import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, dashboardApi, type DashChoices, type DashCustomer, type DashInvite } from '../api'
import { day, usd } from './format'
import { button, card, InviteResult } from './ui'

const field = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm'
const label = 'text-xs font-semibold uppercase tracking-wide text-ink-soft'

/** Runs one action: busy while it runs, a short message when it fails, then the page reloads its data. */
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const run = async (task: () => Promise<string | void>) => {
    setBusy(true)
    setMessage('')
    try {
      setMessage((await task()) ?? '')
    } catch (caught) {
      setMessage(caught instanceof ApiError && caught.status === 400 ? 'Isian tidak valid.' : caught instanceof ApiError && caught.status === 404 ? 'Pelanggan tidak ditemukan.' : 'Gagal. Coba lagi.')
    } finally {
      setBusy(false)
      reload()
    }
  }
  return { busy, message, run }
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={card}>
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

const limitLabel = (value: number | null) => (value === null ? 'Tanpa batas' : usd(value))

export function CustomerActions({ row, choices, reload }: { row: DashCustomer; choices: DashChoices; reload: () => void }) {
  const navigate = useNavigate()
  const { busy, message, run } = useAction(reload)
  const [name, setName] = useState(row.name)
  const [notes, setNotes] = useState(row.notes ?? '')
  const [plan, setPlan] = useState(choices.plans[0]?.code ?? '')
  const [months, setMonths] = useState(choices.choices.months[0] ?? 1)
  const [confirming, setConfirming] = useState<'disable' | 'delete' | 'repair' | 'endPlan' | null>(null)
  const [invite, setInvite] = useState<DashInvite | null>(null)
  const [manualPlan, setManualPlan] = useState(row.planCode ?? choices.allPlans[0]?.code ?? '')
  const [endsOn, setEndsOn] = useState(row.endsAt ? new Date(new Date(row.endsAt).getTime() + 7 * 3_600_000).toISOString().slice(0, 10) : '')
  const [typed, setTyped] = useState('')

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {invite && <div className="lg:col-span-2"><InviteResult invite={invite} onClose={() => setInvite(null)} /></div>}
      <Block title="Profil">
        <div className="flex flex-col gap-1">
          <label htmlFor="c-name" className={label}>Nama</label>
          <div className="flex gap-2">
            <input id="c-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className={field} />
            <button type="button" disabled={busy || !name.trim() || name.trim() === row.name} onClick={() => void run(async () => void (await dashboardApi.renameCustomer(row.id, name)))} className={`${button} bg-brand-500 text-white`}>Simpan</button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="c-notes" className={label}>Catatan (maks. 500 karakter, hanya untuk admin)</label>
          <textarea id="c-notes" value={notes} maxLength={500} rows={3} onChange={(event) => setNotes(event.target.value)} className={field} />
          <div>
            <button type="button" disabled={busy || notes.trim() === (row.notes ?? '')} onClick={() => void run(async () => void (await dashboardApi.setNotes(row.id, notes)))} className={`${button} bg-brand-500 text-white`}>Simpan catatan</button>
          </div>
        </div>
      </Block>

      <Block title="Akun">
        <p className="text-sm text-ink-soft">
          {row.status === 'active' ? 'Aktif: AI dan WhatsApp berjalan.' : row.status === 'disabled' ? 'Dinonaktifkan: tidak bisa masuk dan AI berhenti.' : 'Belum diaktifkan. Mengaktifkan memulai uji coba 14 hari dan mengirim info akses lewat WhatsApp pelanggan.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {row.status !== 'active' && (
            <button type="button" disabled={busy} onClick={() => void run(async () => { const result = await dashboardApi.setStatus(row.id, 'active'); return result.accessSent === false ? 'Aktif, tapi info akses belum terkirim.' : 'Diaktifkan.' })} className={`${button} bg-brand-500 text-white`}>Aktifkan</button>
          )}
          {row.status === 'active' &&
            (confirming === 'disable' ? (
              <button type="button" disabled={busy} onClick={() => { setConfirming(null); void run(async () => void (await dashboardApi.setStatus(row.id, 'disabled'))) }} className={`${button} bg-red-700 text-white`}>Yakin nonaktifkan?</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirming('disable')} className={`${button} bg-surface text-red-700`}>Nonaktifkan</button>
            ))}
          <button type="button" disabled={busy} onClick={() => void run(async () => void (await dashboardApi.setPaused(row.id, !row.paused)))} className={`${button} bg-surface`}>{row.paused ? 'Lanjutkan AI' : 'Jeda AI'}</button>
        </div>
      </Block>

      <Block title="Paket">
        <p className="text-sm text-ink-soft">
          Sekarang: {row.plan ?? 'belum ada'}{row.endsAt ? `, sampai ${day(row.endsAt)}` : ''}. Paket yang masih berjalan diperpanjang dari tanggal akhirnya; pelanggan diberi tahu lewat WhatsApp.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="c-plan" className={label}>Paket</label>
            <select id="c-plan" value={plan} onChange={(event) => setPlan(event.target.value)} className={field}>
              {choices.plans.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="c-months" className={label}>Lama</label>
            <select id="c-months" value={months} onChange={(event) => setMonths(Number(event.target.value))} className={field}>
              {choices.choices.months.map((value) => <option key={value} value={value}>{value} bulan</option>)}
            </select>
          </div>
        </div>
        <div>
          <button type="button" disabled={busy || !plan} onClick={() => void run(async () => { const result = await dashboardApi.grantPlan(row.id, plan, months); return `Paket ${result.plan} aktif sampai ${day(result.endsAt)}.` })} className={`${button} bg-brand-500 text-white`}>Aktifkan / perpanjang</button>
        </div>
      </Block>

      <Block title="Koreksi paket">
        <p className="text-sm text-ink-soft">Mengatur paket dan tanggal akhir persis seperti yang diisi (bukan menambah). Untuk memperpendek, mengganti ke uji coba, atau memperbaiki salah input. Pelanggan tidak diberi tahu.</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="m-plan" className={label}>Paket</label>
            <select id="m-plan" value={manualPlan} onChange={(event) => setManualPlan(event.target.value)} className={field}>
              {choices.allPlans.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="m-end" className={label}>Berakhir (WIB)</label>
            <input id="m-end" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} className={field} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !manualPlan || !endsOn} onClick={() => void run(async () => { const result = await dashboardApi.setPlan(row.id, manualPlan, endsOn); return `Paket ${result.plan} berakhir ${day(result.endsAt)}.` })} className={`${button} bg-brand-500 text-white`}>Simpan</button>
          {row.planCode && (
            confirming === 'endPlan' ? (
              <button type="button" disabled={busy} onClick={() => { setConfirming(null); void run(async () => { await dashboardApi.endPlan(row.id, row.planCode!); return 'Paket diakhiri sekarang.' }) }} className={`${button} bg-red-700 text-white`}>Yakin akhiri?</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirming('endPlan')} className={`${button} bg-surface text-red-700`}>Akhiri sekarang</button>
            )
          )}
        </div>
      </Block>

      <Block title="WhatsApp">
        <p className="text-sm text-ink-soft">
          Pairing ulang memutus sesi WhatsApp lama, mengulang onboarding dari langkah WhatsApp, dan membuat tautan baru (48 jam, sekali pakai). Pesan yang sudah tersimpan tidak hilang.
        </p>
        <div className="flex flex-wrap gap-2">
          {confirming === 'repair' ? (
            <button type="button" disabled={busy} onClick={() => { setConfirming(null); void run(async () => { setInvite(await dashboardApi.repair(row.id)) }) }} className={`${button} bg-red-700 text-white`}>Yakin pairing ulang?</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirming('repair')} className={`${button} bg-surface`}>Pairing ulang</button>
          )}
          {row.status === 'invited' && (
            <button type="button" disabled={busy} onClick={() => void run(async () => { setInvite(await dashboardApi.renewInvitation(row.id)) })} className={`${button} bg-surface`}>Perbarui undangan</button>
          )}
        </div>
      </Block>

      <Block title="Batas biaya AI">
        <p className="text-sm text-ink-soft">Peringatan di 80%; AI dijeda otomatis saat batas tercapai.</p>
        {([['daily', 'Harian', choices.choices.dailyUsd, row.limitUsd.daily], ['monthly', 'Bulanan', choices.choices.monthlyUsd, row.limitUsd.monthly]] as const).map(([scope, title, values, current]) => (
          <div key={scope} className="flex items-center justify-between gap-3">
            <label htmlFor={`c-${scope}`} className="text-sm font-medium">{title}</label>
            <select id={`c-${scope}`} value={current ?? 0} disabled={busy} onChange={(event) => void run(async () => void (await dashboardApi.setLimit(row.id, scope, Number(event.target.value))))} className={`${field} max-w-44`}>
              {!values.includes(current ?? 0) && current !== null && <option value={current}>{limitLabel(current)}</option>}
              {values.map((value) => <option key={value} value={value}>{limitLabel(value)}</option>)}
              <option value={0}>{limitLabel(null)}</option>
            </select>
          </div>
        ))}
      </Block>

      <section className={`${card} border border-red-200 lg:col-span-2`}>
        <h2 className="font-semibold text-red-700">Hapus pelanggan</h2>
        <p className="mt-1 text-sm text-ink-soft">Menghapus permanen pelanggan beserta pesan, proyek, dan sesi WhatsApp-nya. Tidak bisa dibatalkan. Ketik nama pelanggan untuk mengonfirmasi.</p>
        {confirming === 'delete' ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input aria-label="Ketik nama pelanggan" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={row.name} className={field} />
            <button type="button" disabled={busy || typed !== row.name} onClick={() => void run(async () => { await dashboardApi.deleteCustomer(row.id, typed); navigate('/dashboard/pelanggan', { replace: true }) })} className={`${button} bg-red-700 text-white`}>Hapus permanen</button>
            <button type="button" disabled={busy} onClick={() => { setConfirming(null); setTyped('') }} className={`${button} bg-surface`}>Batal</button>
          </div>
        ) : (
          <div className="mt-3">
            <button type="button" disabled={busy} onClick={() => setConfirming('delete')} className={`${button} bg-surface text-red-700`}>Hapus…</button>
          </div>
        )}
      </section>

      {message && <p role="status" className={`${card} text-sm lg:col-span-2`}>{message}</p>}
    </div>
  )
}

