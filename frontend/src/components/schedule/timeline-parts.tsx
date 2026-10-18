import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, RotateCcw, TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { getLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { HOUR_MS, MINUTE_MS, clamp, formatDayKey, type DayLayout, type Segment } from '@/lib/schedule'
import { dateKeyOf, timeInputValue, zonedParts } from '@/lib/zoned-time'
import { pointerInstant, type DragPreview, type GridDrop } from './use-schedule-drag'

/** Matches .schedule-event's line-height and padding: a card holds whole lines. */
const EVENT_LINE = 15
const EVENT_CHROME = 6
export const LANE_GAP = 2
export const ROW_PADDING = 3
/** A card's lines: 管理, the customer, the tech (unless the row or the whole calendar is
 *  theirs) and the company and position. A lane is one card high. */
export const cardLines = (showTech: boolean) => (showTech ? 4 : 3)
export const lanePitch = (lines: number) => lines * EVENT_LINE + EVENT_CHROME + LANE_GAP
export const rowSize = (lanes: number, lines: number) => lanes * lanePitch(lines) - LANE_GAP + 2 * ROW_PADDING
// Lanes share the track's height, whatever the row has grown to.
const laneSpace = `(100% - ${2 * ROW_PADDING - LANE_GAP}px)`
/** Hours from one label to the next: the fewest that leave each label LABEL_WIDTH pixels. */
const LABEL_STEPS = [1, 2, 3, 4, 6]
export const LABEL_WIDTH = 40
/** The wheel multiplies the hours shown by e to the power of this, per pixel turned. */
const ZOOM_RATE = 0.002
/** Narrower hours leave the hour after a date unlabeled, so the two do not touch. */
const DATE_HOUR_WIDTH = 76
const PAN_THRESHOLD = 4
const pad = (value: number) => String(value).padStart(2, '0')
const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', weekday: 'short' }

export const EMPTY_LAYOUT: DayLayout = { segments: [], lanes: 1 }

export interface TimelineRow {
  key: string
  /** The instant the row's window of hours starts. */
  start: number
  /** The day the row stands for. */
  day: string
  /** Rows of one tech (null: unassigned); undefined when the row holds everyone's. */
  techId?: string | null
}

export interface DragApi {
  preview: DragPreview | null
  begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: { row: string; techId: string | null | undefined; at: number }; row?: HTMLElement }) => void
  endsDrag: () => boolean
}

export function inRow(techId: string | null, row: { techId?: string | null }): boolean {
  return row.techId === undefined || techId === row.techId
}

export interface Tick {
  at: number
  label: string
  midnight: boolean
}

/** Hours from one label to the next on a track `width` pixels wide showing `span` minutes. */
export function labelStep(width: number, span: number): number {
  const hourWidth = (width / span) * 60
  return LABEL_STEPS.find(hours => !width || hourWidth * hours >= LABEL_WIDTH) ?? 12
}

/** Whole hours of the zone across a window, labeled where there is room; where a day
 *  begins inside the window, the day view names it. */
export function useTicks(first: number, span: number, timeZone: string, datesAtMidnight: boolean, width: number): Tick[] {
  const locale = getLocale()
  const roomy = width <= 0 || (width / span) * 60 >= DATE_HOUR_WIDTH
  const step = labelStep(width, span)
  return useMemo(() => {
    const list: Tick[] = []
    const end = first + span * MINUTE_MS
    const start = Math.ceil(first / MINUTE_MS) * MINUTE_MS
    for (let at = start + ((60 - zonedParts(start, timeZone).minute) % 60) * MINUTE_MS; at < end; at += HOUR_MS) {
      const hour = zonedParts(at, timeZone).hour
      const midnight = hour === 0 && at > first
      // Labels that would run past the right edge are left out.
      const room = width > 0 ? ((end - at) / (span * MINUTE_MS)) * width : Infinity
      let label = hour % step || room < LABEL_WIDTH ? '' : `${pad(hour)}:00`
      if (datesAtMidnight && midnight) label = room < DATE_HOUR_WIDTH ? '' : formatDayKey(dateKeyOf(at, timeZone), locale, DATE_FORMAT)
      else if (datesAtMidnight && !roomy && list[list.length - 1]?.midnight) label = ''
      list.push({ at, label, midnight })
    }
    return list
  }, [first, span, timeZone, datesAtMidnight, width, roomy, step, locale])
}

