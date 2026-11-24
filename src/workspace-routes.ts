import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import { sameOrigin } from './http.js'
import type { AgendaItem, BillingOverview, ConnectionOverview, ReminderPreferences, SearchItem, WeeklyProject } from './workspace.js'

export type WorkspaceDependencies = {
  connection: (tenantId: string) => Promise<ConnectionOverview>
  reconnect: (tenantId: string) => Promise<boolean>
  disconnect: (tenantId: string) => Promise<void>
  billing: (tenantId: string) => Promise<BillingOverview>
  requestPayment: (tenantId: string, planCode: string, months: number) => Promise<boolean>
  agenda: (tenantId: string) => Promise<AgendaItem[]>
  setAction: (tenantId: string, eventId: string, status: AgendaItem['status'], snoozedUntil: string | null) => Promise<boolean>
  search: (tenantId: string, query: string) => Promise<SearchItem[]>
  report: (tenantId: string) => Promise<{ from: string; to: string; projects: WeeklyProject[] }>
  preferences: (tenantId: string) => Promise<ReminderPreferences>
  setPreferences: (tenantId: string, reminderLeadDays: number, weeklyReportEnabled: boolean) => Promise<boolean>
}

export function registerWorkspace(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  deps: WorkspaceDependencies,
): void {
  app.use('/v1/workspace/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })
  const session = async (context: Context) => {
    const value = await sessionOf(context)
    if (!value) return null
    return value
  }
  const mutationAllowed = (context: Context) => sameOrigin(context.req.header('origin'), context.req.header('host'))

  app.get('/v1/workspace/connection', async (context) => {
    const auth = await session(context)
    return auth ? context.json(await deps.connection(auth.tenantId)) : context.json({ error: 'unauthorized' }, 401)
  })
  app.post('/v1/workspace/connection/reconnect', async (context) => {
    if (!mutationAllowed(context)) return context.json({ error: 'forbidden' }, 403)
    const auth = await session(context)
    if (!auth) return context.json({ error: 'unauthorized' }, 401)
    return (await deps.reconnect(auth.tenantId)) ? context.json({ ok: true }) : context.json({ error: 'unavailable' }, 409)
  })
  app.post('/v1/workspace/connection/disconnect', async (context) => {
    if (!mutationAllowed(context)) return context.json({ error: 'forbidden' }, 403)
    const auth = await session(context)
    if (!auth) return context.json({ error: 'unauthorized' }, 401)
    await deps.disconnect(auth.tenantId)
    return context.json({ ok: true })
  })
  app.get('/v1/workspace/billing', async (context) => {
    const auth = await session(context)
    return auth ? context.json(await deps.billing(auth.tenantId)) : context.json({ error: 'unauthorized' }, 401)
  })
  app.post('/v1/workspace/billing/request', async (context) => {
    if (!mutationAllowed(context)) return context.json({ error: 'forbidden' }, 403)
    const auth = await session(context)
    if (!auth) return context.json({ error: 'unauthorized' }, 401)
    const body = (await context.req.json().catch(() => ({}))) as { planCode?: unknown; months?: unknown }
    const ok = typeof body.planCode === 'string' && typeof body.months === 'number'
      ? await deps.requestPayment(auth.tenantId, body.planCode, body.months)
      : false
    return ok ? context.json({ ok: true }) : context.json({ error: 'invalid_or_pending' }, 409)
  })
  app.get('/v1/workspace/agenda', async (context) => {
    const auth = await session(context)
    return auth ? context.json({ items: await deps.agenda(auth.tenantId) }) : context.json({ error: 'unauthorized' }, 401)
  })
  app.put('/v1/workspace/agenda/:id', async (context) => {
    if (!mutationAllowed(context)) return context.json({ error: 'forbidden' }, 403)
    const auth = await session(context)
    if (!auth) return context.json({ error: 'unauthorized' }, 401)
    const body = (await context.req.json().catch(() => ({}))) as { status?: unknown; snoozedUntil?: unknown }
    const status = body.status
    const snoozed = body.snoozedUntil === null || typeof body.snoozedUntil === 'string' ? body.snoozedUntil : null
    const ok = typeof status === 'string' && ['open', 'done', 'snoozed'].includes(status)
      ? await deps.setAction(auth.tenantId, context.req.param('id'), status as AgendaItem['status'], snoozed)
      : false
    return ok ? context.json({ ok: true }) : context.json({ error: 'invalid' }, 400)
  })
  app.get('/v1/workspace/search', async (context) => {
    const auth = await session(context)
    return auth ? context.json({ items: await deps.search(auth.tenantId, context.req.query('q') ?? '') }) : context.json({ error: 'unauthorized' }, 401)
  })
  app.get('/v1/workspace/report', async (context) => {
    const auth = await session(context)
    return auth ? context.json(await deps.report(auth.tenantId)) : context.json({ error: 'unauthorized' }, 401)
  })
  app.get('/v1/workspace/preferences', async (context) => {
    const auth = await session(context)
    return auth ? context.json(await deps.preferences(auth.tenantId)) : context.json({ error: 'unauthorized' }, 401)
  })
  app.put('/v1/workspace/preferences', async (context) => {
    if (!mutationAllowed(context)) return context.json({ error: 'forbidden' }, 403)
    const auth = await session(context)
    if (!auth) return context.json({ error: 'unauthorized' }, 401)
    const body = (await context.req.json().catch(() => ({}))) as { reminderLeadDays?: unknown; weeklyReportEnabled?: unknown }
    const ok = typeof body.reminderLeadDays === 'number' && typeof body.weeklyReportEnabled === 'boolean'
      ? await deps.setPreferences(auth.tenantId, body.reminderLeadDays, body.weeklyReportEnabled)
      : false
    return ok ? context.json({ ok: true }) : context.json({ error: 'invalid' }, 400)
  })
}
