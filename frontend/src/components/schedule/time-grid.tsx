import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { cn } from '@/lib/utils'
import { FIRST_VISIBLE_HOUR, HOUR_HEIGHT, daySegments, type DaySegment } from '@/lib/schedule'
import { atMinute, minuteOfDay, timeInputValue } from '@/lib/zoned-time'
import { pointerMinute, type DragPreview, type GridDrop } from './use-schedule-drag'

export interface GridColumn {
  key: string
  day: string
  /** Day-view columns belong to a tech (null: unassigned); week-view columns have none. */
  techId?: string | null
  label: string
  sublabel?: string
  color?: string
  isToday?: boolean
}

interface TimeGridProps {
  columns: GridColumn[]
  appointments: Appointment[]
  timezone: string
  now: number
  editable: boolean
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onDrop: (drop: GridDrop) => void
  drag: {
    preview: DragPreview | null
    begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: { day: string; techId: string | null | undefined; minute: number } }) => void
    endsDrag: () => boolean
  }
  /** Scrolls this minute of the day into view when it changes. */
  focusMinute?: number | null
  label: string
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
/** Matches .schedule-event's line-height; a session shows only the lines that fit whole. */
const EVENT_LINE = 15
const EVENT_CHROME = 6

function belongs(appointment: Appointment, column: GridColumn): boolean {
  return column.techId === undefined || (appointment.tech?.id ?? null) === column.techId
}

/** The tech a dragged session would have: dropping on a tech's column assigns it. */
function landingTech(preview: DragPreview, columns: GridColumn[]): Appointment['tech'] {
  const original = preview.appointment?.tech ?? null
  if (preview.kind !== 'move' || preview.techId === undefined || preview.techId === original?.id) return original
  if (preview.techId === null) return null
  const column = columns.find(c => c.techId === preview.techId)
  return { id: preview.techId, username: column?.label ?? '', color: column?.color ?? '', role: 'tech', isDeleted: false }
}

