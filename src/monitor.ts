import { FeatureHealth, type Feature } from './health.js'
import { statfs } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { pruneInvitationPhones, type DailySummary, type LimitStatus } from './ops.js'
import {
  dailySummary,
  enqueueBroadcast,
  getState,
  limitStatuses,
  setState,
  setUsagePaused,
} from './ops.js'
import { formatDate, sweepBilling } from './billing.js'
import type { Database } from './db.js'
import { startOfWibDayDate, wibDateString } from './usage-range.js'

export type AlertButton = { text: string; callback_data: string }
export type Notify = (text: string, keyboard?: AlertButton[][]) => Promise<void>

/* ---------- alert tracking ---------- */

export type Condition = {
  key: string
  message: string
  recovered: string
  /** The condition must hold this long before anyone is told. */
  holdMs: number
  keyboard?: AlertButton[][]
}

export type AlertMessage = { text: string; keyboard?: AlertButton[][] }

const FEATURE_ALERTS: Array<{ feature: Feature; windowMs: number; window: string; failed: string; recovered: string }> = [
  { feature: 'chat', windowMs: 15 * 60_000, window: '15 menit', failed: 'Chat di app gagal menjawab', recovered: '✅ Chat di app menjawab normal lagi.' },
  { feature: 'summary', windowMs: 60 * 60_000, window: '1 jam', failed: 'Catatan proyek gagal ditulis', recovered: '✅ Catatan proyek berjalan normal lagi.' },
  { feature: 'push', windowMs: 60 * 60_000, window: '1 jam', failed: 'Notifikasi push gagal terkirim', recovered: '✅ Notifikasi push berjalan normal lagi.' },
]

/**
 * An alert per feature once it failed at least three times recently and failed more often than it worked.
 * A device the push service reports as gone is not a failure; see push.ts.
 */
export function featureConditions(health: FeatureHealth, now = Date.now()): Condition[] {
  const conditions: Condition[] = []
  for (const alert of FEATURE_ALERTS) {
    const { failures, successes } = health.recent(alert.feature, alert.windowMs, now)
    if (failures < 3 || failures <= successes) continue
    conditions.push({
      key: `feature-${alert.feature}`,
      message: `⚠️ ${alert.failed} ${failures} kali dalam ${alert.window} terakhir.`,
      recovered: alert.recovered,
      holdMs: 0,
      keyboard: [[{ text: '📊 Health', callback_data: 'm:status' }]],
    })
  }
  return conditions
}

const REMIND_MS = 6 * 3_600_000

/** Raises an alert once a condition has held long enough, repeats rarely, and reports recovery. */
export class AlertTracker {
  private readonly active = new Map<
    string,
    { since: number; notifiedAt: number | null; recovered: string; keyboard?: AlertButton[][] }
  >()

  update(conditions: Condition[], now: number): { raise: AlertMessage[]; recover: AlertMessage[] } {
    const raise: AlertMessage[] = []
    const recover: AlertMessage[] = []
    const present = new Set(conditions.map((condition) => condition.key))

    for (const condition of conditions) {
      const entry = this.active.get(condition.key) ?? {
        since: now,
        notifiedAt: null,
        recovered: condition.recovered,
        ...(condition.keyboard ? { keyboard: condition.keyboard } : {}),
      }
      entry.recovered = condition.recovered
      this.active.set(condition.key, entry)
      const due =
        entry.notifiedAt === null
          ? now - entry.since >= condition.holdMs
          : now - entry.notifiedAt >= REMIND_MS
      if (!due) continue
      const reminder = entry.notifiedAt !== null
      entry.notifiedAt = now
      raise.push({
        text: reminder ? `${condition.message}\n(masih berlangsung)` : condition.message,
        ...(condition.keyboard ? { keyboard: condition.keyboard } : {}),
      })
    }

    for (const [key, entry] of this.active) {
      if (present.has(key)) continue
      this.active.delete(key)
      if (entry.notifiedAt !== null) {
        recover.push({ text: entry.recovered, ...(entry.keyboard ? { keyboard: entry.keyboard } : {}) })
      }
    }
    return { raise, recover }
  }
}

