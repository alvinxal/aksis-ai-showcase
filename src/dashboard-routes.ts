import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { DASHBOARD_SESSION_HOURS, endDashboardSession, exchangeLoginLink, getDashboardSession } from './dashboard-auth.js'
import { registerCustomerWrites, type CustomerHooks, DAILY_LIMITS, MONTHLY_LIMITS, MONTH_CHOICES } from './dashboard-customers.js'
import { admins, allPlans, audit, customers, health, overview, requests, usage, type Live } from './dashboard-data.js'
import { recordAudit } from './admin.js'
import { addDbAdmin, removeDbAdmin } from './ops.js'
import type { Database } from './db.js'
import { sameOrigin } from './http.js'
import { inviteFromLead, setLeadStatus } from './leads.js'
import { listSellablePlans } from './billing.js'

export type DashboardDependencies = {
  database: Database
  /** Whether a Telegram id is an admin of the bot right now. */
  isAdmin: (telegramId: number) => boolean
  /** Owners come from the environment: they manage the other admins and cannot be removed. */
  owners: ReadonlySet<number>
  /** The bot keeps a copy of the admins table; tell it to reload after a change. */
  reloadAdmins: () => Promise<void>
  live: Live
  secureCookies: boolean
  /** What the customer actions need from the running app (WhatsApp sessions, limits, messages to customers). */
  hooks: CustomerHooks
  /** Public address of the site, for the invitation links. */
  publicBaseUrl: string
  /** Whether customers whose plan ended long ago are deleted automatically (AUTO_DELETE_EXPIRED). */
  autoDeleteExpired: boolean
}

const COOKIE = 'aksis_dash'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXCHANGES_PER_MINUTE = 10

