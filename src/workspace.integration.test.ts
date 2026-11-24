// Real-database test, run with AKSIS_TEST_DATABASE_URL.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db.js'
import { grantSubscription } from './billing.js'
import {
  getReminderPreferences,
  listAgenda,
  requestPayment,
  searchWorkspace,
  setAgendaAction,
  setReminderPreferences,
  weeklyReport,
} from './workspace.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('customer workspace data', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => { sql = createDatabase(url!) })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
  })
  afterAll(async () => { await sql.end() })

  const tenant = async () => {
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name) values (${`Workspace ${randomUUID()}`}) returning id`
    tenants.push(row!.id)
    return row!.id
  }
  const event = async (tenantId: string, title: string, amount = 12_000_000) => {
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, ${`Rumah ${randomUUID().slice(0, 6)}`}) returning id`
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${project!.id}, 'completed', 'test') returning id`
    const [entry] = await sql<Array<{ id: string }>>`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at, due_at)
      values (${tenantId}, ${project!.id}, ${run!.id}, 'PAYMENT_DUE', ${title}, ${sql.json({ amount })}, 0.9, now(), now() + interval '1 day') returning id
    `
    return { projectId: project!.id, eventId: entry!.id }
  }

  it('keeps agenda actions, search and reports inside one tenant', async () => {
    const mine = await tenant()
    const other = await tenant()
    const own = await event(mine, 'Termin rahasia saya')
    await event(other, 'Termin pelanggan lain')

    expect((await listAgenda(sql, mine)).map((item) => item.title)).toEqual(['Termin rahasia saya'])
    expect((await searchWorkspace(sql, mine, 'rahasia')).map((item) => item.title)).toEqual(['Termin rahasia saya'])
    expect(await searchWorkspace(sql, mine, 'pelanggan lain')).toEqual([])
    expect((await weeklyReport(sql, mine)).projects[0]?.payments).toEqual(['Termin rahasia saya'])

    expect(await setAgendaAction(sql, mine, own.eventId, 'done', null)).toBe(true)
    expect((await listAgenda(sql, mine))[0]?.status).toBe('done')
    expect(await setAgendaAction(sql, other, own.eventId, 'done', null)).toBe(false)
  })

  it('stores reminder choices and only one pending payment request', async () => {
    const tenantId = await tenant()
    expect(await getReminderPreferences(sql, tenantId)).toEqual({ reminderLeadDays: 1, weeklyReportEnabled: true })
    expect(await setReminderPreferences(sql, tenantId, 3, false)).toBe(true)
    expect(await getReminderPreferences(sql, tenantId)).toEqual({ reminderLeadDays: 3, weeklyReportEnabled: false })
    expect(await setReminderPreferences(sql, tenantId, 2, true)).toBe(false)

    expect(await requestPayment(sql, tenantId, 'basic', 3)).toBe(true)
    expect(await requestPayment(sql, tenantId, 'pro', 1)).toBe(false)
    const [row] = await sql<Array<{ plan_code: string; months: number; status: string }>>`select plan_code, months, status from payment_requests where tenant_id = ${tenantId}`
    expect(row).toEqual({ plan_code: 'basic', months: 3, status: 'pending' })
    expect(await grantSubscription(sql, tenantId, 'basic', 3, 123)).not.toBeNull()
    const [confirmed] = await sql<Array<{ status: string }>>`select status from payment_requests where tenant_id = ${tenantId}`
    expect(confirmed?.status).toBe('confirmed')
  })
})