/** The hours above the rows. */
export function HoursHeader({ ticks, first, span, labeled, hoursRef, headRef }: {
  ticks: Tick[]
  first: number
  span: number
  labeled: boolean
  hoursRef: RefObject<HTMLDivElement | null>
  headRef?: RefObject<HTMLDivElement | null>
}) {
  const length = span * MINUTE_MS
  return (
    <div className="schedule-grid-head" aria-hidden="true" ref={headRef}>
      {labeled && <div className="schedule-row-label schedule-corner" />}
      <div className="schedule-hours" ref={hoursRef}>
        {ticks.map(tick => (
          <span key={tick.at} className={cn('schedule-hour', tick.midnight && 'is-midnight')} style={{ left: `${((tick.at - first) / length) * 100}%` }}>{tick.label}</span>
        ))}
      </div>
    </div>
  )
}

/** Hour and half-hour lines down the rows, and a long dashed line where the zone's day turns. */
export function HourLines({ ticks, first, span, halves: withHalves = true, style }: { ticks: Tick[]; first: number; span: number; halves?: boolean; style?: CSSProperties }) {
  const length = span * MINUTE_MS
  const pct = (at: number) => `${((at - first) / length) * 100}%`
  const half = 30 * MINUTE_MS
  const halves = !withHalves ? [] : [...(ticks[0] && ticks[0].at - half > first ? [ticks[0].at - half] : []), ...ticks.map(tick => tick.at + half).filter(at => at < first + length)]
  return (
    <div className="schedule-lines" style={style} aria-hidden="true">
      {ticks.map(tick => <span key={tick.at} className={cn('schedule-line', tick.midnight && 'is-midnight')} style={{ left: pct(tick.at) }} />)}
      {halves.map(at => <span key={at} className="schedule-line is-half" style={{ left: pct(at) }} />)}
    </div>
  )
}

/** The tracks' width. */
export function useTrackWidth(hoursRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = hoursRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hoursRef])
  return width
}

/**
 * The wheel on a timeline: with Ctrl held (or in a trackpad pinch) it zooms the hours
 * about the pointer, once a frame; sideways (or with Shift) it moves them; otherwise it
 * moves the rows (`onScroll`, for rows drawn without a scrollbar) or scrolls as usual.
 */
export function useTimelineWheel(target: RefObject<HTMLElement | null>, hoursRef: RefObject<HTMLElement | null>, handlers: {
  width: number
  span: number
  onPan: (minutes: number) => void
  /** Zooms by `factor` about the point `at` (0–1) across the hours. */
  onZoom: (at: number, factor: number) => void
  onScroll?: (pixels: number) => void
  onStart?: () => void
}) {
  const latest = useRef(handlers)
  latest.current = handlers
  const zoom = useRef({ factor: 1, at: 0, frame: 0 })
  useEffect(() => () => cancelAnimationFrame(zoom.current.frame), [])
  useEffect(() => {
    const element = target.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const { width, span, onPan, onScroll, onStart } = latest.current
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      const sideways = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      if (event.ctrlKey) {
        event.preventDefault()
        onStart?.()
        const box = hoursRef.current?.getBoundingClientRect()
        if (!box?.width) return
        const pending = zoom.current
        pending.factor *= Math.exp(event.deltaY * unit * ZOOM_RATE)
        pending.at = clamp((event.clientX - box.left) / box.width, 0, 1)
        if (!pending.frame) pending.frame = requestAnimationFrame(() => {
          const { factor, at } = pending
          pending.frame = 0
          pending.factor = 1
          latest.current.onZoom(at, factor)
        })
      } else if (sideways && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        event.preventDefault()
        onStart?.()
        if (width) onPan(((sideways * unit) / width) * span)
      } else if (onScroll) {
        event.preventDefault()
        onStart?.()
        if (event.deltaY) onScroll(event.deltaY * unit)
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [target, hoursRef])
}

/**
 * Dragging free space (or, by touch or for a tech, a session) moves the window of hours
 * sideways and, where the days move too, up and down. The pointer is followed on the
 * window, so rows moving away under it do not end the drag; a flick by touch keeps going
 * for a moment, slowing down.
 */
export function usePan({ span, width, onPanX, onPanY }: { span: number; width: number; onPanX?: (minutes: number) => void; onPanY?: (pixels: number) => void }) {
  const [panning, setPanning] = useState(false)
  const latest = useRef({ span, width, onPanX, onPanY })
  latest.current = { span, width, onPanX, onPanY }
  const panned = useRef(false)
  const stop = useRef<() => void>(() => {})
  useEffect(() => () => stop.current(), [])

  const handlers = useMemo(() => {
    const moveBy = (dx: number, dy: number) => {
      const { span, width, onPanX, onPanY } = latest.current
      if (dx && width) onPanX?.((-dx / width) * span)
      if (dy) onPanY?.(dy)
    }
    const glide = (vx: number, vy: number) => {
      let last = performance.now()
      let frame = requestAnimationFrame(function step(now) {
        const dt = Math.min(now - last, 50)
        last = now
        moveBy(vx * dt, vy * dt)
        const decay = Math.pow(0.995, dt)
        vx *= decay
        vy *= decay
        if (Math.hypot(vx, vy) > 0.02) frame = requestAnimationFrame(step)
      })
      stop.current = () => {
        cancelAnimationFrame(frame)
        stop.current = () => {}
      }
    }
    const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      if (event.pointerType === 'mouse') event.preventDefault()
      stop.current()
      const pointerId = event.pointerId
      const touch = event.pointerType === 'touch'
      const start = { x: event.clientX, y: event.clientY }
      let last = start
      let moved = false
      const samples: { t: number; x: number; y: number }[] = []
      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return
        if (!moved) {
          if (Math.abs(next.clientX - start.x) + Math.abs(next.clientY - start.y) < PAN_THRESHOLD) return
          moved = true
          setPanning(true)
        }
        moveBy(next.clientX - last.x, next.clientY - last.y)
        last = { x: next.clientX, y: next.clientY }
        samples.push({ t: next.timeStamp, x: next.clientX, y: next.clientY })
        while (samples.length > 2 && next.timeStamp - samples[0]!.t > 100) samples.shift()
      }
      const up = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return
        stop.current()
        if (!moved) return
        // The click that ends a drag opens nothing.
        panned.current = true
        setTimeout(() => { panned.current = false }, 0)
        setPanning(false)
        const first = samples[0]
        const final = samples[samples.length - 1]
        if (touch && next.type === 'pointerup' && first && final && final.t > first.t && next.timeStamp - final.t < 80) {
          glide((final.x - first.x) / (final.t - first.t), (final.y - first.y) / (final.t - first.t))
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      stop.current = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        stop.current = () => {}
      }
    }
    return { onPointerDown, endsPan: () => panned.current, stopGlide: () => stop.current() }
  }, [])
  return { panning, handlers }
}

