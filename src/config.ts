import { normalizePhone } from './phone.js'

export type Config = {
  host: string
  port: number
  databaseUrl: string
  whatsapp: {
    enabled: boolean
    tenantId?: string
    sessionDir: string
    maxTenants: number
    pairingTimeoutMs: number
  }
  /** The operator's own number (digits, country code) that sends login codes and notices; off when unset. */
  systemWhatsappPhone?: string
  analysisToken?: string
  /** Signs login codes; without it the app login is switched off. */
  authSecret?: string
  /** Web push keys; without them notifications are switched off. */
  push?: { publicKey: string; privateKey: string; subject: string; digestHourWib: number }
  publicBaseUrl: string
  /** Directory of the built public site (web/dist); nothing is served when it has no index.html. */
  webRoot: string
  secureCookies: boolean
  /** Delete a customer's data automatically after the subscription has been over for a while (see retention.ts). */
  autoDeleteExpired: boolean
  summaryHourWib: number
  telegram?: { token: string; adminIds: Set<number> }
  hermes?: {
    endpoint: string
    apiKey: string
    model: string
    pollIntervalMs: number
    /** Optional vision-capable model; image upload stays hidden when unset. */
    visionModel?: string
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const port = Number(env.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  const whatsappEnabled = env.WHATSAPP_ENABLED === 'true'
  const tenantId = env.WHATSAPP_TENANT_ID
  if (whatsappEnabled && !tenantId) {
    throw new Error('WHATSAPP_TENANT_ID is required when WhatsApp is enabled')
  }
  const hermesEnabled = env.HERMES_ENABLED === 'true'
  if (hermesEnabled && !env.HERMES_API_KEY) {
    throw new Error('HERMES_API_KEY is required when Hermes is enabled')
  }

  const telegramToken = env.TELEGRAM_BOT_TOKEN
  const telegramAdminIds = new Set(
    (env.TELEGRAM_ADMIN_IDS ?? '')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )
  if (telegramToken && telegramAdminIds.size === 0) {
    throw new Error('TELEGRAM_ADMIN_IDS is required when TELEGRAM_BOT_TOKEN is set')
  }

  const systemPhone = env.SYSTEM_WHATSAPP_PHONE ? normalizePhone(env.SYSTEM_WHATSAPP_PHONE) : null
  if (env.SYSTEM_WHATSAPP_PHONE && !systemPhone) {
    throw new Error('SYSTEM_WHATSAPP_PHONE must be a phone number, e.g. 6281234567890')
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    databaseUrl,
    whatsapp: {
      enabled: whatsappEnabled,
      ...(tenantId ? { tenantId } : {}),
      sessionDir: env.WHATSAPP_SESSION_DIR ?? '/data/whatsapp',
      maxTenants: positiveInt(env.WHATSAPP_MAX_TENANTS, 3),
      pairingTimeoutMs: positiveInt(env.WHATSAPP_PAIRING_TIMEOUT_MINUTES, 10) * 60_000,
    },
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:18880').replace(/\/$/, ''),
    webRoot: env.WEB_DIST_DIR ?? 'web/dist',
    secureCookies: env.COOKIE_SECURE === 'true',
    autoDeleteExpired: env.AUTO_DELETE_EXPIRED === 'true',
    summaryHourWib: Math.min(23, Math.max(0, Number(env.DAILY_SUMMARY_HOUR_WIB ?? '7') || 7)),
    ...(telegramToken && telegramAdminIds.size > 0
      ? { telegram: { token: telegramToken, adminIds: telegramAdminIds } }
      : {}),
    ...(systemPhone ? { systemWhatsappPhone: systemPhone } : {}),
    ...(env.AUTH_SECRET && env.AUTH_SECRET.length >= 32 ? { authSecret: env.AUTH_SECRET } : {}),
    ...(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? {
          push: {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT ?? 'https://example.com',
            digestHourWib: Math.min(11, Math.max(0, Number(env.PUSH_DIGEST_HOUR_WIB ?? '7') || 7)),
          },
        }
      : {}),
    ...(env.ANALYSIS_INTERNAL_TOKEN
      ? { analysisToken: env.ANALYSIS_INTERNAL_TOKEN }
      : {}),
    ...(hermesEnabled
      ? {
          hermes: {
            endpoint: (env.HERMES_API_ENDPOINT ?? 'http://host.containers.internal:8642').replace(/\/$/, ''),
            apiKey: env.HERMES_API_KEY!,
            model: env.HERMES_MODEL ?? 'deepseek-flash',
            pollIntervalMs: Number(env.HERMES_POLL_INTERVAL_MS ?? '1000'),
            ...(env.HERMES_VISION_MODEL ? { visionModel: env.HERMES_VISION_MODEL } : {}),
          },
        }
      : {}),
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
