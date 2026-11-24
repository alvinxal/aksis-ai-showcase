import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './auth.js'
import type { WorkspaceDependencies } from './workspace-routes.js'

function build() {
  const calls: unknown[][] = []
  const auth: AuthService = {
    requestCode: async () => 'ignored', verify: async () => null, endSession: async () => undefined,
    getSession: async (token) => token === 'tok' ? { tenantId: 'mine', tenantName: 'Studio', contactName: null } : null,
  }
  const workspace: WorkspaceDependencies = {
    connection: async (tenantId) => (calls.push(['connection', tenantId]), { enabled: true, connection: 'connected', lastMessageAt: null, lastError: null }),
    reconnect: async (tenantId) => (calls.push(['reconnect', tenantId]), true),
    disconnect: async (tenantId) => void calls.push(['disconnect', tenantId]),
    billing: async (tenantId) => (calls.push(['billing', tenantId]), { subscription: null, plans: [], latestRequest: null }),
    requestPayment: async (tenantId, plan, months) => (calls.push(['payment', tenantId, plan, months]), plan === 'basic'),
    agenda: async (tenantId) => (calls.push(['agenda', tenantId]), []),
    setAction: async (tenantId, eventId, status, date) => (calls.push(['action', tenantId, eventId, status, date]), eventId === 'event'),
    search: async (tenantId, query) => (calls.push(['search', tenantId, query]), []),
    report: async (tenantId) => (calls.push(['report', tenantId]), { from: '2026-11-02', to: '2026-11-08', projects: [] }),
    preferences: async (tenantId) => (calls.push(['preferences', tenantId]), { reminderLeadDays: 1, weeklyReportEnabled: true }),
    setPreferences: async (tenantId, days, enabled) => (calls.push(['setPreferences', tenantId, days, enabled]), true),
  }
  return { app: createApp({ checkDatabase: async () => undefined, auth: { service: auth, secureCookies: false }, workspace }), calls }
}

const headers = { cookie: 'aksis_app=tok', 'content-type': 'application/json' }
const write = (app: ReturnType<typeof build>['app'], method: 'POST' | 'PUT', path: string, body: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method, headers: { ...headers, ...extra }, body: JSON.stringify(body) })

describe('customer workspace routes', () => {
  it('require an app session and never accept a tenant from the request', async () => {
    const { app, calls } = build()
    expect((await app.request('/v1/workspace/connection')).status).toBe(401)
    expect((await app.request('/v1/workspace/connection?tenantId=other', { headers })).status).toBe(200)
    expect((await app.request('/v1/workspace/billing', { headers })).status).toBe(200)
    expect((await app.request('/v1/workspace/agenda', { headers })).status).toBe(200)
    expect((await app.request('/v1/workspace/search?q=tagihan', { headers })).status).toBe(200)
    expect((await app.request('/v1/workspace/report', { headers })).status).toBe(200)
    expect((await app.request('/v1/workspace/preferences', { headers })).status).toBe(200)
    expect(calls).toEqual([
      ['connection', 'mine'], ['billing', 'mine'], ['agenda', 'mine'], ['search', 'mine', 'tagihan'], ['report', 'mine'], ['preferences', 'mine'],
    ])
  })

  it('scope writes to the session and reject cross-site writes', async () => {
    const { app, calls } = build()
    expect((await write(app, 'POST', '/v1/workspace/connection/reconnect', {})).status).toBe(200)
    expect((await write(app, 'POST', '/v1/workspace/connection/disconnect', {})).status).toBe(200)
    expect((await write(app, 'POST', '/v1/workspace/billing/request', { tenantId: 'other', planCode: 'basic', months: 3 })).status).toBe(200)
    expect((await write(app, 'PUT', '/v1/workspace/agenda/event', { status: 'snoozed', snoozedUntil: '2026-11-10' })).status).toBe(200)
    expect((await write(app, 'PUT', '/v1/workspace/preferences', { reminderLeadDays: 3, weeklyReportEnabled: false })).status).toBe(200)
    expect((await write(app, 'POST', '/v1/workspace/connection/reconnect', {}, { origin: 'https://evil.example', host: 'aksis.test' })).status).toBe(403)
    expect(calls).toEqual([
      ['reconnect', 'mine'], ['disconnect', 'mine'], ['payment', 'mine', 'basic', 3], ['action', 'mine', 'event', 'snoozed', '2026-11-10'], ['setPreferences', 'mine', 3, false],
    ])
  })

  it('reject invalid payment and agenda input', async () => {
    const { app, calls } = build()
    expect((await write(app, 'POST', '/v1/workspace/billing/request', { planCode: 'basic', months: '3' })).status).toBe(409)
    expect((await write(app, 'PUT', '/v1/workspace/agenda/event', { status: 'bad' })).status).toBe(400)
    expect(calls).toEqual([])
  })
})
