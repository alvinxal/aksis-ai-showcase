/** Digits with country code, or null. Indonesian local numbers (08...) become 628... */
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let digits = value.replace(/[\s().-]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  else if (digits.startsWith('0')) digits = `62${digits.slice(1)}`
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}

/** "Studio Satu 0812-3456-7890" -> { name: "Studio Satu", phone: "6281234567890" }; a name alone has no phone. */
export function splitNameAndPhone(text: string): { name: string; phone: string | null } {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const last = words.length > 1 ? words[words.length - 1] : undefined
  const phone = last ? normalizePhone(last) : null
  return phone ? { name: words.slice(0, -1).join(' '), phone } : { name: words.join(' '), phone: null }
}

/**
 * A wa.me link that opens WhatsApp with a message ready to send. With a `phone` (digits with country code)
 * the chat is already chosen; without one WhatsApp asks which contact to send it to.
 */
export function whatsappLink(phone: string | null, text: string): string {
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`
}
