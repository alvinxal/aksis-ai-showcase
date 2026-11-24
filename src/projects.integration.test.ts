// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db.js'
import { getProject, listProjects } from './projects.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const DAY = 86_400_000

describe.skipIf(!url)('project data for the app', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  const tenant = async () => {
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name) values (${`Test ${randomUUID()}`}) returning id`
    tenants.push(row!.id)
    return row!.id
  }
  const project = async (tenantId: string, name: string, group: string | null = name) => {
    const [row] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, ${name}) returning id`
    if (group) {
      await sql`
        insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id)
        values (${tenantId}, ${`${randomUUID()}@g.us`}, ${group}, true, ${row!.id})
      `
    }
    return row!.id
  }
  const event = async (
    tenantId: string,
    projectId: string,
    type: string,
    title: string,
    extra: { dueInDays?: number; amount?: number | null; ageDays?: number } = {},
  ) => {
    const [run] = await sql<Array<{ id: string }>>`
      insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'completed', 'test') returning id
    `
    const due = extra.dueInDays === undefined ? null : new Date(Date.now() + extra.dueInDays * DAY)
    const at = new Date(Date.now() - (extra.ageDays ?? 0) * DAY)
    const [row] = await sql<Array<{ id: string }>>`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at, due_at)
      values (${tenantId}, ${projectId}, ${run!.id}, ${type}::project_event_type, ${title},
        ${sql.json(extra.amount === undefined ? {} : { amount: extra.amount })}, 0.9, ${at}, ${due})
      returning id
    `
    return row!.id
  }

  it('lists only projects with a monitored group, and only the customer\'s own', async () => {
    const mine = await tenant()
    const other = await tenant()
    const shown = await project(mine, 'Rumah Budi')
    await project(mine, 'Umum', null)
    await project(other, 'Rumah Lain')
    const list = await listProjects(sql, mine)
    expect(list.map((item) => item.id)).toEqual([shown])
    expect(list[0]?.groups).toEqual(['Rumah Budi'])
  })

  it('never returns another customer\'s project', async () => {
    const mine = await tenant()
    const other = await tenant()
    const theirs = await project(other, 'Rumah Lain')
    await event(other, theirs, 'DECISION_DETECTED', 'Rahasia')
    expect(await getProject(sql, mine, theirs)).toBeNull()
    expect(await getProject(sql, mine, 'not-a-uuid')).toBeNull()
    expect(await getProject(sql, other, theirs)).not.toBeNull()
  })

  it('puts a due payment, a near deadline and a conflict in attention, urgent first', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId, 'Rumah Budi')
    await event(tenantId, projectId, 'PAYMENT_DUE', 'Termin 2', { dueInDays: 5, amount: 30_000_000 })
    await event(tenantId, projectId, 'DEADLINE_DETECTED', 'Survei lokasi', { dueInDays: 1 })
    await event(tenantId, projectId, 'DECISION_CONFLICT', 'Warna dinding berubah')
    await event(tenantId, projectId, 'DEADLINE_DETECTED', 'Masih jauh', { dueInDays: 40 })
    await event(tenantId, projectId, 'DECISION_DETECTED', 'Lantai granit abu')
    const detail = (await getProject(sql, tenantId, projectId))!
    expect(detail.attention.map((item) => item.title)).toEqual(['Survei lokasi', 'Warna dinding berubah', 'Termin 2'])
    expect(detail.attention[0]?.urgent).toBe(true)
    expect(detail.attention[2]?.urgent).toBe(false)
    expect(detail.decisions).toHaveLength(2)
    const [summary] = await listProjects(sql, tenantId)
    expect(summary).toMatchObject({ attention: 3, urgent: 1, counts: { decisions: 2, tasks: 2, payments: 1, revisions: 0 } })
  })

  it('leaves out a payment that a later "received" event with the same amount covers', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId, 'Rumah Budi')
    await event(tenantId, projectId, 'PAYMENT_DUE', 'Termin 1', { dueInDays: 2, amount: 30_000_000, ageDays: 3 })
    await event(tenantId, projectId, 'PAYMENT_RECEIVED', 'Termin 1 masuk', { amount: 30_000_000 })
    await event(tenantId, projectId, 'PAYMENT_DUE', 'Termin 2', { dueInDays: 2, amount: 20_000_000, ageDays: 3 })
    const detail = (await getProject(sql, tenantId, projectId))!
    expect(detail.attention.map((item) => item.title)).toEqual(['Termin 2'])
    expect(detail.payments).toHaveLength(3)
  })

  it('keeps an amount that was never written as null, and shows overdue items for a month only', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId, 'Rumah Budi')
    await event(tenantId, projectId, 'PAYMENT_DUE', 'Tanpa nominal', { dueInDays: -2 })
    await event(tenantId, projectId, 'PAYMENT_DUE', 'Sudah lama', { dueInDays: -90 })
    const detail = (await getProject(sql, tenantId, projectId))!
    expect(detail.payments.find((item) => item.title === 'Tanpa nominal')?.amount).toBeNull()
    expect(detail.attention.map((item) => item.title)).toEqual(['Tanpa nominal'])
    expect(detail.attention[0]?.urgent).toBe(true)
  })
})
