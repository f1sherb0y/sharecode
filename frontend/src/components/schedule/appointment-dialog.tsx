import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { DEFAULT_DURATION, formatDayKey, scheduleZones } from '@/lib/schedule'
import { atMinute, dateKeyOf, parseTimeInput, timeInputValue, toZonedIso } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores'
import type { Appointment, AppointmentInput, AppointmentStatus, ScheduleConflict, User } from '@/types'
import { CustomerPicker, type PickedCustomer } from './customer-picker'
import { SessionRoomActions, hasRoomActions } from './session-room-actions'
import { TimeFields } from './time-fields'

/** Defaults for a new session, e.g. from a click on the calendar or the customer it is for. */
export interface SessionDraft {
  startsAt: Date
  durationMinutes: number
  techId?: string | null
  /** Chosen already, e.g. on the customer's page: the form then does not ask for one. */
  customer?: PickedCustomer | null
}

interface AppointmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  appointment: Appointment | null
  draft: SessionDraft | null
  /** Agents and admins plan sessions; techs read their own. */
  staff: boolean
  users: User[]
  colors: Map<string, string>
  /** The zone the dialog opens in: the calendar's; the form can switch it. */
  timezone: string
  onSaved: (appointment: Appointment) => void
  onDeleted: (appointmentId: string) => void
}

const NONE = 'none'

function conflictsOf(error: unknown): ScheduleConflict[] | null {
  const data = (error as { status?: number; data?: { conflicts?: ScheduleConflict[] } } | null)
  return data?.status === 409 && Array.isArray(data.data?.conflicts) ? data.data.conflicts : null
}

