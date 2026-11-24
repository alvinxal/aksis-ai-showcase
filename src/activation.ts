import { recordAudit } from './admin.js'
import { startTrial } from './billing.js'
import type { Database } from './db.js'

/** What the customer is told, in their own WhatsApp chat, once the account is active. */
export const accessInfoText = (publicBaseUrl: string): string =>
  `Akun Aksis Anda sudah aktif. Buka ${publicBaseUrl}/app di HP, lalu pasang ke layar utama. ` +
  'Masuk dengan nomor WhatsApp ini: kode masuk 6 digit akan dikirim ke chat ini.'

/**
 * Marks that the admins were asked to choose a plan for this customer. True only for the first call, so the
 * Telegram message is sent once however often the customer's page asks for its state.
 */
export async function markPlanRequested(sql: Database, tenantId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    update tenants set plan_requested_at = now()
    where id = ${tenantId} and plan_requested_at is null
      and not exists (select 1 from subscriptions s where s.tenant_id = tenants.id)
    returning id
  `
  return rows.length > 0
}

/**
 * Finishing onboarding activates the customer: the invitation an admin made is the approval. Only a
 * tenant that is still `onboarding` changes (a disabled one stays disabled), and the trial starts once.
 * Returns true when this call made the tenant active.
 */
export async function activateAfterOnboarding(sql: Database, tenantId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    update tenants set status = 'active', disabled_at = null
    where id = ${tenantId} and status = 'onboarding'
    returning id
  `
  if (rows.length === 0) return false
  await startTrial(sql, tenantId)
  await recordAudit(sql, null, 'tenant_auto_active', tenantId, {})
  return true
}
