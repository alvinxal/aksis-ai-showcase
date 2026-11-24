// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createInvitation } from './admin.js'
import { createDatabase, type Database } from './db.js'
import { attentionItems } from './ops.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('needs attention', () => {
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

  const tenant = async (status: string, createdHoursAgo = 0) => {
    const { tenantId } = await createInvitation(sql, `Test ${randomUUID()}`, 1, null)
    tenants.push(tenantId)
    await sql`update tenants set status = ${status}, created_at = now() - make_interval(hours => ${createdHoursAgo}) where id = ${tenantId}`
    return tenantId
  }
  const mine = async (connection?: string) => (await attentionItems(sql, () => connection)).filter((item) => tenants.includes(item.tenantId))

  it('flags onboarding that has been stuck for a day, not a fresh invitation', async () => {
    const stuck = await tenant('onboarding', 30)
    await tenant('invited', 1)
    expect((await mine()).map((item) => [item.tenantId, item.kind])).toEqual([[stuck, 'stuck']])
  })

  it('flags a plan that ends within a week or has ended, not a long one', async () => {
    const ending = await tenant('active')
    const long = await tenant('active')
    await sql`insert into subscriptions (tenant_id, plan_code, started_at, ends_at) values (${ending}, 'trial', now() - interval '10 days', now() + interval '3 days')`
    await sql`insert into subscriptions (tenant_id, plan_code, started_at, ends_at) values (${long}, 'trial', now(), now() + interval '30 days')`
    expect((await mine()).map((item) => [item.tenantId, item.kind])).toEqual([[ending, 'billing']])
  })

  it('flags an active customer whose WhatsApp is not connected, only while it is switched on', async () => {
    const id = await tenant('active')
    await sql`update tenants set whatsapp_enabled = true where id = ${id}`
    expect((await mine('tidak aktif')).map((item) => item.kind)).toEqual(['whatsapp'])
    expect(await mine('connected')).toEqual([])
    await sql`update tenants set whatsapp_enabled = false where id = ${id}`
    expect(await mine('tidak aktif')).toEqual([])
  })

  it('flags a customer paused by a usage limit', async () => {
    const id = await tenant('active')
    await sql`update tenants set usage_paused = true where id = ${id}`
    expect((await mine()).map((item) => item.kind)).toEqual(['paused'])
  })
})
