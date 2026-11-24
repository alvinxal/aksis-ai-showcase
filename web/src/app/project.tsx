import { CalendarClock, CheckCircle2, ChevronLeft, FileText, MessageCircle, PencilLine, Plus, Search, Wallet, type LucideIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ItemType, ProjectItem, ProjectSummary } from '../api'
import { LoadFailed, Loading, MessageScreen } from '../onboarding/screens'
import { useProject, useProjects } from './data'

// The look follows the landing page: a warm paper background, hairlines instead of shadows, small capital labels, green icons,
// and the dark forest button. No cards: a list of rows with lines between them.

const rupiah = (amount: number) => `Rp ${new Intl.NumberFormat('id-ID').format(amount)}`
const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' })
const dayKey = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(value)
const dayNumber = (value: Date) => Math.floor(Date.parse(`${dayKey(value)}T00:00:00Z`) / 86_400_000)

const PAYMENT_LABEL: Partial<Record<ItemType, string>> = {
  PAYMENT_DUE: 'Tagihan',
  PAYMENT_RECEIVED: 'Diterima',
  INVOICE_SENT: 'Invoice',
  BUDGET_CHANGE: 'Anggaran',
}

/** Where a project is read from: its groups and the personal chats chosen for it. */
const sourcesOf = (project: { groups: string[]; contacts: string[] }) =>
  [...project.groups.map((group) => `Grup ${group}`), ...project.contacts.map((contact) => `Chat ${contact}`)].join(', ')

const clockFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' })

/** "hari ini 08.12", "kemarin 17.40" or a date, for when a note was written. */
export function writtenLabel(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const diff = dayNumber(now) - dayNumber(date)
  const time = clockFormat.format(date).replace(':', '.')
  if (diff === 0) return `hari ini ${time}`
  if (diff === 1) return `kemarin ${time}`
  return dateFormat.format(date)
}

/** A card header as in the reference: a bold title and a small line under it. */
const cardTitle = 'text-base font-semibold leading-snug'
const cardSub = 'mt-0.5 text-sm text-moss'

/** One quiet marker for a project that has things to do; nothing is shown when there are none. */
function Status({ attention }: { attention: number }) {
  return (
    <span className="flex items-center gap-2 text-[0.8125rem] font-medium text-amber-800">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-600" /> {attention} hal perlu dikerjakan
    </span>
  )
}

const COUNTS = [
  { key: 'decisions', name: 'Kesepakatan' },
  { key: 'revisions', name: 'Revisi' },
  { key: 'tasks', name: 'Tugas' },
  { key: 'payments', name: 'Anggaran' },
] as const

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link to={`/app/proyek/${project.id}`} className="block rounded-2xl bg-white px-5 py-4 shadow-card transition active:scale-[0.99]">
      <span className="flex items-center justify-between gap-3">
        <span className="block truncate text-base font-semibold leading-snug">{project.name}</span>
        {project.attention > 0 && (
          <span role="img" aria-label={`${project.attention} perlu dikerjakan`} className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-amber-600 px-1.5 text-xs font-semibold tabular-nums text-white">
            {project.attention}
          </span>
        )}
      </span>
      <span className="mt-0.5 block truncate text-sm text-moss">{sourcesOf(project)}</span>
      <span className="mt-4 grid grid-cols-4 border-t border-line pt-3">
        {COUNTS.map(({ key, name }) => (
          <span key={key} className="block border-l border-line px-1 text-center first:border-l-0">
            <span className="block text-xs text-moss">{name}</span>
            <span className={`mt-1.5 block text-base font-semibold leading-none tabular-nums ${project.counts[key] > 0 ? '' : 'text-ink-mute'}`}>{project.counts[key]}</span>
          </span>
        ))}
      </span>
    </Link>
  )
}

