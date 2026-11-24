import type { Database } from './db.js'
import { getSubscription, listSellablePlans, subscriptionStatus } from './billing.js'

export type ConnectionOverview = {
  enabled: boolean
  connection: string
  lastMessageAt: string | null
  lastError: string | null
}

export type BillingOverview = {
  subscription: { planCode: string; planName: string; groupLimit: number; endsAt: string; status: string } | null
  plans: Array<{ code: string; name: string; groupLimit: number; priceIdr: number }>
  latestRequest: { id: string; planCode: string; months: number; amountIdr: number; status: string; createdAt: string } | null
}

export type AgendaItem = {
  id: string
  projectId: string
  project: string
  type: string
  title: string
  dueAt: string
  amount: number | null
  status: 'open' | 'done' | 'snoozed'
  snoozedUntil: string | null
}

export type SearchItem = {
  id: string
  projectId: string
  project: string
  type: string
  title: string
  occurredAt: string
  dueAt: string | null
  amount: number | null
}

export type WeeklyProject = {
  id: string
  name: string
  decisions: string[]
  revisions: string[]
  tasks: string[]
  payments: string[]
}

export type ReminderPreferences = { reminderLeadDays: number; weeklyReportEnabled: boolean }

const amountOf = (value: string | null): number | null =>
  value !== null && /^\d{1,15}(\.\d+)?$/.test(value) ? Number(value) : null

export async function connectionOverview(
  sql: Database,
  tenantId: string,
  live: { connection: string; lastError: string | null } | null,
): Promise<ConnectionOverview> {
  const [row] = await sql<Array<{ whatsapp_enabled: boolean; last_message_at: Date | null }>>`
    select t.whatsapp_enabled, max(m.received_at) as last_message_at
    from tenants t left join whatsapp_messages m on m.tenant_id = t.id
    where t.id = ${tenantId}
    group by t.id
  `
  return {
    enabled: row?.whatsapp_enabled ?? false,
    connection: live?.connection ?? (row?.whatsapp_enabled ? 'connecting' : 'disabled'),
    lastMessageAt: row?.last_message_at?.toISOString() ?? null,
    lastError: live?.lastError ?? null,
  }
}

export async function billingOverviewForCustomer(sql: Database, tenantId: string): Promise<BillingOverview> {
  const [subscription, plans, requests] = await Promise.all([
    getSubscription(sql, tenantId),
    listSellablePlans(sql),
    sql<Array<{ id: string; plan_code: string; months: number; amount_idr: number; status: string; created_at: Date }>>`
      select id, plan_code, months, amount_idr, status, created_at
      from payment_requests where tenant_id = ${tenantId}
      order by created_at desc limit 1
    `,
  ])
  const latest = requests[0]
  return {
    subscription: subscription
      ? {
          planCode: subscription.planCode,
          planName: subscription.planName,
          groupLimit: subscription.groupLimit,
          endsAt: subscription.endsAt.toISOString(),
          status: subscriptionStatus(subscription, new Date()),
        }
      : null,
    plans,
    latestRequest: latest
      ? {
          id: latest.id,
          planCode: latest.plan_code,
          months: latest.months,
          amountIdr: latest.amount_idr,
          status: latest.status,
          createdAt: latest.created_at.toISOString(),
        }
      : null,
  }
}

export async function requestPayment(sql: Database, tenantId: string, planCode: string, months: number): Promise<boolean> {
  if (![1, 3, 12].includes(months)) return false
  return sql.begin(async (tx) => {
    const [plan] = await tx<Array<{ price_idr: number }>>`
      select price_idr from plans where code = ${planCode} and sellable for update
    `
    if (!plan) return false
    const [pending] = await tx<Array<{ id: string }>>`
      select id from payment_requests where tenant_id = ${tenantId} and status = 'pending' limit 1
    `
    if (pending) return false
    await tx`
      insert into payment_requests (tenant_id, plan_code, months, amount_idr)
      values (${tenantId}, ${planCode}, ${months}, ${plan.price_idr * months})
    `
    return true
  })
}

export async function listAgenda(sql: Database, tenantId: string): Promise<AgendaItem[]> {
  const rows = await sql<Array<{
    id: string; project_id: string; project: string; event_type: string; title: string; due_at: Date
    amount: string | null; status: AgendaItem['status'] | null; snoozed_until: string | null
  }>>`
    select e.id, e.project_id, p.name as project, e.event_type, e.title, e.due_at,
      e.details->>'amount' as amount, a.status, a.snoozed_until::text
    from project_events e
    join projects p on p.id = e.project_id and p.tenant_id = e.tenant_id
    left join project_event_actions a on a.tenant_id = e.tenant_id and a.event_id = e.id
    where e.tenant_id = ${tenantId} and e.due_at is not null and p.status = 'active'
      and e.due_at between now() - interval '90 days' and now() + interval '180 days'
    order by e.due_at, e.occurred_at desc
    limit 200
  `
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    project: row.project,
    type: row.event_type,
    title: row.title,
    dueAt: row.due_at.toISOString(),
    amount: amountOf(row.amount),
    status: row.status ?? 'open',
    snoozedUntil: row.snoozed_until,
  }))
}

