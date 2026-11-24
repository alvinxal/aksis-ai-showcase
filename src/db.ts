import postgres, { type Sql } from 'postgres'

export type Database = Sql<Record<string, never>>

/**
 * Write jsonb with `sql.json(value as JsonValue)`. `${JSON.stringify(value)}::jsonb` makes postgres.js
 * store the text as a JSON *string*, so `->>` on it finds nothing.
 */
export type JsonValue = postgres.JSONValue

export function createDatabase(databaseUrl: string): Database {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  })
}

export async function checkDatabase(sql: Database): Promise<void> {
  await sql`select 1`
}

export type StoredWhatsAppMessage = {
  tenantId: string
  projectId: string | null
  whatsappMessageId: string
  chatJid: string
  senderJid: string | null
  fromMe: boolean
  isSelfChat: boolean
  isAgentGenerated: boolean
  sentAt: Date
  messageType: string
  textContent: string | null
  rawPayload: Record<string, unknown>
}

export async function saveWhatsAppMessage(
  sql: Database,
  message: StoredWhatsAppMessage,
): Promise<void> {
  await sql`
    insert into whatsapp_messages (
      tenant_id,
      project_id,
      whatsapp_message_id,
      chat_jid,
      sender_jid,
      from_me,
      is_self_chat,
      is_agent_generated,
      sent_at,
      message_type,
      text_content,
      raw_payload
    ) values (
      ${message.tenantId},
      ${message.projectId},
      ${message.whatsappMessageId},
      ${message.chatJid},
      ${message.senderJid},
      ${message.fromMe},
      ${message.isSelfChat},
      ${message.isAgentGenerated},
      ${message.sentAt},
      ${message.messageType},
      ${message.textContent},
      ${sql.json(message.rawPayload as JsonValue)}
    )
    on conflict (tenant_id, chat_jid, whatsapp_message_id) do nothing
  `
}