/* ---------- usage limits ---------- */

export type LimitEvent =
  | { kind: 'paused'; tenantId: string; name: string; scope: 'daily' | 'monthly'; cost: number; limit: number }
  | { kind: 'resumed'; tenantId: string; name: string }
  | { kind: 'warn'; tenantId: string; name: string; scope: 'daily' | 'monthly'; cost: number; limit: number }

/** Pure decision step, separated from the database so it can be tested exhaustively. */
export function decideLimits(
  statuses: LimitStatus[],
  warned: Set<string>,
  period: { day: string; month: string },
): { events: LimitEvent[]; pause: string[]; resume: string[] } {
  const events: LimitEvent[] = []
  const pause: string[] = []
  const resume: string[] = []

  for (const status of statuses) {
    const checks: Array<{ scope: 'daily' | 'monthly'; cost: number; limit: number | null; period: string }> = [
      { scope: 'daily', cost: status.todayCost, limit: status.dailyLimit, period: period.day },
      { scope: 'monthly', cost: status.monthCost, limit: status.monthlyLimit, period: period.month },
    ]
    const exceeded = checks.find((check) => check.limit !== null && check.cost >= check.limit)

    if (exceeded && !status.paused) {
      pause.push(status.tenantId)
      events.push({
        kind: 'paused',
        tenantId: status.tenantId,
        name: status.name,
        scope: exceeded.scope,
        cost: exceeded.cost,
        limit: exceeded.limit!,
      })
    } else if (!exceeded && status.paused) {
      resume.push(status.tenantId)
      events.push({ kind: 'resumed', tenantId: status.tenantId, name: status.name })
    }

    for (const check of checks) {
      if (check.limit === null || check.limit <= 0 || check.cost >= check.limit) continue
      const warnKey = `${status.tenantId}:${check.scope}:${check.period}`
      if (check.cost >= check.limit * 0.8 && !warned.has(warnKey)) {
        warned.add(warnKey)
        events.push({
          kind: 'warn',
          tenantId: status.tenantId,
          name: status.name,
          scope: check.scope,
          cost: check.cost,
          limit: check.limit,
        })
      }
    }
  }
  return { events, pause, resume }
}

/* ---------- daily summary ---------- */

const WEEKDAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

export function formatSummary(summary: DailySummary, day: Date): string {
  const wib = new Date(day.getTime() + 7 * 3_600_000)
  const title = `${WEEKDAYS[wib.getUTCDay()]}, ${wib.getUTCDate()} ${MONTHS[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`
  const statuses = ['active', 'onboarding', 'invited', 'disabled']
    .filter((status) => (summary.statusCounts[status] ?? 0) > 0)
    .map((status) => `${summary.statusCounts[status]} ${status}`)
  const lines = [
    `🌅 Ringkasan Aksis — ${title}`,
    `💰 Biaya: ~$${summary.cost.toFixed(4)} (${summary.runs} run${summary.failedRuns > 0 ? `, ${summary.failedRuns} gagal` : ''})`,
    `🧾 Pesan masuk: ${summary.selfMessages} self-chat, ${summary.groupMessages} grup`,
    `📌 Event baru: ${summary.events}`,
    `👥 Pelanggan: ${statuses.length > 0 ? statuses.join(', ') : 'belum ada'}`,
  ]
  if (summary.perTenant.length > 0) {
    lines.push(`Teratas: ${summary.perTenant.map((row) => `${row.name} ~$${row.cost.toFixed(4)}`).join(', ')}`)
  }
  return lines.join('\n')
}

/* ---------- monitor ---------- */

export type MonitorDeps = {
  database: Database
  notify: Notify
  /** Connection state per tenant that has a WhatsApp session in this process. */
  connections: () => Array<{ tenantId: string; connection: string }>
  /** The system number's state, or null when there is none. */
  systemConnection?: () => { connection: string; paired: boolean } | null
  hermesHealthy: () => Promise<boolean>
  /** Recent failures of the app features that leave no trace in the database. */
  featureHealth?: FeatureHealth
  summaryHourWib: number
  now?: () => Date
}

