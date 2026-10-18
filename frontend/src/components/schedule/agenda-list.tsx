import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { Appointment } from '@/types'
import { Badge } from '@/components/ui'
import { getLocale } from '@/i18n'
import { SessionPeople } from './session-people'
import { cn } from '@/lib/utils'
import { formatDayKey, groupSpan, overlapGroups, sessionsOnDay, type LaneRank } from '@/lib/schedule'
import { timeInputValue } from '@/lib/zoned-time'

interface AgendaListProps {
  days: string[]
  today: string
  appointments: Appointment[]
  timezone: string
  showTech: boolean
  /** Off when every session is the same customer's, named above the list. */
  showCustomer?: boolean
  colorOf: (appointment: Appointment) => string
  /** Orders simultaneous sessions from left to right. */
  laneRank?: LaneRank
  onOpen: (appointment: Appointment) => void
  /** Extra controls per session, such as opening its room. */
  actions?: (appointment: Appointment) => ReactNode
  empty: string
}

/**
 * Sessions grouped by day; the default on phones. Sessions that overlap share a
 * row under one time, side by side where there is room.
 */
export function AgendaList({ days, today, appointments, timezone, showTech, showCustomer = true, colorOf, laneRank, onOpen, actions, empty }: AgendaListProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  const range = (from: number, to: number) => `${timeInputValue(from, timezone)}–${timeInputValue(to, timezone)}`
  const groups = days
    .map(day => ({ day, slots: overlapGroups(sessionsOnDay(appointments, day, timezone), laneRank) }))
    .filter(group => group.slots.length > 0)

  if (groups.length === 0) {
    return <p className="schedule-empty">{empty}</p>
  }

  return (
    <div className="schedule-agenda">
      {groups.map(({ day, slots }) => (
        <section key={day} aria-labelledby={`agenda-${day}`} className="schedule-agenda-day">
          <h2 id={`agenda-${day}`} className={cn('schedule-agenda-date', day === today && 'is-today')}>
            {formatDayKey(day, locale, { weekday: 'long', month: 'long', day: 'numeric' })}
            {day === today && <Badge variant="outline">{t('schedule.today')}</Badge>}
          </h2>
          <ul className="schedule-agenda-list">
            {slots.map(slot => {
              const span = groupSpan(slot)
              return (
                <li key={slot[0]!.id} className="schedule-agenda-slot">
                  <span className="schedule-agenda-time" aria-hidden="true">{range(span.from, span.to)}</span>
                  <ul className="schedule-agenda-cards">
                    {slot.map(appointment => {
                      const from = Date.parse(appointment.startsAt)
                      const to = Date.parse(appointment.endsAt)
                      // A session shows its own time only when it differs from the row's.
                      const ownTime = from !== span.from || to !== span.to
                      const tech = showTech ? appointment.tech?.username ?? t('schedule.unassigned') : null
                      const title = showCustomer ? appointment.customer.name : tech
                      const role = [appointment.company, appointment.position].filter(Boolean).join(' · ')
                      return (
                        <li
                          key={appointment.id}
                          className={cn('schedule-agenda-item', `schedule-agenda-${appointment.status}`)}
                          style={{ '--event-color': colorOf(appointment) } as CSSProperties}
                        >
                          <button type="button" className="schedule-agenda-main" onClick={() => onOpen(appointment)}>
                            <span className="schedule-agenda-title">
                              {appointment.hasConflict && <TriangleAlert className="schedule-event-alert" aria-label={t('schedule.conflictBadge')} />}
                              <span className={cn('schedule-agenda-own-time', !ownTime && 'sr-only')}>{range(from, to)}</span>
                              <span className="truncate">{title}</span>
                            </span>
                            {/* One customer's list names the tech in the title; its agent is the same on every row. */}
                            {showCustomer ? (
                              <span className="schedule-agenda-meta flex min-w-0 items-center gap-2">
                                <SessionPeople appointment={appointment} showTech={showTech} />
                                {role && <span className="truncate">{role}</span>}
                              </span>
                            ) : <span className="schedule-agenda-meta">{role}</span>}
                            {appointment.status === 'completed' && (
                              <Badge variant="secondary" className="schedule-agenda-status">{t('schedule.status.completed')}</Badge>
                            )}
                          </button>
                          {actions && <div className="schedule-agenda-actions">{actions(appointment)}</div>}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
