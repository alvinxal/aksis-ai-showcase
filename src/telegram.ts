import { accessInfoText } from './activation.js'
import {
  createInvitation,
  createInvitationForTenant,
  deleteTenantData,
  findTenant,
  getTenantDetail,
  getTenantPhone,
  listTenants,
  recordAudit,
  resetOnboarding,
  setTenantStatus,
  usageByKind,
  usageByTenant,
  USAGE_KIND_LABEL,
  type TenantStatus,
} from './admin.js'
import {
  billingOverview,
  daysLeft,
  formatDate,
  getSubscription,
  grantSubscription,
  GRACE_DAYS,
  listSellablePlans,
  monthlyRecurringIdr,
  startTrial,
  subscriptionStatus,
  type SubscriptionStatus,
} from './billing.js'
import { LOGIN_LINK_MINUTES, createLoginLink } from './dashboard-auth.js'
import type { Database } from './db.js'
import { claimLead, countNewLeads, getLead, listOpenLeads, restoreLead, setLeadStatus, type Lead } from './leads.js'
import { splitNameAndPhone, whatsappLink } from './phone.js'
import {
  isExpired,
  newEditor,
  renderEditor,
  setPage,
  setQuery,
  toggleGroup,
  type GroupEditor,
} from './group-editor.js'
import { GROUP_LIMIT, type SaveGroupsResult, type StoredGroup } from './groups.js'
import {
  activeTenantIds,
  addDbAdmin,
  attentionItems,
  type AttentionKind,
  enqueueBroadcast,
  failedRunsSummary,
  getOpenInvitation,
  getTenantInvitation,
  getTenantNotes,
  limitStatuses,
  listDbAdmins,
  removeDbAdmin,
  renameTenant,
  renewTenantInvitation,
  retryBlockedMessages,
  revokeTenantInvitations,
  setLimit,
  setTenantNotes,
} from './ops.js'
import { parseTypedRange, presetRange, rangeFromKey, type UsageRange } from './usage-range.js'

export type AskHermes = (
  adminId: number,
  question: string,
) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>

export type TelegramHooks = {
  connectionOf?: (tenantId: string) => string
  /** Closes the WhatsApp connection and wipes the stored session of a tenant. */
  removeSession?: (tenantId: string) => Promise<void>
  /** Closes the connection but keeps the session. */
  disconnectWhatsApp?: (tenantId: string) => Promise<void>
  /** Reopens the stored session of a tenant that was switched back on. */
  resumeWhatsApp?: (tenantId: string) => Promise<void>
  /** Switches WhatsApp back on and opens the stored session; no new QR while it is still valid. */
  reconnectWhatsApp?: (tenantId: string) => Promise<'started' | 'exists' | 'full' | 'unavailable'>
  /** Sends text to the tenant's own WhatsApp chat, waiting briefly for the connection; false when it never went out. */
  sendAccessInfo?: (tenantId: string, text: string) => Promise<boolean>
  reevaluateLimits?: () => Promise<void>
  /** The operator's system WhatsApp number: its state and a pairing code for it. */
  system?: {
    status: () => { phone: string; connection: string; paired: boolean; lastError: string | null }
    pair: () => Promise<string | null>
  }
  /** Live WhatsApp groups of a tenant (rejects when not connected) and selection saving. */
  groups?: {
    list: (tenantId: string) => Promise<StoredGroup[]>
    save: (tenantId: string, jids: string[]) => Promise<SaveGroupsResult>
    /** Group limit of the tenant's plan. */
    limit?: (tenantId: string) => Promise<number>
  }
}

export type TelegramOptions = {
  token: string
  /** Owners: from the environment, can manage admins, cannot be removed from Telegram. */
  adminIds: Set<number>
  publicBaseUrl: string
}

type TelegramUpdate = {
  update_id: number
  message?: {
    text?: string
    chat: { id: number; type: string }
    from?: { id: number }
  }
  callback_query?: {
    id: string
    data?: string
    from: { id: number }
    message?: { message_id: number; chat: { id: number; type: string } }
  }
}

export type Button = { text: string; callback_data: string }
/** Opens a link (e.g. the admin's WhatsApp) instead of sending a callback. */
export type UrlButton = { text: string; url: string }
type Reply = { text: string; keyboard?: Array<Array<Button | UrlButton>> }

type Awaiting =
  | { kind: 'invite' }
  | { kind: 'range'; scope: string | null }
  | { kind: 'rename'; tenantId: string }
  | { kind: 'notes'; tenantId: string }
  | { kind: 'broadcast'; target: string }
  | { kind: 'admin' }
  | { kind: 'groupsearch' }

const COMMANDS = [
  { command: 'menu', description: 'Menu utama (tombol)' },
  { command: 'invite', description: 'Buat link undangan pelanggan' },
  { command: 'tenants', description: 'Daftar pelanggan' },
  { command: 'status', description: 'Kesehatan sistem' },
  { command: 'usage', description: 'Pemakaian token dan biaya' },
  { command: 'dashboard', description: 'Link masuk dashboard web' },
  { command: 'help', description: 'Bantuan' },
]

/** Daily work first, in the order of a customer's journey; everything technical is behind System. */
function mainMenu(attention: number, leads = 0): Button[][] {
  return [
    ...(attention > 0 ? [[{ text: `🔔 Needs attention (${attention})`, callback_data: 'm:attn' }]] : []),
    ...(leads > 0 ? [[{ text: `📥 New requests (${leads})`, callback_data: 'm:leads' }]] : []),
    [{ text: '➕ Invite customer', callback_data: 'm:invite' }],
    [
      { text: '👥 Customers', callback_data: 'm:tenants' },
      { text: '💳 Billing', callback_data: 'm:bill' },
    ],
    [
      { text: '📣 Broadcast', callback_data: 'm:bc' },
      { text: '⚙️ System', callback_data: 'm:system' },
    ],
  ]
}

const SYSTEM_MENU: Button[][] = [
  [
    { text: '📊 Health', callback_data: 'm:status' },
    { text: '💰 Usage', callback_data: 'u:d7' },
  ],
  [
    { text: '⚠️ Failed runs', callback_data: 'm:failed' },
    { text: '📱 System WhatsApp', callback_data: 'm:sys' },
  ],
  [
    { text: '🖥 Dashboard', callback_data: 'm:dash' },
    { text: '👮 Admins', callback_data: 'm:adm' },
  ],
]

const ATTENTION_ICON: Record<AttentionKind, string> = {
  plan: '📦',
  whatsapp: '🔌',
  billing: '💳',
  paused: '🚦',
  failed: '⚠️',
  stuck: '⏳',
}

const TENANT_FILTERS = [
  ['all', 'All'],
  ['onb', 'Onboarding'],
  ['act', 'Active'],
  ['end', 'Ending'],
  ['exp', 'Grace/Expired'],
  ['dis', 'Disabled'],
] as const

const BACK_MENU: Button = { text: '⬅️ Menu', callback_data: 'm:menu' }
const ACCESS_SENT = 'Info akses terkirim ke chat WhatsApp pelanggan.'
const ACCESS_NOT_SENT = '⚠️ Info akses belum terkirim (WhatsApp belum tersambung). Coba tombol Send access info again.'
const STATUS_ICON: Record<TenantStatus, string> = {
  active: '🟢',
  onboarding: '🟡',
  invited: '⚪',
  disabled: '🔴',
}

const BILLING_ICON: Record<SubscriptionStatus, string> = {
  pending: '⚪',
  trial: '🟡',
  active: '🟢',
  grace: '🟠',
  expired: '🔴',
}
const MONTH_CHOICES = [1, 3, 12]

const DAILY_LIMITS = [0.25, 0.5, 1, 2]
const MONTHLY_LIMITS = [5, 10, 20, 50]
const PROMPT_TTL_MS = 5 * 60_000
const MAX_BROADCAST_CHARS = 1000

const HELP = [
  'Aksis AI — gunakan tombol dari /menu. Perintah teks juga tersedia:',
  '/menu — menu utama',
  'Teks biasa tanpa / = tanya langsung ke Hermes',
  '/invite <nama pelanggan> — buat link undangan (48 jam, sekali pakai) dengan tombol kirim lewat WhatsApp',
  '/tenants — daftar pelanggan',
  '/status — kesehatan sistem',
  '/usage [hari] — pemakaian token dan biaya',
  '/dashboard — link masuk dashboard web (5 menit, sekali pakai)',
  '/enable <id|nama> dan /disable <id|nama>',
].join('\n')

export class TelegramAdminBot {
  private stopped = false
  private running: Promise<void> | null = null
  private abortController = new AbortController()
  private offset = 0
  private readonly awaiting = new Map<number, Awaiting & { at: number }>()
  private readonly broadcastDrafts = new Map<number, { target: string; text: string }>()
  private readonly asking = new Set<number>()
  private readonly groupEditors = new Map<number, GroupEditor>()
  private dbAdmins = new Set<number>()

  constructor(
    private readonly database: Database,
    private readonly options: TelegramOptions,
    private readonly statusLines: () => Promise<string[]>,
    private readonly askHermes?: AskHermes,
    private readonly hooks: TelegramHooks = {},
  ) {}

