// Real-database test, see analysis.integration.test.ts for how to run it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from './db.js'
import { createDatabase } from './db.js'
import { claimLead, countNewLeads, createLead, getLead, listOpenLeads, purgeOldLeads, restoreLead, setLeadStatus } from './leads.js'

const url = process.env.AKSIS_TEST_DATABASE_URL

describe.skipIf(!url)('access requests', () => {
  let sql: Database
  const phones: string[] = []
  const phone = () => {
    const value = `62${Math.floor(1e9 + Math.random() * 8e9)}`
    phones.push(value)
    return value
  }

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (phones.length) await sql`delete from leads where phone in ${sql(phones)}`
    phones.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  it('keeps one open request per number, and lets a rejected number ask again', async () => {
    const number = phone()
    const first = await createLead(sql, 'Dewi', number, 'v1')
    expect(first?.status).toBe('new')
    expect(await createLead(sql, 'Dewi Lagi', number, 'v1')).toBeNull()

    await setLeadStatus(sql, first!.id, 'contacted')
    expect(await createLead(sql, 'Dewi', number, 'v1')).toBeNull()
    await setLeadStatus(sql, first!.id, 'rejected')
    expect((await createLead(sql, 'Dewi', number, 'v1'))?.status).toBe('new')
  })

  it('counts and lists only open requests', async () => {
    const before = await countNewLeads(sql)
    const a = await createLead(sql, 'A', phone(), 'v1')
    const b = await createLead(sql, 'B', phone(), 'v1')
    await setLeadStatus(sql, b!.id, 'rejected')
    expect(await countNewLeads(sql)).toBe(before + 1)
    const open = (await listOpenLeads(sql, 500)).map((lead) => lead.id)
    expect(open).toContain(a!.id)
    expect(open).not.toContain(b!.id)
  })

  it('hands a request to one invitation only, and can put it back', async () => {
    const lead = await createLead(sql, 'Dewi', phone(), 'v1')
    const [one, two] = await Promise.all([claimLead(sql, lead!.id), claimLead(sql, lead!.id)])
    expect([one, two].filter(Boolean)).toHaveLength(1)
    expect(await getLead(sql, lead!.id)).toBeNull()

    await restoreLead(sql, one ?? two!)
    expect((await listOpenLeads(sql, 500)).some((item) => item.phone === lead!.phone)).toBe(true)
  })

  it('deletes requests 30 days after they came in', async () => {
    const old = await createLead(sql, 'Lama', phone(), 'v1')
    const fresh = await createLead(sql, 'Baru', phone(), 'v1')
    await sql`update leads set created_at = now() - interval '31 days' where id = ${old!.id}`
    expect(await purgeOldLeads(sql)).toBeGreaterThanOrEqual(1)
    expect(await getLead(sql, old!.id)).toBeNull()
    expect(await getLead(sql, fresh!.id)).not.toBeNull()
  })
})
