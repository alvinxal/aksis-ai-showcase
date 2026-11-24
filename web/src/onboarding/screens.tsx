import { AlertTriangle, ArrowRight, Check, Copy, Loader2, Lock, Phone, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Group, OnboardingState } from '../api'
import { copyText } from '../clipboard'

// Same look as the landing page: warm paper, forest text, moss secondary text, leaf and mint accents,
// hairline borders, 8px controls. Contrast (WCAG AA): forest on paper 15.6, moss on paper 5.9,
// moss on mint 5.3, leaf on paper 4.6, white on leaf 4.8. Leaf is never used for text on mint (4.1).
export const h1 = 'text-[28px] font-medium leading-tight tracking-tight'
export const lead = 'mt-2 text-[15px] leading-relaxed text-moss'
export const box = 'rounded-xl border border-line bg-white p-5'
export const input = 'mt-1.5 block w-full rounded-lg border border-line bg-white px-4 py-3 text-[15px] outline-none focus:border-leaf focus:ring-2 focus:ring-leaf/30'
export const primary = 'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-forest px-5 py-3 text-[15px] font-semibold text-white transition hover:bg-black disabled:opacity-50'
export const secondary = 'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-mint px-5 py-3 text-[15px] font-semibold text-forest transition hover:brightness-95 disabled:opacity-50'

const STEPS = ['Profil', 'WhatsApp', 'Grup', 'Selesai']

export function OnboardingFrame({ step, children }: { step?: number; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-forest">
      <div className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-8 pt-5">
        <header className="flex h-10 items-center justify-between">
          <img src="/logo-lockup.svg" alt="Aksis AI" className="h-6 w-auto" />
          {step && (
            <span className="text-sm text-moss">
              Langkah {step} dari {STEPS.length}
            </span>
          )}
        </header>
        {step && (
          <div className="mt-4" role="progressbar" aria-label={STEPS[step - 1]} aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step}>
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-leaf transition-all" style={{ width: `${(step / STEPS.length) * 100}%` }} />
            </div>
          </div>
        )}
        <main className="mt-8 flex flex-1 flex-col gap-5">{children}</main>
      </div>
    </div>
  )
}

export function Mascot({ size = 56 }: { size?: number }) {
  return <img src="/avatars/aksis.webp" alt="" width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />
}

export function MessageScreen({ title, text }: { title: string; text: string }) {
  return (
    <section className="my-auto rounded-2xl bg-mint p-6 text-center">
      <div className="mx-auto w-fit">
        <Mascot size={72} />
      </div>
      <h1 className="mt-4 text-xl font-medium tracking-tight">{title}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-moss">{text}</p>
    </section>
  )
}

export const InvalidInvitation = () => (
  <MessageScreen title="Link tidak berlaku" text="Link undangan ini sudah dipakai, kedaluwarsa, atau dibatalkan. Minta link baru dari tim Aksis." />
)

export const SessionMissing = () => (
  <MessageScreen title="Sesi tidak ditemukan" text="Buka kembali link undangan dari tim Aksis. Jika link sudah dipakai di perangkat lain, minta link baru." />
)

export const LoadFailed = ({ onRetry }: { onRetry: () => void }) => (
  <section className="my-auto rounded-2xl bg-mint p-6 text-center">
    <h1 className="text-xl font-medium tracking-tight">Halaman belum bisa dimuat</h1>
    <p className="mt-2 text-[15px] leading-relaxed text-moss">Periksa koneksi internet Anda, lalu coba lagi.</p>
    <button type="button" className={`${primary} mt-5`} onClick={onRetry}>
      Coba lagi
    </button>
  </section>
)

export const Loading = () => (
  <div className="my-auto grid place-items-center" role="status" aria-label="Memuat">
    <Loader2 className="h-8 w-8 animate-spin text-leaf" />
  </div>
)

export function Note({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> {text}
    </p>
  )
}

