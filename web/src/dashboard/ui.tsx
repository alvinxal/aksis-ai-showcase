import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { DashInvite } from '../api'
import { copyText } from '../clipboard'
import { when } from './format'

export const card = 'rounded-xl bg-white p-4 shadow-card sm:p-5'
export const button = 'rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50'

export function InviteResult({ invite, onClose }: { invite: DashInvite; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const message = `Halo ${invite.name}, ini undangan Aksis AI Anda: ${invite.link} (berlaku sampai ${when(invite.expiresAt)}, sekali pakai).`
  return (
    <section className={`${card} border border-brand-500`}>
      <p className="font-semibold">Undangan untuk {invite.name}</p>
      <p className="mt-1 break-all text-sm">{invite.link}</p>
      <p className="mt-1 text-xs text-ink-soft">Berlaku sampai {when(invite.expiresAt)}, sekali pakai. Tautan ini tidak ditampilkan lagi setelah ditutup.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={`${button} bg-brand-500 text-white`} onClick={() => void copyText(invite.link).then(setCopied)}>{copied ? 'Tersalin' : 'Salin tautan'}</button>
        <a href={`https://wa.me/${invite.phone ?? ''}?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className={`${button} bg-surface`}>Kirim lewat WhatsApp</a>
        <Link to={`/dashboard/pelanggan/${invite.tenantId}`} className={`${button} bg-surface`}>Lihat pelanggan</Link>
        <button type="button" className={`${button} bg-surface`} onClick={onClose}>Tutup</button>
      </div>
    </section>
  )
}

