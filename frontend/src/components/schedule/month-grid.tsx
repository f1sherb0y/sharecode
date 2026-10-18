import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { getLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatDayKey, sessionsOnDay } from '@/lib/schedule'
import { timeInputValue } from '@/lib/zoned-time'

interface MonthGridProps {
  days: string[]
  /** 'YYYY-MM' of the month shown; other days are dimmed. */
  month: string
  today: string
  appointments: Appointment[]
  timezone: string
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  onPickDay: (day: string) => void
}

// Match .schedule-chip's height, the gap between a day's rows and the date above them.
const CHIP_HEIGHT = 18
const CHIP_GAP = 2
const DAY_CHROME = 8 + 24 + CHIP_GAP

/** How many sessions fit in a day of the given height; the rest go behind "+N more". */
function sessionsThatFit(dayHeight: number): number {
  return Math.max(1, Math.floor((dayHeight - DAY_CHROME + CHIP_GAP) / (CHIP_HEIGHT + CHIP_GAP)))
}

export function MonthGrid({ days, month, today, appointments, timezone, colorOf, onOpen, onPickDay }: MonthGridProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  // Weeks share the height of the window, so a taller window shows more of each day.
  const firstWeek = useRef<HTMLDivElement>(null)
  const [perDay, setPerDay] = useState(3)
  useLayoutEffect(() => {
    const week = firstWeek.current
    if (!week) return
    const measure = () => setPerDay(sessionsThatFit(week.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(week)
    return () => observer.disconnect()
  }, [])
  const weeks = days.length / 7
  return (
    <div className="schedule-month" role="grid" style={{ '--weeks': weeks } as CSSProperties} aria-label={formatDayKey(`${month}-01`, locale, { year: 'numeric', month: 'long' })}>
      <div className="schedule-month-head" role="row">
        {days.slice(0, 7).map(day => (
          <span key={day} role="columnheader">{formatDayKey(day, locale, { weekday: 'short' })}</span>
        ))}
      </div>
      <div className="schedule-month-body">
        {Array.from({ length: weeks }, (_, week) => (
          <div key={week} ref={week === 0 ? firstWeek : undefined} className="schedule-month-week" role="row">
            {days.slice(week * 7, week * 7 + 7).map(day => {
              const sessions = sessionsOnDay(appointments, day, timezone)
              const hidden = sessions.length - perDay
              return (
                <div
                  key={day}
                  role="gridcell"
                  className={cn('schedule-month-day', !day.startsWith(month) && 'is-outside', day === today && 'is-today')}
                >
                  <button
                    type="button"
                    className="schedule-month-date"
                    aria-label={formatDayKey(day, locale, { weekday: 'long', month: 'long', day: 'numeric' })}
                    onClick={() => onPickDay(day)}
                  >
                    {Number(day.slice(8))}
                  </button>
                  {sessions.slice(0, hidden > 0 ? perDay - 1 : perDay).map(appointment => (
                    <button
                      key={appointment.id}
                      type="button"
                      className={cn('schedule-chip', `schedule-chip-${appointment.status}`, !appointment.tech && 'schedule-chip-unassigned')}
                      style={{ '--event-color': colorOf(appointment) } as CSSProperties}
                      title={`${appointment.customer.name} · ${appointment.tech?.username ?? t('schedule.unassigned')} · ${appointment.customer.owner.username}`}
                      onClick={() => onOpen(appointment)}
                    >
                      {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-label={t('schedule.conflictBadge')} />}
                      <span className="schedule-chip-time">{timeInputValue(Date.parse(appointment.startsAt), timezone)}</span>
                      <span className="truncate">{appointment.customer.name}</span>
                    </button>
                  ))}
                  {hidden > 0 && (
                    <button type="button" className="schedule-month-more" onClick={() => onPickDay(day)}>
                      {t('schedule.more', { count: hidden + 1 })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
