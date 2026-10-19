import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Appointment } from '@/types'
import { DAY_MINUTES, MINUTE_MS, agentName, sessionTitle } from '@/lib/schedule'
import { addDays, dayStart, timeInputValue } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'

/** Minutes a click on free time snaps to. */
const SLOT_MINUTES = 30
/** Minutes a drag over free time snaps to. */
const DRAG_MINUTES = 15
/** Pixels the pointer moves before a press on free time becomes a drag. */
const DRAG_PX = 4
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

interface Placed {
  appointment: Appointment
  /** Minutes from the day's midnight. */
  top: number
  bottom: number
  lane: number
  lanes: number
}

/** A day's sessions with side-by-side lanes where they overlap. */
function place(appointments: Appointment[], day: string, timeZone: string): Placed[] {
  const from = dayStart(day, timeZone).getTime()
  const to = dayStart(addDays(day, 1), timeZone).getTime()
  const items = appointments
    .map(appointment => ({ appointment, start: Date.parse(appointment.startsAt), end: Date.parse(appointment.endsAt) }))
    .filter(item => item.start < to && item.end > from)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const placed: Placed[] = []
  let cluster: Placed[] = []
  let clusterEnd = -Infinity
  const laneEnds: number[] = []
  const close = () => {
    const lanes = Math.max(1, ...cluster.map(item => item.lane + 1))
    for (const item of cluster) item.lanes = lanes
    cluster = []
    laneEnds.length = 0
  }
  for (const item of items) {
    if (item.start >= clusterEnd) close()
    let lane = laneEnds.findIndex(end => end <= item.start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = item.end
    clusterEnd = Math.max(clusterEnd, item.end)
    const entry: Placed = {
      appointment: item.appointment,
      top: Math.max(0, (item.start - from) / MINUTE_MS),
      bottom: Math.min(DAY_MINUTES, (item.end - from) / MINUTE_MS),
      lane,
      lanes: 1,
    }
    cluster.push(entry)
    placed.push(entry)
  }
  close()
  return placed
}

interface DayColumnsProps {
  days: string[]
  today: string
  timezone: string
  now: number
  appointments: Appointment[]
  colorOf: (appointment: Appointment) => string
  /** Free time was clicked (the day and the minute it snaps to) or dragged over (and the end). */
  onSlot?: (day: string, minute: number, end?: number) => void
  onOpen: (appointment: Appointment) => void
}

/** Hours down the side, one column per day; sessions sit where their time is. */
export function DayColumns({ days, today, timezone, now, appointments, colorOf, onSlot, onOpen }: DayColumnsProps) {
  const { t } = useTranslation()
  const columns = useMemo(() => days.map(day => ({ day, placed: place(appointments, day, timezone) })), [days, appointments, timezone])
  const nowMinute = days.includes(today) ? (now - dayStart(today, timezone).getTime()) / MINUTE_MS : null
  const time = (instant: string) => timeInputValue(Date.parse(instant), timezone)

  // Dragging over free time with a mouse or pen picks the range; touch keeps scrolling.
  const [draft, setDraft] = useState<{ day: string; from: number; to: number } | null>(null)
  const drag = useRef<{ y: number; anchor: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const minuteAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(DAY_MINUTES, Math.max(0, ((event.clientY - rect.top) / rect.height) * DAY_MINUTES))
  }
  const press = (day: string) => (event: PointerEvent<HTMLDivElement>) => {
    if (!onSlot || event.pointerType === 'touch' || event.button !== 0 || event.target !== event.currentTarget) return
    const anchor = Math.min(DAY_MINUTES - DRAG_MINUTES, Math.floor(minuteAt(event) / DRAG_MINUTES) * DRAG_MINUTES)
    dragged.current = false
    drag.current = { y: event.clientY, anchor, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft({ day, from: anchor, to: anchor + DRAG_MINUTES })
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    if (Math.abs(event.clientY - state.y) >= DRAG_PX) state.moved = true
    if (!state.moved) return
    const minute = minuteAt(event)
    setDraft(current => current && {
      ...current,
      from: Math.min(state.anchor, Math.floor(minute / DRAG_MINUTES) * DRAG_MINUTES),
      to: Math.max(state.anchor + DRAG_MINUTES, Math.ceil(minute / DRAG_MINUTES) * DRAG_MINUTES),
    })
  }
  const release = () => {
    const state = drag.current
    drag.current = null
    setDraft(null)
    if (!state?.moved || !draft || !onSlot) return
    dragged.current = true
    onSlot(draft.day, draft.from, draft.to)
  }

  const slot = (day: string) => (event: MouseEvent<HTMLDivElement>) => {
    // The click that ends a drag has already been handled.
    if (dragged.current) {
      dragged.current = false
      return
    }
    if (!onSlot || event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    const minute = ((event.clientY - rect.top) / rect.height) * DAY_MINUTES
    onSlot(day, Math.min(DAY_MINUTES - SLOT_MINUTES, Math.floor(minute / SLOT_MINUTES) * SLOT_MINUTES))
  }

  return (
    <div className="wt-grid">
      <div className="wt-gutter" aria-hidden="true">
        {HOURS.map(hour => (
          <span key={hour} className="wt-hour" style={{ top: `calc(${hour} * var(--wt-hour))` }}>
            {/* The time of now takes the place of an hour it would cover. */}
            {hour > 0 && (nowMinute === null || Math.abs(nowMinute - hour * 60) > 12) && `${String(hour).padStart(2, '0')}:00`}
          </span>
        ))}
        {nowMinute !== null && (
          <span className="wt-now-label" style={{ top: `calc(${nowMinute / 60} * var(--wt-hour))` }}>
            {timeInputValue(now, timezone)}
          </span>
        )}
      </div>
      <div className="wt-columns" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {columns.map(({ day, placed }) => (
          <div
            key={day}
            className={cn('wt-column', onSlot && 'is-open', day === today && days.length > 1 && 'is-today')}
            data-day={day}
            onClick={slot(day)}
            onPointerDown={press(day)}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={() => { drag.current = null; setDraft(null) }}
          >
            {placed.map(({ appointment, top, bottom, lane, lanes }) => {
              const block = appointment.isBlock
              const task = block ? appointment.notes : [appointment.company, appointment.position].filter(Boolean).join(' ')
              const short = bottom - top < 45
              return (
                <button
                  key={appointment.id}
                  type="button"
                  className={cn('wt-card', block && 'is-busy', short && 'is-short', appointment.status === 'completed' && 'is-done', appointment.hasConflict && 'is-clash')}
                  data-appointment={appointment.id}
                  style={{
                    '--event-color': colorOf(appointment),
                    top: `calc(${top / 60} * var(--wt-hour) + 1px)`,
                    height: `calc(${(bottom - top) / 60} * var(--wt-hour) - 2px)`,
                    left: `calc(${(lane / lanes) * 100}% + 2px)`,
                    width: `calc(${100 / lanes}% - 4px)`,
                  } as CSSProperties}
                  onClick={() => onOpen(appointment)}
                >
                  <span className="wt-card-who">{block ? t('schedule.busy') : agentName(appointment)}</span>
                  <span className="wt-card-time">{time(appointment.startsAt)} – {time(appointment.endsAt)}</span>
                  {(task || (!block && appointment.customer)) && (
                    <span className="wt-card-task">{task || sessionTitle(appointment, t)}</span>
                  )}
                </button>
              )
            })}
            {draft?.day === day && drag.current?.moved && (
              <span
                className="wt-draft"
                style={{ top: `calc(${draft.from / 60} * var(--wt-hour) + 1px)`, height: `calc(${(draft.to - draft.from) / 60} * var(--wt-hour) - 2px)` }}
                aria-hidden="true"
              >
                {timeInputValue(dayStart(day, timezone).getTime() + draft.from * MINUTE_MS, timezone)} – {timeInputValue(dayStart(day, timezone).getTime() + draft.to * MINUTE_MS, timezone)}
              </span>
            )}
            {day === today && nowMinute !== null && (
              <span className="wt-now-line" style={{ top: `calc(${nowMinute / 60} * var(--wt-hour))` }} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
