// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createInvitation, createInvitationForTenant, getTenantPhone, joinWithInvitation } from './admin.js'
import { createDatabase, type Database } from './db.js'
import { getTenantInvitation, pruneInvitationPhones, renewInvitation, renewTenantInvitation, revokeInvitation, revokeTenantInvitations } from './ops.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const PHONE = '6281234567890'

describe.skipIf(!url)('the phone number of an invitation', () => {
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

  const phoneOf = async (tenantId: string) =>
    (await sql<Array<{ phone: string | null; revoked: boolean }>>`
      select phone, revoked_at is not null as revoked from invitations where tenant_id = ${tenantId} order by created_at
    `)
  const invite = async (phone: string | null = PHONE) => {
    const created = await createInvitation(sql, `Test ${randomUUID()}`, 1, phone)
    tenants.push(created.tenantId)
    const [row] = await sql<Array<{ id: string }>>`select id from invitations where tenant_id = ${created.tenantId}`
    return { ...created, invitationId: row!.id }
  }

  it('is kept while the invitation is open and forgotten once it is used', async () => {
    const { tenantId, token } = await invite()
    expect((await phoneOf(tenantId))[0]?.phone).toBe(PHONE)
    expect(await joinWithInvitation(sql, token)).not.toBeNull()
    expect((await phoneOf(tenantId))[0]?.phone).toBeNull()
  })

  it('is forgotten when the invitation is revoked', async () => {
    const { tenantId, invitationId } = await invite()
    await revokeInvitation(sql, invitationId)
    expect((await phoneOf(tenantId))[0]).toEqual({ phone: null, revoked: true })
  })

  it('moves to the new link when it is renewed, and the old link forgets it', async () => {
    const { tenantId, invitationId } = await invite()
    const renewed = await renewInvitation(sql, invitationId, 1)
    expect(renewed?.phone).toBe(PHONE)
    const rows = await phoneOf(tenantId)
    expect(rows).toEqual([{ phone: null, revoked: true }, { phone: PHONE, revoked: false }])
  })

  it('is forgotten after the invitation has expired', async () => {
    const { tenantId } = await invite()
    await sql`update invitations set expires_at = now() - interval '1 minute' where tenant_id = ${tenantId}`
    await pruneInvitationPhones(sql)
    expect((await phoneOf(tenantId))[0]?.phone).toBeNull()
  })

  it('is not touched while the invitation is still open', async () => {
    const { tenantId } = await invite()
    await pruneInvitationPhones(sql)
    expect((await phoneOf(tenantId))[0]?.phone).toBe(PHONE)
  })

  it('stores nothing when no number was given', async () => {
    const { tenantId } = await invite(null)
    expect((await phoneOf(tenantId))[0]?.phone).toBeNull()
  })

  it('reads a customer\'s linked number from the jid, without the device part', async () => {
    const { tenantId } = await invite(null)
    expect(await getTenantPhone(sql, tenantId)).toBeNull()
    await sql`update tenants set whatsapp_jid = '6281234567890:12@s.whatsapp.net' where id = ${tenantId}`
    expect(await getTenantPhone(sql, tenantId)).toBe(PHONE)
    await sql`update tenants set whatsapp_jid = '1234@lid' where id = ${tenantId}`
    expect(await getTenantPhone(sql, tenantId)).toBeNull()
  })

  describe('the invitation as the customer card sees it', () => {
    it('is waiting, then expired, then used, and gone once revoked', async () => {
      const { tenantId, token } = await invite(null)
      expect(await getTenantInvitation(sql, tenantId)).toMatchObject({ used: false, expired: false })
      await sql`update invitations set expires_at = now() - interval '1 minute' where tenant_id = ${tenantId}`
      expect(await getTenantInvitation(sql, tenantId)).toMatchObject({ used: false, expired: true })
      await sql`update invitations set expires_at = now() + interval '1 hour' where tenant_id = ${tenantId}`
      await joinWithInvitation(sql, token)
      expect(await getTenantInvitation(sql, tenantId)).toMatchObject({ used: true })
      await sql`update invitations set revoked_at = now() where tenant_id = ${tenantId}`
      expect(await getTenantInvitation(sql, tenantId)).toBeNull()
    })

    it('revokes only the links nobody has opened', async () => {
      const { tenantId, token } = await invite(null)
      await joinWithInvitation(sql, token) // the first link is used
      await createInvitationForTenant(sql, tenantId, 1) // a second one waits
      await revokeTenantInvitations(sql, tenantId)
      const rows = await sql<Array<{ used: boolean; revoked: boolean }>>`
        select used_at is not null as used, revoked_at is not null as revoked from invitations where tenant_id = ${tenantId} order by created_at
      `
      expect(rows).toEqual([{ used: true, revoked: false }, { used: false, revoked: true }])
    })

    it('renews from the tenant, carrying a number along and leaving none behind when there was none', async () => {
      const withNumber = await invite()
      const renewed = await renewTenantInvitation(sql, withNumber.tenantId, 1)
      expect(renewed.phone).toBe(PHONE)
      expect((await phoneOf(withNumber.tenantId)).map((row) => row.phone)).toEqual([null, PHONE])

      const without = await invite(null)
      expect((await renewTenantInvitation(sql, without.tenantId, 1)).phone).toBeNull()
      expect(await getTenantInvitation(sql, without.tenantId)).toMatchObject({ used: false, expired: false })
    })
  })
})
