// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { activateAfterOnboarding } from './activation.js'
import { createInvitation, setTenantStatus } from './admin.js'
import { createDatabase, type Database } from './db.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('activation after onboarding', () => {
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

  const tenantWith = async (status: string) => {
    const { tenantId } = await createInvitation(sql, `Test ${randomUUID()}`, 1, null)
    tenants.push(tenantId)
    await sql`update tenants set status = ${status} where id = ${tenantId}`
    return tenantId
  }
  const state = async (tenantId: string) => {
    const [row] = await sql<Array<{ status: string; plan: string | null }>>`
      select t.status, s.plan_code as plan from tenants t left join subscriptions s on s.tenant_id = t.id where t.id = ${tenantId}
    `
    return row!
  }

  it('activates an onboarding tenant and starts the trial once', async () => {
    const id = await tenantWith('onboarding')
    expect(await activateAfterOnboarding(sql, id)).toBe(true)
    expect(await state(id)).toEqual({ status: 'active', plan: 'trial' })
    expect(await activateAfterOnboarding(sql, id)).toBe(false)
  })

  it('leaves a disabled tenant disabled', async () => {
    const id = await tenantWith('onboarding')
    await setTenantStatus(sql, id, 'disabled')
    expect(await activateAfterOnboarding(sql, id)).toBe(false)
    expect(await state(id)).toEqual({ status: 'disabled', plan: null })
  })
})
