import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { ContactsOverview, SetContactResult } from './contacts.js'

const overview: ContactsOverview = {
  limit: 10, selectedCount: 1, projects: [{ id: 'p1', name: 'Rumah Budi' }],
  contacts: [{ id: 'c1', label: 'Pak <Budi>', selected: true, projectId: 'p1', lastSeenAt: '2026-10-29T08:00:00.000Z', lastMessageAt: '2026-10-29T08:00:00.000Z' }],
}

function build(result: SetContactResult = { ok: true }) {
  const calls: unknown[][] = []
  const auth: AuthService = {
    requestCode: async () => 'ignored', verify: async () => null, endSession: async () => undefined,
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio', contactName: null } : null),
  }
  const app = createApp({
    checkDatabase: async () => undefined,
    auth: { service: auth, secureCookies: false },
    contacts: {
      list: async (tenantId) => (calls.push(['list', tenantId]), overview),
      set: async (...args) => (calls.push(['set', ...args]), result),
    },
  })
  return { app, calls }
}
const headers = { cookie: 'aksis_app=tok', 'content-type': 'application/json' }
const put = (app: ReturnType<typeof build>['app'], body: unknown, extra: Record<string, string> = {}, id = 'c1') =>
  app.request(`/v1/contacts/${id}`, { method: 'PUT', headers: { ...headers, ...extra }, body: JSON.stringify(body) })

describe('contacts routes', () => {
  it('need a logged-in customer', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/contacts')).status).toBe(401)
    expect((await app.request('/v1/contacts/c1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"selected":false}' })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('list for the tenant of the session and change one contact', async () => {
    const { app, calls } = build()
    const list = await app.request('/v1/contacts', { headers })
    expect(await list.json()).toEqual(overview)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect((await put(app, { selected: true, projectId: 'p1', tenantId: 'other' })).status).toBe(200)
    expect(calls).toEqual([['list', 't1'], ['set', 't1', 'c1', { selected: true, projectId: 'p1' }]])
  })

  it('rejects a cross-site write, a non-JSON body and a missing flag', async () => {
    const { app } = build()
    expect((await put(app, { selected: false }, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    expect((await app.request('/v1/contacts/c1', { method: 'PUT', headers: { cookie: 'aksis_app=tok', 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415)
    expect((await put(app, { projectId: 'p1' })).status).toBe(400)
  })

  it.each([
    ['not_found', 404, 'not_found'],
    ['limit', 409, 'limit'],
    ['project', 400, 'project_required'],
  ] as const)('maps %s to %i', async (reason, status, error) => {
    const { app } = build({ ok: false, reason })
    const response = await put(app, { selected: true })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })
})
