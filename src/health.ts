/** The AI features whose failures the admins hear about. */
export type Feature = 'chat' | 'summary' | 'push'

const KEEP_MS = 3_600_000

/**
 * Remembers, in memory, whether the last attempts of each feature worked. A failed chat answer or note leaves no row
 * in the database (only answers that were written are stored), so the monitor asks this instead. A restart clears it,
 * which is fine: an alert needs several recent failures anyway.
 */
export class FeatureHealth {
  private readonly events = new Map<Feature, Array<{ at: number; ok: boolean }>>()

  record(feature: Feature, ok: boolean, at = Date.now()): void {
    const list = (this.events.get(feature) ?? []).filter((event) => at - event.at < KEEP_MS)
    list.push({ at, ok })
    this.events.set(feature, list)
  }

  recent(feature: Feature, windowMs: number, now = Date.now()): { failures: number; successes: number } {
    const inside = (this.events.get(feature) ?? []).filter((event) => now - event.at < windowMs)
    return { failures: inside.filter((event) => !event.ok).length, successes: inside.filter((event) => event.ok).length }
  }
}