const TICK_MS = 60_000
const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3
const MIN_FREE_MEMORY_BYTES = 150 * 1024 ** 2

export class Monitor {
  private timer: NodeJS.Timeout | null = null
  private firstTick: NodeJS.Timeout | null = null
  private running = false
  private readonly tracker = new AlertTracker()
  private readonly warned = new Set<string>()

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    // The container has no outbound network for a few seconds after it starts.
    this.firstTick = setTimeout(() => void this.tick(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstTick) clearTimeout(this.firstTick)
  }

  /** Re-checks limits right away, e.g. after an admin changed one. */
  async reevaluateLimits(): Promise<void> {
    await this.checkLimits().catch((error) => this.logError('limits', error))
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.checkLimits().catch((error) => this.logError('limits', error))
      await this.checkAlerts().catch((error) => this.logError('alerts', error))
      await this.checkSummary().catch((error) => this.logError('summary', error))
      await this.checkBilling().catch((error) => this.logError('billing', error))
      await pruneInvitationPhones(this.deps.database).catch((error) => this.logError('invitations', error))
    } finally {
      this.running = false
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private async checkLimits(): Promise<void> {
    const now = this.now()
    const statuses = (await limitStatuses(this.deps.database, undefined, now)).filter(
      (status) => status.dailyLimit !== null || status.monthlyLimit !== null || status.paused,
    )
    const decision = decideLimits(statuses, this.warned, {
      day: wibDateString(now),
      month: wibDateString(now).slice(0, 7),
    })
    for (const tenantId of decision.pause) await setUsagePaused(this.deps.database, tenantId, true)
    for (const tenantId of decision.resume) await setUsagePaused(this.deps.database, tenantId, false)

    for (const event of decision.events) {
      const open = [[{ text: '🚦 Limits', callback_data: `lm:${event.tenantId}` }]]
      if (event.kind === 'warn') {
        await this.deps.notify(
          `🟡 ${event.name}: pemakaian ${event.scope === 'daily' ? 'harian' : 'bulanan'} sudah 80% (~$${event.cost.toFixed(4)} dari $${event.limit.toFixed(2)}).`,
          open,
        )
      } else if (event.kind === 'paused') {
        const period = event.scope === 'daily' ? 'harian' : 'bulanan'
        await this.deps.notify(
          `⛔ ${event.name} dijeda: batas ${period} tercapai (~$${event.cost.toFixed(4)} dari $${event.limit.toFixed(2)}). AI berhenti memproses pesannya sampai batas dinaikkan atau periode berganti.`,
          open,
        )
        await enqueueBroadcast(
          this.deps.database,
          [event.tenantId],
          `Batas pemakaian ${period} Aksis tercapai, jadi Aksis berhenti memproses pesan sementara. Aksis lanjut otomatis saat periode berikutnya dimulai.`,
        )
      } else {
        await this.deps.notify(`▶️ ${event.name} dilanjutkan: pemakaian kembali di bawah batas.`, open)
      }
    }
  }

  private async checkAlerts(): Promise<void> {
    const db = this.deps.database
    const conditions: Condition[] = []

    const active = await db<Array<{ id: string; name: string }>>`
      select id, name from tenants where status = 'active' and whatsapp_enabled
    `
    const connections = new Map(this.deps.connections().map((entry) => [entry.tenantId, entry.connection]))
    for (const tenant of active) {
      const connection = connections.get(tenant.id) ?? 'tidak ada sesi'
      if (connection === 'connected') continue
      conditions.push({
        key: `wa:${tenant.id}`,
        message: `⚠️ WhatsApp ${tenant.name} tidak tersambung (${connection}). Pesannya tidak dibaca selama ini.`,
        recovered: `✅ WhatsApp ${tenant.name} tersambung lagi.`,
        holdMs: connection === 'logged_out' ? 0 : 5 * 60_000,
        keyboard: [[{ text: '🔎 Open tenant', callback_data: `t:${tenant.id}` }]],
      })
    }

    const system = this.deps.systemConnection?.()
    if (system?.paired && system.connection !== 'connected') {
      conditions.push({
        key: 'system-wa',
        message: `⚠️ WhatsApp sistem tidak tersambung (${system.connection}). Kode login dan info akses tidak terkirim.`,
        recovered: '✅ WhatsApp sistem tersambung lagi.',
        holdMs: system.connection === 'logged_out' ? 0 : 3 * 60_000,
        keyboard: [[{ text: '📱 System WhatsApp', callback_data: 'm:sys' }]],
      })
    }

    if (!(await this.deps.hermesHealthy())) {
      conditions.push({
        key: 'hermes',
        message: '⚠️ Hermes tidak merespons. Balasan dan analisis tertahan.',
        recovered: '✅ Hermes merespons lagi.',
        holdMs: 2 * 60_000,
      })
    }

    const [failed] = await db<Array<{ n: string }>>`
      select count(*) as n from analysis_runs
      where status = 'failed' and started_at > now() - interval '15 minutes'
    `
    if (Number(failed?.n ?? 0) >= 3) {
      conditions.push({
        key: 'runs',
        message: `⚠️ ${failed?.n} run analisis gagal dalam 15 menit terakhir.`,
        recovered: '✅ Run analisis berjalan normal lagi.',
        holdMs: 0,
        keyboard: [[{ text: '⚠️ Failed runs', callback_data: 'm:failed' }]],
      })
    }

    if (this.deps.featureHealth) conditions.push(...featureConditions(this.deps.featureHealth, this.now().getTime()))

    const disk = await statfs('/').catch(() => null)
    if (disk && disk.bavail * disk.bsize < MIN_FREE_DISK_BYTES) {
      conditions.push({
        key: 'disk',
        message: `⚠️ Ruang disk server tinggal ${(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1)} GB.`,
        recovered: '✅ Ruang disk server kembali aman.',
        holdMs: 0,
      })
    }

    const available = await readAvailableMemory()
    if (available !== null && available < MIN_FREE_MEMORY_BYTES) {
      conditions.push({
        key: 'mem',
        message: `⚠️ Memori server tersedia hanya ${Math.round(available / 1024 ** 2)} MB.`,
        recovered: '✅ Memori server kembali longgar.',
        holdMs: 5 * 60_000,
      })
    }

    const { raise, recover } = this.tracker.update(conditions, this.now().getTime())
    for (const alert of [...raise, ...recover]) await this.deps.notify(alert.text, alert.keyboard)
  }

  private async checkSummary(): Promise<void> {
    const now = this.now()
    const today = wibDateString(now)
    const wibHour = new Date(now.getTime() + 7 * 3_600_000).getUTCHours()
    if (wibHour < this.deps.summaryHourWib) return
    if ((await getState(this.deps.database, 'summary:last')) === today) return

    const todayStart = startOfWibDayDate(now)
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000)
    const summary = await dailySummary(this.deps.database, yesterdayStart, todayStart)
    // Mark first: a failed send is better lost than repeated on every tick.
    await setState(this.deps.database, 'summary:last', today)
    await this.deps.notify(formatSummary(summary, yesterdayStart), [
      [
        { text: '💰 Usage', callback_data: 'u:d7' },
        { text: '📊 Health', callback_data: 'm:status' },
      ],
    ])
  }

  /** Queues customer reminders and tells the admins who is about to lapse or just did. */
  private async checkBilling(): Promise<void> {
    const notices = await sweepBilling(this.deps.database, this.now())
    if (notices.length === 0) return
    const label = { remind: 'berakhir ≤3 hari', grace: 'masuk masa tenggang', expired: 'EXPIRED, AI berhenti' } as const
    await this.deps.notify(
      ['💳 Langganan:', ...notices.map((notice) => `• ${notice.tenantName} — ${label[notice.kind]} (${formatDate(notice.endsAt)})`)].join('\n'),
      [[{ text: '💳 Billing', callback_data: 'm:bill' }]],
    )
  }

  private logError(where: string, error: unknown): void {
    console.error(`Monitor ${where} error:`, error instanceof Error ? error.message : error)
  }
}

async function readAvailableMemory(): Promise<number | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8')
    const match = /MemAvailable:\s+(\d+) kB/.exec(text)
    return match ? Number(match[1]) * 1024 : null
  } catch {
    return null
  }
}
