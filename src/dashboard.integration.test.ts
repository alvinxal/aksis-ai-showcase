// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { createLoginLink, endDashboardSession, exchangeLoginLink, getDashboardSession, purgeDashboardAuth } from './dashboard-auth.js'
import * as data from './dashboard-data.js'
import { createDatabase, saveWhatsAppMessage, type Database } from './db.js'
import { createLead } from './leads.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const ADMIN = 424242
const admins = new Set([ADMIN])
const isAdmin = (id: number) => admins.has(id)
const live: data.Live = {
  connectionOf: () => 'connected',
  whatsapp: () => [],
  hermesHealthy: async () => true,
  systemConnection: () => ({ connection: 'connected', paired: true }),
}

describe.skipIf(!url)('admin dashboard', () => {
  let sql: Database
  const tenants: string[] = []
  const phones: string[] = []
  let reloads = 0
  const calls: string[] = []
  const hooks = {
    resumeWhatsApp: async (id: string) => void calls.push(`resume:${id}`),
    removeSession: async (id: string) => void calls.push(`remove:${id}`),
    reevaluateLimits: async () => void calls.push('reevaluate'),
    sendAccessInfo: async (id: string) => (calls.push(`access:${id}`), true),
  }

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    admins.clear()
    admins.add(ADMIN)
    if (tenants.length) {
      await sql`delete from analysis_run_messages where analysis_run_id in (select id from analysis_runs where tenant_id in ${sql(tenants)})`
      await sql`delete from project_event_sources where event_id in (select id from project_events where tenant_id in ${sql(tenants)})`
      await sql`delete from tenants where id in ${sql(tenants)}`
    }
    tenants.length = 0
    if (phones.length) await sql`delete from leads where phone in ${sql(phones)}`
    phones.length = 0
    await sql`delete from dashboard_logins where telegram_id = ${ADMIN}`
    await sql`delete from dashboard_sessions where telegram_id = ${ADMIN}`
  })
  afterAll(async () => {
    await sql.end()
  })

  describe('login link and session', () => {
    it('spends a link once and only for an admin', async () => {
      const { token } = await createLoginLink(sql, ADMIN)
      const first = await exchangeLoginLink(sql, token, isAdmin)
      expect(first?.telegramId).toBe(ADMIN)
      expect(await exchangeLoginLink(sql, token, isAdmin)).toBeNull()
      expect(await exchangeLoginLink(sql, 'not-a-token', isAdmin)).toBeNull()

      const other = await createLoginLink(sql, ADMIN)
      admins.clear()
      expect(await exchangeLoginLink(sql, other.token, isAdmin)).toBeNull()
    })

    it('refuses an expired link and an expired session, and a session of somebody who stopped being an admin', async () => {
      const { token } = await createLoginLink(sql, ADMIN)
      await sql`update dashboard_logins set expires_at = now() - interval '1 second' where telegram_id = ${ADMIN}`
      expect(await exchangeLoginLink(sql, token, isAdmin)).toBeNull()

      const fresh = await createLoginLink(sql, ADMIN)
      const session = (await exchangeLoginLink(sql, fresh.token, isAdmin))!
      expect(await getDashboardSession(sql, session.sessionToken, isAdmin)).toEqual({ telegramId: ADMIN })
      admins.clear()
      expect(await getDashboardSession(sql, session.sessionToken, isAdmin)).toBeNull()
      admins.add(ADMIN)
      await sql`update dashboard_sessions set expires_at = now() - interval '1 second' where telegram_id = ${ADMIN}`
      expect(await getDashboardSession(sql, session.sessionToken, isAdmin)).toBeNull()
      expect(await purgeDashboardAuth(sql)).toBeGreaterThanOrEqual(1)
    })

    it('ends a session on logout', async () => {
      const { token } = await createLoginLink(sql, ADMIN)
      const session = (await exchangeLoginLink(sql, token, isAdmin))!
      await endDashboardSession(sql, session.sessionToken)
      expect(await getDashboardSession(sql, session.sessionToken, isAdmin)).toBeNull()
    })
  })

  describe('routes', () => {
    const build = () => createApp({ checkDatabase: async () => undefined, dashboard: { database: sql, isAdmin, owners: new Set([ADMIN]), reloadAdmins: async () => { reloads += 1 }, live, hooks, secureCookies: false, publicBaseUrl: 'https://aksis.test', autoDeleteExpired: false } })
    const json = { 'content-type': 'application/json', host: 'aksis.test' }
    const login = async (app: ReturnType<typeof build>) => {
      const { token } = await createLoginLink(sql, ADMIN)
      const response = await app.request('/v1/dashboard/login', { method: 'POST', headers: json, body: JSON.stringify({ token }) })
      return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
    }

    it('answers 401 to everything without a session', async () => {
      const app = build()
      for (const path of ['me', 'overview', 'customers', 'usage', 'requests', 'health', 'audit']) {
        const response = await app.request(`/v1/dashboard/${path}`)
        expect(response.status, path).toBe(401)
      }
    })

    it('logs in with a link once, then serves the data with the cookie, never cached', async () => {
      const app = build()
      const { response, cookie } = await login(app)
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i)
      expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/i)
      expect(cookie).toMatch(/^aksis_dash=/)
      for (const path of ['me', 'overview', 'customers', 'usage?days=7', 'requests', 'health', 'audit']) {
        const result = await app.request(`/v1/dashboard/${path}`, { headers: { cookie } })
        expect(result.status, path).toBe(200)
        expect(result.headers.get('cache-control')).toBe('no-store')
      }
      const reused = await app.request('/v1/dashboard/login', { method: 'POST', headers: json, body: JSON.stringify({ token: 'x' }) })
      expect(reused.status).toBe(401)
      const logout = await app.request('/v1/dashboard/logout', { method: 'POST', headers: { ...json, cookie } })
      expect(logout.status).toBe(200)
      expect((await app.request('/v1/dashboard/me', { headers: { cookie } })).status).toBe(401)
    })

    it('changes access requests only with a session, same origin and JSON, and writes ids only to the audit', async () => {
      const app = build()
      const phone = () => `62${Math.floor(1e9 + Math.random() * 8e9)}`
      const make = async () => {
        const lead = await createLead(sql, 'Calon Pelanggan', phone(), 'v1')
        phones.push(lead!.phone)
        return lead!
      }
      const post = (id: string, action: string, headers: Record<string, string>) => app.request(`/v1/dashboard/requests/${id}/${action}`, { method: 'POST', headers, body: '{}' })
      const lead = await make()
      expect((await post(lead.id, 'contacted', json)).status).toBe(401)

      const { cookie } = await login(app)
      expect((await post(lead.id, 'contacted', { ...json, cookie, origin: 'https://evil.example' })).status).toBe(403)
      expect((await post(lead.id, 'contacted', { 'content-type': 'text/plain', host: 'aksis.test', cookie })).status).toBe(415)
      expect((await post('not-a-uuid', 'contacted', { ...json, cookie })).status).toBe(404)
      expect((await post(randomUUID(), 'reject', { ...json, cookie })).status).toBe(404)

      expect((await post(lead.id, 'contacted', { ...json, cookie })).status).toBe(200)
      expect((await data.requests(sql)).find((row) => row.id === lead.id)?.status).toBe('contacted')
      expect((await post(lead.id, 'reject', { ...json, cookie })).status).toBe(200)
      expect((await data.requests(sql)).find((row) => row.id === lead.id)).toBeUndefined()

      const other = await make()
      const invited = await post(other.id, 'invite', { ...json, cookie })
      expect(invited.status).toBe(200)
      const body = (await invited.json()) as { link: string; tenantId: string; phone: string }
      tenants.push(body.tenantId)
      expect(body.link).toMatch(/^https:\/\/aksis\.test\/join\/.+/)
      expect(body.phone).toBe(other.phone)
      expect((await post(other.id, 'invite', { ...json, cookie })).status).toBe(404)

      const rows = await sql<Array<{ action: string; detail: Record<string, unknown> }>>`select action, detail from admin_audit where actor_telegram_id = ${ADMIN} and action in ('lead_contacted', 'lead_rejected', 'invite_created')`
      expect(rows.map((row) => row.action).sort()).toEqual(['invite_created', 'lead_contacted', 'lead_rejected'])
      expect(JSON.stringify(rows)).not.toContain('Calon Pelanggan')
      expect(JSON.stringify(rows)).not.toContain(other.phone)
      await sql`delete from admin_audit where actor_telegram_id = ${ADMIN}`
    })

    it('lets only an owner add and remove admins, never an owner, and writes ids only to the audit', async () => {
      const app = build()
      const newcomer = 9_000_000_000 + Math.floor(Math.random() * 1e8)
      const { cookie } = await login(app)
      const headers = { ...json, cookie }
      const post = (path: string, body: unknown, extra: Record<string, string> = headers) => app.request(`/v1/dashboard/admins${path}`, { method: 'POST', headers: extra, body: JSON.stringify(body) })
      try {
        expect((await app.request('/v1/dashboard/admins')).status).toBe(401)
        expect((await post('', { telegramId: newcomer }, json)).status).toBe(401)
        expect((await post('', { telegramId: newcomer }, { ...headers, origin: 'https://evil.example' })).status).toBe(403)
        expect((await post('', { telegramId: 'abc' })).status).toBe(400)
        expect((await post('', { telegramId: 123 })).status).toBe(400)

        const before = reloads
        expect((await post('', { telegramId: String(newcomer) })).status).toBe(200)
        expect(reloads).toBe(before + 1)
        const list = (await (await app.request('/v1/dashboard/admins', { headers: { cookie } })).json()) as { admins: Array<{ telegramId: number; owner: boolean; addedBy: number | null }>; canManage: boolean }
        expect(list.canManage).toBe(true)
        expect(list.admins.find((row) => row.telegramId === ADMIN)?.owner).toBe(true)
        expect(list.admins.find((row) => row.telegramId === newcomer)).toMatchObject({ owner: false, addedBy: ADMIN })

        expect((await post(`/${ADMIN}/remove`, {})).status).toBe(404)
        expect((await post('/1234567/remove', {})).status).toBe(404)
        expect((await post(`/${newcomer}/remove`, {})).status).toBe(200)
        expect(reloads).toBe(before + 2)
        expect((await post(`/${newcomer}/remove`, {})).status).toBe(404)

        const rows = await sql<Array<{ action: string; detail: Record<string, unknown> }>>`select action, detail from admin_audit where actor_telegram_id = ${ADMIN} and action in ('admin_added', 'admin_removed')`
        expect(rows.map((row) => row.action).sort()).toEqual(['admin_added', 'admin_removed'])
        expect(rows.every((row) => row.detail.telegramId === newcomer)).toBe(true)

        // An admin who is not an owner can read the list but not change it.
        const helper = 9_100_000_000 + Math.floor(Math.random() * 1e8)
        admins.add(helper)
        const link = await createLoginLink(sql, helper)
        const exchanged = await app.request('/v1/dashboard/login', { method: 'POST', headers: json, body: JSON.stringify({ token: link.token }) })
        const helperCookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
        const helperHeaders = { ...json, cookie: helperCookie }
        expect(((await (await app.request('/v1/dashboard/admins', { headers: { cookie: helperCookie } })).json()) as { canManage: boolean }).canManage).toBe(false)
        expect((await post('', { telegramId: String(newcomer) }, helperHeaders)).status).toBe(403)
        await sql`delete from dashboard_sessions where telegram_id = ${helper}`
        await sql`delete from dashboard_logins where telegram_id = ${helper}`
      } finally {
        await sql`delete from admins where telegram_id = ${newcomer}`
        await sql`delete from admin_audit where actor_telegram_id = ${ADMIN}`
      }
    })

    it('manages a customer like the bot does: create, rename, notes, status, pause, limits, plan, delete', async () => {
      const app = build()
      const { cookie } = await login(app)
      const headers = { ...json, cookie }
      const post = (path: string, body: unknown, extra: Record<string, string> = headers) => app.request(`/v1/dashboard${path}`, { method: 'POST', headers: extra, body: JSON.stringify(body) })
      calls.length = 0

      expect((await post('/customers', { name: 'Studio Baru' }, json)).status).toBe(401)
      expect((await post('/customers', { name: '  ' })).status).toBe(400)
      expect((await post('/customers', { name: 'Studio Baru', phone: '12' })).status).toBe(400)
      const created = await post('/customers', { name: 'Studio Baru', phone: '+62 812-3456-7890' })
      expect(created.status).toBe(200)
      const invite = (await created.json()) as { tenantId: string; link: string; phone: string }
      tenants.push(invite.tenantId)
      expect(invite.link).toMatch(/^https:\/\/aksis\.test\/join\/.+/)
      expect(invite.phone).toBe('628123456789' + '0')
      const id = invite.tenantId
      const mine = async () => (await data.customers(sql, live)).find((row) => row.id === id)!
      const sub = (path: string, body: unknown) => post(`/customers/${id}${path}`, body)

      expect((await post(`/customers/not-a-uuid/rename`, { name: 'x' })).status).toBe(404)
      expect((await post(`/customers/${randomUUID()}/rename`, { name: 'x' })).status).toBe(404)
      expect((await sub('/rename', { name: '' })).status).toBe(400)
      expect((await sub('/rename', { name: '  Studio Satu  ' })).status).toBe(200)
      expect((await mine()).name).toBe('Studio Satu')

      expect((await sub('/notes', { notes: 'Bayar tiap tanggal 5' })).status).toBe(200)
      expect((await mine()).notes).toBe('Bayar tiap tanggal 5')
      expect((await sub('/notes', { notes: '' })).status).toBe(200)
      expect((await mine()).notes).toBeNull()

      expect((await sub('/status', { status: 'weird' })).status).toBe(400)
      const activated = (await (await sub('/status', { status: 'active' })).json()) as { accessSent: boolean }
      expect(activated.accessSent).toBe(true)
      expect((await mine()).status).toBe('active')
      expect((await mine()).subscription).toBe('trial')
      expect(calls).toEqual(expect.arrayContaining([`resume:${id}`, `access:${id}`]))
      expect((await sub('/status', { status: 'disabled' })).status).toBe(200)
      expect((await mine()).status).toBe('disabled')

      calls.length = 0
      expect((await sub('/pause', { paused: 'yes' })).status).toBe(400)
      expect((await sub('/pause', { paused: true })).status).toBe(200)
      expect((await mine()).paused).toBe(true)
      expect((await sub('/pause', { paused: false })).status).toBe(200)
      expect(calls.filter((call) => call === 'reevaluate')).toHaveLength(2)

      expect((await sub('/limits', { scope: 'daily', usd: 3 })).status).toBe(400)
      expect((await sub('/limits', { scope: 'weekly', usd: 1 })).status).toBe(400)
      expect((await sub('/limits', { scope: 'daily', usd: 0.5 })).status).toBe(200)
      expect((await sub('/limits', { scope: 'monthly', usd: 0 })).status).toBe(200)
      expect((await mine()).limitUsd).toEqual({ daily: 0.5, monthly: null })

      const plans = (await (await app.request('/v1/dashboard/customers', { headers: { cookie } })).json()) as { plans: Array<{ code: string }>; choices: { months: number[] } }
      expect(plans.plans.length).toBeGreaterThan(0)
      expect(plans.choices.months).toEqual([1, 3, 12])
      expect((await sub('/subscription', { plan: 'nope', months: 1 })).status).toBe(400)
      expect((await sub('/subscription', { plan: plans.plans[0]!.code, months: 2 })).status).toBe(400)
      expect((await sub('/subscription', { plan: plans.plans[0]!.code, months: 1 })).status).toBe(200)
      expect((await mine()).subscription).toBe('active')
      const [queued] = await sql<Array<{ n: number }>>`select count(*)::int as n from outbound_messages where tenant_id = ${id}`
      expect(queued!.n).toBe(1)

      calls.length = 0
      expect((await sub('/delete', {})).status).toBe(400)
      expect((await sub('/delete', { confirmName: 'Studio Lain' })).status).toBe(400)
      expect((await mine()).name).toBe('Studio Satu')
      expect((await sub('/delete', { confirmName: 'Studio Satu' })).status).toBe(200)
      expect(calls).toEqual([`remove:${id}`])
      expect((await data.customers(sql, live)).find((row) => row.id === id)).toBeUndefined()
      expect((await sub('/delete', { confirmName: 'Studio Satu' })).status).toBe(404)

      const audit = await sql<Array<{ action: string }>>`select action from admin_audit where actor_telegram_id = ${ADMIN} order by created_at`
      expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['invite_created', 'tenant_renamed', 'tenant_notes', 'tenant_active', 'tenant_disabled', 'usage_paused', 'limit_changed', 'subscription_granted', 'tenant_deleted']))
      expect(JSON.stringify(audit)).not.toContain('Bayar tiap tanggal 5')
      await sql`delete from admin_audit where actor_telegram_id = ${ADMIN}`
    })

    it('corrects a plan exactly, ends it, pairs WhatsApp again and renews an invitation', async () => {
      const app = build()
      const { cookie } = await login(app)
      const headers = { ...json, cookie }
      const post = (path: string, body: unknown) => app.request(`/v1/dashboard${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      const created = (await (await post('/customers', { name: 'Studio Pairing', phone: '6281234567890' })).json()) as { tenantId: string; link: string }
      const id = created.tenantId
      tenants.push(id)
      const mine = async () => (await data.customers(sql, live)).find((row) => row.id === id)!
      const sub = (path: string, body: unknown) => post(`/customers/${id}${path}`, body)
      const inDays = (days: number) => new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10)

      const plans = (await (await app.request('/v1/dashboard/customers', { headers: { cookie } })).json()) as { plans: Array<{ code: string }>; allPlans: Array<{ code: string }> }
      expect(plans.allPlans.map((plan) => plan.code)).toContain('trial')
      const paid = plans.plans[0]!.code

      expect((await sub('/subscription/set', { plan: paid, endsOn: 'soon' })).status).toBe(400)
      expect((await sub('/subscription/set', { plan: 'nope', endsOn: inDays(5) })).status).toBe(400)
      expect((await sub('/subscription/set', { plan: paid, endsOn: '2099-01-01' })).status).toBe(400)
      expect((await sub('/subscription/set', { plan: paid, endNow: true })).status).toBe(400)

      expect((await sub('/subscription/set', { plan: paid, endsOn: inDays(40) })).status).toBe(200)
      expect((await mine()).subscription).toBe('active')
      // Exactly that date, not an extension of the old one.
      expect((await sub('/subscription/set', { plan: paid, endsOn: inDays(10) })).status).toBe(200)
      expect(((await mine()).endsAt ?? '').slice(0, 10)).toBe(inDays(10))
      expect((await sub('/subscription/set', { plan: 'trial', endsOn: inDays(3) })).status).toBe(200)
      expect((await mine()).subscription).toBe('trial')
      expect((await sub('/subscription/set', { plan: 'trial', endNow: true })).status).toBe(200)
      expect((await mine()).subscription).toBe('grace')
      expect((await sub('/subscription/set', { plan: paid, endNow: true })).status).toBe(400)

      calls.length = 0
      await sql`update tenants set onboarded_at = now(), whatsapp_enabled = true, whatsapp_jid = '628111@s.whatsapp.net' where id = ${id}`
      const repaired = await sub('/repair', {})
      expect(repaired.status).toBe(200)
      const link = (await repaired.json()) as { link: string; phone: string | null }
      expect(link.link).toMatch(/^https:\/\/aksis\.test\/join\/.+/)
      expect(calls).toEqual([`remove:${id}`])
      const [tenant] = await sql<Array<{ onboarded_at: Date | null; whatsapp_enabled: boolean; whatsapp_jid: string | null }>>`select onboarded_at, whatsapp_enabled, whatsapp_jid from tenants where id = ${id}`
      expect(tenant).toMatchObject({ onboarded_at: null, whatsapp_enabled: false, whatsapp_jid: null })

      const renewed = (await (await sub('/invitation', {})).json()) as { link: string }
      expect(renewed.link).not.toBe(link.link)
      const [open] = await sql<Array<{ n: number }>>`select count(*)::int as n from invitations where tenant_id = ${id} and used_at is null and revoked_at is null`
      expect(open!.n).toBe(1)
      expect((await post(`/customers/${randomUUID()}/repair`, {})).status).toBe(404)

      const audit = await sql<Array<{ action: string }>>`select action from admin_audit where actor_telegram_id = ${ADMIN}`
      expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['subscription_set', 'subscription_ended', 'whatsapp_repair', 'invite_renewed']))
      await sql`delete from admin_audit where actor_telegram_id = ${ADMIN}`
    })

    it('blocks cross-site and non-JSON login attempts and limits repeated tries', async () => {
      const app = build()
      expect((await app.request('/v1/dashboard/login', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403)
      expect((await app.request('/v1/dashboard/login', { method: 'POST', headers: { 'content-type': 'text/plain', host: 'aksis.test' }, body: 'x' })).status).toBe(415)
      let last = 0
      for (let i = 0; i < 12; i += 1) last = (await app.request('/v1/dashboard/login', { method: 'POST', headers: json, body: JSON.stringify({ token: `bad${i}` }) })).status
      expect(last).toBe(429)
    })
  })

  describe('data', () => {
    it('never contains message text, group or contact names or what the chat said', async () => {
      const [tenant] = await sql<Array<{ id: string }>>`insert into tenants (name, status, usage_paused) values (${`Studio ${randomUUID()}`}, 'active', true) returning id`
      const tenantId = tenant!.id
      tenants.push(tenantId)
      const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, 'PROYEK-RAHASIA') returning id`
      await sql`insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id) values (${tenantId}, ${`${randomUUID()}@g.us`}, 'GRUP-RAHASIA', true, ${project!.id})`
      await sql`insert into whatsapp_contacts (tenant_id, jid, display_name, selected, project_id) values (${tenantId}, ${`62${Math.floor(1e9 + Math.random() * 8e9)}@s.whatsapp.net`}, 'KONTAK-RAHASIA', true, ${project!.id})`
      await sql`insert into subscriptions (tenant_id, plan_code, started_at, ends_at) values (${tenantId}, 'basic', now() - interval '60 days', now() - interval '20 days')`
      await saveWhatsAppMessage(sql, {
        tenantId, projectId: project!.id, whatsappMessageId: randomUUID(), chatJid: `${randomUUID()}@g.us`, senderJid: null, fromMe: false, isSelfChat: false,
        isAgentGenerated: false, sentAt: new Date(), messageType: 'conversation', textContent: 'ISI-PESAN-RAHASIA', rawPayload: { pushName: 'NAMA-PENGIRIM-RAHASIA' },
      })
      await sql`insert into chat_messages (tenant_id, agent, role, text) values (${tenantId}, 'aksis', 'user', 'PERTANYAAN-RAHASIA')`
      await sql`insert into chat_messages (tenant_id, agent, role, text) values (${tenantId}, 'aksis', 'agent', 'JAWABAN-RAHASIA')`
      const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model, estimated_cost_usd, error_text) values (${tenantId}, ${project!.id}, 'failed', 'm', 0.01, 'Hermes API returned 503') returning id`
      await sql`insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at) values (${tenantId}, ${project!.id}, ${run!.id}, 'DECISION_DETECTED', 'JUDUL-EVENT-RAHASIA', ${sql.json({ x: 'DETAIL-RAHASIA' })}, 0.9, now())`
      const lead = await createLead(sql, 'Calon Pelanggan', `62${Math.floor(1e9 + Math.random() * 8e9)}`, 'v1')
      phones.push(lead!.phone)
      await sql`insert into admin_audit (actor_telegram_id, action, tenant_id, detail) values (${ADMIN}, 'test_action', ${tenantId}, ${sql.json({ messages: 3, secretText: 'TEKS-AUDIT-RAHASIA', leadId: 'abc' })})`

      const everything = JSON.stringify([
        await data.overview(sql, live),
        await data.customers(sql, live),
        await data.usage(sql, 14),
        await data.requests(sql),
        await data.health(sql, live),
        await data.audit(sql, 200),
      ])
      for (const secret of ['RAHASIA']) expect(everything).not.toContain(secret)
      expect(everything).toContain('Calon Pelanggan')
    })

    it('describes a customer: plan state, WhatsApp state, counts, cost and the day its data will be deleted', async () => {
      const [tenant] = await sql<Array<{ id: string; name: string }>>`insert into tenants (name, status, usage_paused) values (${`Studio ${randomUUID()}`}, 'active', true) returning id, name`
      tenants.push(tenant!.id)
      await sql`insert into subscriptions (tenant_id, plan_code, started_at, ends_at) values (${tenant!.id}, 'basic', now() - interval '60 days', now() - interval '20 days')`
      const mine = (await data.customers(sql, live)).find((row) => row.id === tenant!.id)!
      expect(mine).toMatchObject({ name: tenant!.name, status: 'active', subscription: 'expired', plan: 'Basic', whatsapp: 'connected', groups: 0, messages: 0, paused: true, acceptedTerms: false })
      expect(new Date(mine.deletionOn!).getTime()).toBeGreaterThan(Date.now())
    })

    it('fills every day of the usage series, also days without runs', async () => {
      const result = await data.usage(sql, 7)
      expect(result.series).toHaveLength(7)
      expect(new Set(result.series.map((row) => row.day)).size).toBe(7)
      expect(await data.usage(sql, 500).then((value) => value.days)).toBe(90)
    })
  })
})
