import type { Context, Hono } from 'hono'
import type { AppSession } from './auth.js'
import { sameOrigin } from './http.js'
import type { PushService } from './push.js'

/** Notification devices of the logged-in customer. Everything is scoped to the tenant of the session. */
export function registerPush(
  app: Hono,
  sessionOf: (context: Context) => Promise<AppSession | null>,
  service: PushService,
): void {
  app.use('/v1/push/*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
  })

  app.get('/v1/push/key', async (context) => {
    if (!(await sessionOf(context))) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ publicKey: service.publicKey })
  })

  const guarded = async (context: Context): Promise<{ error: Response } | { session: AppSession; body: Record<string, unknown> }> => {
    if (!sameOrigin(context.req.header('origin'), context.req.header('host'))) return { error: context.json({ error: 'forbidden' }, 403) }
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return { error: context.json({ error: 'unsupported_media_type' }, 415) }
    }
    const session = await sessionOf(context)
    if (!session) return { error: context.json({ error: 'unauthorized' }, 401) }
    const body = (await context.req.json().catch(() => null)) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: context.json({ error: 'invalid_request' }, 400) }
    return { session, body: body as Record<string, unknown> }
  }

  app.post('/v1/push/subscribe', async (context) => {
    const result = await guarded(context)
    if ('error' in result) return result.error
    const keys = result.body.keys as { p256dh?: unknown; auth?: unknown } | undefined
    if (typeof result.body.endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      return context.json({ error: 'invalid_subscription' }, 400)
    }
    const saved = await service.subscribe(
      result.session.tenantId,
      { endpoint: result.body.endpoint, p256dh: keys.p256dh, auth: keys.auth },
      context.req.header('user-agent') ?? null,
    )
    return saved ? context.json({ ok: true }) : context.json({ error: 'invalid_subscription' }, 400)
  })

  app.post('/v1/push/unsubscribe', async (context) => {
    const result = await guarded(context)
    if ('error' in result) return result.error
    if (typeof result.body.endpoint !== 'string') return context.json({ error: 'invalid_request' }, 400)
    await service.unsubscribe(result.session.tenantId, result.body.endpoint)
    return context.json({ ok: true })
  })
}
