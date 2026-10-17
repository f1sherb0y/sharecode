import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import { UNASSIGNED_COLOR } from '@/lib/schedule'
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
  // Finished sessions drop to the end so the next one is on top.
  const ordered = [...sessions].sort((a, b) =>
    Number(Date.parse(a.endsAt) <= now) - Number(Date.parse(b.endsAt) <= now) || Date.parse(a.startsAt) - Date.parse(b.startsAt))

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
        {ordered.slice(0, SHOWN).map(appointment => (
          <li
            key={appointment.id}
            className={cn('today-session', Date.parse(appointment.endsAt) <= now && 'is-past')}
            style={{ '--event-color': appointment.tech?.color ?? UNASSIGNED_COLOR } as CSSProperties}
          >
            <Link to={`/schedule?view=day&date=${today}&session=${appointment.id}`} className="today-session-main">
              <span className="today-session-time tabular-nums">
                {timeInputValue(Date.parse(appointment.startsAt), timezone)}–{timeInputValue(Date.parse(appointment.endsAt), timezone)}
              </span>
              <span className="truncate font-medium">{appointment.customer.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[staff ? appointment.tech?.username ?? t('schedule.unassigned') : null, appointment.company, appointment.position].filter(Boolean).join(' · ')}
              </span>
            </Link>
            {appointment.status === 'completed' ? <StatusBadge status="completed" /> : <SessionRoomActions appointment={appointment} compact />}
          </li>
        ))}
      </ul>
      {ordered.length > SHOWN && (
        <Link to={staff ? '/schedule?view=day' : '/schedule?view=list'} className="today-sessions-more">
          {t('schedule.todayCard.more', { count: ordered.length - SHOWN })}
        </Link>
      )}
    </section>
  )
}
