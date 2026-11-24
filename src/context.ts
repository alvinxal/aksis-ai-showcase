import type { Database } from './db.js'

const GROUP_WINDOW_HOURS = 72
const GROUP_MESSAGE_LIMIT = 200
const MESSAGE_CHARS = 400
const CONTEXT_CHARS = 14_000

type GroupRow = {
  subject: string
  sent_at: Date
  from_me: boolean
  sender: string | null
  text_content: string
}

type EventRow = { event_type: string; title: string; occurred_at: Date }
type ChatRow = { sent_at: Date; is_agent_generated: boolean; text_content: string | null; message_type: string }

/** Marker for self-chat messages without text, so the model knows something unreadable was sent. */
function mediaMarker(type: string): string {
  const markers: Record<string, string> = {
    imageMessage: '[gambar]',
    videoMessage: '[video]',
    audioMessage: '[pesan suara]',
    stickerMessage: '[stiker]',
    documentMessage: '[dokumen]',
  }
  return markers[type] ?? '[lampiran]'
}

/**
 * Read-only context for a self-chat reply: what the owner's selected groups said
 * recently, the project events already detected, and the last self-chat turns.
 * Only rows of `tenantId` are ever read.
 */
export async function buildSelfChatContext(
  sql: Database,
  tenantId: string,
  excludeMessageIds: string[],
): Promise<string> {
  const groupRows = await sql<GroupRow[]>`
    select g.subject, m.sent_at, m.from_me, m.raw_payload->>'pushName' as sender, m.text_content
    from whatsapp_messages m
    join whatsapp_groups g
      on g.tenant_id = m.tenant_id and g.group_jid = m.chat_jid and g.selected
    where m.tenant_id = ${tenantId}
      and m.text_content is not null and m.text_content <> ''
      and m.sent_at > now() - (${GROUP_WINDOW_HOURS}::int * interval '1 hour')
    order by m.sent_at desc
    limit ${GROUP_MESSAGE_LIMIT}
  `
  const events = await sql<EventRow[]>`
    select event_type, title, occurred_at from project_events
    where tenant_id = ${tenantId}
    order by occurred_at desc limit 20
  `
  const chat = await sql<ChatRow[]>`
    select sent_at, is_agent_generated, text_content, message_type from whatsapp_messages
    where tenant_id = ${tenantId} and is_self_chat
      and message_type not in ('protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage')
      and id not in ${sql(excludeMessageIds.length > 0 ? excludeMessageIds : ['00000000-0000-0000-0000-000000000000'])}
    order by sent_at desc limit 8
  `

  const parts: string[] = []

  const bySubject = new Map<string, GroupRow[]>()
  for (const row of [...groupRows].reverse()) {
    const list = bySubject.get(row.subject) ?? []
    list.push(row)
    bySubject.set(row.subject, list)
  }
  if (bySubject.size === 0) {
    parts.push(
      `GROUP MESSAGES (last ${GROUP_WINDOW_HOURS} hours): none stored yet. Aksis only keeps messages from the moment the groups were connected, plus recent history WhatsApp provided at pairing.`,
    )
  } else {
    const blocks = [...bySubject].map(([subject, rows]) => {
      const lines = rows.map(
        (row) =>
          `[${formatStamp(row.sent_at)}] ${row.from_me ? 'Owner' : (row.sender ?? 'Member')}: ${row.text_content
            .replace(/\s+/g, ' ')
            .slice(0, MESSAGE_CHARS)}`,
      )
      return `Group "${subject}" (${rows.length} messages):\n${lines.join('\n')}`
    })
    parts.push(`GROUP MESSAGES (last ${GROUP_WINDOW_HOURS} hours, oldest first):\n${blocks.join('\n\n')}`)
  }

  if (events.length > 0) {
    parts.push(
      `DETECTED PROJECT EVENTS (newest first):\n${events
        .map((event) => `- [${formatStamp(event.occurred_at)}] ${event.event_type}: ${event.title}`)
        .join('\n')}`,
    )
  }

  if (chat.length > 0) {
    parts.push(
      `EARLIER SELF-CHAT (oldest first):\n${[...chat]
        .reverse()
        .map((row) => `[${formatStamp(row.sent_at)}] ${row.is_agent_generated ? 'Aksis' : 'Owner'}: ${row.text_content ? row.text_content.slice(0, MESSAGE_CHARS) : mediaMarker(row.message_type)}`)
        .join('\n')}`,
    )
  }

  const text = parts.join('\n\n')
  // Keep the newest part when the context is too long.
  return text.length > CONTEXT_CHARS ? `…${text.slice(-CONTEXT_CHARS)}` : text
}

function formatStamp(date: Date): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta', hour12: false }).slice(0, 16)
}
