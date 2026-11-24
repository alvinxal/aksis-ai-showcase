import { createHash, randomUUID } from 'node:crypto'
import type { PendingQuery, Row } from 'postgres'
import { GRACE_DAYS } from './billing.js'
import type { Database, JsonValue } from './db.js'

const eventTypes = new Set([
  'DECISION_DETECTED',
  'REVISION_REQUESTED',
  'TASK_ASSIGNED',
  'DEADLINE_DETECTED',
  'DECISION_CONFLICT',
  'FOLLOW_UP_REQUIRED',
  'PAYMENT_DUE',
  'PAYMENT_RECEIVED',
  'INVOICE_SENT',
  'BUDGET_CHANGE',
])

export type AnalysisBatch = {
  runId: string
  tenantId: string
  projectId: string
  kind: 'self_chat' | 'group' | 'contact'
  model: string
  messages: Array<{
    id: string
    sentAt: string
    text: string
    fromMe: boolean
  }>
}

export type CompletedEvent = {
  eventType: string
  title: string
  details: Record<string, unknown>
  confidence: number
  occurredAt: string
  /** When the thing is due (deadline, payment, follow-up); null when no date is stated. */
  dueAt: string | null
  sourceMessageIds: string[]
  /** Only for a chat without a fixed project: the project the AI says the event belongs to; null when unsure. */
  projectId?: string | null
}

export type AnalysisCompletion = {
  reply: string | null
  events: CompletedEvent[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    estimatedCostUsd?: number
  }
}

/**
 * The AI gate. A tenant may use AI only while it is active, not usage-paused, and its
 * subscription ended less than GRACE_DAYS ago. Every AI path sits behind this one fragment:
 * message extraction (`claimAnalysisBatch`) and, later, answers to questions.
 * `tenantId` is any SQL expression that yields a tenant id, e.g. sql`m.tenant_id`.
 */
export function aiAllowed(sql: Database, tenantId: PendingQuery<Row[]>): PendingQuery<Row[]> {
  return sql`exists (
    select 1 from tenants t
    where t.id = ${tenantId} and t.status = 'active' and not t.usage_paused
      and exists (
        select 1 from subscriptions s
        where s.tenant_id = t.id and s.ends_at + ${GRACE_DAYS} * interval '1 day' > now()
      )
  )`
}

export async function tenantMayUseAi(sql: Database, tenantId: string): Promise<boolean> {
  const [row] = await sql<Array<{ allowed: boolean }>>`
    select ${aiAllowed(sql, sql`${tenantId}::uuid`)} as allowed
  `
  return row?.allowed === true
}

/** Key that makes the same event, extracted from two batches, one row. Dates compare by day. */
export function dedupKey(event: Pick<CompletedEvent, 'eventType' | 'title' | 'dueAt'>): string {
  const title = event.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const due = event.dueAt ? event.dueAt.slice(0, 10) : ''
  return createHash('sha256').update(`${event.eventType}|${title}|${due}`).digest('hex').slice(0, 32)
}

type Claimable = { tenant_id: string; project_id: string; is_self_chat: boolean; chat_jid: string }

export function kindOf(message: Pick<Claimable, 'is_self_chat' | 'chat_jid'>): AnalysisBatch['kind'] {
  return message.is_self_chat ? 'self_chat' : message.chat_jid.endsWith('@g.us') ? 'group' : 'contact'
}

export type RoutingProject = { id: string; name: string; groups: string[] }

/**
 * The projects the AI may route events to, when the batch is a personal chat without a fixed project (stored under
 * the default project); null for every other batch. Only projects that are actually watched are offered.
 */
