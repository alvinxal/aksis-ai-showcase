// Runs only against a real database, e.g. the throwaway one:
//   scripts/dev-db.sh up
//   AKSIS_TEST_DATABASE_URL=postgres://aksis_ai:dev@127.0.0.1:15432/aksis_ai npx vitest run src/analysis.integration.test.ts
// The fake-database tests cannot prove SQL, and the AI gate is SQL.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { claimAnalysisBatch, completeAnalysisRun, tenantMayUseAi, type CompletedEvent } from './analysis.js'
import { createDatabase, type Database } from './db.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('analysis against a real database', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  // analysis_run_messages points at messages without a cascade, so runs go first.
  async function cleanup() {
    if (!tenants.length) return
    await sql`delete from analysis_runs where tenant_id in ${sql(tenants)}`
    await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
  }
  afterEach(cleanup)
  afterAll(async () => {
    await sql.end()
  })

  type SeedOptions = {
    status?: string
    paused?: boolean
    /** Days from now until the subscription ends; negative = already ended; null = no subscription. */
    endsInDays?: number | null
    agentGenerated?: boolean
  }

  async function seed(options: SeedOptions = {}) {
    const [tenant] = await sql<Array<{ id: string }>>`
      insert into tenants (name, status, usage_paused)
      values (${`Test ${randomUUID()}`}, ${options.status ?? 'active'}, ${options.paused ?? false})
      returning id
    `
    const tenantId = tenant!.id
    tenants.push(tenantId)
    const endsInDays = options.endsInDays === undefined ? 30 : options.endsInDays
    if (endsInDays !== null) {
      await sql`
        insert into subscriptions (tenant_id, plan_code, ends_at)
        values (${tenantId}, 'basic', now() + ${endsInDays} * interval '1 day')
      `
    }
    const [project] = await sql<Array<{ id: string }>>`
      insert into projects (tenant_id, name) values (${tenantId}, 'Rumah Cempaka') returning id
    `
    const projectId = project!.id
    const [message] = await sql<Array<{ id: string }>>`
      insert into whatsapp_messages (
        tenant_id, project_id, whatsapp_message_id, chat_jid, from_me, sent_at,
        message_type, text_content, raw_payload, is_agent_generated
      ) values (
        ${tenantId}, ${projectId}, ${randomUUID()}, '120363000000000000@g.us', false, now(),
        'conversation', 'Termin kedua jatuh tempo Jumat.', '{}'::jsonb, ${options.agentGenerated ?? false}
      ) returning id
    `
    return { tenantId, projectId, messageId: message!.id }
  }

  describe('the AI gate in claimAnalysisBatch', () => {
    it('claims messages of an active tenant with a running subscription', async () => {
      const { tenantId, messageId } = await seed()
      const batch = await claimAnalysisBatch(sql, 'test-model')
      expect(batch?.tenantId).toBe(tenantId)
      expect(batch?.messages.map((message) => message.id)).toEqual([messageId])
    })

    it('does not claim the same message twice', async () => {
      await seed()
      expect(await claimAnalysisBatch(sql, 'test-model')).not.toBeNull()
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
    })

    it('stays off without a subscription', async () => {
      await seed({ endsInDays: null })
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
    })

    it('keeps working during the 3-day grace period and stops after it', async () => {
      await seed({ endsInDays: -2 })
      expect(await claimAnalysisBatch(sql, 'test-model')).not.toBeNull()
      await cleanup()
      await seed({ endsInDays: -5 })
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
    })

    it('stays off for a paused or disabled tenant', async () => {
      await seed({ paused: true })
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
      await cleanup()
      await seed({ status: 'disabled' })
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
    })

    it('never analyses messages written by the agent itself', async () => {
      await seed({ agentGenerated: true })
      expect(await claimAnalysisBatch(sql, 'test-model')).toBeNull()
    })
  })

  describe('tenantMayUseAi (the same gate, for answers)', () => {
    it('agrees with the extraction gate', async () => {
      const ok = await seed()
      expect(await tenantMayUseAi(sql, ok.tenantId)).toBe(true)
      const paused = await seed({ paused: true })
      expect(await tenantMayUseAi(sql, paused.tenantId)).toBe(false)
      const none = await seed({ endsInDays: null })
      expect(await tenantMayUseAi(sql, none.tenantId)).toBe(false)
      const grace = await seed({ endsInDays: -2 })
      expect(await tenantMayUseAi(sql, grace.tenantId)).toBe(true)
      const over = await seed({ endsInDays: -5 })
      expect(await tenantMayUseAi(sql, over.tenantId)).toBe(false)
    })
  })

  describe('events from a completed analysis run', () => {
    const payment = (messageId: string, overrides: Partial<CompletedEvent> = {}): CompletedEvent => ({
      eventType: 'PAYMENT_DUE',
      title: 'Termin kedua Rumah Cempaka',
      details: { amount: 30000000, party: 'Pak Budi', note: 'Jatuh tempo Jumat.' },
      confidence: 0.9,
      occurredAt: '2026-10-28T08:00:00Z',
      dueAt: '2026-10-30T00:00:00Z',
      sourceMessageIds: [messageId],
      ...overrides,
    })

    async function runWith(events: (messageId: string) => CompletedEvent[]) {
      const batch = await claimAnalysisBatch(sql, 'test-model')
      expect(batch).not.toBeNull()
      const messageId = batch!.messages[0]!.id
      await completeAnalysisRun(sql, batch!.runId, { reply: null, events: events(messageId) })
      return batch!
    }

    async function addMessage(tenantId: string, projectId: string, text: string) {
      await sql`
        insert into whatsapp_messages (
          tenant_id, project_id, whatsapp_message_id, chat_jid, from_me, sent_at,
          message_type, text_content, raw_payload
        ) values (
          ${tenantId}, ${projectId}, ${randomUUID()}, '120363000000000000@g.us', false, now(),
          'conversation', ${text}, '{}'::jsonb
        )
      `
    }

    it('stores a finance event with its due date, dedup key and exact amount', async () => {
      const { tenantId } = await seed()
      await runWith((id) => [payment(id)])
      const rows = await sql<Array<{ event_type: string; due_at: Date; dedup_key: string; amount: number }>>`
        select event_type, due_at, dedup_key, (details->>'amount')::numeric as amount
        from project_events where tenant_id = ${tenantId}
      `
      expect(rows).toHaveLength(1)
      expect(rows[0]!.event_type).toBe('PAYMENT_DUE')
      expect(rows[0]!.due_at.toISOString()).toBe('2026-10-30T00:00:00.000Z')
      expect(rows[0]!.dedup_key).toHaveLength(32)
      expect(Number(rows[0]!.amount)).toBe(30000000)
    })

    it('stores the same event once and keeps every source message', async () => {
      const { tenantId, projectId } = await seed()
      await runWith((id) => [payment(id)])
      await addMessage(tenantId, projectId, 'Pak Budi: termin kedua ya, Jumat.')
      await runWith((id) => [payment(id, { title: 'termin KEDUA rumah cempaka!', dueAt: '2026-10-30T17:00:00Z' })])
      const [events] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from project_events where tenant_id = ${tenantId}
      `
      const [sources] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from project_event_sources s
        join project_events e on e.id = s.event_id where e.tenant_id = ${tenantId}
      `
      expect(events!.count).toBe(1)
      expect(sources!.count).toBe(2)
    })

    it('keeps a moved deadline as a separate event', async () => {
      const { tenantId } = await seed()
      await runWith((id) => [
        payment(id, { eventType: 'DEADLINE_DETECTED', title: 'Gambar kerja tahap 2' }),
        payment(id, { eventType: 'DEADLINE_DETECTED', title: 'Gambar kerja tahap 2', dueAt: '2026-11-05T00:00:00Z' }),
      ])
      const [row] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from project_events where tenant_id = ${tenantId}
      `
      expect(row!.count).toBe(2)
    })

    it('stores an event without a due date', async () => {
      const { tenantId } = await seed()
      await runWith((id) => [payment(id, { eventType: 'DECISION_DETECTED', title: 'Material lantai disetujui', dueAt: null, details: {} })])
      const [row] = await sql<Array<{ due_at: Date | null }>>`select due_at from project_events where tenant_id = ${tenantId}`
      expect(row!.due_at).toBeNull()
    })

    it('still rejects an event whose source is not part of the run', async () => {
      await seed()
      const batch = await claimAnalysisBatch(sql, 'test-model')
      await expect(
        completeAnalysisRun(sql, batch!.runId, { reply: null, events: [payment(randomUUID())] }),
      ).rejects.toThrow('invalid source message')
    })
  })
})
