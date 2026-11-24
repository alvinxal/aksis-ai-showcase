import { describe, expect, it } from 'vitest'
import { AlertTracker, decideLimits, formatSummary, type Condition } from './monitor.js'
import type { LimitStatus } from './ops.js'

const condition = (overrides: Partial<Condition> = {}): Condition => ({
  key: 'wa:1',
  message: 'WA mati',
  recovered: 'WA hidup',
  holdMs: 5 * 60_000,
  ...overrides,
})
const MIN = 60_000

describe('AlertTracker', () => {
  it('waits for the hold time before raising, then raises once', () => {
    const tracker = new AlertTracker()
    expect(tracker.update([condition()], 0).raise).toEqual([])
    expect(tracker.update([condition()], 4 * MIN).raise).toEqual([])
    expect(tracker.update([condition()], 5 * MIN).raise.map((a) => a.text)).toEqual(['WA mati'])
    expect(tracker.update([condition()], 6 * MIN).raise).toEqual([])
  })

  it('stays silent when a condition clears before the hold time', () => {
    const tracker = new AlertTracker()
    tracker.update([condition()], 0)
    const result = tracker.update([], 2 * MIN)
    expect(result.raise).toEqual([])
    expect(result.recover).toEqual([])
  })

  it('reports recovery only for alerts that were raised', () => {
    const tracker = new AlertTracker()
    tracker.update([condition({ holdMs: 0 })], 0)
    expect(tracker.update([], MIN).recover.map((a) => a.text)).toEqual(['WA hidup'])
    expect(tracker.update([], 2 * MIN).recover).toEqual([])
  })

  it('reminds every six hours while the condition continues', () => {
    const tracker = new AlertTracker()
    tracker.update([condition({ holdMs: 0 })], 0)
    expect(tracker.update([condition({ holdMs: 0 })], 5 * 3_600_000).raise).toEqual([])
    const reminder = tracker.update([condition({ holdMs: 0 })], 6 * 3_600_000).raise
    expect(reminder[0]?.text).toContain('masih berlangsung')
  })

  it('tracks different keys independently and keeps the keyboard', () => {
    const tracker = new AlertTracker()
    const keyboard = [[{ text: 'Buka', callback_data: 't:1' }]]
    const result = tracker.update(
      [condition({ holdMs: 0, keyboard }), condition({ key: 'hermes', message: 'Hermes mati', holdMs: 0 })],
      0,
    )
    expect(result.raise).toHaveLength(2)
    expect(result.raise[0]?.keyboard).toEqual(keyboard)
  })
})

const status = (overrides: Partial<LimitStatus> = {}): LimitStatus => ({
  tenantId: 't1',
  name: 'Studio',
  dailyLimit: 1,
  monthlyLimit: 20,
  paused: false,
  todayCost: 0,
  monthCost: 0,
  ...overrides,
})
const period = { day: '2026-10-28', month: '2026-10' }

describe('decideLimits', () => {
  it('does nothing below 80%', () => {
    expect(decideLimits([status({ todayCost: 0.5 })], new Set(), period)).toEqual({ events: [], pause: [], resume: [] })
  })

  it('warns once at 80% per period', () => {
    const warned = new Set<string>()
    const first = decideLimits([status({ todayCost: 0.85 })], warned, period)
    expect(first.events).toMatchObject([{ kind: 'warn', scope: 'daily' }])
    expect(decideLimits([status({ todayCost: 0.9 })], warned, period).events).toEqual([])
    expect(decideLimits([status({ todayCost: 0.9 })], warned, { day: '2026-10-29', month: '2026-10' }).events).toHaveLength(1)
  })

  it('pauses when a limit is reached and reports which one', () => {
    const result = decideLimits([status({ monthCost: 21 })], new Set(), period)
    expect(result.pause).toEqual(['t1'])
    expect(result.events[0]).toMatchObject({ kind: 'paused', scope: 'monthly', limit: 20 })
  })

  it('does not pause twice, and resumes once usage is back under the limits', () => {
    expect(decideLimits([status({ todayCost: 2, paused: true })], new Set(), period).pause).toEqual([])
    const resumed = decideLimits([status({ todayCost: 0.1, paused: true })], new Set(), period)
    expect(resumed.resume).toEqual(['t1'])
    expect(resumed.events[0]).toMatchObject({ kind: 'resumed' })
  })

  it('treats a missing limit as unlimited, and resumes a paused tenant whose limits were removed', () => {
    expect(decideLimits([status({ dailyLimit: null, monthlyLimit: null, todayCost: 99 })], new Set(), period).pause).toEqual([])
    expect(decideLimits([status({ dailyLimit: null, monthlyLimit: null, paused: true })], new Set(), period).resume).toEqual(['t1'])
  })
})

describe('formatSummary', () => {
  it('summarises the day in one message', () => {
    const text = formatSummary(
      {
        cost: 0.0123,
        runs: 8,
        failedRuns: 1,
        events: 3,
        selfMessages: 5,
        groupMessages: 40,
        statusCounts: { active: 2, disabled: 1 },
        perTenant: [{ name: 'Studio A', cost: 0.01 }],
      },
      new Date('2026-10-27T17:00:00Z'),
    )
    expect(text).toContain('Rab, 28 Okt 2026')
    expect(text).toContain('~$0.0123 (8 run, 1 gagal)')
    expect(text).toContain('5 self-chat, 40 grup')
    expect(text).toContain('2 active, 1 disabled')
    expect(text).toContain('Studio A ~$0.0100')
  })
})
