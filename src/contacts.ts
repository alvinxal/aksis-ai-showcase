import type { TransactionSql } from 'postgres'
import type { Database } from './db.js'

/** Selected personal chats per customer; groups have their own limit from the plan. */
export const CONTACT_LIMIT = 10
const LIST_LIMIT = 200
const FORGET_AFTER_DAYS = 90
const MAX_LEARNED_PER_EVENT = 3_000
const SEARCH_MAX = 60

/** A one-to-one chat: a phone-number address, or WhatsApp's newer anonymous (lid) address. */
export const isPersonalJid = (jid: string) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')

/** The tenant's default project. Messages of a contact without a fixed project wait here until the analysis routes their events. */
export const DEFAULT_PROJECT = 'Umum'

async function defaultProjectId(sql: Database | TransactionSql<Record<string, never>>, tenantId: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    insert into projects (tenant_id, name) values (${tenantId}, ${DEFAULT_PROJECT})
    on conflict (tenant_id, name) do update set name = excluded.name
    returning id
  `
  return row!.id
}

/**
 * Notes that a contact wrote or was written to, and says which project its messages are stored under, or null when
 * the contact is not selected (the message is then dropped). Only the address and the name WhatsApp shows are kept.
 * A selected contact without a fixed project is stored under the default project; the analysis then decides per event.
 * `altJid` is the other address of the same person (phone number for a lid, or the reverse) when WhatsApp gives it.
 */
export async function touchContact(
  sql: Database,
  tenantId: string,
  jid: string,
  altJid: string | null,
  name: string | null,
): Promise<string | null> {
  const addresses = altJid ? [jid, altJid] : [jid]
  const [existing] = await sql<Array<{ id: string; jid: string; selected: boolean; project_id: string | null; alt_jid: string | null; display_name: string | null; fresh: boolean }>>`
    select id, jid, selected, project_id, alt_jid, display_name, last_seen_at > now() - interval '1 minute' as fresh
    from whatsapp_contacts
    where tenant_id = ${tenantId} and (jid in ${sql(addresses)} or alt_jid in ${sql(addresses)})
    order by (jid = ${jid}) desc
    limit 1
  `
  if (!existing) {
    await sql`
      insert into whatsapp_contacts (tenant_id, jid, alt_jid, display_name, last_message_at)
      values (${tenantId}, ${jid}, ${altJid}, ${name}, now())
      on conflict (tenant_id, jid) do update set last_message_at = now()
    `
    return null
  }
  // The stored row keeps its own address; the alternative is whichever address of the person it does not have.
  const other = addresses.find((address) => address !== existing.jid) ?? null
  const learnsSomething = (other && !existing.alt_jid) || (name && !existing.display_name)
  if (!existing.fresh || learnsSomething) {
    await sql`
      update whatsapp_contacts
      set last_seen_at = now(),
          last_message_at = now(),
          alt_jid = coalesce(alt_jid, ${other}),
          display_name = coalesce(display_name, ${name})
      where id = ${existing.id}
    `
  }
  if (!existing.selected) return null
  return existing.project_id ?? (await defaultProjectId(sql, tenantId))
}

/** A person from the phone's contact list or chat list: identity only, no message. */
export type KnownContact = { jid: string; altJid: string | null; name: string | null; saved: boolean }

/**
 * Notes people WhatsApp tells us about (the phone's contact list, its chat list) so they can be offered in the
 * app before they write. Only the address and the name are kept. A name saved in the phone's list replaces a name
 * the person chose for themselves. Selected state, project and last message are never touched here.
 */
export async function learnContacts(sql: Database, tenantId: string, people: KnownContact[]): Promise<number> {
  let learned = 0
  const seen = new Set<string>()
  for (const person of people.slice(0, MAX_LEARNED_PER_EVENT)) {
    if (!isPersonalJid(person.jid) || person.jid.startsWith('0@') || seen.has(person.jid)) continue
    seen.add(person.jid)
    const name = person.name?.replace(/\s+/g, ' ').trim().slice(0, 80) || null
    const addresses = person.altJid ? [person.jid, person.altJid] : [person.jid]
    const [existing] = await sql<Array<{ id: string; jid: string; alt_jid: string | null; display_name: string | null }>>`
      select id, jid, alt_jid, display_name from whatsapp_contacts
      where tenant_id = ${tenantId} and (jid in ${sql(addresses)} or alt_jid in ${sql(addresses)})
      order by (jid = ${person.jid}) desc
      limit 1
    `
    if (!existing) {
      await sql`
        insert into whatsapp_contacts (tenant_id, jid, alt_jid, display_name)
        values (${tenantId}, ${person.jid}, ${person.altJid}, ${name})
        on conflict (tenant_id, jid) do nothing
      `
      learned += 1
      continue
    }
    const other = addresses.find((address) => address !== existing.jid) ?? null
    const newName = name && (person.saved || !existing.display_name) ? name : existing.display_name
    await sql`
      update whatsapp_contacts
      set last_seen_at = now(), alt_jid = coalesce(alt_jid, ${other}), display_name = ${newName}
      where id = ${existing.id}
    `
  }
  return learned
}

export type ContactItem = {
  id: string
  /** The name WhatsApp shows, or a masked number when there is none. */
  label: string
  selected: boolean
  projectId: string | null
  lastSeenAt: string
  /** When this person last wrote or was written to; null for people only known from the contact list. */
  lastMessageAt: string | null
}

export type ContactsOverview = {
  limit: number
  selectedCount: number
  /** Projects a contact can be fixed to; without one, the analysis decides per message. */
  projects: Array<{ id: string; name: string }>
  contacts: ContactItem[]
}

function masked(jid: string): string {
  const digits = jid.split('@')[0]?.split(':')[0] ?? ''
  return jid.endsWith('@s.whatsapp.net') && digits.length >= 8 ? `+${digits.slice(0, 2)} •••• ${digits.slice(-4)}` : 'Kontak tanpa nama'
}

export async function listContacts(sql: Database, tenantId: string, search = ''): Promise<ContactsOverview> {
  const needle = search.replace(/[%_\\]/g, '').trim().slice(0, SEARCH_MAX)
  await sql`
    delete from whatsapp_contacts
    where tenant_id = ${tenantId} and not selected and last_seen_at < now() - make_interval(days => ${FORGET_AFTER_DAYS})
  `
  const contacts = await sql<Array<{ id: string; jid: string; display_name: string | null; selected: boolean; project_id: string | null; last_seen_at: Date; last_message_at: Date | null }>>`
    select id, jid, display_name, selected, project_id, last_seen_at, last_message_at from whatsapp_contacts
    where tenant_id = ${tenantId}
      and (${needle} = '' or selected or coalesce(display_name, '') ilike ${'%' + needle + '%'})
    order by selected desc, last_message_at desc nulls last, display_name nulls last, last_seen_at desc
    limit ${LIST_LIMIT}
  `
  const projects = await sql<Array<{ id: string; name: string }>>`
    select p.id, p.name from projects p
    where p.tenant_id = ${tenantId} and p.status = 'active' and p.name <> 'Umum'
    order by p.name
  `
  const [count] = await sql<Array<{ n: number }>>`select count(*)::int as n from whatsapp_contacts where tenant_id = ${tenantId} and selected`
  return {
    limit: CONTACT_LIMIT,
    selectedCount: count?.n ?? 0,
    projects,
    contacts: contacts.map((row) => ({
      id: row.id,
      label: row.display_name ?? masked(row.jid),
      selected: row.selected,
      projectId: row.project_id,
      lastSeenAt: row.last_seen_at.toISOString(),
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
    })),
  }
}

export type SetContactResult = { ok: true } | { ok: false; reason: 'not_found' | 'limit' | 'project' }

/**
 * Chooses or drops a contact. A project is optional: a project of the same customer fixes every message to it,
 * 'new' makes one named after the contact, and none lets the analysis route each event to the right project.
 * Choosing also takes in the history held since pairing. Dropping deletes what was stored from that contact and
 * not yet read by the analysis.
 */
export async function setContact(
  sql: Database,
  tenantId: string,
  contactId: string,
  change: { selected: boolean; projectId?: string | null },
): Promise<SetContactResult> {
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) return { ok: false, reason: 'not_found' }
  return sql.begin(async (tx): Promise<SetContactResult> => {
    // One change at a time per customer, so two taps cannot both pass the limit.
    await tx`select id from tenants where id = ${tenantId} for update`
    const [contact] = await tx<Array<{ id: string; jid: string; alt_jid: string | null; display_name: string | null; selected: boolean }>>`
      select id, jid, alt_jid, display_name, selected from whatsapp_contacts where id = ${contactId} and tenant_id = ${tenantId}
    `
    if (!contact) return { ok: false, reason: 'not_found' }

    if (!change.selected) {
      await tx`update whatsapp_contacts set selected = false where id = ${contact.id}`
      const addresses = contact.alt_jid ? [contact.jid, contact.alt_jid] : [contact.jid]
      await tx`
        delete from whatsapp_messages m
        where m.tenant_id = ${tenantId} and m.chat_jid in ${tx(addresses)}
          and not exists (select 1 from analysis_run_messages arm where arm.message_id = m.id)
      `
      return { ok: true }
    }

    if (!contact.selected) {
      const [others] = await tx<Array<{ n: number }>>`select count(*)::int as n from whatsapp_contacts where tenant_id = ${tenantId} and selected`
      if ((others?.n ?? 0) >= CONTACT_LIMIT) return { ok: false, reason: 'limit' }
    }
    let projectId: string | null = null
    if (!change.projectId) {
      projectId = null
    } else if (change.projectId === 'new') {
      const name = (contact.display_name ?? masked(contact.jid)).slice(0, 80)
      const [created] = await tx<Array<{ id: string }>>`
        insert into projects (tenant_id, name) values (${tenantId}, ${name})
        on conflict (tenant_id, name) do update set name = excluded.name
        returning id
      `
      projectId = created?.id ?? null
    } else if (change.projectId && /^[0-9a-f-]{36}$/i.test(change.projectId)) {
      const [owned] = await tx<Array<{ id: string }>>`
        select id from projects where id = ${change.projectId} and tenant_id = ${tenantId} and status = 'active'
      `
      projectId = owned?.id ?? null
      if (!projectId) return { ok: false, reason: 'project' }
    } else {
      return { ok: false, reason: 'project' }
    }
    await tx`update whatsapp_contacts set selected = true, project_id = ${projectId} where id = ${contact.id}`
    // History held since pairing now belongs to the chosen contact.
    const holdIn = projectId ?? (await defaultProjectId(tx, tenantId))
    const addresses = contact.alt_jid ? [contact.jid, contact.alt_jid] : [contact.jid]
    await tx`
      update whatsapp_messages set project_id = ${holdIn}
      where tenant_id = ${tenantId} and project_id is null and chat_jid in ${tx(addresses)}
    `
    return { ok: true }
  })
}
