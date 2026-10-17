import type { CSSProperties } from 'react'
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

const VISIBLE_PER_DAY = 3

export function MonthGrid({ days, month, today, appointments, timezone, colorOf, onOpen, onPickDay }: MonthGridProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  return (
    <div className="schedule-month" role="grid" aria-label={formatDayKey(`${month}-01`, locale, { year: 'numeric', month: 'long' })}>
      <div className="schedule-month-head" role="row">
        {days.slice(0, 7).map(day => (
          <span key={day} role="columnheader">{formatDayKey(day, locale, { weekday: 'short' })}</span>
        ))}
      </div>
      <div className="schedule-month-body">
        {Array.from({ length: days.length / 7 }, (_, week) => (
          <div key={week} className="schedule-month-week" role="row">
            {days.slice(week * 7, week * 7 + 7).map(day => {
              const sessions = sessionsOnDay(appointments, day, timezone)
              const hidden = sessions.length - VISIBLE_PER_DAY
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
                  {sessions.slice(0, hidden > 0 ? VISIBLE_PER_DAY - 1 : VISIBLE_PER_DAY).map(appointment => (
                    <button
                      key={appointment.id}
                      type="button"
                      className={cn('schedule-chip', `schedule-chip-${appointment.status}`, !appointment.tech && 'schedule-chip-unassigned')}
                      style={{ '--event-color': colorOf(appointment) } as CSSProperties}
                      title={`${appointment.customer.name} · ${appointment.tech?.username ?? t('schedule.unassigned')}`}
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
