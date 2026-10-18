import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { cn } from '@/lib/utils'
import { SessionPeople } from './session-people'
import { MAX_WINDOW_HOURS, MIN_WINDOW_HOURS, clamp, layoutSpans, type LaneRank, type Segment } from '@/lib/schedule'
import { timeInputValue, zonedParts } from '@/lib/zoned-time'
import { pointerInstant, type DragPreview, type GridDrop } from './use-schedule-drag'

export interface GridRow {
  key: string
  /** The instant the row's window of hours starts. */
  start: number
  /** The day the window mostly shows. */
  day: string
  /** Rows of one tech (null: unassigned): the day view, or a week of one tech's sessions. */
  techId?: string | null
  /** Empty when the page title already names the only row's day. */
  label: string
  sublabel?: string
  isToday?: boolean
  /** A tech's name in the day view opens their own calendar. */
  onPick?: () => void
}

interface TimeGridProps {
  rows: GridRow[]
  /** Minutes every row's window spans. */
  span: number
  appointments: Appointment[]
  timezone: string
  now: number
  editable: boolean
  /** "Add" is on: clicking or drawing on a row plans a session there. */
  adding: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  /** Orders simultaneous sessions in a row from the top. */
  laneRank?: LaneRank
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  /** Moves the window by so many minutes (later when positive). */
  onPan: (minutes: number) => void
  /** How many hours fit the rows' width. */
  onFit: (hours: number) => void
  drag: {
    preview: DragPreview | null
    begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: { row: string; techId: string | null | undefined; at: number }; row?: HTMLElement }) => void
    endsDrag: () => boolean
  }
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

const MINUTE = 60000
const HOUR = 60 * MINUTE
/** A row lays out the day around its window, so lanes stay put while the window moves. */
const BAND = 12 * HOUR
/** Below this width an hour leaves the window, down to MIN_WINDOW_HOURS. */
const MIN_HOUR_WIDTH = 44
const PAN_THRESHOLD = 4
const pad = (value: number) => String(value).padStart(2, '0')

function inRow(techId: string | null, row: GridRow): boolean {
  return row.techId === undefined || techId === row.techId
}

/** The tech a dragged session would have: dropping on a tech's row assigns it. */
function landingTech(preview: DragPreview): string | null {
  const original = preview.appointment?.tech?.id ?? null
  return preview.kind === 'move' && preview.techId !== undefined ? preview.techId : original
}

/**
 * Week and day views as timelines: a row per weekday (week) or per tech (day), a
 * window of hours across that is dragged sideways. Sessions at the same time in a
 * row take lanes, one under another. Times are instants, so switching the zone
 * keeps every session in place and changes only the hours above.
 */
