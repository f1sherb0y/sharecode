import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import type { Appointment } from '@/types'
import { getLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { clamp, formatDayKey, windowStart, type DayLayout } from '@/lib/schedule'
import { addDays, minuteOfDay, startOfWeek } from '@/lib/zoned-time'
import {
  EMPTY_LAYOUT,
  HourLines,
  HoursHeader,
  LANE_GAP,
  LINES,
  MAX_LINES,
  NowLine,
  ROW_PADDING,
  ResetButton,
  Track,
  lanePitch,
  usePan,
  useTicks,
  useTrackWidth,
  type DragApi,
  type PanHandlers,
} from './timeline-parts'
import type { GridDrop } from './use-schedule-drag'

/** A week of days with a lane each fills the window. */
const DAYS_IN_VIEW = 7
/** How long a focus keeps its day in view while days load around it. */
const SETTLE_MS = 3000

export interface DaysFocus {
  day: string
  /** Changes to go to `day` again. */
  seq: number
  /** week: from its Monday if the day still shows; start: the day at the top; keep: at
   *  the top, as far into it as the top day was. */
  align: 'week' | 'start' | 'keep'
}

export interface DaysGridHandle {
  scrollBy: (pixels: number) => void
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
  /** Where every day's window of hours starts, in minutes from its midnight. */
  phase: number
  /** Minutes the window spans. */
  span: number
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
  onPan: (minutes: number) => void
  onFit: (hours: number) => void
  onReset: () => void
  drag: DragApi
  label: string
  /** The first and last day in view. */
  onVisible: (first: string, last: string) => void
}

interface DayContentProps {
  day: string
  phase: number
  span: number
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
  onPan: (minutes: number) => void
  drag: DragApi
  pan: PanHandlers
}

// A day's label and hours; drawn again only when something about that day changes, not as the days move.
const DayContent = memo(function DayContent({ day, phase, techId, timezone, locale, ...track }: DayContentProps) {
  return (
    <>
      <div className="schedule-row-label">
        <span className="schedule-row-name">{formatDayKey(day, locale, { weekday: 'short' })}</span>
        <span className="schedule-row-sublabel">{formatDayKey(day, locale, { month: 'numeric', day: 'numeric' })}</span>
      </div>
      <Track
        {...track}
        row={{ key: day, start: windowStart(day, phase, timezone), day, ...(techId ? { techId } : {}) }}
        timezone={timezone}
        dateAtMidnight
        label={formatDayKey(day, locale, { weekday: 'short', month: 'numeric', day: 'numeric' })}
      />
    </>
  )
})

/**
 * The week view: days down the page without end, a window of hours across. The days
 * move by wheel, dragging, flicking, keys or a drag at the edge, without a scrollbar;
 * only the days in view are drawn. Days with simultaneous sessions are taller, and the
 * day at the top stays put when days load.
 */
export function DaysGrid({ ref, focus, phase, span, layouts, techId, today, timezone, now, editable, adding, showTech, colorOf, onOpen, onDrop, onPan, onFit, onReset, drag, label, onVisible }: DaysGridProps) {
  const locale = getLocale()
  const root = useRef<HTMLDivElement>(null)
  const days = useRef<HTMLDivElement>(null)
  const hoursRef = useRef<HTMLDivElement>(null)
  const width = useTrackWidth(hoursRef, onFit)
  const [view, setView] = useState(0)
  // A lane is as tall as a seventh of the view allows, three to seven lines.
  const lane = clamp(Math.floor(view / DAYS_IN_VIEW) + LANE_GAP - 2 * ROW_PADDING - 1, lanePitch(LINES), lanePitch(MAX_LINES))
  const heightOf = useCallback((day: string) => (layouts.get(day)?.lanes ?? 1) * lane - LANE_GAP + 2 * ROW_PADDING + 1, [layouts, lane])
  const heights = useRef(heightOf)
  heights.current = heightOf
  const [spot, setSpot] = useState<Spot>({ day: focus.day, delta: 0 })

  // Moving the days by hand lets a focus go; the rows follow once a frame.
  const intent = useRef<{ day: string; align: 'week' | 'start'; at: number } | null>(null)
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
  useImperativeHandle(ref, () => ({ scrollBy }), [scrollBy])
  const pan = usePan({ span, width, onPanX: onPan, onPanY: pixels => scrollBy(-pixels) })

  useLayoutEffect(() => {
    const element = days.current
    if (!element) return
    const read = () => setView(element.clientHeight)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The wheel moves the days; sideways (or with Shift) it moves the hours.
  const latest = useRef({ width, span, onPan, stopGlide: pan.handlers.stopGlide })
  latest.current = { width, span, onPan, stopGlide: pan.handlers.stopGlide }
  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const { width, span, onPan, stopGlide } = latest.current
      stopGlide()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      const sideways = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      if (sideways && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        if (width) onPan(((sideways * unit) / width) * span)
      } else if (event.deltaY) scrollBy(event.deltaY * unit)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [scrollBy])

  // A focus puts its day in view, and keeps it there while the days around it load.
  const focused = useRef(-1)
  useLayoutEffect(() => {
    if (!view) return
    let next = spot
    if (focused.current !== focus.seq) {
      focused.current = focus.seq
      intent.current = focus.align === 'keep' ? null : { day: focus.day, align: focus.align, at: Date.now() }
      if (focus.align === 'keep') next = { day: focus.day, delta: spot.delta }
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
  const lastDay = rows[rows.length - 2]!.day
  useEffect(() => {
    onVisible(spot.day, lastDay)
  }, [spot.day, lastDay]) // eslint-disable-line react-hooks/exhaustive-deps

  const first = windowStart(spot.day, phase, timezone)
  const ticks = useTicks(first, span, timezone, false, width)
  // Now, at its time of day on every day.
  const nowAt = useMemo(() => ((((minuteOfDay(now, timezone) - phase) % 1440) + 1440) % 1440) / span, [now, timezone, phase, span])
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
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') onPan(event.key === 'ArrowLeft' ? -60 : 60)
        else if (move) scrollBy(move)
        else return
        event.preventDefault()
      }}
      data-tour="calendar"
    >
      <HoursHeader ticks={ticks} first={first} span={span} labeled hoursRef={hoursRef} />
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
              phase={phase}
              span={span}
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
              onPan={onPan}
              drag={drag}
              pan={pan.handlers}
            />
          </div>
        ))}
        <HourLines ticks={ticks} first={first} span={span} />
      </div>
      <NowLine position={nowAt} />
      <ResetButton onReset={onReset} />
    </div>
  )
}
