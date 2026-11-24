// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { activateAfterOnboarding, markPlanRequested } from './activation.js'
import { getSubscription, grantSubscription, hasSubscription, startTrial } from './billing.js'
import { createDatabase, type Database } from './db.js'
import { attentionItems } from './ops.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('choosing a plan when WhatsApp is connected', () => {
  let sql: Database
  const tenants: string[] = []

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  const onboarding = async () => {
    const [row] = await sql<Array<{ id: string }>>`insert into tenants (name, status, usage_paused) values (${`Studio ${randomUUID()}`}, 'onboarding', true) returning id`
    tenants.push(row!.id)
    return row!.id
  }

  it('marks the request once, and only for a customer without a plan', async () => {
    const id = await onboarding()
    expect(await markPlanRequested(sql, id)).toBe(true)
    expect(await markPlanRequested(sql, id)).toBe(false)

    const planned = await onboarding()
    await startTrial(sql, planned)
    expect(await markPlanRequested(sql, planned)).toBe(false)
  })

  it('lists a customer that waits for a plan among the things that need attention, until a plan is chosen', async () => {
    const id = await onboarding()
    const waiting = async () => (await attentionItems(sql, () => undefined)).filter((item) => item.tenantId === id)
    expect(await waiting()).toEqual([])
    await markPlanRequested(sql, id)
    expect(await waiting()).toEqual([{ tenantId: id, name: expect.any(String), kind: 'plan', detail: 'menunggu paket dipilih' }])
    await grantSubscription(sql, id, 'basic', 1, 111)
    expect(await waiting()).toEqual([])
  })

  it('keeps the chosen plan when the onboarding is finished, instead of starting a trial', async () => {
    const id = await onboarding()
    expect(await hasSubscription(sql, id)).toBe(false)
    await grantSubscription(sql, id, 'pro', 3, 111)
    expect(await hasSubscription(sql, id)).toBe(true)

    expect(await activateAfterOnboarding(sql, id)).toBe(true)
    expect((await getSubscription(sql, id))?.planCode).toBe('pro')
  })

  it('starts a 14-day trial when that is chosen', async () => {
    const id = await onboarding()
    expect(await startTrial(sql, id)).toBe(true)
    expect(await startTrial(sql, id)).toBe(false)
    const subscription = await getSubscription(sql, id)
    expect(subscription?.planCode).toBe('trial')
    const days = Math.round(((subscription?.endsAt.getTime() ?? 0) - Date.now()) / 86_400_000)
    expect(days).toBe(14)
  })
})
