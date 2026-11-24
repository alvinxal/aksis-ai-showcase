import { createHash, randomBytes } from 'node:crypto'
import type { Database, JsonValue } from './db.js'

export const INVITE_TTL_HOURS = 48
export const SESSION_TTL_DAYS = 7

export type TenantStatus = 'invited' | 'onboarding' | 'active' | 'disabled'

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function recordAudit(
  sql: Database,
  actorTelegramId: number | null,
  action: string,
  tenantId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`
    insert into admin_audit (actor_telegram_id, action, tenant_id, detail)
    values (${actorTelegramId}, ${action}, ${tenantId}, ${sql.json(detail as JsonValue)})
  `
}

export async function createInvitationForTenant(
  sql: Database,
  tenantId: string,
  actorTelegramId: number,
  phone: string | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000)
  await sql`
    insert into invitations (tenant_id, token_hash, created_by_telegram_id, expires_at, phone)
    values (${tenantId}, ${hashToken(token)}, ${actorTelegramId}, ${expiresAt}, ${phone})
  `
  return { token, expiresAt }
}

/** The WhatsApp number a tenant linked, as digits with country code (null before it is linked). */
export async function getTenantPhone(sql: Database, tenantId: string): Promise<string | null> {
  const [row] = await sql<Array<{ jid: string | null }>>`select whatsapp_jid as jid from tenants where id = ${tenantId}`
  const digits = row?.jid?.split('@')[0]?.split(':')[0] ?? ''
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}

/** Puts a tenant back at the start of the WhatsApp step so it can be paired again. */
export async function resetOnboarding(sql: Database, tenantId: string): Promise<void> {
  await sql`
    update tenants set onboarded_at = null, whatsapp_enabled = false, whatsapp_jid = null
    where id = ${tenantId}
  `
}

export async function createInvitation(
  sql: Database,
  name: string,
  actorTelegramId: number,
  phone: string | null = null,
): Promise<{ token: string; tenantId: string; expiresAt: Date }> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000)
  const tenantId = await sql.begin(async (tx) => {
    const [tenant] = await tx<Array<{ id: string }>>`
      insert into tenants (name, status) values (${name}, 'invited') returning id
    `
    if (!tenant) throw new Error('tenant insert returned no row')
    await tx`
      insert into invitations (tenant_id, token_hash, created_by_telegram_id, expires_at, phone)
      values (${tenant.id}, ${hashToken(token)}, ${actorTelegramId}, ${expiresAt}, ${phone})
    `
    return tenant.id
  })
  return { token, tenantId, expiresAt }
}

export type TenantSummary = {
  id: string
  name: string
  status: TenantStatus
  createdAt: Date
  messages: number
}

export async function listTenants(sql: Database): Promise<TenantSummary[]> {
  const rows = await sql<
    Array<{ id: string; name: string; status: TenantStatus; created_at: Date; messages: string }>
  >`
    select t.id, t.name, t.status, t.created_at,
           (select count(*) from whatsapp_messages m where m.tenant_id = t.id) as messages
    from tenants t
    order by t.created_at
  `
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    messages: Number(row.messages),
  }))
}

