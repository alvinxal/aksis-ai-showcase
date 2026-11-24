import type { TransactionSql } from 'postgres'
import type { Database } from './db.js'

/** Largest group limit of any plan; applies before a plan exists (during onboarding). */
export const MAX_GROUP_LIMIT = 5

export const TRIAL_DAYS = 14
export const GRACE_DAYS = 3
/** A repeated identical grant by the same admin within this many seconds is ignored. */
const REPEAT_GRANT_SECONDS = 60
export const REMINDER_DAYS = 3

const DAY_MS = 86_400_000

export type SubscriptionStatus = 'pending' | 'trial' | 'active' | 'grace' | 'expired'

export type Subscription = {
  tenantId: string
  planCode: string
  planName: string
  groupLimit: number
  startedAt: Date
  endsAt: Date
}

export type Plan = { code: string; name: string; groupLimit: number; priceIdr: number }

export function subscriptionStatus(
  subscription: Pick<Subscription, 'planCode' | 'endsAt'> | null,
  now: Date,
): SubscriptionStatus {
  if (!subscription) return 'pending'
  const ends = subscription.endsAt.getTime()
  if (now.getTime() < ends) return subscription.planCode === 'trial' ? 'trial' : 'active'
  if (now.getTime() < ends + GRACE_DAYS * DAY_MS) return 'grace'
  return 'expired'
}

/** Whether the AI may work for a tenant in this state. */
export function isEntitled(status: SubscriptionStatus): boolean {
  return status === 'trial' || status === 'active' || status === 'grace'
}

export function daysLeft(subscription: Pick<Subscription, 'endsAt'>, now: Date): number {
  return Math.ceil((subscription.endsAt.getTime() - now.getTime()) / DAY_MS)
}

type SubscriptionRow = {
  tenant_id: string
  plan_code: string
  plan_name: string
  group_limit: number
  started_at: Date
  ends_at: Date
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    tenantId: row.tenant_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    groupLimit: row.group_limit,
    startedAt: row.started_at,
    endsAt: row.ends_at,
  }
}

export async function getSubscription(sql: Database, tenantId: string): Promise<Subscription | null> {
  const [row] = await sql<SubscriptionRow[]>`
    select s.tenant_id, s.plan_code, p.name as plan_name, p.group_limit, s.started_at, s.ends_at
    from subscriptions s join plans p on p.code = s.plan_code
    where s.tenant_id = ${tenantId}
  `
  return row ? toSubscription(row) : null
}

/** Group limit of the tenant's plan; before a plan exists (onboarding) the largest limit applies. */
export async function groupLimitFor(sql: Database, tenantId: string): Promise<number> {
  const subscription = await getSubscription(sql, tenantId)
  return subscription?.groupLimit ?? MAX_GROUP_LIMIT
}

export async function listSellablePlans(sql: Database): Promise<Plan[]> {
  const rows = await sql<Array<{ code: string; name: string; group_limit: number; price_idr: number }>>`
    select code, name, group_limit, price_idr from plans where sellable order by group_limit, code
  `
  return rows.map((row) => ({ code: row.code, name: row.name, groupLimit: row.group_limit, priceIdr: row.price_idr }))
}

/** Whether the tenant has any plan (trial included). */
export async function hasSubscription(sql: Database, tenantId: string): Promise<boolean> {
  const rows = await sql<Array<{ tenant_id: string }>>`select tenant_id from subscriptions where tenant_id = ${tenantId}`
  return rows.length > 0
}

/** Starts the 14-day trial once, when onboarding finishes. A tenant that has a subscription keeps it. */
export async function startTrial(sql: Database, tenantId: string, now = new Date()): Promise<boolean> {
  const rows = await sql<Array<{ tenant_id: string }>>`
    insert into subscriptions (tenant_id, plan_code, started_at, ends_at)
    values (${tenantId}, 'trial', ${now}, ${new Date(now.getTime() + TRIAL_DAYS * DAY_MS)})
    on conflict (tenant_id) do nothing
    returning tenant_id
  `
  return rows.length > 0
}

