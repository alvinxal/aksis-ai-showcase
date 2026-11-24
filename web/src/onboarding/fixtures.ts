// Sample states for `vite dev` only: /onboarding?mock=<name> renders a screen without a backend.
import type { Group, OnboardingState } from '../api'

const GROUPS: Group[] = [
  { jid: 'g1', subject: 'Rumah Budi', participants: 6, selected: false },
  { jid: 'g2', subject: 'Villa Sanur', participants: 9, selected: false },
  { jid: 'g3', subject: 'Kantor Aksara', participants: 5, selected: false },
  { jid: 'g4', subject: 'Renovasi Ibu Dewi', participants: 4, selected: false },
  { jid: 'g5', subject: 'Keluarga Besar', participants: 38, selected: false },
  { jid: 'g6', subject: 'Tukang dan Supplier', participants: 12, selected: false },
  { jid: 'g7', subject: 'Alumni Arsitektur', participants: 120, selected: false },
]

const base = { tenantName: 'Studio Aksara', contactName: null, pairing: null, groups: null }

// A plain placeholder image stands in for the QR code that the server renders.
const QR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><rect width="25" height="25" fill="#fff"/>' +
      Array.from({ length: 625 }, (_, i) => ((i * 7 + (i % 25) * 3) % 5 < 3 ? `<rect x="${i % 25}" y="${Math.floor(i / 25)}" width="1" height="1" fill="#12201A"/>` : '')).join('') +
      '</svg>',
  )

export const FIXTURES: Record<string, OnboardingState> = {
  profile: { ...base, step: 'profile' },
  whatsapp: { ...base, contactName: 'Dewi', step: 'whatsapp' },
  qr: { ...base, contactName: 'Dewi', step: 'pairing', pairing: { connection: 'qr_ready', qr: QR, pairingCode: null } },
  connecting: { ...base, contactName: 'Dewi', step: 'pairing', pairing: { connection: 'connecting', qr: null, pairingCode: null } },
  loggedout: { ...base, contactName: 'Dewi', step: 'pairing', pairing: { connection: 'logged_out', qr: null, pairingCode: null } },
  code: { ...base, contactName: 'Dewi', step: 'pairing', pairing: { connection: 'qr_ready', qr: QR, pairingCode: 'ABCD1234' } },
  plan: { ...base, contactName: 'Dewi', step: 'plan' },
  groups: { ...base, contactName: 'Dewi', step: 'groups', groups: { items: GROUPS, limit: 3, loadFailed: false } },
  'groups-failed': { ...base, contactName: 'Dewi', step: 'groups', groups: { items: [], limit: 3, loadFailed: true } },
  done: { ...base, contactName: 'Dewi', step: 'done' },
}
