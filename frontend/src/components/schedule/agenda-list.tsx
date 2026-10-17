import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { Badge } from '@/components/ui'
import { getLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatDayKey, sessionsOnDay } from '@/lib/schedule'
import { timeInputValue } from '@/lib/zoned-time'

interface AgendaListProps {
  days: string[]
  today: string
  appointments: Appointment[]
  timezone: string
  showTech: boolean
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  /** Extra controls per session, such as opening its room. */
  actions?: (appointment: Appointment) => ReactNode
  empty: string
}

/** Sessions grouped by day; the default on phones. */
export function AgendaList({ days, today, appointments, timezone, showTech, colorOf, onOpen, actions, empty }: AgendaListProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  const groups = days
    .map(day => ({ day, sessions: sessionsOnDay(appointments, day, timezone) }))
    .filter(group => group.sessions.length > 0)

  if (groups.length === 0) {
    return <p className="schedule-empty">{empty}</p>
  }

  return (
    <div className="schedule-agenda">
      {groups.map(({ day, sessions }) => (
        <section key={day} aria-labelledby={`agenda-${day}`} className="schedule-agenda-day">
          <h2 id={`agenda-${day}`} className={cn('schedule-agenda-date', day === today && 'is-today')}>
            {formatDayKey(day, locale, { weekday: 'long', month: 'long', day: 'numeric' })}
            {day === today && <Badge variant="outline">{t('schedule.today')}</Badge>}
          </h2>
          <ul className="schedule-agenda-list">
            {sessions.map(appointment => (
              <li
                key={appointment.id}
                className={cn('schedule-agenda-item', `schedule-agenda-${appointment.status}`)}
                style={{ '--event-color': colorOf(appointment) } as CSSProperties}
              >
                <button type="button" className="schedule-agenda-main" onClick={() => onOpen(appointment)}>
                  <span className="schedule-agenda-time">
                    {timeInputValue(Date.parse(appointment.startsAt), timezone)}–{timeInputValue(Date.parse(appointment.endsAt), timezone)}
                  </span>
                  <span className="schedule-agenda-title">
                    {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-label={t('schedule.conflictBadge')} />}
                    <span className="truncate">{appointment.customer.name}</span>
                  </span>
                  <span className="schedule-agenda-meta">
                    {[showTech ? appointment.tech?.username ?? t('schedule.unassigned') : null, appointment.company, appointment.position].filter(Boolean).join(' · ')}
                  </span>
                  {appointment.status !== 'scheduled' && (
                    <Badge variant={appointment.status === 'cancelled' ? 'destructive' : 'secondary'} className="schedule-agenda-status">
                      {t(`schedule.status.${appointment.status}`)}
                    </Badge>
                  )}
                </button>
                {actions && <div className="schedule-agenda-actions">{actions(appointment)}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
