import { GRACE_DAYS } from './billing.js'
import { deleteTenantData, recordAudit } from './admin.js'
import { purgeDashboardAuth } from './dashboard-auth.js'
import type { Database } from './db.js'
import { purgeOldLeads } from './leads.js'

/** Message text is kept this long. Older messages are deleted, or emptied when an event cites them. */
export const MESSAGE_RETENTION_DAYS = 90
/** A customer whose subscription (and grace) ended keeps their data this long, then it is deleted. */
export const EXPIRED_KEEP_DAYS = 30
/** The admins hear about a pending deletion this many days ahead. */
export const WARN_DAYS_AHEAD = 7

const DAY_MS = 86_400_000
const SWEEP_MS = 6 * 3_600_000

type Scope = { kind: 'old'; days: number } | { kind: 'chats'; tenantId: string; jids: string[] }

function scopeCondition(sql: Database, scope: Scope) {
  return scope.kind === 'old'
    ? sql`m.sent_at < now() - make_interval(days => ${scope.days})`
    : sql`m.tenant_id = ${scope.tenantId} and m.chat_jid in ${sql(scope.jids)}`
}

/**
 * Removes the stored text of the messages in scope. Event sources and analysis runs restrict message
 * deletion, so a message that an event cites is emptied (text, payload, sender) and its row stays;
 * every other message is deleted. Messages of a run that is still working are left for the next sweep.
 */
async function discardMessages(sql: Database, scope: Scope): Promise<{ deleted: number; emptied: number }> {
  if (scope.kind === 'chats' && scope.jids.length === 0) return { deleted: 0, emptied: 0 }
  const where = scopeCondition(sql, scope)
  return sql.begin(async (tx) => {
    await tx`
      delete from analysis_run_messages x
      using analysis_runs r
      where x.analysis_run_id = r.id and r.status <> 'running'
        and x.message_id in (select m.id from whatsapp_messages m where ${where})
    `
    const deleted = await tx`
      delete from whatsapp_messages m
      where ${where}
        and not exists (select 1 from project_event_sources s where s.message_id = m.id)
        and not exists (select 1 from analysis_run_messages x where x.message_id = m.id)
    `
    const emptied = await tx`
      update whatsapp_messages m
      set text_content = null, raw_payload = '{}'::jsonb, sender_jid = null
      where ${where}
        and (m.text_content is not null or m.sender_jid is not null or m.raw_payload <> '{}'::jsonb)
        and exists (select 1 from project_event_sources s where s.message_id = m.id)
    `
    return { deleted: deleted.count, emptied: emptied.count }
  })
}

/** Deletes (or empties) the messages of chats the customer stopped watching. */
export function discardChatMessages(sql: Database, tenantId: string, jids: string[]) {
  return discardMessages(sql, { kind: 'chats', tenantId, jids })
}

/** Daily-ish housekeeping of stored text: old messages and old sent answers. */
export async function purgeOldData(sql: Database, days = MESSAGE_RETENTION_DAYS) {
  const messages = await discardMessages(sql, { kind: 'old', days })
  const answers = await sql`
    delete from outbound_messages
    where status in ('sent', 'failed') and created_at < now() - make_interval(days => ${days})
  `
  const chat = await sql`delete from chat_messages where created_at < now() - make_interval(days => ${days})`
  const leads = await purgeOldLeads(sql)
  await purgeDashboardAuth(sql)
  return { ...messages, answers: answers.count, chat: chat.count, leads }
}

export type ExpiredTenant = { id: string; name: string; endsAt: Date }

/** Tenants whose subscription ended more than GRACE_DAYS + `afterDays` days ago. */
async function expiredTenants(sql: Database, afterDays: number, now: Date): Promise<ExpiredTenant[]> {
  const rows = await sql<Array<{ id: string; name: string; ends_at: Date }>>`
    select t.id, t.name, s.ends_at
    from tenants t join subscriptions s on s.tenant_id = t.id
    where s.ends_at + make_interval(days => ${GRACE_DAYS + afterDays}) < ${now}
    order by s.ends_at
  `
  return rows.map((row) => ({ id: row.id, name: row.name, endsAt: row.ends_at }))
}