export function ProjectsTab() {
  const projects = useProjects()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const list = projects.state === 'ready' ? projects.data : []
  const searchProjects = (event: FormEvent) => {
    event.preventDefault()
    if (query.trim().length >= 2) navigate(`/app/cari?q=${encodeURIComponent(query.trim())}`)
  }
  return (
    <div className="min-h-full bg-brand-50 px-5 pb-8 pt-6 text-forest">
      <h1 className="text-[2rem] font-semibold leading-none tracking-tight">Proyek</h1>
      <form role="search" onSubmit={searchProjects} className="relative mt-5">
        <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" enterKeyHint="search" aria-label="Cari keputusan, tugas, tagihan" placeholder="Cari keputusan, tugas, tagihan…" className="w-full rounded-2xl bg-white py-3 pl-11 pr-4 text-[0.9375rem] shadow-card outline-none ring-brand-500 focus:ring-2" />
      </form>
      <nav aria-label="Alat proyek" className="mt-3 grid grid-cols-2 gap-3">
        <Link to="/app/agenda" className="flex items-center justify-center gap-2 rounded-xl bg-white px-3 py-3 text-sm font-semibold shadow-card"><CalendarClock className="h-5 w-5 text-leaf" /> Agenda</Link>
        <Link to="/app/laporan" className="flex items-center justify-center gap-2 rounded-xl bg-white px-3 py-3 text-sm font-semibold shadow-card"><FileText className="h-5 w-5 text-leaf" /> Laporan</Link>
      </nav>
      {projects.state === 'loading' && <div className="mt-8"><Loading /></div>}
      {projects.state === 'failed' && <div className="mt-8"><LoadFailed onRetry={projects.retry} /></div>}
      {projects.state === 'ready' && list.length === 0 && (
        <div className="mt-8">
          <MessageScreen title="Belum ada proyek" text="Proyek muncul dari grup WhatsApp yang dipilih saat onboarding. Setelah ada percakapan baru di grup itu, keputusan, tenggat, dan pembayaran akan terkumpul di sini." />
        </div>
      )}
      {projects.state === 'ready' && list.length > 0 && (
        <>
          <ul className="mt-5 flex flex-col gap-3">
            {list.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

const AMOUNT_TYPES: ItemType[] = ['PAYMENT_DUE', 'PAYMENT_RECEIVED', 'INVOICE_SENT', 'BUDGET_CHANGE']

/** One line per item: what it is and when; the amount, due date and conflict marker only when there is one. */
function Line({ entry }: { entry: ProjectItem }) {
  const meta = [
    entry.amount !== null ? rupiah(entry.amount) : null,
    entry.dueAt ? `tenggat ${dateFormat.format(new Date(entry.dueAt))}` : null,
    entry.type === 'DECISION_CONFLICT' ? 'keputusan berubah' : null,
    AMOUNT_TYPES.includes(entry.type) ? PAYMENT_LABEL[entry.type] ?? null : null,
  ].filter(Boolean)
  return (
    <li className="border-t border-line py-2.5 first:border-t-0">
      <p className="text-sm font-semibold leading-snug">{entry.title}</p>
      <p className="mt-0.5 text-xs text-ink-mute">{[dateFormat.format(new Date(entry.occurredAt)), ...meta].join(' · ')}</p>
    </li>
  )
}

const SECTION_ICON: Record<'decisions' | 'revisions' | 'tasks' | 'payments', LucideIcon> = {
  decisions: CheckCircle2,
  revisions: PencilLine,
  tasks: CalendarClock,
  payments: Wallet,
}

export function ProjectDetailScreen() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const project = useProject(id)
  const detail = project.state === 'ready' ? project.data : null
  const groups = detail
    ? [
        { title: 'Kesepakatan', items: detail.decisions, icon: SECTION_ICON.decisions },
        { title: 'Revisi', items: detail.revisions, icon: SECTION_ICON.revisions },
        { title: 'Tugas & tindak lanjut', items: detail.tasks, icon: SECTION_ICON.tasks },
        { title: 'Anggaran & tagihan', items: detail.payments, icon: SECTION_ICON.payments },
      ].filter((group) => group.items.length > 0)
    : []

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white text-forest">
      <header className="px-3 pt-2">
        <button type="button" aria-label="Kembali" onClick={() => navigate('/app/proyek')} className="grid h-10 w-10 place-items-center rounded-full text-moss">
          <ChevronLeft className="h-6 w-6" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {project.state === 'loading' && <Loading />}
        {project.state === 'failed' && <LoadFailed onRetry={project.retry} />}
        {project.state === 'missing' && <MessageScreen title="Proyek tidak ditemukan" text="Proyek ini tidak ada atau bukan milik akun Anda." />}
        {project.state === 'ready' && (
          <>
            <h1 className="text-[2rem] font-semibold leading-none tracking-tight">{project.data.name}</h1>
            <p className="mt-1.5 text-sm text-moss">{sourcesOf(project.data)}</p>

            <section className="mt-5 rounded-xl bg-white shadow-card p-4">
              <h2 className={cardTitle}>Ringkasan</h2>
              {project.data.note && <p className={cardSub}>Ditulis {writtenLabel(project.data.note.writtenAt)}</p>}
              <p className="mt-3 border-t border-line pt-3 text-sm leading-relaxed">
                {project.data.note ? project.data.note.text : groups.length > 0 ? 'Belum ada catatan ringkas.' : 'Belum ada yang tercatat.'}
              </p>
            </section>

            {project.data.attention.length > 0 && (
              <section className="mt-3 rounded-xl bg-white shadow-card p-4">
                <h2 className={cardTitle}>Yang perlu dikerjakan</h2>
                <p className={cardSub}>{project.data.attention.length} hal</p>
                <ul className="mt-3 border-t border-line">
                  {project.data.attention.map((entry) => (
                    <Line key={entry.id} entry={entry} />
                  ))}
                </ul>
              </section>
            )}

            {groups.length > 0 && (
              <ul className="mt-3 flex flex-col gap-3">
                {groups.map((group) => (
                  <li key={group.title} className="rounded-xl bg-white px-4 shadow-card">
                    <details className="group">
                      <summary className={`flex cursor-pointer list-none items-center justify-between gap-4 py-3 [&::-webkit-details-marker]:hidden ${cardTitle}`}>
                        <span className="flex items-center gap-3">
                          <group.icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-leaf" />
                          {group.title}
                        </span>
                        <span className="flex items-center gap-3 text-sm font-normal tabular-nums text-moss">
                          {group.items.length}
                          <Plus aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-45" />
                        </span>
                      </summary>
                      <ul className="mb-2 border-t border-line">
                        {group.items.map((entry) => (
                          <Line key={entry.id} entry={entry} />
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            )}

            <Link to={`/app/chat/aksis?proyek=${project.data.id}`} className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-forest py-3 text-sm font-semibold text-white transition hover:bg-black">
              <MessageCircle aria-hidden="true" className="h-4 w-4" /> Tanya Aksis tentang proyek ini
            </Link>
            <p className="mt-4 text-center text-xs leading-relaxed text-moss">Aksis hanya membaca dan tidak mengirim pesan. Angka diambil apa adanya dari chat.</p>
          </>
        )}
      </div>
    </div>
  )
}
