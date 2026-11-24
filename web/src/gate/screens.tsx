import { Check, Copy, Share, SquarePlus } from 'lucide-react'
import { useState } from 'react'
import { copyText } from '../clipboard'
import { OnboardingFrame, Mascot, NumberedSteps, Note, h1, lead, primary, secondary } from '../onboarding/screens'
import type { Device } from './device'
import { useInstall } from './install'

export function DesktopBlocked() {
  return (
    <OnboardingFrame>
      <section className="my-auto rounded-2xl bg-mint p-6 text-center">
        <div className="mx-auto w-fit">
          <Mascot size={72} />
        </div>
        <h1 className="mt-4 text-xl font-medium tracking-tight">Aksis dibuka dari ponsel</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-moss">Aksis dirancang untuk dipakai di ponsel. Buka link yang dikirim ke WhatsApp Anda dari ponsel Anda.</p>
        <p className="mt-4 text-sm text-moss">Komputer dan tablet belum didukung.</p>
      </section>
    </OnboardingFrame>
  )
}

function CopyAddress() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={secondary}
      onClick={() => {
        void copyText(window.location.href).then((ok) => setCopied(ok))
      }}
    >
      {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      {copied ? 'Alamat tersalin' : 'Salin alamat halaman ini'}
    </button>
  )
}

const inline = 'inline h-4 w-4 -translate-y-px align-middle'

/** Install button on Android, or the step list for the browser at hand; shared by the gate and the end of onboarding. */
export function InstallGuide({ device }: { device: Device }) {
  const { canPrompt, installed, install } = useInstall()
  const android = device.os === 'android'
  const stepsIos = [
    <>Ketuk ikon <b className="font-semibold">Bagikan</b> <Share aria-hidden="true" className={inline} /> di bagian bawah Safari</>,
    <>Gulir ke bawah, lalu pilih <b className="font-semibold">Tambah ke Layar Utama</b> <SquarePlus aria-hidden="true" className={inline} /></>,
    <>Ketuk <b className="font-semibold">Tambah</b> di pojok kanan atas</>,
    'Buka Aksis dari ikonnya di layar utama',
  ]
  const stepsAndroid = [
    <>Ketuk menu <b className="font-semibold">⋮</b> di pojok kanan atas Chrome</>,
    <>Pilih <b className="font-semibold">Instal aplikasi</b> (atau <b className="font-semibold">Tambahkan ke layar utama</b>)</>,
    <>Ketuk <b className="font-semibold">Pasang</b></>,
    'Buka Aksis dari ikonnya di layar utama',
  ]

  return (
    <>
      {device.inApp && (
        <>
          <Note text={`Anda membuka halaman ini di dalam aplikasi lain. Buka dulu di ${android ? 'Chrome' : 'Safari'}, karena aplikasi ini tidak bisa memasang Aksis.`} />
          <CopyAddress />
        </>
      )}

      {installed ? (
        <section className="rounded-2xl bg-lime p-5" role="status">
          <h2 className="font-medium">Aksis sudah terpasang</h2>
          <p className="mt-1 text-[15px] leading-relaxed">Tutup halaman ini, lalu buka Aksis dari ikonnya di layar utama.</p>
        </section>
      ) : (
        <>
          {android && canPrompt && !device.inApp && (
            <button type="button" className={primary} onClick={() => void install()}>
              Pasang sekarang
            </button>
          )}
          {(!android || !canPrompt || device.inApp) && (
            <div className="rounded-xl border border-line bg-white p-5">
              <h2 className="mb-3 font-medium">Cara memasang</h2>
              <NumberedSteps items={android ? stepsAndroid : stepsIos} />
            </div>
          )}
        </>
      )}
    </>
  )
}

export function InstallGate({ device }: { device: Device }) {
  return (
    <OnboardingFrame>
      <section>
        <Mascot size={64} />
        <h1 className={`${h1} mt-4`}>Pasang Aksis di ponsel Anda</h1>
        <p className={lead}>Aksis dipakai sebagai aplikasi: terbuka dari layar utama, dan bisa mengirim pengingat tenggat dan tagihan. Pemasangannya hanya sebentar.</p>
      </section>

      <InstallGuide device={device} />

      <p className="mt-auto text-sm leading-relaxed text-moss">Sesudah terpasang, selalu buka Aksis dari ikonnya di layar utama, bukan dari halaman ini.</p>
    </OnboardingFrame>
  )
}
