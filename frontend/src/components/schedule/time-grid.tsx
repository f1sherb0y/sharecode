import { useCallback, useRef } from 'react'
import type { Appointment } from '@/types'
import { cn } from '@/lib/utils'
import { MINUTE_MS, type DayLayout, type Segment } from '@/lib/schedule'
import {
  EMPTY_LAYOUT,
  HourLines,
  HoursHeader,
  LABEL_WIDTH,
  NowLine,
  ResetButton,
  Track,
  cardLines,
  rowSize,
  usePan,
  useTicks,
  useTimelineWheel,
  useTrackWidth,
  type DragApi,
  type TimelineRow,
} from './timeline-parts'
import type { GridDrop } from './use-schedule-drag'

export interface DayRow extends TimelineRow {
  /** A tech's name; empty when the page title names the only row. */
  label: string
  /** A tech's name opens their own calendar. */
  onPick?: () => void
}

interface TimeGridProps {
  /** Every row starts at the same instant. */
  rows: DayRow[]
  /** Rows keep a column for names, even an unnamed one. */
  labeled: boolean
  /** Each row's sessions in lanes, in the order of the rows. */
  layouts: DayLayout[]
  /** Minutes every row's window spans. */
  span: number
  timezone: string
  now: number
  editable: boolean
  /** "Add" is on: clicking or drawing on a row plans a session there. */
  adding: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  /** Moves the window by so many minutes (later when positive), as far as one likes. */
  onPan: (minutes: number) => void
  /** Zooms the hours by `factor` about the point `at` (0–1) across them. */
  onZoom: (at: number, factor: number) => void
  /** Back to today and the whole day. */
  onReset: () => void
  drag: DragApi
  label: string
}

/**
 * The day view: a row per tech (and one for sessions waiting for a tech), the whole day
 * across at first. Ctrl and the wheel (or a pinch) zoom the hours, which are dragged
 * sideways through the days without end, a date where each begins. Sessions at the same
 * time in a row take lanes, one under another.
 */
export function TimeGrid({ rows, labeled, layouts, span, timezone, now, editable, adding, showTech, colorOf, onOpen, onDrop, onPan, onZoom, onReset, drag, label }: TimeGridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const hoursRef = useRef<HTMLDivElement>(null)
  const width = useTrackWidth(hoursRef)
  const pan = usePan({ span, width, onPanX: onPan })
  useTimelineWheel(scroller, hoursRef, { width, span, onPan, onZoom, onStart: pan.handlers.stopGlide })
  const first = rows[0]?.start ?? 0
  const ticks = useTicks(first, span, timezone, true, width)
  // A marker at an edge brings the nearest session beyond it to the middle of the window.
  const reach = useCallback((segment: Segment) => {
    const end = Math.min(segment.end, segment.start + span * MINUTE_MS)
    onPan(((segment.start + end) / 2 - first) / MINUTE_MS - span / 2)
  }, [onPan, first, span])
  const lines = cardLines(showTech)
  const lanesOf = (index: number) => (layouts[index] ?? EMPTY_LAYOUT).lanes

  return (
    <div
      className={cn('schedule-grid', !labeled && 'is-unlabeled', adding && editable && 'is-adding', pan.panning && 'is-panning')}
      // Ends below the last row (hours row + borders).
      style={{ maxHeight: `calc(1.75rem + 3px + ${rows.reduce((sum, _, index) => sum + rowSize(lanesOf(index), lines) + 1, 0)}px)` }}
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
          <HoursHeader ticks={ticks} first={first} span={span} labeled={labeled} hoursRef={hoursRef} />
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="schedule-row"
              // A card's height per lane (+1px for the row border).
              style={{ flex: 'none', height: rowSize(lanesOf(index), lines) + 1 }}
            >
              {labeled && (
                <div className="schedule-row-label">
                  {row.onPick
                    ? <button type="button" className="schedule-row-name schedule-row-pick" onClick={row.onPick}>{row.label}</button>
                    : <span className="schedule-row-name">{row.label}</span>}
                </div>
              )}
              <Track
                row={row}
                span={span}
                layout={layouts[index] ?? EMPTY_LAYOUT}
                timezone={timezone}
                editable={editable}
                adding={adding}
                showTech={showTech}
                colorOf={colorOf}
                onOpen={onOpen}
                onDrop={onDrop}
                onReach={reach}
                drag={drag}
                pan={pan.handlers}
                label={row.label || undefined}
              />
            </div>
          ))}
          <HourLines ticks={ticks} first={first} span={span} halves={!width || (width / span) * 60 >= LABEL_WIDTH} />
        </div>
      </div>
      <NowLine position={(now - first) / (span * MINUTE_MS)} />
      <ResetButton onReset={onReset} />
    </div>
  )
}
