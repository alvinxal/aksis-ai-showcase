const zone = 'Asia/Jakarta'
const dateTime = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone })
const dateOnly = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: zone })
const dayMonth = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: zone })
const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

export const usd = (value: number): string => `$${value.toFixed(value >= 10 ? 2 : 3)}`
export const idr = (value: number): string => rupiah.format(value)
export const when = (iso: string | null): string => (iso ? dateTime.format(new Date(iso)) : '-')
export const day = (iso: string | null): string => (iso ? dateOnly.format(new Date(iso)) : '-')
/** "2026-11-02" (a Jakarta day) as "2 Nov". */
export const shortDay = (key: string): string => dayMonth.format(new Date(`${key}T12:00:00+07:00`))

export const TENANT_STATUS: Record<string, string> = { invited: 'Diundang', onboarding: 'Onboarding', active: 'Aktif', disabled: 'Nonaktif' }
export const SUBSCRIPTION_STATUS: Record<string, string> = { pending: 'Belum mulai', trial: 'Uji coba', active: 'Berlangganan', grace: 'Masa tenggang', expired: 'Berakhir' }
export const CONNECTION: Record<string, string> = {
  connected: 'Tersambung',
  connecting: 'Menyambung',
  qr_ready: 'Menunggu pairing',
  logged_out: 'Keluar dari WhatsApp',
  error: 'Error',
  disabled: 'Mati',
}
export const REQUEST_STATUS: Record<string, string> = { new: 'Baru', contacted: 'Sudah dihubungi' }

export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days > 0 ? `${days} hari ${hours} jam` : hours > 0 ? `${hours} jam ${minutes} menit` : `${minutes} menit`
}
