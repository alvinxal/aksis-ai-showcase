// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { completeAnalysisRun, routingProjects } from './analysis.js'
import { CONTACT_LIMIT, learnContacts, listContacts, setContact, touchContact } from './contacts.js'
import { createDatabase, saveWhatsAppMessage, type Database } from './db.js'
import { getProject, listProjects } from './projects.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('personal chats of selected contacts', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) {
      // Messages that a run has read cannot be deleted with the tenant until the run's links are gone.
      await sql`delete from project_events where tenant_id in ${sql(tenants)}`
      await sql`delete from analysis_run_messages where analysis_run_id in (select id from analysis_runs where tenant_id in ${sql(tenants)})`
      await sql`delete from tenants where id in ${sql(tenants)}`
    }
    tenants.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  // Usage-paused, so the shared analysis queue (claimed by other test files at the same time) never takes these messages.
  const tenant = async () => {
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name, usage_paused) values (${`T ${randomUUID()}`}, true) returning id`
    tenants.push(row!.id)
    return row!.id
  }
  const phoneJid = () => `62${Math.floor(1e9 + Math.random() * 8e9)}@s.whatsapp.net`
  const project = async (tenantId: string, name = `P ${randomUUID().slice(0, 8)}`) => {
    const [row] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, ${name}) returning id`
    return row!.id
  }
  const message = async (tenantId: string, projectId: string | null, jid: string, text: string, fromMe = false) =>
    saveWhatsAppMessage(sql, {
      tenantId, projectId, whatsappMessageId: randomUUID(), chatJid: jid, senderJid: null, fromMe, isSelfChat: false,
      isAgentGenerated: false, sentAt: new Date(), messageType: 'conversation', textContent: text, rawPayload: {},
    })
  const contactId = async (tenantId: string, jid: string) =>
    (await sql<Array<{ id: string }>>`select id from whatsapp_contacts where tenant_id = ${tenantId} and jid = ${jid}`)[0]!.id

  it('only notes who wrote until the contact is selected, then returns its project', async () => {
    const tenantId = await tenant()
    const jid = phoneJid()
    expect(await touchContact(sql, tenantId, jid, null, 'Pak Budi')).toBeNull()
    const overview = await listContacts(sql, tenantId)
    expect(overview.contacts).toMatchObject([{ label: 'Pak Budi', selected: false, projectId: null }])
    const projectId = await project(tenantId)
    expect(await setContact(sql, tenantId, overview.contacts[0]!.id, { selected: true, projectId })).toEqual({ ok: true })
    expect(await touchContact(sql, tenantId, jid, null, null)).toBe(projectId)
  })

  it('knows a person by either address, and learns the name and the other address later', async () => {
    const tenantId = await tenant()
    const phone = phoneJid()
    const lid = `${Math.floor(1e14 + Math.random() * 8e14)}@lid`
    await touchContact(sql, tenantId, lid, null, null)
    const projectId = await project(tenantId)
    await setContact(sql, tenantId, await contactId(tenantId, lid), { selected: true, projectId })
    // Same person now arrives with the phone number as the main address and the lid as the alternative.
    expect(await touchContact(sql, tenantId, phone, lid, 'Bu Sari')).toBe(projectId)
    const [row] = await sql<Array<{ n: number; name: string | null; alt: string | null }>>`
      select count(*) over ()::int as n, display_name as name, alt_jid as alt from whatsapp_contacts where tenant_id = ${tenantId}
    `
    expect(row).toEqual({ n: 1, name: 'Bu Sari', alt: phone })
    expect(await touchContact(sql, tenantId, lid, null, null)).toBe(projectId)
  })

  it('needs a project of the same customer, or makes one named after the contact', async () => {
    const mine = await tenant()
    const other = await tenant()
    const jid = phoneJid()
    await touchContact(sql, mine, jid, null, 'Mas Joko')
    const id = await contactId(mine, jid)
    const foreign = await project(other)
    expect(await setContact(sql, mine, id, { selected: true, projectId: foreign })).toEqual({ ok: false, reason: 'project' })
    expect(await setContact(sql, other, id, { selected: true, projectId: foreign })).toEqual({ ok: false, reason: 'not_found' })
    expect(await setContact(sql, mine, 'not-a-uuid', { selected: false })).toEqual({ ok: false, reason: 'not_found' })
    expect(await setContact(sql, mine, id, { selected: true, projectId: 'new' })).toEqual({ ok: true })
    const [made] = await sql<Array<{ name: string }>>`select p.name from projects p join whatsapp_contacts c on c.project_id = p.id where c.id = ${id}`
    expect(made?.name).toBe('Mas Joko')
  })

  it('is read without a project: messages wait under the default project, held history is taken in, other history is purged', async () => {
    const tenantId = await tenant()
    const chosen = phoneJid()
    const stranger = phoneJid()
    await touchContact(sql, tenantId, chosen, null, 'Bu Sari')
    await touchContact(sql, tenantId, stranger, null, 'Orang Asing')
    // History from pairing is held without a project.
    await message(tenantId, null, chosen, 'Gambar revisi sudah saya kirim')
    await message(tenantId, null, stranger, 'Halo apa kabar')
    expect(await setContact(sql, tenantId, await contactId(tenantId, chosen), { selected: true })).toEqual({ ok: true })
    const [umum] = await sql<Array<{ id: string }>>`select id from projects where tenant_id = ${tenantId} and name = 'Umum'`
    expect(await touchContact(sql, tenantId, chosen, null, null)).toBe(umum!.id)
    const held = await sql<Array<{ chat_jid: string; project_id: string | null }>>`select chat_jid, project_id from whatsapp_messages where tenant_id = ${tenantId} order by chat_jid`
    expect(held.find((row) => row.chat_jid === chosen)?.project_id).toBe(umum!.id)
    expect(held.find((row) => row.chat_jid === stranger)?.project_id).toBeNull()
    expect((await listContacts(sql, tenantId)).contacts.find((item) => item.label === 'Bu Sari')).toMatchObject({ selected: true, projectId: null })
    // Nobody claims the stranger's history, so the sweep removes it after a day.
    await sql`update whatsapp_messages set received_at = now() - interval '25 hours' where tenant_id = ${tenantId}`
    const { purgeStaleHistory } = await import('./groups.js')
    await purgeStaleHistory(sql)
    const left = await sql<Array<{ chat_jid: string }>>`select chat_jid from whatsapp_messages where tenant_id = ${tenantId}`
    expect(left.map((row) => row.chat_jid)).toEqual([chosen])
  })

  it('routes the events of a contact without a project to the project the AI names, and keeps the rest under the default', async () => {
    const tenantId = await tenant()
    const rumah = await project(tenantId, 'Rumah Budi')
    const villa = await project(tenantId, 'Villa Sanur')
    await project(tenantId, 'Tanpa grup')
    for (const [id, subject] of [[rumah, 'Rumah Budi - Tim'], [villa, 'Villa Sanur - Tim']] as const) {
      await sql`insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id) values (${tenantId}, ${`${randomUUID()}@g.us`}, ${subject}, true, ${id})`
    }
    const jid = phoneJid()
    await touchContact(sql, tenantId, jid, null, 'Pak Andi')
    await setContact(sql, tenantId, await contactId(tenantId, jid), { selected: true })
    await message(tenantId, await touchContact(sql, tenantId, jid, null, null), jid, 'Plafon Villa Sanur jadi gypsum ya')
    await message(tenantId, await touchContact(sql, tenantId, jid, null, null), jid, 'Soal yang tadi kita bahas ya')
    const [umum] = await sql<Array<{ id: string }>>`select id from projects where tenant_id = ${tenantId} and name = 'Umum'`
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model, source_kind) values (${tenantId}, ${umum!.id}, 'running', 'test', 'contact') returning id`
    const messages = await sql<Array<{ id: string }>>`select id from whatsapp_messages where tenant_id = ${tenantId} order by received_at, text_content desc`
    for (const row of messages) await sql`insert into analysis_run_messages (analysis_run_id, message_id) values (${run!.id}, ${row.id})`

    // Only watched projects are offered to the AI, with their group names.
    const offered = await routingProjects(sql, { kind: 'contact', tenantId, projectId: umum!.id })
    expect(offered?.map((item) => item.name)).toEqual(['Rumah Budi', 'Villa Sanur'])
    expect(offered?.[1]?.groups).toEqual(['Villa Sanur - Tim'])
    expect(await routingProjects(sql, { kind: 'group', tenantId, projectId: umum!.id })).toBeNull()
    expect(await routingProjects(sql, { kind: 'contact', tenantId, projectId: villa })).toBeNull()

    const event = (title: string, projectId: string | null, source: string) => ({
      eventType: 'DECISION_DETECTED', title, details: {}, confidence: 0.9, occurredAt: new Date().toISOString(), dueAt: null, sourceMessageIds: [source], projectId,
    })
    await completeAnalysisRun(sql, run!.id, {
      reply: null,
      events: [
        event('Plafon Villa Sanur gypsum', villa, messages[0]!.id),
        event('Topik yang tidak jelas', null, messages[1]!.id),
        // An id that is not a project of this customer is never trusted.
        event('Id asing', randomUUID(), messages[1]!.id),
      ],
    })
    const stored = await sql<Array<{ title: string; project_id: string }>>`select title, project_id from project_events where tenant_id = ${tenantId} order by title`
    expect(stored).toEqual([
      { title: 'Id asing', project_id: umum!.id },
      { title: 'Plafon Villa Sanur gypsum', project_id: villa },
      { title: 'Topik yang tidak jelas', project_id: umum!.id },
    ])
  })

  it('ignores a project named by the AI for a contact that has a fixed project', async () => {
    const tenantId = await tenant()
    const fixed = await project(tenantId)
    const elsewhere = await project(tenantId)
    const jid = phoneJid()
    await touchContact(sql, tenantId, jid, null, 'Pak Budi')
    await setContact(sql, tenantId, await contactId(tenantId, jid), { selected: true, projectId: fixed })
    await message(tenantId, fixed, jid, 'Termin 2 besok')
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model, source_kind) values (${tenantId}, ${fixed}, 'running', 'test', 'contact') returning id`
    const [stored] = await sql<Array<{ id: string }>>`select id from whatsapp_messages where tenant_id = ${tenantId}`
    await sql`insert into analysis_run_messages (analysis_run_id, message_id) values (${run!.id}, ${stored!.id})`
    await completeAnalysisRun(sql, run!.id, {
      reply: null,
      events: [{ eventType: 'PAYMENT_DUE', title: 'Termin 2', details: {}, confidence: 0.9, occurredAt: new Date().toISOString(), dueAt: null, sourceMessageIds: [stored!.id], projectId: elsewhere }],
    })
    const [event] = await sql<Array<{ project_id: string }>>`select project_id from project_events where tenant_id = ${tenantId}`
    expect(event?.project_id).toBe(fixed)
  })

  it('stops at the contact limit, and lets a selected contact be changed at the limit', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId)
    const jids = Array.from({ length: CONTACT_LIMIT + 1 }, phoneJid)
    for (const jid of jids) await touchContact(sql, tenantId, jid, null, 'Kontak')
    for (const jid of jids.slice(0, CONTACT_LIMIT)) {
      expect(await setContact(sql, tenantId, await contactId(tenantId, jid), { selected: true, projectId })).toEqual({ ok: true })
    }
    const extra = await contactId(tenantId, jids[CONTACT_LIMIT]!)
    expect(await setContact(sql, tenantId, extra, { selected: true, projectId })).toEqual({ ok: false, reason: 'limit' })
    const again = await contactId(tenantId, jids[0]!)
    expect(await setContact(sql, tenantId, again, { selected: true, projectId })).toEqual({ ok: true })
    await setContact(sql, tenantId, again, { selected: false })
    expect(await setContact(sql, tenantId, extra, { selected: true, projectId })).toEqual({ ok: true })
  })

  it('deleting a contact from the selection removes what was not read yet and keeps what was', async () => {
    const tenantId = await tenant()
    const projectId = await project(tenantId)
    const jid = phoneJid()
    await touchContact(sql, tenantId, jid, null, 'Pak Budi')
    const id = await contactId(tenantId, jid)
    await setContact(sql, tenantId, id, { selected: true, projectId })
    await message(tenantId, projectId, jid, 'Termin 2 saya transfer besok')
    // Mark the first message as read by an analysis run (the shared queue is not claimed in tests: others use it).
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${projectId}, 'completed', 'test') returning id`
    await sql`insert into analysis_run_messages (analysis_run_id, message_id) select ${run!.id}, id from whatsapp_messages where tenant_id = ${tenantId}`
    await message(tenantId, projectId, jid, 'Pesan yang belum dibaca')
    await setContact(sql, tenantId, id, { selected: false })
    const left = await sql<Array<{ text_content: string }>>`select text_content from whatsapp_messages where tenant_id = ${tenantId} and chat_jid = ${jid}`
    expect(left.map((row) => row.text_content)).toEqual(['Termin 2 saya transfer besok'])
    expect(await touchContact(sql, tenantId, jid, null, null)).toBeNull()
  })

  it('shows a project made for a contact, with the contact name and nothing from other customers', async () => {
    const mine = await tenant()
    const other = await tenant()
    const jid = phoneJid()
    await touchContact(sql, mine, jid, null, 'Pak Budi')
    await setContact(sql, mine, await contactId(mine, jid), { selected: true, projectId: 'new' })
    const list = await listProjects(sql, mine)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'Pak Budi', groups: [], contacts: ['Pak Budi'] })
    expect((await getProject(sql, mine, list[0]!.id))?.contacts).toEqual(['Pak Budi'])
    expect(await listProjects(sql, other)).toEqual([])
    expect((await listContacts(sql, other)).contacts).toEqual([])
  })

  it('forgets contacts that never wrote for three months and were not selected', async () => {
    const tenantId = await tenant()
    const jid = phoneJid()
    await touchContact(sql, tenantId, jid, null, 'Lama')
    await sql`update whatsapp_contacts set last_seen_at = now() - interval '100 days' where tenant_id = ${tenantId}`
    expect((await listContacts(sql, tenantId)).contacts).toEqual([])
  })

  it('offers people from the contact list before they write, without touching the choice, and can search them', async () => {
    const tenantId = await tenant()
    const jid = phoneJid()
    const lid = `${Math.floor(1e12 + Math.random() * 8e12)}@lid`
    const wrote = phoneJid()
    await touchContact(sql, tenantId, wrote, null, 'Penulis Aktif')
    const written = (await listContacts(sql, tenantId)).contacts.find((item) => item.label === 'Penulis Aktif')!
    await setContact(sql, tenantId, written.id, { selected: true })

    expect(await learnContacts(sql, tenantId, [
      { jid, altJid: lid, name: 'Bu Sari Tukang', saved: true },
      { jid: `${Math.floor(1e11)}-1@g.us`, altJid: null, name: 'Grup', saved: true },
      { jid: wrote, altJid: null, name: 'Nama Lain', saved: true },
    ])).toBe(1)
    // The same person arriving under the other address is the same contact, and a saved name wins over a chosen one.
    expect(await learnContacts(sql, tenantId, [{ jid: lid, altJid: jid, name: 'Sari (disimpan)', saved: true }])).toBe(0)
    expect(await learnContacts(sql, tenantId, [{ jid, altJid: null, name: 'sari sendiri', saved: false }])).toBe(0)

    const all = await listContacts(sql, tenantId)
    expect(all.contacts.map((item) => [item.label, item.selected, item.lastMessageAt !== null])).toEqual([
      ['Nama Lain', true, true],
      ['Sari (disimpan)', false, false],
    ])
    expect(all.selectedCount).toBe(1)
    expect((await listContacts(sql, tenantId, 'sari')).contacts.map((item) => item.label)).toEqual(['Nama Lain', 'Sari (disimpan)'])
    expect((await listContacts(sql, tenantId, 'zzz')).contacts.map((item) => item.label)).toEqual(['Nama Lain'])
    expect((await listContacts(sql, tenantId, '%')).contacts).toHaveLength(2)
    // Choosing one that was only known from the list works like any other.
    const sari = all.contacts.find((item) => item.label === 'Sari (disimpan)')!
    expect(await setContact(sql, tenantId, sari.id, { selected: true })).toEqual({ ok: true })
  })
})
