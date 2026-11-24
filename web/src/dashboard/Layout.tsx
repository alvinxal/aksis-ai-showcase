import { Activity, Ellipsis, FileClock, Gauge, HeartPulse, Inbox, LogOut, ShieldCheck, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { dashboardApi } from '../api'
import { useTextSizeScope } from '../app/textsize'

const TABS = [
  { to: '/dashboard', label: 'Ringkasan', icon: Gauge, end: true },
  { to: '/dashboard/pelanggan', label: 'Pelanggan', icon: Users, end: false },
  { to: '/dashboard/biaya', label: 'Biaya', icon: Activity, end: false },
  { to: '/dashboard/kesehatan', label: 'Kesehatan', icon: HeartPulse, end: false },
]

/** On a laptop the pages behind "Lainnya" sit in the sidebar. */
const SIDEBAR_MORE = [
  { to: '/dashboard/permintaan', label: 'Permintaan akses', icon: Inbox },
  { to: '/dashboard/admin', label: 'Admin', icon: ShieldCheck },
  { to: '/dashboard/audit', label: 'Catatan admin', icon: FileClock },
]

const MORE_PATHS = ['/dashboard/lainnya', '/dashboard/permintaan', '/dashboard/admin', '/dashboard/audit']

export function useSignOut() {
  const navigate = useNavigate()
  return () => void dashboardApi.logout().finally(() => navigate('/dashboard/masuk', { replace: true }))
}

/**
 * Frame of the dashboard. Like the customer app on a phone (tabs at the bottom, big titles, cards) and with a sidebar on a laptop.
 * Admin-only and kept out of search engines. It is not part of the installable customer app, so it does not offer to install it.
 */
export function DashboardLayout() {
  const location = useLocation()
  const signOut = useSignOut()
  const [session, setSession] = useState<'checking' | 'in' | 'out'>('checking')
  useTextSizeScope()

  useEffect(() => {
    document.title = 'Dashboard · Aksis AI'
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    const manifest = document.querySelector('link[rel="manifest"]')
    const parent = manifest?.parentNode
    manifest?.remove()
    dashboardApi
      .me()
      .then(() => setSession('in'))
      .catch(() => setSession('out'))
    return () => {
      meta.remove()
      if (manifest && parent) parent.appendChild(manifest)
    }
  }, [])

  if (session === 'checking') return <p className="p-8 text-ink-soft">Memuat…</p>
  if (session === 'out') return <SignedOut />

  const moreActive = MORE_PATHS.some((path) => location.pathname.startsWith(path))
  const tabClass = (active: boolean) => `flex flex-col items-center gap-1 py-2.5 text-xs font-medium ${active ? 'text-brand-600' : 'text-ink-mute'}`

  return (
    <div className="min-h-dvh bg-surface text-ink lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-black/5 bg-white lg:flex lg:min-h-screen lg:flex-col">
        <div className="px-5 py-5">
          <img src="/logo-lockup.svg" alt="Aksis AI" className="h-6 w-auto" />
          <p className="mt-1 text-xs text-ink-soft">Dashboard admin</p>
        </div>
        <nav aria-label="Dashboard" className="flex flex-col gap-1 px-3">
          {[...TABS, ...SIDEBAR_MORE.map((item) => ({ ...item, end: false }))].map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-surface'}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-3 pb-5">
          <button type="button" onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft hover:bg-surface">
            <LogOut aria-hidden="true" className="h-4 w-4" /> Keluar
          </button>
        </div>
      </aside>

      <main className="min-w-0 px-5 pb-28 pt-6 sm:px-8 lg:pb-10 lg:pt-8">
        <Outlet />
      </main>

      <nav aria-label="Dashboard" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-black/5 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
        {TABS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => tabClass(isActive)}>
            <Icon aria-hidden="true" className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
        <NavLink to="/dashboard/lainnya" className={() => tabClass(moreActive)}>
          <Ellipsis aria-hidden="true" className="h-5 w-5" />
          Lainnya
        </NavLink>
      </nav>
    </div>
  )
}

export function SignedOut() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 px-6 text-center">
      <img src="/logo-lockup.svg" alt="Aksis AI" className="mx-auto h-8 w-auto" />
      <h1 className="text-xl font-semibold">Sesi berakhir</h1>
      <p className="text-ink-soft">Ketik /dashboard di bot Telegram untuk mendapat link masuk baru. Link berlaku 5 menit dan sekali pakai.</p>
    </main>
  )
}

