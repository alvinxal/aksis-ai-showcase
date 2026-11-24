import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { registerWeb } from './web.js'

let root: string
const apiOnly = { checkDatabase: async () => undefined }

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aksis-web-'))
  mkdirSync(path.join(root, 'assets'))
  mkdirSync(path.join(root, 'avatars'))
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Aksis AI</title>')
  writeFileSync(path.join(root, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(path.join(root, 'avatars', 'aksis.webp'), 'webp')
  writeFileSync(path.join(root, 'logo-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(path.join(root, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(path.join(root, 'manifest.webmanifest'), '{"name":"Aksis AI"}')
  writeFileSync(path.join(root, '.secret'), 'nope')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('public site', () => {
  it('serves index.html at / with a strict CSP and no long cache', async () => {
    const response = await createApp({ ...apiOnly, webRoot: root }).request('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Aksis AI')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('caches hashed bundles for a year and other files for a day', async () => {
    const app = createApp({ ...apiOnly, webRoot: root })
    expect((await app.request('/assets/index-abc.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await app.request('/avatars/aksis.webp')).headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await app.request('/logo-mark.svg')).headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('does not cache a missing file and does not serve anything else', async () => {
    const app = createApp({ ...apiOnly, webRoot: root })
    const missing = await app.request('/assets/index-zzz.js')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBeNull()
    expect((await app.request('/index.html')).status).toBe(404)
    expect((await app.request('/.secret')).status).toBe(404)
    expect((await app.request('/assets/../index.html')).status).not.toBe(200)
    expect((await app.request('/assets/%2e%2e/.secret')).status).toBe(404)
  })

  it('leaves every backend route alone: no SPA fallback', async () => {
    const app = createApp({ ...apiOnly, webRoot: root })
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok', database: 'ok' })
    for (const route of ['/preview', '/v1/anything', '/join']) {
      expect((await app.request(route)).status, route).toBe(404)
    }
    const remote = await app.request('http://aksis.flaat.studio/setup/whatsapp', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(remote.status).toBe(404)
  })

  it('serves the app shell for the single-page onboarding, never cached, with the strict CSP', async () => {
    const app = createApp({ ...apiOnly, webRoot: root })
    for (const route of ['/onboarding', '/onboarding/anything', '/app', '/app/proyek/p1', '/terms', '/privacy', '/akses']) {
      const response = await app.request(route)
      expect(response.status, route).toBe(200)
      expect(await response.text()).toContain('Aksis AI')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })

  it('lets a phone install the app: the manifest and worker are served and always revalidated', async () => {
    const app = createApp({ ...apiOnly, webRoot: root })
    const manifest = await app.request('/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('content-type') ?? '').toMatch(/json/)
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    const worker = await app.request('/sw.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type') ?? '').toMatch(/javascript/)
    expect(worker.headers.get('cache-control')).toBe('no-cache')
    const csp = (await app.request('/app')).headers.get('content-security-policy') ?? ''
    expect(csp).toContain("manifest-src 'self'")
    expect(csp).toContain("worker-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
  })

  it('shows the same shell for an invitation link without spending it', async () => {
    let spent = 0
    const onboarding = {
      join: async () => {
        spent++
        return null
      },
      getSession: async () => null,
      saveProfile: async () => undefined,
      complete: async () => undefined,
      whatsapp: { status: () => null, start: async () => 'started' as const, requestCode: async () => true, listGroups: async () => [], saveGroups: async () => ({ ok: true as const, count: 0 }) },
      secureCookies: false,
    }
    const response = await createApp({ ...apiOnly, webRoot: root, onboarding }).request('/join/nope')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Aksis AI')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(spent).toBe(0)
  })

  it('registers nothing when there is no build', () => {
    expect(registerWeb(new Hono(), path.join(root, 'missing'))).toBeNull()
    expect(registerWeb(new Hono(), root)).toBeTypeOf('function')
  })
})
