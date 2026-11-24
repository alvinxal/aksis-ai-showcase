import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import type { ContactsOverview, SetContactResult } from './contacts.js'
import { sameOrigin } from './http.js'

export type ContactsDependencies = {
  list: (tenantId: string, search?: string) => Promise<ContactsOverview>
  set: (tenantId: string, contactId: string, change: { selected: boolean; projectId?: string | null }) => Promise<SetContactResult>
}

const FAILURES = {
  not_found: [404, 'not_found'],
  limit: [409, 'limit'],
  project: [400, 'project_required'],
} as const

/** The personal chats of the logged-in customer and which of them are read. Scoped to the tenant of the session. */
export function registerContacts(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  deps: ContactsDependencies,
): void {
  app.use('/v1/contacts', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })
  app.use('/v1/contacts/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  app.get('/v1/contacts', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json(await deps.list(session.tenantId, (context.req.query('q') ?? '').slice(0, 60)))
  })

  app.put('/v1/contacts/:id', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return context.json({ error: 'unsupported_media_type' }, 415)
    }
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const body = (await context.req.json().catch(() => null)) as { selected?: unknown; projectId?: unknown } | null
    if (!body || typeof body.selected !== 'boolean') return context.json({ error: 'invalid_request' }, 400)
    const projectId = typeof body.projectId === 'string' ? body.projectId : null
    const result = await deps.set(session.tenantId, context.req.param('id'), { selected: body.selected, projectId })
    if (result.ok) return context.json({ ok: true })
    const [status, error] = FAILURES[result.reason]
    return context.json({ error }, status)
  })
}
