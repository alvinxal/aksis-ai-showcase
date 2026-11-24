import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, dashboardApi } from '../api'

/** The link from the bot is /dashboard/masuk#<token>; the token is in the # part so no server ever sees it in a request line. */
export function DashboardLogin() {
  const navigate = useNavigate()
  const [state, setState] = useState<'working' | 'invalid' | 'failed'>('working')

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? window.location.hash.slice(1)
    // Take the token out of the address bar and the history at once.
    window.history.replaceState(null, '', window.location.pathname)
    if (!token) {
      setState('invalid')
      return
    }
    dashboardApi
      .login(token)
      .then(() => navigate('/dashboard', { replace: true }))
      .catch((caught: unknown) => setState(caught instanceof ApiError && caught.status === 401 ? 'invalid' : 'failed'))
  }, [navigate])

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 px-6 text-center">
      <img src="/logo-lockup.svg" alt="Aksis AI" className="mx-auto h-8 w-auto" />
      {state === 'working' && <p className="text-ink-soft">Masuk…</p>}
      {state === 'invalid' && (
        <>
          <h1 className="text-xl font-semibold">Link tidak berlaku</h1>
          <p className="text-ink-soft">Link masuk hanya bisa dipakai sekali dan berlaku 5 menit. Ketik /dashboard di bot Telegram untuk mendapat link baru.</p>
        </>
      )}
      {state === 'failed' && (
        <>
          <h1 className="text-xl font-semibold">Belum bisa masuk</h1>
          <p className="text-ink-soft">Coba lagi sebentar lagi, atau minta link baru lewat /dashboard di bot Telegram.</p>
        </>
      )}
    </main>
  )
}
