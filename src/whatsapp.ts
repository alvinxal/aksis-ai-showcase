import makeWASocket, {
  DisconnectReason,
  areJidsSameUser,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pino from 'pino'
import type { WhatsAppStatus } from './app.js'
import { isPersonalJid } from './contacts.js'
import { saveWhatsAppMessage, type Database } from './db.js'

export type WhatsAppGroup = { jid: string; subject: string; participants: number | null }

export type WhatsAppOptions = {
  enabled: boolean
  tenantId?: string
  sessionDir: string
  /** Project that receives self-chat messages. */
  resolveSelfProject: () => Promise<string | null>
  /** Project of a group the tenant selected, or null when the group is not selected. */
  resolveGroupProject: (groupJid: string) => Promise<string | null>
  /**
   * Project of a one-to-one chat the tenant selected, or null when the contact is not selected (a live message is
   * dropped, history is held for a day). It also notes the contact so it can be offered in the list; `altJid` is
   * the person's other address.
   */
  resolveContactProject: (jid: string, altJid: string | null, name: string | null) => Promise<string | null>
  /** People WhatsApp lists (contact list, chat list) who may be offered in the app; identity only. */
  learnContacts?: (people: Array<{ jid: string; altJid: string | null; name: string | null; saved: boolean }>) => Promise<void>
  onConnected?: (jid: string) => void
}

const GROUP_CACHE_MS = 60_000
/** Created in the session directory once the contact list was requested from WhatsApp. */
const CONTACT_SYNC_MARKER = 'contacts-synced-v1'
/** Group history older than this is ignored when WhatsApp sends its initial sync. */
const HISTORY_DAYS = 7

export class WhatsAppConnector {
  private socket: WASocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  private registered = false
  private status: WhatsAppStatus
  private groupCache: { at: number; groups: WhatsAppGroup[] } | null = null

  constructor(
    private readonly database: Database,
    private readonly options: WhatsAppOptions,
  ) {
    this.status = {
      enabled: options.enabled,
      connection: options.enabled ? 'connecting' : 'disabled',
      qr: null,
      lastError: null,
    }
  }

  /** True when the stored session was already paired with a WhatsApp account (known after start). */
  isRegistered(): boolean {
    return this.registered
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (!this.options.enabled) return
    await this.connect()
  }

  async listGroups(): Promise<WhatsAppGroup[]> {
    const socket = this.socket
    if (!socket || this.status.connection !== 'connected') throw new Error('WhatsApp is not connected')
    if (this.groupCache && Date.now() - this.groupCache.at < GROUP_CACHE_MS) return this.groupCache.groups
    const all = await socket.groupFetchAllParticipating()
    const groups = Object.values(all)
      .map((group) => ({
        jid: group.id,
        subject: group.subject || group.id,
        participants: group.participants?.length ?? null,
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject))
    this.groupCache = { at: Date.now(), groups }
    return groups
  }

  async sendSelfMessage(text: string): Promise<void> {
    const socket = this.socket
    const userId = socket?.user?.id
    if (!socket || !userId || this.status.connection !== 'connected') {
      throw new Error('WhatsApp is not connected')
    }
    await socket.sendMessage(jidNormalizedUser(userId), { text: `Aksis: ${text}` })
  }

  /**
   * Asks WhatsApp for a pairing code so the account can be linked from the same phone
   * that shows this page. `phone` is digits only, with country code. It is passed through
   * and never stored or logged.
   */
  async requestPairingCode(phone: string): Promise<boolean> {
    for (let waited = 0; waited < 15_000 && this.status.connection === 'connecting'; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const socket = this.socket
    if (!socket || this.status.connection !== 'qr_ready' || socket.authState.creds.registered) return false
    try {
      const code = await socket.requestPairingCode(phone)
      this.status = { ...this.status, pairingCode: code }
      return true
    } catch {
      return false
    }
  }

  /** Unlinks this device from the WhatsApp account (best effort). */
  async logout(): Promise<void> {
    await this.socket?.logout()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.end(new Error('Application shutdown'))
    this.socket = null
  }

  private async connect(): Promise<void> {
    const tenantId = this.options.tenantId
    if (!tenantId) throw new Error('WhatsApp tenant is not configured')

    this.status = { enabled: true, connection: 'connecting', qr: null, lastError: null }
    const { state, saveCreds } = await useMultiFileAuthState(this.options.sessionDir)
    // A stop that arrived while the credentials loaded must not leave a live socket behind.
    if (this.stopped) return
    this.registered = state.creds.registered === true
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      emitOwnEvents: true,
      generateHighQualityLinkPreview: false,
    })
    this.socket = socket

    socket.ev.on('creds.update', saveCreds)
    socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.status = { enabled: true, connection: 'qr_ready', qr, pairingCode: this.status.pairingCode ?? null, lastError: null }
      }

      if (connection === 'open') {
        this.status = { enabled: true, connection: 'connected', qr: null, lastError: null }
        const jid = socket.user?.id
        if (jid) this.options.onConnected?.(jidNormalizedUser(jid))
        this.scheduleContactListSync(socket)
      }

      if (connection === 'close' && !this.stopped) {
        const error = lastDisconnect?.error as
          | { message?: string; output?: { statusCode?: number } }
          | undefined
        const statusCode = error?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut
        this.status = {
          enabled: true,
          connection: loggedOut ? 'logged_out' : 'error',
          qr: null,
          lastError: error?.message ?? `connection closed (${statusCode ?? 'unknown'})`,
        }
        if (!loggedOut) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((reconnectError: unknown) => {
              console.error('WhatsApp reconnect failed', reconnectError instanceof Error ? reconnectError.message : reconnectError)
              if (!this.stopped) this.reconnectTimer = setTimeout(() => void this.connect().catch(() => undefined), 30_000)
            })
          }, 5_000)
        }
      }
    })

    socket.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
      void this.persistHistory(messages).catch((error: unknown) => {
        console.error('Failed to persist WhatsApp history', error)
      })
      this.learn([
        ...contacts.map((contact) => personOf(contact)),
        ...chats.map((chat) => personOf({ id: chat.id, name: chat.name, lid: chat.lidJid, phoneNumber: chat.pnJid })),
      ])
    })
    socket.ev.on('contacts.upsert', (contacts) => this.learn(contacts.map((contact) => personOf(contact))))
    socket.ev.on('contacts.update', (contacts) =>
      this.learn(contacts.map((contact) => personOf(contact))),
    )

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      for (const message of messages) {
        void this.persistMessage(socket, tenantId, message, type).catch((error: unknown) => {
          console.error('Failed to persist WhatsApp message', error)
        })
      }
    })
  }

  /**
   * WhatsApp sends recent history once, right after pairing. Group and one-to-one text from the last
   * HISTORY_DAYS days is held without a project; saving the group selection attaches it to the chosen groups
   * and deletes the other groups' text, and choosing a contact takes in that contact's text. What nobody claims
   * is deleted within a day (`purgeStaleHistory`). A contact that is already chosen gets its project at once.
   */
  private async persistHistory(messages: WAMessage[]): Promise<void> {
    const tenantId = this.options.tenantId
    if (!tenantId) return
    const cutoff = Date.now() / 1_000 - HISTORY_DAYS * 86_400
    for (const message of messages) {
      const id = message.key.id
      const remoteJid = message.key.remoteJid
      const timestamp = Number(message.messageTimestamp?.toString() ?? 0)
      if (!id || !remoteJid || timestamp < cutoff) continue
      const isGroup = remoteJid.endsWith('@g.us')
      const isPersonal = isPersonalJid(remoteJid)
      if (!isGroup && !isPersonal) continue

      const content = normalizeMessageContent(message.message)
      const textContent = extractText(content)
      if (!textContent) continue

      let projectId: string | null
      if (isGroup) projectId = await this.options.resolveGroupProject(remoteJid)
      else {
        const alt = message.key.remoteJidAlt ? jidNormalizedUser(message.key.remoteJidAlt) : null
        const name = message.key.fromMe ? null : (message.pushName?.trim().slice(0, 80) || null)
        projectId = await this.options.resolveContactProject(jidNormalizedUser(remoteJid), alt, name)
      }

      await saveWhatsAppMessage(this.database, {
        tenantId,
        projectId,
        whatsappMessageId: id,
        chatJid: isGroup ? remoteJid : jidNormalizedUser(remoteJid),
        senderJid: message.key.participant ? jidNormalizedUser(message.key.participant) : null,
        fromMe: message.key.fromMe ?? false,
        isSelfChat: false,
        isAgentGenerated: false,
        sentAt: new Date(timestamp * 1_000),
        messageType: getContentType(content) ?? 'unknown',
        textContent,
        rawPayload: toJsonRecord({
          key: message.key,
          messageTimestamp: timestamp,
          pushName: message.pushName ?? null,
          historical: true,
        }),
      })
    }
  }

  /**
   * A session paired long ago only gets contact changes, so the contact list is asked for once from the start:
   * WhatsApp keeps it in the app-state collection `critical_unblock_low`, and a collection fetched from version 0
   * comes back whole as `contacts.upsert`. The marker file in the session directory makes it a one-time request.
   */
  private scheduleContactListSync(socket: WASocket): void {
    if (!this.options.learnContacts) return
    const marker = path.join(this.options.sessionDir, CONTACT_SYNC_MARKER)
    if (existsSync(marker)) return
    const timer = setTimeout(() => {
      if (this.socket !== socket || this.stopped) return
      void (async () => {
        await rm(path.join(this.options.sessionDir, 'app-state-sync-version-critical_unblock_low.json'), { force: true })
        await socket.resyncAppState(['critical_unblock_low'], true)
        await writeFile(marker, `${new Date().toISOString()}\n`)
      })().catch((error: unknown) => {
        console.error('WhatsApp contact list sync failed', error instanceof Error ? error.message : error)
      })
    }, 15_000)
    timer.unref()
  }

  private learn(people: Array<ReturnType<typeof personOf> | null>): void {
    const known = people.filter((person): person is NonNullable<typeof person> => person !== null)
    if (known.length === 0 || !this.options.learnContacts) return
    void this.options.learnContacts(known).catch((error: unknown) => {
      console.error('Failed to note WhatsApp contacts', error instanceof Error ? error.message : error)
    })
  }

  private async persistMessage(
    socket: WASocket,
    tenantId: string,
    message: WAMessage,
    upsertType: string,
  ): Promise<void> {
    const id = message.key.id
    const remoteJid = message.key.remoteJid
    if (!id || !remoteJid || remoteJid === 'status@broadcast') return

    const normalizedRemoteJid = jidNormalizedUser(remoteJid)
    const selfJids = [socket.user?.id, socket.user?.lid]
      .filter((jid): jid is string => Boolean(jid))
      .map(jidNormalizedUser)
    const isSelfChat = selfJids.some((jid) => areJidsSameUser(jid, normalizedRemoteJid))
    const isGroup = normalizedRemoteJid.endsWith('@g.us')
    let projectId: string | null
    if (isSelfChat) projectId = await this.options.resolveSelfProject()
    else if (isGroup) projectId = await this.options.resolveGroupProject(normalizedRemoteJid)
    else if (isPersonalJid(normalizedRemoteJid)) {
      // Only the name the other person shows is kept as the contact's name; our own name is on messages we send.
      const alt = message.key.remoteJidAlt ? jidNormalizedUser(message.key.remoteJidAlt) : null
      const name = message.key.fromMe ? null : (message.pushName?.trim().slice(0, 80) || null)
      projectId = await this.options.resolveContactProject(normalizedRemoteJid, alt, name)
    } else return
    if (!isSelfChat && !projectId) return

    const content = normalizeMessageContent(message.message)
    const messageType = getContentType(content) ?? 'unknown'
    const textContent = extractText(content)
    const timestamp = Number(message.messageTimestamp?.toString() ?? Date.now() / 1_000)

    await saveWhatsAppMessage(this.database, {
      tenantId,
      projectId,
      whatsappMessageId: id,
      chatJid: normalizedRemoteJid,
      senderJid: message.key.participant ? jidNormalizedUser(message.key.participant) : null,
      fromMe: message.key.fromMe ?? false,
      isSelfChat,
      isAgentGenerated: Boolean(
        message.key.fromMe && isSelfChat && /^(Aksis|Hermes):/.test(textContent ?? ''),
      ),
      sentAt: new Date(timestamp * 1_000),
      messageType,
      textContent,
      rawPayload: toJsonRecord({ ...message, upsertType }),
    })
  }
}

/** A person from a contact or chat record: the phone-number address when there is one, the other address as alt. */
type ContactRecord = { id?: string | null | undefined; lid?: string | null | undefined; phoneNumber?: string | null | undefined; name?: string | null | undefined; notify?: string | null | undefined }

function personOf(contact: ContactRecord) {
  const addresses = [contact.phoneNumber, contact.id, contact.lid].filter((value): value is string => Boolean(value)).map((value) => jidNormalizedUser(value))
  const jid = addresses.find((value) => value.endsWith('@s.whatsapp.net')) ?? addresses.find((value) => value.endsWith('@lid'))
  if (!jid || !isPersonalJid(jid)) return null
  const altJid = addresses.find((value) => value !== jid && isPersonalJid(value)) ?? null
  return { jid, altJid, name: contact.name ?? contact.notify ?? null, saved: Boolean(contact.name) }
}

function extractText(message: WAMessage['message']): string | null {
  if (!message) return null
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null
  )
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as Record<string, unknown>
}
