import type { Context, Hono } from 'hono'
import { accessInfoText } from './activation.js'
import { createInvitation, createInvitationForTenant, deleteTenantData, findTenant, getTenantPhone, recordAudit, resetOnboarding, setTenantStatus } from './admin.js'
import { formatDate, getSubscription, grantSubscription, listSellablePlans, setSubscription, startTrial } from './billing.js'
import type { Database } from './db.js'
import { enqueueBroadcast, renameTenant, renewTenantInvitation, setLimit, setTenantNotes, setUsagePaused } from './ops.js'

/** The same choices as the bot's buttons, so the dashboard cannot set a value the bot would not offer. */
export const MONTH_CHOICES = [1, 3, 12]
export const DAILY_LIMITS = [0.25, 0.5, 1, 2]
export const MONTHLY_LIMITS = [5, 10, 20, 50]

export type CustomerHooks = {
  resumeWhatsApp?: (tenantId: string) => Promise<unknown>
  removeSession?: (tenantId: string) => Promise<unknown>
  reevaluateLimits?: () => Promise<void>
  sendAccessInfo?: (tenantId: string, text: string) => Promise<boolean>
}

export type CustomerRouteDependencies = {
  database: Database
  publicBaseUrl: string
  hooks: CustomerHooks
}

type Write = (handler: (context: Context, actor: number) => Promise<unknown>) => (context: Context) => Promise<Response>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bad = { error: 'invalid' }
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

const bodyOf = async (context: Context) => ((await context.req.json().catch(() => null)) ?? {}) as Record<string, unknown>

/**
 * The customer actions of the dashboard: the ones of the Telegram bot, with the same limits, side effects and audit
 * rows (ids and counts only). `write` already checked the session, the origin and the content type.
 */
