import { USAGE_KIND_LABEL, usageByKind, usageByTenant } from './admin.js'
import { GRACE_DAYS, billingOverview, monthlyRecurringIdr, subscriptionStatus } from './billing.js'
import type { Database } from './db.js'
import type { FeatureHealth } from './health.js'
import { countNewLeads, listOpenLeads } from './leads.js'
import { attentionItems, failedRunsSummary, limitStatuses } from './ops.js'
import { EXPIRED_KEEP_DAYS } from './retention.js'
import { wibDateString } from './usage-range.js'

/**
 * What the dashboard shows is aggregate: names of customers, counts, costs and states. Never the text of a message,
 * the name of a group or a contact, or what a chat answered (the same rule as the audit log).
 */
export type Live = {
  /** The WhatsApp state of a customer, or undefined when its session is not loaded. */
  connectionOf: (tenantId: string) => string | undefined
  whatsapp: () => Array<{ tenantId: string; connection: string }>
  /** Null when the agent is not configured. */
  hermesHealthy: () => Promise<boolean | null>
  systemConnection: () => { connection: string; paired: boolean } | null
  features?: FeatureHealth
}

const DAY_MS = 86_400_000

export async function overview(sql: Database, live: Live, now = new Date()) {
  const statuses = await sql<Array<{ status: string; n: number }>>`select status, count(*)::int as n from tenants group by status`
  const limits = await limitStatuses(sql, undefined, now)
  const failed = await failedRunsSummary(sql)
  return {
    customers: Object.fromEntries(statuses.map((row) => [row.status, row.n])) as Record<string, number>,
    newRequests: await countNewLeads(sql),
    costUsd: {
      today: limits.reduce((sum, row) => sum + row.todayCost, 0),
      month: limits.reduce((sum, row) => sum + row.monthCost, 0),
    },
    monthlyRecurringIdr: await monthlyRecurringIdr(sql, now),
    attention: await attentionItems(sql, live.connectionOf, now),
    failedRuns: failed.recent.map((row) => ({ at: row.at.toISOString(), customer: row.tenantName, error: row.error })),
    blocked: failed.blocked,
  }
}

export async function customers(sql: Database, live: Live, now = new Date()) {
  const rows = await sql<
    Array<{
      id: string
      name: string
      status: string
      created_at: Date
      usage_paused: boolean
      notes: string | null
      terms_accepted_at: Date | null
      plan_code: string | null
      plan_name: string | null
      ends_at: Date | null
      groups: number
      contacts: number
      messages: number
    }>
  >`
    select t.id, t.name, t.status, t.created_at, t.usage_paused, t.notes, t.terms_accepted_at,
      s.plan_code, p.name as plan_name, s.ends_at,
      (select count(*)::int from whatsapp_groups g where g.tenant_id = t.id and g.selected) as groups,
      (select count(*)::int from whatsapp_contacts c where c.tenant_id = t.id and c.selected) as contacts,
      (select count(*)::int from whatsapp_messages m where m.tenant_id = t.id) as messages
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plans p on p.code = s.plan_code
    order by t.created_at
  `
  const costs = new Map((await limitStatuses(sql, undefined, now)).map((row) => [row.tenantId, row]))
  return rows.map((row) => {
    const cost = costs.get(row.id)
    const subscription = row.plan_code && row.ends_at ? { planCode: row.plan_code, endsAt: row.ends_at } : null
    const state = subscriptionStatus(subscription, now)
    const deletion =
      row.ends_at && state === 'expired' ? new Date(row.ends_at.getTime() + (GRACE_DAYS + EXPIRED_KEEP_DAYS) * DAY_MS) : null
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      plan: row.plan_name,
      planCode: row.plan_code,
      subscription: state,
      endsAt: row.ends_at?.toISOString() ?? null,
      deletionOn: deletion?.toISOString() ?? null,
      whatsapp: live.connectionOf(row.id) ?? null,
      groups: row.groups,
      contacts: row.contacts,
      messages: row.messages,
      paused: row.usage_paused,
      notes: row.notes,
      acceptedTerms: row.terms_accepted_at !== null,
      costUsd: { today: cost?.todayCost ?? 0, month: cost?.monthCost ?? 0 },
      limitUsd: { daily: cost?.dailyLimit ?? null, monthly: cost?.monthlyLimit ?? null },
    }
  })
}

