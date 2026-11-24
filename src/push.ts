import webpush from 'web-push'
import type { Database } from './db.js'
import type { FeatureHealth } from './health.js'
import { dueSoon, type DueItem } from './projects.js'

/** Devices a customer can have at once (phone, tablet, a second phone); the oldest is dropped beyond this. */
const MAX_DEVICES = 5
/** A device that keeps failing is dropped after this many failed sends in a row. */
const MAX_FAILURES = 5
const SWEEP_EVERY_MS = 5 * 60_000
/** The digest is a morning message: not sent after this Jakarta hour, even if it was missed earlier. */
const DIGEST_UNTIL_HOUR_WIB = 12

/**
 * The server posts to the address a device hands over, so only the real push services are accepted. Without this a
 * logged-in customer could make the server call any address (an internal service, for example).
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
]

export function isAllowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > 600) return false
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && !url.port && !url.username && PUSH_HOSTS.some((host) => host.test(url.hostname))
  } catch {
    return false
  }
}

const base64Url = /^[A-Za-z0-9_-]+$/

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string }

export function validSubscription(input: PushSubscriptionInput): boolean {
  return (
    isAllowedEndpoint(input.endpoint) &&
    base64Url.test(input.p256dh) && input.p256dh.length >= 80 && input.p256dh.length <= 100 &&
    base64Url.test(input.auth) && input.auth.length >= 16 && input.auth.length <= 32
  )
}

export type PushService = {
  publicKey: string
  subscribe: (tenantId: string, input: PushSubscriptionInput, userAgent: string | null) => Promise<boolean>
  unsubscribe: (tenantId: string, endpoint: string) => Promise<void>
}

export function createPushService(sql: Database, publicKey: string): PushService {
  return {
    publicKey,
    async subscribe(tenantId, input, userAgent) {
      if (!validSubscription(input)) return false
      await sql.begin(async (tx) => {
        await tx`select id from tenants where id = ${tenantId} for update`
        // The same device may be re-registered (new keys, or another customer on a shared phone): one row per endpoint.
        await tx`
          insert into push_subscriptions (tenant_id, endpoint, p256dh, auth, user_agent)
          values (${tenantId}, ${input.endpoint}, ${input.p256dh}, ${input.auth}, ${userAgent?.slice(0, 200) ?? null})
          on conflict (endpoint) do update
            set tenant_id = excluded.tenant_id, p256dh = excluded.p256dh, auth = excluded.auth,
                user_agent = excluded.user_agent, failed_count = 0
        `
        await tx`
          delete from push_subscriptions
          where tenant_id = ${tenantId} and id not in (
            select id from push_subscriptions where tenant_id = ${tenantId} order by created_at desc limit ${MAX_DEVICES}
          )
        `
      })
      return true
    },
    async unsubscribe(tenantId, endpoint) {
      await sql`delete from push_subscriptions where tenant_id = ${tenantId} and endpoint = ${endpoint}`
    },
  }
}

export type PushMessage = { title: string; body: string; url: string; tag: string }
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }
/** Sends one message to one device; rejects with a `statusCode` when the push service refuses it. */
export type Sender = (subscription: Subscription, message: PushMessage) => Promise<void>

export function webPushSender(config: { publicKey: string; privateKey: string; subject: string }): Sender {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey)
  return async (subscription, message) => {
    await webpush.sendNotification(subscription, JSON.stringify(message), { TTL: 6 * 3600, urgency: 'normal', timeout: 15_000 })
  }
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
const dayNumber = (date: Date) => Math.floor(Date.parse(`${dayFormat.format(date)}T00:00:00Z`) / 86_400_000)

function whenLabel(dueAt: Date, now: Date): string {
  const diff = dayNumber(dueAt) - dayNumber(now)
  if (diff <= -1) return `terlewat ${-diff} hari`
  return diff === 0 ? 'hari ini' : 'besok'
}

