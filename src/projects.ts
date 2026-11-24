import type { Database } from './db.js'

export type ItemType =
  | 'DECISION_DETECTED'
  | 'DECISION_CONFLICT'
  | 'REVISION_REQUESTED'
  | 'TASK_ASSIGNED'
  | 'DEADLINE_DETECTED'
  | 'FOLLOW_UP_REQUIRED'
  | 'PAYMENT_DUE'
  | 'PAYMENT_RECEIVED'
  | 'INVOICE_SENT'
  | 'BUDGET_CHANGE'

export type ProjectItem = {
  id: string
  type: ItemType
  title: string
  occurredAt: string
  dueAt: string | null
  /** Rupiah as written in the chat; null when the chat never stated one (nothing is ever computed). */
  amount: number | null
  /** How many WhatsApp messages the event was taken from. */
  sources: number
}

export type AttentionItem = ProjectItem & { urgent: boolean }

/** The AI's short status note for a project; null until one has been written. */
export type Note = { text: string; writtenAt: string } | null

export type ProjectSummary = {
  id: string
  name: string
  groups: string[]
  /** Names of the selected personal chats attached to the project. */
  contacts: string[]
  note: Note
  attention: number
  urgent: number
  counts: { decisions: number; revisions: number; tasks: number; payments: number }
  lastActivityAt: string | null
}

export type ProjectDetail = {
  id: string
  name: string
  groups: string[]
  contacts: string[]
  note: Note
  attention: AttentionItem[]
  decisions: ProjectItem[]
  revisions: ProjectItem[]
  tasks: ProjectItem[]
  payments: ProjectItem[]
}

const SECTION_LIMIT = 50

/**
 * What needs the owner's attention: something due within a week (or missed in the last month), an unresolved
 * conflict between decisions, or a follow-up nobody dated. A payment that a later "received" event with the
 * same written amount covers is left out. `e` is the project_events row.
 */
const attention = (sql: Database) => sql`(
  (e.due_at is not null
    and e.event_type in ('DEADLINE_DETECTED', 'PAYMENT_DUE', 'FOLLOW_UP_REQUIRED', 'TASK_ASSIGNED')
    and e.due_at between now() - interval '30 days' and now() + interval '7 days')
  or (e.event_type = 'DECISION_CONFLICT' and e.occurred_at > now() - interval '30 days')
  or (e.event_type = 'FOLLOW_UP_REQUIRED' and e.due_at is null and e.occurred_at > now() - interval '14 days')
) and not (
  e.event_type = 'PAYMENT_DUE'
  and e.details->>'amount' is not null
  and exists (
    select 1 from project_events r
    where r.tenant_id = e.tenant_id and r.project_id = e.project_id
      and r.event_type = 'PAYMENT_RECEIVED' and r.occurred_at >= e.occurred_at
      and r.details->>'amount' = e.details->>'amount'
  )
) and not exists (
  select 1 from project_event_actions a
  where a.tenant_id = e.tenant_id and a.event_id = e.id
    and (a.status = 'done' or (a.status = 'snoozed' and a.snoozed_until > (now() at time zone 'Asia/Jakarta')::date))
)`

const urgent = (sql: Database) => sql`(e.due_at is not null and e.due_at <= now() + interval '3 days')`

/** Only projects that have a selected WhatsApp group or contact are shown: the default "Umum" project is not one. */
const monitored = (sql: Database) => sql`(exists (
  select 1 from whatsapp_groups g
  where g.tenant_id = p.tenant_id and g.project_id = p.id and g.selected
) or exists (
  select 1 from whatsapp_contacts c
  where c.tenant_id = p.tenant_id and c.project_id = p.id and c.selected
))`

const groupsOf = (sql: Database) => sql`coalesce((
  select array_agg(g.subject order by g.subject) from whatsapp_groups g
  where g.tenant_id = p.tenant_id and g.project_id = p.id and g.selected
), '{}')`

const contactsOf = (sql: Database) => sql`coalesce((
  select array_agg(coalesce(c.display_name, 'Kontak') order by c.display_name) from whatsapp_contacts c
  where c.tenant_id = p.tenant_id and c.project_id = p.id and c.selected
), '{}')`

export type DueItem = { projectId: string; project: string; title: string; dueAt: Date; type: ItemType }

/**
 * What needs attention and is due by the end of tomorrow (Jakarta time) or already missed: the morning digest.
 * It uses the same attention rule as the project screens.
 */
export async function dueSoon(sql: Database, tenantId: string): Promise<DueItem[]> {
  const rows = await sql<Array<{ project_id: string; project: string; title: string; due_at: Date; event_type: ItemType }>>`
    select p.id as project_id, p.name as project, e.title, e.due_at, e.event_type
    from project_events e
    join projects p on p.id = e.project_id and p.tenant_id = e.tenant_id
    left join tenant_preferences pref on pref.tenant_id = e.tenant_id
    where e.tenant_id = ${tenantId} and p.status = 'active' and ${monitored(sql)}
      and e.due_at is not null and ${attention(sql)}
      and e.due_at < (date_trunc('day', now() at time zone 'Asia/Jakarta') + ((coalesce(pref.reminder_lead_days, 1) + 1) * interval '1 day')) at time zone 'Asia/Jakarta'
    order by e.due_at
    limit 50
  `
  return rows.map((row) => ({ projectId: row.project_id, project: row.project, title: row.title, dueAt: row.due_at, type: row.event_type }))
}