/**
 * Activates or extends a paid plan. A live paid plan is extended from its end date so paying
 * early costs nothing; an expired plan or a trial restarts from now.
 */
export async function grantSubscription(
  sql: Database,
  tenantId: string,
  planCode: string,
  months: number,
  actorTelegramId: number,
  now = new Date(),
): Promise<Subscription | null> {
  if (!Number.isInteger(months) || months < 1 || months > 24) return null
  return sql.begin(async (tx) => {
    const [plan] = await tx<Array<{ code: string }>>`select code from plans where code = ${planCode} and sellable`
    if (!plan) return null
    const [current] = await tx<Array<{ plan_code: string; ends_at: Date; repeat: boolean }>>`
      select plan_code, ends_at,
        (updated_by_telegram_id = ${actorTelegramId} and plan_code = ${planCode}
          and updated_at > now() - make_interval(secs => ${REPEAT_GRANT_SECONDS})) as repeat
      from subscriptions where tenant_id = ${tenantId} for update
    `
    // The same admin confirming the same grant again within moments is a double tap, not a second purchase.
    if (current?.repeat) return readSubscription(tx, tenantId)
    const base =
      current && current.plan_code !== 'trial' && current.ends_at.getTime() > now.getTime() ? current.ends_at : now
    const endsAt = addMonths(base, months)
    await tx`
      insert into subscriptions (tenant_id, plan_code, started_at, ends_at, updated_by_telegram_id, updated_at)
      values (${tenantId}, ${planCode}, ${now}, ${endsAt}, ${actorTelegramId}, now())
      on conflict (tenant_id) do update
        set plan_code = excluded.plan_code, ends_at = excluded.ends_at,
            started_at = case when subscriptions.plan_code = 'trial' or subscriptions.ends_at <= ${now}
                              then excluded.started_at else subscriptions.started_at end,
            updated_by_telegram_id = excluded.updated_by_telegram_id, updated_at = now()
    `
    // A grant from the admin resolves the customer's latest manual renewal request, including when
    // the admin agreed a different package with the customer over WhatsApp.
    await tx`
      update payment_requests set status = 'confirmed', reviewed_at = now()
      where tenant_id = ${tenantId} and status = 'pending'
    `
    return readSubscription(tx, tenantId)
  })
}

/**
 * Sets the plan and the end date exactly (a correction by an admin: shorter, earlier, a trial, ended today).
 * Nothing is added to the old end date, and the customer is not told. Null when the plan does not exist.
 */
export async function setSubscription(
  sql: Database,
  tenantId: string,
  planCode: string,
  endsAt: Date,
  actorTelegramId: number,
  now = new Date(),
): Promise<Subscription | null> {
  return sql.begin(async (tx) => {
    const [plan] = await tx<Array<{ code: string }>>`select code from plans where code = ${planCode}`
    if (!plan) return null
    await tx`
      insert into subscriptions (tenant_id, plan_code, started_at, ends_at, updated_by_telegram_id, updated_at)
      values (${tenantId}, ${planCode}, ${now}, ${endsAt}, ${actorTelegramId}, now())
      on conflict (tenant_id) do update
        set plan_code = excluded.plan_code, ends_at = excluded.ends_at,
            started_at = case when subscriptions.plan_code = excluded.plan_code then subscriptions.started_at else excluded.started_at end,
            updated_by_telegram_id = excluded.updated_by_telegram_id, updated_at = now()
    `
    return readSubscription(tx, tenantId)
  })
}

async function readSubscription(tx: Database | TransactionSql<Record<string, never>>, tenantId: string): Promise<Subscription | null> {
  const [row] = await tx<SubscriptionRow[]>`
    select s.tenant_id, s.plan_code, p.name as plan_name, p.group_limit, s.started_at, s.ends_at
    from subscriptions s join plans p on p.code = s.plan_code where s.tenant_id = ${tenantId}
  `
  return row ? toSubscription(row) : null
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime())
  const day = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}

export type BillingRow = {
  tenantId: string
  name: string
  planName: string | null
  status: SubscriptionStatus
  endsAt: Date | null
}

