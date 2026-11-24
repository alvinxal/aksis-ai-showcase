import { ChevronLeft, ChevronRight, FileClock, Inbox, ShieldCheck, LogOut, RefreshCw, Type } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ApiError, dashboardApi, type DashAdmin, type DashAudit, type DashCustomer, type DashFeature, type DashInvite } from '../api'
import { button, card, InviteResult } from './ui'
import { CustomerActions, NewCustomer } from './customer-actions'
import { TEXT_SIZES, readTextSize, saveTextSize, type TextSize } from '../app/textsize'
import { CONNECTION, REQUEST_STATUS, SUBSCRIPTION_STATUS, TENANT_STATUS, day, idr, shortDay, uptime, usd, when } from './format'
import { useData, type Loaded } from './useData'
import { SignedOut, useSignOut } from './Layout'

const th = 'whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-soft'
const td = 'px-3 py-2.5 align-top text-sm'

function Page({ title, note, onReload, back, children }: { title: string; note?: string; onReload?: () => void; back?: string; children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      {back && (
        <button type="button" onClick={() => navigate(back)} className="-mb-2 inline-flex items-center gap-1 self-start text-sm font-medium text-ink-soft">
          <ChevronLeft aria-hidden="true" className="h-5 w-5" /> Kembali
        </button>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[2rem] font-semibold leading-none tracking-tight">{title}</h1>
          {note && <p className="mt-2 text-sm text-ink-soft">{note}</p>}
        </div>
        {onReload && (
          <button type="button" onClick={onReload} aria-label="Perbarui" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3 py-2 text-sm font-medium shadow-card">
            <RefreshCw aria-hidden="true" className="h-4 w-4" /> <span className="hidden sm:inline">Perbarui</span>
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Await<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.status === 'loading') return <p className="text-ink-soft">Memuat…</p>
  if (state.status === 'expired') return <SignedOut />
  if (state.status === 'failed') return <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Data belum bisa dimuat. Coba perbarui sebentar lagi.</p>
  return <>{children(state.data)}</>
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className={card}>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${tone === 'warn' ? 'text-amber-700' : ''}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>}
    </div>
  )
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const colors = { neutral: 'bg-surface text-ink-soft', good: 'bg-brand-50 text-brand-700', warn: 'bg-amber-50 text-amber-800', bad: 'bg-red-50 text-red-700' }
  return <span className={`inline-block max-w-full truncate rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[tone]}`}>{children}</span>
}

const connectionTone = (connection: string | null) => (connection === 'connected' ? 'good' : connection === null ? 'neutral' : 'bad')
const subscriptionTone = (state: string) => (state === 'active' || state === 'trial' ? 'good' : state === 'grace' ? 'warn' : state === 'expired' ? 'bad' : 'neutral')

const ATTENTION: Record<string, string> = { plan: 'Menunggu paket', whatsapp: 'WhatsApp', stuck: 'Onboarding macet', billing: 'Langganan', failed: 'Run gagal', paused: 'Dijeda' }

export function Overview() {
  const { state, reload } = useData(() => dashboardApi.overview(), [], 60_000)
  return (
    <Page title="Ringkasan" note="Diperbarui otomatis tiap menit." onReload={reload}>
      <Await state={state}>
        {(data) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Pelanggan aktif" value={String(data.customers.active ?? 0)} hint={`${data.customers.invited ?? 0} diundang · ${data.customers.onboarding ?? 0} onboarding`} />
              <Stat label="Permintaan akses" value={String(data.newRequests)} hint="menunggu dihubungi" tone={data.newRequests > 0 ? 'warn' : undefined} />
              <Stat label="Biaya AI hari ini" value={usd(data.costUsd.today)} />
              <Stat label="Biaya AI bulan ini" value={usd(data.costUsd.month)} />
              <Stat label="Langganan berbayar" value={idr(data.monthlyRecurringIdr)} hint="per bulan, perkiraan" />
            </div>
            <section className={card}>
              <h2 className="font-semibold">Perlu perhatian</h2>
              {data.attention.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">Tidak ada. Semua tampak baik.</p>
              ) : (
                <ul className="mt-2 divide-y divide-surface">
                  {data.attention.map((item, index) => (
                    <li key={`${item.tenantId}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                      <Pill tone="warn">{ATTENTION[item.kind] ?? item.kind}</Pill>
                      <span className="font-medium">{item.name}</span>
                      <span className="text-ink-soft">{item.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={card}>
              <h2 className="font-semibold">Run gagal (48 jam)</h2>
              {data.failedRuns.length === 0 && data.blocked.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">Tidak ada.</p>
              ) : (
                <>
                  <ul className="mt-2 divide-y divide-surface">
                    {data.failedRuns.map((run, index) => (
                      <li key={index} className="flex flex-wrap gap-x-3 py-2 text-sm">
                        <span className="text-ink-soft">{when(run.at)}</span>
                        <span className="font-medium">{run.customer}</span>
                        <span className="text-ink-soft">{run.error}</span>
                      </li>
                    ))}
                  </ul>
                  {data.blocked.length > 0 && (
                    <p className="mt-2 text-sm text-ink-soft">
                      Pesan yang kehabisan percobaan: {data.blocked.map((row) => `${row.tenantName} (${row.messages})`).join(', ')}.
                    </p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </Await>
    </Page>
  )
}

function limitNote(row: DashCustomer): string {
  const parts: string[] = []
  if (row.limitUsd.daily !== null) parts.push(`batas harian ${usd(row.limitUsd.daily)}`)
  if (row.limitUsd.monthly !== null) parts.push(`bulanan ${usd(row.limitUsd.monthly)}`)
  return parts.join(' · ')
}

function Notes({ row, autoDelete }: { row: DashCustomer; autoDelete: boolean }) {
  return (
    <>
      {row.paused && <Pill tone="bad">Dijeda batas biaya</Pill>}
      {!row.acceptedTerms && <Pill tone="warn">Belum setuju syarat</Pill>}
      {row.deletionOn && (
        <Pill tone="bad">
          {autoDelete
            ? new Date(row.deletionOn) > new Date() ? `Dihapus otomatis ${day(row.deletionOn)}` : 'Dihapus otomatis segera'
            : `Lewat batas simpan ${day(row.deletionOn)}`}
        </Pill>
      )}
    </>
  )
}

export function Customers() {
  const { state, reload } = useData(() => dashboardApi.customers(), [], 60_000)
  return (
    <Page title="Pelanggan" note="Nama dan angka saja. Isi pesan, nama grup, dan nama kontak tidak ditampilkan." onReload={reload}>
      <NewCustomer reload={reload} />
      <Await state={state}>
        {({ customers: rows, autoDelete }) => (
          <>
            <ul className="flex flex-col gap-3 lg:hidden">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/dashboard/pelanggan/${row.id}`} className={`${card} block`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{row.name}</p>
                        <p className="text-xs text-ink-soft">{row.plan ? `${row.plan} · sampai ${day(row.endsAt)}` : 'Belum ada paket'}</p>
                      </div>
                      <ChevronRight aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-ink-mute" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <Pill tone={row.status === 'active' ? 'good' : row.status === 'disabled' ? 'bad' : 'neutral'}>{TENANT_STATUS[row.status] ?? row.status}</Pill>
                      <Pill tone={subscriptionTone(row.subscription)}>{SUBSCRIPTION_STATUS[row.subscription] ?? row.subscription}</Pill>
                      {row.whatsapp && <Pill tone={connectionTone(row.whatsapp)}>{CONNECTION[row.whatsapp] ?? row.whatsapp}</Pill>}
                      <Notes row={row} autoDelete={autoDelete} />
                    </div>
                    <p className="mt-3 text-sm text-ink-soft">{usd(row.costUsd.month)} bulan ini · {row.groups} grup · {row.contacts} kontak</p>
                  </Link>
                </li>
              ))}
            </ul>
            <div className={`${card} hidden overflow-x-auto p-0 sm:p-0 lg:block`}>
              <table className="min-w-full">
                <thead className="border-b border-surface">
                  <tr>
                    <th className={th}>Pelanggan</th>
                    <th className={th}>Status</th>
                    <th className={th}>Langganan</th>
                    <th className={th}>WhatsApp</th>
                    <th className={th}>Grup / kontak</th>
                    <th className={th}>Pesan</th>
                    <th className={th}>Biaya AI</th>
                    <th className={th}>Catatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className={td}>
                        <Link to={`/dashboard/pelanggan/${row.id}`} className="font-medium underline-offset-4 hover:underline">{row.name}</Link>
                        <p className="text-xs text-ink-soft">Sejak {day(row.createdAt)}</p>
                      </td>
                      <td className={td}><Pill tone={row.status === 'active' ? 'good' : row.status === 'disabled' ? 'bad' : 'neutral'}>{TENANT_STATUS[row.status] ?? row.status}</Pill></td>
                      <td className={td}>
                        <Pill tone={subscriptionTone(row.subscription)}>{SUBSCRIPTION_STATUS[row.subscription] ?? row.subscription}</Pill>
                        <p className="mt-1 text-xs text-ink-soft">{row.plan ? `${row.plan} · sampai ${day(row.endsAt)}` : 'Belum ada paket'}</p>
                      </td>
                      <td className={td}>{row.whatsapp ? <Pill tone={connectionTone(row.whatsapp)}>{CONNECTION[row.whatsapp] ?? row.whatsapp}</Pill> : <span className="text-ink-soft">-</span>}</td>
                      <td className={td}>{row.groups} / {row.contacts}</td>
                      <td className={td}>{row.messages.toLocaleString('id-ID')}</td>
                      <td className={td}>
                        <p>{usd(row.costUsd.today)} hari ini</p>
                        <p className="text-xs text-ink-soft">{usd(row.costUsd.month)} bulan ini</p>
                        <p className="text-xs text-ink-soft">{limitNote(row)}</p>
                      </td>
                      <td className={td}><div className="flex flex-col items-start gap-1"><Notes row={row} autoDelete={autoDelete} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Await>
    </Page>
  )
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-surface">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-4 py-2.5 text-sm">
          <dt className="text-ink-soft">{label}</dt>
          <dd className="text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CustomerDetail() {
  const { id = '' } = useParams()
  const { state, reload } = useData(() => dashboardApi.customers(), [], 60_000)
  return (
    <Await state={state}>
      {({ customers: rows, autoDelete, ...choices }) => {
        const row = rows.find((item) => item.id === id)
        if (!row) return <Navigate to="/dashboard/pelanggan" replace />
        return (
          <Page title={row.name} note={`Pelanggan sejak ${day(row.createdAt)}`} onReload={reload} back="/dashboard/pelanggan">
            <div className="flex flex-wrap gap-1.5">
              <Pill tone={row.status === 'active' ? 'good' : row.status === 'disabled' ? 'bad' : 'neutral'}>{TENANT_STATUS[row.status] ?? row.status}</Pill>
              <Notes row={row} autoDelete={autoDelete} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <section className={card}>
                <h2 className="font-semibold">Langganan</h2>
                <Rows rows={[
                  ['Paket', row.plan ?? 'Belum ada'],
                  ['Status', <Pill key="s" tone={subscriptionTone(row.subscription)}>{SUBSCRIPTION_STATUS[row.subscription] ?? row.subscription}</Pill>],
                  ['Berakhir', day(row.endsAt)],
                  ['Setuju syarat', row.acceptedTerms ? 'Ya' : 'Belum'],
                  ['Batas simpan data', row.deletionOn ? `${day(row.deletionOn)} (${autoDelete ? 'hapus otomatis' : 'dihapus manual'})` : '-'],
                ]} />
              </section>
              <section className={card}>
                <h2 className="font-semibold">Pemakaian</h2>
                <Rows rows={[
                  ['WhatsApp', row.whatsapp ? <Pill key="w" tone={connectionTone(row.whatsapp)}>{CONNECTION[row.whatsapp] ?? row.whatsapp}</Pill> : '-'],
                  ['Grup dibaca', String(row.groups)],
                  ['Kontak dibaca', String(row.contacts)],
                  ['Pesan tersimpan', row.messages.toLocaleString('id-ID')],
                  ['Biaya hari ini', usd(row.costUsd.today)],
                  ['Biaya bulan ini', usd(row.costUsd.month)],
                  ['Batas biaya', limitNote(row) || 'Tidak ada'],
                  ['Dijeda batas biaya', row.paused ? 'Ya' : 'Tidak'],
                ]} />
              </section>
            </div>
            <CustomerActions key={`${row.id}:${row.name}:${row.notes ?? ""}:${row.planCode}:${row.endsAt}`} row={row} choices={choices} reload={reload} />
          </Page>
        )
      }}
    </Await>
  )
}

const RANGES = [7, 14, 30, 90]

export function Costs() {
  const [days, setDays] = useState(14)
  const { state, reload } = useData(() => dashboardApi.usage(days), [days], 120_000)
  return (
    <Page title="Biaya AI" note="Perkiraan dari jumlah token. Hari mengikuti WIB." onReload={reload}>
      <div role="group" aria-label="Rentang" className="flex gap-2">
        {RANGES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            onClick={() => setDays(value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${days === value ? 'bg-ink text-white' : 'bg-white text-ink-soft shadow-card'}`}
          >
            {value} hari
          </button>
        ))}
      </div>
      <Await state={state}>
        {(data) => {
          const peak = Math.max(0.0001, ...data.series.map((row) => row.costUsd))
          const total = data.series.reduce((sum, row) => sum + row.costUsd, 0)
          return (
            <>
              <section className={card}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold">Biaya per hari</h2>
                  <p className="text-sm text-ink-soft">Total {usd(total)} · {data.series.reduce((sum, row) => sum + row.runs, 0)} run · {data.series.reduce((sum, row) => sum + row.failed, 0)} gagal</p>
                </div>
                <ul aria-label="Biaya per hari" className="mt-4 flex h-40 items-end gap-1">
                  {data.series.map((row) => (
                    <li key={row.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${shortDay(row.day)}: ${usd(row.costUsd)}, ${row.runs} run, ${row.failed} gagal`}>
                      <span className="block w-full rounded-t bg-brand-500" style={{ height: `${Math.max(2, (row.costUsd / peak) * 100)}%` }} />
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex justify-between text-xs text-ink-soft">
                  <span>{shortDay(data.series[0]?.day ?? '')}</span>
                  <span>puncak {usd(peak)}</span>
                  <span>{shortDay(data.series[data.series.length - 1]?.day ?? '')}</span>
                </div>
              </section>
              <div className="grid gap-4 lg:grid-cols-2">
                <section className={card}>
                  <h2 className="font-semibold">Per jenis pekerjaan</h2>
                  <table className="mt-2 w-full">
                    <tbody className="divide-y divide-surface">
                      {data.byKind.length === 0 && <tr><td className={td}>Belum ada.</td></tr>}
                      {data.byKind.map((row) => (
                        <tr key={row.kind}><td className={td}>{row.kind}</td><td className={`${td} text-right`}>{row.runs} run</td><td className={`${td} text-right font-medium`}>{usd(row.costUsd)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section className={card}>
                  <h2 className="font-semibold">Per pelanggan</h2>
                  <table className="mt-2 w-full">
                    <tbody className="divide-y divide-surface">
                      {data.byCustomer.map((row) => (
                        <tr key={row.customer}><td className={td}>{row.customer}</td><td className={`${td} text-right`}>{row.runs} run</td><td className={`${td} text-right font-medium`}>{usd(row.costUsd)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </div>
            </>
          )
        }}
      </Await>
    </Page>
  )
}


function RequestActions({ row, busy, confirming, onInvite, onContacted, onReject, onAskReject }: {
  row: { id: string; status: string }
  busy: boolean
  confirming: boolean
  onInvite: () => void
  onContacted: () => void
  onReject: () => void
  onAskReject: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={onInvite} className={`${button} bg-brand-500 text-white`}>Buat undangan</button>
      {row.status === 'new' && <button type="button" disabled={busy} onClick={onContacted} className={`${button} bg-surface`}>Sudah dihubungi</button>}
      {confirming ? (
        <button type="button" disabled={busy} onClick={onReject} className={`${button} bg-red-700 text-white`}>Yakin tolak?</button>
      ) : (
        <button type="button" disabled={busy} onClick={onAskReject} className={`${button} bg-surface text-red-700`}>Tolak</button>
      )}
    </div>
  )
}

export function Requests() {
  const { state, reload } = useData(() => dashboardApi.requests(), [], 60_000)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [invite, setInvite] = useState<DashInvite | null>(null)
  const [error, setError] = useState(false)

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError(false)
    try {
      await task()
    } catch {
      setError(true)
    } finally {
      setConfirming(null)
      setBusy(false)
      reload()
    }
  }
  const actions = (row: { id: string; status: string }) => (
    <RequestActions
      row={row}
      busy={busy}
      confirming={confirming === row.id}
      onInvite={() => void run(async () => setInvite(await dashboardApi.invite(row.id)))}
      onContacted={() => void run(async () => void (await dashboardApi.markContacted(row.id)))}
      onReject={() => void run(async () => void (await dashboardApi.reject(row.id)))}
      onAskReject={() => setConfirming(row.id)}
    />
  )

  return (
    <Page title="Permintaan akses" note="Dari formulir di beranda. Undangan berlaku 48 jam dan sekali pakai." onReload={reload}>
      {invite && <InviteResult invite={invite} onClose={() => setInvite(null)} />}
      {error && <p className={`${card} text-sm text-red-700`}>Aksi gagal atau permintaan sudah diproses. Daftar dimuat ulang.</p>}
      <Await state={state}>
        {(rows) =>
          rows.length === 0 ? (
            <p className={`${card} text-sm text-ink-soft`}>Tidak ada permintaan yang menunggu.</p>
          ) : (
            <>
            <ul className="flex flex-col gap-3 lg:hidden">
              {rows.map((row) => (
                <li key={row.id} className={card}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">{row.name}</p>
                    <Pill tone={row.status === 'new' ? 'warn' : 'neutral'}>{REQUEST_STATUS[row.status] ?? row.status}</Pill>
                  </div>
                  <a href={`https://wa.me/${row.phone}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm underline underline-offset-4">+{row.phone}</a>
                  <p className="mt-1 text-xs text-ink-soft">Masuk {when(row.createdAt)}</p>
                  <div className="mt-3">{actions(row)}</div>
                </li>
              ))}
            </ul>
            <div className={`${card} hidden overflow-x-auto p-0 sm:p-0 lg:block`}>
              <table className="min-w-full">
                <thead className="border-b border-surface">
                  <tr><th className={th}>Nama</th><th className={th}>Nomor WhatsApp</th><th className={th}>Status</th><th className={th}>Masuk</th><th className={th}>Aksi</th></tr>
                </thead>
                <tbody className="divide-y divide-surface">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className={`${td} font-medium`}>{row.name}</td>
                      <td className={td}><a href={`https://wa.me/${row.phone}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">+{row.phone}</a></td>
                      <td className={td}><Pill tone={row.status === 'new' ? 'warn' : 'neutral'}>{REQUEST_STATUS[row.status] ?? row.status}</Pill></td>
                      <td className={td}>{when(row.createdAt)}</td>
                      <td className={td}>{actions(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )
        }
      </Await>
    </Page>
  )
}

function Feature({ label, value }: { label: string; value: DashFeature }) {
  const quiet = value.failures === 0 && value.successes === 0
  return (
    <div className={card}>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <p className="mt-1 text-sm">
        {quiet ? <span className="text-ink-soft">Belum ada pemakaian</span> : <><span className="font-semibold">{value.successes}</span> berhasil · <span className={value.failures > 0 ? 'font-semibold text-red-700' : ''}>{value.failures}</span> gagal</>}
      </p>
      <p className="text-xs text-ink-soft">1 jam terakhir</p>
    </div>
  )
}

export function Health() {
  const { state, reload } = useData(() => dashboardApi.health(), [], 30_000)
  return (
    <Page title="Kesehatan" note="Diperbarui otomatis tiap 30 detik." onReload={reload}>
      <Await state={state}>
        {(data) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Database" value={data.database === 'ok' ? 'Baik' : 'Bermasalah'} />
              <Stat label="Agen AI (Hermes)" value={data.agent === null ? 'Tidak diatur' : data.agent ? 'Baik' : 'Bermasalah'} tone={data.agent === false ? 'warn' : undefined} />
              <Stat label="WhatsApp sistem" value={data.system ? (CONNECTION[data.system.connection] ?? data.system.connection) : 'Tidak diatur'} hint={data.system && !data.system.paired ? 'belum dipasangkan' : undefined} />
              <Stat label="Aplikasi menyala" value={uptime(data.uptimeSeconds)} hint={`dicek ${when(data.at)}`} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Feature label="Chat di app" value={data.lastHour.chat} />
              <Feature label="Catatan proyek" value={data.lastHour.summary} />
              <Feature label="Notifikasi pagi" value={data.lastHour.push} />
            </div>
            <section className={card}>
              <h2 className="font-semibold">Sesi WhatsApp pelanggan</h2>
              {data.whatsapp.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">Tidak ada sesi yang terbuka.</p>
              ) : (
                <ul className="mt-2 divide-y divide-surface">
                  {data.whatsapp.map((row, index) => (
                    <li key={index} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="font-medium">{row.customer}</span>
                      <Pill tone={connectionTone(row.connection)}>{CONNECTION[row.connection] ?? row.connection}</Pill>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </Await>
    </Page>
  )
}

const ACTIONS: Record<string, string> = {
  dashboard_link: 'Minta link dashboard',
  dashboard_login: 'Masuk dashboard',
  invite_created: 'Buat undangan',
  invite_renewed: 'Perbarui undangan',
  invite_revoked: 'Cabut undangan',
  subscription_granted: 'Beri atau perpanjang paket',
  tenant_deleted: 'Hapus pelanggan',
  tenant_auto_deleted: 'Hapus otomatis (langganan berakhir)',
  tenant_renamed: 'Ganti nama pelanggan',
  tenant_enabled: 'Aktifkan pelanggan',
  tenant_disabled: 'Nonaktifkan pelanggan',
  lead_contacted: 'Tandai sudah dihubungi',
  lead_rejected: 'Tolak permintaan akses',
  admin_added: 'Tambah admin',
  admin_removed: 'Cabut admin',
}

function detailText(entry: DashAudit): string {
  return Object.entries(entry.detail)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')
}

export function Admins() {
  const { state, reload } = useData(() => dashboardApi.admins(), [])
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<number | null>(null)

  const run = async (task: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    setError('')
    try {
      await task()
      setId('')
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 403 ? 'Hanya owner yang bisa mengubah admin.' : failed)
    } finally {
      setConfirming(null)
      setBusy(false)
      reload()
    }
  }
  const valid = /^\d{5,15}$/.test(id.trim())

  return (
    <Page title="Admin" note="Orang yang bisa memakai bot Telegram dan dashboard ini. Owner berasal dari pengaturan server; hanya owner yang bisa menambah atau mencabut admin." onReload={reload} back="/dashboard/lainnya">
      <Await state={state}>
        {({ admins, canManage }) => (
          <>
            <ul className="flex flex-col gap-3">
              {admins.map((row: DashAdmin) => (
                <li key={row.telegramId} className={`${card} flex items-center justify-between gap-3`}>
                  <div>
                    <p className="font-semibold">{row.telegramId}</p>
                    <p className="text-xs text-ink-soft">{row.owner ? 'Owner (tidak bisa dicabut dari sini)' : `Ditambahkan ${row.addedAt ? when(row.addedAt) : ''}${row.addedBy ? ` oleh ${row.addedBy}` : ''}`}</p>
                  </div>
                  {canManage && !row.owner && (
                    confirming === row.telegramId ? (
                      <button type="button" disabled={busy} onClick={() => void run(() => dashboardApi.removeAdmin(row.telegramId), 'Gagal mencabut admin.')} className={`${button} bg-red-700 text-white`}>Yakin cabut?</button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => setConfirming(row.telegramId)} className={`${button} bg-surface text-red-700`}>Cabut</button>
                    )
                  )}
                </li>
              ))}
            </ul>
            {canManage ? (
              <form
                className={card}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (valid) void run(() => dashboardApi.addAdmin(id.trim()), 'Gagal menambah admin.')
                }}
              >
                <label htmlFor="admin-id" className="font-semibold">Tambah admin</label>
                <p className="mt-1 text-xs text-ink-soft">ID Telegram berupa angka (5–15 digit); orangnya bisa melihatnya lewat @userinfobot dan perlu menekan Start di bot.</p>
                <div className="mt-3 flex gap-2">
                  <input id="admin-id" inputMode="numeric" autoComplete="off" value={id} onChange={(event) => setId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm" />
                  <button type="submit" disabled={busy || !valid} className={`${button} bg-brand-500 text-white`}>Tambah</button>
                </div>
              </form>
            ) : (
              <p className={`${card} text-sm text-ink-soft`}>Anda admin biasa: bisa melihat daftar ini, tapi hanya owner yang bisa mengubahnya.</p>
            )}
            {error && <p className={`${card} text-sm text-red-700`}>{error}</p>}
          </>
        )}
      </Await>
    </Page>
  )
}

export function AuditLog() {
  const { state, reload } = useData(() => dashboardApi.audit(), [], 60_000)
  return (
    <Page title="Catatan admin" note="Siapa melakukan apa. Hanya jenis tindakan, hitungan, dan id; tidak ada isi pesan." onReload={reload}>
      <Await state={state}>
        {(rows) => (
          <>
          <ul className="flex flex-col gap-3 lg:hidden">
            {rows.map((row, index) => (
              <li key={index} className={card}>
                <p className="font-semibold">{ACTIONS[row.action] ?? row.action}</p>
                <p className="text-sm text-ink-soft">{row.customer ? `${row.customer} · ` : ''}admin {row.actor ?? 'sistem'}</p>
                <p className="mt-1 text-xs text-ink-soft">{when(row.at)}</p>
                {detailText(row) && <p className="mt-1 text-xs text-ink-soft">{detailText(row)}</p>}
              </li>
            ))}
          </ul>
          <div className={`${card} hidden overflow-x-auto p-0 sm:p-0 lg:block`}>
            <table className="min-w-full">
              <thead className="border-b border-surface">
                <tr><th className={th}>Waktu</th><th className={th}>Admin</th><th className={th}>Tindakan</th><th className={th}>Pelanggan</th><th className={th}>Rincian</th></tr>
              </thead>
              <tbody className="divide-y divide-surface">
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td className={`${td} whitespace-nowrap`}>{when(row.at)}</td>
                    <td className={td}>{row.actor ?? 'sistem'}</td>
                    <td className={td}>{ACTIONS[row.action] ?? row.action}</td>
                    <td className={td}>{row.customer ?? '-'}</td>
                    <td className={`${td} text-xs text-ink-soft`}>{detailText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Await>
    </Page>
  )
}

export function More() {
  const signOut = useSignOut()
  const [size, setSize] = useState<TextSize>(readTextSize)
  const { state } = useData(() => dashboardApi.overview(), [], 60_000)
  const waiting = state.status === 'ready' ? state.data.newRequests : 0
  const link = 'flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-card'
  return (
    <Page title="Lainnya">
      <div className="flex flex-col gap-3">
        <Link to="/dashboard/permintaan" className={link}>
          <span className="flex items-center gap-3">
            <Inbox aria-hidden="true" className="h-5 w-5 text-ink-soft" />
            <span>
              <span className="block font-semibold">Permintaan akses</span>
              <span className="block text-sm text-ink-soft">{waiting > 0 ? `${waiting} menunggu dihubungi` : 'Dari formulir di beranda'}</span>
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <Link to="/dashboard/audit" className={link}>
          <span className="flex items-center gap-3">
            <FileClock aria-hidden="true" className="h-5 w-5 text-ink-soft" />
            <span>
              <span className="block font-semibold">Catatan admin</span>
              <span className="block text-sm text-ink-soft">Siapa melakukan apa</span>
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <Link to="/dashboard/admin" className={link}>
          <span className="flex items-center gap-3">
            <ShieldCheck aria-hidden="true" className="h-5 w-5 text-ink-soft" />
            <span>
              <span className="block font-semibold">Admin</span>
              <span className="block text-sm text-ink-soft">Siapa yang bisa masuk ke bot dan dashboard</span>
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="h-5 w-5 text-ink-soft" />
        </Link>
        <section className={card}>
          <h2 className="flex items-center gap-2 font-semibold"><Type aria-hidden="true" className="h-5 w-5 text-ink-soft" /> Ukuran teks</h2>
          <div role="radiogroup" aria-label="Ukuran teks" className="mt-3 grid grid-cols-2 gap-2">
            {TEXT_SIZES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === size}
                onClick={() => { setSize(item.id); saveTextSize(item.id) }}
                className={`rounded-xl px-3 py-2 text-sm font-medium ${item.id === size ? 'bg-ink text-white' : 'bg-surface text-ink-soft'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
        <button type="button" onClick={signOut} className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-[0.9375rem] font-semibold shadow-card">
          <LogOut aria-hidden="true" className="h-4 w-4" /> Keluar
        </button>
      </div>
    </Page>
  )
}
