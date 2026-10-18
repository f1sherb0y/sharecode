import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getLocale } from '@/i18n'
import { formatDayKey } from '@/lib/schedule'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'
import type { Appointment } from '@/types'
import type { DragPreview } from './use-schedule-drag'

interface UnassignedPanelProps {
  /** Upcoming sessions without a tech that the calendar below does not show. */
  appointments: Appointment[]
  timezone: string
  colorOf: (appointment: Appointment) => string
  onOpen: (appointment: Appointment) => void
  drag: {
    preview: DragPreview | null
    begin: (event: ReactPointerEvent, init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number }) => void
    endsDrag: () => boolean
  }
}

/** Upcoming sessions without a tech, in a strip above the calendar, ready to be dragged onto it. */
export function UnassignedPanel({ appointments, timezone, colorOf, onOpen, drag }: UnassignedPanelProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  return (
    <aside className="schedule-unassigned" aria-labelledby="unassigned-title">
      <h2 id="unassigned-title" className="schedule-side-title">
        {t('schedule.unassignedPanel.title')}
        <span className="schedule-count">{appointments.length}</span>
      </h2>
      <ul className="schedule-unassigned-list">
        {appointments.map(appointment => (
          <li key={appointment.id}>
            <button
              type="button"
              className={drag.preview?.appointment?.id === appointment.id ? 'is-dragging' : undefined}
              style={{ '--event-color': colorOf(appointment) } as CSSProperties}
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
    </aside>
  )
}
