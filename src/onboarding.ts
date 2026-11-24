import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import type { OnboardingSession } from './admin.js'
import type { WhatsAppStatus } from './app.js'
import { GROUP_LIMIT, type SaveGroupsResult, type StoredGroup } from './groups.js'
import { isNotPhone } from './device.js'
import { normalizePhone } from './phone.js'
import type { Shell } from './web.js'
import type { StartResult } from './whatsapp-manager.js'

export type OnboardingDependencies = {
  join: (token: string) => Promise<{ sessionToken: string; session: OnboardingSession } | null>
  getSession: (sessionToken: string) => Promise<OnboardingSession | null>
  saveProfile: (tenantId: string, studioName: string, contactName: string) => Promise<void>
  complete: (tenantId: string) => Promise<void>
  whatsapp: {
    status: (tenantId: string) => WhatsAppStatus | null
    start: (tenantId: string) => Promise<StartResult>
    /** Link with a phone number code instead of a QR; resolves false when WhatsApp gave no code. */
    requestCode: (tenantId: string, phone: string) => Promise<boolean>
    listGroups: (tenantId: string) => Promise<StoredGroup[]>
    saveGroups: (tenantId: string, jids: string[]) => Promise<SaveGroupsResult>
  }
  /** `readyTenantId` asks the notifier to attach an "activate" action. */
  notify?: (text: string, readyTenantId?: string) => void
  /** Whether an admin has given the customer a plan. Without one the page waits before the groups step; undefined skips the wait. */
  hasPlan?: (tenantId: string) => Promise<boolean>
  /** Asks the admins to choose a plan for this customer (they are told once). */
  requestPlan?: (tenantId: string, tenantName: string) => Promise<void>
  /** Group limit of the tenant's plan; defaults to the largest plan limit. */
  groupLimit?: (tenantId: string) => Promise<number>
  secureCookies: boolean
}

/** What the onboarding page shows; the single-page app renders one screen per step. */
export type OnboardingState = {
  step: 'profile' | 'whatsapp' | 'pairing' | 'plan' | 'groups' | 'done'
  tenantName: string
  contactName: string | null
  pairing: { connection: string; qr: string | null; pairingCode: string | null } | null
  groups: { items: StoredGroup[]; limit: number; loadFailed: boolean } | null
}

/** Version of the terms and privacy text a customer agrees to; change it when the text changes materially. */
export const TERMS_VERSION = '2026-11-draf'

const COOKIE = 'aksis_session'
const SESSION_MAX_AGE = 7 * 86_400