export function registerCustomerWrites(app: Hono, write: Write, deps: CustomerRouteDependencies): void {
  const { database, hooks } = deps
  /** A handler for a customer that exists: null (404) otherwise. */
  const onTenant = (handler: (tenant: { id: string; name: string }, body: Record<string, unknown>, actor: number) => Promise<unknown>) =>
    write(async (context, actor) => {
      const id = context.req.param('id') ?? ''
      if (!UUID.test(id)) return null
      const tenant = await findTenant(database, id)
      if (tenant.kind !== 'found') return null
      return handler({ id: tenant.id, name: tenant.name }, await bodyOf(context), actor)
    })

  app.post(
    '/v1/dashboard/customers',
    write(async (context, actor) => {
      const body = await bodyOf(context)
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.replace(/\D/g, '') : null
      if (!name || (phone !== null && !/^\d{8,15}$/.test(phone))) return bad
      const invite = await createInvitation(database, name, actor, phone)
      await recordAudit(database, actor, 'invite_created', invite.tenantId, { name })
      return { name, phone, tenantId: invite.tenantId, link: `${deps.publicBaseUrl}/join/${invite.token}`, expiresAt: invite.expiresAt.toISOString() }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/rename',
    onTenant(async (tenant, body, actor) => {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      if (!name) return bad
      await renameTenant(database, tenant.id, name)
      await recordAudit(database, actor, 'tenant_renamed', tenant.id, { name })
      return { ok: true }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/notes',
    onTenant(async (tenant, body, actor) => {
      if (typeof body.notes !== 'string') return bad
      await setTenantNotes(database, tenant.id, body.notes.trim().slice(0, 500) || null)
      await recordAudit(database, actor, 'tenant_notes', tenant.id, {})
      return { ok: true }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/status',
    onTenant(async (tenant, body, actor) => {
      const status = body.status
      if (status !== 'active' && status !== 'disabled') return bad
      await setTenantStatus(database, tenant.id, status)
      await recordAudit(database, actor, `tenant_${status}`, tenant.id, { name: tenant.name })
      let accessSent: boolean | null = null
      if (status === 'active') {
        // As in the bot: the trial starts at the first activation, the stored WhatsApp session opens again and the
        // customer is told where the app is.
        await startTrial(database, tenant.id)
        await hooks.resumeWhatsApp?.(tenant.id)
        if (hooks.sendAccessInfo) {
          accessSent = await hooks.sendAccessInfo(tenant.id, accessInfoText(deps.publicBaseUrl)).catch(() => false)
          await recordAudit(database, actor, 'access_info', tenant.id, { sent: accessSent })
        }
      }
      return { ok: true, accessSent }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/pause',
    onTenant(async (tenant, body, actor) => {
      if (typeof body.paused !== 'boolean') return bad
      await setUsagePaused(database, tenant.id, body.paused)
      await recordAudit(database, actor, body.paused ? 'usage_paused' : 'usage_resumed', tenant.id, {})
      await hooks.reevaluateLimits?.()
      return { ok: true }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/limits',
    onTenant(async (tenant, body, actor) => {
      const { scope, usd } = body
      if ((scope !== 'daily' && scope !== 'monthly') || typeof usd !== 'number') return bad
      if (!(usd === 0 || (scope === 'daily' ? DAILY_LIMITS : MONTHLY_LIMITS).includes(usd))) return bad
      await setLimit(database, tenant.id, scope, usd === 0 ? null : usd)
      await recordAudit(database, actor, 'limit_changed', tenant.id, { scope, usd: usd === 0 ? null : usd })
      await hooks.reevaluateLimits?.()
      return { ok: true }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/subscription',
    onTenant(async (tenant, body, actor) => {
      const { plan, months } = body
      if (typeof plan !== 'string' || typeof months !== 'number' || !MONTH_CHOICES.includes(months)) return bad
      if (!(await listSellablePlans(database)).some((item) => item.code === plan)) return bad
      const subscription = await grantSubscription(database, tenant.id, plan, months, actor)
      if (!subscription) return bad
      await recordAudit(database, actor, 'subscription_granted', tenant.id, { plan, months })
      await enqueueBroadcast(
        database,
        [tenant.id],
        `Langganan Aksis AI Anda aktif (paket ${subscription.planName}) sampai ${formatDate(subscription.endsAt)}. Terima kasih!`,
      )
      return { ok: true, plan: subscription.planName, endsAt: subscription.endsAt.toISOString() }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/subscription/set',
    onTenant(async (tenant, body, actor) => {
      const { plan, endsOn, endNow } = body
      if (typeof plan !== 'string') return bad
      let endsAt: Date
      if (endNow === true) {
        // Ending a plan keeps its type; the customer goes through the grace days as with any expiry.
        const current = await getSubscription(database, tenant.id)
        if (!current) return bad
        endsAt = new Date()
        if (plan !== current.planCode) return bad
      } else {
        if (typeof endsOn !== 'string' || !DATE.test(endsOn)) return bad
        // The end date is the end of that day in Jakarta.
        endsAt = new Date(`${endsOn}T23:59:59+07:00`)
        const now = Date.now()
        if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() < now - 3650 * DAY_MS || endsAt.getTime() > now + 3 * 365 * DAY_MS) return bad
      }
      const subscription = await setSubscription(database, tenant.id, plan, endsAt, actor)
      if (!subscription) return bad
      await recordAudit(database, actor, endNow === true ? 'subscription_ended' : 'subscription_set', tenant.id, { plan, endsOn: endsAt.toISOString().slice(0, 10) })
      return { ok: true, plan: subscription.planName, endsAt: subscription.endsAt.toISOString() }
    }),
  )

  /** Pairs WhatsApp again: the old session is cut, onboarding restarts at the WhatsApp step and a new link is made. */
  app.post(
    '/v1/dashboard/customers/:id/repair',
    onTenant(async (tenant, _body, actor) => {
      // The linked number is read before the reset forgets it.
      const phone = await getTenantPhone(database, tenant.id)
      await hooks.removeSession?.(tenant.id)
      await resetOnboarding(database, tenant.id)
      const invite = await createInvitationForTenant(database, tenant.id, actor, phone)
      await recordAudit(database, actor, 'whatsapp_repair', tenant.id, { name: tenant.name })
      return { name: tenant.name, phone, tenantId: tenant.id, link: `${deps.publicBaseUrl}/join/${invite.token}`, expiresAt: invite.expiresAt.toISOString() }
    }),
  )

  /** A new link for a customer whose invitation ran out; the old links stop working. */
  app.post(
    '/v1/dashboard/customers/:id/invitation',
    onTenant(async (tenant, _body, actor) => {
      const invite = await renewTenantInvitation(database, tenant.id, actor)
      await recordAudit(database, actor, 'invite_renewed', tenant.id, {})
      return { name: tenant.name, phone: invite.phone, tenantId: tenant.id, link: `${deps.publicBaseUrl}/join/${invite.token}`, expiresAt: invite.expiresAt.toISOString() }
    }),
  )

  app.post(
    '/v1/dashboard/customers/:id/delete',
    onTenant(async (tenant, body, actor) => {
      // Typing the name is the confirmation, so a stray request cannot erase a customer.
      if (body.confirmName !== tenant.name) return bad
      // Close the connection first so nothing is written while the rows are removed.
      await hooks.removeSession?.(tenant.id)
      await recordAudit(database, actor, 'tenant_deleted', tenant.id, { name: tenant.name })
      const deleted = await deleteTenantData(database, tenant.id)
      return deleted ? { ok: true, messages: deleted.messages } : null
    }),
  )
}