/** Numbered steps like the "Cara kerja" list on the landing page. */
export function NumberedSteps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="w-full text-left">
      {items.map((text, index) => (
        <li key={index} className={`flex gap-4 py-3 ${index > 0 ? 'border-t border-line' : 'pt-0'}`}>
          <span className="w-4 shrink-0 text-sm font-semibold text-leaf tabular-nums">{index + 1}</span>
          <span className="text-[15px] leading-relaxed">{text}</span>
        </li>
      ))}
    </ol>
  )
}

export function Profile({ defaultStudio, busy, error, onSubmit }: { defaultStudio: string; busy: boolean; error: string | null; onSubmit: (studio: string, name: string) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSubmit(String(form.get('studio') ?? ''), String(form.get('name') ?? ''))
  }
  return (
    <>
      <section>
        <Mascot />
        <h1 className={`${h1} mt-4`}>Selamat datang di Aksis AI</h1>
        <p className={lead}>Isi data singkat studio Anda untuk mulai. Hanya butuh sekitar 3 menit.</p>
      </section>
      {error && <Note text={error} />}
      <form onSubmit={submit} className={`${box} flex flex-col gap-4`}>
        <label className="block text-sm font-medium">
          Nama studio / usaha
          <input name="studio" required maxLength={80} defaultValue={defaultStudio} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Nama Anda
          <input name="name" required maxLength={80} autoComplete="name" className={input} />
        </label>
        <label className="flex items-start gap-3 text-sm leading-relaxed">
          <input name="terms" type="checkbox" required className="mt-1 h-4 w-4 shrink-0 accent-leaf" />
          <span>
            Saya setuju dengan{' '}
            <a href="/terms" target="_blank" rel="noopener" className="font-medium underline underline-offset-4">Syarat Layanan</a> dan{' '}
            <a href="/privacy" target="_blank" rel="noopener" className="font-medium underline underline-offset-4">Kebijakan Privasi</a>, termasuk
            bahwa pesan grup yang saya pilih diproses oleh AI.
          </span>
        </label>
        <button className={primary} type="submit" disabled={busy}>
          Lanjut <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </form>
      <p className="flex items-center gap-2 text-sm text-moss">
        <Lock aria-hidden="true" className="h-4 w-4 shrink-0" /> Aksis hanya membaca grup yang Anda pilih dan tidak pernah mengirim pesan ke grup.
      </p>
    </>
  )
}

export type WhatsAppNotice = 'full' | 'phone' | 'failed'

const NOTICES: Record<WhatsAppNotice, string> = {
  full: 'Slot WhatsApp sedang penuh. Tim Aksis akan menghubungi Anda saat tersedia.',
  phone: 'Nomor tidak valid. Tulis nomor WhatsApp lengkap, misalnya 081234567890.',
  failed: 'Kode belum bisa dibuat. Coba lagi sebentar lagi, atau pakai QR dari perangkat lain.',
}

/** `onQr` is given only while QR pairing is offered (see features.ts). */
export function WhatsAppIntro({ notice, busy, onPhone, onQr }: { notice: WhatsAppNotice | null; busy: boolean; onPhone: (phone: string) => void; onQr?: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onPhone(String(new FormData(event.currentTarget).get('phone') ?? ''))
  }
  return (
    <>
      <section>
        <h1 className={h1}>Hubungkan WhatsApp</h1>
        <p className={lead}>Aksis membaca percakapan lewat perangkat tertaut di WhatsApp, seperti WhatsApp Web. Anda tetap memakai WhatsApp seperti biasa di ponsel. Karena ini bukan fitur resmi WhatsApp, WhatsApp bisa sewaktu-waktu membatasi akun; Anda bisa mencabut tautan kapan saja.</p>
      </section>
      {notice && <Note text={NOTICES[notice]} />}
      <form onSubmit={submit} className={`${box} flex flex-col gap-3`}>
        <h2 className="flex items-center gap-2 font-medium">
          <Phone aria-hidden="true" className="h-[18px] w-[18px] text-leaf" /> Pakai satu ponsel
        </h2>
        <p className="text-[15px] leading-relaxed text-moss">Masukkan nomor WhatsApp Anda, lalu ketik kode yang muncul di WhatsApp. Tidak perlu scan.</p>
        <label className="block text-sm font-medium">
          Nomor WhatsApp
          <input name="phone" type="tel" inputMode="tel" required maxLength={20} autoComplete="tel" placeholder="081234567890" className={input} />
        </label>
        <button className={primary} type="submit" disabled={busy}>
          Dapatkan kode <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </form>
      {onQr && (
        <div className="mt-auto flex flex-col gap-3 border-t border-line pt-5">
          <p className="text-sm text-moss">Punya perangkat lain, misalnya laptop atau ponsel kedua?</p>
          <button type="button" className={secondary} onClick={onQr} disabled={busy}>
            Tampilkan QR
          </button>
        </div>
      )}
    </>
  )
}