export function TimeGrid({ rows, span, appointments, timezone, now, editable, adding, showTech, colorOf, laneRank, onOpen, onDrop, onPan, onFit, drag, label }: TimeGridProps) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)
  const hoursRef = useRef<HTMLDivElement>(null)
  const length = span * MINUTE
  const first = rows[0]?.start ?? 0
  const pct = (duration: number) => `${(duration / length) * 100}%`

  const laidOut = useMemo(() => rows.map(row => {
    const end = row.start + length
    const middle = row.start + length / 2
    const segments = layoutSpans(appointments.filter(appointment => inRow(appointment.tech?.id ?? null, row)), middle - BAND, middle + BAND, laneRank)
    return {
      row,
      end,
      lanes: Math.max(1, ...segments.map(segment => segment.columns)),
      shown: segments.filter(segment => segment.end > row.start && segment.start < end),
      // Sessions of the row's day outside the window: a marker at that edge brings them in.
      before: segments.filter(segment => segment.end <= row.start),
      after: segments.filter(segment => segment.start >= end),
    }
  }), [rows, length, appointments, laneRank])

  // Whole hours of the zone across the window; every row starts at the same time of day.
  const ticks = useMemo(() => {
    const list: { at: number; label: string; midnight: boolean }[] = []
    const start = Math.ceil(first / MINUTE) * MINUTE
    let at = start + ((60 - zonedParts(start, timezone).minute) % 60) * MINUTE
    for (; at < first + length; at += HOUR) {
      const hour = zonedParts(at, timezone).hour
      list.push({ at, label: `${pad(hour)}:00`, midnight: hour === 0 })
    }
    return list
  }, [first, length, timezone])
  const halves = [...(ticks[0] && ticks[0].at - 30 * MINUTE > first ? [ticks[0].at - 30 * MINUTE] : []), ...ticks.map(tick => tick.at + 30 * MINUTE).filter(at => at < first + length)]

  const onFitRef = useRef(onFit)
  onFitRef.current = onFit
  const onPanRef = useRef(onPan)
  onPanRef.current = onPan
  const spanRef = useRef(span)
  spanRef.current = span

  // As many hours as fit the width, at most 14.
  useEffect(() => {
    const element = hoursRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width
      if (width > 0) onFitRef.current(clamp(Math.floor(width / MIN_HOUR_WIDTH), MIN_WINDOW_HOURS, MAX_WINDOW_HOURS))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Trackpads swipe sideways (and Shift turns a wheel) to move the window.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const sideways = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      if (!sideways || (!event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY))) return
      event.preventDefault()
      const width = hoursRef.current?.getBoundingClientRect().width
      if (width) onPanRef.current(((sideways * (event.deltaMode === 1 ? 16 : 1)) / width) * spanRef.current)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  // Dragging free space (or, by touch or for a tech, a session) moves the window of hours.
  const pan = useRef<{ pointerId: number; startX: number; lastX: number; width: number; moved: boolean } | null>(null)
  const panned = useRef(false)
  const [panning, setPanning] = useState(false)
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.pointerType === 'mouse') event.preventDefault()
    pan.current = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, width: event.currentTarget.getBoundingClientRect().width, moved: false }
  }
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = pan.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      if (Math.abs(event.clientX - current.startX) < PAN_THRESHOLD) return
      current.moved = true
      setPanning(true)
      // Only now, so a tap still reaches the session under it.
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const dx = event.clientX - current.lastX
    current.lastX = event.clientX
    if (dx) onPan((-dx / current.width) * span)
  }
  const endPan = (event: ReactPointerEvent) => {
    if (pan.current?.pointerId !== event.pointerId) return
    if (pan.current.moved) {
      // The click that ends a drag opens nothing.
      panned.current = true
      setTimeout(() => { panned.current = false }, 0)
    }
    pan.current = null
    setPanning(false)
  }
  const endsDrag = () => panned.current || drag.endsDrag()

  const preview = drag.preview
  const moving = preview && preview.kind !== 'create' ? preview.appointment?.id : undefined
  // The moved session as it would land, for the ghost.
  const ghost = preview?.appointment ? {
    appointment: {
      ...preview.appointment,
      startsAt: preview.startsAt.toISOString(),
      endsAt: new Date(preview.startsAt.getTime() + preview.durationMinutes * MINUTE).toISOString(),
      durationMinutes: preview.durationMinutes,
    },
    techId: landingTech(preview),
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

  const renderSegment = (segment: Segment, row: GridRow, end: number, lanes: number) => {
    const { appointment } = segment
    const from = Math.max(segment.start, row.start)
    const to = Math.min(segment.end, end)
    const role = [appointment.company, appointment.position].filter(Boolean).join(' · ')
    const style = {
      left: `calc(${pct(from - row.start)} + 1px)`,
      width: `calc(${pct(to - from)} - 2px)`,
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
          const at = pointerInstant({ clientX: event.clientX, currentTarget: event.currentTarget.parentElement! })
          drag.begin(event, { kind: 'move', appointment, grabOffset: at - Date.parse(appointment.startsAt) })
        } : undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (!endsDrag()) onOpen(appointment)
        }}
      >
        <span className="schedule-event-title">
          {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-hidden="true" />}
          <span className="truncate">{appointment.customer.name}</span>
        </span>
        {/* No time on the card: the hours above the grid show it. */}
        <SessionPeople appointment={appointment} showTech={showTech} compact className="schedule-event-meta" />
        {role && <span className="schedule-event-meta">{role}</span>}
        {editable && !segment.continuesAfter && Date.parse(appointment.endsAt) <= end && (
          <span
            className="schedule-event-resize"
            aria-hidden="true"
            onPointerDown={(event) => {
              // How far from the end it was grabbed, so the end moves exactly as far as the pointer.
              const track = event.currentTarget.closest<HTMLElement>('[data-schedule-row]')!
              const at = pointerInstant({ clientX: event.clientX, currentTarget: track })
              drag.begin(event, { kind: 'resize', appointment, grabOffset: at - Date.parse(appointment.endsAt), origin: { row: row.key, techId: row.techId, at }, row: track })
            }}
          />
        )}
      </button>
    )
  }

  // While dragging, the landing time is shown: the hours above mark only whole hours.
  const renderGhost = (key: string, row: GridRow, end: number, start: number, stop: number, title: string, color?: string) => {
    const from = Math.max(start, row.start)
    const to = Math.min(stop, end)
    if (to <= from) return null
    return (
      <div
        key={key}
        className={cn('schedule-event schedule-event-ghost', !color && 'schedule-event-new')}
        style={{
          left: `calc(${pct(from - row.start)} + 1px)`,
          width: `calc(${pct(to - from)} - 2px)`,
          top: ROW_PADDING,
          bottom: ROW_PADDING,
          ...(color ? { '--event-color': color } : {}),
        } as CSSProperties}
        aria-hidden="true"
      >
        <span className="schedule-event-time">{title}</span>
      </div>
    )
  }

  // Brings the nearest session beyond an edge to the middle of the window.
  const bringIn = (segment: Segment, row: GridRow) => {
    onPan(((segment.start + segment.end) / 2 - (row.start + length / 2)) / MINUTE)
  }

  // Today stands out among days; rows for people on one day need no marker.
  const marksToday = new Set(rows.map(row => row.day)).size > 1
  const labeled = rows.some(row => row.label)

  return (
    <div
      className={cn('schedule-grid', !labeled && 'is-unlabeled', adding && editable && 'is-adding', panning && 'is-panning')}
      // Ends below the last row once every lane has reached its full height (hours row + borders).
      style={{ maxHeight: `calc(1.75rem + 3px + ${laidOut.reduce((sum, { lanes }) => sum + rowSize(lanes, MAX_LINES) + 1, 0)}px)` }}
      role="region"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        onPan(event.key === 'ArrowLeft' ? -60 : 60)
      }}
      data-tour="calendar"
    >
      <div className="schedule-grid-scroll" ref={scroller} data-schedule-scroll>
        <div className="schedule-grid-inner">
          <div className="schedule-grid-head" aria-hidden="true">
            {labeled && <div className="schedule-row-label schedule-corner" />}
            <div className="schedule-hours" ref={hoursRef}>
              {ticks.map(tick => (
                <span key={tick.at} className={cn('schedule-hour', tick.midnight && 'is-midnight')} style={{ left: pct(tick.at - first) }}>{tick.label}</span>
              ))}
            </div>
          </div>
          {laidOut.map(({ row, end, lanes, shown, before, after }) => (
            <div
              key={row.key}
              className={cn('schedule-row', marksToday && row.isToday && 'is-today')}
              // Each lane gets an equal share of the spare height, up to MAX_LINES lines (+1px for the row border).
              style={{ flex: `${lanes} 0 ${rowSize(lanes, LINES) + 1}px`, maxHeight: rowSize(lanes, MAX_LINES) + 1 }}
            >
              {labeled && (
                <div className="schedule-row-label">
                  {row.onPick
                    ? <button type="button" className="schedule-row-name schedule-row-pick" onClick={row.onPick}>{row.label}</button>
                    : <span className="schedule-row-name">{row.label}</span>}
                  {row.sublabel && <span className="schedule-row-sublabel">{row.sublabel}</span>}
                </div>
              )}
              <div
                className={cn('schedule-track', editable && 'is-editable')}
                data-schedule-row
                data-row={row.key}
                data-day={row.day}
                data-tech={row.techId === undefined ? undefined : row.techId ?? ''}
                data-start={row.start}
                data-span={span}
                aria-label={[row.label, row.sublabel].filter(Boolean).join(' ') || undefined}
                onPointerDown={(event) => {
                  // Sessions an agent drags with a mouse stop the event before it gets here.
                  if (!adding) startPan(event)
                  else if (editable && event.target === event.currentTarget) drag.begin(event, { kind: 'create', origin: { row: row.key, techId: row.techId, at: pointerInstant(event) }, row: event.currentTarget })
                }}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onClick={adding && editable ? (event) => {
                  if (event.target !== event.currentTarget || endsDrag()) return
                  // A click or tap proposes an hour from the half hour under it.
                  const at = Math.floor(pointerInstant(event) / (30 * MINUTE)) * 30 * MINUTE
                  onDrop({ kind: 'create', startsAt: new Date(at), durationMinutes: 60, techId: row.techId })
                } : undefined}
              >
                {shown.map(segment => renderSegment(segment, row, end, lanes))}
                {ghost && inRow(ghost.techId, row) && renderGhost(
                  `ghost-${row.key}`, row, end, Date.parse(ghost.appointment.startsAt), Date.parse(ghost.appointment.endsAt),
                  `${timeRange(Date.parse(ghost.appointment.startsAt), Date.parse(ghost.appointment.endsAt))} ${ghost.appointment.customer.name}`, colorOf(ghost.appointment),
                )}
                {preview?.kind === 'create' && preview.row === row.key && renderGhost(
                  'new', row, end, preview.startsAt.getTime(), preview.startsAt.getTime() + preview.durationMinutes * MINUTE,
                  `${timeRange(preview.startsAt.getTime(), preview.startsAt.getTime() + preview.durationMinutes * MINUTE)} ${t('schedule.newSession')}`,
                )}
                {now >= row.start && now <= end && (
                  <div className="schedule-now" style={{ left: pct(now - row.start) }} aria-hidden="true" />
                )}
                {before.length > 0 && (
                  <button
                    type="button"
                    className="schedule-more is-before"
                    aria-label={t('schedule.earlier', { count: before.length })}
                    title={t('schedule.earlier', { count: before.length })}
                    onClick={() => { if (!endsDrag()) bringIn(before.reduce((last, segment) => (segment.end > last.end ? segment : last)), row) }}
                  >
                    <ChevronLeft aria-hidden="true" />{before.length}
                  </button>
                )}
                {after.length > 0 && (
                  <button
                    type="button"
                    className="schedule-more is-after"
                    aria-label={t('schedule.later', { count: after.length })}
                    title={t('schedule.later', { count: after.length })}
                    onClick={() => { if (!endsDrag()) bringIn(after[0]!, row) }}
                  >
                    {after.length}<ChevronRight aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {/* Hour lines, and a dashed line where the zone's day turns, down every row. */}
          <div className="schedule-lines" aria-hidden="true">
            {ticks.map(tick => <span key={tick.at} className={cn('schedule-line', tick.midnight && 'is-midnight')} style={{ left: pct(tick.at - first) }} />)}
            {halves.map(at => <span key={at} className="schedule-line is-half" style={{ left: pct(at - first) }} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
