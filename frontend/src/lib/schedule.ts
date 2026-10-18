import type { Appointment, User } from '@/types'
import { addDays, addMonths, atMinute, dayStart, daysBetween, startOfMonth, startOfWeek } from '@/lib/zoned-time'

export type ScheduleView = 'day' | 'week' | 'month' | 'list'
export const SCHEDULE_VIEWS: ScheduleView[] = ['day', 'week', 'month', 'list']

export const SNAP_MINUTES = 15

/** Zones the calendar can be viewed in, for customers abroad; IANA names keep daylight saving right. */
export const SCHEDULE_ZONES = ['Asia/Shanghai', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris']
/** Schedules are kept in China time unless another zone is picked. */
export const DEFAULT_ZONE = 'Asia/Shanghai'

/** The standard name of a zone in the UI language, e.g. Eastern Time / 北美东部时间. */
export function zoneName(timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' })
    .formatToParts(0).find(part => part.type === 'timeZoneName')?.value ?? timeZone
}
export const DEFAULT_DURATION = 60
export const DURATION_PRESETS = [30, 45, 60, 90, 120, 150, 180, 240]
/**
 * Week and day timelines show a window of hours that is dragged sideways: 08:00–22:00
 * at first, fewer hours when the screen is too narrow for 14.
 */
export const WINDOW_START_HOUR = 8
export const MAX_WINDOW_HOURS = 14
export const MIN_WINDOW_HOURS = 4

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

/** A session laid out on a timeline row, as instants cut to the stretch laid out. */
export interface Segment {
  appointment: Appointment
  start: number
  end: number
  /** The session continues before / after that stretch. */
  continuesBefore: boolean
  continuesAfter: boolean
  column: number
  columns: number
}

/**
 * Orders sessions that overlap, e.g. by tech, so each tech keeps the same place
 * among simultaneous sessions.
 */
export type LaneRank = (appointment: Appointment) => number

/** Cuts sessions to the stretch from–to (instants) and lays out overlapping ones in lanes. */
export function layoutSpans(appointments: Appointment[], from: number, to: number, rank?: LaneRank): Segment[] {
  const pieces: Segment[] = []
  for (const appointment of appointments) {
    const start = Date.parse(appointment.startsAt)
    const end = Date.parse(appointment.endsAt)
    if (end <= from || start >= to) continue
    pieces.push({
      appointment,
      start: Math.max(start, from),
      end: Math.min(end, to),
      continuesBefore: start < from,
      continuesAfter: end > to,
      column: 0,
      columns: 1,
    })
  }
  return layoutOverlaps(pieces, rank)
}

/**
 * Where a row's window of hours starts: `phase` minutes after the day's midnight in
 * timeZone (negative: the evening before). Every row of a week starts at the same time
 * of day, so midnight lines up down the rows.
 */
export function windowStart(day: string, phase: number, timeZone: string): number {
  const whole = Math.floor(phase)
  return atMinute(day, whole, timeZone).getTime() + (phase - whole) * 60000
}

/**
 * Dragging keeps most of each row's window on the row's own day, so a row never shows
 * more of the day before or after than of its own.
 */
export function clampPhase(phase: number, span: number, current = phase): number {
  const lowest = -span / 2
  const highest = 1440 - span / 2 - 1
  // A zone switch can leave the window further out; it may come back but not go further.
  return clamp(phase, Math.min(lowest, current), Math.max(highest, current))
}

function layoutOverlaps(pieces: Segment[], rank: LaneRank = () => 0): Segment[] {
  pieces.sort((a, b) => a.start - b.start || b.end - a.end || a.appointment.id.localeCompare(b.appointment.id))
  let cluster: Segment[] = []
  let clusterEnd = -1
  // Pieces that overlap, directly or through others, share their lanes. Lanes go
  // in rank order; a lane takes every later piece that fits beside the ones in it.
  const place = () => {
    const ordered = [...cluster].sort((a, b) =>
      rank(a.appointment) - rank(b.appointment) || a.start - b.start || a.appointment.id.localeCompare(b.appointment.id))
    const lanes: Segment[][] = []
    for (const piece of ordered) {
      let lane = lanes.findIndex(taken => taken.every(other => other.end <= piece.start || other.start >= piece.end))
      if (lane === -1) lane = lanes.push([]) - 1
      lanes[lane]!.push(piece)
      piece.column = lane
    }
    for (const piece of cluster) piece.columns = lanes.length
    cluster = []
  }
  for (const piece of pieces) {
    if (piece.start >= clusterEnd && cluster.length > 0) place()
    cluster.push(piece)
    clusterEnd = Math.max(clusterEnd, piece.end)
  }
  if (cluster.length > 0) place()
  return pieces
}

/** Sessions that overlap in time, as groups in start order: a list shows each group as one row. */
export function overlapGroups(appointments: Appointment[], rank: LaneRank = () => 0): Appointment[][] {
  const sorted = [...appointments].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))
  const groups: Appointment[][] = []
  let end = -Infinity
  for (const appointment of sorted) {
    if (groups.length === 0 || Date.parse(appointment.startsAt) >= end) groups.push([])
    groups[groups.length - 1]!.push(appointment)
    end = Math.max(end, Date.parse(appointment.endsAt))
  }
  for (const group of groups) {
    group.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || rank(a) - rank(b) || a.id.localeCompare(b.id))
  }
  return groups
}

/** The time a group of sessions spans. */
export function groupSpan(group: Appointment[]): { from: number; to: number } {
  return {
    from: Math.min(...group.map(appointment => Date.parse(appointment.startsAt))),
    to: Math.max(...group.map(appointment => Date.parse(appointment.endsAt))),
  }
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
