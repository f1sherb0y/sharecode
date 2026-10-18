import { useEffect, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { cn } from '@/lib/utils'
import { SessionPeople } from './session-people'
import { FIRST_VISIBLE_HOUR, daySegments, visibleRange, type DaySegment, type LaneRank } from '@/lib/schedule'
import { atMinute, minuteOfDay, timeInputValue } from '@/lib/zoned-time'
import { pointerMinute, type DragPreview, type GridDrop } from './use-schedule-drag'

export interface GridRow {
  key: string
  day: string
  /** Day-view rows belong to a tech (null: unassigned); week-view rows have none. */
  techId?: string | null
  /** Empty when the page title already names the only row's day. */
  label: string
  sublabel?: string
  color?: string
  isToday?: boolean
}

interface TimeGridProps {
  rows: GridRow[]
  appointments: Appointment[]
  timezone: string
  now: number
  editable: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  /** Orders simultaneous sessions in a row from the top. */
  laneRank?: LaneRank
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  drag: {
    preview: DragPreview | null
    begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: { day: string; techId: string | null | undefined; minute: number }; row?: HTMLElement }) => void
    endsDrag: () => boolean
  }
  /** Scrolls this minute of the day into view when it changes. */
  focusMinute?: number | null
  label: string
}

/** Matches .schedule-event's line-height and padding: a lane holds whole lines. */
const EVENT_LINE = 15
const EVENT_CHROME = 6
const LANE_GAP = 2
const ROW_PADDING = 3
/** A lane fits the customer, the tech and agent, and the company and position; rows
 *  grow to fill the window's height, a lane up to MAX_LINES lines tall. */
const LINES = 3
const MAX_LINES = 7
const lanePitch = (lines: number) => lines * EVENT_LINE + EVENT_CHROME + LANE_GAP
const rowSize = (lanes: number, lines: number) => lanes * lanePitch(lines) - LANE_GAP + 2 * ROW_PADDING
// Lanes share the track's height, whatever the row has grown to.
const laneSpace = `(100% - ${2 * ROW_PADDING - LANE_GAP}px)`

function belongs(appointment: Appointment, row: GridRow): boolean {
  return row.techId === undefined || (appointment.tech?.id ?? null) === row.techId
}

/** The tech a dragged session would have: dropping on a tech's row assigns it. */
function landingTech(preview: DragPreview, rows: GridRow[]): Appointment['tech'] {
  const original = preview.appointment?.tech ?? null
  if (preview.kind !== 'move' || preview.techId === undefined || preview.techId === original?.id) return original
  if (preview.techId === null) return null
  const row = rows.find(r => r.techId === preview.techId)
  return { id: preview.techId, username: row?.label ?? '', color: row?.color ?? '', role: 'tech', isDeleted: false }
}

/**
 * Week and day views as timelines: a row per weekday (week) or per tech (day),
 * hours across. Sessions at the same time in a row take lanes, one under another.
 */
