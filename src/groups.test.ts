import { describe, expect, it } from 'vitest'
import type { Database } from './db.js'
import { GROUP_LIMIT, saveSelectedGroups } from './groups.js'

/** A database whose only answer is the tenant's plan; any write would fail on `begin`. */
function planOnlyDatabase(groupLimit: number | null): Database {
  const query = async () =>
    groupLimit === null
      ? []
      : [{ tenant_id: 't1', plan_code: 'basic', plan_name: 'Basic', group_limit: groupLimit, started_at: new Date(), ends_at: new Date() }]
  return Object.assign(query, {
    begin: () => {
      throw new Error('must not write')
    },
  }) as unknown as Database
}

function groups(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    jid: `g${index}@g.us`,
    subject: `Grup ${index}`,
    participants: 3,
  }))
}

describe('saveSelectedGroups', () => {
  it('refuses more groups than the largest plan allows before writing', async () => {
    const live = groups(GROUP_LIMIT + 1)
    const result = await saveSelectedGroups(planOnlyDatabase(null), 't1', live, live.map((group) => group.jid))
    expect(result).toEqual({ ok: false, reason: `Maksimal ${GROUP_LIMIT} grup untuk paket Anda.` })
  })

  it('applies the limit of the tenant plan', async () => {
    const live = groups(4)
    const result = await saveSelectedGroups(planOnlyDatabase(3), 't1', live, live.map((group) => group.jid))
    expect(result).toEqual({ ok: false, reason: 'Maksimal 3 grup untuk paket Anda.' })
  })
})
