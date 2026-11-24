// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { recordAudit } from './admin.js'
import { createDatabase, saveWhatsAppMessage, type Database } from './db.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const backfill = readFileSync(new URL('../migrations/011_fix_jsonb_strings.sql', import.meta.url), 'utf8')

describe.skipIf(!url)('jsonb columns hold objects, not strings', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) {
      await sql`delete from analysis_runs where tenant_id in ${sql(tenants)}`
      await sql`delete from tenants where id in ${sql(tenants)}`
    }
    tenants.length = 0
    await sql`delete from admin_audit where action like 'jsonb-test%'`
  })
  afterAll(async () => {
    await sql.end()
  })

  async function tenant() {
    const [row] = await sql<Array<{ id: string }>>`
      insert into tenants (name) values (${`Test ${randomUUID()}`}) returning id
    `
    tenants.push(row!.id)
    return row!.id
  }

  it('writes message payloads and audit details as objects', async () => {
    const tenantId = await tenant()
    const whatsappMessageId = randomUUID()
    await saveWhatsAppMessage(sql, {
      tenantId, projectId: null, whatsappMessageId, chatJid: '1@g.us', senderJid: null, fromMe: false,
      isSelfChat: false, isAgentGenerated: false, sentAt: new Date(), messageType: 'conversation',
      textContent: 'halo', rawPayload: { pushName: 'Pak Budi', nested: { ok: true } },
    })
    const [message] = await sql<Array<{ type: string; sender: string | null }>>`
      select jsonb_typeof(raw_payload) as type, raw_payload->>'pushName' as sender
      from whatsapp_messages where whatsapp_message_id = ${whatsappMessageId}
    `
    expect(message).toEqual({ type: 'object', sender: 'Pak Budi' })

    await recordAudit(sql, 1, 'jsonb-test', tenantId, { count: 3 })
    const [audit] = await sql<Array<{ type: string; count: string | null }>>`
      select jsonb_typeof(detail) as type, detail->>'count' as count
      from admin_audit where action = 'jsonb-test' and tenant_id = ${tenantId}
    `
    expect(audit).toEqual({ type: 'object', count: '3' })
  })

  it('turns rows stored as strings back into objects, once, leaving old messages alone', async () => {
    const tenantId = await tenant()
    const [project] = await sql<Array<{ id: string }>>`
      insert into projects (tenant_id, name) values (${tenantId}, 'P') returning id
    `
    const [run] = await sql<Array<{ id: string }>>`
      insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${project!.id}, 'completed', 'm') returning id
    `
    const payload = JSON.stringify({ pushName: 'Pak Budi' })
    // The way the code used to write: a stringified object cast to jsonb.
    const recent = randomUUID()
    const old = randomUUID()
    for (const [id, daysAgo] of [[recent, 1], [old, 30]] as const) {
      await sql`
        insert into whatsapp_messages (tenant_id, whatsapp_message_id, chat_jid, from_me, sent_at, message_type, raw_payload)
        values (${tenantId}, ${id}, '1@g.us', false, now() - ${daysAgo} * interval '1 day', 'conversation', ${payload}::jsonb)
      `
    }
    await sql`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at)
      values (${tenantId}, ${project!.id}, ${run!.id}, 'PAYMENT_DUE', 'Termin', ${JSON.stringify({ amount: 30000000 })}::jsonb, 0.9, now())
    `
    await sql`insert into admin_audit (action, tenant_id, detail) values ('jsonb-test-old', ${tenantId}, ${JSON.stringify({ a: 1 })}::jsonb)`

    const state = async () => ({
      recent: (await sql`select jsonb_typeof(raw_payload) as t from whatsapp_messages where whatsapp_message_id = ${recent}`)[0]!.t,
      old: (await sql`select jsonb_typeof(raw_payload) as t from whatsapp_messages where whatsapp_message_id = ${old}`)[0]!.t,
      event: (await sql`select jsonb_typeof(details) as t from project_events where tenant_id = ${tenantId}`)[0]!.t,
      audit: (await sql`select jsonb_typeof(detail) as t from admin_audit where action = 'jsonb-test-old'`)[0]!.t,
    })
    expect(await state()).toEqual({ recent: 'string', old: 'string', event: 'string', audit: 'string' })

    await sql.unsafe(backfill)
    expect(await state()).toEqual({ recent: 'object', old: 'string', event: 'object', audit: 'object' })
    const [amount] = await sql<Array<{ amount: string }>>`select details->>'amount' as amount from project_events where tenant_id = ${tenantId}`
    expect(amount!.amount).toBe('30000000')

    await sql.unsafe(backfill) // idempotent
    expect(await state()).toEqual({ recent: 'object', old: 'string', event: 'object', audit: 'object' })
  })
})
