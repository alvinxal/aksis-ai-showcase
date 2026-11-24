import { createInvitationForTenant } from './admin.js'
import type { Database } from './db.js'
import { monthStart, startOfWibDayDate } from './usage-range.js'

/* ---------- app state ---------- */

/** A completed run with no token count (cost NULL) still counts towards the cap at this assumed cost. */
export const UNMETERED_RUN_COST_USD = 0.003

export async function getState(sql: Database, key: string): Promise<string | null> {
  const [row] = await sql<Array<{ value: string }>>`select value from app_state where key = ${key}`
  return row?.value ?? null
}

export async function setState(sql: Database, key: string, value: string): Promise<void> {
  await sql`
    insert into app_state (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `
}

/* ---------- admins ---------- */

export async function listDbAdmins(sql: Database): Promise<number[]> {
  const rows = await sql<Array<{ telegram_id: string }>>`select telegram_id from admins order by added_at`
  return rows.map((row) => Number(row.telegram_id))
}

export async function addDbAdmin(sql: Database, telegramId: number, addedBy: number): Promise<void> {
  await sql`
    insert into admins (telegram_id, added_by) values (${telegramId}, ${addedBy})
    on conflict (telegram_id) do nothing
  `
}

export async function removeDbAdmin(sql: Database, telegramId: number): Promise<void> {
  await sql`delete from admins where telegram_id = ${telegramId}`
}

/* ---------- invitations ---------- */

export type OpenInvitation = {
  id: string
  tenantId: string
  tenantName: string
  expiresAt: Date
  expired: boolean
}

export async function listOpenInvitations(sql: Database): Promise<OpenInvitation[]> {
  const rows = await sql<
    Array<{ id: string; tenant_id: string; name: string; expires_at: Date; expired: boolean }>
  >`
    select i.id, i.tenant_id, t.name, i.expires_at, i.expires_at <= now() as expired
    from invitations i join tenants t on t.id = i.tenant_id
    where i.used_at is null and i.revoked_at is null
    order by i.created_at desc
    limit 15
  `
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.name,
    expiresAt: row.expires_at,
    expired: row.expired,
  }))
}

export async function getOpenInvitation(sql: Database, id: string): Promise<OpenInvitation | null> {
  return (await listOpenInvitations(sql)).find((invitation) => invitation.id === id) ?? null
}

export async function revokeInvitation(sql: Database, id: string): Promise<void> {
  await sql`update invitations set revoked_at = now(), phone = null where id = ${id} and used_at is null and revoked_at is null`
}

/** The newest invitation of a tenant that was not revoked: waiting, used by the customer, or expired. */
export type TenantInvitation = { id: string; expiresAt: Date; expired: boolean; used: boolean }

export async function getTenantInvitation(sql: Database, tenantId: string): Promise<TenantInvitation | null> {
  const [row] = await sql<Array<{ id: string; expires_at: Date; expired: boolean; used: boolean }>>`
    select id, expires_at, expires_at <= now() as expired, used_at is not null as used
    from invitations
    where tenant_id = ${tenantId} and revoked_at is null
    order by created_at desc limit 1
  `
  return row ? { id: row.id, expiresAt: row.expires_at, expired: row.expired, used: row.used } : null
}

/** Cancels the links of a tenant that nobody has opened yet. */
export async function revokeTenantInvitations(sql: Database, tenantId: string): Promise<void> {
  await sql`
    update invitations set revoked_at = now(), phone = null
    where tenant_id = ${tenantId} and used_at is null and revoked_at is null
  `
}

/** Revokes every open link of the tenant and issues one new link; a number given with the old link moves to it. */
export async function renewTenantInvitation(
  sql: Database,
  tenantId: string,
  actor: number,
): Promise<{ token: string; expiresAt: Date; phone: string | null }> {
  const [row] = await sql<Array<{ phone: string | null }>>`
    select phone from invitations
    where tenant_id = ${tenantId} and used_at is null and revoked_at is null and phone is not null
    order by created_at desc limit 1
  `
  const phone = row?.phone ?? null
  await revokeTenantInvitations(sql, tenantId)
  const created = await createInvitationForTenant(sql, tenantId, actor, phone)
  return { ...created, phone }
}

