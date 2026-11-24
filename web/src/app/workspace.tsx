import { CalendarDays, Check, ChevronLeft, Clipboard, Download, Link2Off, RefreshCw, Search, Wallet } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, workspaceApi, type AgendaItem, type BillingOverview, type ConnectionOverview, type ReminderPreferences, type SearchItem, type WeeklyReport } from '../api'
import { copyText } from '../clipboard'
import { LoadFailed, Loading, MessageScreen } from '../onboarding/screens'
import { SAMPLE_DATA } from './data'

type Loaded<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T }

function useLoaded<T>(load: () => Promise<T>, key = ''): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0)
  const [value, setValue] = useState<Loaded<T>>({ state: 'loading' })
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  useEffect(() => {
    let live = true
    setValue({ state: 'loading' })
    load()
      .then((data) => live && setValue({ state: 'ready', data }))
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
        if (live) setValue({ state: 'failed' })
      })
    return () => { live = false }
    // The caller supplies a stable key for meaningful changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  return [value, retry]
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="mx-auto min-h-dvh max-w-md bg-surface text-forest">
      <header className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button type="button" aria-label="Kembali" onClick={() => navigate(-1)} className="grid h-10 w-10 place-items-center rounded-full"><ChevronLeft className="h-6 w-6" /></button>
        <h1 className="text-xl font-semibold">{title}</h1>
      </header>
      <main className="px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</main>
    </div>
  )
}

const when = (iso: string | null) => iso ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso)) : 'Belum ada'
const day = (iso: string) => new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso))
const idr = (amount: number) => `Rp ${new Intl.NumberFormat('id-ID').format(amount)}`

const CONNECTION: Record<string, string> = { connected: 'Terhubung', connecting: 'Menghubungkan', qr_ready: 'Menunggu penautan', logged_out: 'Perlu ditautkan ulang', error: 'Bermasalah', disabled: 'Tidak aktif' }
const sampleConnection: ConnectionOverview = { enabled: true, connection: 'connected', lastMessageAt: new Date().toISOString(), lastError: null }
const sampleBilling: BillingOverview = {
  subscription: { planCode: 'basic', planName: 'Basic', groupLimit: 3, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), status: 'active' },
  plans: [{ code: 'basic', name: 'Basic', groupLimit: 3, priceIdr: 0 }, { code: 'pro', name: 'Pro', groupLimit: 5, priceIdr: 0 }],
  latestRequest: null,
}
const sampleAgenda: AgendaItem[] = [
  { id: 'a1', projectId: 'p1', project: 'Rumah Budi', type: 'DEADLINE_DETECTED', title: 'Kirim gambar kerja tahap 2', dueAt: new Date(Date.now() + 86_400_000).toISOString(), amount: null, status: 'open', snoozedUntil: null },
  { id: 'a2', projectId: 'p1', project: 'Rumah Budi', type: 'PAYMENT_DUE', title: 'Termin 2 jatuh tempo', dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), amount: 30_000_000, status: 'open', snoozedUntil: null },
]

export function ConnectionScreen() {
  const [data, retry] = useLoaded<ConnectionOverview>(() => SAMPLE_DATA ? Promise.resolve(sampleConnection) : workspaceApi.connection())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const run = async (kind: 'reconnect' | 'disconnect') => {
    if (kind === 'disconnect' && !window.confirm('Putuskan koneksi WhatsApp? Aksis berhenti membaca pesan sampai disambungkan lagi.')) return
    setBusy(true); setNotice(null)
    try {
      await workspaceApi[kind]()
      setNotice(kind === 'reconnect' ? 'WhatsApp sedang disambungkan.' : 'Koneksi WhatsApp diputuskan.')
      retry()
    } catch { setNotice('Belum berhasil. Coba lagi sebentar lagi.') }
    finally { setBusy(false) }
  }
  return <Frame title="Koneksi WhatsApp">
    {data.state === 'loading' && <Loading />}
    {data.state === 'failed' && <LoadFailed onRetry={retry} />}
    {data.state === 'ready' && <>
      <section className="card mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Status</p>
        <p className={`mt-1 text-xl font-semibold ${data.data.connection === 'connected' ? 'text-brand-700' : 'text-amber-800'}`}>{CONNECTION[data.data.connection] ?? data.data.connection}</p>
        <p className="mt-3 text-sm text-ink-soft">Pesan terakhir diterima</p><p className="font-medium">{when(data.data.lastMessageAt)}</p>
        {data.data.lastError && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{data.data.lastError}</p>}
      </section>
      {notice && <p role="status" className="mt-3 text-sm text-ink-soft">{notice}</p>}
      <button type="button" disabled={busy} onClick={() => void run('reconnect')} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest px-4 py-3 font-semibold text-white disabled:opacity-50"><RefreshCw className="h-4 w-4" /> Sambungkan ulang</button>
      <button type="button" disabled={busy || !data.data.enabled} onClick={() => void run('disconnect')} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 font-semibold text-red-700 shadow-card disabled:opacity-40"><Link2Off className="h-4 w-4" /> Putuskan koneksi</button>
      <p className="mt-4 text-xs leading-relaxed text-ink-soft">Menyambungkan ulang memakai sesi perangkat tertaut yang tersimpan. Jika WhatsApp sudah mengeluarkan perangkat, tim Aksis perlu membantu penautan dengan kode baru.</p>
    </>}
  </Frame>
}

