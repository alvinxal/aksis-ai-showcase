import { createLead } from './leads.js'
import { TERMS_VERSION } from './onboarding.js'
import { RetentionSweep } from './retention.js'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { checkDatabase, createDatabase } from './db.js'
import { WhatsAppManager } from './whatsapp-manager.js'
import { listStoredGroups, saveSelectedGroups } from './groups.js'
import { claimAnalysisBatch, completeAnalysisRun, failAnalysisRun } from './analysis.js'
import { AgentWorker } from './agent-worker.js'
import {
  getOnboardingSession,
  joinWithInvitation,
  markOnboarded,
  recordAudit,
  saveTenantProfile,
  systemCounts,
} from './admin.js'
import { createChatService, type Llm } from './chat.js'
import { FeatureHealth } from './health.js'
import { listContacts, setContact } from './contacts.js'
import { createPushService, PushWorker, webPushSender } from './push.js'
import { SummaryWorker, refreshOnOpen } from './summary.js'
import { getProject, listProjects } from './projects.js'
import { createAuthService } from './auth.js'
import { groupLimitFor, hasSubscription } from './billing.js'
import { Monitor } from './monitor.js'
import { SystemWhatsApp, phoneOfTenant } from './system-whatsapp.js'
import { TelegramAdminBot, type AskHermes } from './telegram.js'
import { accessInfoText, activateAfterOnboarding, markPlanRequested } from './activation.js'
import {
  billingOverviewForCustomer,
  connectionOverview,
  getReminderPreferences,
  listAgenda,
  requestPayment,
  searchWorkspace,
  setAgendaAction,
  setReminderPreferences,
  weeklyReport,
} from './workspace.js'

const config = loadConfig()
const database = createDatabase(config.databaseUrl)
const whatsapp = new WhatsAppManager(database, {
  baseDir: config.whatsapp.sessionDir,
  ...(config.whatsapp.tenantId ? { legacyTenantId: config.whatsapp.tenantId } : {}),
  maxActive: config.whatsapp.maxTenants,
  pairingTimeoutMs: config.whatsapp.pairingTimeoutMs,
})
const primaryWhatsAppStatus = () =>
  (config.whatsapp.tenantId ? whatsapp.status(config.whatsapp.tenantId) : null) ?? {
    enabled: config.whatsapp.enabled,
    connection: config.whatsapp.enabled ? ('connecting' as const) : ('disabled' as const),
    qr: null,
    lastError: null,
  }
const systemWhatsApp = config.systemWhatsappPhone
  ? new SystemWhatsApp(config.systemWhatsappPhone, config.whatsapp.sessionDir)
  : null
/** Sends from the operator's system number to the customer's linked number; throws when it cannot. */
async function sendFromSystem(tenantId: string, text: string): Promise<void> {
  if (!systemWhatsApp) throw new Error('System WhatsApp is not configured')
  const phone = await phoneOfTenant(database, tenantId)
  if (!phone) throw new Error('Customer has no linked WhatsApp number')
  await systemWhatsApp.sendText(phone, text)
}
/** Login codes and access info: from the system number when there is one, else the customer's self-chat. */
const sendNotice = (tenantId: string, text: string) =>
  systemWhatsApp ? sendFromSystem(tenantId, text) : whatsapp.sendSelfMessage(tenantId, text)
/** The stored session may still be reopening, so a send gets a few tries before it counts as failed. */
async function sendAccessInfo(tenantId: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await sendNotice(tenantId, text)
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  return false
}
/** One call to Hermes for the answers and notes written in the app; the extraction worker has its own. */
const hermesLlm: Llm | undefined = config.hermes
  ? async ({ sessionKey, prompt, image }) => {
    const hermes = config.hermes!
    const response = await fetch(`${hermes.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${hermes.apiKey}`,
        'content-type': 'application/json',
        'x-hermes-session-key': sessionKey,
      },
      body: JSON.stringify({
        model: image ? hermes.visionModel : hermes.model,
        messages: [{
          role: 'user',
          content: image
            ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image.dataUrl } }]
            : prompt,
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error(`Hermes API returned ${response.status}`)
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    if (body.choices?.[0]?.finish_reason === 'error') throw new Error('Hermes agent run failed')
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
      ...(body.usage?.completion_tokens !== undefined ? { outputTokens: body.usage.completion_tokens } : {}),
    }
  }
  : undefined

