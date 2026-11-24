import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed' } | { status: 'expired' }

/** Loads a dashboard resource, keeps it fresh every `refreshMs`, and tells the page when the session is over (401). */
export function useData<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: number): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  const loader = useRef(load)
  loader.current = load

  const run = useCallback((quiet: boolean) => {
    if (!quiet) setState((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    loader
      .current()
      .then((data) => setState({ status: 'ready', data }))
      .catch((caught: unknown) => setState((current) => (caught instanceof ApiError && caught.status === 401 ? { status: 'expired' } : quiet && current.status === 'ready' ? current : { status: 'failed' })))
  }, [])

  useEffect(() => {
    run(false)
    if (!refreshMs) return
    const timer = window.setInterval(() => run(true), refreshMs)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshMs, run])

  return { state, reload: () => run(false) }
}
