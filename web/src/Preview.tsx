import { Link } from 'react-router-dom'

const SCREENS = [
  ['Landing', '/'],
  ['Onboarding: profil', '/onboarding?mock=profile'],
  ['Onboarding: WhatsApp (pilih cara)', '/onboarding?mock=whatsapp'],
  ['Onboarding: QR', '/onboarding?mock=qr'],
  ['Onboarding: menyambung', '/onboarding?mock=connecting'],
  ['Onboarding: sesi keluar', '/onboarding?mock=loggedout'],
  ['Onboarding: kode tautan', '/onboarding?mock=code'],
  ['Onboarding: pilih grup', '/onboarding?mock=groups'],
  ['Onboarding: daftar grup gagal', '/onboarding?mock=groups-failed'],
  ['Onboarding: selesai', '/onboarding?mock=done'],
  ['Link undangan tidak valid', '/onboarding?mock=invalid'],
  ['Gerbang: desktop (hanya ponsel)', '/app?device=desktop'],
  ['Gerbang: pasang di Android', '/app?device=android'],
  ['Gerbang: pasang di iPhone', '/app?device=ios'],
  ['Gerbang: iPhone, dibuka dari dalam WhatsApp', '/app?device=ios-inapp'],
  ['Gerbang: sudah terpasang (lolos)', '/app?device=installed'],
  ['Onboarding dibuka di desktop', '/onboarding?mock=profile&device=desktop'],
  ['Sesi tidak ditemukan', '/onboarding?mock=session'],
  ['Masuk: nomor', '/preview/masuk'],
  ['Masuk: kode (salah)', '/preview/masuk-kode'],
  ['Apps: daftar chat', '/app'],
  ['Apps: chat Aksis', '/app/chat/aksis'],
  ['Apps: chat Finance', '/app/chat/finance'],
  ['Apps: proyek', '/app/proyek'],
  ['Apps: detail proyek (ada yang perlu dikerjakan)', '/app/proyek/p1'],
  ['Apps: detail proyek (semua aman)', '/app/proyek/p2'],
  ['Apps: pengaturan', '/app/pengaturan'],
] as const

export function Preview() {
  return (
    <div className="mx-auto max-w-md px-5 py-8">
      <h1 className="text-2xl font-extrabold">Semua layar</h1>
      <p className="mt-1 text-sm text-ink-soft">Halaman bantu untuk desain. Data masih contoh.</p>
      <ul className="mt-5 flex flex-col gap-2">
        {SCREENS.map(([label, to]) => (
          <li key={to}>
            <Link to={to} className="card flex items-center justify-between py-3 text-sm font-medium">
              {label}
              <span className="text-xs text-ink-mute">{to}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
