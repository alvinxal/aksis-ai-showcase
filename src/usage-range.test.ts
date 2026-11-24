import { describe, expect, it } from 'vitest'
import { customRange, parseTypedRange, presetRange, rangeFromKey } from './usage-range.js'

// 15:30 WIB on 28 Oct 2026.
const now = new Date('2026-10-28T08:30:00Z')

describe('presetRange', () => {
  it('starts "today" at Jakarta midnight', () => {
    const range = presetRange(1, now)!
    expect(range.from.toISOString()).toBe('2026-10-27T17:00:00.000Z')
    expect(range.to).toEqual(now)
    expect(range.key).toBe('d1')
    expect(range.label).toContain('Hari ini')
  })

  it('covers today plus the previous days', () => {
    expect(presetRange(7, now)!.from.toISOString()).toBe('2026-10-21T17:00:00.000Z')
    expect(presetRange(30, now)!.label).toBe('30 hari terakhir')
  })

  it('rejects out-of-range day counts', () => {
    expect(presetRange(0, now)).toBeNull()
    expect(presetRange(91, now)).toBeNull()
  })
})

describe('custom ranges', () => {
  it('includes the whole last day', () => {
    const range = parseTypedRange('2026-10-01 2026-10-15', now)!
    expect(range.from.toISOString()).toBe('2026-09-30T17:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-10-15T17:00:00.000Z')
    expect(range.key).toBe('2026-10-01_2026-10-15')
    expect(range.label).toBe('1 Okt 2026 – 15 Okt 2026')
  })

  it('accepts dd/mm/yyyy with separators and a single day', () => {
    expect(parseTypedRange('01/10/2026 - 15/10/2026', now)!.key).toBe('2026-10-01_2026-10-15')
    expect(parseTypedRange('sampai 5/10/2026', now)!.key).toBe('2026-10-05_2026-10-05')
  })

  it('clips a range that ends in the future to now', () => {
    expect(parseTypedRange('2026-10-20 2026-11-30', now)!.to).toEqual(now)
  })

  it('rejects impossible, reversed, future and oversized input', () => {
    expect(parseTypedRange('2026-02-31 2026-03-02', now)).toBeNull()
    expect(parseTypedRange('2026-10-15 2026-10-01', now)).toBeNull()
    expect(parseTypedRange('2026-11-05 2026-11-06', now)).toBeNull()
    expect(parseTypedRange('2024-01-01 2026-10-01', now)).toBeNull()
    expect(parseTypedRange('kemarin', now)).toBeNull()
    expect(customRange({ year: 2026, month: 10, day: 1 }, { year: 2026, month: 9, day: 1 }, now)).toBeNull()
  })

  it('round-trips through the callback key', () => {
    const range = parseTypedRange('2026-10-01 2026-10-15', now)!
    expect(rangeFromKey(range.key, now)!.from).toEqual(range.from)
    expect(rangeFromKey('d7', now)!.key).toBe('d7')
    expect(rangeFromKey('junk', now)).toBeNull()
  })
})
