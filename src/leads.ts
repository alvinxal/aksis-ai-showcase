import { createInvitation, recordAudit } from './admin.js'
import type { Database } from './db.js'

/** A request that nobody turned into an invitation is deleted this many days after it came in. */
export const LEAD_KEEP_DAYS = 30

export type LeadStatus = 'new' | 'contacted' | 'rejected'
export type Lead = { id: string; name: string; phone: string; status: LeadStatus; createdAt: Date }

type LeadRow = { id: string; name: string; phone: string; status: LeadStatus; created_at: Date }

const toLead = (row: LeadRow): Lead => ({ id: row.id, name: row.name, phone: row.phone, status: row.status, createdAt: row.created_at })

/** Stores a request; null when an open request with the same number already exists. */
export async function createLead(sql: Database, name: string, phone: string, termsVersion: string): Promise<Lead | null> {
  const [row] = await sql<LeadRow[]>`
    insert into leads (name, phone, terms_version) values (${name}, ${phone}, ${termsVersion})
    on conflict (phone) where status in ('new', 'contacted') do nothing
    returning id, name, phone, status, created_at
  `
  return row ? toLead(row) : null
}

export async function getLead(sql: Database, id: string): Promise<Lead | null> {
  const [row] = await sql<LeadRow[]>`select id, name, phone, status, created_at from leads where id = ${id}`
  return row ? toLead(row) : null
}

/** New and contacted requests, oldest first. */
export async function listOpenLeads(sql: Database, limit = 8): Promise<Lead[]> {
  const rows = await sql<LeadRow[]>`
    select id, name, phone, status, created_at from leads
    where status in ('new', 'contacted') order by created_at limit ${limit}
  `
  return rows.map(toLead)
}

export async function countNewLeads(sql: Database): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`select count(*)::int as n from leads where status = 'new'`
  return row?.n ?? 0
}

export async function setLeadStatus(sql: Database, id: string, status: 'contacted' | 'rejected'): Promise<Lead | null> {
  const [row] = await sql<LeadRow[]>`
    update leads set status = ${status}, contacted_at = case when ${status} = 'contacted' then now() else contacted_at end
    where id = ${id} returning id, name, phone, status, created_at
  `
  return row ? toLead(row) : null
}

/**
 * Takes the request out (delete returning), so two taps on "Create invite" make one invitation; the caller
 * puts it back with `restoreLead` if the invitation could not be made.
 */
export async function claimLead(sql: Database, id: string): Promise<{ name: string; phone: string; termsVersion: string | null } | null> {
  const [row] = await sql<Array<{ name: string; phone: string; terms_version: string | null }>>`
    delete from leads where id = ${id} returning name, phone, terms_version
  `
  return row ? { name: row.name, phone: row.phone, termsVersion: row.terms_version } : null
}

export async function restoreLead(sql: Database, lead: { name: string; phone: string; termsVersion: string | null }): Promise<void> {
  await sql`
    insert into leads (name, phone, terms_version) values (${lead.name}, ${lead.phone}, ${lead.termsVersion})
    on conflict (phone) where status in ('new', 'contacted') do nothing
  `
}

export async function purgeOldLeads(sql: Database, days = LEAD_KEEP_DAYS): Promise<number> {
  const result = await sql`delete from leads where created_at < now() - make_interval(days => ${days})`
  return result.count
}

/**
 * Makes the invitation for the number a request gave and removes the request (the data is on the customer now).
 * Null when the request is already gone; a failed invitation puts the request back.
 */
export async function inviteFromLead(sql: Database, id: string, actorTelegramId: number) {
  const lead = await claimLead(sql, id)
  if (!lead) return null
  let invite: Awaited<ReturnType<typeof createInvitation>>
  try {
    invite = await createInvitation(sql, lead.name.slice(0, 80), actorTelegramId, lead.phone)
  } catch (error) {
    await restoreLead(sql, lead).catch(() => undefined)
    throw error
  }
  await recordAudit(sql, actorTelegramId, 'invite_created', invite.tenantId, { fromLead: true })
  return { ...invite, name: lead.name, phone: lead.phone }
}
