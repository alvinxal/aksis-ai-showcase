/** Usage reports are cut on Jakarta calendar days (UTC+7, no DST). */
const WIB_OFFSET_MS = 7 * 3_600_000
const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366

export type UsageRange = {
  /** Inclusive start. */
  from: Date
  /** Exclusive end. */
  to: Date
  /** Stable id that fits in Telegram callback data: d<n> or YYYY-MM-DD_YYYY-MM-DD. */
  key: string
  label: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

function startOfWibDay(ms: number): number {
  return Math.floor((ms + WIB_OFFSET_MS) / DAY_MS) * DAY_MS - WIB_OFFSET_MS
}

function wibDate(ms: number): string {
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10)
}

function dayLabel(ms: number): string {
  const date = new Date(ms + WIB_OFFSET_MS)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** `d1` = today, `d7` = today and the 6 days before it, and so on (1–90). */
export function presetRange(days: number, now: Date): UsageRange | null {
  if (!Number.isInteger(days) || days < 1 || days > 90) return null
  const from = startOfWibDay(now.getTime()) - (days - 1) * DAY_MS
  return {
    from: new Date(from),
    to: now,
    key: `d${days}`,
    label: days === 1 ? `Hari ini (${dayLabel(now.getTime())})` : `${days} hari terakhir`,
  }
}

function dayStart(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day) - WIB_OFFSET_MS
  const check = new Date(ms + WIB_OFFSET_MS)
  // Rejects 31 Feb and similar: the date must survive the round trip.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  return ms
}

/** Inclusive calendar dates in WIB; `to` is clipped to now so future days add nothing. */
export function customRange(
  start: { year: number; month: number; day: number },
  end: { year: number; month: number; day: number },
  now: Date,
): UsageRange | null {
  const from = dayStart(start.year, start.month, start.day)
  const lastDay = dayStart(end.year, end.month, end.day)
  if (from === null || lastDay === null || lastDay < from) return null
  if (from > now.getTime()) return null
  if ((lastDay - from) / DAY_MS + 1 > MAX_RANGE_DAYS) return null
  const to = Math.min(lastDay + DAY_MS, now.getTime())
  const same = from === lastDay
  return {
    from: new Date(from),
    to: new Date(to),
    key: `${wibDate(from)}_${wibDate(lastDay)}`,
    label: same ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(lastDay)}`,
  }
}

export function rangeFromKey(key: string, now: Date): UsageRange | null {
  const preset = /^d(\d{1,2})$/.exec(key)
  if (preset) return presetRange(Number(preset[1]), now)
  const custom = /^(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!custom) return null
  const [, y1, m1, d1, y2, m2, d2] = custom.map(Number) as [number, number, number, number, number, number, number]
  return customRange({ year: y1, month: m1, day: d1 }, { year: y2, month: m2, day: d2 }, now)
}

/**
 * Parses what an admin types: "2026-10-01 2026-10-15", "01/10/2026 - 15/10/2026",
 * or a single date for one day.
 */
export function parseTypedRange(text: string, now: Date): UsageRange | null {
  const dates: Array<{ year: number; month: number; day: number }> = []
  for (const match of text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/g)) {
    if (match[1]) dates.push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) })
    else dates.push({ year: Number(match[6]), month: Number(match[5]), day: Number(match[4]) })
  }
  if (dates.length === 1) return customRange(dates[0]!, dates[0]!, now)
  if (dates.length === 2) return customRange(dates[0]!, dates[1]!, now)
  return null
}

/** Start of the current Jakarta calendar month. */
export function monthStart(now: Date): Date {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS)
  return new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), 1) - WIB_OFFSET_MS)
}

export function startOfWibDayDate(now: Date): Date {
  return new Date(startOfWibDay(now.getTime()))
}

export function wibDateString(now: Date): string {
  return wibDate(now.getTime())
}
