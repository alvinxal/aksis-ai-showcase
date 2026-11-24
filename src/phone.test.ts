import { describe, expect, it } from 'vitest'
import { normalizePhone, splitNameAndPhone, whatsappLink } from './phone.js'

describe('normalizePhone', () => {
  it('normalizes phone numbers', () => {
    expect(normalizePhone('0812 3456 7890')).toBe('6281234567890')
    expect(normalizePhone('+62 812-3456-7890')).toBe('6281234567890')
    expect(normalizePhone('6281234567890')).toBe('6281234567890')
    expect(normalizePhone('abc')).toBeNull()
    expect(normalizePhone('123')).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
  })
})

describe('splitNameAndPhone', () => {
  it('takes a trailing number off the name', () => {
    expect(splitNameAndPhone('Studio Satu 0812-3456-7890')).toEqual({ name: 'Studio Satu', phone: '6281234567890' })
    expect(splitNameAndPhone('  Dewi   +6281234567890 ')).toEqual({ name: 'Dewi', phone: '6281234567890' })
  })

  it('leaves a name alone, including a name with digits and a lone number', () => {
    expect(splitNameAndPhone('Studio Satu')).toEqual({ name: 'Studio Satu', phone: null })
    expect(splitNameAndPhone('Studio 21')).toEqual({ name: 'Studio 21', phone: null })
    expect(splitNameAndPhone('081234567890')).toEqual({ name: '081234567890', phone: null })
  })
})

describe('whatsappLink', () => {
  it('opens a chat with the message already typed, safely encoded', () => {
    const link = whatsappLink('6281234567890', 'Halo, ini link:\nhttps://x.test/join/abc?x=1&y=2')
    expect(link.startsWith('https://wa.me/6281234567890?text=')).toBe(true)
    expect(decodeURIComponent(link.split('?text=')[1]!)).toBe('Halo, ini link:\nhttps://x.test/join/abc?x=1&y=2')
    expect(link).not.toContain('\n')
    expect(link).not.toContain('&y=2')
  })

  it('lets WhatsApp ask for the recipient when there is no number', () => {
    const link = whatsappLink(null, 'Halo')
    expect(link).toBe('https://wa.me/?text=Halo')
  })
})