export async function listProjects(sql: Database, tenantId: string): Promise<ProjectSummary[]> {
  const rows = await sql<
    Array<{
      id: string
      name: string
      groups: string[]
      contacts: string[]
      attention: number
      urgent: number
      decisions: number
      revisions: number
      tasks: number
      payments: number
      last: Date | null
      note: string | null
      note_at: Date | null
    }>
  >`
    select p.id, p.name, ${groupsOf(sql)} as groups, ${contactsOf(sql)} as contacts, ps.text as note, ps.generated_at as note_at,
      count(e.id) filter (where ${attention(sql)})::int as attention,
      count(e.id) filter (where ${attention(sql)} and ${urgent(sql)})::int as urgent,
      count(e.id) filter (where e.event_type in ('DECISION_DETECTED', 'DECISION_CONFLICT'))::int as decisions,
      count(e.id) filter (where e.event_type = 'REVISION_REQUESTED')::int as revisions,
      count(e.id) filter (where e.event_type in ('TASK_ASSIGNED', 'DEADLINE_DETECTED', 'FOLLOW_UP_REQUIRED'))::int as tasks,
      count(e.id) filter (where e.event_type in ('PAYMENT_DUE', 'PAYMENT_RECEIVED', 'INVOICE_SENT', 'BUDGET_CHANGE'))::int as payments,
      max(e.occurred_at) as last
    from projects p
    left join project_events e on e.tenant_id = p.tenant_id and e.project_id = p.id
    left join project_summaries ps on ps.project_id = p.id and ps.tenant_id = p.tenant_id
    where p.tenant_id = ${tenantId} and p.status = 'active' and ${monitored(sql)}
    group by p.id, ps.project_id
    order by urgent desc, attention desc, last desc nulls last, p.name
  `
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    groups: row.groups,
    contacts: row.contacts,
    note: noteOf(row.note, row.note_at),
    attention: row.attention,
    urgent: row.urgent,
    counts: { decisions: row.decisions, revisions: row.revisions, tasks: row.tasks, payments: row.payments },
    lastActivityAt: row.last ? row.last.toISOString() : null,
  }))
}

function noteOf(text: string | null, at: Date | null): Note {
  return text && at ? { text, writtenAt: at.toISOString() } : null
}

function amountOf(value: string | null): number | null {
  return value !== null && /^\d{1,15}(\.\d+)?$/.test(value) ? Number(value) : null
}

export async function getProject(sql: Database, tenantId: string, projectId: string): Promise<ProjectDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null
  const [project] = await sql<Array<{ id: string; name: string; groups: string[]; contacts: string[]; note: string | null; note_at: Date | null }>>`
    select p.id, p.name, ${groupsOf(sql)} as groups, ${contactsOf(sql)} as contacts, ps.text as note, ps.generated_at as note_at
    from projects p
    left join project_summaries ps on ps.project_id = p.id and ps.tenant_id = p.tenant_id
    where p.tenant_id = ${tenantId} and p.id = ${projectId} and p.status = 'active' and ${monitored(sql)}
  `
  if (!project) return null

  const rows = await sql<
    Array<{
      id: string
      event_type: ItemType
      title: string
      occurred_at: Date
      due_at: Date | null
      amount: string | null
      sources: number
      attention: boolean
      urgent: boolean
    }>
  >`
    select e.id, e.event_type, e.title, e.occurred_at, e.due_at, e.details->>'amount' as amount,
      (select count(*)::int from project_event_sources s where s.event_id = e.id) as sources,
      (${attention(sql)}) as attention, (${urgent(sql)}) as urgent
    from project_events e
    where e.tenant_id = ${tenantId} and e.project_id = ${projectId}
    order by e.occurred_at desc
    limit 400
  `
  const items = rows.map((row) => ({
    item: {
      id: row.id,
      type: row.event_type,
      title: row.title,
      occurredAt: row.occurred_at.toISOString(),
      dueAt: row.due_at ? row.due_at.toISOString() : null,
      amount: amountOf(row.amount),
      sources: row.sources,
    } satisfies ProjectItem,
    attention: row.attention,
    urgent: row.urgent,
  }))
  const section = (types: ItemType[]) =>
    items.filter(({ item }) => types.includes(item.type)).slice(0, SECTION_LIMIT).map(({ item }) => item)

  return {
    id: project.id,
    name: project.name,
    groups: project.groups,
    contacts: project.contacts,
    note: noteOf(project.note, project.note_at),
    attention: items
      .filter((entry) => entry.attention)
      .map((entry) => ({ ...entry.item, urgent: entry.urgent }))
      .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.dueAt ?? a.occurredAt).localeCompare(b.dueAt ?? b.occurredAt)),
    decisions: section(['DECISION_DETECTED', 'DECISION_CONFLICT']),
    revisions: section(['REVISION_REQUESTED']),
    tasks: section(['TASK_ASSIGNED', 'DEADLINE_DETECTED', 'FOLLOW_UP_REQUIRED']),
    payments: section(['PAYMENT_DUE', 'PAYMENT_RECEIVED', 'INVOICE_SENT', 'BUDGET_CHANGE']),
  }
}
