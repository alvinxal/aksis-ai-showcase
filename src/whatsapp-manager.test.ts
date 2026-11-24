import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from './db.js'
import { WhatsAppManager } from './whatsapp-manager.js'
import type { WhatsAppConnector } from './whatsapp.js'

const TIMEOUT = 10 * 60_000
type Fake = { connection: string; registered: boolean; stop: ReturnType<typeof vi.fn> }

/** Tagged-template stand-in: tenants to open at start, tenants still allowed, and the switch-offs. */
function fakeDatabase(startIds: string[]) {
  const switchedOff: string[] = []
  const run = async (strings: TemplateStringsArray, values: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('whatsapp_enabled or id')) return startIds.map((id) => ({ id }))
    if (text.includes('select status from tenants where id')) return [{ status: 'active' }]
    if (text.includes('where id in')) return (values[0] as string[]).map((id) => ({ id }))
    if (text.includes('set whatsapp_enabled = false')) switchedOff.push(values[0] as string)
    return []
  }
  // database(ids) is the list helper and must answer synchronously; a template call is a query.
  const database = ((strings: TemplateStringsArray | unknown, ...values: unknown[]) =>
    Array.isArray((strings as TemplateStringsArray).raw) ? run(strings as TemplateStringsArray, values) : strings) as unknown as Database
  return { database, switchedOff }
}

function build(ids: string[], fakes: Record<string, Partial<Fake>>, legacyTenantId?: string) {
  const { database, switchedOff } = fakeDatabase(ids)
  const made = new Map<string, Fake>()
  let created = 0
  const manager = new WhatsAppManager(database, {
    baseDir: '/tmp/wa',
    ...(legacyTenantId ? { legacyTenantId } : {}),
    maxActive: 3,
    pairingTimeoutMs: TIMEOUT,
    createConnector: (options) => {
      const id = options.tenantId!
      created += 1
      const fake: Fake = { connection: 'connecting', registered: false, stop: vi.fn(), ...fakes[id] }
      made.set(id, fake)
      return {
        start: async () => undefined,
        stop: fake.stop,
        getStatus: () => ({ enabled: true, connection: fake.connection, qr: null, lastError: null }),
        isRegistered: () => fake.registered,
      } as unknown as WhatsAppConnector
    },
  })
  const sweep = () => (manager as unknown as { sweep: () => Promise<void> }).sweep()
  return { manager, made, switchedOff, sweep, created: () => created }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WhatsApp session sweep', () => {
  it('keeps a paired session that is slow to reconnect after a restart', async () => {
    const { manager, switchedOff, sweep } = build(['t1'], { t1: { registered: true, connection: 'error' } })
    await manager.start()
    vi.advanceTimersByTime(TIMEOUT * 3)
    await sweep()
    expect(manager.status('t1')).not.toBeNull()
    expect(switchedOff).toEqual([])
    manager.stop()
  })

  it('switches off a pairing that was never completed, and says so', async () => {
    const { manager, made, switchedOff, sweep } = build(['t1'], { t1: { registered: false, connection: 'qr_ready' } })
    await manager.start()
    vi.advanceTimersByTime(TIMEOUT + 1_000)
    await sweep()
    expect(made.get('t1')!.stop).toHaveBeenCalled()
    expect(manager.status('t1')).toBeNull()
    expect(switchedOff).toEqual(['t1'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('pairing of tenant t1 was not completed'))
    manager.stop()
  })

  it('leaves a pairing alone while it is still within the time limit', async () => {
    const { manager, switchedOff, sweep } = build(['t1'], { t1: { registered: false, connection: 'qr_ready' } })
    await manager.start()
    vi.advanceTimersByTime(TIMEOUT - 1_000)
    await sweep()
    expect(manager.status('t1')).not.toBeNull()
    expect(switchedOff).toEqual([])
    manager.stop()
  })

  it('never sweeps a connected session or the legacy tenant', async () => {
    const { manager, switchedOff, sweep } = build(['t1', 'legacy'], { t1: { connection: 'connected' }, legacy: { connection: 'qr_ready' } }, 'legacy')
    await manager.start()
    vi.advanceTimersByTime(TIMEOUT * 3)
    await sweep()
    expect(manager.status('t1')).not.toBeNull()
    expect(manager.status('legacy')).not.toBeNull()
    expect(switchedOff).toEqual([])
    manager.stop()
  })

  it('reports how many sessions it opened at start', async () => {
    const { manager } = build(['t1', 't2'], { t1: { registered: true }, t2: { registered: false } })
    await manager.start()
    expect(console.log).toHaveBeenCalledWith('WhatsApp: 2 session(s) opened at start, 1 already paired')
    manager.stop()
  })
})

describe('starting a session', () => {
  it('opens one connection when "start" arrives twice at once', async () => {
    const { manager, created } = build([], {})
    const results = await Promise.all([manager.ensure('t1'), manager.ensure('t1')])
    expect(results).toEqual(['started', 'started'])
    expect(created()).toBe(1)
    expect(await manager.ensure('t1')).toBe('exists')
    manager.stop()
  })
})
