// Real-database test, see analysis.integration.test.ts for how to run it.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db.js'
import { createAuthService, CODE_MAX_ATTEMPTS, CODE_MAX_REQUESTS } from './auth.js'

const url = process.env.AKSIS_TEST_DATABASE_URL
const SECRET = 'x'.repeat(40)

describe.skipIf(!url)('login by WhatsApp code', () => {
  let sql: Database
  const tenants: string[] = []
  const sent: string[] = []
  const send = async (_tenantId: string, text: string) => void sent.push(text)
  const codeOf = () => /(\d{6})/.exec(sent.at(-1) ?? '')?.[1] ?? ''

  beforeAll(() => {
    sql = createDatabase(url!)
  })
  afterEach(async () => {
    if (tenants.length) await sql`delete from tenants where id in ${sql(tenants)}`
    tenants.length = 0
    sent.length = 0
  })
  afterAll(async () => {
    await sql.end()
  })

  const tenant = async (status = 'active') => {
    const phone = `62${Math.floor(1e9 + Math.random() * 8e9)}`
    const [row] = await sql<Array<{ id: string }>>`
      insert into tenants (name, status, whatsapp_jid) values (${`Test ${randomUUID()}`}, ${status}, ${`${phone}:12@s.whatsapp.net`})
      returning id
    `
    tenants.push(row!.id)
    return { id: row!.id, phone }
  }

  it('logs an active customer in with the code and then reads the session', async () => {
    const { phone, id } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    expect(await auth.requestCode(phone)).toBe('sent')
    const token = await auth.verify(phone, codeOf())
    expect(token).toBeTruthy()
    expect((await auth.getSession(token!))?.tenantId).toBe(id)
    await auth.endSession(token!)
    expect(await auth.getSession(token!)).toBeNull()
  })

  it('stores only a hash, and a code works once', async () => {
    const { phone, id } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    await auth.requestCode(phone)
    const code = codeOf()
    const rows = await sql<Array<{ code_hash: string }>>`select code_hash from login_codes where tenant_id = ${id}`
    expect(rows[0]?.code_hash).not.toContain(code)
    expect(await auth.verify(phone, code)).toBeTruthy()
    expect(await auth.verify(phone, code)).toBeNull()
  })

  it('does not send a code to a customer who is not active or not known', async () => {
    const onboarding = await tenant('onboarding')
    const disabled = await tenant('disabled')
    const auth = createAuthService(sql, SECRET, send)
    expect(await auth.requestCode(onboarding.phone)).toBe('ignored')
    expect(await auth.requestCode(disabled.phone)).toBe('ignored')
    expect(await auth.requestCode('6280000000000')).toBe('ignored')
    expect(sent).toHaveLength(0)
  })

  it('locks a code after too many wrong guesses, even for the right one', async () => {
    const { phone } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    await auth.requestCode(phone)
    const right = codeOf()
    const wrong = right === '000000' ? '111111' : '000000'
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) expect(await auth.verify(phone, wrong)).toBeNull()
    expect(await auth.verify(phone, right)).toBeNull()
  })

  it('replaces an older code when a new one is asked for', async () => {
    const { phone } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    await auth.requestCode(phone)
    const first = codeOf()
    await auth.requestCode(phone)
    const second = codeOf()
    if (first !== second) expect(await auth.verify(phone, first)).toBeNull()
    expect(await auth.verify(phone, second)).toBeTruthy()
  })

  it('refuses a code that expired', async () => {
    const { phone, id } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    await auth.requestCode(phone)
    await sql`update login_codes set expires_at = now() - interval '1 minute' where tenant_id = ${id}`
    expect(await auth.verify(phone, codeOf())).toBeNull()
  })

  it('limits how many codes one customer can ask for', async () => {
    const { phone } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    for (let i = 0; i < CODE_MAX_REQUESTS; i += 1) expect(await auth.requestCode(phone)).toBe('sent')
    expect(await auth.requestCode(phone)).toBe('ignored')
    expect(sent).toHaveLength(CODE_MAX_REQUESTS)
  })

  it('does not count a code that logged someone in, so login, logout and login again keeps working', async () => {
    const { phone } = await tenant()
    const auth = createAuthService(sql, SECRET, send)
    for (let i = 0; i < CODE_MAX_REQUESTS + 2; i += 1) {
      expect(await auth.requestCode(phone)).toBe('sent')
      const token = await auth.verify(phone, codeOf())
      expect(token).toBeTruthy()
      await auth.endSession(token!)
    }
  })

  it('gives no code when WhatsApp cannot send, and revokes the session when the customer is disabled', async () => {
    const { phone, id } = await tenant()
    const failing = createAuthService(sql, SECRET, async () => {
      throw new Error('WhatsApp is not connected')
    })
    expect(await failing.requestCode(phone)).toBe('ignored')
    const auth = createAuthService(sql, SECRET, send)
    await auth.requestCode(phone)
    const token = await auth.verify(phone, codeOf())
    await sql`update tenants set status = 'disabled' where id = ${id}`
    expect(await auth.getSession(token!)).toBeNull()
  })
})
