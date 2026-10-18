import { BriefcaseBusiness, Laptop } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { Appointment } from '@/types'

/** The tech and the customer's agent on one line, each marked by an icon instead of a label. */
export function SessionPeople({ appointment, showTech, className }: { appointment: Appointment; showTech: boolean; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('schedule-people', className)}>
      {showTech && (
        <span title={t('schedule.dialog.tech')}>
          <Laptop aria-hidden="true" />
          <span className="truncate">{appointment.tech?.username ?? t('schedule.unassigned')}</span>
        </span>
      )}
      <span title={t('schedule.agent')}>
        <BriefcaseBusiness aria-hidden="true" />
        <span className="truncate">{appointment.customer.owner.username}</span>
      </span>
    </span>
  )
}