const featureHealth = new FeatureHealth()
let telegramBot: TelegramAdminBot | null = null
const app = createApp({
  checkDatabase: () => checkDatabase(database),
  getWhatsAppStatus: primaryWhatsAppStatus,
  webRoot: config.webRoot,
  ...(config.authSecret
    ? {
        auth: {
          service: createAuthService(database, config.authSecret, sendNotice),
          secureCookies: config.secureCookies,
        },
        projects: {
          list: (tenantId: string) => listProjects(database, tenantId),
          get: (tenantId: string, projectId: string) => getProject(database, tenantId, projectId),
          ...(hermesLlm ? { refresh: (tenantId: string) => refreshOnOpen(database, hermesLlm, tenantId, featureHealth) } : {}),
        },
        ...(hermesLlm ? { chat: createChatService(database, hermesLlm, featureHealth, Boolean(config.hermes?.visionModel)) } : {}),
        ...(config.push ? { push: createPushService(database, config.push.publicKey) } : {}),
        groups: {
          list: async (tenantId: string) => ({
            limit: await groupLimitFor(database, tenantId),
            groups: await listStoredGroups(database, tenantId, await whatsapp.listGroups(tenantId)),
          }),
          save: async (tenantId: string, jids: string[]) => {
            const result = await saveSelectedGroups(database, tenantId, await whatsapp.listGroups(tenantId), jids)
            if (result.ok) await recordAudit(database, null, 'groups_changed_by_customer', tenantId, { count: result.count })
            return result
          },
        },
        contacts: {
          list: (tenantId: string, search?: string) => listContacts(database, tenantId, search),
          set: (tenantId: string, contactId: string, change: { selected: boolean; projectId?: string | null }) => setContact(database, tenantId, contactId, change),
        },
        workspace: {
          connection: (tenantId) => {
            const status = whatsapp.status(tenantId)
            return connectionOverview(database, tenantId, status ? {
              connection: status.connection,
              lastError: status.lastError ? 'Koneksi WhatsApp terputus. Coba sambungkan ulang.' : null,
            } : null)
          },
          reconnect: async (tenantId) => ['started', 'exists'].includes(await whatsapp.ensure(tenantId)),
          disconnect: (tenantId) => whatsapp.disconnect(tenantId),
          billing: (tenantId) => billingOverviewForCustomer(database, tenantId),
          requestPayment: async (tenantId, planCode, months) => {
            const created = await requestPayment(database, tenantId, planCode, months)
            if (!created) return false
            const [tenant] = await database<Array<{ name: string }>>`select name from tenants where id = ${tenantId}`
            await recordAudit(database, null, 'payment_requested_by_customer', tenantId, { planCode, months })
            void telegramBot?.notify(`💳 Permintaan pembayaran baru\n${tenant?.name ?? 'Pelanggan'}\nPaket ${planCode.toUpperCase()} · ${months} bulan`)
            return true
          },
          agenda: (tenantId) => listAgenda(database, tenantId),
          setAction: (tenantId, eventId, status, snoozedUntil) => setAgendaAction(database, tenantId, eventId, status, snoozedUntil),
          search: (tenantId, query) => searchWorkspace(database, tenantId, query),
          report: (tenantId) => weeklyReport(database, tenantId),
          preferences: (tenantId) => getReminderPreferences(database, tenantId),
          setPreferences: (tenantId, days, enabled) => setReminderPreferences(database, tenantId, days, enabled),
        },
      }
    : {}),
  dashboard: {
    database,
    isAdmin: (telegramId) => telegramBot?.isAdminId(telegramId) ?? false,
    owners: config.telegram?.adminIds ?? new Set<number>(),
    reloadAdmins: async () => telegramBot?.reloadAdmins(),
    secureCookies: config.secureCookies,
    publicBaseUrl: config.publicBaseUrl,
    hooks: {
      resumeWhatsApp: (tenantId) => whatsapp.resume(tenantId),
      removeSession: (tenantId) => whatsapp.removeSession(tenantId),
      reevaluateLimits: () => monitor.reevaluateLimits(),
      sendAccessInfo,
    },
    autoDeleteExpired: config.autoDeleteExpired,
    live: {
      connectionOf: (tenantId) => whatsapp.status(tenantId)?.connection,
      whatsapp: () => whatsapp.snapshot(),
      hermesHealthy: async () => (agentWorker ? agentWorker.isHealthy() : null),
      systemConnection: () => {
        const status = systemWhatsApp?.getStatus()
        return status ? { connection: status.connection, paired: status.paired } : null
      },
      features: featureHealth,
    },
  },
  leads: {
    submit: async (name, phone) => {
      const lead = await createLead(database, name, phone, TERMS_VERSION)
      // A repeated number has an open request already: the admins were told once.
      if (lead) await telegramBot?.notifyNewLead(lead)
    },
  },
  onboarding: {
    join: (token) => joinWithInvitation(database, token),
    getSession: (sessionToken) => getOnboardingSession(database, sessionToken),
    saveProfile: (tenantId, studio, contact) => saveTenantProfile(database, tenantId, studio, contact, TERMS_VERSION),
    complete: async (tenantId) => {
      await markOnboarded(database, tenantId)
      if (await activateAfterOnboarding(database, tenantId)) void sendAccessInfo(tenantId, accessInfoText(config.publicBaseUrl))
    },
    groupLimit: (tenantId) => groupLimitFor(database, tenantId),
    hasPlan: (tenantId) => hasSubscription(database, tenantId),
    requestPlan: async (tenantId, tenantName) => {
      if (await markPlanRequested(database, tenantId)) await telegramBot?.notifyPlanRequest({ id: tenantId, name: tenantName })
    },
    whatsapp: {
      status: (tenantId) => whatsapp.status(tenantId),
      start: (tenantId) => whatsapp.ensure(tenantId),
      requestCode: (tenantId, phone) => whatsapp.requestPairingCode(tenantId, phone),
      listGroups: async (tenantId) =>
        listStoredGroups(database, tenantId, await whatsapp.listGroups(tenantId)),
      saveGroups: async (tenantId, jids) =>
        saveSelectedGroups(database, tenantId, await whatsapp.listGroups(tenantId), jids),
    },
    notify: (text, readyTenantId) =>
      void telegramBot?.notify(
        text,
        readyTenantId ? [[{ text: '⛔ Set disabled', callback_data: `dis:${readyTenantId}` }]] : undefined,
      ),
    secureCookies: config.secureCookies,
  },
  ...(config.analysisToken
    ? {
        analysis: {
          token: config.analysisToken,
          claim: () => claimAnalysisBatch(database, 'deepseek-flash'),
          complete: (runId: string, completion: Parameters<typeof completeAnalysisRun>[2]) =>
            completeAnalysisRun(database, runId, completion),
          fail: (runId: string, error: string) => failAnalysisRun(database, runId, error),
        },
      }
    : {}),
})

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
})

