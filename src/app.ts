import { Hono } from 'hono'
import QRCode from 'qrcode'
import { registerAuth, type AuthDependencies } from './auth-routes.js'
import { registerChat } from './chat-routes.js'
import { registerContacts, type ContactsDependencies } from './contacts-routes.js'
import { registerDashboard, type DashboardDependencies } from './dashboard-routes.js'
import { registerGroups, type GroupsDependencies } from './groups-routes.js'
import { registerLeads, type LeadsDependencies } from './leads-routes.js'
import type { ChatService } from './chat.js'
import { registerPush } from './push-routes.js'
import type { PushService } from './push.js'
import { registerProjects, type ProjectsDependencies } from './projects-routes.js'
import { registerWorkspace, type WorkspaceDependencies } from './workspace-routes.js'
import { registerOnboarding, type OnboardingDependencies } from './onboarding.js'
import { registerWeb } from './web.js'
import {
  type AnalysisBatch,
  type AnalysisCompletion,
  parseAnalysisCompletion,
} from './analysis.js'

export type WhatsAppStatus = {
  enabled: boolean
  connection: 'disabled' | 'connecting' | 'qr_ready' | 'connected' | 'logged_out' | 'error'
  qr: string | null
  /** Eight-character code for linking with a phone number, set while it is valid. */
  pairingCode?: string | null
  lastError: string | null
}

export type AppDependencies = {
  checkDatabase: () => Promise<void>
  getWhatsAppStatus?: () => WhatsAppStatus
  onboarding?: OnboardingDependencies
  auth?: AuthDependencies
  /** Needs `auth`: the routes answer 401 without a logged-in customer. */
  projects?: ProjectsDependencies
  /** Needs `auth`; only offered when the AI gateway is configured. */
  chat?: ChatService
  /** Needs `auth`: which personal chats are read. */
  contacts?: ContactsDependencies
  groups?: GroupsDependencies
  /** The admin dashboard (read-only), behind a login link made in the Telegram bot. */
  dashboard?: DashboardDependencies
  /** The public request-access form on the landing page. */
  leads?: LeadsDependencies
  /** Needs `auth`; only offered when the push keys are configured. */
  push?: PushService
  /** Needs `auth`: customer connection, billing and productivity tools. */
  workspace?: WorkspaceDependencies
  webRoot?: string
  analysis?: {
    token: string
    claim: () => Promise<AnalysisBatch | null>
    complete: (runId: string, completion: AnalysisCompletion) => Promise<void>
    fail: (runId: string, error: string) => Promise<void>
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Operator routes (WhatsApp setup page and status, internal worker API) are for the
 * server itself and for SSH tunnels. A request that arrived through a public tunnel
 * carries the public hostname or proxy headers, so it is treated as remote.
 */
function isLocalRequest(url: string, headers: (name: string) => string | undefined): boolean {
  if (headers('cf-connecting-ip') || headers('x-forwarded-for') || headers('x-forwarded-host')) return false
  return LOCAL_HOSTNAMES.has(new URL(url).hostname.toLowerCase())
}

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono()

  app.use('*', async (context, next) => {
    const path = context.req.path
    const operatorRoute = path.startsWith('/setup') || path.startsWith('/api') || path.startsWith('/internal')
    if (operatorRoute && !isLocalRequest(context.req.url, (name) => context.req.header(name))) {
      return context.notFound()
    }
    await next()
  })

  app.get('/health', async (context) => {
    try {
      await dependencies.checkDatabase()
      return context.json({ status: 'ok', database: 'ok' })
    } catch {
      return context.json({ status: 'degraded', database: 'unavailable' }, 503)
    }
  })

  const shell = dependencies.webRoot ? registerWeb(app, dependencies.webRoot) : null
  if (dependencies.onboarding) registerOnboarding(app, dependencies.onboarding, shell ?? undefined)
  if (dependencies.leads) registerLeads(app, dependencies.leads)
  if (dependencies.dashboard) registerDashboard(app, dependencies.dashboard)
  if (dependencies.auth) {
    const sessionOf = registerAuth(app, dependencies.auth)
    if (dependencies.projects) registerProjects(app, sessionOf, dependencies.projects)
    if (dependencies.chat) registerChat(app, sessionOf, dependencies.chat)
    if (dependencies.contacts) registerContacts(app, sessionOf, dependencies.contacts)
    if (dependencies.groups) registerGroups(app, sessionOf, dependencies.groups)
    if (dependencies.push) registerPush(app, sessionOf, dependencies.push)
    if (dependencies.workspace) registerWorkspace(app, sessionOf, dependencies.workspace)
  }

  app.get('/api/whatsapp/status', (context) => {
    return context.json(
      dependencies.getWhatsAppStatus?.() ?? {
        enabled: false,
        connection: 'disabled',
        qr: null,
        lastError: null,
      },
    )
  })

  app.get('/setup/whatsapp', async (context) => {
    const status = dependencies.getWhatsAppStatus?.() ?? {
      enabled: false,
      connection: 'disabled' as const,
      qr: null,
      lastError: null,
    }
    const qrImage = status.qr ? await QRCode.toDataURL(status.qr, { width: 320, margin: 2 }) : null
    const detail = status.enabled
      ? status.connection === 'qr_ready'
        ? 'Scan this QR from the test WhatsApp Business account.'
        : `Connection status: ${status.connection}`
      : 'WhatsApp is disabled until a test tenant is configured.'

    return context.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="5">
    <title>Aksis AI — WhatsApp Setup</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; color: #172018; }
      main { border: 1px solid #d7ded8; border-radius: 1rem; padding: 2rem; }
      img { display: block; max-width: 100%; margin: 1.5rem auto; }
      code { background: #eef2ee; padding: .15rem .35rem; border-radius: .3rem; }
    </style>
  </head>
  <body><main>
    <h1>WhatsApp test pairing</h1>
    <p>${detail}</p>
    ${qrImage ? `<img src="${qrImage}" alt="WhatsApp pairing QR code">` : ''}
    ${status.lastError ? `<p>Last error: <code>${status.lastError}</code></p>` : ''}
    <p>This local-only page refreshes every five seconds.</p>
  </main></body>
</html>`)
  })

  app.post('/internal/analysis/claim', async (context) => {
    if (!isAuthorized(context.req.header('authorization'), dependencies.analysis?.token)) {
      return context.json({ error: 'unauthorized' }, 401)
    }
    const batch = await dependencies.analysis!.claim()
    return batch ? context.json(batch) : context.body(null, 204)
  })

  app.post('/internal/analysis/:runId/complete', async (context) => {
    if (!isAuthorized(context.req.header('authorization'), dependencies.analysis?.token)) {
      return context.json({ error: 'unauthorized' }, 401)
    }
    try {
      const completion = parseAnalysisCompletion(await context.req.json())
      await dependencies.analysis!.complete(context.req.param('runId'), completion)
      return context.json({ status: 'completed' })
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'invalid completion' }, 400)
    }
  })

  app.post('/internal/analysis/:runId/fail', async (context) => {
    if (!isAuthorized(context.req.header('authorization'), dependencies.analysis?.token)) {
      return context.json({ error: 'unauthorized' }, 401)
    }
    const body = (await context.req.json()) as { error?: unknown }
    await dependencies.analysis!.fail(
      context.req.param('runId'),
      typeof body.error === 'string' ? body.error : 'unknown worker error',
    )
    return context.json({ status: 'failed' })
  })

  return app
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`)
}
