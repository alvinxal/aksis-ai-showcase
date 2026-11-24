import type { Database } from './db.js'

export type OutboundMessage = {
  id: string
  tenantId: string
  text: string
  channel: string
  attempts: number
}

export async function claimOutboundMessage(sql: Database): Promise<OutboundMessage | null> {
  return sql.begin(async (transaction) => {
    const rows = await transaction<Array<{ id: string; tenant_id: string; text_content: string; channel: string; attempts: number }>>`
      select id, tenant_id, text_content, channel, attempts
      from outbound_messages
      where status = 'pending' and next_attempt_at <= now()
      order by created_at
      limit 1
      for update skip locked
    `
    const row = rows[0]
    if (!row) return null
    await transaction`
      update outbound_messages
      set status = 'sending', attempts = attempts + 1
      where id = ${row.id}
    `
    return { id: row.id, tenantId: row.tenant_id, text: row.text_content, channel: row.channel, attempts: row.attempts + 1 }
  })
}

export async function markOutboundSent(sql: Database, id: string): Promise<void> {
  await sql`
    update outbound_messages
    set status = 'sent', sent_at = now(), last_error = null
    where id = ${id} and status = 'sending'
  `
}

export async function retryOutboundMessage(
  sql: Database,
  message: OutboundMessage,
  error: string,
): Promise<void> {
  const exhausted = message.attempts >= 8
  const delaySeconds = Math.min(300, 2 ** Math.min(message.attempts, 8))
  await sql`
    update outbound_messages
    set status = ${exhausted ? 'failed' : 'pending'},
        next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
        last_error = ${error.slice(0, 2_000)}
    where id = ${message.id} and status = 'sending'
  `
}

export async function recoverSendingOutbox(sql: Database): Promise<void> {
  await sql`
    update outbound_messages
    set status = 'pending', next_attempt_at = now(), last_error = 'delivery worker restarted'
    where status = 'sending'
  `
}