export type UsageRow = {
  name: string
  runs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** Plain names for the kinds of AI work recorded in analysis_runs.source_kind. */
export const USAGE_KIND_LABEL: Record<string, string> = {
  self_chat: 'Tanya via WhatsApp',
  group: 'Baca grup',
  contact: 'Baca chat pribadi',
  app_chat: 'Chat di app',
  summary: 'Catatan proyek',
}

export type UsageKindRow = { kind: string; runs: number; costUsd: number }

/** Completed AI runs and their cost per kind of work, for everyone or for one customer. Biggest cost first. */
export async function usageByKind(sql: Database, from: Date, to: Date, tenantId?: string): Promise<UsageKindRow[]> {
  const rows = await sql<Array<{ kind: string; runs: string; cost: string | null }>>`
    select r.source_kind as kind, count(*) as runs, sum(r.estimated_cost_usd) as cost
    from analysis_runs r
    where r.status = 'completed'
      and r.started_at >= ${from} and r.started_at < ${to}
      and (${tenantId ?? null}::uuid is null or r.tenant_id = ${tenantId ?? null}::uuid)
    group by r.source_kind
    order by sum(r.estimated_cost_usd) desc nulls last, r.source_kind
  `
  return rows.map((row) => ({ kind: row.kind, runs: Number(row.runs), costUsd: Number(row.cost ?? 0) }))
}

export async function usageByTenant(
  sql: Database,
  from: Date,
  to: Date,
  tenantId?: string,
): Promise<UsageRow[]> {
  const rows = await sql<
    Array<{ name: string; runs: string; input: string | null; output: string | null; cost: string | null }>
  >`
    select t.name,
           count(r.id) as runs,
           sum(r.input_tokens) as input,
           sum(r.output_tokens) as output,
           sum(r.estimated_cost_usd) as cost
    from tenants t
    left join analysis_runs r
      on r.tenant_id = t.id
     and r.status = 'completed'
     and r.started_at >= ${from} and r.started_at < ${to}
    where ${tenantId ?? null}::uuid is null or t.id = ${tenantId ?? null}::uuid
    group by t.id, t.name
    order by t.created_at
  `
  return rows.map((row) => ({
    name: row.name,
    runs: Number(row.runs),
    inputTokens: Number(row.input ?? 0),
    outputTokens: Number(row.output ?? 0),
    costUsd: Number(row.cost ?? 0),
  }))
}

export async function systemCounts(
  sql: Database,
): Promise<{ failedRuns24h: number; pendingOutbound: number }> {
  const [row] = await sql<Array<{ failed: string; pending: string }>>`
    select
      (select count(*) from analysis_runs
        where status = 'failed' and started_at > now() - interval '24 hours') as failed,
      (select count(*) from outbound_messages where status <> 'sent') as pending
  `
  return { failedRuns24h: Number(row?.failed ?? 0), pendingOutbound: Number(row?.pending ?? 0) }
}

export type TenantLookup =
  | { kind: 'found'; id: string; name: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

export async function findTenant(sql: Database, identifier: string): Promise<TenantLookup> {
  const rows = await sql<Array<{ id: string; name: string }>>`
    select id, name from tenants
    where id::text like ${identifier.toLowerCase() + '%'} or lower(name) = lower(${identifier})
    limit 3
  `
  if (rows.length === 0) return { kind: 'none' }
  const first = rows[0]
  if (rows.length > 1 || !first) return { kind: 'ambiguous', count: rows.length }
  return { kind: 'found', id: first.id, name: first.name }
}

export async function setTenantStatus(
  sql: Database,
  tenantId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await sql`
    update tenants
    set status = ${status},
        disabled_at = ${status === 'disabled' ? sql`now()` : null}
    where id = ${tenantId}
  `
  if (status === 'disabled') {
    await sql`delete from web_sessions where tenant_id = ${tenantId}`
  }
}

export type OnboardingSession = {
  tenantId: string
  tenantName: string
  status: TenantStatus
  contactName: string | null
  onboardedAt: Date | null
}

export async function joinWithInvitation(
  sql: Database,
  token: string,
): Promise<{ sessionToken: string; session: OnboardingSession } | null> {
  const sessionToken = newToken()
  const sessionExpires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000)
  const tenantId = await sql.begin(async (tx) => {
    const [invitation] = await tx<Array<{ tenant_id: string }>>`
      update invitations
      set used_at = now(), phone = null
      where token_hash = ${hashToken(token)}
        and used_at is null and revoked_at is null and expires_at > now()
      returning tenant_id
    `
    if (!invitation) return null
    await tx`
      update tenants set status = 'onboarding'
      where id = ${invitation.tenant_id} and status = 'invited'
    `
    await tx`
      insert into projects (tenant_id, name) values (${invitation.tenant_id}, 'Umum')
      on conflict (tenant_id, name) do nothing
    `
    await tx`
      insert into web_sessions (tenant_id, token_hash, expires_at)
      values (${invitation.tenant_id}, ${hashToken(sessionToken)}, ${sessionExpires})
    `
    return invitation.tenant_id
  })
  if (!tenantId) return null
  const session = await getSessionByTenant(sql, tenantId)
  return session ? { sessionToken, session } : null
}

async function getSessionByTenant(sql: Database, tenantId: string): Promise<OnboardingSession | null> {
  const [row] = await sql<
    Array<{
      id: string
      name: string
      status: TenantStatus
      contact_name: string | null
      onboarded_at: Date | null
    }>
  >`select id, name, status, contact_name, onboarded_at from tenants where id = ${tenantId}`
  return row
    ? {
        tenantId: row.id,
        tenantName: row.name,
        status: row.status,
        contactName: row.contact_name,
        onboardedAt: row.onboarded_at,
      }
    : null
}

export async function getOnboardingSession(
  sql: Database,
  sessionToken: string,
): Promise<OnboardingSession | null> {
  const [row] = await sql<Array<{ tenant_id: string }>>`
    select s.tenant_id
    from web_sessions s
    join tenants t on t.id = s.tenant_id
    where s.token_hash = ${hashToken(sessionToken)}
      and s.kind = 'onboarding' and s.expires_at > now()
      and t.status in ('onboarding', 'active')
  `
  return row ? getSessionByTenant(sql, row.tenant_id) : null
}

export async function saveTenantProfile(
  sql: Database,
  tenantId: string,
  studioName: string,
  contactName: string,
  termsVersion: string,
): Promise<void> {
  await sql`
    update tenants set name = ${studioName}, contact_name = ${contactName},
      terms_accepted_at = now(), terms_version = ${termsVersion}
    where id = ${tenantId}
  `
}

export async function markOnboarded(sql: Database, tenantId: string): Promise<void> {
  await sql`update tenants set onboarded_at = coalesce(onboarded_at, now()) where id = ${tenantId}`
}

export type TenantDetail = {
  id: string
  name: string
  status: TenantStatus
  contactName: string | null
  createdAt: Date
  onboardedAt: Date | null
  whatsappJid: string | null
  selfMessages: number
  groupMessages: number
  events: number
  groups: string[]
}

export async function getTenantDetail(sql: Database, tenantId: string): Promise<TenantDetail | null> {
  const [row] = await sql<
    Array<{
      id: string
      name: string
      status: TenantStatus
      contact_name: string | null
      created_at: Date
      onboarded_at: Date | null
      whatsapp_jid: string | null
      self_messages: string
      group_messages: string
      events: string
    }>
  >`
    select t.id, t.name, t.status, t.contact_name, t.created_at, t.onboarded_at, t.whatsapp_jid,
      (select count(*) from whatsapp_messages m where m.tenant_id = t.id and m.is_self_chat) as self_messages,
      (select count(*) from whatsapp_messages m where m.tenant_id = t.id and m.chat_jid like '%@g.us') as group_messages,
      (select count(*) from project_events e where e.tenant_id = t.id) as events
    from tenants t where t.id = ${tenantId}
  `
  if (!row) return null
  const groups = await sql<Array<{ subject: string }>>`
    select subject from whatsapp_groups where tenant_id = ${tenantId} and selected order by subject
  `
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    contactName: row.contact_name,
    createdAt: row.created_at,
    onboardedAt: row.onboarded_at,
    whatsappJid: row.whatsapp_jid,
    selfMessages: Number(row.self_messages),
    groupMessages: Number(row.group_messages),
    events: Number(row.events),
    groups: groups.map((group) => group.subject),
  }
}

