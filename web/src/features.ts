/**
 * Pairing with a QR code (for a second device) is hidden for now: onboarding links WhatsApp with a code
 * typed on the same phone. The QR screens and the /v1/onboarding/whatsapp/start endpoint stay in place;
 * set this to true to offer the QR again (the preview still shows it at /onboarding?mock=qr).
 */
export const QR_PAIRING = false
