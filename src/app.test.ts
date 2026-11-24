import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('GET /health', () => {
  it('reports a healthy database', async () => {
    const app = createApp({ checkDatabase: async () => undefined })
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok', database: 'ok' })
  })

  it('reports an unavailable database', async () => {
    const app = createApp({
      checkDatabase: async () => {
        throw new Error('offline')
      },
    })
    const response = await app.request('/health')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      status: 'degraded',
      database: 'unavailable',
    })
  })
})

describe('operator routes', () => {
  const app = createApp({
    checkDatabase: async () => undefined,
    getWhatsAppStatus: () => ({ enabled: true, connection: 'qr_ready', qr: 'secret-qr', lastError: null }),
    analysis: {
      token: 'tok',
      claim: async () => null,
      complete: async () => undefined,
      fail: async () => undefined,
    },
  })
  const publicHost = 'https://aksis.example.com'

  it('serves them on localhost, as used through an SSH tunnel', async () => {
    expect((await app.request('http://localhost:18880/api/whatsapp/status')).status).toBe(200)
    expect((await app.request('http://127.0.0.1:18880/setup/whatsapp')).status).toBe(200)
  })

  it('hides them from requests that came in through a public hostname', async () => {
    for (const path of ['/api/whatsapp/status', '/setup/whatsapp']) {
      expect((await app.request(`${publicHost}${path}`)).status).toBe(404)
    }
    const internal = await app.request(`${publicHost}/internal/analysis/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
    })
    expect(internal.status).toBe(404)
  })

  it('hides them when proxy headers show the request was forwarded, even for a localhost url', async () => {
    for (const header of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host']) {
      const response = await app.request('http://localhost:18880/api/whatsapp/status', {
        headers: { [header]: '203.0.113.9' },
      })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('secret-qr')
    }
  })

  it('keeps the health check reachable from anywhere', async () => {
    expect((await app.request(`${publicHost}/health`)).status).toBe(200)
  })
})
