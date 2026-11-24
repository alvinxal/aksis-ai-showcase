import { useEffect } from 'react'

export type TextSize = 'small' | 'normal' | 'large' | 'xlarge'

export const TEXT_SIZES: Array<{ id: TextSize; label: string }> = [
  { id: 'small', label: 'Kecil' },
  { id: 'normal', label: 'Normal' },
  { id: 'large', label: 'Besar' },
  { id: 'xlarge', label: 'Sangat besar' },
]

const KEY = 'aksis.textsize'
const isSize = (value: unknown): value is TextSize => TEXT_SIZES.some((size) => size.id === value)

/** Kept on the device only; styles.css scales the root font size from `data-text` on <html> (no inline style, the CSP forbids it). */
export function readTextSize(): TextSize {
  try {
    const stored = window.localStorage.getItem(KEY)
    return isSize(stored) ? stored : 'normal'
  } catch {
    return 'normal'
  }
}

export function applyTextSize(size: TextSize): void {
  if (size === 'normal') delete document.documentElement.dataset.text
  else document.documentElement.dataset.text = size
}

export function saveTextSize(size: TextSize): void {
  try {
    window.localStorage.setItem(KEY, size)
  } catch {
    // Private mode: the choice then lasts until the app is closed.
  }
  applyTextSize(size)
}

/** The app, not the landing page, follows the saved size. */
export function useTextSizeScope(): void {
  useEffect(() => {
    applyTextSize(readTextSize())
    return () => {
      delete document.documentElement.dataset.text
    }
  }, [])
}
