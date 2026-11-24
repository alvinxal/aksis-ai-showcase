import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import type { SaveGroupsResult, StoredGroup } from './groups.js'
import { sameOrigin } from './http.js'

export type GroupsDependencies = {
  /** The groups of the customer's own WhatsApp account (rejects when it is not connected) and the plan limit. */
  list: (tenantId: string) => Promise<{ limit: number; groups: StoredGroup[] }>
  save: (tenantId: string, jids: string[]) => Promise<SaveGroupsResult>
}

/** The groups Aksis reads, chosen by the customer. Scoped to the tenant of the session. */
export function registerGroups(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  deps: GroupsDependencies,
): void {
  app.use('/v1/groups', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  app.get('/v1/groups', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    try {
      const { limit, groups } = await deps.list(session.tenantId)
      return context.json({
        limit,
        groups: groups.map((group) => ({ id: group.jid, name: group.subject, members: group.participants, selected: group.selected })),
      })
    } catch {
      return context.json({ error: 'unavailable' }, 503)
    }
  })

  app.put('/v1/groups', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return context.json({ error: 'unsupported_media_type' }, 415)
    }
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const body = (await context.req.json().catch(() => null)) as { groups?: unknown } | null
    const jids = Array.isArray(body?.groups) ? body.groups.filter((value): value is string => typeof value === 'string') : null
    if (!jids || jids.length === 0) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await deps.save(session.tenantId, jids)
      if (!result.ok) return context.json({ error: 'groups_rejected', message: result.reason }, 422)
      return context.json({ ok: true, count: result.count })
    } catch {
      return context.json({ error: 'unavailable' }, 503)
    }
  })
}
