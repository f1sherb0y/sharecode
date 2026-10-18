import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import { UNASSIGNED_COLOR, groupSpan, overlapGroups } from '@/lib/schedule'
import { addDays, dayStart, timeInputValue, todayKey } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore, useSettingsStore } from '@/stores'
import { StatusBadge } from './appointment-dialog'
import { SessionRoomActions } from './session-room-actions'
import '@/styles/schedule.css'

const SHOWN = 5

/** Today's sessions above the room list: a tech's own, or everyone's for staff. */
export function TodaySessions() {
  const { t } = useTranslation()
  const user = useAuthStore(state => state.user)
  const timezone = useSettingsStore(state => state.timezone)
  const today = todayKey(timezone)
  const staff = isStaff(user)
  const params = useMemo(() => ({
    from: dayStart(today, timezone).toISOString(),
    to: dayStart(addDays(today, 1), timezone).toISOString(),
  }), [today, timezone])
  const { data } = useQuery({
    queryKey: queryKeys.appointments(params),
    queryFn: async ({ signal }) => (await api.listAppointments(params, signal)).appointments,
    enabled: !!user,
    refetchInterval: 60_000,
  })

  const sessions = (data ?? []).filter(appointment => appointment.status !== 'cancelled')
  if (sessions.length === 0) return null
  const now = Date.now()
  const range = (from: number, to: number) => `${timeInputValue(from, timezone)}–${timeInputValue(to, timezone)}`
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
        <Link to={staff ? '/schedule?view=day' : '/schedule'} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          {t('schedule.todayCard.open')}
        </Link>
      </div>
      <ul className="today-sessions-list">
        {shownRows.map(row => {
          const span = groupSpan(row)
          return (
            <li key={row[0]!.id} className="today-slot">
              <span className="today-session-time tabular-nums" aria-hidden="true">{range(span.from, span.to)}</span>
              <ul className="today-slot-cards">
                {row.map(appointment => {
                  const from = Date.parse(appointment.startsAt)
                  const to = Date.parse(appointment.endsAt)
                  const ownTime = from !== span.from || to !== span.to
                  return (
                    <li
                      key={appointment.id}
                      className={cn('today-session', to <= now && 'is-past')}
                      style={{ '--event-color': appointment.tech?.color ?? UNASSIGNED_COLOR } as CSSProperties}
                    >
                      <Link to={`/schedule?view=day&date=${today}&session=${appointment.id}`} className="today-session-main">
                        <span className="truncate">
                          <span className={cn('today-session-own-time tabular-nums', !ownTime && 'sr-only')}>{range(from, to)} </span>
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
          {t('schedule.todayCard.more', { count: sessions.length - shownCount })}
        </Link>
      )}
    </section>
  )
}
