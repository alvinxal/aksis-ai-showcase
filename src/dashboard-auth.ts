import { hashToken, newToken, recordAudit } from './admin.js'
import type { Database } from './db.js'

/** The login link made in the bot is good for this long, once. */
export const LOGIN_LINK_MINUTES = 5
export const DASHBOARD_SESSION_HOURS = 12

/** A one-time token for the admin who asked for it; only its hash is stored. */
export async function createLoginLink(sql: Database, telegramId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + LOGIN_LINK_MINUTES * 60_000)
  await sql`
    insert into dashboard_logins (token_hash, telegram_id, expires_at) values (${hashToken(token)}, ${telegramId}, ${expiresAt})
  `
  await recordAudit(sql, telegramId, 'dashboard_link', null, {})
  return { token, expiresAt }
}

/**
 * Spends the link (one `update ... returning`, so two requests cannot both use it) and opens a session, but only for
 * somebody who is still an admin. Null for an unknown, used, expired or no longer authorised link.
 */
export async function exchangeLoginLink(
  sql: Database,
  token: string,
  isAdmin: (telegramId: number) => boolean,
): Promise<{ sessionToken: string; telegramId: number; expiresAt: Date } | null> {
  const [link] = await sql<Array<{ telegram_id: string }>>`
    update dashboard_logins set used_at = now()
    where token_hash = ${hashToken(token)} and used_at is null and expires_at > now()
    returning telegram_id
  `
  if (!link) return null
  const telegramId = Number(link.telegram_id)
  if (!isAdmin(telegramId)) return null
  const sessionToken = newToken()
  const expiresAt = new Date(Date.now() + DASHBOARD_SESSION_HOURS * 3_600_000)
  await sql`
    insert into dashboard_sessions (token_hash, telegram_id, expires_at) values (${hashToken(sessionToken)}, ${telegramId}, ${expiresAt})
  `
  await recordAudit(sql, telegramId, 'dashboard_login', null, {})
  return { sessionToken, telegramId, expiresAt }
}

/** The admin behind a session cookie, or null when it is unknown, expired, or its owner is no longer an admin. */
export async function getDashboardSession(
  sql: Database,
  sessionToken: string,
  isAdmin: (telegramId: number) => boolean,
): Promise<{ telegramId: number } | null> {
  const [row] = await sql<Array<{ telegram_id: string }>>`
    select telegram_id from dashboard_sessions where token_hash = ${hashToken(sessionToken)} and expires_at > now()
  `
  if (!row) return null
  const telegramId = Number(row.telegram_id)
  return isAdmin(telegramId) ? { telegramId } : null
}

export async function endDashboardSession(sql: Database, sessionToken: string): Promise<void> {
  await sql`delete from dashboard_sessions where token_hash = ${hashToken(sessionToken)}`
}

export async function purgeDashboardAuth(sql: Database): Promise<number> {
  const logins = await sql`delete from dashboard_logins where expires_at < now() - interval '1 day'`
  const sessions = await sql`delete from dashboard_sessions where expires_at < now()`
  return logins.count + sessions.count
}
