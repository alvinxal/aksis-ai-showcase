// Sample data for the UI-first phase. Replaced by /v1 API calls once the backend is wired.

export type Agent = {
  id: string
  name: string
  role: string
  /** Avatar image in /public/avatars, one color per agent. */
  avatar: string
  last: string
  time: string
  unread: number
}

/** `at` (ISO) lets the chat put a day badge between days; the sample data below has none for most threads. */
export type Message = { id: number | string; from: 'agent' | 'me' | 'divider'; text: string; time: string; at?: string }

export const AGENTS: Agent[] = [
  { id: 'aksis', name: 'Aksis', role: 'Asisten umum', avatar: '/avatars/aksis.webp', last: 'Ada 2 hal penting hari ini: revisi denah dan termin 2.', time: '08.12', unread: 2 },
  { id: 'project', name: 'Project', role: 'Progres dan keputusan', avatar: '/avatars/project.webp', last: 'Klien menyetujui material lantai Rumah Budi.', time: '07.45', unread: 1 },
  { id: 'finance', name: 'Finance', role: 'Termin dan tagihan', avatar: '/avatars/finance.webp', last: 'Termin 2 Rumah Budi jatuh tempo 3 hari lagi.', time: 'Kemarin', unread: 0 },
  { id: 'reminder', name: 'Reminder', role: 'Tenggat dan tindak lanjut', avatar: '/avatars/reminder.webp', last: 'Besok 09.00 survei lokasi Villa Sanur.', time: 'Kemarin', unread: 3 },
]

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

export const THREADS: Record<string, Message[]> = {
  aksis: [
    { id: 'old-1', from: 'me', text: 'Ringkas progres minggu lalu.', time: '16.02', at: hoursAgo(80) },
    { id: 'old-2', from: 'agent', text: 'Minggu lalu ada 3 keputusan dan 1 revisi yang sudah selesai.', time: '16.03', at: hoursAgo(80) },
    { id: 'old-3', from: 'me', text: 'Ada tagihan yang belum dibayar?', time: '10.20', at: hoursAgo(30) },
    { id: 'old-4', from: 'agent', text: 'Belum ada. Termin berikutnya jatuh tempo 3 hari lagi.', time: '10.21', at: hoursAgo(30) },
    { id: 1, from: 'agent', text: 'Selamat pagi. Ada 2 hal penting hari ini.', time: '08.10', at: hoursAgo(0.5) },
    { id: 2, from: 'agent', text: '1. Klien Rumah Budi minta revisi denah lantai 2.\n2. Termin 2 jatuh tempo 3 hari lagi.', time: '08.12', at: hoursAgo(0.4) },
    { id: 3, from: 'me', text: 'Revisi denahnya minta apa saja?', time: '08.14', at: hoursAgo(0.3) },
    { id: 4, from: 'agent', text: 'Pindahkan kamar mandi ke sisi timur dan tambah satu jendela di ruang keluarga. Sumber: grup "Rumah Budi", kemarin 16.40.', time: '08.14', at: hoursAgo(0.3) },
  ],
  project: [
    { id: 1, from: 'agent', text: 'Klien menyetujui material lantai untuk Rumah Budi (granit abu).', time: '07.45' },
    { id: 2, from: 'me', text: 'Kapan persetujuannya?', time: '07.46' },
    { id: 3, from: 'agent', text: 'Selasa lalu, 14.20, di grup "Rumah Budi".', time: '07.46' },
  ],
  finance: [
    { id: 1, from: 'agent', text: 'Termin 2 Rumah Budi (30%) jatuh tempo 3 hari lagi.', time: 'Kemarin' },
    { id: 2, from: 'agent', text: 'Nominal tidak disebut jelas di chat. Mau saya tandai untuk dicek?', time: 'Kemarin' },
  ],
  reminder: [
    { id: 1, from: 'agent', text: 'Besok 09.00 survei lokasi Villa Sanur.', time: 'Kemarin' },
    { id: 2, from: 'agent', text: 'Jumat: kirim gambar kerja tahap 2 ke Pak Budi.', time: 'Kemarin' },
    { id: 3, from: 'agent', text: 'Klien Villa Sanur belum membalas sejak 3 hari.', time: 'Kemarin' },
  ],
}

export const GROUPS = [
  { jid: 'g1', name: 'Rumah Budi', members: 6 },
  { jid: 'g2', name: 'Villa Sanur', members: 9 },
  { jid: 'g3', name: 'Kantor Aksara', members: 5 },
  { jid: 'g4', name: 'Renovasi Ibu Dewi', members: 4 },
  { jid: 'g5', name: 'Keluarga Besar', members: 38 },
  { jid: 'g6', name: 'Tukang dan Supplier', members: 12 },
  { jid: 'g7', name: 'Alumni Arsitektur', members: 120 },
]
