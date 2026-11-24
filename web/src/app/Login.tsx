import { ArrowRight } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Outlet } from 'react-router-dom'
import { ApiError, authApi, projectsApi, type Me } from '../api'
import { LoadFailed, Loading, Note, OnboardingFrame, h1, input, lead, primary, secondary } from '../onboarding/screens'

type Notice = 'phone' | 'code' | 'many' | 'failed'

const NOTICES: Record<Notice, string> = {
  phone: 'Nomor tidak valid. Tulis nomor WhatsApp lengkap, misalnya 081234567890.',
  code: 'Kode salah atau sudah kedaluwarsa. Minta kode baru bila perlu.',
  many: 'Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.',
  failed: 'Belum bisa diproses. Coba lagi sebentar lagi.',
}

const noticeFor = (caught: unknown, fallback: Notice): Notice => {
  if (caught instanceof ApiError) {
    if (caught.status === 429) return 'many'
    if (caught.code === 'invalid_phone') return 'phone'
    if (caught.code === 'invalid_code') return 'code'
  }
  return fallback
}

export function PhoneStep({ notice, busy, onSubmit }: { notice: Notice | null; busy: boolean; onSubmit: (phone: string) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(String(new FormData(event.currentTarget).get('phone') ?? ''))
  }
  return (
    <>
      <section>
        <h1 className={h1}>Masuk ke Aksis</h1>
        <p className={lead}>Masukkan nomor WhatsApp yang tertaut ke akun Anda. Kode masuk dikirim ke chat WhatsApp Anda sendiri.</p>
      </section>
      {notice && <Note text={NOTICES[notice]} />}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="block text-sm font-medium">
          Nomor WhatsApp
          <input name="phone" type="tel" inputMode="tel" required maxLength={20} autoComplete="tel" placeholder="081234567890" className={input} />
        </label>
        <button className={primary} type="submit" disabled={busy}>
          Kirim kode <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </form>
    </>
  )
}

const SHORT_WAIT_SECONDS = 60

/** Seconds left until `until` (ms since epoch), counting down once a second. */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/** Short waits count down to the next code; a long one means the 3 requests are used up. */
export function ResendLabel({ seconds }: { seconds: number }) {
  if (seconds <= 0) return <>Kirim ulang kode</>
  if (seconds <= SHORT_WAIT_SECONDS) return <>Kirim ulang kode dalam {clockText(seconds)}</>
  return <>Coba lagi dalam {Math.ceil(seconds / 60)} menit</>
}

export function CodeStep({ notice, busy, waitUntil = null, onSubmit, onResend, onBack }: { notice: Notice | null; busy: boolean; waitUntil?: number | null; onSubmit: (code: string) => void; onResend: () => void; onBack: () => void }) {
  const left = useCountdown(waitUntil)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(String(new FormData(event.currentTarget).get('code') ?? ''))
  }
  return (
    <>
      <section>
        <h1 className={h1}>Masukkan kode</h1>
        <p className={lead}>Buka WhatsApp, lalu lihat chat dengan diri sendiri. Jika nomor ini terdaftar sebagai pelanggan aktif, kode 6 digit ada di sana. Kode berlaku 5 menit. Kode baru bisa diminta maksimal 3 kali dalam 15 menit, jadi bila belum datang, tunggu sebentar sebelum meminta lagi.</p>
      </section>
      {notice && <Note text={NOTICES[notice]} />}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="block text-sm font-medium">
          Kode masuk
          <input name="code" type="text" inputMode="numeric" required maxLength={7} autoComplete="one-time-code" autoFocus placeholder="123456" className={`${input} text-center text-2xl tracking-[.3em]`} />
        </label>
        <button className={primary} type="submit" disabled={busy}>
          Masuk
        </button>
        <button type="button" className={secondary} onClick={onResend} disabled={busy || left > 0}>
          <ResendLabel seconds={left} />
        </button>
        {left > SHORT_WAIT_SECONDS && <p className="text-sm text-ink-soft">Kode sudah diminta 3 kali. Pakai kode terakhir di WhatsApp, atau tunggu sampai waktunya habis.</p>}
      </form>
      <button type="button" onClick={onBack} className="text-left text-sm font-medium text-forest underline underline-offset-4">
        Ganti nomor
      </button>
    </>
  )
}

export type SessionContext = { me: Me; logout: () => Promise<void> }

/** Asks for a login code until /v1/me knows the person, then shows the app routes inside it. */
export function SessionGate() {
  const [session, setSession] = useState<'checking' | 'out' | 'in' | 'failed'>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [waitUntil, setWaitUntil] = useState<number | null>(null)

  const check = useCallback(() => {
    setSession('checking')
    authApi
      .me()
      .then((value) => {
        setMe(value)
        setSession('in')
      })
      .catch((caught: unknown) => setSession(caught instanceof ApiError && caught.status === 401 ? 'out' : 'failed'))
  }, [])
  useEffect(check, [check])
  // Once per visit to the app: let the server fill the project notes so chat and projects start with context.
  useEffect(() => {
    if (session === 'in') projectsApi.refresh().catch(() => undefined)
  }, [session])

  const run = async (task: () => Promise<void>, fallback: Notice) => {
    setBusy(true)
    setNotice(null)
    try {
      await task()
    } catch (caught) {
      setNotice(noticeFor(caught, fallback))
    } finally {
      setBusy(false)
    }
  }

  const ask = (number: string) => run(async () => {
    const answer = await authApi.requestCode(number)
    setWaitUntil(answer.retryAfter ? Date.now() + answer.retryAfter * 1000 : null)
    setPhone(number)
  }, 'failed')

  if (session === 'in' && me) {
    const context: SessionContext = {
      me,
      logout: async () => {
        await authApi.logout()
        setMe(null)
        setPhone(null)
        setSession('out')
      },
    }
    return <Outlet context={context} />
  }

  return (
    <OnboardingFrame>
      {session === 'checking' && <Loading />}
      {session === 'failed' && <LoadFailed onRetry={check} />}
      {session === 'out' && !phone && <PhoneStep notice={notice} busy={busy} onSubmit={(number) => void ask(number)} />}
      {session === 'out' && phone && (
        <CodeStep
          notice={notice}
          busy={busy}
          waitUntil={waitUntil}
          onSubmit={(code) => void run(async () => {
            await authApi.verify(phone, code)
            check()
          }, 'code')}
          onResend={() => void ask(phone)}
          onBack={() => {
            setPhone(null)
            setNotice(null)
          }}
        />
      )}
    </OnboardingFrame>
  )
}
