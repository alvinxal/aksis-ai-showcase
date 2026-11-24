import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { ChatResult, ChatService } from './chat.js'

const reply = { id: 'm1', role: 'agent' as const, text: 'Termin 2 jatuh tempo Jumat.', createdAt: '2026-10-29T08:00:00.000Z' }

function build(result: ChatResult = { ok: true, reply }) {
  const calls: unknown[][] = []
  const service: ChatService = {
    supportsImages: false,
    history: async (tenantId, agent) => (calls.push(['history', tenantId, agent]), [reply]),
    latest: async (tenantId) => (calls.push(['latest', tenantId]), [{ ...reply, agent: 'aksis' as const }]),
    ask: async (...args) => (calls.push(['ask', ...args]), result),
    startNew: async (tenantId, agent) => (calls.push(['startNew', tenantId, agent]), { id: 'd1', role: 'divider' as const, text: 'Chat baru', createdAt: '2026-10-29T09:00:00.000Z' }),
  }
  const auth: AuthService = {
    requestCode: async () => 'ignored',
    verify: async () => null,
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio', contactName: null } : null),
    endSession: async () => undefined,
  }
  return { app: createApp({ checkDatabase: async () => undefined, auth: { service: auth, secureCookies: false }, chat: service }), calls }
}
const headers = { cookie: 'aksis_app=tok', 'content-type': 'application/json' }
const post = (app: ReturnType<typeof build>['app'], body: unknown, extra: Record<string, string> = {}, agent = 'aksis') =>
  app.request(`/v1/chat/${agent}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })

describe('chat routes', () => {
  it('need a logged-in customer', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/chat/aksis')).status).toBe(401)
    expect((await app.request('/v1/chat/aksis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hai"}' })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('return the history and the answer of the tenant of the session', async () => {
    const { app, calls } = build()
    const history = await app.request('/v1/chat/aksis', { headers })
    expect(await history.json()).toEqual({ messages: [reply] })
    expect(history.headers.get('cache-control')).toBe('no-store')
    const answer = await post(app, { text: 'Apa yang jatuh tempo?', tenantId: 'other' })
    expect(await answer.json()).toEqual({ reply })
    expect(calls).toEqual([['history', 't1', 'aksis'], ['ask', 't1', 'aksis', 'Apa yang jatuh tempo?', null]])
  })

  it('lists the newest message per agent for the session tenant only', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/chat')).status).toBe(401)
    const list = await app.request('/v1/chat', { headers })
    expect(await list.json()).toEqual({ latest: [{ ...reply, agent: 'aksis' }] })
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(calls).toEqual([['latest', 't1']])
  })

  it('reports image capability only to a logged-in customer', async () => {
    const { app } = build()
    expect((await app.request('/v1/chat-capabilities')).status).toBe(401)
    expect(await (await app.request('/v1/chat-capabilities', { headers })).json()).toEqual({ images: false })
  })

  it('passes a project id only when it looks like one', async () => {
    const { app, calls } = build()
    const id = '3f9b1c3e-8a52-4b43-9a0a-0d6c1e2f7a11'
    await post(app, { text: 'Ringkas', projectId: id })
    expect(calls.at(-1)).toEqual(['ask', 't1', 'aksis', 'Ringkas', id])
    expect((await post(app, { text: 'Ringkas', projectId: 'x; drop' })).status).toBe(404)
  })

  it('rejects an unknown agent, a cross-site post, a non-JSON body and a missing text', async () => {
    const { app } = build()
    expect((await post(app, { text: 'hai' }, {}, 'finance')).status).toBe(404)
    expect((await post(app, { text: 'hai' }, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    expect((await app.request('/v1/chat/aksis', { method: 'POST', headers: { cookie: 'aksis_app=tok', 'content-type': 'text/plain' }, body: 'hai' })).status).toBe(415)
    expect((await post(app, { nope: 1 })).status).toBe(400)
  })

  it.each([
    ['invalid', 400, 'invalid_message'],
    ['paused', 403, 'paused'],
    ['limited', 429, 'limited'],
    ['busy', 429, 'busy'],
    ['unavailable', 502, 'unavailable'],
    ['unknown_project', 404, 'not_found'],
    ['image_unavailable', 409, 'image_unavailable'],
  ] as const)('maps %s to %i', async (reason, status, error) => {
    const { app } = build({ ok: false, reason })
    const response = await post(app, { text: 'hai' })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })

  it('is off when no chat service is configured', async () => {
    const app = createApp({ checkDatabase: async () => undefined, auth: { service: { requestCode: async () => 'ignored', verify: async () => null, getSession: async () => null, endSession: async () => undefined }, secureCookies: false } })
    expect((await app.request('/v1/chat/aksis')).status).toBe(404)
  })

  it('starts a new chat for the tenant of the session only, and not cross-site', async () => {
    const { app, calls } = build()
    const url = '/v1/chat/aksis/new'
    expect((await app.request(url, { method: 'POST' })).status).toBe(401)
    expect((await app.request(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example', host: 'aksis.test' } })).status).toBe(403)
    expect((await app.request('/v1/chat/unknown/new', { method: 'POST', headers })).status).toBe(404)
    const response = await app.request(url, { method: 'POST', headers: { ...headers, 'x-tenant': 'other' } })
    expect((await response.json() as { divider: { text: string } }).divider.text).toBe('Chat baru')
    expect(calls).toEqual([['startNew', 't1', 'aksis']])
  })
})