/**
 * Permanently deletes a tenant and everything stored for it. Rows are removed in
 * dependency order because event sources and run messages restrict message deletion.
 */
export async function deleteTenantData(
  sql: Database,
  tenantId: string,
): Promise<{ name: string; messages: number } | null> {
  return sql.begin(async (tx) => {
    const [tenant] = await tx<Array<{ name: string }>>`select name from tenants where id = ${tenantId} for update`
    if (!tenant) return null
    const [count] = await tx<Array<{ messages: string }>>`
      select count(*) as messages from whatsapp_messages where tenant_id = ${tenantId}
    `
    await tx`
      delete from project_event_sources
      where event_id in (select id from project_events where tenant_id = ${tenantId})
    `
    await tx`delete from project_events where tenant_id = ${tenantId}`
    await tx`delete from outbound_messages where tenant_id = ${tenantId}`
    await tx`
      delete from analysis_run_messages
      where analysis_run_id in (select id from analysis_runs where tenant_id = ${tenantId})
    `
    await tx`delete from analysis_runs where tenant_id = ${tenantId}`
    await tx`delete from whatsapp_messages where tenant_id = ${tenantId}`
    await tx`delete from tenants where id = ${tenantId}`
    return { name: tenant.name, messages: Number(count?.messages ?? 0) }
  })
}
