import type { TFunction } from 'i18next'
import type { NotificationItem } from '@/types'
import { getLocale } from '@/i18n'
import { formatDayKey } from '@/lib/schedule'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'

const KINDS = ['schedule.assigned', 'schedule.updated', 'schedule.unassigned', 'schedule.cancelled'] as const
type ScheduleKind = (typeof KINDS)[number]

interface ScheduleNoticeData {
  appointmentId: string
  customerName: string
  startsAt: string
  durationMinutes: number
  company?: string | null
  position?: string | null
  previousStartsAt?: string
}

/** A tech's personal notice about one of their sessions. */
export function isScheduleNotice(notification: NotificationItem): boolean {
  return KINDS.includes(notification.kind as ScheduleKind) && !!notification.data
}

/** Renders a schedule notice in the UI language and timezone. */
export function describeScheduleNotice(notification: NotificationItem, t: TFunction, timeZone: string) {
  const kind = (notification.kind as ScheduleKind).slice('schedule.'.length)
  const data = notification.data as unknown as ScheduleNoticeData
  const locale = getLocale()
  const when = (iso: string) => {
    const start = Date.parse(iso)
    const day = formatDayKey(dateKeyOf(start, timeZone), locale, { weekday: 'short', month: 'short', day: 'numeric' })
    return `${day} ${timeInputValue(start, timeZone)}`
  }
  const end = Date.parse(data.startsAt) + data.durationMinutes * 60000
  const details = [
    `${when(data.startsAt)}–${timeInputValue(end, timeZone)}`,
    [data.company, data.position].filter(Boolean).join(' '),
    kind === 'updated' && data.previousStartsAt && data.previousStartsAt !== data.startsAt
      ? t('schedule.notice.movedFrom', { time: when(data.previousStartsAt) })
      : '',
    t('schedule.notice.by', { username: notification.createdBy.username }),
  ].filter(Boolean)
  const date = dateKeyOf(Date.parse(data.startsAt), timeZone)
  return {
    title: t(`schedule.notice.${kind}`, { customer: data.customerName }),
    description: details.join(' · '),
    // A session taken away or cancelled is no longer the tech's to open.
    href: kind === 'unassigned' || kind === 'cancelled'
      ? `/schedule?date=${date}`
      : `/schedule?date=${date}&session=${encodeURIComponent(data.appointmentId)}`,
  }
}
