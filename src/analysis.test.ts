import { describe, expect, it } from 'vitest'
import { chooseBatch, dedupKey, kindOf, parseAnalysisCompletion } from './analysis.js'

const event = (overrides: Record<string, unknown> = {}) => ({
  eventType: 'PAYMENT_DUE',
  title: 'Termin kedua Rumah Cempaka',
  details: { amount: 30000000, party: 'Pak Budi', note: 'Jatuh tempo Jumat.' },
  confidence: 0.9,
  occurredAt: '2026-10-28T08:00:00Z',
  dueAt: '2026-10-30T00:00:00Z',
  sourceMessageIds: ['m1'],
  ...overrides,
})

describe('parseAnalysisCompletion', () => {
  it('keeps a projectId that is a string, drops anything else', () => {
    const [named, empty, odd] = parseAnalysisCompletion({
      reply: null,
      events: [event({ projectId: 'p-budi' }), event({ projectId: null }), event({ projectId: 42 })],
    }).events
    expect(named?.projectId).toBe('p-budi')
    expect(empty).not.toHaveProperty('projectId')
    expect(odd).not.toHaveProperty('projectId')
  })

  it('accepts the finance event types and a due date', () => {
    const [parsed] = parseAnalysisCompletion({ reply: null, events: [event()] }).events
    expect(parsed?.eventType).toBe('PAYMENT_DUE')
    expect(parsed?.dueAt).toBe('2026-10-30T00:00:00Z')
    for (const eventType of ['PAYMENT_RECEIVED', 'INVOICE_SENT', 'BUDGET_CHANGE']) {
      expect(() => parseAnalysisCompletion({ reply: null, events: [event({ eventType })] })).not.toThrow()
    }
  })

  it('treats a missing or null dueAt as no date', () => {
    const { dueAt: _omitted, ...withoutDueAt } = event()
    expect(parseAnalysisCompletion({ reply: null, events: [withoutDueAt] }).events[0]?.dueAt).toBeNull()
    expect(parseAnalysisCompletion({ reply: null, events: [event({ dueAt: null })] }).events[0]?.dueAt).toBeNull()
  })

  it('rejects an unreadable dueAt and unknown event types', () => {
    expect(() => parseAnalysisCompletion({ reply: null, events: [event({ dueAt: 'Jumat' })] })).toThrow('dueAt')
    expect(() => parseAnalysisCompletion({ reply: null, events: [event({ dueAt: 20261030 })] })).toThrow('dueAt')
    expect(() => parseAnalysisCompletion({ reply: null, events: [event({ eventType: 'MADE_UP' })] })).toThrow('eventType')
  })
})

describe('dedupKey', () => {
  const base = { eventType: 'PAYMENT_DUE', title: 'Termin kedua Rumah Cempaka', dueAt: '2026-10-30T00:00:00Z' }

  it('ignores case, punctuation and the time of day', () => {
    const key = dedupKey(base)
    expect(dedupKey({ ...base, title: '  termin KEDUA, rumah cempaka! ' })).toBe(key)
    expect(dedupKey({ ...base, dueAt: '2026-10-30T17:30:00Z' })).toBe(key)
  })

  it('separates other days, other types and other wording', () => {
    const key = dedupKey(base)
    expect(dedupKey({ ...base, dueAt: '2026-10-31T00:00:00Z' })).not.toBe(key)
    expect(dedupKey({ ...base, eventType: 'INVOICE_SENT' })).not.toBe(key)
    expect(dedupKey({ ...base, title: 'Termin ketiga Rumah Cempaka' })).not.toBe(key)
    expect(dedupKey({ ...base, dueAt: null })).not.toBe(key)
  })
})

describe('which messages form one batch', () => {
  const row = (tenant: string, project: string, chat: string, self = false) => ({ tenant_id: tenant, project_id: project, chat_jid: chat, is_self_chat: self })

  it('knows the three kinds of chat', () => {
    expect(kindOf({ is_self_chat: true, chat_jid: '62811@s.whatsapp.net' })).toBe('self_chat')
    expect(kindOf({ is_self_chat: false, chat_jid: '123@g.us' })).toBe('group')
    expect(kindOf({ is_self_chat: false, chat_jid: '62811@s.whatsapp.net' })).toBe('contact')
    expect(kindOf({ is_self_chat: false, chat_jid: '9876@lid' })).toBe('contact')
  })

  it('never mixes two contacts, two projects, two tenants or two kinds', () => {
    const a1 = row('t', 'p', '62811@s.whatsapp.net')
    const a2 = row('t', 'p', '62811@s.whatsapp.net')
    const b = row('t', 'p', '62822@s.whatsapp.net')
    const otherProject = row('t', 'q', '62811@s.whatsapp.net')
    const otherTenant = row('u', 'p', '62811@s.whatsapp.net')
    const group = row('t', 'p', '123@g.us')
    expect(chooseBatch([a1, b, a2, otherProject, otherTenant, group])).toEqual({ kind: 'contact', messages: [a1, a2] })
  })

  it('still puts messages of different groups of one project together, as before', () => {
    const g1 = row('t', 'p', '1@g.us')
    const g2 = row('t', 'p', '2@g.us')
    expect(chooseBatch([g1, g2])).toEqual({ kind: 'group', messages: [g1, g2] })
  })

  it('has nothing to choose from an empty queue', () => {
    expect(chooseBatch([])).toBeNull()
  })
})