const REQUEST_STATUS: Record<string, string> = { pending: 'Menunggu verifikasi', confirmed: 'Terkonfirmasi', rejected: 'Ditolak' }
export function BillingScreen() {
  const [data, retry] = useLoaded<BillingOverview>(() => SAMPLE_DATA ? Promise.resolve(sampleBilling) : workspaceApi.billing())
  const [plan, setPlan] = useState('')
  const [months, setMonths] = useState(1)
  const [busy, setBusy] = useState(false)
  const request = async () => {
    if (!plan) return
    setBusy(true)
    try { await workspaceApi.requestPayment(plan, months); retry() }
    finally { setBusy(false) }
  }
  return <Frame title="Paket & pembayaran">
    {data.state === 'loading' && <Loading />}
    {data.state === 'failed' && <LoadFailed onRetry={retry} />}
    {data.state === 'ready' && <>
      <section className="card mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Paket aktif</p>
        <p className="mt-1 text-xl font-semibold">{data.data.subscription?.planName ?? 'Belum ada paket'}</p>
        {data.data.subscription && <p className="mt-1 text-sm text-ink-soft">Maksimal {data.data.subscription.groupLimit} grup · berakhir {day(data.data.subscription.endsAt)}</p>}
      </section>
      {data.data.latestRequest?.status === 'pending' ? <section className="mt-3 rounded-xl bg-amber-50 p-4 text-amber-900">
        <p className="font-semibold">Menunggu verifikasi pembayaran</p>
        <p className="mt-1 text-sm">{data.data.latestRequest.planCode.toUpperCase()} · {data.data.latestRequest.months} bulan · {idr(data.data.latestRequest.amountIdr)}</p>
        <p className="mt-1 text-xs">{REQUEST_STATUS[data.data.latestRequest.status]}</p>
      </section> : <section className="card mt-3">
        <label className="block text-sm font-semibold">Pilih paket
          <select value={plan} onChange={(event) => setPlan(event.target.value)} className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-3">
            <option value="">Pilih paket</option>
            {data.data.plans.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.groupLimit} grup · {item.priceIdr > 0 ? `${idr(item.priceIdr)}/bulan` : 'harga dikonfirmasi admin'}</option>)}
          </select>
        </label>
        <label className="mt-4 block text-sm font-semibold">Durasi
          <select value={months} onChange={(event) => setMonths(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-3"><option value={1}>1 bulan</option><option value={3}>3 bulan</option><option value={12}>12 bulan</option></select>
        </label>
        <button type="button" disabled={busy || !plan} onClick={() => void request()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-forest py-3 font-semibold text-white disabled:opacity-40"><Wallet className="h-4 w-4" /> Ajukan perpanjangan</button>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">Setelah diajukan, tim Aksis akan mengirim instruksi transfer dan memverifikasi pembayaran melalui WhatsApp.</p>
      </section>}
    </>}
  </Frame>
}

function ics(items: AgendaItem[]): string {
  const escape = (text: string) => text.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
  const date = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aksis AI//Agenda//ID', ...items.filter((item) => item.status !== 'done').flatMap((item) => ['BEGIN:VEVENT', `UID:${item.id}@aksis.flaat.studio`, `DTSTAMP:${date(new Date().toISOString())}`, `DTSTART:${date(item.dueAt)}`, `SUMMARY:${escape(item.title)}`, `DESCRIPTION:${escape(item.project)}`, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n')
}

export function AgendaScreen() {
  const [data, retry] = useLoaded<AgendaItem[]>(() => SAMPLE_DATA ? Promise.resolve(sampleAgenda) : workspaceApi.agenda())
  const [filter, setFilter] = useState<'open' | 'done'>('open')
  const update = async (item: AgendaItem, status: AgendaItem['status'], snoozedUntil: string | null = null) => { await workspaceApi.setAction(item.id, status, snoozedUntil); retry() }
  const download = () => {
    if (data.state !== 'ready') return
    const url = URL.createObjectURL(new Blob([ics(data.data)], { type: 'text/calendar;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'agenda-aksis.ics'; link.click(); URL.revokeObjectURL(url)
  }
  const shown = data.state === 'ready' ? data.data.filter((item) => filter === 'done' ? item.status === 'done' : item.status !== 'done') : []
  return <Frame title="Agenda">
    <div className="mt-3 flex items-center gap-2"><button type="button" onClick={() => setFilter('open')} className={`chip ${filter === 'open' ? 'bg-brand-50 text-brand-700' : ''}`}>Aktif</button><button type="button" onClick={() => setFilter('done')} className={`chip ${filter === 'done' ? 'bg-brand-50 text-brand-700' : ''}`}>Selesai</button><button type="button" onClick={download} className="ml-auto grid h-9 w-9 place-items-center rounded-full bg-white shadow-card" aria-label="Unduh kalender"><Download className="h-4 w-4" /></button></div>
    {data.state === 'loading' && <Loading />}{data.state === 'failed' && <LoadFailed onRetry={retry} />}
    {data.state === 'ready' && shown.length === 0 && <MessageScreen title="Tidak ada agenda" text={filter === 'done' ? 'Belum ada pekerjaan yang ditandai selesai.' : 'Tidak ada tenggat yang perlu ditampilkan.'} />}
    <ul className="mt-4 flex flex-col gap-3 pb-2">{shown.map((item) => <li key={item.id} className="card">
      <Link to={`/app/proyek/${item.projectId}`} className="block"><p className="text-xs font-semibold uppercase tracking-wide text-moss">{item.project}</p><p className={`mt-1 font-semibold ${item.status === 'done' ? 'line-through text-ink-mute' : ''}`}>{item.title}</p><p className="mt-1 text-sm text-ink-soft">{day(item.dueAt)}{item.amount !== null ? ` · ${idr(item.amount)}` : ''}{item.snoozedUntil ? ` · ditunda sampai ${item.snoozedUntil}` : ''}</p></Link>
      <div className="mt-3 flex items-end gap-2">{item.status === 'done' ? <button type="button" onClick={() => void update(item, 'open')} className="chip">Buka lagi</button> : <><button type="button" onClick={() => void update(item, 'done')} className="chip bg-brand-50 text-brand-700"><Check className="h-3.5 w-3.5" /> Selesai</button><label className="text-xs text-ink-soft">Tunda<input type="date" aria-label={`Tunda ${item.title}`} onChange={(event) => event.target.value && void update(item, 'snoozed', event.target.value)} className="ml-1 rounded-lg border border-line px-2 py-1.5" /></label></>}</div>
    </li>)}</ul>
  </Frame>
}

export function SearchScreen() {
  const [params] = useSearchParams()
  const initial = params.get('q')?.slice(0, 100) ?? ''
  const [query, setQuery] = useState(initial)
  const [results, setResults] = useState<SearchItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (text: string) => { if (text.trim().length < 2) return; setBusy(true); try { setResults(await workspaceApi.search(text)) } finally { setBusy(false) } }
  const submit = (event: FormEvent) => { event.preventDefault(); void run(query) }
  useEffect(() => { if (initial) void run(initial) }, [initial]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Frame title="Cari proyek"><form role="search" onSubmit={submit} className="relative mt-2"><Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" /><input autoFocus={!initial} value={query} onChange={(event) => setQuery(event.target.value)} type="search" enterKeyHint="search" aria-label="Cari" placeholder="Keputusan, tugas, tagihan…" className="w-full rounded-2xl bg-white py-3 pl-11 pr-4 shadow-card outline-none ring-brand-500 focus:ring-2" /></form>
    {busy && <Loading />}{results?.length === 0 && <MessageScreen title="Tidak ditemukan" text="Coba kata lain atau nama proyek." />}
    <ul className="mt-4 divide-y divide-line rounded-xl bg-white px-4 shadow-card">{results?.map((item) => <li key={item.id}><Link to={`/app/proyek/${item.projectId}`} className="block py-3"><p className="text-xs font-semibold uppercase tracking-wide text-moss">{item.project}</p><p className="mt-0.5 font-medium">{item.title}</p><p className="mt-1 text-xs text-ink-mute">{day(item.occurredAt)}{item.amount !== null ? ` · ${idr(item.amount)}` : ''}</p></Link></li>)}</ul>
  </Frame>
}

/** How many days before a deadline the morning reminder starts. Lives in Pengaturan; the agenda only lists work. */
export function ReminderSetting() {
  const [preferences] = useLoaded<ReminderPreferences>(() => SAMPLE_DATA ? Promise.resolve({ reminderLeadDays: 1, weeklyReportEnabled: true }) : workspaceApi.preferences())
  const [chosen, setChosen] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  if (preferences.state !== 'ready') return null
  const lead = chosen ?? preferences.data.reminderLeadDays
  const change = (value: number) => {
    setChosen(value); setFailed(false)
    if (SAMPLE_DATA) return
    void workspaceApi.setPreferences(value, preferences.data.weeklyReportEnabled).catch(() => { setChosen(null); setFailed(true) })
  }
  return <div className="rounded-xl bg-white p-4 shadow-card">
    <label className="flex items-center justify-between gap-3"><span><span className="block font-semibold">Pengingat pagi</span><span className="block text-sm text-ink-soft">Kabari sebelum tenggat</span></span>
      <select value={lead} onChange={(event) => change(Number(event.target.value))} className="shrink-0 rounded-lg border border-line bg-white px-3 py-2 text-sm"><option value={0}>Hari H</option><option value={1}>H-1</option><option value={3}>H-3</option><option value={7}>H-7</option></select>
    </label>
    {failed && <p role="alert" className="mt-2 text-sm text-amber-900">Belum tersimpan. Coba lagi.</p>}
  </div>
}

const reportText = (report: WeeklyReport) => ['Laporan mingguan Aksis', `${report.from} sampai ${report.to}`, ...report.projects.flatMap((project) => [`\n${project.name}`, ...([['Keputusan', project.decisions], ['Revisi', project.revisions], ['Tugas', project.tasks], ['Pembayaran', project.payments]] as Array<[string, string[]]>).filter(([, rows]) => rows.length).flatMap(([title, rows]) => [`${title}:`, ...rows.map((row) => `• ${row}`)])])].join('\n')
export function ReportScreen() {
  const [data, retry] = useLoaded<WeeklyReport>(() => SAMPLE_DATA ? Promise.resolve({ from: '2026-11-02', to: '2026-11-08', projects: [{ id: 'p1', name: 'Rumah Budi', decisions: ['Material lantai disetujui'], revisions: ['Geser kamar mandi lantai 2'], tasks: ['Kirim gambar kerja tahap 2'], payments: ['Termin 2 jatuh tempo'] }] }) : workspaceApi.report())
  const [copied, setCopied] = useState(false)
  return <Frame title="Laporan mingguan">{data.state === 'loading' && <Loading />}{data.state === 'failed' && <LoadFailed onRetry={retry} />}{data.state === 'ready' && <>
    <div className="mt-2 flex items-center justify-between"><p className="text-sm text-ink-soft">{data.data.from} sampai {data.data.to}</p><button type="button" onClick={() => void copyText(reportText(data.data)).then((ok) => setCopied(ok))} className="chip"><Clipboard className="h-3.5 w-3.5" /> {copied ? 'Tersalin' : 'Salin'}</button></div>
    {data.data.projects.length === 0 && <MessageScreen title="Belum ada aktivitas" text="Laporan akan terisi setelah ada keputusan, revisi, tugas, atau pembayaran minggu ini." />}
    <ul className="mt-4 flex flex-col gap-3">{data.data.projects.map((project) => <li key={project.id} className="card"><Link to={`/app/proyek/${project.id}`} className="font-semibold">{project.name}</Link>{([['Kesepakatan', project.decisions], ['Revisi', project.revisions], ['Tugas', project.tasks], ['Pembayaran', project.payments]] as Array<[string, string[]]>).filter(([, rows]) => rows.length).map(([title, rows]) => <section key={title} className="mt-3"><h2 className="text-xs font-semibold uppercase tracking-wide text-moss">{title}</h2><ul className="mt-1 list-disc pl-5 text-sm">{rows.map((row) => <li key={row}>{row}</li>)}</ul></section>)}</li>)}</ul>
  </>}</Frame>
}
