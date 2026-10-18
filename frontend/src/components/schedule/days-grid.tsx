import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import type { Appointment } from '@/types'
import { getLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { DAY_MINUTES, HOUR_MS, MINUTE_MS, MIN_WINDOW_MINUTES, clamp, formatDayKey, type DayLayout, type Segment } from '@/lib/schedule'
import { addDays, dayStart, minuteOfDay, startOfWeek } from '@/lib/zoned-time'
import {
  EMPTY_LAYOUT,
  HourLines,
  HoursHeader,
  LABEL_WIDTH,
  NowLine,
  ResetButton,
  Track,
  cardLines,
  labelStep,
  rowSize,
  usePan,
  useTimelineWheel,
  useTrackWidth,
  type DragApi,
  type PanHandlers,
  type Tick,
} from './timeline-parts'
import type { GridDrop } from './use-schedule-drag'

/** How long a focus keeps its day in view while days load around it. */
const SETTLE_MS = 3000
/** The hours across, in minutes from midnight: the whole day until zoomed in, and
 *  never beyond it. */
interface Zoom {
  start: number
  span: number
}
const WHOLE_DAY: Zoom = { start: 0, span: DAY_MINUTES }

export interface DaysFocus {
  day: string
  /** Changes to go to `day` again. */
  seq: number
  /** week: from its Monday if the day still shows; start: the day at the top. */
  align: 'week' | 'start'
}

export interface DaysGridHandle {
  scrollBy: (pixels: number) => void
  /** Moves zoomed-in hours later (or earlier, when negative) by so many minutes. */
  panBy: (minutes: number) => void
  resetZoom: () => void
}

/** The day at the top of the view and how far into it the view starts. */
interface Spot {
  day: string
  delta: number
}

function moveBy(spot: Spot, pixels: number, height: (day: string) => number): Spot {
  let { day, delta } = spot
  delta += pixels
  while (delta < 0) {
    day = addDays(day, -1)
    delta += height(day)
  }
  while (delta >= height(day)) {
    delta -= height(day)
    day = addDays(day, 1)
  }
  return { day, delta }
}

interface DaysGridProps {
  ref?: Ref<DaysGridHandle>
  focus: DaysFocus
  /** The days' sessions in lanes, for the days loaded. */
  layouts: Map<string, DayLayout>
  /** One tech's days: what is drawn or dropped on them is theirs. */
  techId?: string
  today: string
  timezone: string
  now: number
  editable: boolean
  adding: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  onReset: () => void
  drag: DragApi
  label: string
  /** The first and last day in view. */
  onVisible: (first: string, last: string) => void
}

interface DayContentProps {
  day: string
  zoomStart: number
  zoomSpan: number
  layout: DayLayout
  techId?: string
  timezone: string
  locale: string
  editable: boolean
  adding: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  onReach: (segment: Segment) => void
  drag: DragApi
  pan: PanHandlers
}

// A day's label and the hours shown of it (a day of 23 or 25 hours, where the clocks
// change, takes the same width); drawn again only when something about that day
// changes, not as the days move.
const DayContent = memo(function DayContent({ day, zoomStart, zoomSpan, techId, timezone, locale, ...track }: DayContentProps) {
  const midnight = dayStart(day, timezone).getTime()
  const scale = (dayStart(addDays(day, 1), timezone).getTime() - midnight) / MINUTE_MS / DAY_MINUTES
  return (
    <>
      <div className="schedule-row-label">
        <span className="schedule-row-name">{formatDayKey(day, locale, { weekday: 'short' })}</span>
        <span className="schedule-row-sublabel">{formatDayKey(day, locale, { month: 'numeric', day: 'numeric' })}</span>
      </div>
      <Track
        {...track}
        row={{ key: day, start: midnight + zoomStart * scale * MINUTE_MS, day, ...(techId ? { techId } : {}) }}
        span={zoomSpan * scale}
        timezone={timezone}
        label={formatDayKey(day, locale, { weekday: 'short', month: 'numeric', day: 'numeric' })}
      />
    </>
  )
})

/**
 * The week view: days down the page without end, each whole from midnight to midnight
 * until Ctrl and the wheel (or a pinch) zoom in on some hours; those then move sideways
 * within the day, and markers at the edges count the sessions outside and bring them in.
 * The days move up and down by wheel, dragging, flicking, keys or a drag at the edge,
 * without a scrollbar. Only the days in view are drawn; days with simultaneous sessions
 * are taller, and the day at the top stays put when days load.
 */
export function DaysGrid({ ref, focus, layouts, techId, today, timezone, now, editable, adding, showTech, colorOf, onOpen, onDrop, onReset, drag, label, onVisible }: DaysGridProps) {
  const locale = getLocale()
  const root = useRef<HTMLDivElement>(null)
  const days = useRef<HTMLDivElement>(null)
  const hoursRef = useRef<HTMLDivElement>(null)
  const width = useTrackWidth(hoursRef)
  const [view, setView] = useState(0)
  // A lane is one card high (+1px for the row border).
  const lines = cardLines(showTech)
  const heightOf = useCallback((day: string) => rowSize(layouts.get(day)?.lanes ?? 1, lines) + 1, [layouts, lines])
  const heights = useRef(heightOf)
  heights.current = heightOf
  const [spot, setSpot] = useState<Spot>({ day: focus.day, delta: 0 })

  // Moving the days by hand lets a focus go; the rows follow once a frame.
  const intent = useRef<{ day: string; align: DaysFocus['align']; at: number } | null>(null)
  const queued = useRef(0)
  const frame = useRef(0)
  const scrollBy = useCallback((pixels: number) => {
    intent.current = null
    queued.current += pixels
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const total = queued.current
      queued.current = 0
      setSpot(current => moveBy(current, total, heights.current))
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Zooming keeps the time under the pointer where it is.
  const [zoom, setZoom] = useState<Zoom>(WHOLE_DAY)
  const zoomBy = useCallback((at: number, factor: number) => setZoom(current => {
    const span = clamp(current.span * factor, MIN_WINDOW_MINUTES, DAY_MINUTES)
    const start = clamp(current.start + at * (current.span - span), 0, DAY_MINUTES - span)
    return span === current.span && start === current.start ? current : { start, span }
  }), [])
  const panBy = useCallback((minutes: number) => setZoom(current => {
    const start = clamp(current.start + minutes, 0, DAY_MINUTES - current.span)
    return start === current.start ? current : { ...current, start }
  }), [])
  // A marker at an edge brings the nearest session beyond it to the middle of the hours.
  const bringIn = useCallback((segment: Segment) => setZoom(current => {
    const from = minuteOfDay(segment.start, timezone)
    const middle = (from + Math.min(from + (segment.end - segment.start) / MINUTE_MS, from + current.span)) / 2
    return { ...current, start: clamp(middle - current.span / 2, 0, DAY_MINUTES - current.span) }
  }), [timezone])
  useImperativeHandle(ref, () => ({ scrollBy, panBy, resetZoom: () => setZoom(WHOLE_DAY) }), [scrollBy, panBy])
  const pan = usePan({ span: zoom.span, width, onPanX: panBy, onPanY: pixels => scrollBy(-pixels) })

  useLayoutEffect(() => {
    const element = days.current
    if (!element) return
    const read = () => setView(element.clientHeight)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useTimelineWheel(root, hoursRef, { width, span: zoom.span, onPan: panBy, onZoom: zoomBy, onScroll: scrollBy, onStart: pan.handlers.stopGlide })

  // A focus puts its day in view, and keeps it there while the days around it load.
  const focused = useRef(-1)
  useLayoutEffect(() => {
    if (!view) return
    let next = spot
    if (focused.current !== focus.seq) {
      focused.current = focus.seq
      intent.current = { day: focus.day, align: focus.align, at: Date.now() }
    }
    if (intent.current && Date.now() - intent.current.at > SETTLE_MS) intent.current = null
    if (intent.current) {
      const { day, align } = intent.current
      next = { day, delta: 0 }
      if (align === 'week') {
        const monday = startOfWeek(day)
        let total = 0
        for (let at = monday; at <= day; at = addDays(at, 1)) total += heightOf(at)
        // Its week from Monday, else as much of the week as leaves the day in view.
        if (total <= view) next = { day: monday, delta: 0 }
        else if (heightOf(day) <= view) next = moveBy({ day: addDays(day, 1), delta: 0 }, -view, heightOf)
      }
    }
    next = moveBy(next, 0, heightOf)
    if (next.day !== spot.day || Math.abs(next.delta - spot.delta) >= 0.5) setSpot(next)
  }, [focus.seq, heightOf, view]) // eslint-disable-line react-hooks/exhaustive-deps

  // The days in view, and one either side.
  const rows: { day: string; top: number; height: number }[] = []
  const above = addDays(spot.day, -1)
  rows.push({ day: above, top: -spot.delta - heightOf(above), height: heightOf(above) })
  for (let day = spot.day, y = -spot.delta; ; day = addDays(day, 1)) {
    const height = heightOf(day)
    rows.push({ day, top: y, height })
    y += height
    if (y >= view) {
      rows.push({ day: addDays(day, 1), top: y, height: heightOf(addDays(day, 1)) })
      break
    }
  }
  // A day is in view when its middle is: a sliver at an edge does not count.
  const middles = rows.filter(row => row.top + row.height / 2 >= 0 && row.top + row.height / 2 <= view)
  const firstDay = middles[0]?.day ?? spot.day
  const lastDay = middles[middles.length - 1]?.day ?? spot.day
  useEffect(() => {
    onVisible(firstDay, lastDay)
  }, [firstDay, lastDay]) // eslint-disable-line react-hooks/exhaustive-deps

  // The hours shown; labels, and half hours, only where they have room.
  const step = labelStep(width, zoom.span)
  const ticks = useMemo<Tick[]>(() => {
    const list: Tick[] = []
    for (let hour = Math.ceil(zoom.start / 60); hour * 60 < zoom.start + zoom.span; hour++) {
      // Labels that would run past the right edge are left out.
      const room = width > 0 ? ((zoom.start + zoom.span - hour * 60) / zoom.span) * width : Infinity
      list.push({ at: hour * HOUR_MS, label: hour % step || room < LABEL_WIDTH ? '' : `${String(hour).padStart(2, '0')}:00`, midnight: false })
    }
    return list
  }, [zoom.start, zoom.span, step, width])
  const first = zoom.start * MINUTE_MS
  const plain = heightOf('')

  return (
    <div
      ref={root}
      className={cn('schedule-grid', adding && editable && 'is-adding', pan.panning && 'is-panning')}
      role="region"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        const move = { ArrowUp: -plain, ArrowDown: plain, PageUp: -view, PageDown: view }[event.key]
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') panBy(event.key === 'ArrowLeft' ? -60 : 60)
        else if (move) scrollBy(move)
        else return
        event.preventDefault()
      }}
      data-tour="calendar"
    >
      <HoursHeader ticks={ticks} first={first} span={zoom.span} labeled hoursRef={hoursRef} />
      <div
        ref={days}
        className="schedule-days"
        data-schedule-scroll
        // Days' names move the days too.
        onPointerDown={(event) => { if (!(event.target as Element).closest('[data-schedule-row]')) pan.handlers.onPointerDown(event) }}
      >
        {rows.map(row => (
          <div key={row.day} className={cn('schedule-row', row.day === today && 'is-today')} style={{ top: row.top, height: row.height }}>
            <DayContent
              day={row.day}
              zoomStart={zoom.start}
              zoomSpan={zoom.span}
              layout={layouts.get(row.day) ?? EMPTY_LAYOUT}
              techId={techId}
              timezone={timezone}
              locale={locale}
              editable={editable}
              adding={adding}
              showTech={showTech}
              colorOf={colorOf}
              onOpen={onOpen}
              onDrop={onDrop}
              onReach={bringIn}
              drag={drag}
              pan={pan.handlers}
            />
          </div>
        ))}
        <HourLines ticks={ticks} first={first} span={zoom.span} halves={!width || (width / zoom.span) * 60 >= LABEL_WIDTH} />
      </div>
      {/* Now, at its time of day on every day. */}
      <NowLine position={(minuteOfDay(now, timezone) - zoom.start) / zoom.span} />
      <ResetButton onReset={onReset} />
    </div>
  )
}
