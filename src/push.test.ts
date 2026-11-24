import { describe, expect, it } from 'vitest'
import type { DueItem } from './projects.js'
import { digestMessage, isAllowedEndpoint, sendDigests, validSubscription } from './push.js'

describe('which push addresses the server will call', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGk3',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => expect(isAllowedEndpoint(endpoint)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evil.example/fcm.googleapis.com',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://push.apple.com/x',
    'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(700)}`,
  ])('refuses %s', (endpoint) => expect(isAllowedEndpoint(endpoint)).toBe(false))

  it('checks the keys too', () => {
    const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }
    expect(validSubscription(ok)).toBe(true)
    expect(validSubscription({ ...ok, p256dh: 'short' })).toBe(false)
    expect(validSubscription({ ...ok, auth: 'bad key!' })).toBe(false)
  })
})

describe('the morning message', () => {
  const now = new Date('2026-10-29T01:00:00Z') // Thursday 08:00 in Jakarta
  const item = (project: string, title: string, due: string, id = project): DueItem => ({ projectId: id, project, title, dueAt: new Date(due), type: 'PAYMENT_DUE' })

  it('names the two most pressing things and how many more, in plain words', () => {
    const message = digestMessage(
      [
        item('Rumah Budi', 'Termin 2 jatuh tempo', '2026-10-29T08:00:00Z'),
        item('Villa Sanur', 'Survei lokasi', '2026-10-30T02:00:00Z'),
        item('Rumah Budi', 'Gambar potongan A-A', '2026-10-30T09:00:00Z'),
      ],
      now,
    )
    expect(message.title).toBe('3 hal perlu perhatian')
    expect(message.body).toBe('Termin 2 jatuh tempo (Rumah Budi), hari ini. Survei lokasi (Villa Sanur), besok. +1 lagi')
    expect(message.url).toBe('/app/proyek')
    expect(message.body).not.toMatch(/Rp|\d{6}/)
  })

  it('opens the project when everything is about one project, and says what was missed', () => {
    const message = digestMessage([item('Rumah Budi', 'Termin 1', '2026-10-27T05:00:00Z', 'p1')], now)
    expect(message).toMatchObject({ title: '1 hal perlu perhatian', body: 'Termin 1 (Rumah Budi), terlewat 2 hari', url: '/app/proyek/p1' })
  })
})

describe('when the digest may go out', () => {
  const never = (() => {
    throw new Error('the database must not be touched')
  }) as never
  const send = async () => undefined

  it('does nothing before the digest hour or from noon on (Jakarta)', async () => {
    expect(await sendDigests(never, send, 7, new Date('2026-10-28T22:30:00Z'))).toBe(0) // 05:30
    expect(await sendDigests(never, send, 7, new Date('2026-10-29T05:00:00Z'))).toBe(0) // 12:00
    expect(await sendDigests(never, send, 7, new Date('2026-10-29T09:00:00Z'))).toBe(0) // 16:00
  })
})
