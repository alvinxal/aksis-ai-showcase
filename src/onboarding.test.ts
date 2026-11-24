import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashToken, newToken, type OnboardingSession } from './admin.js'
import { createApp, type WhatsAppStatus } from './app.js'
import type { OnboardingDependencies, OnboardingState } from './onboarding.js'

const webRoot = mkdtempSync(path.join(tmpdir(), 'aksis-onboarding-'))
writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Aksis AI</title>')

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'

const session: OnboardingSession = {
  tenantId: 't1',
  tenantName: 'Studio <Uji>',
  status: 'onboarding',
  contactName: null,
  onboardedAt: null,
}
const profiled: OnboardingSession = { ...session, contactName: 'Dewi' }

const status = (overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus => ({
  enabled: true,
  connection: 'connected',
  qr: null,
  lastError: null,
  ...overrides,
})

type Notice = [string, string | undefined]

function buildApp(overrides: Partial<OnboardingDependencies> = {}) {
  const saved: Array<[string, string, string]> = []
  const notices: Notice[] = []
  const onboarding: OnboardingDependencies = {
    join: async (token) => (token === 'valid' ? { sessionToken: 'sess', session } : null),
    getSession: async (token) => (token === 'sess' ? session : null),
    saveProfile: async (tenantId, studio, contact) => {
      saved.push([tenantId, studio, contact])
    },
    complete: async () => undefined,
    whatsapp: {
      status: () => null,
      start: async () => 'started',
      requestCode: async () => true,
      listGroups: async () => [],
      saveGroups: async () => ({ ok: true, count: 0 }),
    },
    notify: (text, id) => void notices.push([text, id]),
    secureCookies: false,
    ...overrides,
  }
  return { app: createApp({ checkDatabase: async () => undefined, onboarding, webRoot }), saved, notices }
}

const cookie = { cookie: 'aksis_session=sess' }
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { ...cookie, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const stateOf = async (app: ReturnType<typeof buildApp>['app']) =>
  (await (await app.request('/v1/onboarding/state', { headers: cookie })).json()) as OnboardingState

describe('tokens', () => {
  it('generates unique url-safe tokens and hashes them deterministically', () => {
    const a = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newToken()).not.toBe(a)
    expect(hashToken(a)).toBe(hashToken(a))
    expect(hashToken(a)).not.toBe(a)
  })
})

const joinRequest = (token: string, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': PHONE, ...headers },
  body: JSON.stringify({ token }),
})

