// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db.js'
import { createChatService, QUESTIONS_PER_HOUR, type Llm } from './chat.js'
import { FeatureHealth } from './health.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('app chat', () => {
  let sql: Database
  const tenants: string[] = []
  const prompts: string[] = []
  const llm: Llm = async ({ prompt }) => (prompts.push(prompt), { text: 'Termin 2 jatuh tempo Jumat (grup Rumah Budi, 27 Okt).', inputTokens: 1000, outputTokens: 100 })

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

  const tenant = async (name: string, extra: { status?: string; paused?: boolean; endsInDays?: number } = {}) => {
    const [row] = await sql<Array<{ id: string }>>`
      insert into tenants (name, status, usage_paused) values (${`${name} ${randomUUID()}`}, ${extra.status ?? 'active'}, ${extra.paused ?? false}) returning id
    `
    tenants.push(row!.id)
    const days = extra.endsInDays ?? 10
    await sql`
      insert into subscriptions (tenant_id, plan_code, started_at, ends_at)
      values (${row!.id}, (select code from plans limit 1), now() - interval '20 days', now() + ${days} * interval '1 day')
    `
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${row!.id}, 'Rumah Budi') returning id`
    await sql`
      insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id)
      values (${row!.id}, ${`${randomUUID()}@g.us`}, 'Rumah Budi', true, ${project!.id})
    `
    return { id: row!.id, projectId: project!.id }
  }
  const eventFor = async (tenantId: string, projectId: string, title: string) => {
    const [run] = await sql<Array<{ id: string }>>`
      insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'completed', 'test') returning id
    `
    await sql`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at)
      values (${tenantId}, ${projectId}, ${run!.id}, 'DECISION_DETECTED', ${title}, ${sql.json({})}, 0.9, now())
    `
  }

  it('answers from the tenant\'s own data only, stores the turn and records the cost as a run', async () => {
    const mine = await tenant('Mine')
    const other = await tenant('Other')
    await eventFor(mine.id, mine.projectId, 'Lantai granit abu')
    await eventFor(other.id, other.projectId, 'Rahasia tenant lain')
    const chat = createChatService(sql, llm)
    const result = await chat.ask(mine.id, 'aksis', 'Apa yang sudah diputuskan?')
    expect(result).toMatchObject({ ok: true, reply: { role: 'agent' } })
    expect(prompts[0]).toContain('Lantai granit abu')
    expect(prompts[0]).not.toContain('Rahasia tenant lain')
    const history = await chat.history(mine.id, 'aksis')
    expect(history.map((entry) => entry.role)).toEqual(['user', 'agent'])
    expect(await chat.history(other.id, 'aksis')).toEqual([])
    expect((await chat.latest(mine.id)).map((entry) => [entry.agent, entry.role])).toEqual([['aksis', 'agent']])
    expect(await chat.latest(other.id)).toEqual([])
    const [run] = await sql<Array<{ cost: string; kind: string; tokens: number }>>`
      select estimated_cost_usd as cost, source_kind as kind, input_tokens as tokens from analysis_runs
      where tenant_id = ${mine.id} and source_kind = 'app_chat'
    `
    expect(run).toMatchObject({ kind: 'app_chat', tokens: 1000 })
    expect(Number(run!.cost)).toBeCloseTo(0.00042, 6)
  })

  it('scopes the context to one project and refuses a project of another tenant', async () => {
    const mine = await tenant('Mine')
    const other = await tenant('Other')
    await eventFor(mine.id, mine.projectId, 'Atap baja ringan')
    const chat = createChatService(sql, llm)
    expect(await chat.ask(mine.id, 'aksis', 'Ringkas', other.projectId)).toEqual({ ok: false, reason: 'unknown_project' })
    expect(prompts).toHaveLength(0)
    expect((await chat.ask(mine.id, 'aksis', 'Ringkas', mine.projectId)).ok).toBe(true)
    expect(prompts[0]).toContain('Atap baja ringan')
  })

  it('stays behind the AI gate: paused, disabled and long-expired tenants get no answer and no model call', async () => {
    const paused = await tenant('Paused', { paused: true })
    const disabled = await tenant('Disabled', { status: 'disabled' })
    const expired = await tenant('Expired', { endsInDays: -10 })
    const chat = createChatService(sql, llm)
    for (const target of [paused, disabled, expired]) {
      expect(await chat.ask(target.id, 'aksis', 'Halo')).toEqual({ ok: false, reason: 'paused' })
    }
    expect(prompts).toHaveLength(0)
  })

  it('limits questions per hour, rejects empty and over-long ones, and stores nothing when the model fails', async () => {
    const mine = await tenant('Mine')
    const chat = createChatService(sql, llm)
    expect(await chat.ask(mine.id, 'aksis', '   ')).toEqual({ ok: false, reason: 'invalid' })
    expect(await chat.ask(mine.id, 'aksis', 'x'.repeat(1001))).toEqual({ ok: false, reason: 'invalid' })
    const failing = createChatService(sql, async () => {
      throw new Error('down')
    })
    expect(await failing.ask(mine.id, 'aksis', 'Halo')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await chat.history(mine.id, 'aksis')).toEqual([])
    // The failed question is not stored but it counts against the hour, so an unreachable agent cannot be hammered.
    for (let i = 0; i < QUESTIONS_PER_HOUR - 1; i += 1) expect((await chat.ask(mine.id, 'aksis', `Tanya ${i}`)).ok).toBe(true)
    expect(await chat.ask(mine.id, 'aksis', 'Satu lagi')).toEqual({ ok: false, reason: 'limited' })
  })

  it('refuses a second question while one is still being answered', async () => {
    const mine = await tenant('Mine')
    let release: () => void = () => undefined
    const slow = createChatService(sql, () => new Promise((resolve) => (release = () => resolve({ text: 'ok' }))))
    const first = slow.ask(mine.id, 'aksis', 'Pertama')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await slow.ask(mine.id, 'aksis', 'Kedua')).toEqual({ ok: false, reason: 'busy' })
    release()
    expect((await first).ok).toBe(true)
  })

  it('deletes turns older than the retention period when the customer asks again', async () => {
    const mine = await tenant('Mine')
    await sql`insert into chat_messages (tenant_id, agent, role, text, created_at) values (${mine.id}, 'aksis', 'user', 'lama', now() - interval '91 days')`
    const chat = createChatService(sql, llm)
    await chat.ask(mine.id, 'aksis', 'Baru')
    expect((await chat.history(mine.id, 'aksis')).map((entry) => entry.text)).not.toContain('lama')
  })

  it('tells the health tracker whether the answer worked, for the admin alerts', async () => {
    const mine = await tenant('Mine')
    const health = new FeatureHealth()
    const failing = createChatService(sql, async () => {
      throw new Error('down')
    }, health)
    await failing.ask(mine.id, 'aksis', 'Halo')
    await failing.ask(mine.id, 'aksis', 'Halo lagi')
    expect(health.recent('chat', 60_000)).toEqual({ failures: 2, successes: 0 })
    await createChatService(sql, llm, health).ask(mine.id, 'aksis', 'Sekarang')
    expect(health.recent('chat', 60_000)).toEqual({ failures: 2, successes: 1 })
  })

  it('starts a new chat: a divider in the history, nothing older in the prompt, a new model session, no duplicate divider', async () => {
    const mine = await tenant('Mine')
    const keys: string[] = []
    const chat = createChatService(sql, async ({ prompt, sessionKey }) => (prompts.push(prompt), keys.push(sessionKey), { text: 'Jawaban.' }))
    expect(await chat.startNew(mine.id, 'aksis')).toBeNull()

    await chat.ask(mine.id, 'aksis', 'Pertanyaan sebelum chat baru')
    const divider = await chat.startNew(mine.id, 'aksis')
    expect(divider).toMatchObject({ role: 'divider', text: 'Chat baru' })
    expect(await chat.startNew(mine.id, 'aksis')).toBeNull()

    await chat.ask(mine.id, 'aksis', 'Pertanyaan sesudah chat baru')
    expect(prompts.at(-1)).not.toContain('Pertanyaan sebelum chat baru')
    expect(keys[0]).toBe(`tenant:${mine.id}:chat:aksis`)
    expect(keys[1]).toBe(`tenant:${mine.id}:chat:aksis:1`)

    const roles = (await chat.history(mine.id, 'aksis')).map((message) => message.role)
    expect(roles).toEqual(['user', 'agent', 'divider', 'user', 'agent'])
    const latest = await chat.latest(mine.id)
    expect(latest.map((message) => message.role)).toEqual(['agent'])
  })
})