export function AppointmentDialog({ open, onOpenChange, appointment, draft, staff, users, colors, timezone, onSaved, onDeleted }: AppointmentDialogProps) {
  const { t } = useTranslation()
  const [customer, setCustomer] = useState<PickedCustomer | null>(null)
  const [techId, setTechId] = useState(NONE)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [zone, setZone] = useState(timezone)
  const homeZone = useSettingsStore(state => state.timezone)
  const [company, setCompany] = useState('')
  const [position, setPosition] = useState('')
  const [notes, setNotes] = useState('')
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Start from the session, or the draft, each time the dialog opens.
  const seed = appointment?.id ?? draft?.startsAt.getTime()
  useEffect(() => {
    if (!open) return
    const start = appointment ? Date.parse(appointment.startsAt) : (draft?.startsAt.getTime() ?? Date.now())
    setCustomer(appointment ? appointment.customer : (draft?.customer ?? null))
    setTechId((appointment ? appointment.tech?.id : draft?.techId) ?? NONE)
    setZone(timezone)
    setDate(dateKeyOf(start, timezone))
    setTime(timeInputValue(start, timezone))
    setDuration(appointment?.durationMinutes ?? draft?.durationMinutes ?? DEFAULT_DURATION)
    setCompany(appointment?.company ?? '')
    setPosition(appointment?.position ?? '')
    setNotes(appointment?.notes ?? '')
    setConflicts(null)
    setError('')
    setConfirmDelete(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed])

  const techs = useMemo(() => users.filter(user => user.role === 'tech'), [users])
  const staffUsers = useMemo(() => users.filter(user => user.role !== 'tech'), [users])

  const saveMutation = useMutation({
    mutationFn: async (allowConflicts: boolean) => {
      const minute = parseTimeInput(time)
      if (!customer) throw new Error(t('schedule.dialog.customerRequired'))
      if (!date || minute === null) throw new Error(t('schedule.dialog.timeRequired'))
      const input: AppointmentInput = {
        customerId: customer.id,
        techId: techId === NONE ? null : techId,
        startsAt: toZonedIso(atMinute(date, minute, zone), zone),
        durationMinutes: duration,
        company: company.trim() || null,
        position: position.trim() || null,
        notes: notes.trim() || null,
        allowConflicts,
      }
      return appointment
        ? (await api.updateAppointment(appointment.id, input)).appointment
        : (await api.createAppointment(input)).appointment
    },
    onSuccess: (saved) => {
      toast.success(appointment ? t('schedule.dialog.saved') : t('schedule.dialog.created'))
      onSaved(saved)
    },
    onError: (err) => {
      const found = conflictsOf(err)
      if (found) {
        setConflicts(found)
        setError('')
      } else {
        setError(err instanceof Error ? err.message : t('common.requestFailed'))
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAppointment(appointment!.id),
    onSuccess: () => {
      toast.success(t('schedule.dialog.deleted'))
      onDeleted(appointment!.id)
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('common.requestFailed')),
  })

  // Overlaps found for another tech or time no longer apply.
  useEffect(() => { setConflicts(null) }, [techId, date, time, duration])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setConflicts(null)
    saveMutation.mutate(false)
  }

  const locale = getLocale()
  const conflictTech = users.find(user => user.id === techId)?.username ?? appointment?.tech?.username ?? ''
  // The same moment, shown in another zone.
  const switchZone = (next: string) => {
    const minute = parseTimeInput(time)
    if (date && minute !== null) {
      const start = atMinute(date, minute, zone)
      setDate(dateKeyOf(start, next))
      setTime(timeInputValue(start, next))
    }
    setZone(next)
  }
  const range = (from: string, to: string) => `${timeInputValue(Date.parse(from), zone)}–${timeInputValue(Date.parse(to), zone)}`
  const dayLabel = (instant: string) => formatDayKey(dateKeyOf(Date.parse(instant), zone), locale, { weekday: 'short', month: 'short', day: 'numeric' })
  const techOption = (user: User) => (
    <SelectItem key={user.id} value={user.id}>
      <span className="flex items-center gap-1.5">
        <span className="schedule-dot" style={{ background: colors.get(user.id) ?? user.color }} aria-hidden="true" />
        {user.username}
      </span>
    </SelectItem>
  )
  const missingTech = appointment?.tech && !users.some(user => user.id === appointment.tech!.id) ? appointment.tech : null

  if (!staff) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          {appointment && (
            <>
              <DialogHeader>
                <DialogTitle>{appointment.customer.name}</DialogTitle>
                <DialogDescription>
                  {dayLabel(appointment.startsAt)} · {range(appointment.startsAt, appointment.endsAt)}
                </DialogDescription>
              </DialogHeader>
              {(appointment.customer.contact || appointment.company || appointment.position || appointment.notes) && (
                <dl className="schedule-details">
                  {appointment.customer.contact && <><dt>{t('schedule.dialog.contact')}</dt><dd>{appointment.customer.contact}</dd></>}
                  {(appointment.company || appointment.position) && (
                    <><dt>{t('schedule.dialog.role')}</dt><dd>{[appointment.company, appointment.position].filter(Boolean).join(' · ')}</dd></>
                  )}
                  {appointment.notes && <><dt>{t('schedule.dialog.notes')}</dt><dd className="whitespace-pre-wrap break-words">{appointment.notes}</dd></>}
                </dl>
              )}
              {hasRoomActions(appointment) && (
                <div className="schedule-room-section">
                  <h3>{t('schedule.room.title')}</h3>
                  <SessionRoomActions appointment={appointment} />
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  // Picked before the form opened, e.g. on the customer's page: the form need not ask.
  const presetCustomer = !appointment && draft?.customer ? draft.customer : null
  const title = appointment
    ? t('schedule.dialog.editTitle')
    : presetCustomer ? t('schedule.dialog.createTitleFor', { customer: presetCustomer.name }) : t('schedule.dialog.createTitle')
  const techSelect = (
    <div className="space-y-1">
      <Label>{t('schedule.dialog.tech')}</Label>
      <Select value={techId} onValueChange={setTechId}>
        <SelectTrigger aria-label={t('schedule.dialog.tech')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('schedule.unassigned')}</SelectItem>
          {missingTech && <SelectItem value={missingTech.id}>{t('schedule.dialog.deletedAccount', { username: missingTech.username })}</SelectItem>}
          {techs.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t('schedule.dialog.techsGroup')}</SelectLabel>
              {techs.map(techOption)}
            </SelectGroup>
          )}
          {staffUsers.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('schedule.dialog.staffGroup')}</SelectLabel>
                {staffUsers.map(techOption)}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <form onSubmit={submit} className="grid gap-2" noValidate>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>

            {presetCustomer ? techSelect : (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="session-customer">{t('schedule.dialog.customer')}</Label>
                  <CustomerPicker id="session-customer" value={customer} onChange={setCustomer} />
                </div>
                {techSelect}
              </div>
            )}

            <TimeFields
              id="session"
              date={date}
              time={time}
              duration={duration}
              onDate={setDate}
              onTime={setTime}
              onDuration={setDuration}
              zone={zone}
              zones={scheduleZones(homeZone)}
              onZone={switchZone}
              required
            />

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="session-company">{t('schedule.dialog.company')}</Label>
                <Input id="session-company" value={company} maxLength={100} onChange={e => setCompany(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="session-position">{t('schedule.dialog.position')}</Label>
                <Input id="session-position" value={position} maxLength={100} onChange={e => setPosition(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="session-notes">{t('schedule.dialog.notes')}</Label>
              <Textarea id="session-notes" value={notes} rows={3} maxLength={2000} onChange={e => setNotes(e.target.value)} />
            </div>

            {appointment?.customer.notes && (
              <p className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                <span className="font-medium">{t('schedule.dialog.customerNotes')}:</span> {appointment.customer.notes}
              </p>
            )}

            {conflicts && (
              <div role="alert" className="schedule-conflict">
                <p className="flex items-center gap-1 font-medium">
                  <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                  {t('schedule.dialog.conflictTitle')}
                </p>
                <p className="text-xs">{t('schedule.dialog.conflictDescription', { tech: conflictTech })}</p>
                <ul className="text-xs">
                  {conflicts.map(conflict => (
                    <li key={conflict.id}>{dayLabel(conflict.startsAt)} {range(conflict.startsAt, conflict.endsAt)} · {conflict.customer.name}</li>
                  ))}
                </ul>
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="destructive" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(true)}>
                    {t('schedule.dialog.saveAnyway')}
                  </Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{translateError(error)}</p>}

            {appointment && hasRoomActions(appointment) && (
              <div className="schedule-room-section">
                <h3>{t('schedule.room.title')}</h3>
                <SessionRoomActions appointment={appointment} />
              </div>
            )}

            <DialogFooter className={cn(appointment && 'sm:justify-between')}>
              {appointment && (
                <Button type="button" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                  {t('schedule.dialog.delete')}
                </Button>
              )}
              <div className="flex flex-col-reverse gap-1 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending
                    ? t('schedule.dialog.saving')
                    : appointment ? t('schedule.dialog.save') : t('schedule.dialog.create')}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('schedule.dialog.deleteTitle', { customer: appointment?.customer.name ?? '' })}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const { t } = useTranslation()
  return (
    <Badge variant={status === 'completed' ? 'secondary' : 'outline'}>
      {t(`schedule.status.${status}`)}
    </Badge>
  )
}
