import { createHmac, randomInt } from 'node:crypto'
import { hashToken, newToken } from './admin.js'
import type { Database } from './db.js'

export const CODE_TTL_MINUTES = 5
export const CODE_MAX_ATTEMPTS = 5
/** Codes a tenant may ask for inside CODE_WINDOW_MINUTES; stops WhatsApp being used to spam a customer. */
export const CODE_MAX_REQUESTS = 3
export const CODE_WINDOW_MINUTES = 15
export const APP_SESSION_DAYS = 30

export type AppSession = { tenantId: string; tenantName: string; contactName: string | null }

export type AuthService = {
  /** Always resolves the same way for the caller; `sent` only tells the server whether a code went out. */
  requestCode: (phone: string) => Promise<'sent' | 'ignored'>
  verify: (phone: string, code: string) => Promise<string | null>
  getSession: (sessionToken: string) => Promise<AppSession | null>
  endSession: (sessionToken: string) => Promise<void>
}

const codeHash = (secret: string, tenantId: string, code: string) =>
  createHmac('sha256', secret).update(`${tenantId}:${code}`).digest('hex')

/** Only an active customer whose linked WhatsApp number matches may log in. */
async function activeTenantByPhone(sql: Database, phone: string): Promise<string | null> {
  const [row] = await sql<Array<{ id: string }>>`
    select id from tenants
    where status = 'active'
      and split_part(split_part(whatsapp_jid, '@', 1), ':', 1) = ${phone}
    limit 1
  `
  return row?.id ?? null
}

export function createAuthService(
  sql: Database,
  secret: string,
  sendSelf: (tenantId: string, text: string) => Promise<void>,
): AuthService {
  return {
    async requestCode(phone) {
      const tenantId = await activeTenantByPhone(sql, phone)
      if (!tenantId) return 'ignored'
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const issued = await sql.begin(async (tx) => {
        // Serialise per customer so two taps cannot both pass the limit.
        await tx`select id from tenants where id = ${tenantId} for update`
        const [recent] = await tx<Array<{ n: number }>>`
          select count(*)::int as n from login_codes
          where tenant_id = ${tenantId} and created_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES})
        `
        if ((recent?.n ?? 0) >= CODE_MAX_REQUESTS) return false
        await tx`update login_codes set used_at = now() where tenant_id = ${tenantId} and used_at is null`
        await tx`
          insert into login_codes (tenant_id, code_hash, expires_at)
          values (${tenantId}, ${codeHash(secret, tenantId, code)}, now() + make_interval(mins => ${CODE_TTL_MINUTES}))
        `
        return true
      })
      if (!issued) return 'ignored'
      try {
        await sendSelf(tenantId, `Kode masuk Anda: ${code}. Berlaku ${CODE_TTL_MINUTES} menit. Jangan bagikan kode ini ke siapa pun.`)
      } catch {
        await sql`update login_codes set used_at = now() where tenant_id = ${tenantId} and used_at is null`
        return 'ignored'
      }
      return 'sent'
    },

    async verify(phone, code) {
      const tenantId = await activeTenantByPhone(sql, phone)
      if (!tenantId || !/^\d{6}$/.test(code)) return null
      const sessionToken = newToken()
      const ok = await sql.begin(async (tx) => {
        const [row] = await tx<Array<{ id: string; code_hash: string; attempts: number }>>`
          select id, code_hash, attempts from login_codes
          where tenant_id = ${tenantId} and used_at is null and expires_at > now()
          order by created_at desc limit 1
          for update
        `
        if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return false
        if (row.code_hash !== codeHash(secret, tenantId, code)) {
          await tx`update login_codes set attempts = attempts + 1 where id = ${row.id}`
          return false
        }
        // A code that logged someone in is gone, so logging in and out again never uses up the request limit.
        await tx`delete from login_codes where id = ${row.id}`
        await tx`
          insert into web_sessions (tenant_id, token_hash, expires_at, kind)
          values (${tenantId}, ${hashToken(sessionToken)}, now() + make_interval(days => ${APP_SESSION_DAYS}), 'app')
        `
        return true
      })
      return ok ? sessionToken : null
    },

    async getSession(sessionToken) {
      const [row] = await sql<Array<{ tenant_id: string; name: string; contact_name: string | null }>>`
        select t.id as tenant_id, t.name, t.contact_name
        from web_sessions s
        join tenants t on t.id = s.tenant_id
        where s.token_hash = ${hashToken(sessionToken)}
          and s.kind = 'app' and s.expires_at > now() and t.status = 'active'
      `
      return row ? { tenantId: row.tenant_id, tenantName: row.name, contactName: row.contact_name } : null
    },

    async endSession(sessionToken) {
      await sql`delete from web_sessions where token_hash = ${hashToken(sessionToken)} and kind = 'app'`
    },
  }
}