  start(): void {
    void this.api('setMyCommands', { commands: COMMANDS }).catch((error) => this.logError('setMyCommands', error))
    this.running = this.refreshAdmins().then(() => this.loop())
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abortController.abort()
    await this.running
  }

  async notify(text: string, keyboard?: Array<Array<Button | UrlButton>>): Promise<void> {
    for (const id of this.allAdmins()) {
      const payload = keyboard ? { text, keyboard } : { text }
      // One retry: a transient network error must not drop an alert.
      await this.send(id, payload)
        .catch(async () => {
          await delay(2_000)
          await this.send(id, payload)
        })
        .catch((error) => this.logError('notify', error))
    }
  }

  private allAdmins(): Set<number> {
    return new Set([...this.options.adminIds, ...this.dbAdmins])
  }

  private isAdmin(id: number): boolean {
    return this.options.adminIds.has(id) || this.dbAdmins.has(id)
  }

  /** Whether this Telegram id is an admin right now; the dashboard checks it at login and on every request. */
  isAdminId(id: number): boolean {
    return this.isAdmin(id)
  }

  private isOwner(id: number): boolean {
    return this.options.adminIds.has(id)
  }

  /** For the dashboard: owners come from the environment and manage the other admins. */
  isOwnerId(id: number): boolean {
    return this.isOwner(id)
  }

  /** The dashboard changed the admins table: the bot reloads its copy. */
  async reloadAdmins(): Promise<void> {
    await this.refreshAdmins()
  }

