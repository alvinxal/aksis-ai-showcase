import { describe, expect, it } from 'vitest'
import { addMonths, daysLeft, isEntitled, subscriptionStatus } from './billing.js'

const DAY = 86_400_000
const ends = new Date('2026-11-10T00:00:00Z')

describe('subscriptionStatus', () => {
  it('has no access before any subscription exists', () => {
    expect(subscriptionStatus(null, ends)).toBe('pending')
    expect(isEntitled('pending')).toBe(false)
  })

  it('moves trial/active -> grace -> expired at the exact boundaries', () => {
    const paid = { planCode: 'pro', endsAt: ends }
    expect(subscriptionStatus(paid, new Date(ends.getTime() - 1))).toBe('active')
    expect(subscriptionStatus(paid, ends)).toBe('grace')
    expect(subscriptionStatus(paid, new Date(ends.getTime() + 3 * DAY - 1))).toBe('grace')
    expect(subscriptionStatus(paid, new Date(ends.getTime() + 3 * DAY))).toBe('expired')
    expect(subscriptionStatus({ planCode: 'trial', endsAt: ends }, new Date(ends.getTime() - 1))).toBe('trial')
  })

  it('keeps the AI on through grace and off once expired', () => {
    expect(['trial', 'active', 'grace'].every((s) => isEntitled(s as never))).toBe(true)
    expect(isEntitled('expired')).toBe(false)
  })
})

describe('addMonths', () => {
  it('adds calendar months and clamps to the last day', () => {
    expect(addMonths(new Date('2026-10-28T00:00:00Z'), 1).toISOString()).toBe('2026-11-28T00:00:00.000Z')
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2027-02-28T00:00:00.000Z'.replace('2027', '2026'))
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 3).toISOString()).toBe('2027-03-15T00:00:00.000Z')
  })
})

describe('daysLeft', () => {
  it('rounds partial days up', () => {
    expect(daysLeft({ endsAt: new Date(ends.getTime() + 2.2 * DAY) }, ends)).toBe(3)
  })
})
