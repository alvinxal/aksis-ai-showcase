// Day labels for the chat, as in WhatsApp: "Hari ini", "Kemarin", the weekday within the last week, else the date.
// Days are Jakarta days, whatever time zone the phone is set to.
const ZONE = 'Asia/Jakarta'
const keyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
const weekdayFormat = new Intl.DateTimeFormat('id-ID', { timeZone: ZONE, weekday: 'long' })
const dateFormat = new Intl.DateTimeFormat('id-ID', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric' })
const dayMonthFormat = new Intl.DateTimeFormat('id-ID', { timeZone: ZONE, day: 'numeric', month: 'short' })
const DAY_MS = 86_400_000

/** "2026-11-02": the Jakarta calendar day of a moment. */
export const dayKey = (value: string | Date): string => keyFormat.format(typeof value === 'string' ? new Date(value) : value)

const dayNumber = (key: string): number => Date.parse(`${key}T00:00:00Z`) / DAY_MS

export function dayLabel(value: string, now: Date = new Date()): string {
  const date = new Date(value)
  const gap = dayNumber(dayKey(now)) - dayNumber(dayKey(date))
  if (gap === 0) return 'Hari ini'
  if (gap === 1) return 'Kemarin'
  if (gap > 1 && gap < 7) return weekdayFormat.format(date)
  return dateFormat.format(date)
}

/** The badge that slides in while scrolling also names the date: "Hari ini, 2 Nov", "Kemarin, 1 Nov", "Jumat, 30 Okt"; older days already are dates. */
export function dayLabelWithDate(value: string, now: Date = new Date()): string {
  const label = dayLabel(value, now)
  const gap = dayNumber(dayKey(now)) - dayNumber(dayKey(new Date(value)))
  return gap >= 0 && gap < 7 ? `${label}, ${dayMonthFormat.format(new Date(value))}` : label
}
