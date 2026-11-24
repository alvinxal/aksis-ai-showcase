import { useSyncExternalStore } from 'react'

// Chrome on Android offers the install dialog through this event, once and early, so it is kept here.
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let saved: InstallPrompt | null = null
let installed = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/** Call once at startup, before React renders, so the event is not missed. */
export function listenForInstall(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    saved = event as InstallPrompt
    notify()
  })
  window.addEventListener('appinstalled', () => {
    saved = null
    installed = true
    notify()
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useInstall(): { canPrompt: boolean; installed: boolean; install: () => Promise<void> } {
  const canPrompt = useSyncExternalStore(subscribe, () => saved !== null)
  const done = useSyncExternalStore(subscribe, () => installed)
  return {
    canPrompt,
    installed: done,
    install: async () => {
      if (!saved) return
      await saved.prompt()
      const { outcome } = await saved.userChoice
      if (outcome === 'accepted') {
        installed = true
        notify()
      }
      saved = null
      notify()
    },
  }
}