export async function billingOverview(sql: Database, now = new Date()): Promise<BillingRow[]> {
  const rows = await sql<
    Array<{ id: string; name: string; plan_code: string | null; plan_name: string | null; ends_at: Date | null }>
  >`
    select t.id, t.name, s.plan_code, p.name as plan_name, s.ends_at
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plans p on p.code = s.plan_code
    where t.status in ('onboarding', 'active')
    order by s.ends_at nulls first, t.created_at
  `
  return rows.map((row) => ({
    tenantId: row.id,
    name: row.name,
    planName: row.plan_name,
    status: subscriptionStatus(row.plan_code && row.ends_at ? { planCode: row.plan_code, endsAt: row.ends_at } : null, now),
    endsAt: row.ends_at,
  }))
}

/** Active-plan revenue estimate for the month: sum of prices of currently paying tenants. */
export async function monthlyRecurringIdr(sql: Database, now = new Date()): Promise<number> {
  const [row] = await sql<Array<{ total: string | null }>>`
    select sum(p.price_idr) as total
    from subscriptions s join plans p on p.code = s.plan_code
    where s.plan_code <> 'trial' and s.ends_at > ${now}
  `
  return Number(row?.total ?? 0)
}

export type BillingNotice = { tenantId: string; tenantName: string; kind: 'remind' | 'grace' | 'expired'; endsAt: Date }

const MESSAGES: Record<BillingNotice['kind'], (endsAt: Date, now: Date) => string> = {
  remind: (endsAt, now) =>
    `Langganan Aksis AI Anda berakhir ${Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS))} hari lagi (${formatDate(endsAt)}). Hubungi admin untuk memperpanjang agar Aksis terus bekerja.`,
  grace: (endsAt) =>
    `Langganan Aksis AI Anda sudah berakhir pada ${formatDate(endsAt)}. Aksis tetap bekerja selama ${GRACE_DAYS} hari masa tenggang. Hubungi admin untuk memperpanjang.`,
  expired: () =>
    'Masa tenggang langganan Aksis AI sudah habis, jadi Aksis berhenti membaca dan membalas pesan. Data Anda tetap tersimpan. Hubungi admin untuk mengaktifkan lagi.',
}

/**
 * Queues the reminder, grace and expiry notices that are due. Each notice is recorded per
 * tenant, kind and end date, so running the sweep again, or after a restart, sends nothing twice.
 */
export async function sweepBilling(sql: Database, now = new Date()): Promise<BillingNotice[]> {
  const rows = await sql<Array<{ id: string; name: string; plan_code: string; ends_at: Date }>>`
    select t.id, t.name, s.plan_code, s.ends_at
    from subscriptions s join tenants t on t.id = s.tenant_id
    where t.status = 'active'
  `
  const sent: BillingNotice[] = []
  for (const row of rows) {
    const status = subscriptionStatus({ planCode: row.plan_code, endsAt: row.ends_at }, now)
    const untilEnd = row.ends_at.getTime() - now.getTime()
    const kind: BillingNotice['kind'] | null =
      status === 'expired'
        ? 'expired'
        : status === 'grace'
          ? 'grace'
          : untilEnd <= REMINDER_DAYS * DAY_MS
            ? 'remind'
            : null
    if (!kind) continue
    const inserted = await sql.begin(async (tx) => {
      const marked = await tx<Array<{ kind: string }>>`
        insert into subscription_notices (tenant_id, kind, ends_at)
        values (${row.id}, ${kind}, ${row.ends_at})
        on conflict do nothing
        returning kind
      `
      if (marked.length === 0) return false
      await tx`
        insert into outbound_messages (tenant_id, channel, text_content)
        values (${row.id}, 'broadcast', ${MESSAGES[kind](row.ends_at, now)})
      `
      return true
    })
    if (inserted) sent.push({ tenantId: row.id, tenantName: row.name, kind, endsAt: row.ends_at })
  }
  return sent
}

export function formatDate(date: Date): string {
  const wib = new Date(date.getTime() + 7 * 3_600_000)
  return wib.toISOString().slice(0, 10)
}
