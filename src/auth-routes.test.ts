import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'

function build(overrides: Partial<AuthService> = {}, secureCookies = false, now?: () => number) {
  const calls: string[] = []
  const service: AuthService = {
    requestCode: async (phone) => {
      calls.push(`code:${phone}`)
      return phone === '6281234567890' ? 'sent' : 'ignored'
    },
    verify: async (phone, code) => (phone === '6281234567890' && code === '123456' ? 'tok' : null),
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio <Uji>', contactName: 'Dewi' } : null),
    endSession: async (token) => void calls.push(`end:${token}`),
    ...overrides,
  }
  return { app: createApp({ checkDatabase: async () => undefined, auth: { service, secureCookies, ...(now ? { now } : {}) } }), calls }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
  body: JSON.stringify(body),
  path,
})
const send = (app: ReturnType<typeof build>['app'], path: string, body: unknown, headers: Record<string, string> = {}) => {
  const { path: _path, ...init } = post(path, body, headers)
  return app.request(path, init)
}

describe('app login', () => {
  it('tells how long to wait between codes, the same for known and unknown numbers, and sends nothing meanwhile', async () => {
    let clock = 1_000_000
    const { app, calls } = build({}, false, () => clock)
    const phones = ['081234567890', '085555555555']
    for (const phone of phones) {
      const first = await send(app, '/v1/auth/code', { phone })
      expect(await first.json()).toEqual({ ok: true, retryAfter: 60 })
    }
    clock += 20_000
    const early = await send(app, '/v1/auth/code', { phone: phones[0] })
    expect(await early.json()).toEqual({ ok: true, retryAfter: 40 })
    expect(calls).toEqual(['code:6281234567890', 'code:6285555555555'])
    clock += 40_000
    expect(await (await send(app, '/v1/auth/code', { phone: phones[0] })).json()).toEqual({ ok: true, retryAfter: 60 })
    clock += 60_000
    // The third request in the window uses it up: the wait is until the first one leaves the 15 minutes.
    expect(await (await send(app, '/v1/auth/code', { phone: phones[0] })).json()).toEqual({ ok: true, retryAfter: 900 - 120 })
    clock += 61_000
    expect(await (await send(app, '/v1/auth/code', { phone: phones[0] })).json()).toEqual({ ok: true, retryAfter: 900 - 181 })
    expect(calls.filter((call) => call === 'code:6281234567890')).toHaveLength(3)
    clock += 900_000
    expect(await (await send(app, '/v1/auth/code', { phone: phones[0] })).json()).toEqual({ ok: true, retryAfter: 60 })
  })

  it('answers the same for a known and an unknown number', async () => {
    const { app } = build()
    const known = await send(app, '/v1/auth/code', { phone: '081234567890' })
    const unknown = await send(app, '/v1/auth/code', { phone: '085555555555' })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(await known.json()).toEqual(await unknown.json())
  })

  it('rejects a bad number, a desktop browser, a cross-site post and a non-JSON body', async () => {
    const { app } = build()
    expect((await send(app, '/v1/auth/code', { phone: 'abc' })).status).toBe(400)
    expect((await send(app, '/v1/auth/code', { phone: '081234567890' }, { 'user-agent': DESKTOP })).status).toBe(403)
    expect((await send(app, '/v1/auth/code', { phone: '081234567890' }, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    const form = await app.request('/v1/auth/code', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': UA }, body: 'phone=1' })
    expect(form.status).toBe(415)
  })

  it('sets an httpOnly session cookie only for a right code', async () => {
    const { app } = build()
    const wrong = await send(app, '/v1/auth/verify', { phone: '081234567890', code: '000000' })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    expect((await send(app, '/v1/auth/verify', { phone: '081234567890', code: '12' })).status).toBe(400)
    const right = await send(app, '/v1/auth/verify', { phone: '081234567890', code: '123 456' })
    expect(right.status).toBe(200)
    const cookie = right.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('aksis_app=tok')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('uses a __Host- cookie on a secure deployment', async () => {
    const { app } = build({}, true)
    const right = await send(app, '/v1/auth/verify', { phone: '081234567890', code: '123456' })
    expect(right.headers.get('set-cookie')).toContain('__Host-aksis_app=tok')
  })

  it('reports who is logged in, escaping nothing itself', async () => {
    const { app } = build()
    expect((await app.request('/v1/me')).status).toBe(401)
    expect((await app.request('/v1/me', { headers: { cookie: 'aksis_app=nope' } })).status).toBe(401)
    const me = await app.request('/v1/me', { headers: { cookie: 'aksis_app=tok' } })
    expect(await me.json()).toEqual({ tenantName: 'Studio <Uji>', contactName: 'Dewi' })
    expect(me.headers.get('cache-control')).toBe('no-store')
  })

  it('ends the session on logout', async () => {
    const { app, calls } = build()
    const out = await app.request('/v1/auth/logout', { method: 'POST', headers: { cookie: 'aksis_app=tok' } })
    expect(out.status).toBe(200)
    expect(calls).toContain('end:tok')
  })

  it('limits one address to a few tries a minute', async () => {
    const { app } = build()
    let last = 200
    for (let i = 0; i < 12; i += 1) last = (await send(app, '/v1/auth/verify', { phone: '081234567890', code: '000000' }, { 'cf-connecting-ip': '1.2.3.4' })).status
    expect(last).toBe(429)
    expect((await send(app, '/v1/auth/verify', { phone: '081234567890', code: '123456' }, { 'cf-connecting-ip': '5.6.7.8' })).status).toBe(200)
  })

  it('leaves the routes off when no secret is configured', async () => {
    const app = createApp({ checkDatabase: async () => undefined })
    expect((await app.request('/v1/me')).status).toBe(404)
  })
})