export type PanHandlers = ReturnType<typeof usePan>['handlers']

/** Now as a red line down the whole calendar, at `position` (0–1) across the hours. */
export function NowLine({ position }: { position: number | null }) {
  if (position === null || position < 0 || position > 1) return null
  return <div className="schedule-now-line" style={{ left: `calc(var(--schedule-label) + (100% - var(--schedule-label)) * ${position})` }} aria-hidden="true" />
}

/** Back to today and the whole day. */
export function ResetButton({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" className="schedule-reset" onClick={onReset}>
      <RotateCcw aria-hidden="true" />{t('schedule.reset')}
    </button>
  )
}

interface TrackProps {
  row: TimelineRow
  span: number
  layout: DayLayout
  timezone: string
  editable: boolean
  adding: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  /** Brings in a session beyond an edge of a window that moves; markers at the edges count them. */
  onReach?: (segment: Segment) => void
  drag: DragApi
  pan: PanHandlers
  label?: string
}

/** The tech a dragged session would have: dropping on a tech's row assigns it. */
function landingTech(preview: DragPreview): string | null {
  const original = preview.appointment?.tech?.id ?? null
  return preview.kind === 'move' && preview.techId !== undefined ? preview.techId : original
}

/** One row's window of hours: its sessions in lanes, what is being dragged, and markers for what lies beyond. */
export function Track({ row, span, layout, timezone, editable, adding, showTech, colorOf, onOpen, onDrop, onReach, drag, pan, label }: TrackProps) {
  const { t } = useTranslation()
  const length = span * MINUTE_MS
  const end = row.start + length
  const pct = (duration: number) => `${(duration / length) * 100}%`
  const { lanes } = layout
  const shown = layout.segments.filter(segment => segment.end > row.start && segment.start < end)
  // Sessions of the row's day outside the window: a marker at that edge brings them in.
  const before = layout.segments.filter(segment => segment.end <= row.start)
  const after = layout.segments.filter(segment => segment.start >= end)
  const endsDrag = () => pan.endsPan() || drag.endsDrag()

  const preview = drag.preview
  const moving = preview && preview.kind !== 'create' ? preview.appointment?.id : undefined
  // The moved session as it would land.
  const ghost = preview?.appointment && inRow(landingTech(preview), row) ? {
    ...preview.appointment,
    startsAt: preview.startsAt.toISOString(),
    endsAt: new Date(preview.startsAt.getTime() + preview.durationMinutes * MINUTE_MS).toISOString(),
    durationMinutes: preview.durationMinutes,
  } : null

  const timeRange = (start: number, stop: number) => `${timeInputValue(start, timezone)}–${timeInputValue(stop, timezone)}`
  const describe = (appointment: Appointment) => [
    timeRange(Date.parse(appointment.startsAt), Date.parse(appointment.endsAt)),
    appointment.customer.name,
    appointment.tech?.username ?? t('schedule.unassigned'),
    appointment.customer.owner.username,
    [appointment.company, appointment.position].filter(Boolean).join(' '),
    appointment.status === 'completed' ? t('schedule.status.completed') : '',
    appointment.hasConflict ? t('schedule.conflictBadge') : '',
  ].filter(Boolean).join(', ')

  const renderSegment = (segment: Segment) => {
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
        key={appointment.id}
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
        {/* No time on the card: the hours above the grid show it. */}
        <span className="schedule-event-meta">{appointment.customer.owner.username}</span>
        <span className="schedule-event-title">
          {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-hidden="true" />}
          <span className="truncate">{appointment.customer.name}</span>
        </span>
        {showTech && <span className="schedule-event-meta">{appointment.tech?.username ?? t('schedule.unassigned')}</span>}
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
  const renderGhost = (key: string, start: number, stop: number, title: string, color?: string) => {
    const from = Math.max(start, row.start)
    const to = Math.min(stop, end)
    if (to <= from) return null
    return (
      <div
        key={key}
        className={cn('schedule-event schedule-event-ghost', !color && 'schedule-event-new')}
        style={{ left: `calc(${pct(from - row.start)} + 1px)`, width: `calc(${pct(to - from)} - 2px)`, top: ROW_PADDING, bottom: ROW_PADDING, ...(color ? { '--event-color': color } : {}) } as CSSProperties}
        aria-hidden="true"
      >
        <span className="schedule-event-time">{title}</span>
      </div>
    )
  }

  return (
    <div
      className={cn('schedule-track', editable && 'is-editable')}
      data-schedule-row
      data-row={row.key}
      data-day={row.day}
      data-tech={row.techId === undefined ? undefined : row.techId ?? ''}
      data-start={row.start}
      data-span={span}
      aria-label={label}
      onPointerDown={(event) => {
        // Sessions an agent drags with a mouse stop the event before it gets here.
        if (!adding) pan.onPointerDown(event)
        else if (editable && event.target === event.currentTarget) drag.begin(event, { kind: 'create', origin: { row: row.key, techId: row.techId, at: pointerInstant(event) }, row: event.currentTarget })
      }}
      onClick={adding && editable ? (event) => {
        if (event.target !== event.currentTarget || endsDrag()) return
        // A click or tap proposes an hour from the half hour under it.
        const at = Math.floor(pointerInstant(event) / (30 * MINUTE_MS)) * 30 * MINUTE_MS
        onDrop({ kind: 'create', startsAt: new Date(at), durationMinutes: 60, techId: row.techId })
      } : undefined}
    >
      {shown.map(renderSegment)}
      {ghost && renderGhost('ghost', Date.parse(ghost.startsAt), Date.parse(ghost.endsAt), `${timeRange(Date.parse(ghost.startsAt), Date.parse(ghost.endsAt))} ${ghost.customer.name}`, colorOf(ghost))}
      {preview?.kind === 'create' && preview.row === row.key && renderGhost(
        'new', preview.startsAt.getTime(), preview.startsAt.getTime() + preview.durationMinutes * MINUTE_MS,
        `${timeRange(preview.startsAt.getTime(), preview.startsAt.getTime() + preview.durationMinutes * MINUTE_MS)} ${t('schedule.newSession')}`,
      )}
      {onReach && before.length > 0 && (
        <button
          type="button"
          className="schedule-more is-before"
          aria-label={t('schedule.earlier', { count: before.length })}
          title={t('schedule.earlier', { count: before.length })}
          onClick={() => { if (!endsDrag()) onReach(before.reduce((last, segment) => (segment.end > last.end ? segment : last))) }}
        >
          <ChevronLeft aria-hidden="true" />{before.length}
        </button>
      )}
      {onReach && after.length > 0 && (
        <button
          type="button"
          className="schedule-more is-after"
          aria-label={t('schedule.later', { count: after.length })}
          title={t('schedule.later', { count: after.length })}
          onClick={() => { if (!endsDrag()) onReach(after.reduce((next, segment) => (segment.start < next.start ? segment : next))) }}
        >
          {after.length}<ChevronRight aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