/** Creates a customer with an invitation link (the same as /invite in the bot). */
export function NewCustomer({ reload }: { reload: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [invite, setInvite] = useState<DashInvite | null>(null)
  const { busy, message, run } = useAction(reload)
  const phoneOk = phone.trim() === '' || /^\d{8,15}$/.test(phone.replace(/\D/g, ''))

  return (
    <>
      {invite && <InviteResult invite={invite} onClose={() => setInvite(null)} />}
      {open ? (
        <form
          className={card}
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              setInvite(await dashboardApi.createCustomer({ name, phone }))
              setName('')
              setPhone('')
              setOpen(false)
            })
          }}
        >
          <h2 className="font-semibold">Pelanggan baru</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="n-name" className={label}>Nama</label>
              <input id="n-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className={field} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="n-phone" className={label}>Nomor WhatsApp (opsional)</label>
              <input id="n-phone" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="62812…" className={field} />
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-soft">Membuat undangan 48 jam, sekali pakai. Nomor hanya dipakai untuk tombol kirim lewat WhatsApp.</p>
          <div className="mt-3 flex gap-2">
            <button type="submit" disabled={busy || !name.trim() || !phoneOk} className={`${button} bg-brand-500 text-white`}>Buat undangan</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className={`${button} bg-surface`}>Batal</button>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" onClick={() => setOpen(true)} className={`${button} bg-brand-500 text-white`}>Pelanggan baru</button>
        </div>
      )}
      {message && <p role="status" className={`${card} text-sm`}>{message}</p>}
    </>
  )
}