export async function routingProjects(
  sql: Database,
  batch: Pick<AnalysisBatch, 'kind' | 'tenantId' | 'projectId'>,
): Promise<RoutingProject[] | null> {
  if (batch.kind !== 'contact') return null
  const [held] = await sql<Array<{ name: string }>>`select name from projects where id = ${batch.projectId} and tenant_id = ${batch.tenantId}`
  if (held?.name !== 'Umum') return null
  const rows = await sql<Array<{ id: string; name: string; groups: string[] }>>`
    select p.id, p.name, coalesce((
      select array_agg(g.subject order by g.subject) from whatsapp_groups g
      where g.tenant_id = p.tenant_id and g.project_id = p.id and g.selected
    ), '{}') as groups
    from projects p
    where p.tenant_id = ${batch.tenantId} and p.status = 'active' and p.name <> 'Umum'
      and (
        exists (select 1 from whatsapp_groups g where g.tenant_id = p.tenant_id and g.project_id = p.id and g.selected)
        or exists (select 1 from whatsapp_contacts c where c.tenant_id = p.tenant_id and c.project_id = p.id and c.selected)
      )
    order by p.name
    limit 30
  `
  return rows
}

/**
 * The messages that go into one batch: those of the first message's tenant, project and kind. A personal chat is
 * also one person, so two contacts are never mixed (the prompt speaks of "the other person").
 */
export function chooseBatch<T extends Claimable>(messages: T[]): { kind: AnalysisBatch['kind']; messages: T[] } | null {
  const first = messages[0]
  if (!first) return null
  const kind = kindOf(first)
  return {
    kind,
    messages: messages.filter(
      (message) =>
        message.tenant_id === first.tenant_id &&
        message.project_id === first.project_id &&
        kindOf(message) === kind &&
        (kind !== 'contact' || message.chat_jid === first.chat_jid),
    ),
  }
}

export async function claimAnalysisBatch(
  sql: Database,
  model: string,
  limit = 50,
): Promise<AnalysisBatch | null> {
  const messages = await sql<
    Array<{
      id: string
      tenant_id: string
      project_id: string
      sent_at: Date
      text_content: string
      from_me: boolean
      is_self_chat: boolean
      chat_jid: string
    }>
  >`
    select m.id, m.tenant_id, m.project_id, m.sent_at, m.text_content, m.from_me, m.is_self_chat, m.chat_jid
    from whatsapp_messages m
    where m.project_id is not null
      and m.text_content is not null
      and m.text_content <> ''
      and (m.is_self_chat or m.chat_jid like '%@g.us' or m.chat_jid like '%@s.whatsapp.net' or m.chat_jid like '%@lid')
      and not m.is_agent_generated
      and m.analysis_attempts < 3
      and ${aiAllowed(sql, sql`m.tenant_id`)}
      and not exists (
        select 1 from analysis_run_messages arm where arm.message_id = m.id
      )
    order by m.received_at
    limit ${limit}
  `

  const first = messages[0]
  if (!first) return null

  const chosen = chooseBatch(messages)!
  const kind = chosen.kind
  const sameProject = chosen.messages
  const runId = randomUUID()

  await sql.begin(async (transaction) => {
    await transaction`
      insert into analysis_runs (
        id, tenant_id, project_id, status, model, lease_expires_at, source_kind
      ) values (
        ${runId}, ${first.tenant_id}, ${first.project_id}, 'running', ${model},
        now() + interval '5 minutes', ${kind}
      )
    `
    for (const message of sameProject) {
      await transaction`
        insert into analysis_run_messages (analysis_run_id, message_id)
        values (${runId}, ${message.id})
      `
    }
    await transaction`
      update whatsapp_messages
      set analysis_attempts = analysis_attempts + 1,
          last_analysis_error = null
      where id in ${transaction(sameProject.map((message) => message.id))}
    `
  })

  return {
    runId,
    tenantId: first.tenant_id,
    projectId: first.project_id,
    kind,
    model,
    messages: sameProject.map((message) => ({
      id: message.id,
      sentAt: message.sent_at.toISOString(),
      text: message.text_content,
      fromMe: message.from_me,
    })),
  }
}