/** The morning message: plain words, no amounts, the two most pressing things and how many more there are. */
export function digestMessage(items: DueItem[], now: Date): PushMessage {
  const shown = items.slice(0, 2).map((item) => `${item.title.slice(0, 70)} (${item.project.slice(0, 30)}), ${whenLabel(item.dueAt, now)}`)
  const rest = items.length - shown.length
  const sameProject = items.every((item) => item.projectId === items[0]?.projectId)
  return {
    title: items.length === 1 ? '1 hal perlu perhatian' : `${items.length} hal perlu perhatian`,
    body: `${shown.join('. ')}${rest > 0 ? `. +${rest} lagi` : ''}`,
    url: sameProject && items[0] ? `/app/proyek/${items[0].projectId}` : '/app/proyek',
    tag: 'digest',
  }
}

const jakartaHour = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(now)) % 24

type Device = { id: string; endpoint: string; p256dh: string; auth: string; failed_count: number }

/**
 * Sends the morning digest to every active customer who has a device registered and something due, once a day,
 * between the digest hour and noon (Jakarta). Returns how many customers got it.
 */
export async function sendDigests(
  sql: Database,
  send: Sender,
  digestHourWib: number,
  now = new Date(),
  untilHourWib = DIGEST_UNTIL_HOUR_WIB,
  health?: FeatureHealth,
): Promise<number> {
  const hour = jakartaHour(now)
  if (hour < digestHourWib || hour >= untilHourWib) return 0
  const tenants = await sql<Array<{ id: string }>>`
    select distinct t.id from tenants t
    join push_subscriptions s on s.tenant_id = t.id
    where t.status = 'active'
      and not exists (
        select 1 from push_sent ps
        where ps.tenant_id = t.id and ps.kind = 'digest' and ps.day = (${now}::timestamptz at time zone 'Asia/Jakarta')::date
      )
  `
  let delivered = 0
  for (const tenant of tenants) {
    try {
      const items = await dueSoon(sql, tenant.id)
      if (items.length === 0) continue
      const [claimed] = await sql<Array<{ tenant_id: string }>>`
        insert into push_sent (tenant_id, day, kind)
        values (${tenant.id}, (${now}::timestamptz at time zone 'Asia/Jakarta')::date, 'digest')
        on conflict do nothing
        returning tenant_id
      `
      if (!claimed) continue
      const message = digestMessage(items, now)
      const devices = await sql<Device[]>`select id, endpoint, p256dh, auth, failed_count from push_subscriptions where tenant_id = ${tenant.id}`
      let ok = 0
      let retryable = 0
      for (const device of devices) {
        try {
          await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, message)
          ok += 1
          health?.record('push', true)
          await sql`update push_subscriptions set last_ok_at = now(), failed_count = 0 where id = ${device.id}`
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            // The push service answered: the device is just gone. That is not a fault of ours.
            await sql`delete from push_subscriptions where id = ${device.id}`
          } else {
            retryable += 1
            health?.record('push', false)
            await sql`update push_subscriptions set failed_count = failed_count + 1 where id = ${device.id}`
            await sql`delete from push_subscriptions where id = ${device.id} and failed_count >= ${MAX_FAILURES}`
          }
        }
      }
      // Nothing got through only because of a passing problem: allow the next sweep to try again.
      if (ok === 0 && retryable > 0) {
        await sql`delete from push_sent where tenant_id = ${tenant.id} and kind = 'digest' and day = (${now}::timestamptz at time zone 'Asia/Jakarta')::date`
      } else if (ok > 0) {
        delivered += 1
      }
    } catch (error) {
      console.error('Push digest failed', error instanceof Error ? error.message : error)
    }
  }
  return delivered
}

/** Runs the sweep every few minutes. The first one waits a little so a restart does not start with a burst. */
export class PushWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly sql: Database,
    private readonly send: Sender,
    private readonly digestHourWib: number,
    private readonly health?: FeatureHealth,
  ) {}

  start(): void {
    if (this.timer) return
    const tick = () => {
      if (this.running) return
      this.running = true
      sendDigests(this.sql, this.send, this.digestHourWib, new Date(), DIGEST_UNTIL_HOUR_WIB, this.health)
        .catch((error: unknown) => console.error('Push sweep failed', error instanceof Error ? error.message : error))
        .finally(() => {
          this.running = false
        })
    }
    this.timer = setInterval(tick, SWEEP_EVERY_MS)
    setTimeout(tick, 90_000).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
