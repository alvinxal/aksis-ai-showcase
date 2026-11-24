// The menu button of the chat: a sheet of buttons. None of these needs the AI except the three questions.
export type Command =
  | { id: string; title: string; hint: string; kind: 'new' | 'help' }
  | { id: string; title: string; hint: string; kind: 'ask'; question: string }

export const COMMANDS: Command[] = [
  { id: 'baru', title: 'Chat baru', hint: 'Mulai percakapan baru; yang lama tetap bisa digulir', kind: 'new' },
  { id: 'bantuan', title: 'Bantuan', hint: 'Apa yang bisa ditanyakan ke Aksis', kind: 'help' },
  { id: 'ringkasan', title: 'Ringkasan hari ini', hint: 'Yang penting hari ini di semua proyek', kind: 'ask', question: 'Ringkas yang penting hari ini.' },
  { id: 'tenggat', title: 'Tenggat minggu ini', hint: 'Yang jatuh tempo dalam 7 hari', kind: 'ask', question: 'Apa saja yang jatuh tempo atau ada tenggat minggu ini?' },
  { id: 'bayar', title: 'Anggaran & tagihan', hint: 'Tagihan yang jatuh tempo atau belum diterima', kind: 'ask', question: 'Pembayaran apa yang jatuh tempo atau belum diterima?' },
]

export const HELP_TEXT = [
  '*Yang bisa Aksis bantu*',
  'Aksis membaca grup WhatsApp dan chat pribadi yang Anda pilih, lalu mencatat keputusan, permintaan revisi, tugas, tenggat, dan pembayaran.',
  '',
  '*Contoh pertanyaan*',
  '• Apa yang jatuh tempo minggu ini?',
  '• Ada keputusan baru di proyek tertentu?',
  '• Tuliskan pesan pengingat untuk klien.',
  '',
  '*Menu*',
  'Tekan tombol menu di samping kolom pesan untuk memulai chat baru, membuka bantuan ini, atau langsung bertanya: ringkasan hari ini, tenggat minggu ini, dan pembayaran.',
  '',
  '*Perlu diketahui*',
  '• Paling banyak 20 pertanyaan per jam.',
  '• Aksis tidak pernah mengirim pesan ke siapa pun.',
  '• Grup dan kontak yang dibaca diatur di Pengaturan.',
].join('\n')