export function parseAnalysisCompletion(value: unknown): AnalysisCompletion {
  if (!value || typeof value !== 'object') throw new Error('completion must be an object')
  const raw = value as { reply?: unknown; events?: unknown; usage?: unknown }
  if (raw.reply !== null && typeof raw.reply !== 'string') {
    throw new Error('reply must be a string or null')
  }
  if (!Array.isArray(raw.events)) throw new Error('events must be an array')

  const events = raw.events.map((item): CompletedEvent => {
    if (!item || typeof item !== 'object') throw new Error('event must be an object')
    const event = item as Record<string, unknown>
    if (typeof event.eventType !== 'string' || !eventTypes.has(event.eventType)) {
      throw new Error('invalid eventType')
    }
    if (typeof event.title !== 'string' || !event.title.trim()) {
      throw new Error('event title is required')
    }
    if (!event.details || typeof event.details !== 'object' || Array.isArray(event.details)) {
      throw new Error('event details must be an object')
    }
    if (typeof event.confidence !== 'number' || event.confidence < 0 || event.confidence > 1) {
      throw new Error('confidence must be between 0 and 1')
    }
    if (typeof event.occurredAt !== 'string' || Number.isNaN(Date.parse(event.occurredAt))) {
      throw new Error('occurredAt must be an ISO timestamp')
    }
    const dueAt = event.dueAt ?? null
    if (dueAt !== null && (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt)))) {
      throw new Error('dueAt must be an ISO timestamp or null')
    }
    if (
      !Array.isArray(event.sourceMessageIds) ||
      event.sourceMessageIds.some((id) => typeof id !== 'string')
    ) {
      throw new Error('sourceMessageIds must be a string array')
    }

    return {
      eventType: event.eventType,
      title: event.title.slice(0, 500),
      details: event.details as Record<string, unknown>,
      confidence: event.confidence,
      occurredAt: event.occurredAt,
      dueAt,
      sourceMessageIds: event.sourceMessageIds as string[],
      ...(typeof event.projectId === 'string' ? { projectId: event.projectId } : {}),
    }
  })

  const usage = parseUsage(raw.usage)
  return {
    reply: typeof raw.reply === 'string' ? raw.reply.slice(0, 2_000) : null,
    events,
    ...(usage ? { usage } : {}),
  }
}

function parseUsage(value: unknown): AnalysisCompletion['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const usage: NonNullable<AnalysisCompletion['usage']> = {}
  if (typeof raw.inputTokens === 'number') usage.inputTokens = raw.inputTokens
  if (typeof raw.outputTokens === 'number') usage.outputTokens = raw.outputTokens
  if (typeof raw.estimatedCostUsd === 'number') usage.estimatedCostUsd = raw.estimatedCostUsd
  return usage
}

