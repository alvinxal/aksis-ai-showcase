import { discardChatMessages } from './retention.js'
import { groupLimitFor, MAX_GROUP_LIMIT } from './billing.js'
import type { Database } from './db.js'
import type { WhatsAppGroup } from './whatsapp.js'

/** Largest plan limit. The limit that applies to a tenant comes from its plan (see billing.ts). */
export const GROUP_LIMIT = MAX_GROUP_LIMIT

export type StoredGroup = WhatsAppGroup & { selected: boolean }

export async function firstProjectId(sql: Database, tenantId: string): Promise<string | null> {
  const [row] = await sql<Array<{ id: string }>>`
    select id from projects where tenant_id = ${tenantId} order by created_at limit 1
  `
  return row?.id ?? null
}

export async function selectedGroupProject(
  sql: Database,
  tenantId: string,
  groupJid: string,
): Promise<string | null> {
  const [row] = await sql<Array<{ project_id: string | null }>>`
    select project_id from whatsapp_groups
    where tenant_id = ${tenantId} and group_jid = ${groupJid} and selected
  `
  return row?.project_id ?? null
}

export async function listStoredGroups(
  sql: Database,
  tenantId: string,
  live: WhatsAppGroup[],
): Promise<StoredGroup[]> {
  const rows = await sql<Array<{ group_jid: string }>>`
    select group_jid from whatsapp_groups where tenant_id = ${tenantId} and selected
  `
  const selected = new Set(rows.map((row) => row.group_jid))
  return live.map((group) => ({ ...group, selected: selected.has(group.jid) }))
}

export type SaveGroupsResult = { ok: true; count: number } | { ok: false; reason: string }

/**
 * Replaces the tenant's selected groups. Only groups that exist in `live` (the
 * tenant's own WhatsApp account) can be selected, so a forged form cannot add others.
 */
export async function saveSelectedGroups(
  sql: Database,
  tenantId: string,
  live: WhatsAppGroup[],
  requestedJids: string[],
): Promise<SaveGroupsResult> {
  const liveByJid = new Map(live.map((group) => [group.jid, group]))
  const chosen = [...new Set(requestedJids)].filter((jid) => liveByJid.has(jid))
  const limit = await groupLimitFor(sql, tenantId)
  if (chosen.length > limit) {
    return { ok: false, reason: `Maksimal ${limit} grup untuk paket Anda.` }
  }

  const dropped = (
    await sql<Array<{ group_jid: string }>>`
      select group_jid from whatsapp_groups where tenant_id = ${tenantId} and selected
    `
  )
    .map((row) => row.group_jid)
    .filter((jid) => !chosen.includes(jid))

  await sql.begin(async (tx) => {
    await tx`update whatsapp_groups set selected = false, updated_at = now() where tenant_id = ${tenantId}`
    for (const jid of chosen) {
      const group = liveByJid.get(jid)!
      const [existing] = await tx<Array<{ project_id: string | null }>>`
        select project_id from whatsapp_groups where tenant_id = ${tenantId} and group_jid = ${jid}
      `
      let projectId = existing?.project_id ?? null
      if (!projectId) {
        const name = group.subject.slice(0, 80)
        const [project] = await tx<Array<{ id: string }>>`
          insert into projects (tenant_id, name) values (${tenantId}, ${name})
          on conflict (tenant_id, name) do update set name = excluded.name
          returning id
        `
        projectId = project?.id ?? null
      }
      await tx`
        insert into whatsapp_groups (tenant_id, group_jid, subject, participants, selected, project_id)
        values (${tenantId}, ${jid}, ${group.subject}, ${group.participants}, true, ${projectId})
        on conflict (tenant_id, group_jid) do update
          set subject = excluded.subject, participants = excluded.participants,
              selected = true, project_id = excluded.project_id, updated_at = now()
      `
    }
  })
  // A group the customer stops watching is no longer read, so what was stored from it goes too.
  await discardChatMessages(sql, tenantId, dropped)
  await attachHistory(sql, tenantId)
  return { ok: true, count: chosen.length }
}

/**
 * History captured at pairing is held without a project. Messages of selected groups
 * join their project; held messages of every other group are deleted.
 */
export async function attachHistory(sql: Database, tenantId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update whatsapp_messages m
      set project_id = g.project_id
      from whatsapp_groups g
      where m.tenant_id = ${tenantId} and m.project_id is null
        and g.tenant_id = m.tenant_id and g.group_jid = m.chat_jid
        and g.selected and g.project_id is not null
    `
    await tx`
      delete from whatsapp_messages
      where tenant_id = ${tenantId} and project_id is null and chat_jid like '%@g.us'
    `
  })
}

/** Held history that was never claimed by a group or contact selection is removed after a day. */
export async function purgeStaleHistory(sql: Database): Promise<void> {
  await sql`
    delete from whatsapp_messages
    where project_id is null
      and (chat_jid like '%@g.us' or chat_jid like '%@s.whatsapp.net' or chat_jid like '%@lid')
      and received_at < now() - interval '24 hours'
  `
}
