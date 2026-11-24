// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { usageByKind, USAGE_KIND_LABEL } from './admin.js'
import { createDatabase, type Database } from './db.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('AI cost per kind of work', () => {
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
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name) values (${`T ${randomUUID()}`}) returning id`
    tenants.push(row!.id)
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${row!.id}, 'P') returning id`
    return { id: row!.id, projectId: project!.id }
  }
  const run = (t: { id: string; projectId: string }, kind: string, cost: number | null, status = 'completed') =>
    sql`
      insert into analysis_runs (tenant_id, project_id, status, model, estimated_cost_usd, source_kind)
      values (${t.id}, ${t.projectId}, ${status}, 'test', ${cost}, ${kind})
    `
  const range = () => [new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)] as const

  it('adds up completed runs per kind, biggest cost first, for one customer', async () => {
    const mine = await tenant()
    const other = await tenant()
    await run(mine, 'group', 0.5)
    await run(mine, 'group', 0.25)
    await run(mine, 'app_chat', 0.1)
    await run(mine, 'summary', 0.01)
    await run(mine, 'contact', null)
    await run(other, 'group', 9)
    const [from, to] = range()
    expect(await usageByKind(sql, from, to, mine.id)).toEqual([
      { kind: 'group', runs: 2, costUsd: 0.75 },
      { kind: 'app_chat', runs: 1, costUsd: 0.1 },
      { kind: 'summary', runs: 1, costUsd: 0.01 },
      { kind: 'contact', runs: 1, costUsd: 0 },
    ])
  })

  it('leaves out failed and unfinished runs and runs outside the range', async () => {
    const mine = await tenant()
    await run(mine, 'group', 1, 'failed')
    await run(mine, 'group', 1, 'running')
    await sql`
      insert into analysis_runs (tenant_id, project_id, status, model, estimated_cost_usd, source_kind, started_at)
      values (${mine.id}, ${mine.projectId}, 'completed', 'test', 5, 'group', now() - interval '3 days')
    `
    const [from, to] = range()
    expect(await usageByKind(sql, from, to, mine.id)).toEqual([])
  })

  it('has a plain name for every kind a run can have', () => {
    for (const kind of ['self_chat', 'group', 'contact', 'app_chat', 'summary']) expect(USAGE_KIND_LABEL[kind]).toBeTruthy()
  })
})