/** Same, starting from one of the tenant's open invitations (an older bot message may still point at it). */
export async function renewInvitation(
  sql: Database,
  invitationId: string,
  actor: number,
): Promise<{ token: string; expiresAt: Date; tenantName: string; tenantId: string; phone: string | null } | null> {
  const invitation = await getOpenInvitation(sql, invitationId)
  if (!invitation) return null
  const renewed = await renewTenantInvitation(sql, invitation.tenantId, actor)
  return { ...renewed, tenantName: invitation.tenantName, tenantId: invitation.tenantId }
}

/** Forgets the number of invitations that were used, revoked or have expired. */
export async function pruneInvitationPhones(sql: Database): Promise<void> {
  await sql`
    update invitations set phone = null
    where phone is not null and (used_at is not null or revoked_at is not null or expires_at <= now())
  `
}

/* ---------- tenant profile ---------- */

export async function renameTenant(sql: Database, tenantId: string, name: string): Promise<void> {
  await sql`update tenants set name = ${name} where id = ${tenantId}`
}

export async function setTenantNotes(sql: Database, tenantId: string, notes: string | null): Promise<void> {
  await sql`update tenants set notes = ${notes} where id = ${tenantId}`
}

export async function getTenantNotes(sql: Database, tenantId: string): Promise<string | null> {
  const [row] = await sql<Array<{ notes: string | null }>>`select notes from tenants where id = ${tenantId}`
  return row?.notes ?? null
}

/* ---------- failed runs ---------- */

export type FailedRunsSummary = {
  recent: Array<{ at: Date; tenantName: string; error: string }>
  blocked: Array<{ tenantId: string; tenantName: string; messages: number }>
}

export async function failedRunsSummary(sql: Database): Promise<FailedRunsSummary> {
  const recent = await sql<Array<{ finished_at: Date | null; started_at: Date; name: string; error_text: string | null }>>`
    select r.finished_at, r.started_at, t.name, r.error_text
    from analysis_runs r join tenants t on t.id = r.tenant_id
    where r.status = 'failed' and r.started_at > now() - interval '48 hours'
    order by r.started_at desc limit 6
  `
  const blocked = await sql<Array<{ tenant_id: string; name: string; n: string }>>`
    select m.tenant_id, t.name, count(*) as n
    from whatsapp_messages m join tenants t on t.id = m.tenant_id
    where m.analysis_attempts >= 3 and m.last_analysis_error is not null
      and not exists (select 1 from analysis_run_messages arm where arm.message_id = m.id)
    group by m.tenant_id, t.name
    order by count(*) desc
  `
  return {
    recent: recent.map((row) => ({
      at: row.finished_at ?? row.started_at,
      tenantName: row.name,
      error: (row.error_text ?? 'unknown').replace(/\s+/g, ' ').slice(0, 80),
    })),
    blocked: blocked.map((row) => ({ tenantId: row.tenant_id, tenantName: row.name, messages: Number(row.n) })),
  }
}

