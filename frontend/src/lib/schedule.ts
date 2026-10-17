import type { Appointment, User } from '@/types'
import { addDays, addMonths, dayStart, daysBetween, minuteOfDay, startOfMonth, startOfWeek } from '@/lib/zoned-time'

export type ScheduleView = 'day' | 'week' | 'month' | 'list'
export const SCHEDULE_VIEWS: ScheduleView[] = ['day', 'week', 'month', 'list']

export const HOUR_HEIGHT = 48
export const SNAP_MINUTES = 15
export const DEFAULT_DURATION = 60
export const DURATION_PRESETS = [30, 45, 60, 90, 120, 150, 180, 240]
/** Where the time grid opens, so a workday is in view. */
export const FIRST_VISIBLE_HOUR = 8

export interface ViewRange {
  /** Calendar days shown, as date keys. */
  days: string[]
  /** First day of the range and the day after the last. */
  from: string
  to: string
}

/** The list is an agenda of the days from the one in view. */
export const LIST_DAYS = 14

export function viewRange(view: ScheduleView, anchor: string): ViewRange {
  if (view === 'day') return { days: [anchor], from: anchor, to: addDays(anchor, 1) }
  if (view === 'list') {
    return { days: Array.from({ length: LIST_DAYS }, (_, i) => addDays(anchor, i)), from: anchor, to: addDays(anchor, LIST_DAYS) }
  }
  if (view === 'month') {
    // Whole weeks covering the month, Monday first.
    const from = startOfWeek(startOfMonth(anchor))
    const to = addDays(startOfWeek(addDays(addMonths(anchor, 1), -1)), 7)
    return { days: Array.from({ length: daysBetween(from, to) }, (_, i) => addDays(from, i)), from, to }
  }
  const from = startOfWeek(anchor)
  return { days: Array.from({ length: 7 }, (_, i) => addDays(from, i)), from, to: addDays(from, 7) }
}

export function stepAnchor(view: ScheduleView, anchor: string, direction: 1 | -1): string {
  if (view === 'day') return addDays(anchor, direction)
  if (view === 'month') return addMonths(anchor, direction)
  if (view === 'list') return addDays(anchor, LIST_DAYS * direction)
  return addDays(anchor, 7 * direction)
}

export function snap(minutes: number, step = SNAP_MINUTES): number {
  return Math.round(minutes / step) * step
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The part of a session on one calendar day, in wall-clock minutes. */
export interface DaySegment {
  appointment: Appointment
  start: number
  end: number
  /** The session continues from the day before / into the next day. */
  continuesBefore: boolean
  continuesAfter: boolean
  column: number
  columns: number
}

/** Splits sessions into per-day pieces and lays out overlapping pieces side by side. */
export function daySegments(appointments: Appointment[], day: string, timeZone: string): DaySegment[] {
  const start = dayStart(day, timeZone).getTime()
  const end = dayStart(addDays(day, 1), timeZone).getTime()
  const pieces: DaySegment[] = []
  for (const appointment of appointments) {
    const from = Date.parse(appointment.startsAt)
    const to = Date.parse(appointment.endsAt)
    if (to <= start || from >= end) continue
    const continuesBefore = from < start
    const continuesAfter = to > end
    pieces.push({
      appointment,
      start: continuesBefore ? 0 : minuteOfDay(from, timeZone),
      end: continuesAfter ? 1440 : minuteOfDay(to, timeZone) || 1440,
      continuesBefore,
      continuesAfter,
      column: 0,
      columns: 1,
    })
  }
  return layoutOverlaps(pieces)
}

function layoutOverlaps(pieces: DaySegment[]): DaySegment[] {
  pieces.sort((a, b) => a.start - b.start || b.end - a.end || a.appointment.id.localeCompare(b.appointment.id))
  let cluster: DaySegment[] = []
  let clusterEnd = -1
  const columnEnds: number[] = []
  const flush = () => {
    const columns = Math.max(1, columnEnds.length)
    for (const piece of cluster) piece.columns = columns
    cluster = []
    columnEnds.length = 0
  }
  for (const piece of pieces) {
    if (piece.start >= clusterEnd) flush()
    let column = columnEnds.findIndex(columnEnd => columnEnd <= piece.start)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(piece.end)
    } else {
      columnEnds[column] = piece.end
    }
    piece.column = column
    cluster.push(piece)
    clusterEnd = Math.max(clusterEnd, piece.end)
  }
  flush()
  return pieces
}

/** Sessions touching a calendar day, earliest first. */
export function sessionsOnDay(appointments: Appointment[], day: string, timeZone: string): Appointment[] {
  const start = dayStart(day, timeZone).getTime()
  const end = dayStart(addDays(day, 1), timeZone).getTime()
  return appointments
    .filter(a => Date.parse(a.endsAt) > start && Date.parse(a.startsAt) < end)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))
}

const EXTRA_COLORS = ['#7c6cf2', '#e0699b', '#3b9e6d', '#d9822b', '#4a7fd6', '#a05ccf', '#2aa3a3', '#c2563f', '#7a8a2a', '#5f6f8f']
export const UNASSIGNED_COLOR = '#8e9099'

/** Each tech's calendar color: their account color unless another tech already shows it. */
export function techColors(techs: Pick<User, 'id' | 'color' | 'username'>[]): Map<string, string> {
  const colors = new Map<string, string>()
  const used = new Set<string>()
  const sorted = [...techs].sort((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id))
  for (const tech of sorted) {
    let color = tech.color?.toLowerCase()
    if (!color || used.has(color)) color = EXTRA_COLORS.find(extra => !used.has(extra)) ?? color ?? UNASSIGNED_COLOR
    used.add(color)
    colors.set(tech.id, color)
  }
  return colors
}

export function isLive(appointment: Appointment): boolean {
  return appointment.status === 'scheduled' && Date.parse(appointment.endsAt) > Date.now()
}

/** A calendar day in the UI language, e.g. "Tue 10/20" or "10月20日周二". */
export function formatDayKey(key: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(Date.UTC(year!, month! - 1, day!))
}

/** A whole number of minutes as "1 h 30 min" style text. */
export function formatDuration(minutes: number, units: { hours: string; minutes: string }): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours ? `${hours} ${units.hours}` : '', rest || !hours ? `${rest} ${units.minutes}` : ''].filter(Boolean).join(' ')
}
