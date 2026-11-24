import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthService } from './auth.js'
import { APP_SESSION_DAYS, CODE_MAX_REQUESTS, CODE_WINDOW_MINUTES, type AppSession } from './auth.js'
import { isNotPhone } from './device.js'
import { normalizePhone } from './phone.js'

export type AuthDependencies = {
  service: AuthService
  secureCookies: boolean
  /** Clock in ms, for tests. */
  now?: () => number
}

const COOKIE = 'aksis_app'
/** Requests per IP per minute on the two code endpoints; a per-customer limit lives in the service. */
const IP_LIMIT = 10
/** Seconds a number must wait between two code requests. */
export const RESEND_SECONDS = 60
const MAX_TRACKED_NUMBERS = 5_000

/** Returns how to find the logged-in customer of a request, for the other app routes. */
export function registerAuth(app: Hono, deps: AuthDependencies): (context: Context) => Promise<AppSession | null> {
  const prefix = deps.secureCookies ? ('host' as const) : undefined
  const readToken = (context: Context) => (prefix ? getCookie(context, COOKIE, prefix) : undefined) ?? getCookie(context, COOKIE)

  const hits = new Map<string, { count: number; resetAt: number }>()
  const limited = (context: Context): boolean => {
    const now = Date.now()
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key)
    const ip = context.req.header('cf-connecting-ip') ?? context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
    const entry = hits.get(ip) ?? { count: 0, resetAt: now + 60_000 }
    entry.count += 1
    hits.set(ip, entry)
    return entry.count > IP_LIMIT
  }

  // Waiting time per number, for known and unknown numbers alike, so the answer never says whether a customer exists.
  // The per-customer limit in the service stays as the backstop (this one forgets everything on a restart).
  const asked = new Map<string, number[]>()
  const now = deps.now ?? Date.now
  const windowMs = CODE_WINDOW_MINUTES * 60_000
  /** Returns how many seconds the number must wait, and whether this request may go through. */
  const gate = (phone: string): { allowed: boolean; retryAfter: number } => {
    const at = now()
    for (const [key, times] of asked) if (times.every((time) => at - time >= windowMs)) asked.delete(key)
    const times = (asked.get(phone) ?? []).filter((time) => at - time < windowMs)
    const last = times.at(-1)
    if (last !== undefined && at - last < RESEND_SECONDS * 1_000) {
      return { allowed: false, retryAfter: Math.ceil((RESEND_SECONDS * 1_000 - (at - last)) / 1_000) }
    }
    if (times.length >= CODE_MAX_REQUESTS) {
      return { allowed: false, retryAfter: Math.ceil((windowMs - (at - times[0]!)) / 1_000) }
    }
    if (!asked.has(phone) && asked.size >= MAX_TRACKED_NUMBERS) return { allowed: true, retryAfter: RESEND_SECONDS }
    times.push(at)
    asked.set(phone, times)
    const wait = times.length >= CODE_MAX_REQUESTS ? Math.ceil((windowMs - (at - times[0]!)) / 1_000) : RESEND_SECONDS
    return { allowed: true, retryAfter: wait }
  }

  app.use('/v1/auth/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })
  app.use('/v1/me', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  const guardWrite = async (context: Context): Promise<{ error: Response } | { body: Record<string, unknown> }> => {
    const origin = context.req.header('origin')
    if (origin) {
      try {
        if (new URL(origin).host !== context.req.header('host')) return { error: context.json({ error: 'forbidden' }, 403) }
      } catch {
        return { error: context.json({ error: 'forbidden' }, 403) }
      }
    }
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return { error: context.json({ error: 'unsupported_media_type' }, 415) }
    }
    if (isNotPhone(context.req.header('user-agent'))) return { error: context.json({ error: 'phone_only' }, 403) }
    if (limited(context)) return { error: context.json({ error: 'too_many' }, 429) }
    const body = (await context.req.json().catch(() => null)) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: context.json({ error: 'invalid_json' }, 400) }
    return { body: body as Record<string, unknown> }
  }

  // The answer is the same whether or not the number belongs to a customer, so numbers cannot be probed.
  app.post('/v1/auth/code', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const phone = normalizePhone(guarded.body.phone)
    if (!phone) return context.json({ error: 'invalid_phone' }, 400)
    const turn = gate(phone)
    if (turn.allowed) await deps.service.requestCode(phone).catch(() => 'ignored')
    return context.json({ ok: true, retryAfter: turn.retryAfter })
  })

  app.post('/v1/auth/verify', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const phone = normalizePhone(guarded.body.phone)
    const code = typeof guarded.body.code === 'string' ? guarded.body.code.replace(/\s+/g, '') : ''
    if (!phone || !/^\d{6}$/.test(code)) return context.json({ error: 'invalid_code' }, 400)
    const token = await deps.service.verify(phone, code)
    if (!token) return context.json({ error: 'invalid_code' }, 401)
    setCookie(context, COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.secureCookies,
      path: '/',
      maxAge: APP_SESSION_DAYS * 86_400,
      ...(prefix ? { prefix } : {}),
    })
    return context.json({ ok: true })
  })

  app.get('/v1/me', async (context) => {
    const token = readToken(context)
    const session = token ? await deps.service.getSession(token) : null
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ tenantName: session.tenantName, contactName: session.contactName })
  })

  app.post('/v1/auth/logout', async (context) => {
    const origin = context.req.header('origin')
    if (origin) {
      try {
        if (new URL(origin).host !== context.req.header('host')) return context.json({ error: 'forbidden' }, 403)
      } catch {
        return context.json({ error: 'forbidden' }, 403)
      }
    }
    const token = readToken(context)
    if (token) await deps.service.endSession(token)
    deleteCookie(context, COOKIE, { path: '/', ...(prefix ? { prefix, secure: true } : {}) })
    deleteCookie(context, COOKIE, { path: '/' })
    return context.json({ ok: true })
  })

  return async (context) => {
    const token = readToken(context)
    return token ? deps.service.getSession(token) : null
  }
}