console.log(`Aksis AI API listening on ${config.host}:${config.port}`)
if (config.whatsapp.enabled) await whatsapp.start()
await systemWhatsApp?.start().catch((error: unknown) => {
  console.error('System WhatsApp did not start', error instanceof Error ? error.message : error)
})
const agentWorker = config.hermes
  ? new AgentWorker(database, config.hermes, async (tenantId, text, channel) => {
      // Broadcasts and billing notices come from the system number; AI answers stay in the self-chat.
      if (channel === 'broadcast' && systemWhatsApp) {
        try {
          await sendFromSystem(tenantId, text)
          return
        } catch (error) {
          console.warn('System WhatsApp could not deliver a notice, using the self-chat', error instanceof Error ? error.message : error)
        }
      }
      await whatsapp.sendSelfMessage(tenantId, text)
    })
  : null
agentWorker?.start()
const summaryWorker = hermesLlm ? new SummaryWorker(database, hermesLlm, featureHealth) : null
summaryWorker?.start()
const pushWorker = config.push ? new PushWorker(database, webPushSender(config.push), config.push.digestHourWib, featureHealth) : null
pushWorker?.start()

const ADMIN_SYSTEM_PROMPT =
  'You are the admin assistant for the operator of Aksis AI, a WhatsApp project copilot for Indonesian professionals who run client projects. ' +
  'Answer directly and briefly, in Indonesian unless asked otherwise. No greetings or filler. ' +
  'Use web search when a question needs current or external information and name the source briefly. ' +
  'You have no access to customer data or internal systems; for those, tell the operator to use /status, /usage or /tenants.'

