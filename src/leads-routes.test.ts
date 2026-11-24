import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerLeads } from './leads-routes.js'

function build() {
  const submit = vi.fn(async (_name: string, _phone: string) => undefined)
  const app = new Hono()
  registerLeads(app, { submit })
  const post = (body: unknown, headers: Record<string, string> = {}, ip = '1.1.1.1') =>
    app.request('/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'aksis.test', 'cf-connecting-ip': ip, ...headers },
      body: JSON.stringify(body),
    })
  return { submit, post, app }
}
const valid = { name: '  Dewi   Lestari ', phone: '0812-3456-7890', terms: true }

describe('POST /v1/leads', () => {
  it('stores a tidied request and answers ok', async () => {
    const { submit, post } = build()
    const response = await post(valid)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(submit).toHaveBeenCalledWith('Dewi Lestari', '6281234567890')
  })

  it('answers the same for a number that already asked, so numbers cannot be probed', async () => {
    const { post } = build()
    const first = await (await post(valid)).json()
    const again = await (await post(valid, {}, '2.2.2.2')).json()
    expect(again).toEqual(first)
  })

  it('rejects a missing name, a bad number and a missing consent', async () => {
    const { submit, post } = build()
    expect((await post({ ...valid, name: ' ' })).status).toBe(400)
    expect((await post({ ...valid, phone: '12' })).status).toBe(400)
    const noTerms = await post({ ...valid, terms: undefined })
    expect(noTerms.status).toBe(400)
    expect(await noTerms.json()).toEqual({ error: 'terms_required' })
    expect((await post({ ...valid, terms: 'true' })).status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
  })

  it('pretends to work but stores nothing when the hidden field is filled in', async () => {
    const { submit, post } = build()
    const response = await post({ ...valid, website: 'http://spam.example' })
    expect(await response.json()).toEqual({ ok: true })
    expect(submit).not.toHaveBeenCalled()
  })

  it('blocks cross-site posts, form posts and broken JSON', async () => {
    const { submit, post, app } = build()
    expect((await post(valid, { origin: 'https://evil.example' })).status).toBe(403)
    const form = await app.request('/v1/leads', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'aksis.test' }, body: 'name=a' })
    expect(form.status).toBe(415)
    const broken = await app.request('/v1/leads', { method: 'POST', headers: { 'content-type': 'application/json', host: 'aksis.test' }, body: '{nope' })
    expect(broken.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
  })

  it('limits one address to five requests an hour and one number to three a day', async () => {
    const { submit, post } = build()
    for (let i = 0; i < 4; i += 1) expect((await post(valid, {}, `9.9.9.${i}`)).status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(3)

    const limited = build()
    for (let i = 0; i < 5; i += 1) expect((await limited.post({ ...valid, phone: `0812000000${i}0` })).status).toBe(200)
    expect((await limited.post(valid)).status).toBe(429)
  })
})
