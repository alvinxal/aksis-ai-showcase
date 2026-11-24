import type { Context, Hono } from 'hono'
import { normalizePhone } from './phone.js'

export type LeadsDependencies = {
  /** Stores the request and tells the admins; the answer to the visitor does not depend on whether it was new. */
  submit: (name: string, phone: string) => Promise<void>
  now?: () => number
}

const PER_IP_PER_HOUR = 5
const PER_NUMBER_PER_DAY = 3
const ALL_PER_HOUR = 60
const HOUR_MS = 3_600_000
const MAX_TRACKED = 5_000

const cleanName = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '')

/** The public "Dapatkan akses" form: name and WhatsApp number, same answer for a new or a repeated number. */
export function registerLeads(app: Hono, deps: LeadsDependencies): void {
  const now = () => deps.now?.() ?? Date.now()
  const hits = new Map<string, number[]>()
  const count = (key: string, windowMs: number): number => {
    const recent = (hits.get(key) ?? []).filter((at) => now() - at < windowMs)
    if (recent.length) hits.set(key, recent)
    else hits.delete(key)
    return recent.length
  }
  const note = (key: string) => {
    if (hits.size > MAX_TRACKED) hits.clear()
    hits.set(key, [...(hits.get(key) ?? []), now()])
  }

  app.post('/v1/leads', async (context: Context) => {
    context.header('Cache-Control', 'no-store')
    const origin = context.req.header('origin')
    if (origin) {
      try {
        if (new URL(origin).host !== context.req.header('host')) return context.json({ error: 'forbidden' }, 403)
      } catch {
        return context.json({ error: 'forbidden' }, 403)
      }
    }
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return context.json({ error: 'unsupported_media_type' }, 415)
    }
    const ip = context.req.header('cf-connecting-ip') ?? context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
    if (count(`ip:${ip}`, HOUR_MS) >= PER_IP_PER_HOUR || count('all', HOUR_MS) >= ALL_PER_HOUR) {
      return context.json({ error: 'too_many' }, 429)
    }
    const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_json' }, 400)
    note(`ip:${ip}`)

    // A hidden field that people leave empty and bots fill in: pretend it worked and store nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') return context.json({ ok: true })

    const name = cleanName(body.name)
    if (name.length < 2) return context.json({ error: 'invalid_name' }, 400)
    const phone = normalizePhone(body.phone)
    if (!phone) return context.json({ error: 'invalid_phone' }, 400)
    if (body.terms !== true) return context.json({ error: 'terms_required' }, 400)

    if (count(`phone:${phone}`, 24 * HOUR_MS) < PER_NUMBER_PER_DAY) {
      note(`phone:${phone}`)
      note('all')
      await deps.submit(name, phone).catch((error: unknown) => {
        console.error('Lead could not be stored', error instanceof Error ? error.message : error)
      })
    }
    return context.json({ ok: true })
  })
}
