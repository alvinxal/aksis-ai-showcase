import { useEffect, useState } from 'react'

/**
 * The part of the screen that is really visible, so a screen can shrink when the keyboard opens and keep its
 * header on top, as WhatsApp does. Android Chrome does this on its own with `interactive-widget=resizes-content`
 * (see index.html); iOS Safari only reports it through visualViewport, and scrolls the page to show the field.
 */
export function useVisibleViewport(): { height: number; top: number } | null {
  const [box, setBox] = useState<{ height: number; top: number } | null>(() => {
    const viewport = window.visualViewport
    return viewport ? { height: viewport.height, top: viewport.offsetTop } : null
  })
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setBox({ height: viewport.height, top: viewport.offsetTop })
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    update()
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return box
}