export async function completeAnalysisRun(
  sql: Database,
  runId: string,
  completion: AnalysisCompletion,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const runs = await transaction<
      Array<{ tenant_id: string; project_id: string; status: string; source_kind: string }>
    >`
      select tenant_id, project_id, status, source_kind
      from analysis_runs
      where id = ${runId}
      for update
    `
    const run = runs[0]
    if (!run || run.status !== 'running') throw new Error('analysis run is not active')

    const sourceRows = await transaction<Array<{ message_id: string }>>`
      select message_id from analysis_run_messages where analysis_run_id = ${runId}
    `
    const allowedSources = new Set(sourceRows.map((row) => row.message_id))

    // A personal chat without a fixed project is stored under the default project; the AI names the real one per event.
    const routable = new Set<string>()
    if (run.source_kind === 'contact') {
      const held = await transaction<Array<{ name: string }>>`select name from projects where id = ${run.project_id}`
      if (held[0]?.name === 'Umum') {
        const projects = await transaction<Array<{ id: string }>>`
          select id from projects where tenant_id = ${run.tenant_id} and status = 'active' and name <> 'Umum'
        `
        for (const project of projects) routable.add(project.id)
      }
    }

    for (const event of completion.events) {
      if (!event.sourceMessageIds.length || event.sourceMessageIds.some((id) => !allowedSources.has(id))) {
        throw new Error('event contains an invalid source message')
      }
      const key = dedupKey(event)
      // An unknown or missing project stays under the default project: "not clear yet", never a guess.
      const projectId = event.projectId && routable.has(event.projectId) ? event.projectId : run.project_id
      const inserted = await transaction<Array<{ id: string }>>`
        insert into project_events (
          id, tenant_id, project_id, analysis_run_id, event_type,
          title, details, confidence, occurred_at, due_at, dedup_key
        ) values (
          ${randomUUID()}, ${run.tenant_id}, ${projectId}, ${runId},
          ${event.eventType}::project_event_type, ${event.title},
          ${transaction.json(event.details as JsonValue)}, ${event.confidence}, ${event.occurredAt},
          ${event.dueAt}, ${key}
        )
        on conflict (tenant_id, project_id, event_type, dedup_key) where dedup_key is not null do nothing
        returning id
      `
      // Seen before: keep the first row and add this batch's messages as further sources.
      const eventId =
        inserted[0]?.id ??
        (
          await transaction<Array<{ id: string }>>`
            select id from project_events
            where tenant_id = ${run.tenant_id} and project_id = ${projectId}
              and event_type = ${event.eventType}::project_event_type and dedup_key = ${key}
          `
        )[0]!.id
      for (const messageId of event.sourceMessageIds) {
        await transaction`
          insert into project_event_sources (event_id, message_id)
          values (${eventId}, ${messageId})
          on conflict do nothing
        `
      }
    }

    await transaction`
      update analysis_runs
      set status = 'completed',
          input_tokens = ${completion.usage?.inputTokens ?? null},
          output_tokens = ${completion.usage?.outputTokens ?? null},
          estimated_cost_usd = ${completion.usage?.estimatedCostUsd ?? null},
          finished_at = now()
      where id = ${runId}
    `
    // Aksis never writes into groups: only self-chat runs may produce a reply.
    if (run.source_kind === 'self_chat' && completion.reply?.trim()) {
      await transaction`
        insert into outbound_messages (
          tenant_id, analysis_run_id, channel, text_content
        ) values (
          ${run.tenant_id}, ${runId}, 'whatsapp_self_chat', ${completion.reply.trim()}
        )
        on conflict (analysis_run_id, channel) do nothing
      `
    }
  })
}

/**
 * Marks a run failed and frees its messages for the next claim. `refundAttempt` gives the attempt back:
 * the claim already counted it, and a deploy or a short Hermes outage must not use up the three tries
 * a message has (after which it is never read).
 */
export async function failAnalysisRun(
  sql: Database,
  runId: string,
  error: string,
  options: { refundAttempt?: boolean } = {},
): Promise<void> {
  await sql.begin(async (transaction) => {
    const sourceRows = await transaction<Array<{ message_id: string }>>`
      select message_id from analysis_run_messages where analysis_run_id = ${runId}
    `
    if (options.refundAttempt && sourceRows.length) {
      await transaction`
        update whatsapp_messages set analysis_attempts = greatest(analysis_attempts - 1, 0)
        where id in ${transaction(sourceRows.map((row) => row.message_id))}
      `
    }
    if (sourceRows.length) {
      await transaction`
        update whatsapp_messages
        set last_analysis_error = ${error.slice(0, 2_000)}
        where id in ${transaction(sourceRows.map((row) => row.message_id))}
      `
    }
    await transaction`
      update analysis_runs
      set status = 'failed', error_text = ${error.slice(0, 2_000)}, finished_at = now()
      where id = ${runId} and status = 'running'
    `
    await transaction`
      delete from analysis_run_messages where analysis_run_id = ${runId}
    `
  })
}

export async function recoverStaleAnalysisRuns(sql: Database): Promise<number> {
  return sql.begin(async (transaction) => {
    const runs = await transaction<Array<{ id: string }>>`
      select id from analysis_runs
      where status = 'running'
        and coalesce(lease_expires_at, started_at + interval '5 minutes') < now()
      for update skip locked
    `
    for (const run of runs) {
      await transaction`
        update whatsapp_messages m
        set last_analysis_error = 'analysis lease expired'
        from analysis_run_messages arm
        where arm.analysis_run_id = ${run.id} and arm.message_id = m.id
      `
      await transaction`
        update analysis_runs
        set status = 'failed', error_text = 'analysis lease expired', finished_at = now()
        where id = ${run.id}
      `
      await transaction`delete from analysis_run_messages where analysis_run_id = ${run.id}`
    }
    return runs.length
  })
}
