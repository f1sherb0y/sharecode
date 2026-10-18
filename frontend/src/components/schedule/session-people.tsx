import { BriefcaseBusiness, Laptop } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { Appointment } from '@/types'

/** The tech and the customer's agent on one line, each marked by an icon instead of a label (compact: "tech · agent"). */
export function SessionPeople({ appointment, showTech, compact, className }: { appointment: Appointment; showTech: boolean; compact?: boolean; className?: string }) {
  const { t } = useTranslation()
  if (compact) {
    return (
      <span className={className}>
        {[showTech ? appointment.tech?.username ?? t('schedule.unassigned') : null, appointment.customer.owner.username].filter(Boolean).join(' · ')}
      </span>
    )
  }
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
