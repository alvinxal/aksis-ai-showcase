// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { failAnalysisRun } from './analysis.js'
import { GRACE_DAYS, grantSubscription } from './billing.js'
import { createDatabase, saveWhatsAppMessage, type Database } from './db.js'
import { saveSelectedGroups } from './groups.js'
import {
  discardChatMessages,
  EXPIRED_KEEP_DAYS,
  purgeOldData,
  RetentionSweep,
  tenantsToDelete,
  tenantsToWarn,
} from './retention.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const DAY = 86_400_000

describe.skipIf(!url)('retention', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) {
      await sql`delete from analysis_run_messages where analysis_run_id in (select id from analysis_runs where tenant_id in ${sql(tenants)})`
      await sql`delete from project_event_sources where event_id in (select id from project_events where tenant_id in ${sql(tenants)})`
      await sql`delete from tenants where id in ${sql(tenants)}`
    }
    tenants.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  /** A usage-paused customer, so the shared analysis queue never takes these messages. */
  const newTenant = async (endsInDays: number | null = 10) => {
    const [tenant] = await sql<Array<{ id: string }>>`insert into tenants (name, status, usage_paused) values (${`T ${randomUUID()}`}, 'active', true) returning id`
    const tenantId = tenant!.id
    tenants.push(tenantId)
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, 'Rumah Budi') returning id`
    if (endsInDays !== null) {
      await sql`
        insert into subscriptions (tenant_id, plan_code, started_at, ends_at)
        values (${tenantId}, 'basic', now() - interval '400 days', now() + make_interval(days => ${endsInDays}))
      `
    }
    return { tenantId, projectId: project!.id }
  }

  const message = async (tenantId: string, projectId: string, chatJid: string, daysOld: number, text: string) => {
    const id = randomUUID()
    await saveWhatsAppMessage(sql, {
      tenantId, projectId, whatsappMessageId: id, chatJid, senderJid: '628111@s.whatsapp.net', fromMe: false, isSelfChat: false,
      isAgentGenerated: false, sentAt: new Date(Date.now() - daysOld * DAY), messageType: 'conversation', textContent: text, rawPayload: { pushName: 'Budi' },
    })
    const [row] = await sql<Array<{ id: string }>>`select id from whatsapp_messages where tenant_id = ${tenantId} and whatsapp_message_id = ${id}`
    return row!.id
  }

  const cite = async (tenantId: string, projectId: string, messageId: string) => {
    const [run] = await sql<Array<{ id: string }>>`
      insert into analysis_runs (tenant_id, project_id, status, model, finished_at) values (${tenantId}, ${projectId}, 'completed', 'm', now()) returning id`
    await sql`insert into analysis_run_messages (analysis_run_id, message_id) values (${run!.id}, ${messageId})`
    const [event] = await sql<Array<{ id: string }>>`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at)
      values (${tenantId}, ${projectId}, ${run!.id}, 'DECISION_DETECTED', 'Keputusan', '{}'::jsonb, 0.9, now()) returning id`
    await sql`insert into project_event_sources (event_id, message_id) values (${event!.id}, ${messageId})`
  }

  const rowOf = async (id: string) => (await sql<Array<{ text_content: string | null; sender_jid: string | null; raw_payload: unknown }>>`
    select text_content, sender_jid, raw_payload from whatsapp_messages where id = ${id}`)[0]

  it('deletes old messages, empties the ones an event cites and leaves recent ones alone', async () => {
    const { tenantId, projectId } = await newTenant()
    const jid = `${randomUUID()}@g.us`
    const plain = await message(tenantId, projectId, jid, 120, 'pesan lama biasa')
    const cited = await message(tenantId, projectId, jid, 120, 'pesan lama yang jadi sumber')
    const recent = await message(tenantId, projectId, jid, 5, 'pesan baru')
    await cite(tenantId, projectId, cited)

    const result = await purgeOldData(sql)
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(await rowOf(plain)).toBeUndefined()
    expect(await rowOf(cited)).toEqual({ text_content: null, sender_jid: null, raw_payload: {} })
    expect((await rowOf(recent))?.text_content).toBe('pesan baru')
    const [sources] = await sql<Array<{ n: number }>>`select count(*)::int as n from project_event_sources where message_id = ${cited}`
    expect(sources?.n).toBe(1)

    const again = await purgeOldData(sql)
    expect(again.emptied).toBe(0)
  })

  it('keeps the messages of a run that is still working', async () => {
    const { tenantId, projectId } = await newTenant()
    const id = await message(tenantId, projectId, `${randomUUID()}@g.us`, 120, 'sedang dibaca AI')
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'running', 'm') returning id`
    await sql`insert into analysis_run_messages (analysis_run_id, message_id) values (${run!.id}, ${id})`
    await purgeOldData(sql)
    expect((await rowOf(id))?.text_content).toBe('sedang dibaca AI')
  })

  it('discards what was stored from a group that is no longer watched', async () => {
    const { tenantId, projectId } = await newTenant()
    const kept = `${randomUUID()}@g.us`
    const dropped = `${randomUUID()}@g.us`
    for (const jid of [kept, dropped]) {
      await sql`insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id) values (${tenantId}, ${jid}, ${`G ${jid}`}, true, ${projectId})`
    }
    const keptMessage = await message(tenantId, projectId, kept, 1, 'tetap')
    const droppedMessage = await message(tenantId, projectId, dropped, 1, 'dilepas')
    const live = [kept, dropped].map((jid) => ({ jid, subject: `G ${jid}`, participants: 3 }))
    const saved = await saveSelectedGroups(sql, tenantId, live, [kept])
    expect(saved).toEqual({ ok: true, count: 1 })
    expect((await rowOf(keptMessage))?.text_content).toBe('tetap')
    expect(await rowOf(droppedMessage)).toBeUndefined()
    expect(await discardChatMessages(sql, tenantId, [])).toEqual({ deleted: 0, emptied: 0 })
  })

  it('finds customers whose subscription ended long ago, warns once and deletes them only when enabled', async () => {
    const waiting = await newTenant(-(GRACE_DAYS + EXPIRED_KEEP_DAYS - 3))
    const gone = await newTenant(-(GRACE_DAYS + EXPIRED_KEEP_DAYS + 1))
    const active = await newTenant(10)
    const trial = await newTenant(null)
    const now = new Date()
    const mine = (list: Array<{ id: string }>) => list.map((tenant) => tenant.id).filter((id) => tenants.includes(id))

    expect(mine(await tenantsToDelete(sql, now))).toEqual([gone.tenantId])
    expect(mine(await tenantsToWarn(sql, now))).toEqual([waiting.tenantId])
    expect(mine(await tenantsToDelete(sql, now))).not.toContain(active.tenantId)
    expect(mine(await tenantsToDelete(sql, now))).not.toContain(trial.tenantId)

    const sent: string[] = []
    const removed: string[] = []
    const make = (autoDelete: boolean) =>
      new RetentionSweep({
        database: sql,
        removeSession: async (id) => void removed.push(id),
        notify: async (text) => void sent.push(text),
        autoDelete,
        now: () => now,
      })

    await make(false).tick()
    expect(removed).toEqual([])
    expect((await sql`select 1 from tenants where id = ${gone.tenantId}`).length).toBe(1)
    expect(sent.some((text) => text.includes('Langganan'))).toBe(true)
    expect(mine(await tenantsToWarn(sql, now))).not.toContain(waiting.tenantId)

    await make(true).tick()
    expect(removed).toContain(gone.tenantId)
    expect(removed).not.toContain(active.tenantId)
    expect((await sql`select 1 from tenants where id = ${gone.tenantId}`).length).toBe(0)
    expect((await sql`select 1 from tenants where id in ${sql([active.tenantId, trial.tenantId, waiting.tenantId])}`).length).toBe(3)
    const [audit] = await sql<Array<{ detail: { tenantId: string; messages: number } }>>`
      select detail from admin_audit where action = 'tenant_auto_deleted' and detail->>'tenantId' = ${gone.tenantId}`
    expect(audit?.detail.messages).toBe(0)
  })

  it('ignores a repeated grant from the same admin but still extends for a real renewal', async () => {
    const { tenantId } = await newTenant(null)
    const first = await grantSubscription(sql, tenantId, 'basic', 1, 111)
    const repeat = await grantSubscription(sql, tenantId, 'basic', 1, 111)
    expect(repeat?.endsAt.getTime()).toBe(first?.endsAt.getTime())

    const other = await grantSubscription(sql, tenantId, 'basic', 1, 222)
    expect(other!.endsAt.getTime()).toBeGreaterThan(first!.endsAt.getTime())
  })

  it('gives the attempt back when a run fails for a reason that is not the message', async () => {
    const { tenantId, projectId } = await newTenant()
    const id = await message(tenantId, projectId, `${randomUUID()}@g.us`, 1, 'pesan baru')
    const attemptsOf = async () => (await sql<Array<{ analysis_attempts: number }>>`select analysis_attempts from whatsapp_messages where id = ${id}`)[0]!.analysis_attempts
    const claim = async () => {
      const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'running', 'm') returning id`
      await sql`insert into analysis_run_messages (analysis_run_id, message_id) values (${run!.id}, ${id})`
      await sql`update whatsapp_messages set analysis_attempts = analysis_attempts + 1 where id = ${id}`
      return run!.id
    }
    await failAnalysisRun(sql, await claim(), 'Hermes API returned 503', { refundAttempt: true })
    expect(await attemptsOf()).toBe(0)
    await failAnalysisRun(sql, await claim(), 'bad JSON from the model')
    expect(await attemptsOf()).toBe(1)
  })
})
