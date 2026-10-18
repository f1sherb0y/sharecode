import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { api } from '@/api'
import { useNow } from '@/hooks/use-now'
import { getLocale } from '@/i18n'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import { UNASSIGNED_COLOR, groupSpan, overlapGroups } from '@/lib/schedule'
import { dateKeyOf, daysBetween, timeInputValue, todayKey } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore, useSettingsStore } from '@/stores'
import { StatusBadge } from './appointment-dialog'
import { SessionRoomActions } from './session-room-actions'
import { useOnlyMine } from './use-only-mine'
import '@/styles/schedule.css'

const SHOWN = 5
const HOUR = 3_600_000
/** The card covers sessions from two hours ago to ten hours ahead. */
const BEFORE = 2 * HOUR
const AHEAD = 10 * HOUR
/** The range asked of the server moves in steps, so it is not fetched anew every minute. */
const STEP = HOUR / 4

/** Sessions around now above the room list: a tech's own, or everyone's (an agent's own) for staff. */
export function TodaySessions() {
  const { t } = useTranslation()
  const user = useAuthStore(state => state.user)
  const timezone = useSettingsStore(state => state.timezone)
  const { mine } = useOnlyMine()
  const now = useNow()
  const today = todayKey(timezone)
  const staff = isStaff(user)
  const from = Math.floor((now - BEFORE) / STEP) * STEP
  const to = Math.ceil((now + AHEAD) / STEP) * STEP
  const params = useMemo(() => ({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    mine,
  }), [from, to, mine])
  const { data } = useQuery({
    queryKey: queryKeys.appointments(params),
    queryFn: async ({ signal }) => (await api.listAppointments(params, signal)).appointments,
    enabled: !!user,
    refetchInterval: 60_000,
  })

  const sessions = (data ?? []).filter(a => Date.parse(a.endsAt) > now - BEFORE && Date.parse(a.startsAt) < now + AHEAD)
  if (sessions.length === 0) return null
  const range = (start: number, end: number) => `${timeInputValue(start, timezone)}–${timeInputValue(end, timezone)}`
  // Yesterday's or tomorrow's sessions say so; today's need not.
  const relativeDay = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const dayOf = (instant: number) => {
    const offset = daysBetween(today, dateKeyOf(instant, timezone))
    return offset === 0 ? null : relativeDay.format(offset, 'day')
  }
  // Simultaneous sessions share a row. Finished rows drop to the end so the next one is on top.
  const finished = (group: typeof sessions) => group.every(appointment => Date.parse(appointment.endsAt) <= now)
  const rows = overlapGroups(sessions).sort((a, b) => Number(finished(a)) - Number(finished(b)))
  const shownRows: typeof rows = []
  let shownCount = 0
  for (const row of rows) {
    if (shownRows.length > 0 && shownCount + row.length > SHOWN) break
    shownRows.push(row)
    shownCount += row.length
  }

  return (
    <section className="today-sessions" aria-labelledby="today-sessions-title">
      <div className="today-sessions-head">
        <h2 id="today-sessions-title" className="flex items-center gap-1 text-sm font-semibold">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {t('schedule.todayCard.title')}
          <span className="schedule-count">{sessions.length}</span>
        </h2>
      </div>
      <ul className="today-sessions-list">
        {shownRows.map(row => {
          const span = groupSpan(row)
          const day = dayOf(span.from)
          return (
            <li key={row[0]!.id} className="today-slot">
              <span className="today-session-time tabular-nums" aria-hidden="true">
                {day && <span className="today-session-day">{day}</span>}
                {range(span.from, span.to)}
              </span>
              <ul className="today-slot-cards">
                {row.map(appointment => {
                  const start = Date.parse(appointment.startsAt)
                  const end = Date.parse(appointment.endsAt)
                  const ownTime = start !== span.from || end !== span.to
                  return (
                    <li
                      key={appointment.id}
                      className={cn('today-session', end <= now && 'is-past')}
                      style={{ '--event-color': appointment.tech?.color ?? UNASSIGNED_COLOR } as CSSProperties}
                    >
                      <Link to={`/schedule?view=day&date=${dateKeyOf(start, timezone)}&session=${appointment.id}`} className="today-session-main">
                        <span className="truncate">
                          <span className={cn('today-session-own-time tabular-nums', !ownTime && 'sr-only')}>
                            {dayOf(start) && <span className="sr-only">{dayOf(start)} </span>}{range(start, end)}{' '}
                          </span>
                          <span className="font-medium">{appointment.customer.name}</span>
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[staff ? appointment.tech?.username ?? t('schedule.unassigned') : null, appointment.company, appointment.position].filter(Boolean).join(' · ')}
                        </span>
                      </Link>
                      {appointment.status === 'completed' ? <StatusBadge status="completed" /> : <SessionRoomActions appointment={appointment} compact />}
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>
      {sessions.length > shownCount && (
        <Link to={staff ? '/schedule?view=day' : '/schedule?view=list'} className="today-sessions-more">
          {t('schedule.more', { count: sessions.length - shownCount })}
        </Link>
      )}
    </section>
  )
}