export function registerOnboarding(app: Hono, deps: OnboardingDependencies, shell?: Shell): void {
  // A secure deployment uses the __Host- prefix (no Domain, Secure, Path=/), so a sibling
  // subdomain of flaat.studio can neither read nor overwrite the session. Plain http (dev) cannot.
  const prefix = deps.secureCookies ? ('host' as const) : undefined
  const readToken = (context: Context) =>
    (prefix ? getCookie(context, COOKIE, prefix) : undefined) ?? getCookie(context, COOKIE)
  const currentSession = async (context: Context): Promise<OnboardingSession | null> => {
    const token = readToken(context)
    return token ? deps.getSession(token) : null
  }

  // Opening the link only shows the page. The invitation is spent by the page itself (POST /v1/join),
  // so a link preview, a link scanner or a desktop browser cannot use up a one-time link.
  if (shell) {
    app.get('/join/:token', (context) => {
      context.header('Cache-Control', 'no-store')
      return shell(context)
    })
  }

  app.post('/v1/join', async (context) => {
    context.header('Cache-Control', 'no-store')
    context.header('Referrer-Policy', 'no-referrer')
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) {
      return context.json({ error: 'forbidden' }, 403)
    }
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return context.json({ error: 'unsupported_media_type' }, 415)
    }
    if (isNotPhone(context.req.header('user-agent'))) return context.json({ error: 'phone_only' }, 403)
    const body = (await context.req.json().catch(() => null)) as { token?: unknown } | null
    const token = typeof body?.token === 'string' ? body.token : ''
    const joined = token ? await deps.join(token) : null
    if (!joined) return context.json({ error: 'invalid_link' }, 410)
    setCookie(context, COOKIE, joined.sessionToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.secureCookies,
      path: '/',
      maxAge: SESSION_MAX_AGE,
      ...(prefix ? { prefix } : {}),
    })
    // Retire a session cookie from before the prefix existed, so only one remains.
    if (prefix) deleteCookie(context, COOKIE, { path: '/' })
    deps.notify?.(`Undangan dibuka: ${joined.session.tenantName}`)
    return context.json({ ok: true })
  })

  app.use('/v1/onboarding/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  /** Rejects cross-site and non-JSON writes: a form from another site can send neither. */
  const guardWrite = async (context: Context): Promise<{ error: Response } | { body: Record<string, unknown>; session: OnboardingSession }> => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) {
      return { error: context.json({ error: 'forbidden' }, 403) }
    }
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return { error: context.json({ error: 'unsupported_media_type' }, 415) }
    }
    const session = await currentSession(context)
    if (!session) return { error: context.json({ error: 'unauthorized' }, 401) }
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return { error: context.json({ error: 'invalid_json' }, 400) }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: context.json({ error: 'invalid_json' }, 400) }
    }
    return { body: body as Record<string, unknown>, session }
  }

  app.get('/v1/onboarding/state', async (context) => {
    const session = await currentSession(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json(await stateOf(session, deps))
  })

  app.post('/v1/onboarding/profile', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const studio = cleanText(guarded.body.studio)
    const name = cleanText(guarded.body.name)
    if (!studio || !name) return context.json({ error: 'invalid_profile' }, 400)
    // The page asks for consent to the terms and privacy policy; without it nothing is saved.
    if (guarded.body.terms !== true) return context.json({ error: 'terms_required' }, 400)
    await deps.saveProfile(guarded.session.tenantId, studio, name)
    deps.notify?.(`Profil diisi: ${studio} (${name})`)
    return context.json({ ok: true })
  })

  app.post('/v1/onboarding/whatsapp/start', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const { session } = guarded
    const result = await deps.whatsapp.start(session.tenantId)
    if (result === 'started') deps.notify?.(`Pairing WhatsApp dimulai: ${session.tenantName}`)
    if (result === 'full') {
      deps.notify?.(`⚠️ Slot WhatsApp penuh: ${session.tenantName} tidak bisa memulai pairing.`)
      return context.json({ error: 'full' }, 409)
    }
    if (result === 'unavailable') return context.json({ error: 'unavailable' }, 409)
    return context.json({ result })
  })

  app.post('/v1/onboarding/whatsapp/code', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const { session } = guarded
    const phone = normalizePhone(guarded.body.phone)
    if (!phone) return context.json({ error: 'invalid_phone' }, 400)
    const result = await deps.whatsapp.start(session.tenantId)
    if (result === 'full') {
      deps.notify?.(`⚠️ Slot WhatsApp penuh: ${session.tenantName} tidak bisa memulai pairing.`)
      return context.json({ error: 'full' }, 409)
    }
    if (result === 'unavailable') return context.json({ error: 'unavailable' }, 409)
    if (result === 'started') deps.notify?.(`Pairing WhatsApp dimulai: ${session.tenantName}`)
    const issued = await deps.whatsapp.requestCode(session.tenantId, phone)
    return issued ? context.json({ ok: true }) : context.json({ error: 'code_failed' }, 502)
  })

  app.post('/v1/onboarding/groups', async (context) => {
    const guarded = await guardWrite(context)
    if ('error' in guarded) return guarded.error
    const { session } = guarded
    if (deps.whatsapp.status(session.tenantId)?.connection !== 'connected') {
      return context.json({ error: 'not_connected' }, 409)
    }
    if (deps.hasPlan && !(await deps.hasPlan(session.tenantId))) return context.json({ error: 'plan_pending' }, 409)
    const raw = guarded.body.groups
    const jids = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []
    const result = await deps.whatsapp.saveGroups(session.tenantId, jids)
    if (!result.ok) return context.json({ error: 'groups_rejected', message: result.reason }, 422)
    await deps.complete(session.tenantId)
    deps.notify?.(`Onboarding selesai, akun aktif: ${session.tenantName} (${result.count} grup)`, session.tenantId)
    return context.json({ ok: true, count: result.count })
  })

  app.post('/v1/onboarding/logout', (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) {
      return context.json({ error: 'forbidden' }, 403)
    }
    deleteCookie(context, COOKIE, { path: '/', ...(prefix ? { prefix, secure: true } : {}) })
    deleteCookie(context, COOKIE, { path: '/' })
    return context.json({ ok: true })
  })
}

async function stateOf(session: OnboardingSession, deps: OnboardingDependencies): Promise<OnboardingState> {
  const base = { tenantName: session.tenantName, contactName: session.contactName, pairing: null, groups: null }
  if (!session.contactName) return { ...base, step: 'profile' }
  if (session.onboardedAt) return { ...base, step: 'done' }

  const status = deps.whatsapp.status(session.tenantId)
  if (!status) return { ...base, step: 'whatsapp' }
  if (status.connection !== 'connected') {
    const qr = status.qr ? await QRCode.toDataURL(status.qr, { width: 320, margin: 2 }) : null
    return {
      ...base,
      step: 'pairing',
      pairing: { connection: status.connection, qr, pairingCode: status.pairingCode ?? null },
    }
  }

  // A plan comes first: the number of groups the customer may pick depends on it. The admins choose it.
  if (deps.hasPlan && !(await deps.hasPlan(session.tenantId))) {
    await deps.requestPlan?.(session.tenantId, session.tenantName).catch(() => undefined)
    return { ...base, step: 'plan' }
  }

  let items: StoredGroup[] = []
  let loadFailed = false
  try {
    items = await deps.whatsapp.listGroups(session.tenantId)
  } catch {
    loadFailed = true
  }
  const limit = (await deps.groupLimit?.(session.tenantId)) ?? GROUP_LIMIT
  return { ...base, step: 'groups', groups: { items, limit, loadFailed } }
}

function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}
