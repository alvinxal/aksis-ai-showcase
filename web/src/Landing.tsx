import { ArrowDown, ArrowRight, CalendarClock, ChevronLeft, ClipboardCheck, Plus, SendHorizontal, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'

/** The app screens run on sample data and only exist in `vite dev`, so "Masuk" is dev-only too. */
const SHOW_LOGIN = import.meta.env.DEV


// Contrast (WCAG AA): forest on paper 15.6, on mint 14.1, on lime 12.6; moss on paper 5.9, on mint 5.3;
// leaf on paper 4.6 (never used for text on mint, 4.1); white on leaf 4.8.

const CAPABILITIES = [
  {
    icon: ClipboardCheck,
    title: 'Kesepakatan & revisi',
    text: <>Kesepakatan klien tercatat dengan sumbernya. Gak perlu pusing bongkar <em>chat</em> lama.</>,
    sample: { label: 'Kesepakatan', title: 'Revisi desain disetujui', meta: 'Grup Proyek Cempaka · 27 Okt' },
  },
  {
    icon: Wallet,
    title: 'Anggaran & tagihan',
    text: <>Pantau pembayaran klien dan tagihan yang belum lunas dengan lebih praktis.</>,
    sample: { label: 'Tagihan', title: 'Termin kedua', meta: 'Menunggu pembayaran' },
  },
  {
    icon: CalendarClock,
    title: 'Pengingat',
    text: <>Jadwal survei, tenggat waktu, dan <em>follow-up</em> tak lagi terlewat.</>,
    sample: { label: 'Jadwal', title: 'Survei lokasi', meta: '30 Oktober · pengingat H-1' },
  },
]

const STEPS = [
  <>Dapatkan akses, lalu lengkapi profil studio atau usaha Anda.</>,
  <>Hubungkan akun WhatsApp dari HP, persis seperti memakai WhatsApp Web.</>,
  <>Pilih grup proyek mana saja yang boleh dipantau oleh Aksis.</>,
  <>Tanya apa saja, kapan saja. Setiap jawaban akan selalu menyertakan sumber <em>chat</em> aslinya.</>,
]

const FACTS = [
  { title: 'Cuma Membaca', text: <>Tidak pernah ikut campur membalas pesan di grup.</> },
  { title: 'Hanya Grup Pilihan', text: <>Grup lain tidak dibaca dan riwayatnya dihapus. Pesan grup pilihan disimpan paling lama 90 hari.</> },
  { title: 'Sumber Selalu Jelas', text: <>Setiap rangkuman disertai <em>chat</em> aslinya untuk di-<em>cross-check</em>.</> },
]

const FAQ = [
  { q: 'Apakah Aksis akan mengirim pesan ke grup?', a: 'Tidak. Aksis hanya membaca grup yang Anda pilih. Jawaban dikirim ke chat pribadi Anda, bukan ke grup.' },
  { q: 'Apakah saya harus ganti nomor WhatsApp?', a: 'Tidak. WhatsApp ditautkan sebagai perangkat tambahan, seperti WhatsApp Web. Anda tetap memakai WhatsApp seperti biasa.' },
  { q: 'Data apa saja yang disimpan?', a: 'Pesan teks dari grup dan chat pribadi yang Anda pilih, paling lama 90 hari. Riwayat grup lain dihapus dalam 24 jam, dan pesan grup yang Anda lepas dihapus saat itu juga. Hasil analisis (keputusan, tugas, tenggat) tersimpan selama Anda berlangganan. Rinciannya ada di Kebijakan Privasi.' },
  { q: 'Apakah ada risiko memakai WhatsApp tertaut?', a: 'Aksis memakai perangkat tertaut yang tidak disediakan resmi oleh WhatsApp, jadi WhatsApp bisa mengubah aturannya atau membatasi akun. Anda bisa mencabut tautan kapan saja dari WhatsApp.' },
  { q: 'Berapa banyak grup yang bisa dipantau?', a: 'Tiga atau lima grup proyek, tergantung paket.' },
]

// Sample conversation for the phone mockup (illustrative). Mirrors the chat screen in app/screens.tsx.
const CHAT: { from: 'me' | 'aksis'; text: string; time: string }[] = [
  { from: 'me', text: 'Ada yang penting hari ini?', time: '08.10' },
  { from: 'aksis', text: 'Ada 3 hal. Klien sudah setuju revisi desain Proyek Cempaka.', time: '08.10' },
  { from: 'me', text: 'Yang lainnya?', time: '08.11' },
  { from: 'aksis', text: 'Survei lokasi 30 Okt. Termin kedua belum dibayar.', time: '08.11' },
  { from: 'me', text: 'Revisi desainnya apa saja?', time: '08.12' },
  { from: 'aksis', text: 'Ganti material lantai ke granit abu dan geser serah terima ke 15 Nov.', time: '08.12' },
]

function Sample({ label, title, meta }: { label: string; title: string; meta: string }) {
  return (
    <div aria-hidden="true" className="rounded-xl border border-line bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-moss">{label}</p>
      <p className="mt-0.5 text-[15px] font-medium">{title}</p>
      <p className="text-[13px] text-moss">{meta}</p>
    </div>
  )
}

function Phone() {
  return (
    <div role="img" aria-label="Contoh tampilan chat Aksis di ponsel" className="relative mx-auto w-[260px] sm:w-[270px] lg:ml-auto lg:mr-6">
      <div aria-hidden="true" className="flex aspect-[9/19.5] flex-col overflow-hidden rounded-[38px] border-[6px] border-forest bg-white">
        <div className="mx-auto mt-2 h-4 w-20 shrink-0 rounded-full bg-forest" />
        <div className="mt-2 flex shrink-0 items-center gap-1.5 bg-surface px-2 py-2">
          <ChevronLeft className="h-5 w-5 shrink-0 text-ink-soft" />
          <img src="/avatars/aksis.webp" alt="" width={30} height={30} className="h-[30px] w-[30px] rounded-full" />
          <div>
            <p className="text-[13px] font-semibold leading-tight">Aksis</p>
            <p className="text-[10px] text-ink-soft">Asisten umum</p>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden px-3 py-3 text-[12px] leading-snug">
          {CHAT.map(({ from, text, time }) => (
            <div key={text} className={`flex flex-col ${from === 'me' ? 'items-end' : 'items-start'}`}>
              <p className={from === 'me' ? 'max-w-[82%] rounded-2xl rounded-br-md bg-brand-500 px-3 py-2 text-white' : 'max-w-[82%] rounded-2xl rounded-bl-md bg-surface px-3 py-2 text-ink'}>{text}</p>
              <span className="mt-0.5 text-[9px] text-ink-mute">{time}</span>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 bg-surface px-2.5 py-2">
          <span className="flex-1 rounded-full bg-white px-3 py-2 text-[12px] text-ink-mute">Pesan</span>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-500 text-white opacity-40">
            <SendHorizontal className="h-4 w-4" />
          </span>
        </div>
        <div className="mx-auto my-1.5 h-1 w-20 shrink-0 rounded-full bg-forest/80" />
      </div>
      <p className="mt-3 text-center text-xs text-moss lg:text-left">Contoh tampilan, bukan data pelanggan sungguhan.</p>
    </div>
  )
}

export function Landing() {
  return (
    <div className="min-h-screen bg-paper text-forest">
      <div className="p-3 sm:p-5">
        <div className="overflow-hidden rounded-3xl bg-mint">
          <div className="mx-auto max-w-5xl px-4 pb-14 pt-4 sm:px-6 lg:pb-20">
            <header className="flex h-14 items-center justify-between rounded-xl bg-white px-4">
              <img src="/logo-lockup.svg" alt="Aksis AI" className="h-7 w-auto" />
              <nav aria-label="Utama" className="flex items-center gap-4 sm:gap-6">
                <a href="#cara-kerja" className="hidden text-sm font-medium hover:underline sm:inline">
                  Cara kerja
                </a>
                <a href="#tanya-jawab" className="hidden text-sm font-medium hover:underline sm:inline">
                  Tanya jawab
                </a>
                {SHOW_LOGIN && (
                  <Link to="/app" className="text-sm font-medium hover:underline">
                    Masuk
                  </Link>
                )}
              </nav>
            </header>

            <div className="grid gap-10 pt-12 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:pt-16">
              <div>
                <h1 className="text-[34px] font-medium leading-[1.12] tracking-tight sm:text-5xl sm:leading-[1.08]">
                  <span className="block text-balance">Stop capek <em>scroll</em> nyari chat.</span>
                  <span className="block text-balance">Waktunya fokus berkarya.</span>
                </h1>
                <p className="mt-5 max-w-md text-[17px] leading-relaxed text-moss">Aksis adalah <span className="font-medium text-forest">asisten proyek untuk profesional yang bekerja dengan klien lewat WhatsApp</span>: arsitek, kontraktor, desainer, dan konsultan. Semua keputusan klien, revisi, dan tenggat waktu dari grup WhatsApp, kini terkumpul rapi di satu tempat.</p>
                <Link to="/akses" className="group mt-7 inline-flex items-center gap-2 rounded-lg bg-forest px-5 py-3 text-[15px] font-semibold text-white transition hover:bg-black">
                  Dapatkan Akses
                  <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <p className="mt-4 max-w-sm text-sm text-moss">Aksis hanya memantau grup pilihan Anda dan tidak akan pernah mengirim pesan ke dalamnya.</p>
                <a href="#kenalan" className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium hover:underline">
                  Lihat selengkapnya <ArrowDown aria-hidden="true" className="h-4 w-4" />
                </a>
              </div>
              <Phone />
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-5xl px-5 sm:px-8">
        <section id="kenalan" className="grid gap-8 py-16 lg:grid-cols-[1fr_1.1fr] lg:gap-16 lg:py-24">
          <div aria-hidden="true" className="flex flex-col justify-center gap-3 rounded-2xl bg-mint p-5 sm:p-8">
            <Sample label="Hari ini" title="3 hal yang perlu Anda cek" meta="Dirangkum dari 3 grup proyek" />
            <Sample label="Kesepakatan" title="Material lantai disetujui" meta="Grup Proyek Cempaka · 24 Okt" />
          </div>
          <div>
            <h2 className="text-3xl font-medium leading-tight tracking-tight">Kenalan dengan Aksis</h2>
            <ul className="mt-5 border-t border-line">
              {FACTS.map(({ title, text }) => (
                <li key={title} className="border-b border-line py-4">
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 max-w-md text-[15px] leading-relaxed text-moss">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="bidang" className="pb-16 lg:pb-24">
          <h2 id="bidang" className="text-3xl font-medium leading-tight tracking-tight">
            Aksis dapat membantu apa?
          </h2>
          <p className="mt-3 max-w-md text-moss">Biar Anda fokus ke desain, Aksis yang tangani tiga hal yang paling menyita waktu:</p>
          <ul className="mt-8 grid gap-5 md:grid-cols-3">
            {CAPABILITIES.map(({ icon: Icon, title, text, sample }) => (
              <li key={title}>
                <div className="rounded-2xl bg-mint p-4">
                  <Sample {...sample} />
                </div>
                <h3 className="mt-4 flex items-center gap-2 text-lg font-medium">
                  <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-leaf" />
                  {title}
                </h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-moss">{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="cara-kerja" className="grid gap-8 border-t border-line py-16 lg:grid-cols-2 lg:gap-16 lg:py-24">
          <div>
            <h2 className="text-3xl font-medium leading-tight tracking-tight">Cara kerja</h2>
            <p className="mt-3 max-w-md text-moss">Dari daftar sampai mulai bertanya, butuh waktu kurang dari lima menit.</p>
          </div>
          <ol className="flex flex-col">
            {STEPS.map((text, index) => (
              <li key={index} className={`flex gap-4 py-4 ${index > 0 ? 'border-t border-line' : 'pt-0'}`}>
                <span className="w-5 shrink-0 text-sm font-semibold text-leaf tabular-nums">{index + 1}</span>
                <span className="text-[15px] leading-relaxed">{text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="tanya-jawab" className="grid gap-8 border-t border-line py-16 lg:grid-cols-2 lg:gap-16 lg:py-24">
          <h2 className="text-3xl font-medium leading-tight tracking-tight">Pertanyaan umum</h2>
          <ul className="border-t border-line">
            {FAQ.map(({ q, a }) => (
              <li key={q} className="border-b border-line">
                <details className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
                    {q}
                    <Plus aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-45" />
                  </summary>
                  <p className="mt-2 max-w-md text-[15px] leading-relaxed text-moss">{a}</p>
                </details>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-16 rounded-3xl bg-lime px-6 py-10 sm:px-10 lg:mb-24 lg:flex lg:items-center lg:justify-between lg:gap-8">
          <div>
            <h2 className="text-2xl font-medium leading-tight tracking-tight sm:text-3xl">Siap mulai pakai Aksis?</h2>
            <p className="mt-2 max-w-md text-forest">Aksis saat ini menggunakan sistem undangan (<em>invite-only</em>). Dapatkan akses Anda sekarang dan mulai gunakan dalam hitungan menit.</p>
          </div>
          <Link to="/akses" className="group mt-6 inline-flex items-center gap-2 rounded-lg bg-forest px-5 py-3 text-[15px] font-semibold text-white transition hover:bg-black lg:mt-0 lg:shrink-0">
            Dapatkan Akses
            <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl border-t border-line px-5 py-8 text-sm text-moss sm:px-8">
        © Aksis AI by{' '}
        <a href="https://flaat.studio" rel="noopener" className="font-medium text-forest underline underline-offset-4 hover:no-underline">
          Flaat Studio
        </a>
        <span className="mx-2" aria-hidden="true">·</span>
        <Link to="/terms" className="underline underline-offset-4 hover:no-underline">Syarat</Link>
        <span className="mx-2" aria-hidden="true">·</span>
        <Link to="/privacy" className="underline underline-offset-4 hover:no-underline">Privasi</Link>
      </footer>
    </div>
  )
}