export async function setAgendaAction(
  sql: Database,
  tenantId: string,
  eventId: string,
  status: AgendaItem['status'],
  snoozedUntil: string | null,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return false
  if (!['open', 'done', 'snoozed'].includes(status)) return false
  if ((status === 'snoozed') !== Boolean(snoozedUntil && /^\d{4}-\d{2}-\d{2}$/.test(snoozedUntil))) return false
  const rows = await sql<Array<{ event_id: string }>>`
    insert into project_event_actions (tenant_id, event_id, status, snoozed_until, updated_at)
    select ${tenantId}, e.id, ${status}, ${snoozedUntil}, now()
    from project_events e where e.id = ${eventId} and e.tenant_id = ${tenantId}
    on conflict (tenant_id, event_id) do update
      set status = excluded.status, snoozed_until = excluded.snoozed_until, updated_at = now()
    returning event_id
  `
  return rows.length === 1
}

export async function searchWorkspace(sql: Database, tenantId: string, rawQuery: string): Promise<SearchItem[]> {
  const query = rawQuery.trim().slice(0, 100)
  if (query.length < 2) return []
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`
  const rows = await sql<Array<{
    id: string; project_id: string; project: string; event_type: string; title: string
    occurred_at: Date; due_at: Date | null; amount: string | null
  }>>`
    select e.id, e.project_id, p.name as project, e.event_type, e.title, e.occurred_at, e.due_at,
      e.details->>'amount' as amount
    from project_events e join projects p on p.id = e.project_id and p.tenant_id = e.tenant_id
    where e.tenant_id = ${tenantId} and p.status = 'active'
      and (e.title ilike ${like} escape '\\' or p.name ilike ${like} escape '\\' or e.details->>'amount' ilike ${like} escape '\\')
    order by e.occurred_at desc limit 100
  `
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    project: row.project,
    type: row.event_type,
    title: row.title,
    occurredAt: row.occurred_at.toISOString(),
    dueAt: row.due_at?.toISOString() ?? null,
    amount: amountOf(row.amount),
  }))
}

export async function weeklyReport(sql: Database, tenantId: string): Promise<{ from: string; to: string; projects: WeeklyProject[] }> {
  const rows = await sql<Array<{ project_id: string; project: string; event_type: string; title: string }>>`
    select e.project_id, p.name as project, e.event_type, e.title
    from project_events e join projects p on p.id = e.project_id and p.tenant_id = e.tenant_id
    where e.tenant_id = ${tenantId} and p.status = 'active'
      and e.occurred_at >= date_trunc('week', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta'
    order by p.name, e.occurred_at desc limit 300
  `
  const projects = new Map<string, WeeklyProject>()
  for (const row of rows) {
    const report = projects.get(row.project_id) ?? { id: row.project_id, name: row.project, decisions: [], revisions: [], tasks: [], payments: [] }
    if (['DECISION_DETECTED', 'DECISION_CONFLICT'].includes(row.event_type)) report.decisions.push(row.title)
    else if (row.event_type === 'REVISION_REQUESTED') report.revisions.push(row.title)
    else if (['TASK_ASSIGNED', 'DEADLINE_DETECTED', 'FOLLOW_UP_REQUIRED'].includes(row.event_type)) report.tasks.push(row.title)
    else report.payments.push(row.title)
    projects.set(row.project_id, report)
  }
  const [range] = await sql<Array<{ from_day: string; to_day: string }>>`
    select to_char(date_trunc('week', now() at time zone 'Asia/Jakarta'), 'YYYY-MM-DD') as from_day,
      to_char(date_trunc('week', now() at time zone 'Asia/Jakarta') + interval '6 days', 'YYYY-MM-DD') as to_day
  `
  return { from: range?.from_day ?? '', to: range?.to_day ?? '', projects: [...projects.values()] }
}

export async function getReminderPreferences(sql: Database, tenantId: string): Promise<ReminderPreferences> {
  const [row] = await sql<Array<{ reminder_lead_days: number; weekly_report_enabled: boolean }>>`
    select reminder_lead_days, weekly_report_enabled from tenant_preferences where tenant_id = ${tenantId}
  `
  return { reminderLeadDays: row?.reminder_lead_days ?? 1, weeklyReportEnabled: row?.weekly_report_enabled ?? true }
}

export async function setReminderPreferences(
  sql: Database,
  tenantId: string,
  reminderLeadDays: number,
  weeklyReportEnabled: boolean,
): Promise<boolean> {
  if (![0, 1, 3, 7].includes(reminderLeadDays)) return false
  await sql`
    insert into tenant_preferences (tenant_id, reminder_lead_days, weekly_report_enabled, updated_at)
    values (${tenantId}, ${reminderLeadDays}, ${weeklyReportEnabled}, now())
    on conflict (tenant_id) do update set reminder_lead_days = excluded.reminder_lead_days,
      weekly_report_enabled = excluded.weekly_report_enabled, updated_at = now()
  `
  return true
}