export async function usage(sql: Database, days: number, now = new Date()) {
  const span = Math.min(90, Math.max(1, Math.round(days)))
  const from = new Date(now.getTime() - span * DAY_MS)
  const rows = await sql<Array<{ day: string; runs: number; failed: number; cost: string | null }>>`
    select to_char(started_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD') as day,
      (count(*) filter (where status = 'completed'))::int as runs,
      (count(*) filter (where status = 'failed'))::int as failed,
      sum(estimated_cost_usd) filter (where status = 'completed') as cost
    from analysis_runs where started_at >= ${from}
    group by 1 order by 1
  `
  const byDay = new Map(rows.map((row) => [row.day, row]))
  const series: Array<{ day: string; runs: number; failed: number; costUsd: number }> = []
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = wibDateString(new Date(now.getTime() - offset * DAY_MS))
    const row = byDay.get(day)
    series.push({ day, runs: row?.runs ?? 0, failed: row?.failed ?? 0, costUsd: Number(row?.cost ?? 0) })
  }
  const to = new Date(now.getTime() + DAY_MS)
  return {
    days: span,
    series,
    byKind: (await usageByKind(sql, from, to)).map((row) => ({ kind: USAGE_KIND_LABEL[row.kind] ?? row.kind, runs: row.runs, costUsd: row.costUsd })),
    byCustomer: (await usageByTenant(sql, from, to)).map((row) => ({ customer: row.name, runs: row.runs, costUsd: row.costUsd })),
  }
}

export async function requests(sql: Database) {
  return (await listOpenLeads(sql, 50)).map((lead) => ({
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    status: lead.status,
    createdAt: lead.createdAt.toISOString(),
  }))
}

export async function health(sql: Database, live: Live, now = new Date()) {
  await sql`select 1`
  const sessions = live.whatsapp()
  const names = sessions.length
    ? await sql<Array<{ id: string; name: string }>>`select id, name from tenants where id in ${sql(sessions.map((item) => item.tenantId))}`
    : []
  const nameOf = new Map(names.map((row) => [row.id, row.name]))
  const feature = (name: 'chat' | 'summary' | 'push') => live.features?.recent(name, 3_600_000) ?? { failures: 0, successes: 0 }
  return {
    at: now.toISOString(),
    database: 'ok' as const,
    agent: await live.hermesHealthy(),
    system: live.systemConnection(),
    whatsapp: sessions.map((item) => ({ customer: nameOf.get(item.tenantId) ?? 'tidak dikenal', connection: item.connection })),
    lastHour: { chat: feature('chat'), summary: feature('summary'), push: feature('push') },
    uptimeSeconds: Math.round(process.uptime()),
  }
}

/** Only these keys of an audit row's detail are shown, and only as numbers, booleans or short codes: counts and ids. */
const AUDIT_DETAIL_KEYS = ['leadId', 'tenantId', 'messages', 'months', 'plan', 'sent', 'result', 'fromLead', 'count', 'telegramId']

export async function audit(sql: Database, limit = 50) {
  const rows = await sql<
    Array<{ created_at: Date; actor: string | null; action: string; tenant: string | null; detail: Record<string, unknown> }>
  >`
    select a.created_at, a.actor_telegram_id as actor, a.action, t.name as tenant, a.detail
    from admin_audit a left join tenants t on t.id = a.tenant_id
    order by a.id desc limit ${Math.min(200, Math.max(1, limit))}
  `
  return rows.map((row) => ({
    at: row.created_at.toISOString(),
    actor: row.actor === null ? null : Number(row.actor),
    action: row.action,
    customer: row.tenant,
    detail: Object.fromEntries(
      Object.entries(row.detail ?? {}).filter(
        ([key, value]) => AUDIT_DETAIL_KEYS.includes(key) && (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 40)),
      ),
    ),
  }))
}

/** Owners (from the environment, cannot be removed here) and the admins added later, with who added them. */
export async function admins(sql: Database, owners: ReadonlySet<number>) {
  const rows = await sql<Array<{ telegram_id: string; added_by: string | null; added_at: Date }>>`
    select telegram_id, added_by, added_at from admins order by added_at
  `
  return [
    ...[...owners].map((id) => ({ telegramId: id, owner: true, addedBy: null as number | null, addedAt: null as string | null })),
    ...rows
      .filter((row) => !owners.has(Number(row.telegram_id)))
      .map((row) => ({ telegramId: Number(row.telegram_id), owner: false, addedBy: row.added_by === null ? null : Number(row.added_by), addedAt: row.added_at.toISOString() })),
  ]
}

/** Every plan, trial included, for the admin's exact correction of a customer's plan. */
export async function allPlans(sql: Database) {
  return sql<Array<{ code: string; name: string }>>`select code, name from plans order by group_limit, code`
}