/** The admin dashboard: data for the logged-in admins of the Telegram bot, behind a one-time login link. The access requests, the customers and the admins can be changed here. */
export function registerDashboard(app: Hono, deps: DashboardDependencies): void {
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
    return entry.count > EXCHANGES_PER_MINUTE
  }

  app.use('/v1/dashboard/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  const sessionOf = async (context: Context) => {
    const token = readToken(context)
    return token ? getDashboardSession(deps.database, token, deps.isAdmin) : null
  }

  app.post('/v1/dashboard/login', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return context.json({ error: 'unsupported_media_type' }, 415)
    if (limited(context)) return context.json({ error: 'too_many' }, 429)
    const body = (await context.req.json().catch(() => null)) as { token?: unknown } | null
    const token = typeof body?.token === 'string' ? body.token.slice(0, 200) : ''
    const result = token ? await exchangeLoginLink(deps.database, token, deps.isAdmin) : null
    if (!result) return context.json({ error: 'invalid_link' }, 401)
    setCookie(context, COOKIE, result.sessionToken, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: deps.secureCookies,
      path: '/',
      maxAge: DASHBOARD_SESSION_HOURS * 3600,
      ...(prefix ? { prefix } : {}),
    })
    return context.json({ ok: true })
  })

  app.post('/v1/dashboard/logout', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    const token = readToken(context)
    if (token) await endDashboardSession(deps.database, token)
    deleteCookie(context, COOKIE, { path: '/', ...(prefix ? { prefix, secure: true } : {}) })
    deleteCookie(context, COOKIE, { path: '/' })
    return context.json({ ok: true })
  })

  const guarded = (handler: (context: Context) => Promise<unknown>) => async (context: Context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json(await handler(context))
  }

  app.get('/v1/dashboard/me', guarded(async () => ({ ok: true })))
  app.get('/v1/dashboard/overview', guarded(() => overview(deps.database, deps.live)))
  app.get(
    '/v1/dashboard/customers',
    guarded(async () => ({
      customers: await customers(deps.database, deps.live),
      autoDelete: deps.autoDeleteExpired,
      plans: (await listSellablePlans(deps.database)).map((plan) => ({ code: plan.code, name: plan.name })),
      allPlans: await allPlans(deps.database),
      choices: { months: MONTH_CHOICES, dailyUsd: DAILY_LIMITS, monthlyUsd: MONTHLY_LIMITS },
    })),
  )
  app.get('/v1/dashboard/usage', guarded(async (context) => usage(deps.database, Number(context.req.query('days')) || 14)))
  app.get('/v1/dashboard/requests', guarded(async () => ({ requests: await requests(deps.database) })))
  app.get('/v1/dashboard/health', guarded(() => health(deps.database, deps.live)))
  app.get('/v1/dashboard/audit', guarded(async () => ({ entries: await audit(deps.database) })))

  /** Writes need a session, a same-origin request and JSON; the audit row gets ids only. */
  const write = (handler: (context: Context, actor: number) => Promise<unknown>) => async (context: Context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return context.json({ error: 'unsupported_media_type' }, 415)
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const result = await handler(context, session.telegramId)
    if (!result) return context.json({ error: 'not_found' }, 404)
    const error = (result as { error?: string }).error
    return error ? context.json({ error }, error === 'owner_only' ? 403 : 400) : context.json(result)
  }
  const leadId = (context: Context) => {
    const id = context.req.param('id') ?? ''
    return UUID.test(id) ? id : null
  }

  const mark = (status: 'contacted' | 'rejected') =>
    write(async (context, actor) => {
      const id = leadId(context)
      const lead = id ? await setLeadStatus(deps.database, id, status) : null
      if (!lead) return null
      await recordAudit(deps.database, actor, status === 'contacted' ? 'lead_contacted' : 'lead_rejected', null, { leadId: lead.id })
      return { ok: true }
    })
  app.post('/v1/dashboard/requests/:id/contacted', mark('contacted'))
  app.post('/v1/dashboard/requests/:id/reject', mark('rejected'))
  app.post(
    '/v1/dashboard/requests/:id/invite',
    write(async (context, actor) => {
      const id = leadId(context)
      const invite = id ? await inviteFromLead(deps.database, id, actor) : null
      if (!invite) return null
      return {
        name: invite.name,
        phone: invite.phone,
        tenantId: invite.tenantId,
        link: `${deps.publicBaseUrl}/join/${invite.token}`,
        expiresAt: invite.expiresAt.toISOString(),
      }
    }),
  )

  /** Only an owner changes the admins, as in the bot. The audit row keeps the same action names as the bot's. */
  app.get('/v1/dashboard/admins', guarded(async (context) => {
    const session = await sessionOf(context)
    return { admins: await admins(deps.database, deps.owners), canManage: session ? deps.owners.has(session.telegramId) : false }
  }))
  app.post(
    '/v1/dashboard/admins',
    write(async (context, actor) => {
      if (!deps.owners.has(actor)) return { error: 'owner_only' }
      const body = (await context.req.json().catch(() => null)) as { telegramId?: unknown } | null
      const id = typeof body?.telegramId === 'string' ? body.telegramId.trim() : typeof body?.telegramId === 'number' ? String(body.telegramId) : ''
      if (!/^\d{5,15}$/.test(id)) return { error: 'invalid_id' }
      await addDbAdmin(deps.database, Number(id), actor)
      await deps.reloadAdmins()
      await recordAudit(deps.database, actor, 'admin_added', null, { telegramId: Number(id) })
      return { ok: true }
    }),
  )
  app.post(
    '/v1/dashboard/admins/:id/remove',
    write(async (context, actor) => {
      if (!deps.owners.has(actor)) return { error: 'owner_only' }
      const id = context.req.param('id') ?? ''
      if (!/^\d{5,15}$/.test(id) || deps.owners.has(Number(id))) return null
      const known = (await admins(deps.database, deps.owners)).some((row) => row.telegramId === Number(id))
      if (!known) return null
      await removeDbAdmin(deps.database, Number(id))
      await deps.reloadAdmins()
      await recordAudit(deps.database, actor, 'admin_removed', null, { telegramId: Number(id) })
      return { ok: true }
    }),
  )

  registerCustomerWrites(app, write, { database: deps.database, publicBaseUrl: deps.publicBaseUrl, hooks: deps.hooks })
}
