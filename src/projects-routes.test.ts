import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { ProjectDetail, ProjectSummary } from './projects.js'

const summary: ProjectSummary = {
  id: 'p1', name: 'Rumah <Budi>', groups: ['Rumah Budi'], contacts: [], note: null, attention: 1, urgent: 0,
  counts: { decisions: 1, revisions: 0, tasks: 0, payments: 0 }, lastActivityAt: null,
}
const detail: ProjectDetail = { id: 'p1', name: 'Rumah <Budi>', groups: [], contacts: [], note: null, attention: [], decisions: [], revisions: [], tasks: [], payments: [] }

function build() {
  const asked: string[] = []
  const service: AuthService = {
    requestCode: async () => 'ignored',
    verify: async () => null,
    getSession: async (token) => (token === 'tok' ? { tenantId: 't1', tenantName: 'Studio', contactName: null } : null),
    endSession: async () => undefined,
  }
  const app = createApp({
    checkDatabase: async () => undefined,
    auth: { service, secureCookies: false },
    projects: {
      list: async (tenantId) => (asked.push(`list:${tenantId}`), [summary]),
      get: async (tenantId, id) => (asked.push(`get:${tenantId}:${id}`), id === 'p1' ? detail : null),
      refresh: (tenantId) => (asked.push(`refresh:${tenantId}`), true),
    },
  })
  return { app, asked }
}
const cookie = { cookie: 'aksis_app=tok' }

describe('project routes', () => {
  it('need a logged-in customer', async () => {
    const { app, asked } = build()
    expect((await app.request('/v1/projects')).status).toBe(401)
    expect((await app.request('/v1/projects/p1', { headers: { cookie: 'aksis_app=nope' } })).status).toBe(401)
    expect(asked).toEqual([])
  })

  it('ask for the tenant of the session, never one from the request', async () => {
    const { app, asked } = build()
    const list = await app.request('/v1/projects?tenantId=other', { headers: cookie })
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(await list.json()).toEqual({ projects: [summary] })
    expect((await app.request('/v1/projects/p1', { headers: cookie })).status).toBe(200)
    expect(asked).toEqual(['list:t1', 'get:t1:p1'])
  })

  it('start the note refresh for the tenant of the session only', async () => {
    const { app, asked } = build()
    expect((await app.request('/v1/projects/refresh', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/v1/projects/refresh', { method: 'POST', headers: { ...cookie, origin: 'https://evil.example', host: 'aksis.flaat.studio' } })).status).toBe(403)
    const ok = await app.request('/v1/projects/refresh', { method: 'POST', headers: cookie })
    expect(ok.status).toBe(202)
    expect(await ok.json()).toEqual({ started: true })
    expect(asked).toEqual(['refresh:t1'])
  })

  it('answer 404 for a project that is not the customer\'s', async () => {
    const { app } = build()
    expect((await app.request('/v1/projects/zzz', { headers: cookie })).status).toBe(404)
  })
})