/** Gives messages that ran out of attempts a fresh set of attempts. */
export async function retryBlockedMessages(sql: Database, tenantId: string): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    update whatsapp_messages m
    set analysis_attempts = 0, last_analysis_error = null
    where m.tenant_id = ${tenantId} and m.analysis_attempts >= 3 and m.last_analysis_error is not null
      and not exists (select 1 from analysis_run_messages arm where arm.message_id = m.id)
    returning m.id
  `
  return rows.length
}

/* ---------- usage limits ---------- */

export type LimitStatus = {
  tenantId: string
  name: string
  dailyLimit: number | null
  monthlyLimit: number | null
  paused: boolean
  todayCost: number
  monthCost: number
}

export async function limitStatuses(sql: Database, tenantId?: string, now = new Date()): Promise<LimitStatus[]> {
  const dayStart = startOfWibDayDate(now)
  const monthFrom = monthStart(now)
  const rows = await sql<
    Array<{
      id: string
      name: string
      daily: string | null
      monthly: string | null
      paused: boolean
      today: string | null
      month: string | null
    }>
  >`
    select t.id, t.name, t.daily_cost_limit_usd as daily, t.monthly_cost_limit_usd as monthly, t.usage_paused as paused,
      (select sum(coalesce(r.estimated_cost_usd, ${UNMETERED_RUN_COST_USD})) from analysis_runs r
        where r.tenant_id = t.id and r.status = 'completed' and r.started_at >= ${dayStart}) as today,
      (select sum(coalesce(r.estimated_cost_usd, ${UNMETERED_RUN_COST_USD})) from analysis_runs r
        where r.tenant_id = t.id and r.status = 'completed' and r.started_at >= ${monthFrom}) as month
    from tenants t
    where ${tenantId ?? null}::uuid is null or t.id = ${tenantId ?? null}::uuid
    order by t.created_at
  `
  return rows.map((row) => ({
    tenantId: row.id,
    name: row.name,
    dailyLimit: row.daily === null ? null : Number(row.daily),
    monthlyLimit: row.monthly === null ? null : Number(row.monthly),
    paused: row.paused,
    todayCost: Number(row.today ?? 0),
    monthCost: Number(row.month ?? 0),
  }))
}

export async function setLimit(
  sql: Database,
  tenantId: string,
  scope: 'daily' | 'monthly',
  value: number | null,
): Promise<void> {
  if (scope === 'daily') await sql`update tenants set daily_cost_limit_usd = ${value} where id = ${tenantId}`
  else await sql`update tenants set monthly_cost_limit_usd = ${value} where id = ${tenantId}`
}

export async function setUsagePaused(sql: Database, tenantId: string, paused: boolean): Promise<void> {
  await sql`update tenants set usage_paused = ${paused} where id = ${tenantId}`
}

/* ---------- broadcast ---------- */

export async function enqueueBroadcast(sql: Database, tenantIds: string[], text: string): Promise<number> {
  let count = 0
  for (const tenantId of tenantIds) {
    await sql`
      insert into outbound_messages (tenant_id, channel, text_content)
      values (${tenantId}, 'broadcast', ${text})
    `
    count += 1
  }
  return count
}

export async function activeTenantIds(sql: Database): Promise<Array<{ id: string; name: string }>> {
  return sql<Array<{ id: string; name: string }>>`
    select id, name from tenants where status = 'active' order by created_at
  `
}

/* ---------- daily summary ---------- */

export type DailySummary = {
  cost: number
  runs: number
  failedRuns: number
  events: number
  selfMessages: number
  groupMessages: number
  statusCounts: Record<string, number>
  perTenant: Array<{ name: string; cost: number }>
}

export async function dailySummary(sql: Database, from: Date, to: Date): Promise<DailySummary> {
  const [totals] = await sql<
    Array<{ cost: string | null; runs: string; failed: string; events: string; self_msgs: string; group_msgs: string }>
  >`
    select
      (select sum(estimated_cost_usd) from analysis_runs where status = 'completed' and started_at >= ${from} and started_at < ${to}) as cost,
      (select count(*) from analysis_runs where status = 'completed' and started_at >= ${from} and started_at < ${to}) as runs,
      (select count(*) from analysis_runs where status = 'failed' and started_at >= ${from} and started_at < ${to}) as failed,
      (select count(*) from project_events where created_at >= ${from} and created_at < ${to}) as events,
      (select count(*) from whatsapp_messages where is_self_chat and not is_agent_generated and received_at >= ${from} and received_at < ${to}) as self_msgs,
      (select count(*) from whatsapp_messages where chat_jid like '%@g.us' and received_at >= ${from} and received_at < ${to}) as group_msgs
  `
  const statuses = await sql<Array<{ status: string; n: string }>>`select status, count(*) as n from tenants group by status`
  const perTenant = await sql<Array<{ name: string; cost: string | null }>>`
    select t.name, sum(r.estimated_cost_usd) as cost
    from tenants t join analysis_runs r on r.tenant_id = t.id
    where r.status = 'completed' and r.started_at >= ${from} and r.started_at < ${to}
    group by t.id, t.name order by sum(r.estimated_cost_usd) desc nulls last limit 5
  `
  return {
    cost: Number(totals?.cost ?? 0),
    runs: Number(totals?.runs ?? 0),
    failedRuns: Number(totals?.failed ?? 0),
    events: Number(totals?.events ?? 0),
    selfMessages: Number(totals?.self_msgs ?? 0),
    groupMessages: Number(totals?.group_msgs ?? 0),
    statusCounts: Object.fromEntries(statuses.map((row) => [row.status, Number(row.n)])),
    perTenant: perTenant.map((row) => ({ name: row.name, cost: Number(row.cost ?? 0) })),
  }
}

/* ---------- needs attention ---------- */

export type AttentionKind = 'plan' | 'whatsapp' | 'stuck' | 'billing' | 'failed' | 'paused'
export type AttentionItem = { tenantId: string; name: string; kind: AttentionKind; detail: string }

const ATTENTION_ORDER: AttentionKind[] = ['plan', 'whatsapp', 'billing', 'paused', 'failed', 'stuck']

/**
 * What an admin should look at: active customers whose WhatsApp is not connected, onboarding that has
 * been stuck for a day, plans ending within a week (or already over), runs that failed in the last day,
 * and customers paused by a usage limit. `connectionOf` is the live WhatsApp state, which is not in the database.
 */
export async function attentionItems(
  sql: Database,
  connectionOf: (tenantId: string) => string | undefined,
  now = new Date(),
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []

  const whatsapp = await sql<Array<{ id: string; name: string }>>`
    select id, name from tenants where status = 'active' and whatsapp_enabled order by created_at
  `
  for (const row of whatsapp) {
    const connection = connectionOf(row.id)
    if (connection !== undefined && connection !== 'connected') items.push({ tenantId: row.id, name: row.name, kind: 'whatsapp', detail: `WhatsApp ${connection}` })
  }

  // Their WhatsApp is connected and the page waits for an admin to choose a plan.
  const waiting = await sql<Array<{ id: string; name: string }>>`
    select t.id, t.name from tenants t
    where t.status = 'onboarding' and t.plan_requested_at is not null
      and not exists (select 1 from subscriptions s where s.tenant_id = t.id)
    order by t.plan_requested_at
  `
  for (const row of waiting) items.push({ tenantId: row.id, name: row.name, kind: 'plan', detail: 'menunggu paket dipilih' })

  const stuck = await sql<Array<{ id: string; name: string; status: string }>>`
    select id, name, status from tenants
    where status in ('invited', 'onboarding') and created_at < ${new Date(now.getTime() - 24 * 3_600_000)}
    order by created_at
  `
  const waitingIds = new Set(waiting.map((row) => row.id))
  for (const row of stuck) {
    if (waitingIds.has(row.id)) continue
    items.push({ tenantId: row.id, name: row.name, kind: 'stuck', detail: row.status === 'invited' ? 'link belum dibuka' : 'onboarding belum selesai' })
  }

  const billing = await sql<Array<{ id: string; name: string; ends_at: Date }>>`
    select t.id, t.name, s.ends_at
    from tenants t join subscriptions s on s.tenant_id = t.id
    where t.status = 'active' and s.ends_at < ${new Date(now.getTime() + 7 * 86_400_000)}
    order by s.ends_at
  `
  for (const row of billing) {
    items.push({ tenantId: row.id, name: row.name, kind: 'billing', detail: row.ends_at <= now ? 'langganan berakhir' : `langganan berakhir ${row.ends_at.toISOString().slice(0, 10)}` })
  }

  const failed = await sql<Array<{ id: string; name: string; n: string }>>`
    select t.id, t.name, count(*) as n
    from analysis_runs r join tenants t on t.id = r.tenant_id
    where r.status = 'failed' and r.started_at > ${new Date(now.getTime() - 24 * 3_600_000)}
    group by t.id, t.name
    order by count(*) desc
  `
  for (const row of failed) items.push({ tenantId: row.id, name: row.name, kind: 'failed', detail: `${Number(row.n)} run gagal 24 jam` })

  const paused = await sql<Array<{ id: string; name: string }>>`
    select id, name from tenants where status = 'active' and usage_paused order by created_at
  `
  for (const row of paused) items.push({ tenantId: row.id, name: row.name, kind: 'paused', detail: 'dijeda: batas pemakaian' })

  return items.sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind))
}
