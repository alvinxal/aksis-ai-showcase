import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, leadApi } from '../api'
import { Note, input, primary } from '../onboarding/screens'

const ERRORS: Record<string, string> = {
  invalid_name: 'Isi nama Anda dulu.',
  invalid_phone: 'Nomor belum benar. Tulis nomor WhatsApp lengkap, misalnya 081234567890.',
  terms_required: 'Centang persetujuan dulu untuk melanjutkan.',
  too_many: 'Permintaan sudah masuk. Kami akan menghubungi Anda, tidak perlu mengirim ulang.',
}
const FAILED = 'Permintaan belum terkirim. Coba lagi sebentar lagi.'

/** The public "Dapatkan akses" form: name and the WhatsApp number that will be linked. We contact them next. */
export function RequestAccess() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      await leadApi.submit({
        name: String(form.get('name') ?? ''),
        phone: String(form.get('phone') ?? ''),
        terms: form.get('terms') === 'on',
        website: String(form.get('website') ?? ''),
      })
      setSent(true)
    } catch (caught) {
      setError(caught instanceof ApiError ? (ERRORS[caught.code] ?? FAILED) : FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-paper text-forest">
      <header className="mx-auto flex max-w-md items-center justify-between px-5 py-5">
        <Link to="/">
          <img src="/logo-lockup.svg" alt="Aksis AI" className="h-7 w-auto" />
        </Link>
      </header>
      <main className="mx-auto flex max-w-md flex-col gap-5 px-5 pb-16">
        {sent ? (
          <section className="flex flex-col gap-3 rounded-xl border border-line bg-white p-6">
            <CheckCircle2 aria-hidden="true" className="h-8 w-8 text-leaf" />
            <h1 className="text-[24px] font-medium leading-tight tracking-tight">Terima kasih, permintaan Anda sudah masuk</h1>
            <p className="text-[15px] leading-relaxed text-moss">Kami akan menghubungi Anda lewat WhatsApp dalam 1–2 hari kerja.</p>
            <Link to="/" className="mt-2 text-sm font-medium underline underline-offset-4">Kembali ke beranda</Link>
          </section>
        ) : (
          <>
            <section>
              <h1 className="text-[28px] font-medium leading-tight tracking-tight">Dapatkan akses Aksis AI</h1>
              <p className="mt-2 text-[15px] leading-relaxed text-moss">
                Isi nama dan nomor WhatsApp Anda. Tim kami akan menghubungi Anda untuk mengenalkan Aksis dan menyiapkan akses.
              </p>
            </section>
            {error && <Note text={error} />}
            <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 rounded-xl border border-line bg-white p-5">
              <label className="block text-sm font-medium">
                Nama Anda
                <input name="name" required minLength={2} maxLength={80} autoComplete="name" placeholder="Contoh: Dewi Lestari" className={input} />
              </label>
              <label className="block text-sm font-medium">
                Nomor WhatsApp
                <input name="phone" type="tel" inputMode="tel" required maxLength={20} autoComplete="tel" placeholder="081234567890" className={input} />
                <span className="mt-1.5 block text-[13px] font-normal leading-relaxed text-moss">
                  Pakai nomor yang akan Anda tautkan ke Aksis, yaitu nomor WhatsApp yang dipakai untuk grup proyek Anda.
                </span>
              </label>
              {/* A field people never see: bots fill it in, and the server then drops the request. */}
              <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                <label>
                  Website
                  <input name="website" type="text" tabIndex={-1} autoComplete="off" />
                </label>
              </div>
              <label className="flex items-start gap-3 text-sm leading-relaxed">
                <input name="terms" type="checkbox" required className="mt-1 h-4 w-4 shrink-0 accent-leaf" />
                <span>
                  Saya setuju nama dan nomor saya dipakai untuk dihubungi tim Aksis, sesuai{' '}
                  <a href="/privacy" target="_blank" rel="noopener" className="font-medium underline underline-offset-4">Kebijakan Privasi</a>.
                </span>
              </label>
              <button className={primary} type="submit" disabled={busy}>
                Kirim permintaan <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  )
}
