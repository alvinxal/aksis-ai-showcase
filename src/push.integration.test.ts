// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db.js'
import { FeatureHealth } from './health.js'
import { createPushService, sendDigests, type PushMessage, type Sender } from './push.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const HOUR = 3_600_000

describe.skipIf(!url)('push notifications', () => {
  let sql: Database
  const tenants: string[] = []
  // endpoint -> messages; the shared database may hold other tests' tenants, so everything is keyed by endpoint.
  const sent = new Map<string, PushMessage[]>()
  let failure: ((endpoint: string) => { statusCode: number } | null) | null = null
  const send: Sender = async (subscription, message) => {
    const error = failure?.(subscription.endpoint)
    if (error) throw Object.assign(new Error('push failed'), error)
    sent.set(subscription.endpoint, [...(sent.get(subscription.endpoint) ?? []), message])
  }
  const service = () => createPushService(sql, 'PUBLIC')

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
    sent.clear()
    failure = null
  })
  afterAll(async () => {
    await sql.end()
  })

  const tenant = async (status = 'active') => {
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name, status) values (${`T ${randomUUID()}`}, ${status}) returning id`
    tenants.push(row!.id)
    return row!.id
  }
  const device = async (tenantId: string) => {
    const input = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') }
    expect(await service().subscribe(tenantId, input, 'Test phone')).toBe(true)
    return input.endpoint
  }
  const dueProject = async (tenantId: string, title = 'Termin 2 jatuh tempo', dueInHours = 3) => {
    const [project] = await sql<Array<{ id: string }>>`insert into projects (tenant_id, name) values (${tenantId}, ${`Rumah ${randomUUID().slice(0, 6)}`}) returning id`
    await sql`insert into whatsapp_groups (tenant_id, group_jid, subject, selected, project_id) values (${tenantId}, ${`${randomUUID()}@g.us`}, 'G', true, ${project!.id})`
    const [run] = await sql<Array<{ id: string }>>`insert into analysis_runs (tenant_id, project_id, status, model) values (${tenantId}, ${project!.id}, 'completed', 'test') returning id`
    await sql`
      insert into project_events (tenant_id, project_id, analysis_run_id, event_type, title, details, confidence, occurred_at, due_at)
      values (${tenantId}, ${project!.id}, ${run!.id}, 'PAYMENT_DUE', ${title}, ${sql.json({ amount: 30000000 })}, 0.9, now(), ${new Date(Date.now() + dueInHours * HOUR)})
    `
    return project!.id
  }
  // The hour window is checked against `now`; these tests run at any time of day, so the window is opened wide.
  const sweep = (now = new Date()) => sendDigests(sql, send, 0, now, 24)
  // Another test file deleting a tenant at the same moment can make Postgres abort one tenant's turn with a
  // deadlock; that tenant is simply picked up by the next sweep, so a test that expects a message allows a few.
  const sweepUntil = async (endpoint: string) => {
    for (let attempt = 0; attempt < 3 && !sent.has(endpoint); attempt += 1) await sweep()
  }

  it('sends one plain message to a customer with a device and something due, never with the amount', async () => {
    const tenantId = await tenant()
    const endpoint = await device(tenantId)
    const projectId = await dueProject(tenantId)
    await sweepUntil(endpoint)
    const [message] = sent.get(endpoint) ?? []
    expect(message).toMatchObject({ title: '1 hal perlu perhatian', url: `/app/proyek/${projectId}`, tag: 'digest' })
    expect(message?.body).toContain('Termin 2 jatuh tempo')
    expect(message?.body).not.toMatch(/30\.?000\.?000|Rp/)
  })

  it('sends it once a day, even when the sweep runs again', async () => {
    const tenantId = await tenant()
    const endpoint = await device(tenantId)
    await dueProject(tenantId)
    await sweepUntil(endpoint)
    await sweep()
    await sweep()
    expect(sent.get(endpoint)).toHaveLength(1)
    // A new day sends again.
    await sql`delete from push_sent where tenant_id = ${tenantId}`
    for (let attempt = 0; attempt < 3 && (sent.get(endpoint)?.length ?? 0) < 2; attempt += 1) await sweep()
    expect(sent.get(endpoint)).toHaveLength(2)
  })

  it('stays quiet without a device, without anything due, for an inactive customer, and beyond the due horizon', async () => {
    const noDevice = await tenant()
    await dueProject(noDevice)
    const nothingDue = await tenant()
    const nothingEndpoint = await device(nothingDue)
    const inactive = await tenant('disabled')
    const inactiveEndpoint = await device(inactive)
    await dueProject(inactive)
    const faraway = await tenant()
    const farEndpoint = await device(faraway)
    await dueProject(faraway, 'Masih lama', 24 * 4)
    await sweep()
    await sweep()
    expect([...sent.keys()]).not.toContain(nothingEndpoint)
    expect([...sent.keys()]).not.toContain(inactiveEndpoint)
    expect([...sent.keys()]).not.toContain(farEndpoint)
    expect((await sql`select 1 from push_sent where tenant_id = ${noDevice}`).length).toBe(0)
  })

  it('does not tell one customer about another customer\'s work', async () => {
    const mine = await tenant()
    const other = await tenant()
    const myEndpoint = await device(mine)
    const otherEndpoint = await device(other)
    await dueProject(mine, 'Punya saya')
    await dueProject(other, 'Rahasia lain')
    await sweepUntil(myEndpoint)
    await sweepUntil(otherEndpoint)
    expect(sent.get(myEndpoint)?.[0]?.body).toContain('Punya saya')
    expect(sent.get(myEndpoint)?.[0]?.body).not.toContain('Rahasia lain')
    expect(sent.get(otherEndpoint)?.[0]?.body).not.toContain('Punya saya')
  })

  it('forgets a device that the push service says is gone, and keeps the others', async () => {
    const tenantId = await tenant()
    const gone = await device(tenantId)
    const alive = await device(tenantId)
    await dueProject(tenantId)
    failure = (endpoint) => (endpoint === gone ? { statusCode: 410 } : null)
    for (let attempt = 0; attempt < 3 && !sent.has(alive); attempt += 1) await sweep()
    const left = await sql<Array<{ endpoint: string }>>`select endpoint from push_subscriptions where tenant_id = ${tenantId}`
    expect(left.map((row) => row.endpoint)).toEqual([alive])
  })

  it('tries again at the next sweep when a passing problem stopped every device, and drops a device after repeated failures', async () => {
    const tenantId = await tenant()
    const endpoint = await device(tenantId)
    await dueProject(tenantId)
    failure = () => ({ statusCode: 503 })
    for (let i = 0; i < 4; i += 1) await sweep()
    expect(sent.has(endpoint)).toBe(false)
    expect((await sql`select 1 from push_sent where tenant_id = ${tenantId}`).length).toBe(0)
    failure = null
    await sweepUntil(endpoint)
    expect(sent.get(endpoint)).toHaveLength(1)

    const other = await tenant()
    const flaky = await device(other)
    await dueProject(other)
    failure = (e) => (e === flaky ? { statusCode: 500 } : null)
    for (let i = 0; i < 6; i += 1) await sweep()
    expect((await sql`select 1 from push_subscriptions where endpoint = ${flaky}`).length).toBe(0)
  })

  it('keeps one row per device, moves a device to the customer who registers it last, and caps the devices', async () => {
    const first = await tenant()
    const second = await tenant()
    const endpoint = await device(first)
    expect(await service().subscribe(second, { endpoint, p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') }, null)).toBe(true)
    const owners = await sql<Array<{ tenant_id: string }>>`select tenant_id from push_subscriptions where endpoint = ${endpoint}`
    expect(owners).toEqual([{ tenant_id: second }])
    for (let i = 0; i < 7; i += 1) await device(first)
    expect((await sql`select 1 from push_subscriptions where tenant_id = ${first}`).length).toBe(5)
    await service().unsubscribe(first, endpoint)
    expect((await sql`select 1 from push_subscriptions where endpoint = ${endpoint}`).length).toBe(1)
    await service().unsubscribe(second, endpoint)
    expect((await sql`select 1 from push_subscriptions where endpoint = ${endpoint}`).length).toBe(0)
  })

  it('refuses a device whose address is not a push service', async () => {
    const tenantId = await tenant()
    const bad = { endpoint: 'https://169.254.169.254/latest', p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') }
    expect(await service().subscribe(tenantId, bad, null)).toBe(false)
  })

  it('tells the health tracker about delivery, but a device that is simply gone is not a fault', async () => {
    const health = new FeatureHealth()
    const tenantId = await tenant()
    const gone = await device(tenantId)
    await dueProject(tenantId)
    failure = () => ({ statusCode: 410 })
    await sendDigests(sql, send, 0, new Date(), 24, health)
    // Other tests' tenants may be swept too, so only the absence of failures is certain.
    expect(health.recent('push', 60_000).failures).toBe(0)
    expect((await sql`select 1 from push_subscriptions where endpoint = ${gone}`).length).toBe(0)

    const other = await tenant()
    await device(other)
    await dueProject(other)
    failure = () => ({ statusCode: 503 })
    await sendDigests(sql, send, 0, new Date(), 24, health)
    expect(health.recent('push', 60_000).failures).toBeGreaterThanOrEqual(1)
  })
})
