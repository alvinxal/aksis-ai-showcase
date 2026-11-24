import { ChevronLeft, ChevronRight, FolderKanban, ImagePlus, LogOut, Menu, MessageCircle, Paperclip, Search, SendHorizontal, Settings, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Navigate, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, chatApi } from '../api'
import { AGENTS, THREADS, type Message } from '../mock'
import { LoadFailed, Loading } from '../onboarding/screens'
import { SAMPLE_DATA, SAMPLE_ME, useProject } from './data'
import { dayKey, dayLabel, dayLabelWithDate } from './chatdays'
import { COMMANDS, HELP_TEXT, type Command } from './commands'
import { useVisibleViewport } from './viewport'
import type { SessionContext } from './Login'
import { PushToggle } from './push'
import { ReminderSetting } from './workspace'
import { renderRich } from './richtext'

const TABS = [
  { to: '/app', label: 'Chats', icon: MessageCircle, end: true },
  { to: '/app/proyek', label: 'Proyek', icon: FolderKanban, end: false },
  { to: '/app/pengaturan', label: 'Pengaturan', icon: Settings, end: false },
]

export function AppShell() {
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <div className="flex-1 overflow-y-auto">
        <Outlet context={useOutletContext()} />
      </div>
      <nav className="grid grid-cols-3 border-t border-surface bg-white pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex flex-col items-center gap-1 py-2.5 text-xs font-medium ${isActive ? 'text-brand-600' : 'text-ink-mute'}`}>
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

const clock = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' })
const dayStamp = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' })
const timeOf = (iso: string) => {
  const date = new Date(iso)
  return Date.now() - date.getTime() < 20 * 3_600_000 ? clock.format(date).replace(':', '.') : `${dayStamp.format(date)}, ${clock.format(date).replace(':', '.')}`
}
/** A bubble only shows the clock; the day badges between and above the bubbles carry the date. */
const clockOf = (iso: string) => clock.format(new Date(iso)).replace(':', '.')
/** Chat-list stamp as in WhatsApp: the clock today, "Kemarin", else the date. */
const listStamp = (iso: string) => {
  const date = new Date(iso)
  const dayKey = (value: Date) => dayStamp.format(value)
  if (dayKey(date) === dayKey(new Date())) return clock.format(date).replace(':', '.')
  if (dayKey(date) === dayKey(new Date(Date.now() - 86_400_000))) return 'Kemarin'
  return dayKey(date)
}
/** One line for the list: the WhatsApp marks and line breaks are dropped. */
const previewOf = (text: string) => text.replace(/\s+/g, ' ').replace(/([*_~`])(\S(?:.*?\S)?)\1/g, '$2').trim()


/** Tallest the message field gets: about five lines. */
const FIELD_MAX_PX = 132

type Filter = 'all' | 'unread'

/** In production only Aksis answers; the other agents of the sample data come later. */
const LIVE_AGENTS = AGENTS.filter((agent) => agent.id === 'aksis')

export function ChatList() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const agents = SAMPLE_DATA ? AGENTS : LIVE_AGENTS
  const [latest, setLatest] = useState<Record<string, { role: 'user' | 'agent' | 'divider'; text: string; createdAt: string }>>({})
  useEffect(() => {
    if (SAMPLE_DATA) return
    let live = true
    chatApi
      .latest()
      .then((list) => live && setLatest(Object.fromEntries(list.map((entry) => [entry.agent, entry]))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const unreadCount = agents.filter((agent) => agent.unread > 0).length
  const shown = agents.filter((agent) => (filter === 'all' || agent.unread > 0) && agent.name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <div className="px-5 pt-6">
      <header>
        <h1 className="text-[2rem] font-semibold leading-none tracking-tight">Chats</h1>
      </header>
      {SAMPLE_DATA && (
        <>
          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Cari" className="w-full rounded-2xl bg-surface py-3 pl-11 pr-4 text-[0.9375rem] outline-none ring-brand-500 focus:ring-2" />
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => setFilter('all')} className={`chip ${filter === 'all' ? 'bg-brand-50 text-brand-700' : ''}`}>
              Semua
            </button>
            <button type="button" onClick={() => setFilter('unread')} className={`chip ${filter === 'unread' ? 'bg-brand-50 text-brand-700' : ''}`}>
              Belum dibaca {unreadCount}
            </button>
          </div>
        </>
      )}
      <ul className="mt-2">
        {shown.map((agent) => (
          <li key={agent.id}>
            <Link to={`/app/chat/${agent.id}`} className="flex items-center gap-3 py-3">
              <img src={agent.avatar} alt="" width={56} height={56} className="h-14 w-14 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{agent.name}</span>
                  {(SAMPLE_DATA || latest[agent.id]) && <span className="shrink-0 text-xs text-ink-mute">{SAMPLE_DATA ? agent.time : listStamp(latest[agent.id]!.createdAt)}</span>}
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-ink-soft">{SAMPLE_DATA ? agent.last : latest[agent.id] ? `${latest[agent.id]!.role === 'user' ? 'Anda: ' : ''}${previewOf(latest[agent.id]!.text)}` : 'Tanya soal proyek, tenggat, dan pembayaran'}</span>
                  {SAMPLE_DATA && agent.unread > 0 && <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand-500 px-1.5 text-xs font-semibold text-white">{agent.unread}</span>}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {shown.length === 0 && <li className="py-10 text-center text-sm text-ink-mute">Tidak ada percakapan.</li>}
      </ul>
    </div>
  )
}

const ERRORS: Record<string, string> = {
  paused: 'Layanan AI akun Anda sedang dijeda. Hubungi tim Aksis.',
  limited: 'Terlalu banyak pertanyaan dalam satu jam. Coba lagi nanti.',
  busy: 'Pertanyaan sebelumnya masih dijawab. Tunggu sebentar.',
  unavailable: 'Aksis belum bisa menjawab sekarang. Coba lagi sebentar lagi.',
  image_unavailable: 'Analisis gambar belum tersedia pada model saat ini.',
  invalid_message: 'Pesan kosong atau terlalu panjang (maksimal 1.000 karakter).',
}

/** "Tentang proyek" chip above the message field: questions sent while it shows only look at that project. */
function ProjectScope({ id, onClear }: { id: string; onClear: () => void }) {
  const project = useProject(id)
  return (
    <div className="bg-surface px-3 pt-3">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-white py-1.5 pl-3 pr-1.5 text-sm">
        <Paperclip aria-hidden="true" className="h-4 w-4 shrink-0 text-leaf" />
        <span className="min-w-0 flex-1 truncate">
          Tentang proyek: <span className="font-semibold">{project.state === 'ready' ? project.data.name : '…'}</span>
        </span>
        <button type="button" aria-label="Hapus batasan proyek" onClick={onClear} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-soft">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export function ChatThread() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const projectId = params.get('proyek')
  const agent = AGENTS.find((item) => item.id === id && (SAMPLE_DATA || item.id === 'aksis'))
  const [messages, setMessages] = useState<Message[]>(() => (SAMPLE_DATA ? (THREADS[id] ?? []) : []))
  const [loading, setLoading] = useState<'loading' | 'ready' | 'failed'>(SAMPLE_DATA ? 'ready' : 'loading')
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const [fieldHeight, setFieldHeight] = useState(0)
  const viewport = useVisibleViewport()
  const [menuOpen, setMenuOpen] = useState(false)
  const [imagesEnabled, setImagesEnabled] = useState(false)
  const [image, setImage] = useState<{ name: string; type: string; dataUrl: string } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const [badge, setBadge] = useState<{ label: string; shown: boolean }>({ label: '', shown: false })
  const badgeTimer = useRef<number | undefined>(undefined)
  const lastJump = useRef(0)

  useEffect(() => {
    if (SAMPLE_DATA || !agent) return
    let live = true
    setLoading('loading')
    chatApi
      .history(agent.id)
      .then((list) => {
        if (!live) return
        setMessages(list.map((entry) => ({ id: entry.id, from: entry.role === 'user' ? 'me' : entry.role === 'divider' ? 'divider' : 'agent', text: entry.text, time: clockOf(entry.createdAt), at: entry.createdAt })))
        setLoading('ready')
      })
      .catch((caught: unknown) => {
        if (!live) return
        if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
        setLoading('failed')
      })
    return () => {
      live = false
    }
  }, [agent, attempt])

  // The field is one line when empty and grows with the text up to FIELD_MAX_PX, then scrolls inside itself.
  useLayoutEffect(() => {
    const box = field.current
    if (!box) return
    box.style.height = 'auto'
    const height = Math.min(box.scrollHeight, FIELD_MAX_PX)
    box.style.height = `${height}px`
    setFieldHeight(height)
  }, [draft, loading])

  // The newest bubble stays right above the field, also when a reply arrives, the keyboard opens and the screen gets shorter.
  const shownCount = useRef(0)
  useLayoutEffect(() => {
    const box = scroller.current
    if (!box) return
    const toEnd = (smooth: boolean) => {
      // Scrolling the list to its end by itself must not make the day badge appear.
      lastJump.current = Date.now()
      box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    }
    // The first fill of the list jumps; later messages glide down.
    const smooth = shownCount.current > 0 && messages.length > shownCount.current
    shownCount.current = messages.length
    toEnd(smooth)
    const frame = window.requestAnimationFrame(() => toEnd(smooth))
    return () => window.cancelAnimationFrame(frame)
  }, [messages, waiting, loading, viewport?.height, fieldHeight])
  useEffect(() => () => window.clearTimeout(badgeTimer.current), [])
  useEffect(() => {
    if (SAMPLE_DATA) return setImagesEnabled(true)
    void chatApi.capabilities().then((value) => setImagesEnabled(value.images)).catch(() => undefined)
  }, [])
  if (!agent) return <Navigate to="/app" replace />

  // While the reader scrolls, a badge slides down from the top with the day of the topmost message; it fades away on its own.
  const onScroll = () => {
    const box = scroller.current
    if (!box || Date.now() - lastJump.current < 900) return
    const rows = box.querySelectorAll<HTMLElement>('[data-at]')
    const edge = box.scrollTop + 8
    let current: HTMLElement | null = null
    for (const row of rows) {
      if (row.offsetTop + row.offsetHeight > edge) {
        current = row
        break
      }
    }
    const at = current?.dataset.at
    if (!at) return
    setBadge({ label: dayLabelWithDate(at), shown: true })
    window.clearTimeout(badgeTimer.current)
    badgeTimer.current = window.setTimeout(() => setBadge((value) => ({ ...value, shown: false })), 1500)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || waiting) return
    return sendText(text)
  }

  const runCommand = async (command: Command) => {
    setMenuOpen(false)
    setDraft('')
    setError(null)
    if (command.kind === 'ask') return waiting ? undefined : sendText(command.question)
    const now = new Date().toISOString()
    if (command.kind === 'help') {
      setMessages((list) => [...list, { id: `help-${Date.now()}`, from: 'agent', text: HELP_TEXT, time: clockOf(now), at: now }])
      return
    }
    const last = messages[messages.length - 1]
    if (!last || last.from === 'divider') return
    if (SAMPLE_DATA || !agent) {
      setMessages((list) => [...list, { id: `new-${Date.now()}`, from: 'divider', text: 'Chat baru', time: '', at: now }])
      return
    }
    try {
      const divider = await chatApi.startNew(agent.id)
      if (divider) setMessages((list) => [...list, { id: divider.id, from: 'divider', text: divider.text, time: '', at: divider.createdAt }])
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
      setError('Belum bisa memulai chat baru. Coba lagi sebentar lagi.')
    }
  }

  const sendText = async (text: string) => {
    if (!agent) return
    setDraft('')
    setError(null)
    const mine: Message = { id: `me-${Date.now()}`, from: 'me', text, time: 'Baru saja', at: new Date().toISOString() }
    setMessages((list) => [...list, mine])
    setWaiting(true)
    if (SAMPLE_DATA) {
      window.setTimeout(() => {
        setMessages((list) => [...list, { id: `a-${Date.now()}`, from: 'agent', text: 'Ini jawaban contoh. Nanti dijawab agent sungguhan, lengkap dengan sumber pesan.', time: 'Baru saja', at: new Date().toISOString() }])
        setWaiting(false)
        setImage(null)
      }, 700)
      return
    }
    try {
      const reply = await chatApi.send(agent.id, text, projectId, image ?? undefined)
      setMessages((list) => [...list, { id: reply.id, from: 'agent', text: reply.text, time: clockOf(reply.createdAt), at: reply.createdAt }])
      setImage(null)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
      // The question was not stored, so take it back out and give the text back to edit.
      setMessages((list) => list.filter((message) => message.id !== mine.id))
      setDraft(text)
      setError((caught instanceof ApiError && ERRORS[caught.code]) || 'Belum bisa terkirim. Coba lagi sebentar lagi.')
    } finally {
      setWaiting(false)
    }
  }

  return (
    <div
      className="fixed inset-x-0 mx-auto flex max-w-md flex-col bg-white"
      style={viewport ? { top: viewport.top, height: viewport.height } : { top: 0, bottom: 0 }}
    >
      <header className="flex items-center gap-3 bg-surface px-3 py-3">
        <button type="button" aria-label="Kembali" onClick={() => navigate('/app')} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <img src={agent.avatar} alt="" width={40} height={40} className="h-10 w-10 rounded-full" />
        <div className="min-w-0">
          <p className="truncate font-semibold leading-tight">{agent.name}</p>
          <p className="text-xs text-ink-soft">{agent.role}</p>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center transition duration-200 motion-reduce:transition-none ${badge.shown ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0'}`}
        >
          <span className="rounded-full bg-ink/80 px-3 py-1 text-xs font-semibold text-white shadow-card">{badge.label}</span>
        </div>
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-4 py-4">
        {loading === 'loading' && <Loading />}
        {loading === 'failed' && <LoadFailed onRetry={() => setAttempt((count) => count + 1)} />}
        {loading === 'ready' && (
          <>
            {messages.length === 0 && (
              <p className="mx-auto max-w-xs py-8 text-center text-sm leading-relaxed text-ink-soft">
                Tanyakan apa saja soal proyek Anda, misalnya &quot;Apa yang jatuh tempo minggu ini?&quot; Aksis menjawab dari grup WhatsApp yang dipilih dan menyebut sumbernya.
              </p>
            )}
            <ul className="flex flex-col gap-3">
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  {message.at && dayKey(message.at) !== (messages[index - 1]?.at ? dayKey(messages[index - 1]!.at!) : null) && (
                    <li role="separator" aria-label={dayLabel(message.at)} className="flex justify-center py-1">
                      <span className="rounded-full bg-surface px-3 py-1 text-xs font-semibold text-ink-soft">{dayLabel(message.at)}</span>
                    </li>
                  )}
                {message.from === 'divider' ? (
                  <li data-at={message.at} role="separator" aria-label={message.text} className="flex items-center gap-3 py-1 text-xs font-semibold text-ink-mute">
                    <span aria-hidden="true" className="h-px flex-1 bg-surface" />
                    {message.text}
                    <span aria-hidden="true" className="h-px flex-1 bg-surface" />
                  </li>
                ) : (
                <li data-at={message.at} className={`flex flex-col ${message.from === 'me' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[82%] whitespace-pre-line rounded-2xl px-4 py-2.5 text-[0.9375rem] ${message.from === 'me' ? 'rounded-br-md bg-brand-500 text-white' : 'rounded-bl-md bg-surface text-ink'}`}>{message.from === 'agent' ? renderRich(message.text) : message.text}</div>
                  <span className="mt-1 text-[0.6875rem] text-ink-mute">{message.time}</span>
                </li>
                )}
                </Fragment>
              ))}
              {waiting && (
                <li role="status" className="flex flex-col items-start">
                  <div className="rounded-2xl rounded-bl-md bg-surface px-4 py-2.5 text-[0.9375rem] text-ink-soft">Aksis sedang menjawab…</div>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
      </div>
      {error && (
        <p role="alert" className="bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}
      {projectId && <ProjectScope id={projectId} onClear={() => setParams({}, { replace: true })} />}
      {image && <div className="flex items-center gap-2 bg-surface px-3 pt-2 text-sm"><span className="min-w-0 flex-1 truncate rounded-xl bg-white px-3 py-2">Gambar: {image.name}</span><button type="button" aria-label="Hapus gambar" onClick={() => setImage(null)} className="grid h-8 w-8 place-items-center"><X className="h-4 w-4" /></button></div>}
      {menuOpen && <button type="button" aria-label="Tutup menu" onClick={() => setMenuOpen(false)} className="absolute inset-0 z-10 cursor-default bg-ink/20" />}
      <form onSubmit={(event) => void submit(event)} className={`relative flex items-end gap-2 bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${projectId ? 'pt-2' : 'pt-3'}`}>
        {menuOpen && (
          <div role="menu" aria-label="Menu" className="absolute inset-x-3 bottom-full z-20 mb-1 max-h-[60vh] overflow-y-auto rounded-2xl bg-white shadow-card">
            {COMMANDS.map((command) => (
              <button key={command.id} type="button" role="menuitem" onClick={() => void runCommand(command)} className="block w-full border-b border-surface px-4 py-3 text-left last:border-b-0">
                <span className="block font-semibold leading-tight">{command.title}</span>
                <span className="block text-sm text-ink-soft">{command.hint}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-ink-soft">
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>
        {imagesEnabled && <>
          <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            if (file.size > 4_000_000) return setError('Ukuran gambar maksimal 4 MB.')
            const reader = new FileReader()
            reader.onload = () => typeof reader.result === 'string' && setImage({ name: file.name.slice(0, 100), type: file.type, dataUrl: reader.result })
            reader.readAsDataURL(file)
          }} />
          <button type="button" aria-label="Lampirkan gambar" onClick={() => imageInput.current?.click()} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-ink-soft"><ImagePlus className="h-5 w-5" /></button>
        </>}
        <textarea ref={field} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} placeholder="Pesan" aria-label="Pesan" className="block min-w-0 flex-1 resize-none rounded-3xl bg-white px-4 py-3 text-base leading-6 outline-none ring-brand-500 focus:ring-2" />
        <button type="submit" aria-label="Kirim" disabled={!draft.trim() || waiting || loading !== 'ready'} className="grid h-11 w-11 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-40">
          <SendHorizontal className="h-5 w-5" />
        </button>
      </form>
    </div>
  )
}

export function SettingsTab() {
  const session = useOutletContext<SessionContext | null>()
  const me = session?.me ?? SAMPLE_ME
  const [busy, setBusy] = useState(false)
  return (
    <div className="min-h-full bg-surface px-5 pb-6 pt-6">
      <h1 className="text-[2rem] font-semibold leading-none tracking-tight">Pengaturan</h1>
      <div className="card mt-5 text-sm">
        <p className="font-semibold">{me.tenantName}</p>
        {me.contactName && <p className="text-ink-soft">{me.contactName}</p>}
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <section aria-label="Pengingat" className="flex flex-col gap-3">
          <PushToggle />
          <ReminderSetting />
        </section>
        <section aria-label="Akun" className="flex flex-col gap-3">
        <Link to="/app/pengaturan/whatsapp" className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-card">
          <span><span className="block font-semibold">Koneksi WhatsApp</span><span className="block text-sm text-ink-soft">Status dan sambungkan ulang</span></span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <Link to="/app/pengaturan/paket" className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-card">
          <span><span className="block font-semibold">Paket & pembayaran</span><span className="block text-sm text-ink-soft">Paket aktif dan perpanjangan</span></span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        </section>
        <section aria-label="Preferensi" className="flex flex-col gap-3">
        <Link to="/app/pengaturan/tampilan" className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-card">
          <span><span className="block font-semibold">Tampilan</span><span className="block text-sm text-ink-soft">Ukuran teks</span></span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <Link to="/app/pengaturan/grup" className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-card">
          <span><span className="block font-semibold">Grup proyek</span><span className="block text-sm text-ink-soft">Pilih grup WhatsApp yang dibaca</span></span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <Link to="/app/pengaturan/kontak" className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-card">
          <span><span className="block font-semibold">Chat pribadi</span><span className="block text-sm text-ink-soft">Pilih kontak yang boleh dibaca</span></span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        </section>
      </div>
      <p className="mt-6 text-xs leading-relaxed text-ink-soft">Aksis membaca grup WhatsApp dan chat pribadi yang Anda pilih, dan tidak pernah mengirim pesan ke siapa pun. Untuk menyambung ulang WhatsApp, hubungi tim Aksis.</p>
      {session && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void session.logout().catch(() => setBusy(false))
          }}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-[0.9375rem] font-semibold shadow-card disabled:opacity-50"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" /> Keluar
        </button>
      )}
    </div>
  )
}
