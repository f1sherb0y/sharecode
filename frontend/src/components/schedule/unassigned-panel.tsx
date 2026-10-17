import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/ui'
import { getLocale } from '@/i18n'
import { formatDayKey } from '@/lib/schedule'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'
import type { Appointment } from '@/types'
import type { DragPreview } from './use-schedule-drag'

interface UnassignedPanelProps {
  appointments: Appointment[]
  isLoading: boolean
  timezone: string
  /** Day view shows a column per tech to drop on. */
  canDropOnTech: boolean
  onOpen: (appointment: Appointment) => void
  drag: {
    preview: DragPreview | null
    begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number }) => void
    endsDrag: () => boolean
  }
}

/** Upcoming sessions without a tech, ready to be dragged onto the calendar. */
export function UnassignedPanel({ appointments, isLoading, timezone, canDropOnTech, onOpen, drag }: UnassignedPanelProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  return (
    <aside className="schedule-unassigned" aria-labelledby="unassigned-title">
      <h2 id="unassigned-title" className="schedule-side-title">
        {t('schedule.unassignedPanel.title')}
        <span className="schedule-count">{appointments.length}</span>
      </h2>
      <p className="text-xs text-muted-foreground">
        {canDropOnTech ? t('schedule.unassignedPanel.hintDay') : t('schedule.unassignedPanel.hint')}
      </p>
      {isLoading ? (
        <div className="flex justify-center py-2"><Spinner size="sm" /></div>
      ) : appointments.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">{t('schedule.unassignedPanel.empty')}</p>
      ) : (
        <ul className="schedule-unassigned-list">
          {appointments.map(appointment => (
            <li key={appointment.id}>
              <button
                type="button"
                className={drag.preview?.appointment?.id === appointment.id ? 'is-dragging' : undefined}
                onPointerDown={(event) => drag.begin(event, { kind: 'move', appointment })}
                onClick={() => { if (!drag.endsDrag()) onOpen(appointment) }}
              >
                <span className="schedule-unassigned-when tabular-nums">
                  {formatDayKey(dateKeyOf(Date.parse(appointment.startsAt), timezone), locale, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                  {' '}{timeInputValue(Date.parse(appointment.startsAt), timezone)}–{timeInputValue(Date.parse(appointment.endsAt), timezone)}
                </span>
                <span className="truncate font-medium">{appointment.customer.name}</span>
                {(appointment.company || appointment.position) && (
                  <span className="truncate text-xs text-muted-foreground">{[appointment.company, appointment.position].filter(Boolean).join(' · ')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
