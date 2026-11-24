import { Check, ChevronLeft, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, groupsApi, type GroupsOverview } from '../api'
import { LoadFailed, Loading } from '../onboarding/screens'
import { SAMPLE_DATA, useGroups } from './data'

const ERRORS: Record<string, string> = {
  groups_rejected: 'Jumlah grup melebihi batas paket Anda.',
  invalid_request: 'Pilih minimal satu grup.',
  unavailable: 'WhatsApp Anda belum tersambung. Coba lagi sebentar lagi.',
}

/** The groups Aksis reads: the customer ticks them and saves; the plan limit is enforced by the server too. */
export function GroupsScreen() {
  const navigate = useNavigate()
  const loaded = useGroups()
  const [overview, setOverview] = useState<GroupsOverview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (loaded.state !== 'ready') return
    setOverview(loaded.data)
    setChosen(new Set(loaded.data.groups.filter((group) => group.selected).map((group) => group.id)))
  }, [loaded])

  const toggle = (id: string) => {
    if (!overview) return
    setSaved(false)
    setError(null)
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else if (next.size < overview.limit) next.add(id)
      else setError(`Batas paket Anda ${overview.limit} grup. Lepas satu grup dulu.`)
      return next
    })
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!SAMPLE_DATA) await groupsApi.save([...chosen])
      setOverview((current) => current && { ...current, groups: current.groups.map((group) => ({ ...group, selected: chosen.has(group.id) })) })
      setSaved(true)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
      setError((caught instanceof ApiError && (caught.code === 'groups_rejected' ? (caught.message ?? ERRORS.groups_rejected) : ERRORS[caught.code])) || 'Belum bisa disimpan. Coba lagi sebentar lagi.')
    } finally {
      setBusy(false)
    }
  }

  const shown = overview?.groups.filter((group) => group.name.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const unchanged = overview !== null && overview.groups.every((group) => group.selected === chosen.has(group.id))
  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <header className="flex items-center gap-3 bg-surface px-3 py-3">
        <button type="button" aria-label="Kembali" onClick={() => navigate('/app/pengaturan')} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <h1 className="font-semibold">Grup proyek</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-5 pt-5">
        {loaded.state === 'loading' && <Loading />}
        {loaded.state === 'failed' && <LoadFailed onRetry={loaded.retry} />}
        {overview && (
          <>
            <p className="text-[0.9375rem] leading-relaxed">Aksis hanya membaca grup WhatsApp yang Anda pilih di sini. Tiap grup menjadi satu proyek. Grup yang dilepas berhenti dibaca, catatan proyeknya tetap tersimpan.</p>
            <p className="mt-4 text-sm font-semibold">
              {chosen.size} dari {overview.limit} grup dibaca
            </p>
            <div className="relative mt-3">
              <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Cari grup" aria-label="Cari grup" className="w-full rounded-2xl bg-surface py-3 pl-11 pr-4 text-base outline-none ring-brand-500 focus:ring-2" />
            </div>
            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
                {error}
              </p>
            )}
            <ul className="mt-2 pb-6">
              {shown.map((group) => {
                const on = chosen.has(group.id)
                return (
                  <li key={group.id} className="border-b border-surface">
                    <button type="button" onClick={() => toggle(group.id)} aria-pressed={on} className="flex w-full items-center gap-3 py-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{group.name}</span>
                        {group.members !== null && <span className="block text-xs text-ink-soft">{group.members} anggota</span>}
                      </span>
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-mute/40'}`}>{on && <Check aria-hidden="true" className="h-4 w-4" />}</span>
                    </button>
                  </li>
                )
              })}
              {shown.length === 0 && <li className="py-8 text-center text-sm text-ink-mute">{overview.groups.length === 0 ? 'Belum ada grup di WhatsApp Anda.' : 'Tidak ada grup yang cocok.'}</li>}
            </ul>
          </>
        )}
      </div>
      {overview && (
        <div className="border-t border-surface bg-white px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {saved && unchanged && <p role="status" className="mb-2 text-center text-sm text-brand-700">Tersimpan. Aksis mulai membaca pilihan ini.</p>}
          <button type="button" onClick={() => void save()} disabled={busy || unchanged || chosen.size === 0} className="w-full rounded-xl bg-brand-500 px-5 py-3 text-[0.9375rem] font-semibold text-white disabled:opacity-40">
            Simpan pilihan
          </button>
        </div>
      )}
    </div>
  )
}
