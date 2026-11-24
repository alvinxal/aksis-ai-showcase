import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'

export type Device = {
  kind: 'phone' | 'desktop'
  os: 'android' | 'ios' | 'other'
  /** Running as an installed app (from the home screen), not in a browser tab. */
  standalone: boolean
  /** Opened inside another app (WhatsApp, Instagram, ...), which cannot install a web app. */
  inApp: boolean
  /** `vite dev` only: set by ?device=... so every state can be previewed. */
  forced: boolean
}

const PREVIEW: Record<string, Omit<Device, 'forced'>> = {
  desktop: { kind: 'desktop', os: 'other', standalone: false, inApp: false },
  android: { kind: 'phone', os: 'android', standalone: false, inApp: false },
  'android-inapp': { kind: 'phone', os: 'android', standalone: false, inApp: true },
  ios: { kind: 'phone', os: 'ios', standalone: false, inApp: false },
  'ios-inapp': { kind: 'phone', os: 'ios', standalone: false, inApp: true },
  installed: { kind: 'phone', os: 'android', standalone: true, inApp: false },
}

/**
 * Aksis is used from a phone: Android or iPhone. A tablet or a computer (an iPad calls itself a Mac) is
 * not. The server checks the same User-Agent before it spends an invitation; this is the page's side.
 */
export function detectDevice(search: string, userAgent = navigator.userAgent): Device {
  if (import.meta.env.DEV) {
    const forced = PREVIEW[new URLSearchParams(search).get('device') ?? '']
    if (forced) return { ...forced, forced: true }
  }
  const ios = /iPhone|iPod/.test(userAgent)
  const android = /Android/.test(userAgent) && /Mobile/.test(userAgent)
  return {
    kind: ios || android ? 'phone' : 'desktop',
    os: ios ? 'ios' : android ? 'android' : 'other',
    standalone: window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    inApp: /FBAN|FBAV|Instagram|MicroMessenger|Line\/|WhatsApp|; wv\)/i.test(userAgent),
    forced: false,
  }
}

export function useDevice(): Device {
  const { search } = useLocation()
  return useMemo(() => detectDevice(search), [search])
}

/** While designing (`vite dev`) the gates stay open unless a ?device= preview is asked for. */
export const gateIsOpen = (device: Device) => import.meta.env.DEV && !device.forced
