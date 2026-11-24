import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { PushService } from './push.js'

const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }
const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'

function build() {
  const calls: unknown[][] = []
  const service: PushService = {
    publicKey: 'PUBLIC',
    subscribe: async (tenantId, input, ua) => (calls.push(['subscribe', tenantId, input, ua]), input.endpoint.startsWith('https://fcm.')),
    unsubscribe: async (tenantId, ep) => void calls.push(['unsubscribe', tenantId, ep]),
  }
  const auth: AuthService = {
    requestCode: async () => 'ignored', verify: async () => null, endSession: async () => undefined,
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio', contactName: null } : null),
  }
  return { app: createApp({ checkDatabase: async () => undefined, auth: { service: auth, secureCookies: false }, push: service }), calls }
}
const headers = { cookie: 'aksis_app=tok', 'content-type': 'application/json' }
const post = (app: ReturnType<typeof build>['app'], path: string, body: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })

describe('push routes', () => {
  it('need a logged-in customer', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/push/key')).status).toBe(401)
    expect((await app.request('/v1/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('give the public key and keep a device for the tenant of the session', async () => {
    const { app, calls } = build()
    const key = await app.request('/v1/push/key', { headers })
    expect(await key.json()).toEqual({ publicKey: 'PUBLIC' })
    expect(key.headers.get('cache-control')).toBe('no-store')
    expect((await post(app, '/v1/push/subscribe', { endpoint, keys, tenantId: 'other' }, { 'user-agent': 'Phone' })).status).toBe(200)
    expect(calls).toEqual([['subscribe', 't1', { endpoint, p256dh: keys.p256dh, auth: keys.auth }, 'Phone']])
  })

  it('refuse a bad subscription, a cross-site write and a non-JSON body', async () => {
    const { app } = build()
    expect((await post(app, '/v1/push/subscribe', { endpoint: 'https://evil.example/x', keys })).status).toBe(400)
    expect((await post(app, '/v1/push/subscribe', { endpoint })).status).toBe(400)
    expect((await post(app, '/v1/push/subscribe', { endpoint, keys }, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    expect((await app.request('/v1/push/subscribe', { method: 'POST', headers: { cookie: 'aksis_app=tok', 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415)
  })

  it('remove a device of the same tenant only', async () => {
    const { app, calls } = build()
    expect((await post(app, '/v1/push/unsubscribe', { endpoint })).status).toBe(200)
    expect((await post(app, '/v1/push/unsubscribe', {})).status).toBe(400)
    expect(calls).toEqual([['unsubscribe', 't1', endpoint]])
  })

  it('are off when no keys are configured', async () => {
    const app = createApp({ checkDatabase: async () => undefined })
    expect((await app.request('/v1/push/key')).status).toBe(404)
  })
})
