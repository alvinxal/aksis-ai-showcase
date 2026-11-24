// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deleteTenantData } from './admin.js'
import { createDatabase, saveWhatsAppMessage, type Database } from './db.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('deleting a customer', () => {
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

  /** Every table that has a tenant_id column: whatever a customer owns must be listed here automatically. */
  const tenantTables = async () =>
    (
      await sql<Array<{ table_name: string }>>`
        select c.table_name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
        order by c.table_name
      `
    ).map((row) => row.table_name)

  /**
   * Fills every kind of data a customer can have, and returns the ids needed to look for it again. The customer is
   * usage-paused: the shared analysis queue (claimed by other test files at the same time) must never take these messages.
   */
  const populate = async () => {
    const [tenant] = await sql<Array<{ id: string }>>`insert into tenants (name, status, usage_paused) values (${`T ${randomUUID()}`}, 'active', true) returning id`
    const tenantId = tenant!.id
    tenants.push(tenantId)
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, 'Rumah Budi') returning id`
    const projectId = project!.id
    const jid = `${randomUUID()}@g.us`
    const contactJid = `62${Math.floor(1e9 + Math.random() * 8e9)}@s.whatsapp.net`
    await sql`insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id) values (${tenantId}, ${jid}, 'Rumah Budi', true, ${projectId})`
    await sql`insert into whatsapp_contacts (tenant_id, jid, display_name, selected, project_id) values (${tenantId}, ${contactJid}, 'Pak Budi', true, ${projectId})`
    await sql`insert into subscriptions (tenant_id, plan_code, started_at, ends_at) values (${tenantId}, (select code from plans limit 1), now(), now() + interval '10 days')`
    await saveWhatsAppMessage(sql, {
      tenantId, projectId, whatsappMessageId: randomUUID(), chatJid: jid, senderJid: null, fromMe: false, isSelfChat: false,
      isAgentGenerated: false, sentAt: new Date(), messageType: 'conversation', textContent: 'Termin 2 saya transfer Jumat', rawPayload: {},
    })
    await saveWhatsAppMessage(sql, {
      tenantId, projectId, whatsappMessageId: randomUUID(), chatJid: contactJid, senderJid: null, fromMe: false, isSelfChat: false,
      isAgentGenerated: false, sentAt: new Date(), messageType: 'conversation', textContent: 'Pesan pribadi dari klien', rawPayload: {},
    })
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model, source_kind) values (${tenantId}, ${projectId}, 'completed', 'test', 'group') returning id`
    await sql`insert into analysis_run_messages (analysis_run_id, message_id) select ${run!.id}, id from whatsapp_messages where tenant_id = ${tenantId} and chat_jid = ${jid}`
    const [event] = await sql<Array<{ id: string }>>`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at)
      values (${tenantId}, ${projectId}, ${run!.id}, 'PAYMENT_DUE', 'Termin 2', ${sql.json({ amount: 30000000 })}, 0.9, now()) returning id
    `
    await sql`insert into project_event_sources (event_id, message_id) select ${event!.id}, id from whatsapp_messages where tenant_id = ${tenantId} and chat_jid = ${jid}`
    const [chatRun] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model, source_kind) values (${tenantId}, ${projectId}, 'completed', 'test', 'app_chat') returning id`
    await sql`insert into chat_messages (tenant_id, agent, role, text, project_id, run_id) values (${tenantId}, 'aksis', 'user', 'Apa yang jatuh tempo?', ${projectId}, ${chatRun!.id})`
    await sql`insert into project_summaries (project_id, tenant_id, text, generated_at, run_id) values (${projectId}, ${tenantId}, 'Ringkasan', now(), ${chatRun!.id})`
    await sql`insert into push_subscriptions (tenant_id, endpoint, p256dh, auth) values (${tenantId}, ${`https://fcm.googleapis.com/fcm/send/${randomUUID()}`}, ${randomBytes(65).toString('base64url')}, ${randomBytes(16).toString('base64url')})`
    await sql`insert into push_sent (tenant_id, day, kind) values (${tenantId}, current_date, 'digest')`
    await sql`insert into login_codes (tenant_id, code_hash, expires_at) values (${tenantId}, 'x', now() + interval '5 minutes')`
    await sql`insert into web_sessions (tenant_id, token_hash, expires_at, kind) values (${tenantId}, ${randomUUID()}, now() + interval '1 day', 'app')`
    await sql`insert into invitations (tenant_id, token_hash, created_by_telegram_id, expires_at) values (${tenantId}, ${randomUUID()}, 1, now() + interval '1 day')`
    await sql`insert into outbound_messages (tenant_id, analysis_run_id, channel, text_content) values (${tenantId}, ${run!.id}, 'whatsapp_self_chat', 'balasan')`
    return { tenantId, projectId }
  }

  const rowsOf = async (table: string, tenantId: string) =>
    (await sql<Array<{ n: number }>>`select count(*)::int as n from ${sql(table)} where tenant_id = ${tenantId}`)[0]!.n

  it('leaves nothing behind in any table that belongs to a customer, and does not touch another customer', async () => {
    const gone = await populate()
    const kept = await populate()
    const tables = await tenantTables()
    // The two customers really have data in the tables this test knows about, so an empty result means something.
    for (const table of ['whatsapp_messages', 'whatsapp_contacts', 'chat_messages', 'project_summaries', 'push_subscriptions', 'push_sent', 'login_codes', 'web_sessions', 'invitations', 'project_events', 'analysis_runs', 'projects']) {
      expect(await rowsOf(table, gone.tenantId), table).toBeGreaterThan(0)
    }
    const result = await deleteTenantData(sql, gone.tenantId)
    expect(result?.messages).toBe(2)
    for (const table of tables) expect(await rowsOf(table, gone.tenantId), `${table} still has data of the deleted customer`).toBe(0)
    // The audit row of the deletion stays, but no longer points at the customer.
    expect((await sql`select 1 from admin_audit where detail->>'phone' is not null`).length).toBe(0)
    expect((await sql`select 1 from tenants where id = ${gone.tenantId}`).length).toBe(0)
    expect((await sql`select 1 from project_event_sources where event_id in (select id from project_events where tenant_id = ${gone.tenantId})`).length).toBe(0)
    for (const table of ['whatsapp_messages', 'whatsapp_contacts', 'chat_messages', 'project_summaries', 'push_subscriptions', 'project_events', 'projects']) {
      expect(await rowsOf(table, kept.tenantId), `${table} of the other customer`).toBeGreaterThan(0)
    }
  })

  it('knows about every table of a customer: each one is removed with the customer or listed on purpose', async () => {
    const cascading = await sql<Array<{ table_name: string }>>`
      select c.conrelid::regclass::text as table_name
      from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'tenants'::regclass and c.confdeltype = 'c'
    `
    const covered = new Set(cascading.map((row) => row.table_name))
    // Tables that are cleared by hand in deleteTenantData because other rows restrict deleting them.
    const byHand = new Set(['whatsapp_messages', 'analysis_runs', 'project_events', 'outbound_messages'])
    // Kept on purpose: the record of what an admin did (including that this deletion happened). Its tenant_id becomes
    // null and it holds ids, counts and the customer's name only, never message text, group names or phone numbers.
    const keptOnPurpose = new Set(['admin_audit'])
    const missing = (await tenantTables()).filter((table) => !covered.has(table) && !byHand.has(table) && !keptOnPurpose.has(table))
    expect(missing, `tables with tenant_id that are neither cascaded nor cleared by deleteTenantData`).toEqual([])
  })

  it('deleting a customer that does not exist is harmless', async () => {
    expect(await deleteTenantData(sql, randomUUID())).toBeNull()
  })
})
