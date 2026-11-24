import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { WhatsAppStatus } from './app.js'
import { learnContacts, touchContact } from './contacts.js'
import type { Database } from './db.js'
import { firstProjectId, purgeStaleHistory, selectedGroupProject } from './groups.js'
import { WhatsAppConnector, type WhatsAppGroup, type WhatsAppOptions } from './whatsapp.js'

export type ManagerOptions = {
  baseDir: string
  /** Tenant whose session lives directly in baseDir (the original PoC session). */
  legacyTenantId?: string
  maxActive: number
  /** Pairing sessions that are not connected after this long are shut down to free RAM. */
  pairingTimeoutMs: number
  /** Test seam; defaults to a real Baileys connector. */
  createConnector?: (options: WhatsAppOptions) => WhatsAppConnector
}

export type StartResult = 'started' | 'exists' | 'full' | 'unavailable'

const SWEEP_MS = 30_000

export class WhatsAppManager {
  private readonly connectors = new Map<string, { connector: WhatsAppConnector; since: number; everConnected: boolean }>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(
    private readonly database: Database,
    private readonly options: ManagerOptions,
  ) {}

  async start(): Promise<void> {
    const rows = await this.database<Array<{ id: string }>>`
      select id from tenants
      where status in ('onboarding', 'active')
        and (whatsapp_enabled or id = ${this.options.legacyTenantId ?? null})
      order by created_at
    `
    for (const row of rows) {
      if (this.connectors.size >= this.options.maxActive) {
        console.warn(`WhatsApp: ${rows.length - this.connectors.size} tenant(s) not opened, the limit of ${this.options.maxActive} sessions is reached`)
        break
      }
      await this.open(row.id)
    }
    const paired = [...this.connectors.values()].filter((entry) => entry.everConnected).length
    console.log(`WhatsApp: ${this.connectors.size} session(s) opened at start, ${paired} already paired`)
    this.sweeper = setInterval(() => void this.sweep().catch(logSweepError), SWEEP_MS)
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const { connector } of this.connectors.values()) connector.stop()
    this.connectors.clear()
  }

  activeCount(): number {
    return [...this.connectors.values()].filter(({ connector }) => connector.getStatus().connection === 'connected')
      .length
  }

  totalCount(): number {
    return this.connectors.size
  }

  snapshot(): Array<{ tenantId: string; connection: string }> {
    return [...this.connectors].map(([tenantId, { connector }]) => ({
      tenantId,
      connection: connector.getStatus().connection,
    }))
  }

  /**
   * Reopens the stored session of a tenant that was switched off and on again, unless
   * its connection was cut by hand (whatsapp_enabled is false then).
   */
  async resume(tenantId: string): Promise<void> {
    if (this.connectors.has(tenantId) || this.connectors.size >= this.options.maxActive) return
    const [tenant] = await this.database<Array<{ status: string; whatsapp_enabled: boolean }>>`
      select status, whatsapp_enabled from tenants where id = ${tenantId}
    `
    if (tenant?.whatsapp_enabled && ['onboarding', 'active'].includes(tenant.status)) {
      await this.open(tenantId)
    }
  }

  /** Closes the connection but keeps the session, so reconnect needs no new QR. */
  async disconnect(tenantId: string): Promise<void> {
    const entry = this.connectors.get(tenantId)
    if (entry) {
      entry.connector.stop()
      this.connectors.delete(tenantId)
    }
    await this.database`update tenants set whatsapp_enabled = false where id = ${tenantId}`
  }

  status(tenantId: string): WhatsAppStatus | null {
    return this.connectors.get(tenantId)?.connector.getStatus() ?? null
  }

  /** Two taps on "start" must not open two sockets on one session folder: the second waits for the first. */
  private readonly starting = new Map<string, Promise<StartResult>>()

  ensure(tenantId: string): Promise<StartResult> {
    const running = this.starting.get(tenantId)
    if (running) return running
    const started = this.ensureOnce(tenantId).finally(() => this.starting.delete(tenantId))
    this.starting.set(tenantId, started)
    return started
  }

  private async ensureOnce(tenantId: string): Promise<StartResult> {
    if (this.connectors.has(tenantId)) return 'exists'
    const [tenant] = await this.database<Array<{ status: string }>>`
      select status from tenants where id = ${tenantId}
    `
    if (!tenant || !['onboarding', 'active'].includes(tenant.status)) return 'unavailable'
    if (this.connectors.size >= this.options.maxActive) return 'full'
    await this.database`update tenants set whatsapp_enabled = true where id = ${tenantId}`
    await this.open(tenantId)
    return 'started'
  }

  async requestPairingCode(tenantId: string, phone: string): Promise<boolean> {
    const entry = this.connectors.get(tenantId)
    return entry ? entry.connector.requestPairingCode(phone) : false
  }

  async sendSelfMessage(tenantId: string, text: string): Promise<void> {
    const entry = this.connectors.get(tenantId)
    if (!entry) throw new Error('WhatsApp is not connected')
    await entry.connector.sendSelfMessage(text)
  }

  async listGroups(tenantId: string): Promise<WhatsAppGroup[]> {
    const entry = this.connectors.get(tenantId)
    if (!entry) throw new Error('WhatsApp is not connected')
    return entry.connector.listGroups()
  }

  /**
   * Closes the tenant's connection, unlinks the device from their WhatsApp account and
   * deletes the stored session. The original PoC session lives in baseDir itself, so its
   * folder is left in place and only the connection is closed.
   */
  async removeSession(tenantId: string): Promise<void> {
    const entry = this.connectors.get(tenantId)
    if (entry) {
      await entry.connector.logout().catch(() => undefined)
      entry.connector.stop()
      this.connectors.delete(tenantId)
    }
    if (tenantId !== this.options.legacyTenantId) {
      await rm(path.join(this.options.baseDir, 'tenants', tenantId), { recursive: true, force: true })
    }
  }

  private async open(tenantId: string): Promise<void> {
    const entry = { connector: null as unknown as WhatsAppConnector, since: Date.now(), everConnected: false }
    const create = this.options.createConnector ?? ((options: WhatsAppOptions) => new WhatsAppConnector(this.database, options))
    const connector = create({
      enabled: true,
      tenantId,
      sessionDir:
        tenantId === this.options.legacyTenantId
          ? this.options.baseDir
          : path.join(this.options.baseDir, 'tenants', tenantId),
      resolveSelfProject: () => firstProjectId(this.database, tenantId),
      resolveGroupProject: (groupJid) => selectedGroupProject(this.database, tenantId, groupJid),
      resolveContactProject: (jid, altJid, name) => touchContact(this.database, tenantId, jid, altJid, name),
      learnContacts: async (people) => void (await learnContacts(this.database, tenantId, people)),
      onConnected: (jid) => {
        entry.everConnected = true
        void this.database`update tenants set whatsapp_jid = ${jid} where id = ${tenantId}`.catch(logSweepError)
      },
    })
    entry.connector = connector
    this.connectors.set(tenantId, entry)
    await connector.start()
    // A session that was paired before this start is not an unfinished pairing: it only has to
    // reconnect. Only never-paired sessions are swept, so a slow reconnect after a restart
    // cannot switch a customer's WhatsApp off.
    entry.everConnected = connector.isRegistered()
  }

  /** Closes idle pairings and connections of tenants that are no longer allowed to run. */
  private async sweep(): Promise<void> {
    await purgeStaleHistory(this.database)
    if (this.connectors.size === 0) return
    const ids = [...this.connectors.keys()]
    const allowed = await this.database<Array<{ id: string }>>`
      select id from tenants where id in ${this.database(ids)} and status in ('onboarding', 'active')
    `
    const allowedIds = new Set(allowed.map((row) => row.id))
    for (const [tenantId, entry] of this.connectors) {
      const connected = entry.connector.getStatus().connection === 'connected'
      const idle =
        !connected &&
        !entry.everConnected &&
        tenantId !== this.options.legacyTenantId &&
        Date.now() - entry.since > this.options.pairingTimeoutMs
      if (allowedIds.has(tenantId) && !idle) continue
      entry.connector.stop()
      this.connectors.delete(tenantId)
      if (idle) {
        console.warn(`WhatsApp: pairing of tenant ${tenantId} was not completed within ${Math.round(this.options.pairingTimeoutMs / 60_000)} min, switched off`)
        await this.database`update tenants set whatsapp_enabled = false where id = ${tenantId}`
      } else {
        console.log(`WhatsApp: session of tenant ${tenantId} closed, the tenant may no longer run`)
      }
    }
  }
}

function logSweepError(error: unknown): void {
  console.error('WhatsApp manager error', error instanceof Error ? error.message : error)
}