/** Week and day views: hours down, days or techs across. */
export function TimeGrid({ columns, appointments, timezone, now, editable, showTech, colorOf, onOpen, onDrop, drag, focusMinute, label }: TimeGridProps) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: FIRST_VISIBLE_HOUR * HOUR_HEIGHT - 8 })
  }, [])
  useEffect(() => {
    if (focusMinute == null || !scroller.current) return
    scroller.current.scrollTo({ top: Math.max(0, (focusMinute / 60 - 1) * HOUR_HEIGHT) })
  }, [focusMinute])

  const preview = drag.preview
  const moving = preview && preview.kind !== 'create' ? preview.appointment?.id : undefined
  // The moved session as it would land, for the ghost.
  const ghost: Appointment | null = preview?.appointment ? {
    ...preview.appointment,
    startsAt: preview.startsAt.toISOString(),
    endsAt: new Date(preview.startsAt.getTime() + preview.durationMinutes * 60000).toISOString(),
    durationMinutes: preview.durationMinutes,
    tech: landingTech(preview, columns),
  } : null

  const timeRange = (appointment: Appointment) =>
    `${timeInputValue(Date.parse(appointment.startsAt), timezone)}–${timeInputValue(Date.parse(appointment.endsAt), timezone)}`

  const describe = (appointment: Appointment) => [
    timeRange(appointment),
    appointment.customer.name,
    appointment.tech?.username ?? t('schedule.unassigned'),
    t(`schedule.status.${appointment.status}`),
    appointment.hasConflict ? t('schedule.conflictBadge') : '',
  ].filter(Boolean).join(', ')

  const renderSegment = (segment: DaySegment, column: GridColumn, isGhost = false) => {
    const { appointment } = segment
    const height = Math.max(18, ((segment.end - segment.start) / 60) * HOUR_HEIGHT - 2)
    const style = {
      top: (segment.start / 60) * HOUR_HEIGHT,
      height,
      left: `calc(${(segment.column / segment.columns) * 100}% + 1px)`,
      width: `calc(${100 / segment.columns}% - 3px)`,
      '--event-color': colorOf(appointment),
    } as CSSProperties
    const lines = Math.max(1, Math.floor((height - EVENT_CHROME) / EVENT_LINE))
    const compact = lines === 1
    if (isGhost) {
      return (
        <div key={`ghost-${column.key}`} className={cn('schedule-event schedule-event-ghost', compact && 'schedule-event-compact')} style={style} aria-hidden="true">
          <span className="schedule-event-time">
            {timeRange(appointment)}
            {compact && <span className="schedule-event-inline"> {appointment.customer.name}</span>}
          </span>
          {!compact && <span className="schedule-event-title">{appointment.customer.name}</span>}
        </div>
      )
    }
    const meta = [
      showTech ? appointment.tech?.username ?? t('schedule.unassigned') : null,
      [appointment.company, appointment.position].filter(Boolean).join(' · '),
    ].filter(Boolean).slice(0, Math.max(0, lines - 2))
    return (
      <button
        key={`${appointment.id}-${column.key}`}
        type="button"
        data-appointment={appointment.id}
        className={cn(
          'schedule-event',
          `schedule-event-${appointment.status}`,
          !appointment.tech && 'schedule-event-unassigned',
          appointment.hasConflict && 'schedule-event-conflict',
          compact && 'schedule-event-compact',
          moving === appointment.id && 'schedule-event-moving',
        )}
        style={style}
        aria-label={describe(appointment)}
        title={describe(appointment)}
        onPointerDown={editable ? (event) => {
          const grabbedAt = atMinute(column.day, pointerMinute({ clientY: event.clientY, currentTarget: event.currentTarget.parentElement! }), timezone)
          drag.begin(event, { kind: 'move', appointment, grabOffset: Math.round((grabbedAt.getTime() - Date.parse(appointment.startsAt)) / 60000) })
        } : undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (!drag.endsDrag()) onOpen(appointment)
        }}
      >
        <span className="schedule-event-time">
          {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-hidden="true" />}
          {timeRange(appointment)}
          {compact && <span className="schedule-event-inline"> {appointment.customer.name}</span>}
        </span>
        {!compact && <span className="schedule-event-title">{appointment.customer.name}</span>}
        {meta.map((text, index) => <span key={index} className="schedule-event-meta">{text}</span>)}
        {editable && !segment.continuesAfter && (
          <span
            className="schedule-event-resize"
            aria-hidden="true"
            onPointerDown={(event) => {
              // How far from the end it was grabbed, so the end moves exactly as far as the pointer.
              const column = event.currentTarget.closest('[data-schedule-column]')!
              drag.begin(event, { kind: 'resize', appointment, grabOffset: pointerMinute({ clientY: event.clientY, currentTarget: column }) - segment.end })
            }}
          />
        )}
      </button>
    )
  }

  const nowMinute = minuteOfDay(now, timezone)
  // Today stands out among days; a day split by person needs no marker.
  const marksToday = new Set(columns.map(column => column.day)).size > 1

  return (
    <div className="schedule-grid" style={{ '--columns': columns.length } as CSSProperties} role="region" aria-label={label}>
      <div className="schedule-grid-scroll" ref={scroller} data-schedule-scroll>
        <div className="schedule-grid-inner">
          <div className="schedule-grid-head" aria-hidden="true">
            <div className="schedule-gutter" />
            {columns.map(column => (
              <div key={column.key} className={cn('schedule-column-head', marksToday && column.isToday && 'is-today')}>
                {column.color && <span className="schedule-dot" style={{ background: column.color }} />}
                <span className="schedule-column-label">{column.label}</span>
                {column.sublabel && <span className="schedule-column-sublabel">{column.sublabel}</span>}
              </div>
            ))}
          </div>
          <div className="schedule-grid-body">
            <div className="schedule-gutter" aria-hidden="true">
              {HOURS.map(hour => (
                <span key={hour} className="schedule-hour" style={{ top: hour * HOUR_HEIGHT }}>
                  {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
                </span>
              ))}
            </div>
            {columns.map(column => {
              const own = appointments.filter(appointment => belongs(appointment, column))
              const segments = daySegments(own, column.day, timezone)
              const ghostSegments = ghost && belongs(ghost, column) ? daySegments([ghost], column.day, timezone) : []
              const creating = preview?.kind === 'create' && preview.day === column.day && preview.techId === column.techId
              return (
                <div
                  key={column.key}
                  className={cn('schedule-column', marksToday && column.isToday && 'is-today', editable && 'is-editable')}
                  data-schedule-column
                  data-day={column.day}
                  data-tech={column.techId === undefined ? undefined : column.techId ?? ''}
                  aria-label={[column.label, column.sublabel].filter(Boolean).join(' ')}
                  onPointerDown={editable ? (event) => {
                    if (event.target !== event.currentTarget) return
                    drag.begin(event, { kind: 'create', origin: { day: column.day, techId: column.techId, minute: pointerMinute(event) } })
                  } : undefined}
                  onClick={editable ? (event) => {
                    if (event.target !== event.currentTarget || drag.endsDrag()) return
                    // A click or tap on free time proposes a session there, on the half hour.
                    const minute = Math.floor(pointerMinute(event) / 30) * 30
                    onDrop({ kind: 'create', startsAt: atMinute(column.day, minute, timezone), durationMinutes: 60, techId: column.techId })
                  } : undefined}
                >
                  {segments.map(segment => renderSegment(segment, column))}
                  {ghostSegments.map(segment => renderSegment({ ...segment, column: 0, columns: 1 }, column, true))}
                  {creating && preview && (
                    <div
                      className="schedule-event schedule-event-ghost schedule-event-new"
                      style={{
                        top: (minuteOfDay(preview.startsAt, timezone) / 60) * HOUR_HEIGHT,
                        height: Math.max(18, (preview.durationMinutes / 60) * HOUR_HEIGHT - 2),
                        left: 1,
                        width: 'calc(100% - 3px)',
                      }}
                      aria-hidden="true"
                    >
                      <span className="schedule-event-time">
                        {timeInputValue(preview.startsAt, timezone)}–{timeInputValue(preview.startsAt.getTime() + preview.durationMinutes * 60000, timezone)}
                      </span>
                      <span className="schedule-event-title">{t('schedule.newSession')}</span>
                    </div>
                  )}
                  {column.isToday && (
                    <div className="schedule-now" style={{ top: (nowMinute / 60) * HOUR_HEIGHT }} aria-hidden="true" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
