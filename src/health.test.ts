import { describe, expect, it } from 'vitest'
import { FeatureHealth } from './health.js'
import { featureConditions } from './monitor.js'

const MIN = 60_000

describe('feature health', () => {
  it('counts recent successes and failures per feature, inside the window only', () => {
    const health = new FeatureHealth()
    health.record('chat', false, 0)
    health.record('chat', false, 10 * MIN)
    health.record('chat', true, 12 * MIN)
    health.record('summary', false, 12 * MIN)
    expect(health.recent('chat', 15 * MIN, 14 * MIN)).toEqual({ failures: 2, successes: 1 })
    expect(health.recent('chat', 15 * MIN, 20 * MIN)).toEqual({ failures: 1, successes: 1 })
    expect(health.recent('push', 15 * MIN, 14 * MIN)).toEqual({ failures: 0, successes: 0 })
  })

  it('forgets what is older than an hour', () => {
    const health = new FeatureHealth()
    health.record('chat', false, 0)
    health.record('chat', true, 2 * 60 * MIN)
    expect(health.recent('chat', 4 * 60 * MIN, 2 * 60 * MIN)).toEqual({ failures: 0, successes: 1 })
  })
})

describe('alerts for the app features', () => {
  const fail = (health: FeatureHealth, feature: 'chat' | 'summary' | 'push', times: number, at: number) => {
    for (let i = 0; i < times; i += 1) health.record(feature, false, at)
  }

  it('stay quiet for one or two failures', () => {
    const health = new FeatureHealth()
    fail(health, 'chat', 2, 0)
    expect(featureConditions(health, MIN)).toEqual([])
  })

  it('raise for three failures in a row, naming the feature and the window', () => {
    const health = new FeatureHealth()
    fail(health, 'chat', 3, 0)
    const [chat] = featureConditions(health, MIN)
    expect(chat).toMatchObject({ key: 'feature-chat', holdMs: 0, recovered: '✅ Chat di app menjawab normal lagi.' })
    expect(chat?.message).toBe('⚠️ Chat di app gagal menjawab 3 kali dalam 15 menit terakhir.')
    expect(chat?.keyboard).toEqual([[{ text: '📊 Health', callback_data: 'm:status' }]])
  })

  it('stay quiet when the feature works more often than it fails, and clear when the failures age out', () => {
    const mixed = new FeatureHealth()
    fail(mixed, 'chat', 3, 0)
    for (let i = 0; i < 4; i += 1) mixed.record('chat', true, MIN)
    expect(featureConditions(mixed, 2 * MIN)).toEqual([])

    const old = new FeatureHealth()
    fail(old, 'chat', 5, 0)
    expect(featureConditions(old, 16 * MIN)).toEqual([])
  })

  it('judge each feature on its own, with a longer window for notes and push', () => {
    const health = new FeatureHealth()
    fail(health, 'summary', 3, 0)
    fail(health, 'push', 4, 0)
    const conditions = featureConditions(health, 30 * MIN)
    expect(conditions.map((c) => c.key)).toEqual(['feature-summary', 'feature-push'])
    expect(conditions[1]?.message).toBe('⚠️ Notifikasi push gagal terkirim 4 kali dalam 1 jam terakhir.')
  })
})
