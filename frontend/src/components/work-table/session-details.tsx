import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { Clock, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui'
import { SessionRoomActions, hasRoomActions } from '@/components/schedule/session-room-actions'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { formatDayKey, sessionAgent } from '@/lib/schedule'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'
import type { Appointment } from '@/types'
import { Sheet } from './sheet'

interface SessionDetailsProps {
  appointment: Appointment | null
  onClose: () => void
  /** May change or delete it. */
  editable: boolean
  meId: string
  color: string
  timezone: string
  onEdit: (appointment: Appointment) => void
  onDeleted: (appointmentId: string) => void
  onChanged: (appointment: Appointment) => void
  /** Deletes it; signed-in users delete through their account. */
  remove?: (id: string) => Promise<unknown>
  /** Room buttons, for signed-in users. */
  rooms?: boolean
}

export function SessionDetails({ appointment, onClose, editable, meId, color, timezone, onEdit, onDeleted, onChanged, remove: removeOne = id => api.deleteAppointment(id), rooms = true }: SessionDetailsProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: (id: string) => removeOne(id),
    onSuccess: (_, id) => {
      setConfirming(false)
      toast.success(t('workTable.deleted'))
      onDeleted(id)
    },
    onError: err => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed'))),
  })

  const a = appointment
  const block = !!a?.isBlock
  const who = a ? (block ? t('schedule.busy') : sessionAgent(a).username) : ''
  const start = a ? Date.parse(a.startsAt) : 0
  const task = a ? [a.company, a.position].filter(Boolean).join(' · ') : ''

  return (
    <>
      <Sheet
        open={!!a}
        onOpenChange={open => !open && onClose()}
        title={who}
        hideTitle
        end={editable && a && (
          <>
            <Button type="button" variant="ghost" size="icon" aria-label={t('workTable.editAction')} onClick={() => onEdit(a)}><Pencil /></Button>
            <Button type="button" variant="ghost" size="icon" className="text-destructive" aria-label={t('workTable.delete')} onClick={() => setConfirming(true)}><Trash2 /></Button>
          </>
        )}
      >
        {a && (
          <div className="wt-details">
            <div className="wt-details-who">
              <span className="wt-swatch" style={{ background: color }} aria-hidden="true" />
              <span>{who}</span>
              {!block && a.createdBy.id === meId && <span className="wt-badge">{t('workTable.mine')}</span>}
              {a.hasConflict && <span className="wt-badge is-clash">{t('workTable.clash')}</span>}
            </div>
            <div className="wt-details-row">
              <Clock aria-hidden="true" />
              <div>
                <div>{formatDayKey(dateKeyOf(start, timezone), locale, { weekday: 'short', month: 'numeric', day: 'numeric' })}</div>
                <div className="wt-muted">{timeInputValue(start, timezone)} – {timeInputValue(Date.parse(a.endsAt), timezone)}</div>
              </div>
            </div>
            {(task || a.customer || a.notes) && (
              <dl className="wt-details-list">
                {task && <><dt>{t('workTable.task')}</dt><dd>{task}</dd></>}
                {a.customer && <><dt>{t('workTable.customer')}</dt><dd>{a.customer.name}{a.customer.contact && <span className="wt-muted"> · {a.customer.contact}</span>}</dd></>}
                {a.notes && <><dt>{t('workTable.notes')}</dt><dd className="whitespace-pre-wrap">{a.notes}</dd></>}
              </dl>
            )}
            {rooms && !block && hasRoomActions(a) && <SessionRoomActions appointment={a} onChanged={onChanged} />}
          </div>
        )}
      </Sheet>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{block ? t('workTable.deleteBusyTitle') : t('workTable.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => a && remove.mutate(a.id)}>{t('workTable.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
