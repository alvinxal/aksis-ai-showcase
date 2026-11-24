import { ChevronLeft, Search, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, contactsApi, type ContactItem, type ContactsOverview } from '../api'
import { LoadFailed, Loading, MessageScreen } from '../onboarding/screens'
import { SAMPLE_DATA, useContacts } from './data'

const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' })

const ERRORS: Record<string, string> = {
  limit: 'Batas kontak sudah tercapai. Lepas satu kontak dulu.',
  project_required: 'Proyek tidak ditemukan. Muat ulang halaman.',
  not_found: 'Kontak tidak ditemukan. Muat ulang halaman.',
}

/** One contact: chosen ones can be dropped, others are chosen with one tap. Aksis finds the project of each message itself. */
function ContactRow({ contact, busy, onChoose, onDrop }: { contact: ContactItem; busy: boolean; onChoose: () => void; onDrop: () => void }) {
  return (
    <li className="border-b border-surface py-3">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-ink-soft">
          <UserRound aria-hidden="true" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{contact.label}</p>
          <p className="truncate text-xs text-ink-soft">
            {contact.selected ? 'Dibaca' : contact.lastMessageAt ? `Terakhir chat ${dateFormat.format(new Date(contact.lastMessageAt))}` : 'Belum pernah chat dengan Anda'}
          </p>
        </div>
        {contact.selected ? (
          <button type="button" disabled={busy} onClick={onDrop} className="shrink-0 rounded-full bg-surface px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50">
            Lepas
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onChoose} className="shrink-0 rounded-full bg-brand-50 px-3.5 py-1.5 text-sm font-semibold text-brand-700 disabled:opacity-50">
            Baca
          </button>
        )}
      </div>
    </li>
  )
}

export function ContactsScreen() {
  const navigate = useNavigate()
  const loaded = useContacts()
  const [overview, setOverview] = useState<ContactsOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (loaded.state === 'ready') setOverview(loaded.data)
  }, [loaded])

  // The list is searched on the server, because the phone's contact list can be long.
  const [query, setQuery] = useState('')
  const asked = useRef('')
  useEffect(() => {
    if (!overview || query.trim() === asked.current) return
    const timer = window.setTimeout(() => {
      asked.current = query.trim()
      if (SAMPLE_DATA) return
      contactsApi.list(asked.current).then(setOverview).catch(() => setError('Pencarian belum bisa dijalankan. Coba lagi sebentar lagi.'))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, overview])

  const change = async (contact: ContactItem, selected: boolean) => {
    if (!overview) return
    setBusy(true)
    setError(null)
    try {
      if (!SAMPLE_DATA) await contactsApi.set(contact.id, selected)
      setOverview(SAMPLE_DATA ? { ...overview, contacts: overview.contacts.map((item) => (item.id === contact.id ? { ...item, selected } : item)) } : await contactsApi.list(asked.current))
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
      setError((caught instanceof ApiError && ERRORS[caught.code]) || 'Belum bisa disimpan. Coba lagi sebentar lagi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <header className="flex items-center gap-3 bg-surface px-3 py-3">
        <button type="button" aria-label="Kembali" onClick={() => navigate('/app/pengaturan')} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <h1 className="font-semibold">Chat pribadi</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5">
        {loaded.state === 'loading' && <Loading />}
        {loaded.state === 'failed' && <LoadFailed onRetry={loaded.retry} />}
        {overview && (
          <>
            <p className="text-[0.9375rem] leading-relaxed">Aksis hanya membaca chat pribadi yang Anda pilih di sini, seperti chat dengan klien atau tukang. Aksis menentukan sendiri proyeknya dari isi chat. Kontak yang tidak dipilih tidak dibaca; hanya nama dan nomornya yang dicatat supaya bisa Anda pilih, dan pesan lamanya yang dikirim WhatsApp saat penautan dihapus paling lambat dalam 24 jam.</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-soft">Chat pribadi berisi pesan orang lain. Sebaiknya beri tahu mereka bahwa Aksis ikut membantu membaca chat proyek. Memilih kontak tidak mengirim apa pun ke mereka.</p>
            <p className="mt-4 text-sm font-semibold">
              {overview.selectedCount} dari {overview.limit} kontak dibaca
            </p>
            <div className="relative mt-3">
              <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Cari nama kontak" aria-label="Cari nama kontak" className="w-full rounded-2xl bg-surface py-3 pl-11 pr-4 text-base outline-none ring-brand-500 focus:ring-2" />
            </div>
            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
                {error}
              </p>
            )}
            {overview.contacts.length === 0 ? (
              <div className="mt-6">
                <MessageScreen title="Belum ada kontak" text="Kontak dari WhatsApp Anda muncul di sini. Yang belum Anda pilih tidak dibaca dan isi pesannya dihapus paling lambat dalam 24 jam." />
              </div>
            ) : (
              <ul className="mt-2">
                {overview.contacts.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    busy={busy}
                    onChoose={() => void change(contact, true)}
                    onDrop={() => void change(contact, false)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