  private async refreshAdmins(): Promise<void> {
    this.dbAdmins = new Set(await listDbAdmins(this.database).catch(() => []))
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api<TelegramUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          35_000,
        )
        for (const update of updates) {
          this.offset = update.update_id + 1
          await this.handle(update).catch((error) => this.logError('handle', error))
        }
      } catch (error) {
        if (this.stopped) break
        this.logError('poll', error)
        await delay(5_000)
      }
    }
  }

  /* ---------- incoming ---------- */

  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query)

    const message = update.message
    const text = message?.text?.trim()
    const fromId = message?.from?.id
    if (!message || !text || fromId === undefined) return

    if (message.chat.type !== 'private' || !this.isAdmin(fromId)) {
      await recordAudit(this.database, fromId, 'telegram_denied', null, {
        command: text.split(/\s+/)[0]?.slice(0, 32) ?? '',
      })
      return
    }

    const [rawCommand = '', ...args] = text.split(/\s+/)
    if (!rawCommand.startsWith('/')) {
      const pending = this.awaiting.get(fromId)
      if (pending && Date.now() - pending.at < PROMPT_TTL_MS) {
        return this.send(message.chat.id, await this.handleTyped(pending, text, fromId))
      }
      this.awaiting.delete(fromId)
      if (!this.askHermes) return this.send(message.chat.id, { text: 'Ketik /menu untuk membuka tombol.' })
      // Not awaited: a slow answer must not block button presses and commands.
      void this.answer(message.chat.id, fromId, text).catch((error) => this.logError('ask', error))
      return
    }
    this.awaiting.delete(fromId)
    const command = rawCommand.replace(/@.*$/, '').toLowerCase()
    await this.send(message.chat.id, await this.run(command, args, fromId))
  }

  private async handleCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chat = query.message?.chat
    const messageId = query.message?.message_id
    const data = query.data ?? ''
    if (!chat || chat.type !== 'private' || !this.isAdmin(query.from.id)) {
      await recordAudit(this.database, query.from.id, 'telegram_denied', null, {
        callback: data.slice(0, 32),
      })
      return
    }
    await this.api('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)
    if (data === 'noop') return
    const reply = await this.route(data, query.from.id)
    // Navigation edits the message in place so the chat does not fill up with menus.
    await this.show(chat.id, reply, messageId)
  }

  private async answer(chatId: number, adminId: number, question: string): Promise<void> {
    if (this.asking.has(adminId)) {
      return this.send(chatId, { text: 'Pertanyaan sebelumnya masih diproses. Tunggu sebentar.' })
    }
    this.asking.add(adminId)
    try {
      await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined)
      const result = await this.askHermes!(adminId, question.slice(0, 2000))
      await recordAudit(this.database, adminId, 'ask_hermes', null, {
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
      })
      await this.send(chatId, { text: result.text || 'Tidak ada jawaban.' })
    } catch (error) {
      this.logError('ask', error)
      await this.send(chatId, { text: 'Hermes tidak merespons. Coba lagi sebentar lagi, atau cek /status.' })
    } finally {
      this.asking.delete(adminId)
    }
  }

  /* ---------- typed answers to prompts ---------- */

  private prompt(actor: number, awaiting: Awaiting, text: string, cancelTo: string): Reply {
    this.awaiting.set(actor, { ...awaiting, at: Date.now() })
    return { text: `${text}\nBatas waktu 5 menit.`, keyboard: [[{ text: '❌ Batal', callback_data: cancelTo }]] }
  }

  private async handleTyped(pending: Awaiting, text: string, actor: number): Promise<Reply> {
    const clean = text.replace(/\s+/g, ' ').trim()
    switch (pending.kind) {
      case 'invite':
        this.awaiting.delete(actor)
        return this.invite(clean, actor)

      case 'groupsearch': {
        this.awaiting.delete(actor)
        const editor = this.liveEditor(actor)
        if (!editor) return this.editorExpired()
        setQuery(editor, clean)
        return renderEditor(editor)
      }

      case 'range': {
        const range = parseTypedRange(text, new Date())
        if (!range) {
          return {
            text: 'Format tanggal tidak dikenali. Contoh: 2026-10-01 2026-10-15 atau 01/10/2026 15/10/2026 (maksimal 366 hari, tidak boleh di masa depan).',
            keyboard: [[this.rangeCancel(pending.scope)]],
          }
        }
        this.awaiting.delete(actor)
        return pending.scope ? this.tenantUsageScreen(pending.scope, range) : this.usageScreen(range)
      }

      case 'rename': {
        const name = clean.slice(0, 80)
        if (!name) return { text: 'Nama tidak boleh kosong.', keyboard: [[{ text: '❌ Batal', callback_data: `t:${pending.tenantId}` }]] }
        this.awaiting.delete(actor)
        await renameTenant(this.database, pending.tenantId, name)
        await recordAudit(this.database, actor, 'tenant_renamed', pending.tenantId, { name })
        return this.tenantScreen(pending.tenantId)
      }

      case 'notes': {
        this.awaiting.delete(actor)
        await setTenantNotes(this.database, pending.tenantId, text.trim().slice(0, 500) || null)
        await recordAudit(this.database, actor, 'tenant_notes', pending.tenantId, {})
        return this.tenantScreen(pending.tenantId)
      }

      case 'broadcast': {
        const body = text.trim().slice(0, MAX_BROADCAST_CHARS)
        if (!body) return { text: 'Pesan tidak boleh kosong.' }
        this.awaiting.delete(actor)
        this.broadcastDrafts.set(actor, { target: pending.target, text: body })
        const recipients = await this.broadcastTargets(pending.target)
        return {
          text:
            `Pratinjau — dikirim ke ${recipients.length === 1 ? recipients[0]!.name : `${recipients.length} pelanggan aktif`}, ` +
            `lewat self-chat WhatsApp mereka:\n\nAksis: ${body}`,
          keyboard: [
            [
              { text: '📤 Kirim', callback_data: 'bs' },
              { text: '❌ Batal', callback_data: 'm:menu' },
            ],
          ],
        }
      }

      case 'admin': {
        if (!this.isOwner(actor)) return { text: 'Hanya owner yang bisa menambah admin.' }
        if (!/^\d{5,15}$/.test(clean)) {
          return {
            text: 'ID Telegram harus berupa angka (5–15 digit). Admin baru bisa mengetahui ID-nya lewat @userinfobot.',
            keyboard: [[{ text: '❌ Batal', callback_data: 'm:adm' }]],
          }
        }
        this.awaiting.delete(actor)
        await addDbAdmin(this.database, Number(clean), actor)
        await this.refreshAdmins()
        await recordAudit(this.database, actor, 'admin_added', null, { telegramId: Number(clean) })
        return this.adminsScreen(actor)
      }
    }
  }

  /* ---------- callbacks ---------- */

  private async route(data: string, actor: number): Promise<Reply> {
    const [kind = '', first = '', second = '', third = ''] = data.split(':')
    const id = isUuid(first) ? first : null
    // Leaving a prompt screen cancels the typed input it was waiting for.
    const opensPrompt =
      (kind === 'm' && first === 'invite') ||
      ['uc', 'tc', 'rn', 'nt', 'bt', 'ada', 'gq'].includes(kind)
    if (!opensPrompt) this.awaiting.delete(actor)

    switch (kind) {
      case 'm':
        return this.routeMenu(first, second, actor)
      case 't':
        return id ? this.tenantScreen(id, second) : this.unknown()
      case 'u':
        return this.usageScreen(rangeFromKey(first, new Date()) ?? presetRange(7, new Date())!)
      case 'uc':
        return this.prompt(actor, { kind: 'range', scope: null }, 'Ketik rentang tanggal (WIB), misalnya:\n2026-10-01 2026-10-15\n01/10/2026 15/10/2026\nSatu tanggal saja = satu hari.', 'u:d7')
      case 'tu':
        return id ? this.tenantUsageScreen(id, rangeFromKey(second, new Date()) ?? presetRange(7, new Date())!) : this.unknown()
      case 'tc':
        return id
          ? this.prompt(actor, { kind: 'range', scope: id }, 'Ketik rentang tanggal (WIB), misalnya:\n2026-10-01 2026-10-15\n01/10/2026 15/10/2026\nSatu tanggal saja = satu hari.', `tu:${id}:d7`)
          : this.unknown()
      case 'en':
        return id ? this.changeStatus(id, 'active', actor) : this.unknown()
      case 'ai':
        return id ? this.sendAccessInfo(id, actor) : this.unknown()
      case 'dis':
        return id ? this.confirmDisable(id) : this.unknown()
      case 'disok':
        return id ? this.changeStatus(id, 'disabled', actor) : this.unknown()
      case 'del':
        return id ? this.confirmDelete(id) : this.unknown()
      case 'delok':
        return id ? this.deleteTenant(id, actor) : this.unknown()
      case 'rp':
        return id ? this.confirmRepair(id) : this.unknown()
      case 'rpok':
        return id ? this.repair(id, actor) : this.unknown()
      case 'rn':
        return id ? this.prompt(actor, { kind: 'rename', tenantId: id }, 'Ketik nama baru untuk pelanggan ini.', `t:${id}`) : this.unknown()
      case 'nt':
        return id ? this.prompt(actor, { kind: 'notes', tenantId: id }, 'Ketik catatan untuk pelanggan ini (maksimal 500 karakter). Catatan lama akan diganti.', `t:${id}`) : this.unknown()
      case 'ntx':
        if (!id) return this.unknown()
        await setTenantNotes(this.database, id, null)
        return this.tenantScreen(id)
      case 'ge':
        return id ? this.openGroupEditor(id, actor) : this.unknown()
      case 'gt':
      case 'gp':
      case 'gc':
      case 'gq':
      case 'gs':
      case 'gx':
        return this.groupEditorAction(kind, first, actor)
      case 'pt':
        return id ? this.startTrialFor(id, actor) : this.unknown()
      case 'sb':
        return id ? this.subscriptionScreen(id) : this.unknown()
      case 'sp':
        return id ? this.monthsScreen(id, second) : this.unknown()
      case 'sk':
        return id ? this.confirmGrant(id, second, Number(third)) : this.unknown()
      case 'sg':
        return id ? this.grant(id, second, Number(third), actor) : this.unknown()
      case 'wd':
        return id ? this.disconnectWhatsApp(id, actor) : this.unknown()
      case 'wr':
        return id ? this.reconnectWhatsApp(id, actor) : this.unknown()
      case 'lm':
        return id ? this.limitScreen(id) : this.unknown()
      case 'ld':
      case 'lb':
        return id ? this.changeLimit(id, kind === 'ld' ? 'daily' : 'monthly', second, actor) : this.unknown()
      case 'fr':
        return id ? this.retryFailed(id, actor) : this.unknown()
      case 'lr':
        return isUuid(second) ? this.leadAction(first, second, actor) : this.unknown()
      case 'tn':
        return id ? this.newLink(id, actor) : this.unknown()
      case 'tr':
        return id ? this.revokeLinks(id, actor) : this.unknown()
      // Buttons from before the invitations moved into the customer card still point at an invitation.
      case 'iv':
      case 'ivn':
      case 'ivr': {
        const invitation = isUuid(first) ? await getOpenInvitation(this.database, first) : null
        if (!invitation) return this.tenantsScreen()
        if (kind === 'ivn') return this.newLink(invitation.tenantId, actor)
        if (kind === 'ivr') return this.revokeLinks(invitation.tenantId, actor)
        return this.tenantScreen(invitation.tenantId)
      }
      case 'bt':
        return this.broadcastPrompt(first, actor)
      case 'bs':
        return this.sendBroadcast(actor)
      case 'ada':
        return this.isOwner(actor)
          ? this.prompt(actor, { kind: 'admin' }, 'Ketik ID Telegram (angka) admin baru. Dia perlu menekan Start di bot ini agar bisa menerima pesan.', 'm:adm')
          : { text: 'Hanya owner yang bisa menambah admin.', keyboard: [[BACK_MENU]] }
      case 'adr':
        return /^\d+$/.test(first) ? this.confirmRemoveAdmin(Number(first), actor) : this.unknown()
      case 'adrok':
        return /^\d+$/.test(first) ? this.removeAdmin(Number(first), actor) : this.unknown()
      default:
        return this.unknown()
    }
  }

  private unknown(): Reply {
    return { text: 'Tombol tidak dikenal.', keyboard: [[BACK_MENU]] }
  }

  private async routeMenu(target: string, arg: string, actor: number): Promise<Reply> {
    switch (target) {
      case 'menu':
        return this.run('/menu', [], actor)
      case 'status':
        return this.run('/status', [], actor)
      case 'tenants':
        return this.tenantsScreen(arg)
      case 'attn':
        return this.attentionScreen()
      case 'system':
        return { text: '⚙️ System', keyboard: [...SYSTEM_MENU, [BACK_MENU]] }
      case 'failed':
        return this.failedScreen()
      case 'leads':
        return this.leadsScreen()
      case 'dash':
        return this.dashboardLink(actor)
      case 'inv': // the old Invites menu: its customers are in the list now
        return this.tenantsScreen()
      case 'bc':
        return this.broadcastTargetsScreen()
      case 'adm':
        return this.adminsScreen(actor)
      case 'bill':
        return this.billingScreen()
      case 'sys':
        return this.systemScreen(arg === 'pair', actor)
      case 'usage': // buttons in messages sent before the single usage button existed
        return this.usageScreen(presetRange(Number(arg) || 7, new Date()) ?? presetRange(7, new Date())!)
      case 'invite':
        return this.prompt(actor, { kind: 'invite' }, 'Ketik nama pelanggan baru.', 'm:menu')
      default:
        return this.unknown()
    }
  }

  /* ---------- choosing a plan when a customer's WhatsApp is connected ---------- */

  /** Tells the admins that a customer is waiting for a plan; the buttons make the choice. Basic and Pro continue in the usual months screen. */
  async notifyPlanRequest(tenant: { id: string; name: string }): Promise<void> {
    await this.notify(
      `📱 WhatsApp tersambung: ${tenant.name}\nPilih paket supaya pelanggan bisa lanjut memilih grup.`,
      this.planKeyboard(tenant.id),
    )
  }

  private planKeyboard(tenantId: string): Array<Array<Button | UrlButton>> {
    return [
      [{ text: '🎁 Trial 14 days', callback_data: `pt:${tenantId}` }],
      [
        { text: 'Basic', callback_data: `sp:${tenantId}:basic` },
        { text: 'Pro', callback_data: `sp:${tenantId}:pro` },
      ],
    ]
  }

  private async startTrialFor(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.unknown()
    const started = await startTrial(this.database, tenant.id)
    await recordAudit(this.database, actor, 'trial_started', tenant.id, { started })
    if (started) await enqueueBroadcast(this.database, [tenant.id], 'Paket uji coba 14 hari Aksis AI Anda sudah siap. Lanjutkan memilih grup proyek di halaman onboarding.')
    const subscription = await getSubscription(this.database, tenant.id)
    return {
      text: started
        ? `✅ Uji coba 14 hari dimulai untuk ${tenant.name}. Pelanggan lanjut memilih grup.`
        : `ℹ️ ${tenant.name} sudah punya paket: ${describeSubscription(subscription, new Date())}`,
      keyboard: [[{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }]],
    }
  }

  /* ---------- web dashboard ---------- */

  /** A one-time link to the web dashboard. The link is only in the button (never in the text), and its token travels in the # part, which no server or preview ever receives. */
  private async dashboardLink(actor: number): Promise<Reply> {
    const { token } = await createLoginLink(this.database, actor)
    return {
      text: `🖥 Dashboard\nLink masuk berlaku ${LOGIN_LINK_MINUTES} menit dan hanya bisa dipakai sekali. Jangan dibagikan.`,
      keyboard: [[{ text: '🖥 Open dashboard', url: `${this.options.publicBaseUrl}/dashboard/masuk#${token}` }], [BACK_MENU]],
    }
  }

  /* ---------- access requests (landing page form) ---------- */

  /** Tells the admins about a new request; the buttons act on it. */
  async notifyNewLead(lead: Lead): Promise<void> {
    await this.notify(this.leadText(lead, '📥 Permintaan akses baru'), this.leadKeyboard(lead))
  }

  private leadText(lead: Lead, title: string): string {
    const state = lead.status === 'contacted' ? 'sudah dihubungi' : lead.status === 'rejected' ? 'ditolak' : 'baru'
    return `${title}\n${lead.name}\n+${lead.phone}\nMasuk ${formatTime(lead.createdAt)} · ${state}`
  }

  private leadKeyboard(lead: Lead): Array<Array<Button | UrlButton>> {
    const hello = `Halo ${lead.name}, terima kasih sudah meminta akses Aksis AI. Kami dari tim Aksis ingin mengenalkan layanannya dan menyiapkan akses Anda.`
    return [
      [{ text: '✅ Create invite', callback_data: `lr:i:${lead.id}` }],
      [{ text: '💬 Chat on WhatsApp', url: whatsappLink(lead.phone, hello) }],
      [
        { text: '📞 Mark contacted', callback_data: `lr:c:${lead.id}` },
        { text: '🚫 Reject', callback_data: `lr:r:${lead.id}` },
      ],
    ]
  }

  private async leadsScreen(): Promise<Reply> {
    const leads = await listOpenLeads(this.database)
    if (leads.length === 0) return { text: '📥 Tidak ada permintaan akses yang menunggu.', keyboard: [[BACK_MENU]] }
    return {
      text: `📥 Permintaan akses (${leads.length})\nPilih salah satu.`,
      keyboard: [
        ...leads.map((lead) => [
          { text: `${lead.status === 'new' ? '🆕' : '📞'} ${lead.name} · +${lead.phone}`.slice(0, 48), callback_data: `lr:v:${lead.id}` },
        ]),
        [BACK_MENU],
      ],
    }
  }

  private async leadScreen(id: string, note?: string): Promise<Reply> {
    const lead = await getLead(this.database, id)
    if (!lead) return { text: 'Permintaan ini sudah diproses atau dihapus.', keyboard: [[{ text: '📥 Requests', callback_data: 'm:leads' }, BACK_MENU]] }
    return { text: this.leadText(lead, note ?? '📥 Permintaan akses'), keyboard: this.leadKeyboard(lead) }
  }

  private async leadAction(action: string, id: string, actor: number): Promise<Reply> {
    switch (action) {
      case 'v':
        return this.leadScreen(id)
      case 'c': {
        const lead = await setLeadStatus(this.database, id, 'contacted')
        if (!lead) return this.leadScreen(id)
        await recordAudit(this.database, actor, 'lead_contacted', null, { leadId: id })
        return this.leadScreen(id, '📞 Ditandai sudah dihubungi')
      }
      case 'r': {
        const lead = await setLeadStatus(this.database, id, 'rejected')
        if (!lead) return this.leadScreen(id)
        await recordAudit(this.database, actor, 'lead_rejected', null, { leadId: id })
        return { text: '🚫 Permintaan ditolak. Datanya dihapus otomatis dalam 30 hari.', keyboard: [[{ text: '📥 Requests', callback_data: 'm:leads' }, BACK_MENU]] }
      }
      case 'i':
        return this.leadInvite(id, actor)
      default:
        return this.unknown()
    }
  }

  /** Makes the invitation for the number the person gave, then removes the request (the data is on the customer now). */
  private async leadInvite(id: string, actor: number): Promise<Reply> {
    const lead = await claimLead(this.database, id)
    if (!lead) return { text: 'Permintaan ini sudah diproses atau dihapus.', keyboard: [[{ text: '📥 Requests', callback_data: 'm:leads' }, BACK_MENU]] }
    let invite: Awaited<ReturnType<typeof createInvitation>>
    try {
      invite = await createInvitation(this.database, lead.name.slice(0, 80), actor, lead.phone)
    } catch (error) {
      await restoreLead(this.database, lead).catch(() => undefined)
      throw error
    }
    await recordAudit(this.database, actor, 'invite_created', invite.tenantId, { fromLead: true })
    const link = `${this.options.publicBaseUrl}/join/${invite.token}`
    return {
      text: `Undangan untuk ${lead.name}\n${link}\nBerlaku sampai ${formatTime(invite.expiresAt)}, sekali pakai.`,
      keyboard: [
        ...this.sendViaWhatsApp(lead.phone, lead.name, link, invite.expiresAt),
        [{ text: '👤 Customer', callback_data: `t:${invite.tenantId}` }, { text: '👥 Pelanggan', callback_data: 'm:tenants' }, BACK_MENU],
      ],
    }
  }

  /* ---------- customers ---------- */

  private async mainMenu(): Promise<Button[][]> {
    // A failing lookup must never take the menu away.
    const items = await attentionItems(this.database, (id) => this.hooks.connectionOf?.(id)).catch(() => [])
    const leads = await countNewLeads(this.database).catch(() => 0)
    return mainMenu(items.length, leads)
  }

  private async attentionScreen(): Promise<Reply> {
    const items = await attentionItems(this.database, (id) => this.hooks.connectionOf?.(id))
    if (items.length === 0) return { text: 'Tidak ada yang perlu perhatian. ✅', keyboard: [[BACK_MENU]] }
    const shown = items.slice(0, 15)
    return {
      text: `🔔 Needs attention (${items.length}) — pilih untuk membuka pelanggan:`,
      keyboard: [
        ...shown.map((item) => [{ text: `${ATTENTION_ICON[item.kind]} ${item.name} · ${item.detail}`.slice(0, 48), callback_data: `t:${item.tenantId}` }]),
        [{ text: '🔄 Perbarui', callback_data: 'm:attn' }, BACK_MENU],
      ],
    }
  }

  private async tenantsScreen(filter = 'all'): Promise<Reply> {
    const [all, billing] = await Promise.all([listTenants(this.database), billingOverview(this.database, new Date())])
    const now = Date.now()
    const billingOf = new Map(billing.map((row) => [row.tenantId, row]))
    const matches: Record<string, (tenant: (typeof all)[number]) => boolean> = {
      all: () => true,
      onb: (tenant) => tenant.status === 'invited' || tenant.status === 'onboarding',
      act: (tenant) => tenant.status === 'active',
      end: (tenant) => {
        const row = billingOf.get(tenant.id)
        return tenant.status === 'active' && !!row?.endsAt && (row.status === 'trial' || row.status === 'active') && row.endsAt.getTime() < now + 7 * 86_400_000
      },
      exp: (tenant) => ['grace', 'expired'].includes(billingOf.get(tenant.id)?.status ?? ''),
      dis: (tenant) => tenant.status === 'disabled',
    }
    const active = TENANT_FILTERS.some(([key]) => key === filter) ? filter : 'all'
    const tenants = all.filter(matches[active]!)
    const chip = ([key, label]: (typeof TENANT_FILTERS)[number]): Button => ({
      text: `${key === active ? '• ' : ''}${label}${key === 'all' ? '' : ` (${all.filter(matches[key]!).length})`}`,
      callback_data: `m:tenants:${key}`,
    })
    const keyboard: Button[][] = [TENANT_FILTERS.slice(0, 3).map(chip), TENANT_FILTERS.slice(3).map(chip)]
    keyboard.push(
      ...tenants.map((tenant, index): Button[] => [
        {
          text: `${index + 1}. ${STATUS_ICON[tenant.status]} ${tenant.name}${tenant.status === 'invited' ? ' · belum dibuka' : ''}`.slice(0, 48),
          callback_data: `t:${tenant.id}`,
        },
      ]),
    )
    keyboard.push([{ text: '➕ Invite customer', callback_data: 'm:invite' }, BACK_MENU])
    return {
      text: tenants.length === 0 ? 'Tidak ada pelanggan di filter ini.' : `Pelanggan (${tenants.length}) — pilih untuk melihat aksi:`,
      keyboard,
    }
  }

  private async tenantScreen(tenantId: string, section = ''): Promise<Reply> {
    const tenant = await getTenantDetail(this.database, tenantId)
    if (!tenant) return this.tenantsScreen()
    const [limits] = await limitStatuses(this.database, tenantId)
    const notes = await getTenantNotes(this.database, tenantId)
    const subscription = await getSubscription(this.database, tenantId)
    const connection = this.hooks.connectionOf?.(tenant.id) ?? '—'
    const beforeActive = tenant.status === 'invited' || tenant.status === 'onboarding'
    const link = beforeActive ? await getTenantInvitation(this.database, tenantId) : null
    const linkOpen = link !== null && !link.used && !link.expired
    const lines = [
      `${STATUS_ICON[tenant.status]} ${tenant.name}`,
      `Status: ${tenant.status}${limits?.paused ? ' (dijeda: batas pemakaian)' : ''}`,
      `Kontak: ${tenant.contactName ?? '—'}`,
      `Dibuat: ${formatTime(tenant.createdAt)}`,
      `Onboarding: ${tenant.onboardedAt ? 'selesai' : 'belum selesai'}`,
      ...(beforeActive
        ? [`Link onboarding: ${link?.used ? 'sudah dibuka pelanggan' : linkOpen ? `berlaku sampai ${formatTime(link!.expiresAt)}` : link ? 'kedaluwarsa' : 'belum ada yang aktif'}`]
        : []),
      `Langganan: ${describeSubscription(subscription, new Date())}`,
      `WhatsApp: ${connection}${tenant.whatsappJid ? ` (…${tenant.whatsappJid.replace(/\D/g, '').slice(-4)})` : ''}`,
      `Pesan: ${tenant.selfMessages} self-chat, ${tenant.groupMessages} grup`,
      `Event proyek: ${tenant.events}`,
      `Grup dibaca: ${tenant.groups.length === 0 ? '—' : tenant.groups.join(', ')}`,
      ...(limits ? [`Batas: ${formatLimits(limits.dailyLimit, limits.monthlyLimit)}`] : []),
      ...(notes ? [`Catatan: ${notes.slice(0, 300)}`] : []),
    ]
    const toggle: Button =
      tenant.status === 'disabled'
        ? { text: '✅ Set active', callback_data: `en:${tenant.id}` }
        : tenant.status === 'active'
          ? { text: '⛔ Set disabled', callback_data: `dis:${tenant.id}` }
          : { text: '✅ Set active (skip onboarding)', callback_data: `en:${tenant.id}` }
    const back: Button[] = section
      ? [{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }]
      : [{ text: '⬅️ Customers', callback_data: 'm:tenants' }]
    const sections: Record<string, Button[][]> = {
      // Access: how the customer gets in and stays connected.
      a: [
        ...(tenant.status === 'active' && this.hooks.sendAccessInfo ? [[{ text: '📲 Send access info again', callback_data: `ai:${tenant.id}` }]] : []),
        ...(beforeActive
          ? [[{ text: '🔗 New link', callback_data: `tn:${tenant.id}` }, ...(linkOpen ? [{ text: '🚫 Revoke link', callback_data: `tr:${tenant.id}` }] : [])]]
          : []),
        [
          { text: '⏏️ WA disconnect', callback_data: `wd:${tenant.id}` },
          { text: '🔄 WA re-pair (wipe)', callback_data: `rp:${tenant.id}` },
        ],
        ...(this.hooks.reconnectWhatsApp && connection === 'tidak aktif' && ['active', 'onboarding'].includes(tenant.status)
          ? [[{ text: '🔌 WA reconnect', callback_data: `wr:${tenant.id}` }]]
          : []),
      ],
      // Plan: what they pay and what they may use.
      p: [
        [{ text: '💳 Subscription', callback_data: `sb:${tenant.id}` }],
        [
          { text: '💰 Usage', callback_data: `tu:${tenant.id}:d7` },
          { text: '🚦 Limits', callback_data: `lm:${tenant.id}` },
        ],
      ],
      // Projects: what Aksis reads and how the customer is described.
      j: [
        ...(this.hooks.groups ? [[{ text: '🗂 Change groups', callback_data: `ge:${tenant.id}` }]] : []),
        [
          { text: '✏️ Rename', callback_data: `rn:${tenant.id}` },
          { text: '📝 Notes', callback_data: `nt:${tenant.id}` },
        ],
        ...(notes ? [[{ text: '🧹 Clear notes', callback_data: `ntx:${tenant.id}` }]] : []),
      ],
      // Account: the status itself.
      c: [[toggle], [{ text: '🗑 Delete tenant', callback_data: `del:${tenant.id}` }]],
    }
    const group = sections[section]
    return {
      text: lines.join('\n'),
      keyboard: group
        ? [...group, back]
        : [
            [
              { text: '🔑 Access', callback_data: `t:${tenant.id}:a` },
              { text: '💳 Plan', callback_data: `t:${tenant.id}:p` },
            ],
            [
              { text: '🗂 Projects', callback_data: `t:${tenant.id}:j` },
              { text: '👤 Account', callback_data: `t:${tenant.id}:c` },
            ],
            back,
          ],
    }
  }

  /* ---------- subscriptions ---------- */

  private async systemScreen(pair: boolean, actor: number): Promise<Reply> {
    const system = this.hooks.system
    if (!system) return { text: 'WhatsApp sistem belum diatur (SYSTEM_WHATSAPP_PHONE).', keyboard: [[BACK_MENU]] }
    const refresh: Button = { text: '🔄 Refresh', callback_data: 'm:sys' }
    let note = ''
    if (pair) {
      const code = await system.pair()
      await recordAudit(this.database, actor, 'system_whatsapp_pair', null, { issued: code !== null })
      note = code
        ? `Kode pairing: ${code}\nDi HP pemilik nomor: WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon, lalu ketik kodenya. Kode berlaku beberapa menit.`
        : 'Kode pairing belum bisa dibuat (sudah tertaut atau belum siap). Tekan Refresh lalu coba lagi.'
    }
    const status = system.status()
    const lines = [
      '📱 System WhatsApp',
      `Nomor: ${status.phone}`,
      `Status: ${status.connection}${status.paired ? '' : ' (belum tertaut)'}`,
      ...(status.lastError ? [`Error terakhir: ${status.lastError}`] : []),
      'Dipakai untuk kode login, info akses dan pengingat langganan.',
      ...(note ? ['', note] : []),
    ]
    return {
      text: lines.join('\n'),
      keyboard: [
        [...(status.connection === 'connected' ? [] : [{ text: '🔗 Pair number', callback_data: 'm:sys:pair' }]), refresh],
        [BACK_MENU],
      ],
    }
  }

  private async billingScreen(): Promise<Reply> {
    const now = new Date()
    const rows = await billingOverview(this.database, now)
    const mrr = await monthlyRecurringIdr(this.database, now)
    const lines = rows.map(
      (row) =>
        `${BILLING_ICON[row.status]} ${row.name} — ${row.planName ?? 'belum ada'}${row.endsAt ? `, sampai ${formatDate(row.endsAt)}` : ''} (${row.status})`,
    )
    return {
      text: [
        '💳 Billing',
        rows.length === 0 ? 'Belum ada pelanggan.' : lines.join('\n'),
        `Pendapatan berulang aktif: Rp ${mrr.toLocaleString('id-ID')}/bulan`,
      ].join('\n\n'),
      keyboard: [
        ...rows.slice(0, 20).map((row) => [{ text: `${BILLING_ICON[row.status]} ${row.name}`.slice(0, 48), callback_data: `sb:${row.tenantId}` }]),
        [BACK_MENU],
      ],
    }
  }

  private async subscriptionScreen(tenantId: string): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    const subscription = await getSubscription(this.database, tenant.id)
    const plans = await listSellablePlans(this.database)
    return {
      text: `💳 ${tenant.name}\n${describeSubscription(subscription, new Date())}\n\nPilih paket untuk mengaktifkan atau memperpanjang:`,
      keyboard: [
        plans.map((plan) => ({
          text: `${plan.name} (${plan.groupLimit} grup)`,
          callback_data: `sp:${tenant.id}:${plan.code}`,
        })),
        [{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }],
      ],
    }
  }

  private async monthsScreen(tenantId: string, planCode: string): Promise<Reply> {
    const plan = (await listSellablePlans(this.database)).find((entry) => entry.code === planCode)
    if (!plan) return this.subscriptionScreen(tenantId)
    return {
      text: `Paket ${plan.name}: berapa bulan?`,
      keyboard: [
        MONTH_CHOICES.map((months) => ({
          text: `${months} bulan`,
          callback_data: `sk:${tenantId}:${plan.code}:${months}`,
        })),
        [{ text: 'Batal', callback_data: `sb:${tenantId}` }],
      ],
    }
  }

  private async confirmGrant(tenantId: string, planCode: string, months: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    const plan = (await listSellablePlans(this.database)).find((entry) => entry.code === planCode)
    if (tenant.kind !== 'found' || !plan || !MONTH_CHOICES.includes(months)) return this.unknown()
    return {
      text: `Aktifkan paket ${plan.name} untuk ${tenant.name} selama ${months} bulan? Pastikan pembayaran sudah diterima.`,
      keyboard: [
        [
          { text: '✅ Ya, aktifkan', callback_data: `sg:${tenant.id}:${plan.code}:${months}` },
          { text: 'Batal', callback_data: `sb:${tenant.id}` },
        ],
      ],
    }
  }

  private async grant(tenantId: string, planCode: string, months: number, actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found' || !MONTH_CHOICES.includes(months)) return this.unknown()
    const subscription = await grantSubscription(this.database, tenant.id, planCode, months, actor)
    if (!subscription) return this.unknown()
    await recordAudit(this.database, actor, 'subscription_granted', tenant.id, { plan: planCode, months })
    await enqueueBroadcast(
      this.database,
      [tenant.id],
      `Langganan Aksis AI Anda aktif (paket ${subscription.planName}) sampai ${formatDate(subscription.endsAt)}. Terima kasih!`,
    )
    return {
      text: `✅ ${tenant.name}: ${describeSubscription(subscription, new Date())}`,
      keyboard: [[{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }]],
    }
  }

  /* ---------- group editor ---------- */

  private liveEditor(actor: number): GroupEditor | null {
    const editor = this.groupEditors.get(actor)
    if (!editor) return null
    if (isExpired(editor)) {
      this.groupEditors.delete(actor)
      return null
    }
    editor.at = Date.now()
    return editor
  }

  private editorExpired(): Reply {
    return {
      text: 'Sesi ganti grup sudah berakhir. Buka lagi dari layar pelanggan.',
      keyboard: [[{ text: '👥 Pelanggan', callback_data: 'm:tenants' }, BACK_MENU]],
    }
  }

  private async openGroupEditor(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await getTenantDetail(this.database, tenantId)
    if (!tenant) return this.tenantsScreen()
    const back: Button[][] = [[{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }]]
    if (!this.hooks.groups) return { text: 'Fitur ganti grup belum tersedia.', keyboard: back }
    if (tenant.status === 'disabled') {
      return { text: `${tenant.name} sedang nonaktif. Aktifkan dulu sebelum mengganti grup.`, keyboard: back }
    }
    let groups: StoredGroup[]
    try {
      groups = await this.hooks.groups.list(tenant.id)
    } catch {
      return {
        text: `WhatsApp ${tenant.name} belum tersambung, jadi daftar grup belum bisa dibuka. Gunakan WA re-pair bila koneksinya perlu dipulihkan.`,
        keyboard: back,
      }
    }
    // Viewing a customer's group names is sensitive: record the access, never the names.
    await recordAudit(this.database, actor, 'groups_viewed', tenant.id, { count: groups.length })
    const limit = (await this.hooks.groups.limit?.(tenant.id)) ?? GROUP_LIMIT
    const editor = newEditor(tenant.id, tenant.name, groups, Date.now(), limit)
    this.groupEditors.set(actor, editor)
    return renderEditor(editor)
  }

  private async groupEditorAction(kind: string, arg: string, actor: number): Promise<Reply> {
    const editor = this.liveEditor(actor)
    if (!editor) return this.editorExpired()

    switch (kind) {
      case 'gt': {
        const result = toggleGroup(editor, Number(arg))
        return renderEditor(
          editor,
          result === 'limit' ? `Batas ${editor.limit} grup tercapai. Lepas satu grup dulu.` : undefined,
        )
      }
      case 'gp':
        setPage(editor, Number(arg))
        return renderEditor(editor)
      case 'gc':
        setQuery(editor, '')
        return renderEditor(editor)
      case 'gq':
        return this.prompt(actor, { kind: 'groupsearch' }, 'Ketik sebagian nama grup yang dicari.', 'gp:0')
      case 'gx':
        this.groupEditors.delete(actor)
        return this.tenantScreen(editor.tenantId)
      case 'gs':
        return this.saveGroupEditor(editor, actor)
      default:
        return this.unknown()
    }
  }

  private async saveGroupEditor(editor: GroupEditor, actor: number): Promise<Reply> {
    let result: SaveGroupsResult
    try {
      result = await this.hooks.groups!.save(editor.tenantId, [...editor.selected])
    } catch {
      return renderEditor(editor, 'WhatsApp terputus, pilihan belum disimpan. Coba lagi sebentar lagi.')
    }
    if (!result.ok) return renderEditor(editor, result.reason)
    this.groupEditors.delete(actor)
    await recordAudit(this.database, actor, 'groups_changed', editor.tenantId, { count: result.count })
    return {
      text:
        `✅ Grup ${editor.tenantName} diperbarui: ${result.count} grup dibaca.\n` +
        'Grup yang dilepas berhenti dibaca, data lamanya tetap tersimpan. Grup baru dibaca mulai sekarang.',
      keyboard: [[{ text: '⬅️ Back', callback_data: `t:${editor.tenantId}` }]],
    }
  }

  private async confirmDisable(tenantId: string): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    return {
      text: `Yakin nonaktifkan ${tenant.name}? AI berhenti memproses pesannya, koneksi WhatsApp ditutup, dan sesi webnya dicabut.`,
      keyboard: [
        [
          { text: 'Ya, nonaktifkan', callback_data: `disok:${tenant.id}` },
          { text: 'Batal', callback_data: `t:${tenant.id}` },
        ],
      ],
    }
  }

  private async confirmDelete(tenantId: string): Promise<Reply> {
    const tenant = await getTenantDetail(this.database, tenantId)
    if (!tenant) return this.tenantsScreen()
    return {
      text:
        `HAPUS PERMANEN ${tenant.name}?\n` +
        `Terhapus: ${tenant.selfMessages + tenant.groupMessages} pesan, ${tenant.events} event, semua proyek, run analisis, dan sesi WhatsApp (perangkat ditautkan akan diputus).\n` +
        'Tidak bisa dikembalikan.',
      keyboard: [
        [
          { text: '🗑 Ya, hapus permanen', callback_data: `delok:${tenant.id}` },
          { text: 'Batal', callback_data: `t:${tenant.id}` },
        ],
      ],
    }
  }

  private async deleteTenant(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    // Close the connection first so nothing is written while the rows are removed.
    await this.hooks.removeSession?.(tenant.id)
    await recordAudit(this.database, actor, 'tenant_deleted', tenant.id, { name: tenant.name })
    const deleted = await deleteTenantData(this.database, tenant.id)
    return {
      text: deleted
        ? `${deleted.name} dihapus permanen (${deleted.messages} pesan).`
        : 'Pelanggan sudah tidak ada.',
      keyboard: [[{ text: '⬅️ Daftar pelanggan', callback_data: 'm:tenants' }]],
    }
  }

  private async confirmRepair(tenantId: string): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    return {
      text:
        `Re-pair WhatsApp ${tenant.name}?\n` +
        'Sesi WhatsApp sekarang dihapus dan perangkat tertaut diputus, onboarding diulang dari langkah WhatsApp, dan link undangan lama dicabut. Pesan yang sudah tersimpan tidak hilang.',
      keyboard: [
        [
          { text: 'Ya, re-pair', callback_data: `rpok:${tenant.id}` },
          { text: 'Batal', callback_data: `t:${tenant.id}` },
        ],
      ],
    }
  }

  /** Unlinks and re-pairs WhatsApp so WhatsApp sends its recent history again. */
  private async repair(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    // The linked number is read before the reset forgets it, so the link can go straight to the customer.
    const phone = await getTenantPhone(this.database, tenant.id)
    await this.hooks.removeSession?.(tenant.id)
    await resetOnboarding(this.database, tenant.id)
    const invite = await createInvitationForTenant(this.database, tenant.id, actor, phone)
    await recordAudit(this.database, actor, 'whatsapp_repair', tenant.id, { name: tenant.name })
    const link = `${this.options.publicBaseUrl}/join/${invite.token}`
    return {
      text:
        `Pairing ulang ${tenant.name}: sesi WhatsApp lama diputus.\n` +
        'Buka link ini, tautkan WhatsApp dengan kode, dan pilih grup:\n' +
        `${link}\n` +
        `Berlaku sampai ${formatTime(invite.expiresAt)}, sekali pakai.`,
      keyboard: [...this.sendViaWhatsApp(phone, tenant.name, link, invite.expiresAt), [{ text: '⬅️ Back', callback_data: `t:${tenant.id}` }]],
    }
  }

  private async disconnectWhatsApp(tenantId: string, actor: number): Promise<Reply> {
    await this.hooks.disconnectWhatsApp?.(tenantId)
    await recordAudit(this.database, actor, 'whatsapp_disconnect', tenantId, {})
    return this.withNote(await this.tenantScreen(tenantId), 'Koneksi diputus. Sesi tetap tersimpan; gunakan WA reconnect untuk menyambung lagi.')
  }

  private async reconnectWhatsApp(tenantId: string, actor: number): Promise<Reply> {
    const result = (await this.hooks.reconnectWhatsApp?.(tenantId)) ?? 'unavailable'
    await recordAudit(this.database, actor, 'whatsapp_reconnect', tenantId, { result })
    const notes = {
      started: 'WhatsApp dibuka lagi. Sesi yang masih valid tersambung tanpa QR; jika tidak, gunakan WA re-pair.',
      exists: 'WhatsApp sudah terbuka.',
      full: '⚠️ Slot WhatsApp penuh. Putuskan sesi lain atau naikkan batasnya.',
      unavailable: 'Pelanggan harus berstatus onboarding atau active untuk menyambung WhatsApp.',
    }
    return this.withNote(await this.tenantScreen(tenantId), notes[result])
  }

  private withNote(reply: Reply, note: string): Reply {
    return { ...reply, text: `${note}\n\n${reply.text}` }
  }

  private async changeStatus(tenantId: string, status: 'active' | 'disabled', actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    await setTenantStatus(this.database, tenant.id, status)
    await recordAudit(this.database, actor, `tenant_${status}`, tenant.id, { name: tenant.name })
    // Disabling closes the connection; enabling must open the stored session again.
    if (status === 'active') {
      // The 14-day trial starts when an admin first activates the customer; later activations keep the plan.
      await startTrial(this.database, tenant.id)
      await this.hooks.resumeWhatsApp?.(tenant.id)
      if (this.hooks.sendAccessInfo) {
        const sent = await this.deliverAccessInfo(tenant.id, actor)
        return this.withNote(await this.tenantScreen(tenant.id), sent ? ACCESS_SENT : ACCESS_NOT_SENT)
      }
    }
    return this.tenantScreen(tenant.id)
  }

  private async sendAccessInfo(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await findTenant(this.database, tenantId)
    if (tenant.kind !== 'found') return this.tenantsScreen()
    const sent = await this.deliverAccessInfo(tenantId, actor)
    return this.withNote(await this.tenantScreen(tenantId), sent ? ACCESS_SENT : ACCESS_NOT_SENT)
  }

  /** Tells the customer, in their own WhatsApp chat, where the app is and how to log in. */
  private async deliverAccessInfo(tenantId: string, actor: number): Promise<boolean> {
    const text = accessInfoText(this.options.publicBaseUrl)
    const sent = (await this.hooks.sendAccessInfo?.(tenantId, text).catch(() => false)) ?? false
    await recordAudit(this.database, actor, 'access_info', tenantId, { sent })
    return sent
  }

  private async invite(rawText: string, actor: number): Promise<Reply> {
    // `/invite Studio Satu` is enough. A number after the name (`/invite Studio Satu 0812-3456-7890`) only
    // chooses the recipient of the WhatsApp button in advance; without it WhatsApp asks who to send to.
    const parsed = splitNameAndPhone(rawText)
    const name = parsed.name.slice(0, 80)
    const phone = parsed.phone
    if (!name) return { text: 'Format: /invite <nama pelanggan>', keyboard: [[BACK_MENU]] }
    const invite = await createInvitation(this.database, name, actor, phone)
    // The audit keeps the name only, never the phone number.
    await recordAudit(this.database, actor, 'invite_created', invite.tenantId, { name })
    const link = `${this.options.publicBaseUrl}/join/${invite.token}`
    return {
      text: `Undangan untuk ${name}\n${link}\nBerlaku sampai ${formatTime(invite.expiresAt)}, sekali pakai.`,
      keyboard: [
        ...this.sendViaWhatsApp(phone, name, link, invite.expiresAt),
        [{ text: '👤 Customer', callback_data: `t:${invite.tenantId}` }, { text: '👥 Pelanggan', callback_data: 'm:tenants' }, BACK_MENU],
      ],
    }
  }

  /** A button that opens the admin's own WhatsApp with the invitation message ready; `phone` picks the chat in advance. */
  private sendViaWhatsApp(phone: string | null, name: string, link: string, expiresAt: Date): UrlButton[][] {
    const message = `Halo, ini link untuk mengatur Aksis AI (${name}):\n${link}\nBerlaku sampai ${formatTime(expiresAt)} dan hanya bisa dipakai sekali.`
    return [[{ text: '📲 Send via WhatsApp', url: whatsappLink(phone, message) }]]
  }

  /* ---------- usage ---------- */

  private rangeButtons(active: string, make: (key: string) => string, custom: string): Button[][] {
    const mark = (key: string, text: string): Button => ({
      text: active === key ? `• ${text}` : text,
      callback_data: make(key),
    })
    return [
      [mark('d1', 'Hari ini'), mark('d7', '7 hari'), mark('d30', '30 hari')],
      [{ text: '📅 Custom', callback_data: custom }],
    ]
  }

  private rangeCancel(scope: string | null): Button {
    return { text: '❌ Batal', callback_data: scope ? `tu:${scope}:d7` : 'u:d7' }
  }

  /** "Per jenis" lines: where the AI cost came from (reading groups, private chats, chat answers, project notes). */
  private async kindLines(range: UsageRange, tenantId?: string): Promise<string> {
    const kinds = await usageByKind(this.database, range.from, range.to, tenantId)
    if (kinds.length === 0) return ''
    return `\n\nPer jenis:\n${kinds.map((row) => `• ${USAGE_KIND_LABEL[row.kind] ?? row.kind}: ${row.runs} run, ~$${row.costUsd.toFixed(4)}`).join('\n')}`
  }

  private async usageScreen(range: UsageRange): Promise<Reply> {
    const usage = await usageByTenant(this.database, range.from, range.to)
    const keyboard = [...this.rangeButtons(range.key, (key) => `u:${key}`, 'uc'), [BACK_MENU]]
    if (usage.length === 0) return { text: `Pemakaian — ${range.label}\nBelum ada pelanggan.`, keyboard }
    const lines = usage.map(
      (u) => `${u.name}: ${u.runs} run, ${u.inputTokens} in / ${u.outputTokens} out, ~$${u.costUsd.toFixed(4)}`,
    )
    const total = usage.reduce((sum, u) => sum + u.costUsd, 0)
    const kinds = await this.kindLines(range)
    return { text: `Pemakaian — ${range.label}\n${lines.join('\n')}\nTotal ~$${total.toFixed(4)}${kinds}`, keyboard }
  }

  private async tenantUsageScreen(tenantId: string, range: UsageRange): Promise<Reply> {
    const [usage] = await usageByTenant(this.database, range.from, range.to, tenantId)
    const back: Button[] = [{ text: '⬅️ Kembali', callback_data: `t:${tenantId}` }]
    if (!usage) return { text: 'Pelanggan tidak ditemukan.', keyboard: [back] }
    const kinds = await this.kindLines(range, tenantId)
    return {
      text: `${usage.name} — ${range.label}\n${usage.runs} run, ${usage.inputTokens} in / ${usage.outputTokens} out\n~$${usage.costUsd.toFixed(4)}${kinds}`,
      keyboard: [...this.rangeButtons(range.key, (key) => `tu:${tenantId}:${key}`, `tc:${tenantId}`), back],
    }
  }

  /* ---------- limits ---------- */

  private async limitScreen(tenantId: string): Promise<Reply> {
    const [status] = await limitStatuses(this.database, tenantId)
    if (!status) return this.tenantsScreen()
    const row = (values: number[], current: number | null, prefix: string): Button[] => [
      ...values.map((value) => ({
        text: `${current === value ? '• ' : ''}$${value}`,
        callback_data: `${prefix}:${tenantId}:${value}`,
      })),
      { text: `${current === null ? '• ' : ''}∞`, callback_data: `${prefix}:${tenantId}:0` },
    ]
    return {
      text:
        `🚦 Batas pemakaian — ${status.name}\n` +
        `Harian: ${status.dailyLimit === null ? 'tanpa batas' : `$${status.dailyLimit}`} (terpakai ~$${status.todayCost.toFixed(4)})\n` +
        `Bulanan: ${status.monthlyLimit === null ? 'tanpa batas' : `$${status.monthlyLimit}`} (terpakai ~$${status.monthCost.toFixed(4)})\n` +
        `Status: ${status.paused ? 'DIJEDA, AI berhenti memproses pesannya' : 'berjalan'}\n` +
        'Peringatan dikirim di 80%, dan AI dijeda otomatis saat batas tercapai. Pilih batas baru:',
      keyboard: [
        [{ text: 'Harian:', callback_data: 'noop' }, ...row(DAILY_LIMITS, status.dailyLimit, 'ld')],
        [{ text: 'Bulanan:', callback_data: 'noop' }, ...row(MONTHLY_LIMITS, status.monthlyLimit, 'lb')],
        [{ text: '⬅️ Kembali', callback_data: `t:${tenantId}` }],
      ].map((buttons) => buttons.slice(0, 6)),
    }
  }

  private async changeLimit(
    tenantId: string,
    scope: 'daily' | 'monthly',
    value: string,
    actor: number,
  ): Promise<Reply> {
    const amount = Number(value)
    const allowed = scope === 'daily' ? DAILY_LIMITS : MONTHLY_LIMITS
    if (!(amount === 0 || allowed.includes(amount))) return this.limitScreen(tenantId)
    await setLimit(this.database, tenantId, scope, amount === 0 ? null : amount)
    await recordAudit(this.database, actor, 'limit_changed', tenantId, { scope, usd: amount === 0 ? null : amount })
    await this.hooks.reevaluateLimits?.()
    return this.limitScreen(tenantId)
  }

  /* ---------- failed runs ---------- */

  private async failedScreen(): Promise<Reply> {
    const summary = await failedRunsSummary(this.database)
    const lines: string[] = []
    if (summary.recent.length === 0) lines.push('Tidak ada run gagal dalam 48 jam terakhir. ✅')
    else {
      lines.push('Run gagal (48 jam terakhir):')
      for (const run of summary.recent) lines.push(`• ${formatShort(run.at)} · ${run.tenantName} · ${run.error}`)
    }
    if (summary.blocked.length > 0) {
      lines.push('', 'Pesan yang menunggu dicoba ulang:')
      for (const blocked of summary.blocked) lines.push(`• ${blocked.tenantName}: ${blocked.messages} pesan`)
    }
    const keyboard: Button[][] = summary.blocked.map((blocked) => [
      { text: `🔁 Retry ${blocked.tenantName} (${blocked.messages})`.slice(0, 48), callback_data: `fr:${blocked.tenantId}` },
    ])
    keyboard.push([{ text: '🔄 Perbarui', callback_data: 'm:failed' }, BACK_MENU])
    return { text: lines.join('\n'), keyboard }
  }

  private async retryFailed(tenantId: string, actor: number): Promise<Reply> {
    const count = await retryBlockedMessages(this.database, tenantId)
    await recordAudit(this.database, actor, 'retry_failed', tenantId, { messages: count })
    return this.withNote(await this.failedScreen(), `${count} pesan dijadwalkan ulang.`)
  }

  /* ---------- invitations ---------- */

  /** Revokes the unused links of a customer and issues a new one, ready to send through WhatsApp. */
  private async newLink(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await getTenantDetail(this.database, tenantId)
    if (!tenant) return this.tenantsScreen()
    const renewed = await renewTenantInvitation(this.database, tenantId, actor)
    await recordAudit(this.database, actor, 'invite_renewed', tenantId, { name: tenant.name })
    const link = `${this.options.publicBaseUrl}/join/${renewed.token}`
    return {
      text: `Link baru untuk ${tenant.name} (link lama dicabut)\n${link}\nBerlaku sampai ${formatTime(renewed.expiresAt)}, sekali pakai.`,
      keyboard: [
        ...this.sendViaWhatsApp(renewed.phone, tenant.name, link, renewed.expiresAt),
        [{ text: '⬅️ Customer', callback_data: `t:${tenantId}` }, BACK_MENU],
      ],
    }
  }

  private async revokeLinks(tenantId: string, actor: number): Promise<Reply> {
    const tenant = await getTenantDetail(this.database, tenantId)
    if (!tenant) return this.tenantsScreen()
    await revokeTenantInvitations(this.database, tenantId)
    await recordAudit(this.database, actor, 'invite_revoked', tenantId, { name: tenant.name })
    return this.withNote(await this.tenantScreen(tenantId), 'Link dicabut. Buat link baru bila pelanggan masih perlu masuk.')
  }

  /* ---------- messages to customers ---------- */

  private async broadcastTargets(target: string): Promise<Array<{ id: string; name: string }>> {
    const active = await activeTenantIds(this.database)
    return target === 'all' ? active : active.filter((tenant) => tenant.id === target)
  }

  private async broadcastTargetsScreen(): Promise<Reply> {
    const active = await activeTenantIds(this.database)
    if (active.length === 0) {
      return { text: 'Belum ada pelanggan aktif untuk dikirimi pesan.', keyboard: [[BACK_MENU]] }
    }
    return {
      text:
        'Kirim pesan ke WhatsApp pelanggan. Pesan masuk ke self-chat mereka dan diawali "Aksis:". Pilih tujuan:',
      keyboard: [
        [{ text: `📣 Semua pelanggan aktif (${active.length})`, callback_data: 'bt:all' }],
        ...active.map((tenant, index): Button[] => [
          { text: `${index + 1}. ${tenant.name}`.slice(0, 44), callback_data: `bt:${tenant.id}` },
        ]),
        [BACK_MENU],
      ],
    }
  }

  private async broadcastPrompt(target: string, actor: number): Promise<Reply> {
    if (target !== 'all' && !isUuid(target)) return this.unknown()
    const recipients = await this.broadcastTargets(target)
    if (recipients.length === 0) return this.broadcastTargetsScreen()
    return this.prompt(
      actor,
      { kind: 'broadcast', target },
      `Ketik pesan untuk ${target === 'all' ? `${recipients.length} pelanggan aktif` : recipients[0]!.name} (maksimal ${MAX_BROADCAST_CHARS} karakter).`,
      'm:bc',
    )
  }

  private async sendBroadcast(actor: number): Promise<Reply> {
    const draft = this.broadcastDrafts.get(actor)
    this.broadcastDrafts.delete(actor)
    if (!draft) return { text: 'Tidak ada pesan yang menunggu dikirim.', keyboard: [[BACK_MENU]] }
    const recipients = await this.broadcastTargets(draft.target)
    const queued = await enqueueBroadcast(
      this.database,
      recipients.map((tenant) => tenant.id),
      draft.text,
    )
    await recordAudit(this.database, actor, 'broadcast', null, { recipients: queued, characters: draft.text.length })
    return {
      text: `Pesan masuk antrean untuk ${queued} pelanggan. Pengiriman gagal terlihat di /status sebagai balasan tertunda.`,
      keyboard: [[BACK_MENU]],
    }
  }

  /* ---------- admins ---------- */

  private async adminsScreen(actor: number): Promise<Reply> {
    await this.refreshAdmins()
    const owner = this.isOwner(actor)
    const everyone = [
      ...[...this.options.adminIds].map((id) => `🔒 ${id} (owner)`),
      ...[...this.dbAdmins].filter((id) => !this.options.adminIds.has(id)).map((id) => `👮 ${id}`),
    ]
    const lines = ['Admin Aksis:', ...everyone.map((line, index) => `${index + 1}. ${line}`)]
    const keyboard: Button[][] = owner
      ? [...this.dbAdmins]
          .filter((id) => !this.options.adminIds.has(id))
          .map((id, index): Button[] => [
            { text: `${this.options.adminIds.size + index + 1}. 🗑 Remove ${id}`, callback_data: `adr:${id}` },
          ])
      : []
    if (owner) keyboard.push([{ text: '➕ Add admin', callback_data: 'ada' }])
    else lines.push('', 'Hanya owner yang bisa menambah atau mencabut admin.')
    keyboard.push([BACK_MENU])
    return { text: lines.join('\n'), keyboard }
  }

  private async confirmRemoveAdmin(telegramId: number, actor: number): Promise<Reply> {
    if (!this.isOwner(actor) || this.options.adminIds.has(telegramId)) return this.adminsScreen(actor)
    return {
      text: `Cabut akses admin ${telegramId}?`,
      keyboard: [
        [
          { text: 'Ya, cabut', callback_data: `adrok:${telegramId}` },
          { text: 'Batal', callback_data: 'm:adm' },
        ],
      ],
    }
  }

  private async removeAdmin(telegramId: number, actor: number): Promise<Reply> {
    if (this.isOwner(actor) && !this.options.adminIds.has(telegramId)) {
      await removeDbAdmin(this.database, telegramId)
      await this.refreshAdmins()
      await recordAudit(this.database, actor, 'admin_removed', null, { telegramId })
    }
    return this.adminsScreen(actor)
  }

  /* ---------- commands ---------- */

  private async run(command: string, args: string[], actor: number): Promise<Reply> {
    const db = this.database
    switch (command) {
      case '/start':
      case '/menu':
        return { text: 'Aksis AI — pilih menu:', keyboard: await this.mainMenu() }

      case '/help':
        return { text: HELP, keyboard: await this.mainMenu() }

      case '/invite': {
        if (args.length === 0) {
          return this.prompt(actor, { kind: 'invite' }, 'Ketik nama pelanggan baru.', 'm:menu')
        }
        return this.invite(args.join(' '), actor)
      }

      case '/tenants':
        return this.tenantsScreen()

      case '/dashboard':
        return this.dashboardLink(actor)

      case '/status':
        return {
          text: (await this.statusLines()).join('\n'),
          keyboard: [[{ text: '🔄 Perbarui', callback_data: 'm:status' }, BACK_MENU]],
        }

      case '/usage': {
        const requested = Number(args[0] ?? '7')
        return this.usageScreen(
          presetRange(Number.isInteger(requested) ? requested : 7, new Date()) ?? presetRange(7, new Date())!,
        )
      }

      case '/enable':
      case '/disable': {
        const identifier = args.join(' ').trim()
        if (!identifier) return { text: `Format: ${command} <id|nama>` }
        const tenant = await findTenant(db, identifier)
        if (tenant.kind === 'none') return { text: 'Pelanggan tidak ditemukan.' }
        if (tenant.kind === 'ambiguous') {
          return { text: 'Lebih dari satu pelanggan cocok. Pakai id yang lebih panjang.' }
        }
        return this.changeStatus(tenant.id, command === '/enable' ? 'active' : 'disabled', actor)
      }

      default:
        return { text: 'Perintah tidak dikenal. Ketik /menu.', keyboard: [[BACK_MENU]] }
    }
  }

  /** Edits the message a button was pressed on, falling back to a new message. */
  private async show(chatId: number, reply: Reply, messageId?: number): Promise<void> {
    if (messageId === undefined) return this.send(chatId, reply)
    try {
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: reply.text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(reply.keyboard ? { reply_markup: { inline_keyboard: reply.keyboard } } : {}),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      if (detail.includes('message is not modified')) return
      await this.send(chatId, reply)
    }
  }

  private async send(chatId: number, reply: Reply | string): Promise<void> {
    const { text, keyboard } = typeof reply === 'string' ? { text: reply, keyboard: undefined } : reply
    await this.api('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    })
  }

  private async api<T = unknown>(method: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abortController.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const payload = (await response.json()) as { ok?: boolean; result?: T; description?: string }
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description ?? response.status}`)
    }
    return payload.result as T
  }

  private logError(where: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : 'unknown error'
    console.error(`Telegram bot ${where} error: ${detail.split(this.options.token).join('***')}`)
  }
}

function describeSubscription(
  subscription: { planName: string; planCode: string; endsAt: Date } | null,
  now: Date,
): string {
  const status = subscriptionStatus(subscription, now)
  if (!subscription) return `${BILLING_ICON.pending} belum ada (AI belum aktif)`
  const until = formatDate(subscription.endsAt)
  switch (status) {
    case 'trial':
    case 'active':
      return `${BILLING_ICON[status]} ${subscription.planName}, sampai ${until} (${daysLeft(subscription, now)} hari lagi)`
    case 'grace':
      return `${BILLING_ICON.grace} masa tenggang (${subscription.planName} berakhir ${until}, AI berhenti dalam ${GRACE_DAYS} hari)`
    default:
      return `${BILLING_ICON.expired} berakhir ${until} — AI berhenti`
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

function formatTime(date: Date): string {
  return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function formatLimits(daily: number | null, monthly: number | null): string {
  return `harian ${daily === null ? '∞' : `$${daily}`} · bulanan ${monthly === null ? '∞' : `$${monthly}`}`
}

function formatShort(date: Date): string {
  return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