const askHermes: AskHermes | undefined = config.hermes
  ? async (adminId, question) => {
      const hermes = config.hermes!
      const response = await fetch(`${hermes.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${hermes.apiKey}`,
          'content-type': 'application/json',
          'x-hermes-session-key': `admin:${adminId}`,
        },
        body: JSON.stringify({
          model: hermes.model,
          messages: [
            { role: 'system', content: ADMIN_SYSTEM_PROMPT },
            { role: 'user', content: question },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!response.ok) throw new Error(`Hermes API returned ${response.status}`)
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      return {
        text: body.choices?.[0]?.message?.content?.trim() ?? '',
        ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
        ...(body.usage?.completion_tokens !== undefined ? { outputTokens: body.usage.completion_tokens } : {}),
      }
    }
  : undefined

if (config.telegram) {
  telegramBot = new TelegramAdminBot(
    database,
    { ...config.telegram, publicBaseUrl: config.publicBaseUrl },
    async () => {
      const counts = await systemCounts(database)
      const hermesOk = config.hermes ? await agentWorker?.isHealthy() : null
      return [
        `Database: ok`,
        `WhatsApp: ${whatsapp.activeCount()} tersambung dari ${whatsapp.totalCount()} sesi (maks ${config.whatsapp.maxTenants})`,
        `Hermes: ${hermesOk === null ? 'disabled' : hermesOk ? 'ok' : 'tidak merespons'}`,
        `Run gagal 24 jam: ${counts.failedRuns24h}`,
        `Balasan tertunda: ${counts.pendingOutbound}`,
      ]
    },
    askHermes,
    {
      connectionOf: (tenantId) => whatsapp.status(tenantId)?.connection ?? 'tidak aktif',
      removeSession: (tenantId) => whatsapp.removeSession(tenantId),
      disconnectWhatsApp: (tenantId) => whatsapp.disconnect(tenantId),
      resumeWhatsApp: (tenantId) => whatsapp.resume(tenantId),
      reconnectWhatsApp: (tenantId) => whatsapp.ensure(tenantId),
      sendAccessInfo,
      ...(systemWhatsApp
        ? {
            system: {
              status: () => systemWhatsApp.getStatus(),
              pair: async () => {
                if (systemWhatsApp.getStatus().connection === 'logged_out') await systemWhatsApp.reset()
                return systemWhatsApp.requestPairingCode()
              },
            },
          }
        : {}),
      reevaluateLimits: () => monitor.reevaluateLimits(),
      groups: {
        limit: (tenantId) => groupLimitFor(database, tenantId),
        list: async (tenantId) => listStoredGroups(database, tenantId, await whatsapp.listGroups(tenantId)),
        save: async (tenantId, jids) =>
          saveSelectedGroups(database, tenantId, await whatsapp.listGroups(tenantId), jids),
      },
    },
  )
  telegramBot.start()
}

const monitor = new Monitor({
  database,
  notify: async (text, keyboard) => {
    await telegramBot?.notify(text, keyboard)
  },
  connections: () => whatsapp.snapshot(),
  systemConnection: () => systemWhatsApp?.getStatus() ?? null,
  hermesHealthy: async () => (agentWorker ? agentWorker.isHealthy() : true),
  featureHealth,
  summaryHourWib: config.summaryHourWib,
})
monitor.start()
const retention = new RetentionSweep({
  database,
  removeSession: (tenantId) => whatsapp.removeSession(tenantId),
  notify: async (text) => {
    await telegramBot?.notify(text)
  },
  autoDelete: config.autoDeleteExpired,
})
retention.start()

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`)
  whatsapp.stop()
  systemWhatsApp?.stop()
  await agentWorker?.stop()
  summaryWorker?.stop()
  pushWorker?.stop()
  monitor.stop()
  retention.stop()
  await telegramBot?.stop()
  server.close()
  await database.end({ timeout: 5 })
  process.exit(0)
}

// A background task that fails must not take the whole service (and every customer's WhatsApp) down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason instanceof Error ? reason.message : reason)
})
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
