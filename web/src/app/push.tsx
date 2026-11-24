import { Bell } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError, pushApi } from '../api'
import { SAMPLE_DATA } from './data'

type State = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on' | 'working' | 'failed'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function keyBytes(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

/** Waits for the service worker, but not forever: in a browser where none is registered it never comes. */
const registration = () =>
  Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000))])

const COPY: Record<State, string> = {
  checking: 'Memeriksa…',
  unsupported: 'Perangkat ini belum mendukung notifikasi.',
  blocked: 'Notifikasi diblokir. Aktifkan lewat pengaturan perangkat, lalu buka halaman ini lagi.',
  off: 'Dapatkan pengingat tenggat dan tagihan setiap pagi sekitar pukul 07.00.',
  on: 'Aktif. Pengingat tenggat dan tagihan dikirim setiap pagi sekitar pukul 07.00, hanya bila ada yang perlu dikerjakan.',
  working: 'Sebentar…',
  failed: 'Belum bisa diatur. Coba lagi sebentar lagi.',
}

/** The switch for the morning reminder. Permission is asked only when it is pressed, as phones require. */
export function PushToggle() {
  const [state, setState] = useState<State>(SAMPLE_DATA ? 'off' : 'checking')

  useEffect(() => {
    if (SAMPLE_DATA) return
    if (!supported()) return setState('unsupported')
    let live = true
    void (async () => {
      try {
        if (Notification.permission === 'denied') return live && setState('blocked')
        const reg = await registration()
        if (!reg) return live && setState('unsupported')
        const existing = await reg.pushManager.getSubscription()
        if (!live) return
        if (existing && Notification.permission === 'granted') {
          setState('on')
          // Registered again in case the server lost it; harmless when it already knows the device.
          const json = existing.toJSON()
          if (json.endpoint && json.keys?.p256dh && json.keys.auth) void pushApi.subscribe(json.endpoint, json.keys.p256dh, json.keys.auth).catch(() => undefined)
        } else setState('off')
      } catch {
        if (live) setState('failed')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const turnOn = async () => {
    if (SAMPLE_DATA) return setState('on')
    setState('working')
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return setState(permission === 'denied' ? 'blocked' : 'off')
      const reg = await registration()
      if (!reg) return setState('unsupported')
      const key = await pushApi.key()
      const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource })
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('incomplete subscription')
      await pushApi.subscribe(json.endpoint, json.keys.p256dh, json.keys.auth)
      setState('on')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
      setState('failed')
    }
  }

  const turnOff = async () => {
    if (SAMPLE_DATA) return setState('off')
    setState('working')
    try {
      const reg = await registration()
      const subscription = await reg?.pushManager.getSubscription()
      if (subscription) {
        await pushApi.unsubscribe(subscription.endpoint).catch(() => undefined)
        await subscription.unsubscribe()
      }
      setState('off')
    } catch {
      setState('failed')
    }
  }

  const on = state === 'on'
  const canPress = state === 'off' || state === 'on' || state === 'failed'
  return (
    <div className="rounded-xl bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <Bell aria-hidden="true" className="h-4 w-4" /> Notifikasi pagi
        </span>
        {(canPress || state === 'working') && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Notifikasi pagi"
            disabled={!canPress}
            onClick={() => void (on ? turnOff() : turnOn())}
            className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${on ? 'bg-brand-500' : 'bg-ink-mute/40'}`}
          >
            <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        )}
      </div>
      <p role="status" className="mt-1.5 text-sm leading-snug text-ink-soft">
        {COPY[state]}
      </p>
    </div>
  )
}
