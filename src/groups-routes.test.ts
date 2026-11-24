import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { GroupsDependencies } from './groups-routes.js'

function build(fail = false) {
  const calls: unknown[][] = []
  const groups: GroupsDependencies = {
    list: async (tenantId) => {
      calls.push(['list', tenantId])
      if (fail) throw new Error('WhatsApp is not connected')
      return { limit: 3, groups: [{ jid: '1@g.us', subject: 'Rumah <Budi>', participants: 5, selected: true }, { jid: '2@g.us', subject: 'Villa', participants: null, selected: false }] }
    },
    save: async (tenantId, jids) => {
      calls.push(['save', tenantId, jids])
      return jids.length > 3 ? { ok: false, reason: 'Maksimal 3 grup untuk paket Anda.' } : { ok: true, count: jids.length }
    },
  }
  const auth: AuthService = {
    requestCode: async () => 'ignored',
    verify: async () => null,
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio', contactName: null } : null),
    endSession: async () => undefined,
  }
  return { app: createApp({ checkDatabase: async () => undefined, auth: { service: auth, secureCookies: false }, groups }), calls }
}
const headers = { cookie: 'aksis_app=tok', 'content-type': 'application/json' }
const put = (app: ReturnType<typeof build>['app'], body: unknown, extra: Record<string, string> = {}) =>
  app.request('/v1/groups', { method: 'PUT', headers: { ...headers, ...extra }, body: JSON.stringify(body) })

describe('group routes', () => {
  it('need a logged-in customer', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/groups')).status).toBe(401)
    expect((await app.request('/v1/groups', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"groups":["1@g.us"]}' })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('list the groups and the plan limit of the tenant of the session', async () => {
    const { app, calls } = build()
    const response = await app.request('/v1/groups?tenantId=other', { headers })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      limit: 3,
      groups: [{ id: '1@g.us', name: 'Rumah <Budi>', members: 5, selected: true }, { id: '2@g.us', name: 'Villa', members: null, selected: false }],
    })
    expect(calls).toEqual([['list', 't1']])
  })

  it('save for the session tenant, refuse an empty or over-limit choice and a cross-site post', async () => {
    const { app, calls } = build()
    const saved = await put(app, { groups: ['1@g.us', 5, '2@g.us'], tenantId: 'other' })
    expect(await saved.json()).toEqual({ ok: true, count: 2 })
    expect(calls).toEqual([['save', 't1', ['1@g.us', '2@g.us']]])
    expect((await put(app, { groups: [] })).status).toBe(400)
    expect((await put(app, {})).status).toBe(400)
    const over = await put(app, { groups: ['a', 'b', 'c', 'd'] })
    expect(over.status).toBe(422)
    expect(await over.json()).toEqual({ error: 'groups_rejected', message: 'Maksimal 3 grup untuk paket Anda.' })
    expect((await put(app, { groups: ['1@g.us'] }, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    const form = await app.request('/v1/groups', { method: 'PUT', headers: { cookie: 'aksis_app=tok', 'content-type': 'text/plain' }, body: 'x' })
    expect(form.status).toBe(415)
  })

  it('answer 503 when WhatsApp is not connected', async () => {
    const { app } = build(true)
    expect((await app.request('/v1/groups', { headers })).status).toBe(503)
  })
})
