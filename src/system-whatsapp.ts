import { rm } from 'node:fs/promises'
import path from 'node:path'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys'
import pino from 'pino'
import type { Database } from './db.js'

export type SystemConnection = 'connecting' | 'qr_ready' | 'connected' | 'error' | 'logged_out'

export type SystemWhatsAppStatus = {
  phone: string
  connection: SystemConnection
  paired: boolean
  lastError: string | null
}

/**
 * The operator's own WhatsApp number. It is not a customer session: it only sends login codes,
 * access info and billing notices to customers, and it never reads or stores incoming messages.
 */
export class SystemWhatsApp {
  private socket: WASocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  private paired = false
  private connection: SystemConnection = 'connecting'
  private lastError: string | null = null

  /** `phone` is digits only, with country code. `sessionDir` is the base directory of all sessions. */
  constructor(
    readonly phone: string,
    private readonly sessionDir: string,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.end(new Error('Application shutdown'))
    this.socket = null
  }

  getStatus(): SystemWhatsAppStatus {
    return { phone: this.phone, connection: this.connection, paired: this.paired, lastError: this.lastError }
  }

  /** Pairing code for the configured number, to be typed in WhatsApp > Linked devices; null when it cannot be issued. */
  async requestPairingCode(): Promise<string | null> {
    for (let waited = 0; waited < 15_000 && this.connection === 'connecting'; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const socket = this.socket
    if (!socket || this.paired || this.connection !== 'qr_ready') return null
    try {
      return await socket.requestPairingCode(this.phone)
    } catch {
      return null
    }
  }

  async sendText(toPhone: string, text: string): Promise<void> {
    const socket = this.socket
    if (!socket || this.connection !== 'connected') throw new Error('System WhatsApp is not connected')
    await socket.sendMessage(`${toPhone}@s.whatsapp.net`, { text })
  }

  /** Drops the stored session and reconnects, so a number that was unlinked can be paired again. */
  async reset(): Promise<void> {
    this.stop()
    await rm(path.join(this.sessionDir, 'system'), { recursive: true, force: true })
    await this.start()
  }

  private async connect(): Promise<void> {
    this.connection = 'connecting'
    this.lastError = null
    const { state, saveCreds } = await useMultiFileAuthState(path.join(this.sessionDir, 'system'))
    this.paired = state.creds.registered === true
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false,
    })
    this.socket = socket
    socket.ev.on('creds.update', saveCreds)
    socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) this.connection = 'qr_ready'
      if (connection === 'open') {
        this.connection = 'connected'
        this.paired = true
        this.lastError = null
      }
      if (connection === 'close' && !this.stopped) {
        const error = lastDisconnect?.error as { message?: string; output?: { statusCode?: number } } | undefined
        const statusCode = error?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut
        this.connection = loggedOut ? 'logged_out' : 'error'
        this.lastError = error?.message ?? `connection closed (${statusCode ?? 'unknown'})`
        // Pairing renews the socket (restartRequired), and a lost link reconnects by itself.
        if (!loggedOut) this.reconnectTimer = setTimeout(() => void this.connect().catch(() => undefined), 5_000)
        else this.paired = false
      }
    })
  }
}

/** Digits of the customer's linked WhatsApp number, or null when none is linked. */
export async function phoneOfTenant(sql: Database, tenantId: string): Promise<string | null> {
  const [row] = await sql<Array<{ phone: string | null }>>`
    select nullif(split_part(split_part(whatsapp_jid, '@', 1), ':', 1), '') as phone
    from tenants where id = ${tenantId}
  `
  return row?.phone ?? null
}