describe('invitation link', () => {
  it('only shows the page when the link is opened, so a preview, a scanner or a desktop cannot spend it', async () => {
    let spent = 0
    const { app } = buildApp({
      join: async () => {
        spent++
        return { sessionToken: 'sess', session }
      },
    })
    for (const agent of [PHONE, DESKTOP, 'WhatsApp/2.23.20.76 A', 'facebookexternalhit/1.1', 'TelegramBot (like TwitterBot)']) {
      const response = await app.request('/join/valid', { headers: { 'user-agent': agent } })
      expect(response.status, agent).toBe(200)
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toContain('Aksis AI')
    }
    expect(spent).toBe(0)
  })

  it('spends the invitation on POST /v1/join and sets a hardened cookie', async () => {
    const { app, notices } = buildApp()
    const response = await app.request('/v1/onboarding/state', { headers: cookie })
    expect(response.status).toBe(200) // sanity: the stub session works
    const joined = await app.request('/v1/join', joinRequest('valid'))
    expect(joined.status).toBe(200)
    expect(await joined.json()).toEqual({ ok: true })
    const setCookie = joined.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('aksis_session=sess')
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(joined.headers.get('referrer-policy')).toBe('no-referrer')
    expect(notices[0]?.[0]).toContain('Undangan dibuka')
  })

  it('rejects an unknown invitation without setting a session', async () => {
    const response = await buildApp().app.request('/v1/join', joinRequest('nope'))
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({ error: 'invalid_link' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect((await buildApp().app.request('/v1/join', { ...joinRequest(''), body: '{}' })).status).toBe(410)
  })

  it('refuses a desktop browser and leaves the link unspent', async () => {
    let spent = 0
    const { app } = buildApp({
      join: async () => {
        spent++
        return { sessionToken: 'sess', session }
      },
    })
    const response = await app.request('/v1/join', joinRequest('valid', { 'user-agent': DESKTOP }))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'phone_only' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(spent).toBe(0)
  })

  it('refuses cross-site posts and anything that is not JSON', async () => {
    const { app } = buildApp()
    expect((await app.request('/v1/join', joinRequest('valid', { origin: 'https://evil.example', host: 'aksis.test' }))).status).toBe(403)
    const form = await app.request('/v1/join', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': PHONE }, body: 'token=valid' })
    expect(form.status).toBe(415)
  })

  it('uses the __Host- cookie on a secure deployment and still reads the old cookie', async () => {
    const { app } = buildApp({ secureCookies: true })
    const response = await app.request('/v1/join', joinRequest('valid'))
    const cookies = response.headers.getSetCookie()
    const hostCookie = cookies.find((value) => value.startsWith('__Host-aksis_session='))!
    expect(hostCookie).toMatch(/Secure/i)
    expect(hostCookie).toMatch(/Path=\//i)
    expect(hostCookie).not.toMatch(/Domain=/i)

    const withHost = await app.request('/v1/onboarding/state', { headers: { cookie: '__Host-aksis_session=sess' } })
    expect(withHost.status).toBe(200)
    // A customer who opened the link before the prefix existed keeps working.
    const withOld = await app.request('/v1/onboarding/state', { headers: cookie })
    expect(withOld.status).toBe(200)
  })
})

describe('GET /v1/onboarding/state', () => {
  it('needs a session and is never cached', async () => {
    const { app } = buildApp()
    const anonymous = await app.request('/v1/onboarding/state')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'unauthorized' })
    const response = await app.request('/v1/onboarding/state', { headers: cookie })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('walks the steps: profile, whatsapp, pairing, groups, done', async () => {
    expect((await stateOf(buildApp().app)).step).toBe('profile')

    const intro = buildApp({ getSession: async () => profiled })
    expect(await stateOf(intro.app)).toMatchObject({ step: 'whatsapp', contactName: 'Dewi', pairing: null, groups: null })

    const waiting = buildApp({
      getSession: async () => profiled,
      whatsapp: {
        status: () => status({ connection: 'qr_ready', qr: 'qr-data' }),
        start: async () => 'exists',
        requestCode: async () => true,
        listGroups: async () => [],
        saveGroups: async () => ({ ok: true, count: 0 }),
      },
    })
    const pairing = await stateOf(waiting.app)
    expect(pairing.step).toBe('pairing')
    expect(pairing.pairing?.qr).toMatch(/^data:image\/png;base64,/)
    expect(pairing.pairing?.pairingCode).toBeNull()

    const done = buildApp({ getSession: async () => ({ ...profiled, onboardedAt: new Date() }) })
    expect((await stateOf(done.app)).step).toBe('done')
  })

  it('returns the tenant name as data, never as markup', async () => {
    const state = await stateOf(buildApp().app)
    expect(state.tenantName).toBe('Studio <Uji>')
  })

  it('passes a pairing code through instead of a QR when one was requested', async () => {
    const { app } = buildApp({
      getSession: async () => profiled,
      whatsapp: {
        status: () => status({ connection: 'qr_ready', qr: 'qr-data', pairingCode: 'ABCD1234' }),
        start: async () => 'exists',
        requestCode: async () => true,
        listGroups: async () => [],
        saveGroups: async () => ({ ok: true, count: 0 }),
      },
    })
    expect((await stateOf(app)).pairing?.pairingCode).toBe('ABCD1234')
  })

  it('lists the groups with the plan limit once connected, and reports a failed load', async () => {
    const group = { jid: 'g1@g.us', subject: 'Rumah <Budi>', participants: 4, selected: false }
    const base = { status: () => status(), start: async () => 'exists' as const, requestCode: async () => true, saveGroups: async () => ({ ok: true as const, count: 0 }) }

    const ok = buildApp({ getSession: async () => profiled, groupLimit: async () => 3, whatsapp: { ...base, listGroups: async () => [group] } })
    expect(await stateOf(ok.app)).toMatchObject({ step: 'groups', groups: { items: [group], limit: 3, loadFailed: false } })

    const failing = buildApp({
      getSession: async () => profiled,
      whatsapp: {
        ...base,
        listGroups: async () => {
          throw new Error('not connected')
        },
      },
    })
    expect(await stateOf(failing.app)).toMatchObject({ step: 'groups', groups: { items: [], limit: 5, loadFailed: true } })
  })
})

describe('choosing a plan before the groups', () => {
  const connected = { whatsapp: { status: () => status(), start: async () => 'started' as const, requestCode: async () => true, listGroups: async () => [], saveGroups: async () => ({ ok: true as const, count: 1 }) } }

  it('waits for an admin when the customer has no plan, and asks the admins once per page load', async () => {
    const requested: Array<[string, string]> = []
    const { app } = buildApp({ ...connected, getSession: async () => profiled, hasPlan: async () => false, requestPlan: async (id, name) => void requested.push([id, name]) })
    expect((await stateOf(app)).step).toBe('plan')
    expect(requested).toEqual([[profiled.tenantId, profiled.tenantName]])
  })

  it('moves on to the groups once there is a plan, and shows the group limit of that plan', async () => {
    const { app } = buildApp({ ...connected, getSession: async () => profiled, hasPlan: async () => true, groupLimit: async () => 5 })
    const state = await stateOf(app)
    expect(state.step).toBe('groups')
    expect(state.groups?.limit).toBe(5)
  })

  it('refuses to save groups while no plan has been chosen', async () => {
    const { app } = buildApp({ ...connected, getSession: async () => profiled, hasPlan: async () => false })
    const response = await app.request('/v1/onboarding/groups', post({ groups: ['g1'] }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'plan_pending' })
  })

  it('does not ask for a plan before WhatsApp is connected', async () => {
    const requested: string[] = []
    const { app } = buildApp({ getSession: async () => profiled, hasPlan: async () => false, requestPlan: async (id) => void requested.push(id) })
    expect((await stateOf(app)).step).toBe('whatsapp')
    expect(requested).toEqual([])
  })
})

describe('POST /v1/onboarding/profile', () => {
  it('saves a tidied profile and tells the admins', async () => {
    const { app, saved, notices } = buildApp()
    const response = await app.request('/v1/onboarding/profile', post({ studio: '  Studio   Baru ', name: 'Dewi', terms: true }))
    expect(response.status).toBe(200)
    expect(saved).toEqual([['t1', 'Studio Baru', 'Dewi']])
    expect(notices[0]?.[0]).toContain('Studio Baru')
  })

  it('blocks cross-origin posts, form posts, missing sessions and incomplete profiles', async () => {
    const { app, saved } = buildApp()
    const forged = await app.request('/v1/onboarding/profile', post({ studio: 'S', name: 'N' }, { origin: 'https://evil.example', host: 'aksis.test' }))
    expect(forged.status).toBe(403)
    const form = await app.request('/v1/onboarding/profile', {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'studio=S&name=N',
    })
    expect(form.status).toBe(415)
    const anonymous = await app.request('/v1/onboarding/profile', { ...post({ studio: 'S', name: 'N' }), headers: { 'content-type': 'application/json' } })
    expect(anonymous.status).toBe(401)
    expect((await app.request('/v1/onboarding/profile', post({ studio: '  ', name: 'N' }))).status).toBe(400)
    const noConsent = await app.request('/v1/onboarding/profile', post({ studio: 'S', name: 'N' }))
    expect(noConsent.status).toBe(400)
    expect(await noConsent.json()).toEqual({ error: 'terms_required' })
    expect((await app.request('/v1/onboarding/profile', post({ studio: 'S', name: 'N', terms: 'true' }))).status).toBe(400)
    expect((await app.request('/v1/onboarding/profile', post([1]))).status).toBe(400)
    expect((await app.request('/v1/onboarding/profile', { ...post(null), body: '{nope' })).status).toBe(400)
    expect(saved).toHaveLength(0)
  })
})

describe('POST /v1/onboarding/whatsapp/start', () => {
  const withStart = (result: 'started' | 'exists' | 'full' | 'unavailable') =>
    buildApp({
      getSession: async () => profiled,
      whatsapp: { status: () => null, start: async () => result, requestCode: async () => true, listGroups: async () => [], saveGroups: async () => ({ ok: true, count: 0 }) },
    })

  it('starts pairing and tells the admins', async () => {
    const { app, notices } = withStart('started')
    const response = await app.request('/v1/onboarding/whatsapp/start', post({}))
    expect(await response.json()).toEqual({ result: 'started' })
    expect(notices[0]?.[0]).toContain('Pairing WhatsApp dimulai')
  })

  it('reports a full slot with a warning to the admins', async () => {
    const { app, notices } = withStart('full')
    const response = await app.request('/v1/onboarding/whatsapp/start', post({}))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'full' })
    expect(notices[0]?.[0]).toContain('Slot WhatsApp penuh')
  })

  it('refuses a tenant that may not pair', async () => {
    expect((await withStart('unavailable').app.request('/v1/onboarding/whatsapp/start', post({}))).status).toBe(409)
  })
})

describe('POST /v1/onboarding/whatsapp/code', () => {
  const withCode = (issued: boolean, start: 'started' | 'full' = 'started') => {
    const requested: string[] = []
    const built = buildApp({
      getSession: async () => profiled,
      whatsapp: {
        status: () => null,
        start: async () => start,
        requestCode: async (_tenantId, phone) => {
          requested.push(phone)
          return issued
        },
        listGroups: async () => [],
        saveGroups: async () => ({ ok: true, count: 0 }),
      },
    })
    return { ...built, requested }
  }

  it('requests a code for the normalized number', async () => {
    const { app, requested } = withCode(true)
    const response = await app.request('/v1/onboarding/whatsapp/code', post({ phone: '0812-3456-7890' }))
    expect(await response.json()).toEqual({ ok: true })
    expect(requested).toEqual(['6281234567890'])
  })

  it('rejects a bad number before touching WhatsApp', async () => {
    const { app, requested } = withCode(true)
    const response = await app.request('/v1/onboarding/whatsapp/code', post({ phone: '123' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_phone' })
    expect(requested).toEqual([])
  })

  it('reports when WhatsApp gives no code, and when there is no free slot', async () => {
    const failed = await withCode(false).app.request('/v1/onboarding/whatsapp/code', post({ phone: '+6281234567890' }))
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'code_failed' })
    const full = withCode(true, 'full')
    const response = await full.app.request('/v1/onboarding/whatsapp/code', post({ phone: '+6281234567890' }))
    expect(response.status).toBe(409)
    expect(full.requested).toEqual([])
  })
})

describe('POST /v1/onboarding/groups', () => {
  const connected = (saveGroups: OnboardingDependencies['whatsapp']['saveGroups'], extra: Partial<OnboardingDependencies> = {}) =>
    buildApp({
      getSession: async () => profiled,
      whatsapp: { status: () => status(), start: async () => 'exists', requestCode: async () => true, listGroups: async () => [], saveGroups },
      ...extra,
    })

  it('saves the selection, finishes onboarding and offers the admins an activate action', async () => {
    const saved: string[][] = []
    let completed = false
    const { app, notices } = connected(
      async (_tenantId, jids) => {
        saved.push(jids)
        return { ok: true, count: jids.length }
      },
      { complete: async () => void (completed = true) },
    )
    const response = await app.request('/v1/onboarding/groups', post({ groups: ['g1@g.us', 'g2@g.us', 7] }))
    expect(await response.json()).toEqual({ ok: true, count: 2 })
    expect(saved).toEqual([['g1@g.us', 'g2@g.us']])
    expect(completed).toBe(true)
    expect(notices.at(-1)).toEqual(['Onboarding selesai, akun aktif: Studio <Uji> (2 grup)', 't1'])
  })

  it('shows the limit error and does not finish onboarding', async () => {
    let completed = false
    const { app } = connected(async () => ({ ok: false, reason: 'Maksimal 5 grup untuk paket Anda.' }), { complete: async () => void (completed = true) })
    const response = await app.request('/v1/onboarding/groups', post({ groups: ['a'] }))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'groups_rejected', message: 'Maksimal 5 grup untuk paket Anda.' })
    expect(completed).toBe(false)
  })

  it('ignores group saves while WhatsApp is not connected', async () => {
    let saves = 0
    const { app } = buildApp({
      getSession: async () => profiled,
      whatsapp: {
        status: () => null,
        start: async () => 'exists',
        requestCode: async () => true,
        listGroups: async () => [],
        saveGroups: async () => {
          saves++
          return { ok: true, count: 0 }
        },
      },
    })
    const response = await app.request('/v1/onboarding/groups', post({ groups: ['a'] }))
    expect(response.status).toBe(409)
    expect(saves).toBe(0)
  })
})

describe('POST /v1/onboarding/logout', () => {
  it('clears the session cookie and blocks cross-origin posts', async () => {
    const { app } = buildApp()
    const response = await app.request('/v1/onboarding/logout', { method: 'POST', headers: cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie') ?? '').toContain('aksis_session=;')
    const forged = await app.request('/v1/onboarding/logout', { method: 'POST', headers: { ...cookie, origin: 'https://evil.example', host: 'aksis.test' } })
    expect(forged.status).toBe(403)
  })
})