export function TimeGrid({ rows, appointments, timezone, now, editable, showTech, colorOf, laneRank, onOpen, onDrop, drag, focusMinute, label }: TimeGridProps) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)

  const laidOut = useMemo(() => rows.map(row => {
    const segments = daySegments(appointments.filter(appointment => belongs(appointment, row)), row.day, timezone, laneRank)
    return { row, segments, lanes: Math.max(1, ...segments.map(segment => segment.columns)) }
  }), [rows, appointments, timezone, laneRank])
  const { from, to } = useMemo(() => visibleRange(laidOut.flatMap(({ segments }) => segments)), [laidOut])
  const span = to - from
  const hours = Array.from({ length: span / 60 }, (_, index) => from / 60 + index)
  const x = (minute: number) => `${((Math.min(to, Math.max(from, minute)) - from) / span) * 100}%`
  const width = (start: number, end: number) => `${((Math.min(to, end) - Math.max(from, start)) / span) * 100}%`

  // Sessions before the working day (common in another zone) are where the timeline opens.
  const earliest = Math.min(FIRST_VISIBLE_HOUR * 60, ...laidOut.flatMap(({ segments }) => segments.map(segment => Math.floor(segment.start / 60) * 60)))

  // A timeline wider than the window opens at the working day, or at the session asked for.
  useEffect(() => {
    const scroll = scroller.current
    const track = scroll?.querySelector<HTMLElement>('[data-schedule-row]')
    if (!scroll || !track || scroll.scrollWidth <= scroll.clientWidth) return
    const minute = focusMinute ?? earliest
    const hour = track.offsetWidth / hours.length
    scroll.scrollTo({ left: Math.max(0, ((minute - from) / span) * track.offsetWidth - (focusMinute == null ? 0 : 2 * hour)) })
  }, [focusMinute, from, to, earliest]) // eslint-disable-line react-hooks/exhaustive-deps

  const preview = drag.preview
  const moving = preview && preview.kind !== 'create' ? preview.appointment?.id : undefined
  // The moved session as it would land, for the ghost.
  const ghost: Appointment | null = preview?.appointment ? {
    ...preview.appointment,
    startsAt: preview.startsAt.toISOString(),
    endsAt: new Date(preview.startsAt.getTime() + preview.durationMinutes * 60000).toISOString(),
    durationMinutes: preview.durationMinutes,
    tech: landingTech(preview, rows),
  } : null

  const timeRange = (start: number, end: number) => `${timeInputValue(start, timezone)}–${timeInputValue(end, timezone)}`

  const describe = (appointment: Appointment) => [
    timeRange(Date.parse(appointment.startsAt), Date.parse(appointment.endsAt)),
    appointment.customer.name,
    appointment.tech?.username ?? t('schedule.unassigned'),
    appointment.customer.owner.username,
    [appointment.company, appointment.position].filter(Boolean).join(' '),
    appointment.status === 'completed' ? t('schedule.status.completed') : '',
    appointment.hasConflict ? t('schedule.conflictBadge') : '',
  ].filter(Boolean).join(', ')

  const renderSegment = (segment: DaySegment, row: GridRow, lanes: number) => {
    const { appointment } = segment
    const role = [appointment.company, appointment.position].filter(Boolean).join(' · ')
    const style = {
      left: `calc(${x(segment.start)} + 1px)`,
      width: `calc(${width(segment.start, segment.end)} - 2px)`,
      top: `calc(${ROW_PADDING}px + ${segment.column} * ${laneSpace} / ${lanes})`,
      height: `calc(${laneSpace} / ${lanes} - ${LANE_GAP}px)`,
      '--event-color': colorOf(appointment),
    } as CSSProperties
    return (
      <button
        key={`${appointment.id}-${row.key}`}
        type="button"
        data-appointment={appointment.id}
        className={cn(
          'schedule-event',
          `schedule-event-${appointment.status}`,
          !appointment.tech && 'schedule-event-unassigned',
          appointment.hasConflict && 'schedule-event-conflict',
          moving === appointment.id && 'schedule-event-moving',
        )}
        style={style}
        aria-label={describe(appointment)}
        title={describe(appointment)}
        onPointerDown={editable ? (event) => {
          const grabbedAt = atMinute(row.day, pointerMinute({ clientX: event.clientX, currentTarget: event.currentTarget.parentElement! }), timezone)
          drag.begin(event, { kind: 'move', appointment, grabOffset: Math.round((grabbedAt.getTime() - Date.parse(appointment.startsAt)) / 60000) })
        } : undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (!drag.endsDrag()) onOpen(appointment)
        }}
      >
        <span className="schedule-event-title">
          {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-hidden="true" />}
          <span className="truncate">{appointment.customer.name}</span>
        </span>
        {/* No time on the card: the hours above the grid show it. */}
        <SessionPeople appointment={appointment} showTech={showTech} compact className="schedule-event-meta" />
        {role && <span className="schedule-event-meta">{role}</span>}
        {editable && !segment.continuesAfter && (
          <span
            className="schedule-event-resize"
            aria-hidden="true"
            onPointerDown={(event) => {
              // How far from the end it was grabbed, so the end moves exactly as far as the pointer.
              const track = event.currentTarget.closest<HTMLElement>('[data-schedule-row]')!
              const minute = pointerMinute({ clientX: event.clientX, currentTarget: track })
              drag.begin(event, { kind: 'resize', appointment, grabOffset: minute - segment.end, origin: { day: row.day, techId: row.techId, minute }, row: track })
            }}
          />
        )}
      </button>
    )
  }

  // While dragging, the landing time is shown: the hours above mark only whole hours.
  const renderGhost = (key: string, start: number, end: number, title: string, color?: string) => (
    <div
      key={key}
      className={cn('schedule-event schedule-event-ghost', !color && 'schedule-event-new')}
      style={{
        left: `calc(${x(start)} + 1px)`,
        width: `calc(${width(start, end)} - 2px)`,
        top: ROW_PADDING,
        bottom: ROW_PADDING,
        ...(color ? { '--event-color': color } : {}),
      } as CSSProperties}
      aria-hidden="true"
    >
      <span className="schedule-event-time">{title}</span>
    </div>
  )

  const nowMinute = minuteOfDay(now, timezone)
  // Today stands out among days; rows for people on one day need no marker.
  const marksToday = new Set(rows.map(row => row.day)).size > 1
  const labeled = rows.some(row => row.label)

  return (
    <div
      className={cn('schedule-grid', !labeled && 'is-unlabeled')}
      // Ends below the last row once every lane has reached its full height (hours row + borders).
      style={{ '--hours': hours.length, maxHeight: `calc(1.75rem + 3px + ${laidOut.reduce((sum, { lanes }) => sum + rowSize(lanes, MAX_LINES) + 1, 0)}px)` } as CSSProperties}
      role="region"
      aria-label={label}
      data-tour="calendar"
    >
      <div className="schedule-grid-scroll" ref={scroller} data-schedule-scroll>
        <div className="schedule-grid-inner">
          <div className="schedule-grid-head" aria-hidden="true">
            {labeled && <div className="schedule-row-label schedule-corner" />}
            <div className="schedule-hours">
              {hours.map(hour => (
                <span key={hour} className="schedule-hour" style={{ left: x(hour * 60) }}>{String(hour).padStart(2, '0')}:00</span>
              ))}
            </div>
          </div>
          {laidOut.map(({ row, segments, lanes }) => {
            const ghostSegments = ghost && belongs(ghost, row) ? daySegments([ghost], row.day, timezone) : []
            const creating = preview?.kind === 'create' && preview.day === row.day && preview.techId === row.techId
            const createStart = creating && preview ? minuteOfDay(preview.startsAt, timezone) : 0
            return (
              <div
                key={row.key}
                className={cn('schedule-row', marksToday && row.isToday && 'is-today')}
                // Each lane gets an equal share of the spare height, up to MAX_LINES lines (+1px for the row border).
                style={{ flex: `${lanes} 0 ${rowSize(lanes, LINES) + 1}px`, maxHeight: rowSize(lanes, MAX_LINES) + 1 }}
              >
                {labeled && (
                  <div className="schedule-row-label">
                    {row.color && <span className="schedule-dot" style={{ background: row.color }} aria-hidden="true" />}
                    <span className="schedule-row-name">{row.label}</span>
                    {row.sublabel && <span className="schedule-row-sublabel">{row.sublabel}</span>}
                  </div>
                )}
                <div
                  className={cn('schedule-track', editable && 'is-editable')}
                  data-schedule-row
                  data-day={row.day}
                  data-tech={row.techId === undefined ? undefined : row.techId ?? ''}
                  data-from={from}
                  data-to={to}
                  aria-label={[row.label, row.sublabel].filter(Boolean).join(' ') || undefined}
                  onPointerDown={editable ? (event) => {
                    if (event.target !== event.currentTarget) return
                    drag.begin(event, { kind: 'create', origin: { day: row.day, techId: row.techId, minute: pointerMinute(event) }, row: event.currentTarget })
                  } : undefined}
                  onClick={editable ? (event) => {
                    if (event.target !== event.currentTarget || drag.endsDrag()) return
                    // A click or tap on free time proposes a session there, on the half hour.
                    const minute = Math.floor(pointerMinute(event) / 30) * 30
                    onDrop({ kind: 'create', startsAt: atMinute(row.day, minute, timezone), durationMinutes: 60, techId: row.techId })
                  } : undefined}
                >
                  {segments.map(segment => renderSegment(segment, row, lanes))}
                  {ghost && ghostSegments.map(segment => renderGhost(
                    `ghost-${segment.start}`, segment.start, segment.end,
                    `${timeRange(Date.parse(ghost.startsAt), Date.parse(ghost.endsAt))} ${ghost.customer.name}`, colorOf(ghost),
                  ))}
                  {creating && preview && renderGhost(
                    'new', createStart, createStart + preview.durationMinutes,
                    `${timeRange(preview.startsAt.getTime(), preview.startsAt.getTime() + preview.durationMinutes * 60000)} ${t('schedule.newSession')}`,
                  )}
                  {row.isToday && nowMinute >= from && nowMinute <= to && (
                    <div className="schedule-now" style={{ left: x(nowMinute) }} aria-hidden="true" />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