/** Copies the code without the dash, which is how WhatsApp's own field takes it. */
function CopyCode({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <>
      <button
        type="button"
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white px-5 py-3 text-[15px] font-semibold text-forest transition hover:brightness-95"
        onClick={() => void copyText(code).then((ok) => setState(ok ? 'copied' : 'failed'))}
      >
        {state === 'copied' ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
        {state === 'copied' ? 'Kode tersalin' : 'Salin kode'}
      </button>
      <p role="status" className={state === 'failed' ? 'mt-2 text-sm text-moss' : 'sr-only'}>
        {state === 'copied' ? 'Kode tersalin' : state === 'failed' ? 'Kode belum bisa disalin. Ketik manual.' : ''}
      </p>
    </>
  )
}

export function CodeScreen({ code, onNewCode }: { code: string; onNewCode: () => void }) {
  return (
    <>
      <section>
        <h1 className={h1}>Masukkan kode ini di WhatsApp</h1>
        <p className={lead}>Kode berlaku beberapa menit. Halaman ini lanjut sendiri setelah perangkat tertaut.</p>
      </section>
      <div className="rounded-2xl bg-mint p-6 text-center">
        <p className="text-sm text-moss">Kode tautan Anda</p>
        <p className="mt-2 text-[34px] font-semibold tracking-[.18em]" aria-label={`Kode tautan ${code.split('').join(' ')}`}>
          {code.slice(0, 4)}-{code.slice(4)}
        </p>
        <CopyCode code={code} />
      </div>
      <div className={box}>
        <NumberedSteps items={['Buka WhatsApp di ponsel ini', 'Ketuk Pengaturan, lalu Perangkat tertaut, lalu Tautkan perangkat', 'Ketuk Tautkan dengan nomor telepon', 'Ketik kode di atas']} />
      </div>
      <button type="button" onClick={onNewCode} className="text-left text-sm font-medium text-forest underline underline-offset-4">
        Kode tidak berfungsi atau sudah kedaluwarsa? Minta kode baru
      </button>
    </>
  )
}

export function QrScreen({ pairing, onUseCode }: { pairing: NonNullable<OnboardingState['pairing']>; onUseCode: () => void }) {
  const waiting = pairing.connection === 'qr_ready' && pairing.qr
  return (
    <>
      <section>
        <h1 className={h1}>{waiting ? 'Scan QR dari perangkat lain' : 'Menyiapkan koneksi'}</h1>
        <p className={lead}>{waiting ? 'QR berlaku beberapa menit dan halaman ini diperbarui otomatis.' : 'Mohon tunggu sebentar.'}</p>
      </section>
      {waiting ? (
        <>
          <div className="rounded-xl border border-line bg-white p-4">
            <img src={pairing.qr!} alt="QR WhatsApp" width={320} height={320} className="mx-auto h-64 w-64" />
          </div>
          <div className={box}>
            <NumberedSteps items={['Buka WhatsApp di ponsel', 'Ketuk Pengaturan, lalu Perangkat tertaut', 'Ketuk Tautkan perangkat dan scan kode ini']} />
          </div>
          <button type="button" onClick={onUseCode} className="text-sm font-medium text-forest underline underline-offset-4">
            Hanya punya satu ponsel? Pakai kode
          </button>
        </>
      ) : pairing.connection === 'logged_out' ? (
        <div className="rounded-2xl bg-mint p-6 text-center">
          <h2 className="font-medium">Sesi WhatsApp keluar</h2>
          <p className="mt-1 text-[15px] text-moss">Kembali beberapa saat lagi untuk mencoba ulang.</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-mint py-10 text-center">
          <Loader2 className="h-9 w-9 animate-spin text-forest" role="status" aria-label="Menyambung" />
          <p className="text-[15px] text-moss">Status koneksi: {pairing.connection}</p>
        </div>
      )}
    </>
  )
}

/** The list could not be fetched although WhatsApp is connected: one calm panel, retried by itself. */
function GroupsUnavailable({ refreshing, retried, onRefresh }: { refreshing: boolean; retried: boolean; onRefresh: () => void }) {
  return (
    <section className="rounded-2xl bg-mint p-6 text-center" role="status" aria-live="polite">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white">
        <RefreshCw aria-hidden="true" className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
      </div>
      <h2 className="mt-4 text-xl font-medium tracking-tight">Daftar grup belum bisa dimuat</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-moss">WhatsApp Anda sudah terhubung, hanya daftar grupnya yang belum bisa diambil. Biasanya pulih dalam beberapa detik, dan halaman ini mencoba lagi sendiri.</p>
      <button type="button" className={`${primary} mt-5`} onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Memuat…' : 'Muat ulang sekarang'}
      </button>
      {retried && !refreshing && <p className="mt-4 text-sm text-moss">Masih belum berhasil. Kalau tetap begini beberapa menit lagi, hubungi tim Aksis.</p>}
    </section>
  )
}

export function Groups({ groups, error, busy, retried, onSave, onRefresh }: { groups: NonNullable<OnboardingState['groups']>; error: string | null; busy: boolean; retried: boolean; onSave: (jids: string[]) => void; onRefresh: () => void }) {
  const { limit, loadFailed } = groups
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(groups.items.filter((group) => group.selected).map((group) => group.jid)))
  const shown = groups.items.filter((group) => group.subject.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (jid: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(jid)) next.delete(jid)
      else if (next.size < limit) next.add(jid)
      return next
    })
  const intro = (
    <section>
      <h1 className={h1}>Pilih grup proyek</h1>
      <p className={lead}>Pilih maksimal {limit} grup yang boleh dibaca Aksis. Aksis hanya membaca dan tidak pernah mengirim pesan ke grup. Grup lain diabaikan.</p>
      <p className="mt-2 text-sm leading-relaxed text-moss">WhatsApp mengirim riwayat 7 hari terakhir saat ditautkan. Aksis hanya menyimpan riwayat dari grup yang Anda pilih; riwayat grup lain dihapus saat Anda menyimpan pilihan.</p>
    </section>
  )

  // Nothing to search, pick or save yet, so none of those controls are shown.
  if (loadFailed) {
    return (
      <>
        {intro}
        <GroupsUnavailable refreshing={busy} retried={retried} onRefresh={onRefresh} />
      </>
    )
  }

  return (
    <>
      {intro}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-moss" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" aria-label="Cari grup" placeholder="Cari grup" autoComplete="off" className="w-full rounded-lg border border-line bg-white py-3 pl-10 pr-4 text-[15px] outline-none focus:border-leaf focus:ring-2 focus:ring-leaf/30" />
        </div>
        <span className="shrink-0 rounded-full bg-mint px-3 py-1.5 text-sm font-medium" aria-live="polite">
          {picked.size} / {limit}
        </span>
      </div>
      {error && <Note text={error} />}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {shown.map((group: Group) => {
            const on = picked.has(group.jid)
            const locked = !on && picked.size >= limit
            return (
              <li key={group.jid}>
                <button type="button" role="checkbox" aria-checked={on} onClick={() => toggle(group.jid)} disabled={locked} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-45 ${on ? 'border-leaf bg-mint' : 'border-line bg-white hover:bg-paper'}`}>
                  <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-mint text-sm font-semibold">
                    {group.subject.trim().slice(0, 2).toUpperCase() || '#'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{group.subject}</span>
                    {group.participants ? <span className="block text-sm text-moss">{group.participants} anggota</span> : null}
                  </span>
                  <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${on ? 'border-leaf bg-leaf text-white' : 'border-moss text-transparent'}`}>
                    <Check className="h-4 w-4" />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-line bg-white p-5 text-center text-[15px] text-moss">{groups.items.length === 0 ? 'Tidak ada grup ditemukan. Anda bisa melanjutkan tanpa grup.' : 'Tidak ada grup yang cocok.'}</p>
      )}
      <div className="sticky bottom-4 mt-auto pt-2">
        <button className={primary} type="button" disabled={busy} onClick={() => onSave([...picked])}>
          Simpan dan selesai <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}

/** WhatsApp is connected; an admin chooses the plan, then the page moves on to the groups by itself (Onboarding.tsx polls). */
export function PlanWaiting() {
  return (
    <>
      <section>
        <Mascot />
        <h1 className={`${h1} mt-4`}>Menyiapkan paket Anda</h1>
        <p className={lead}>WhatsApp Anda sudah tersambung. Tim Aksis sedang menyiapkan paket Anda. Halaman ini lanjut sendiri ke pemilihan grup, biasanya dalam beberapa menit.</p>
      </section>
      <ul className="border-t border-line">
        <li className="flex items-center gap-3 border-b border-line py-3.5">
          <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-leaf text-white">
            <Check className="h-4 w-4" />
          </span>
          <span className="font-medium">WhatsApp terhubung</span>
        </li>
        <li className="flex items-center gap-3 border-b border-line py-3.5 text-moss">
          <span aria-hidden="true" className="h-6 w-6 animate-pulse rounded-full border-2 border-line" />
          <span>Paket disiapkan</span>
        </li>
      </ul>
      <p className="text-sm text-moss">Tidak perlu melakukan apa pun. Begitu paket siap, halaman ini lanjut sendiri dan tim Aksis juga memberi tahu lewat WhatsApp.</p>
    </>
  )
}

export function Done({ tenantName, contactName, install }: { tenantName: string; contactName: string | null; install?: ReactNode }) {
  const items = ['Profil studio', 'WhatsApp terhubung', 'Grup proyek dipilih', 'Akun aktif']
  return (
    <>
      <section className="rounded-2xl bg-lime p-6">
        <Mascot size={64} />
        <h1 className="mt-4 text-[28px] font-medium leading-tight tracking-tight">Akun Anda aktif</h1>
        <p className="mt-2 text-[15px] leading-relaxed">
          Terima kasih, {contactName ?? 'Anda'}. {tenantName} sudah siap dipakai.
        </p>
      </section>
      <ul className="border-t border-line">
        {items.map((label) => (
          <li key={label} className="flex items-center gap-3 border-b border-line py-3.5">
            <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-leaf text-white">
              <Check className="h-4 w-4" />
            </span>
            <span className="font-medium">{label}</span>
          </li>
        ))}
      </ul>
      <section className="rounded-2xl bg-mint p-5">
        <h2 className="font-medium">Apa selanjutnya?</h2>
        <p className="mt-1 text-[15px] leading-relaxed text-moss">Pasang Aksis di layar utama, lalu masuk dengan nomor WhatsApp yang baru Anda tautkan. Kode masuk dikirim lewat WhatsApp dari nomor Aksis, jadi simpan nomor itu di kontak Anda.</p>
      </section>
      {install && (
        <>
          <section>
            <h2 className="text-lg font-medium tracking-tight">Pasang Aksis sekarang</h2>
            <p className={lead}>Setelah terpasang, buka Aksis dari ikonnya, masukkan nomor WhatsApp Anda, dan kode masuk akan dikirim lewat WhatsApp.</p>
          </section>
          {install}
        </>
      )}
    </>
  )
}
