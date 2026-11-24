import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import { sameOrigin } from './http.js'
import type { ProjectDetail, ProjectSummary } from './projects.js'

export type ProjectsDependencies = {
  list: (tenantId: string) => Promise<ProjectSummary[]>
  get: (tenantId: string, projectId: string) => Promise<ProjectDetail | null>
  /** Starts writing missing project notes in the background; false when it ran recently or is not available. */
  refresh?: (tenantId: string) => boolean
}

/** Read-only project data of the logged-in customer; every query is scoped to that customer's tenant. */
export function registerProjects(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  deps: ProjectsDependencies,
): void {
  app.use('/v1/projects', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })
  app.use('/v1/projects/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  app.get('/v1/projects', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ projects: await deps.list(session.tenantId) })
  })

  app.post('/v1/projects/refresh', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ started: deps.refresh?.(session.tenantId) ?? false }, 202)
  })

  app.get('/v1/projects/:id', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const project = await deps.get(session.tenantId, context.req.param('id'))
    return project ? context.json(project) : context.json({ error: 'not_found' }, 404)
  })
}
