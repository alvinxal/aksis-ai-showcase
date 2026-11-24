import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import { isChatAgent, type ChatImage, type ChatResult, type ChatService } from './chat.js'
import { sameOrigin } from './http.js'

const FAILURES: Record<Exclude<ChatResult, { ok: true }>['reason'], [number, string]> = {
  invalid: [400, 'invalid_message'],
  unknown_project: [404, 'not_found'],
  paused: [403, 'paused'],
  limited: [429, 'limited'],
  busy: [429, 'busy'],
  unavailable: [502, 'unavailable'],
  image_unavailable: [409, 'image_unavailable'],
}

/** Chat with an agent for the logged-in customer. Everything is scoped to the tenant of the session. */
export function registerChat(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  service: ChatService,
): void {
  app.use('/v1/chat/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  app.get('/v1/chat-capabilities', async (context) => {
    const session = await sessionOf(context)
    return session ? context.json({ images: service.supportsImages }) : context.json({ error: 'unauthorized' }, 401)
  })

  app.get('/v1/chat', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ latest: await service.latest(session.tenantId) })
  })

  app.get('/v1/chat/:agent', async (context) => {
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const agent = context.req.param('agent')
    if (!isChatAgent(agent)) return context.json({ error: 'not_found' }, 404)
    return context.json({ messages: await service.history(session.tenantId, agent) })
  })

  app.post('/v1/chat/:agent/new', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const agent = context.req.param('agent')
    if (!isChatAgent(agent)) return context.json({ error: 'not_found' }, 404)
    return context.json({ divider: await service.startNew(session.tenantId, agent) })
  })

  app.post('/v1/chat/:agent', async (context) => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return context.json({ error: 'forbidden' }, 403)
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return context.json({ error: 'unsupported_media_type' }, 415)
    }
    const session = await sessionOf(context)
    if (!session) return context.json({ error: 'unauthorized' }, 401)
    const agent = context.req.param('agent')
    if (!isChatAgent(agent)) return context.json({ error: 'not_found' }, 404)
    if (Number(context.req.header('content-length') ?? '0') > 5_800_000) return context.json({ error: 'invalid_message' }, 413)
    const body = (await context.req.json().catch(() => null)) as { text?: unknown; projectId?: unknown; image?: unknown } | null
    if (!body || typeof body.text !== 'string') return context.json({ error: 'invalid_message' }, 400)
    const projectId = typeof body.projectId === 'string' && /^[0-9a-f-]{36}$/i.test(body.projectId) ? body.projectId : null
    if (body.projectId !== undefined && body.projectId !== null && !projectId) return context.json({ error: 'not_found' }, 404)
    const candidate = body.image as Partial<ChatImage> | undefined
    const image = candidate && typeof candidate.name === 'string' && typeof candidate.type === 'string' && typeof candidate.dataUrl === 'string'
      ? candidate as ChatImage
      : undefined
    const result = image
      ? await service.ask(session.tenantId, agent, body.text, projectId, image)
      : await service.ask(session.tenantId, agent, body.text, projectId)
    if (result.ok) return context.json({ reply: result.reply })
    const [status, error] = FAILURES[result.reason]
    return context.json({ error }, status as 400)
  })
}
