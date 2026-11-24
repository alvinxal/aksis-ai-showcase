// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Llm } from './chat.js'
import { createDatabase, type Database } from './db.js'
import { FeatureHealth } from './health.js'
import { getProject, listProjects } from './projects.js'
import { refreshOnOpen, summaryPrompt, sweepSummaries, SUMMARY_PER_SWEEP } from './summary.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('project summaries', () => {
  let sql: Database
  const tenants: string[] = []
  const prompts: string[] = []
  const llm: Llm = async ({ prompt }) => (prompts.push(prompt), { text: 'Proyek jalan.\nTermin 2 jatuh tempo Jumat.', inputTokens: 2000, outputTokens: 100 })

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
    prompts.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  const tenant = async (extra: { status?: string; paused?: boolean; endsInDays?: number } = {}) => {
    const [row] = await sql<Array<{ id: string }>>`
      insert into tenants (name, status, usage_paused) values (${`T ${randomUUID()}`}, ${extra.status ?? 'active'}, ${extra.paused ?? false}) returning id
    `
    tenants.push(row!.id)
    await sql`
      insert into subscriptions (tenant_id, plan_code, started_at, ends_at)
      values (${row!.id}, (select code from plans limit 1), now() - interval '20 days', now() + ${extra.endsInDays ?? 10} * interval '1 day')
    `
    return row!.id
  }
  // Tests run in parallel against one database and a sweep is global, so every project gets a unique name.
  const names = new Map<string, string>()
  const project = async (tenantId: string, label = 'Rumah', withEvent = true) => {
    const name = `${label} ${randomUUID().slice(0, 8)}`
    const [row] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, ${name}) returning id`
    await sql`
      insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id)
      values (${tenantId}, ${`${randomUUID()}@g.us`}, ${name}, true, ${row!.id})
    `
    names.set(row!.id, name)
    if (withEvent) await event(tenantId, row!.id, `Keputusan ${name}`)
    return row!.id
  }
  const promptsFor = (projectId: string) => prompts.filter((prompt) => prompt.includes(`PROJECT: ${names.get(projectId)}`))
  const event = async (tenantId: string, projectId: string, title: string) => {
    const [run] = await sql<Array<{ id: string }>>`
      insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'completed', 'test') returning id
    `
    await sql`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at)
      values (${tenantId}, ${projectId}, ${run!.id}, 'DECISION_DETECTED', ${title}, ${sql.json({})}, 0.9, now())
    `
  }
  // Other test files delete tenants in parallel, which can make Postgres abort one sweep with a deadlock; the
  // sweep skips such a project and the next one picks it up, so a test that expects a note allows a few sweeps.
  const sweepUntilNote = async (tenantId: string, projectId: string) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sweepSummaries(sql, llm, 100)
      if ((await getProject(sql, tenantId, projectId))?.note) return
      await sql`update project_summaries set attempted_at = null where project_id = ${projectId}`
    }
  }
  const noteOf = async (tenantId: string, projectId: string) => (await getProject(sql, tenantId, projectId))?.note ?? null

  it('writes a note for a project with events, shows it in the list and detail, and records the cost', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId)
    expect(await noteOf(tenantId, projectId)).toBeNull()
    await sweepUntilNote(tenantId, projectId)
    expect(promptsFor(projectId).some((prompt) => prompt.includes(`Keputusan ${names.get(projectId)}`))).toBe(true)
    const note = await noteOf(tenantId, projectId)
    expect(note?.text).toBe('Proyek jalan. Termin 2 jatuh tempo Jumat.')
    expect((await listProjects(sql, tenantId))[0]?.note?.text).toBe(note?.text)
    const [run] = await sql<Array<{ kind: string; cost: string }>>`
      select source_kind as kind, estimated_cost_usd as cost from analysis_runs where tenant_id = ${tenantId} and source_kind = 'summary'
    `
    expect(run?.kind).toBe('summary')
    expect(Number(run!.cost)).toBeCloseTo(0.00072, 6)
  })

  it('does not write again until there is a newer event and the note is old enough', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId)
    await sweepUntilNote(tenantId, projectId)
    const first = await noteOf(tenantId, projectId)
    prompts.length = 0
    await sweepSummaries(sql, llm, 100)
    expect(promptsFor(projectId)).toHaveLength(0)
    await event(tenantId, projectId, 'Baru')
    await sweepSummaries(sql, llm, 100)
    expect(promptsFor(projectId)).toHaveLength(0)
    await sql`update project_summaries set generated_at = now() - interval '4 hours' where project_id = ${projectId}`
    await sweepSummaries(sql, llm, 100)
    expect(promptsFor(projectId)).toHaveLength(1)
    expect((await noteOf(tenantId, projectId))?.writtenAt).not.toBe(first?.writtenAt)
  })

  it('skips projects without events, and tenants behind the AI gate', async () => {
    const empty = await tenant()
    const emptyProject = await project(empty, 'Kosong', false)
    const paused = await tenant({ paused: true })
    const pausedProject = await project(paused, 'Dijeda')
    const disabled = await tenant({ status: 'disabled' })
    const disabledProject = await project(disabled, 'Nonaktif')
    const expired = await tenant({ endsInDays: -10 })
    const expiredProject = await project(expired, 'Kedaluwarsa')
    await sweepSummaries(sql, llm, 100)
    expect(await noteOf(empty, emptyProject)).toBeNull()
    expect(await noteOf(paused, pausedProject)).toBeNull()
    expect(await noteOf(disabled, disabledProject)).toBeNull()
    expect(await noteOf(expired, expiredProject)).toBeNull()
    for (const id of [emptyProject, pausedProject, disabledProject, expiredProject]) expect(promptsFor(id)).toHaveLength(0)
  })

  it('writes only a few notes per sweep', async () => {
    const tenantId = await tenant()
    for (let i = 0; i < SUMMARY_PER_SWEEP + 2; i += 1) await project(tenantId, `Proyek ${i}`)
    expect(await sweepSummaries(sql, llm)).toBeLessThanOrEqual(SUMMARY_PER_SWEEP)
    expect(prompts.length).toBeLessThanOrEqual(SUMMARY_PER_SWEEP)
    const written = (await listProjects(sql, tenantId)).filter((item) => item.note)
    expect(written.length).toBeLessThanOrEqual(SUMMARY_PER_SWEEP)
  })

  it('stores nothing and waits before retrying when the model fails', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId)
    const failing: Llm = async () => {
      throw new Error('down')
    }
    await sweepSummaries(sql, failing, 100)
    expect(await noteOf(tenantId, projectId)).toBeNull()
    prompts.length = 0
    await sweepSummaries(sql, llm, 100)
    expect(promptsFor(projectId)).toHaveLength(0)
    await sql`update project_summaries set attempted_at = now() - interval '1 hour' where project_id = ${projectId}`
    await sweepUntilNote(tenantId, projectId)
    expect(await noteOf(tenantId, projectId)).not.toBeNull()
  })

  it('keeps a note private to its own tenant and gives the model only that project', async () => {
    const mine = await tenant()
    const other = await tenant()
    const mineProject = await project(mine, 'Punya Saya')
    const otherProject = await project(other, 'Rahasia Lain')
    await sweepUntilNote(mine, mineProject)
    await sweepUntilNote(other, otherProject)
    expect((await listProjects(sql, other)).map((item) => item.id)).toEqual([otherProject])
    expect((await listProjects(sql, mine)).map((item) => item.id)).toEqual([mineProject])
    expect(promptsFor(mineProject)[0]).not.toContain('Rahasia Lain')
    expect(promptsFor(otherProject)[0]).not.toContain('Punya Saya')
  })

  it('builds a prompt with the date and without internal words asked for', () => {
    const prompt = summaryPrompt('Rumah Budi', 'MATERIAL TEST', new Date('2026-10-29T03:00:00Z'))
    expect(prompt).toContain('PROJECT: Rumah Budi')
    expect(prompt).toMatch(/TODAY: .*29 Oktober 2026/)
    expect(prompt).toContain('MATERIAL TEST')
  })

  it('tells the health tracker about each note, written or failed', async () => {
    const tenantId = await tenant()
    await project(tenantId)
    const failing: Llm = async () => {
      throw new Error('down')
    }
    const health = new FeatureHealth()
    await sweepSummaries(sql, failing, 100, health)
    const afterFailure = health.recent('summary', 60_000)
    expect(afterFailure.failures).toBeGreaterThanOrEqual(1)
    expect(afterFailure.successes).toBe(0)
    await sql`update project_summaries set attempted_at = null where tenant_id = ${tenantId}`
    await sweepSummaries(sql, llm, 100, health)
    expect(health.recent('summary', 60_000).successes).toBeGreaterThanOrEqual(1)
  })

  it('refreshes only the opening customer\'s projects, at most once an hour, and not behind a closed AI gate', async () => {
    const mine = await tenant()
    const other = await tenant()
    const paused = await tenant({ paused: true })
    const p1 = await project(mine)
    const p2 = await project(other)
    const p3 = await project(paused)
    // A note written a minute ago is outdated by a newer event, which the 3-hour sweep rule would still skip.
    await sql`insert into project_summaries (project_id, tenant_id, text, generated_at) values (${p1}, ${mine}, 'lama', now() - interval '1 minute')`
    await event(mine, p1, 'Keputusan baru')
    const now = Date.now()
    expect(refreshOnOpen(sql, llm, mine, undefined, now)).toBe(true)
    expect(refreshOnOpen(sql, llm, mine, undefined, now + 60_000)).toBe(false)
    expect(refreshOnOpen(sql, llm, paused, undefined, now)).toBe(true)
    for (let wait = 0; wait < 50 && promptsFor(p1).length === 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(promptsFor(p1)).toHaveLength(1)
    expect(promptsFor(p2)).toHaveLength(0)
    expect(promptsFor(p3)).toHaveLength(0)
    expect(refreshOnOpen(sql, llm, mine, undefined, now + 61 * 60_000)).toBe(true)
  })
})
