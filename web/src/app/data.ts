import { useCallback, useEffect, useState } from 'react'
import { ApiError, authApi, contactsApi, groupsApi, projectsApi, type ContactsOverview, type GroupsOverview, type Me, type ProjectDetail, type ProjectSummary } from '../api'

/**
 * `vite dev` shows sample data so screens can be designed without a backend; set VITE_REAL_API=1 to talk to
 * the backend through the proxy instead. A production build always uses the API.
 */
export const SAMPLE_DATA = import.meta.env.DEV && !import.meta.env.VITE_REAL_API

const day = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * day).toISOString()
const inDays = (days: number) => new Date(Date.now() + days * day).toISOString()
let counter = 0
const item = (type: ProjectDetail['decisions'][number]['type'], title: string, occurred: number, extra: { due?: number; amount?: number | null; sources?: number } = {}) => ({
  id: `s${(counter += 1)}`,
  type,
  title,
  occurredAt: ago(occurred),
  dueAt: extra.due === undefined ? null : inDays(extra.due),
  amount: extra.amount ?? null,
  sources: extra.sources ?? 1,
})

const SAMPLE_DETAILS: ProjectDetail[] = [
  {
    id: 'p1',
    name: 'Rumah Budi',
    groups: ['Rumah Budi'],
    contacts: ['Pak Budi'],
    note: { text: 'Material lantai dan atap sudah disetujui, tinggal revisi denah lantai 2 yang belum dikerjakan. Termin 2 sebesar Rp 30.000.000 jatuh tempo besok, dan warna dinding ruang tamu masih bolak-balik antara putih dan abu muda.', writtenAt: ago(0.1) },
    attention: [
      { ...item('PAYMENT_DUE', 'Termin 2 jatuh tempo', 2, { due: 1, amount: 30_000_000, sources: 2 }), urgent: true },
      { ...item('DEADLINE_DETECTED', 'Kirim gambar kerja tahap 2', 1, { due: 5 }), urgent: false },
      { ...item('DECISION_CONFLICT', 'Warna dinding ruang tamu: putih lalu abu muda', 2, { sources: 3 }), urgent: false },
    ],
    decisions: [item('DECISION_DETECTED', 'Lantai ruang tamu: granit abu-abu', 2), item('DECISION_DETECTED', 'Atap: baja ringan', 5)],
    revisions: [item('REVISION_REQUESTED', 'Denah lantai 2: geser kamar mandi, tambah jendela ruang keluarga', 2, { sources: 2 })],
    tasks: [item('TASK_ASSIGNED', 'Update gambar potongan A-A', 3, { due: 1 }), item('DEADLINE_DETECTED', 'Kirim gambar kerja tahap 2', 1, { due: 5 })],
    payments: [item('PAYMENT_DUE', 'Termin 2 jatuh tempo', 2, { due: 1, amount: 30_000_000, sources: 2 }), item('PAYMENT_RECEIVED', 'Termin 1 sudah masuk', 14, { amount: 30_000_000 }), item('INVOICE_SENT', 'Invoice DP terkirim', 28, { amount: 45_000_000 })],
  },
  {
    id: 'p2',
    name: 'Villa Sanur',
    groups: ['Villa Sanur'],
    contacts: [],
    note: null,
    attention: [],
    decisions: [item('DECISION_DETECTED', 'Gaya desain: tropis modern', 9)],
    revisions: [],
    tasks: [],
    payments: [item('PAYMENT_RECEIVED', 'DP 20 juta sudah masuk', 11, { amount: 20_000_000 })],
  },
]

const summarize = (detail: ProjectDetail): ProjectSummary => ({
  id: detail.id,
  name: detail.name,
  groups: detail.groups,
  contacts: detail.contacts,
  note: detail.note,
  attention: detail.attention.length,
  urgent: detail.attention.filter((entry) => entry.urgent).length,
  counts: { decisions: detail.decisions.length, revisions: detail.revisions.length, tasks: detail.tasks.length, payments: detail.payments.length },
  lastActivityAt: [...detail.decisions, ...detail.revisions, ...detail.tasks, ...detail.payments].map((entry) => entry.occurredAt).sort().at(-1) ?? null,
})

export const SAMPLE_ME: Me = { tenantName: 'Studio Aksara', contactName: 'Dewi' }

export type Loaded<T> = { state: 'loading' } | { state: 'failed'; retry: () => void } | { state: 'missing' } | { state: 'ready'; data: T }

function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  useEffect(() => {
    let live = true
    setResult({ state: 'loading' })
    load()
      .then((data) => live && setResult({ state: 'ready', data }))
      .catch((caught: unknown) => {
        if (!live) return
        if (caught instanceof ApiError && caught.status === 401) return window.location.reload()
        setResult(caught instanceof ApiError && caught.status === 404 ? { state: 'missing' } : { state: 'failed', retry })
      })
    return () => {
      live = false
    }
    // `load` is rebuilt every render; the key says when the request really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, retry])
  return result
}

export const useProjects = () =>
  useLoad<ProjectSummary[]>(() => (SAMPLE_DATA ? Promise.resolve(SAMPLE_DETAILS.map(summarize)) : projectsApi.list()), 'projects')

export const useProject = (id: string) =>
  useLoad<ProjectDetail>(
    () => {
      if (!SAMPLE_DATA) return projectsApi.get(id)
      const found = SAMPLE_DETAILS.find((entry) => entry.id === id)
      return found ? Promise.resolve(found) : Promise.reject(new ApiError(404, 'not_found'))
    },
    `project:${id}`,
  )

const SAMPLE_CONTACTS: ContactsOverview = {
  limit: 10,
  selectedCount: 1,
  projects: [{ id: 'p1', name: 'Rumah Budi' }, { id: 'p2', name: 'Villa Sanur' }],
  contacts: [
    { id: 'c1', label: 'Pak Budi', selected: true, projectId: 'p1', lastSeenAt: ago(0.05), lastMessageAt: ago(0.05) },
    { id: 'c2', label: 'Bu Sari', selected: false, projectId: null, lastSeenAt: ago(0.4), lastMessageAt: ago(0.4) },
    { id: 'c3', label: '+62 •••• 7890', selected: false, projectId: null, lastSeenAt: ago(2), lastMessageAt: ago(2) },
    { id: 'c4', label: 'Mas Joko (tukang)', selected: false, projectId: null, lastSeenAt: ago(5), lastMessageAt: null },
  ],
}

export const useContacts = () => useLoad<ContactsOverview>(() => (SAMPLE_DATA ? Promise.resolve(SAMPLE_CONTACTS) : contactsApi.list()), 'contacts')

const SAMPLE_GROUPS: GroupsOverview = {
  limit: 3,
  groups: [
    { id: 'g1', name: 'Rumah Budi', members: 6, selected: true },
    { id: 'g2', name: 'Villa Sanur', members: 4, selected: true },
    { id: 'g3', name: 'Tukang & Material', members: 12, selected: false },
    { id: 'g4', name: 'Keluarga', members: 9, selected: false },
  ],
}

export const useGroups = () => useLoad<GroupsOverview>(() => (SAMPLE_DATA ? Promise.resolve(SAMPLE_GROUPS) : groupsApi.list()), 'groups')

export const logout = () => authApi.logout()
