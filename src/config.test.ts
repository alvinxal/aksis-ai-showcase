import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = { DATABASE_URL: 'postgres://x' }

describe('SYSTEM_WHATSAPP_PHONE', () => {
  it('is off when unset', () => {
    expect(loadConfig(base).systemWhatsappPhone).toBeUndefined()
  })

  it('accepts local and international formats', () => {
    expect(loadConfig({ ...base, SYSTEM_WHATSAPP_PHONE: '081200000000' }).systemWhatsappPhone).toBe('6281200000000')
    expect(loadConfig({ ...base, SYSTEM_WHATSAPP_PHONE: '+62 812-0000-0000' }).systemWhatsappPhone).toBe('6281200000000')
  })

  it('rejects garbage', () => {
    expect(() => loadConfig({ ...base, SYSTEM_WHATSAPP_PHONE: 'abc' })).toThrow('SYSTEM_WHATSAPP_PHONE')
  })
})

describe('HERMES_VISION_MODEL', () => {
  it('keeps image chat off unless a vision model is named', () => {
    const hermes = { ...base, HERMES_ENABLED: 'true', HERMES_API_KEY: 'secret' }
    expect(loadConfig(hermes).hermes?.visionModel).toBeUndefined()
    expect(loadConfig({ ...hermes, HERMES_VISION_MODEL: 'vision-test' }).hermes?.visionModel).toBe('vision-test')
  })
})
