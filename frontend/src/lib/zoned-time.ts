// Wall-clock arithmetic in an IANA timezone (the settings timezone) without a
// date library. Calendar days are 'YYYY-MM-DD' keys; instants are Dates.

export interface WallTime {
  year: number
  /** 1–12 */
  month: number
  day: number
  hour: number
  minute: number
}

export interface ZonedParts extends WallTime {
  second: number
  /** Monday 0 … Sunday 6 */
  weekday: number
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, format)
  }
  return format
}

export function zonedParts(instant: Date | number, timeZone: string): ZonedParts {
  const values: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(instant)) values[part.type] = part.value
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    // Some engines still print midnight as 24 under h23.
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAYS.indexOf(values.weekday ?? ''),
  }
}

function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** When a wall-clock time happens in timeZone. A time skipped by DST moves forward. */
export function zonedInstant(wall: WallTime, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const first = asUtc - offsetAt(asUtc, timeZone)
  const second = asUtc - offsetAt(first, timeZone)
  return new Date(first === second ? first : Math.max(first, second))
}

const pad = (value: number) => String(value).padStart(2, '0')

export function toDateKey(wall: Pick<WallTime, 'year' | 'month' | 'day'>): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
}

export function parseDateKey(key: string): Pick<WallTime, 'year' | 'month' | 'day'> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

function utcDate(key: string): Date {
  const parts = parseDateKey(key)
  if (!parts) throw new Error(`Invalid date key: ${key}`)
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
}

export function addDays(key: string, days: number): string {
  const date = utcDate(key)
  date.setUTCDate(date.getUTCDate() + days)
  return toDateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() })
}

export function addMonths(key: string, months: number): string {
  const { year, month } = parseDateKey(key)!
  const date = new Date(Date.UTC(year, month - 1 + months, 1))
  return toDateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 })
}

/** Monday 0 … Sunday 6 */
export function weekdayOf(key: string): number {
  return (utcDate(key).getUTCDay() + 6) % 7
}

export function startOfWeek(key: string): string {
  return addDays(key, -weekdayOf(key))
}

export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 864e5)
}

export function dateKeyOf(instant: Date | number, timeZone: string): string {
  return toDateKey(zonedParts(instant, timeZone))
}

export function todayKey(timeZone: string): string {
  return dateKeyOf(Date.now(), timeZone)
}

/** Midnight starting the calendar day in timeZone. */
export function dayStart(key: string, timeZone: string): Date {
  return zonedInstant({ ...parseDateKey(key)!, hour: 0, minute: 0 }, timeZone)
}

/** Minutes past midnight on the wall clock. */
export function minuteOfDay(instant: Date | number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  return parts.hour * 60 + parts.minute
}

/** A wall-clock day and minute in timeZone, as an instant. */
export function atMinute(key: string, minutes: number, timeZone: string): Date {
  const extraDays = Math.floor(minutes / 1440)
  const day = parseDateKey(addDays(key, extraDays))!
  const rest = minutes - extraDays * 1440
  return zonedInstant({ ...day, hour: Math.floor(rest / 60), minute: rest % 60 }, timeZone)
}

/** 'HH:MM' on the wall clock, for time inputs. */
export function timeInputValue(instant: Date | number, timeZone: string): string {
  const parts = zonedParts(instant, timeZone)
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

export function parseTimeInput(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [hour, minute] = [Number(match[1]), Number(match[2])]
  return hour < 24 && minute < 60 ? hour * 60 + minute : null
}

/** An ISO string with the instant's UTC offset in timeZone, e.g. 2026-10-20T14:00:00+08:00. */
export function toZonedIso(instant: Date | number, timeZone: string): string {
  const time = typeof instant === 'number' ? instant : instant.getTime()
  const parts = zonedParts(time, timeZone)
  const offset = Math.round(offsetAt(time, timeZone) / 60000)
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  return `${toDateKey(parts)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}