export const tenantsToDelete = (sql: Database, now = new Date()) => expiredTenants(sql, EXPIRED_KEEP_DAYS, now)

/** Tenants that reach deletion within WARN_DAYS_AHEAD days and have not been announced for this subscription end. */
export async function tenantsToWarn(sql: Database, now = new Date()): Promise<ExpiredTenant[]> {
  const due = await expiredTenants(sql, EXPIRED_KEEP_DAYS - WARN_DAYS_AHEAD, now)
  const gone = new Set((await tenantsToDelete(sql, now)).map((tenant) => tenant.id))
  const result: ExpiredTenant[] = []
  for (const tenant of due) {
    if (gone.has(tenant.id)) continue
    const [seen] = await sql<Array<{ kind: string }>>`
      select kind from subscription_notices
      where tenant_id = ${tenant.id} and kind = 'deletion_warning' and ends_at = ${tenant.endsAt}
    `
    if (!seen) result.push(tenant)
  }
  return result
}

export type RetentionDeps = {
  database: Database
  /** Closes the customer's WhatsApp session and removes it from disk. */
  removeSession: (tenantId: string) => Promise<void>
  notify: (text: string) => Promise<void>
  /** Off by default: without it the sweep only warns the admins. */
  autoDelete: boolean
  now?: () => Date
}

/** Purges old stored text and handles customers whose subscription ended long ago. */
export class RetentionSweep {
  private timer: NodeJS.Timeout | null = null
  private firstTick: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: RetentionDeps) {}

  start(): void {
    if (this.timer) return
    this.firstTick = setTimeout(() => void this.tick(), 60_000)
    this.timer = setInterval(() => void this.tick(), SWEEP_MS)
  }

  stop(): void {
    if (this.firstTick) clearTimeout(this.firstTick)
    if (this.timer) clearInterval(this.timer)
    this.firstTick = null
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = this.deps.now?.() ?? new Date()
      const purged = await purgeOldData(this.deps.database)
      if (purged.deleted + purged.emptied + purged.answers + purged.chat + purged.leads > 0) {
        console.log(`Retention: ${purged.deleted} messages deleted, ${purged.emptied} emptied, ${purged.answers} answers, ${purged.chat} chat turns, ${purged.leads} old requests`)
      }
      await this.warn(now)
      if (this.deps.autoDelete) await this.deleteExpired(now)
    } catch (error) {
      console.error('Retention sweep failed', error instanceof Error ? error.message : error)
    } finally {
      this.running = false
    }
  }

  private async warn(now: Date): Promise<void> {
    for (const tenant of await tenantsToWarn(this.deps.database, now)) {
      await this.deps.database`
        insert into subscription_notices (tenant_id, kind, ends_at)
        values (${tenant.id}, 'deletion_warning', ${tenant.endsAt})
        on conflict do nothing
      `
      const days = Math.max(0, Math.ceil((tenant.endsAt.getTime() + (GRACE_DAYS + EXPIRED_KEEP_DAYS) * DAY_MS - now.getTime()) / DAY_MS))
      await this.deps.notify(
        this.deps.autoDelete
          ? `🗑️ Data ${tenant.name} akan dihapus otomatis sekitar ${days} hari lagi karena langganan sudah berakhir. Perpanjang paketnya untuk menahan penghapusan.`
          : `🗑️ Langganan ${tenant.name} sudah lama berakhir (data akan dihapus sekitar ${days} hari lagi bila penghapusan otomatis aktif).`,
      )
    }
  }

  private async deleteExpired(now: Date): Promise<void> {
    for (const tenant of await tenantsToDelete(this.deps.database, now)) {
      await this.deps.removeSession(tenant.id).catch((error: unknown) => {
        console.warn('Retention: could not remove a WhatsApp session', error instanceof Error ? error.message : error)
      })
      const result = await deleteTenantData(this.deps.database, tenant.id)
      if (!result) continue
      await recordAudit(this.deps.database, null, 'tenant_auto_deleted', null, { tenantId: tenant.id, messages: result.messages })
      await this.deps.notify(`🗑️ Data ${result.name} dihapus otomatis (${result.messages} pesan) karena langganan berakhir lebih dari ${EXPIRED_KEEP_DAYS} hari.`)
    }
  }
}
