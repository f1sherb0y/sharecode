import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button, DatePicker, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, TimePicker } from '@/components/ui'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import { DAY_MINUTES } from '@/lib/schedule'
import { useAuthStore } from '@/stores'
import { atMinute, dateKeyOf, minuteOfDay, parseTimeInput, timeInputValue, toZonedIso, todayKey } from '@/lib/zoned-time'
import type { Appointment, AppointmentInput, ScheduleConflict, WorkTable } from '@/types'
import { Sheet } from './sheet'
import { useManagerOptions } from '@/components/schedule/manager-options'

/** A new session (or busy time) where free time was clicked, or one to edit. */
export type FormTarget =
  | { kind: 'new'; day: string; minute: number; techId: string; block: boolean }
  | { kind: 'edit'; appointment: Appointment }

interface SessionFormProps {
  target: FormTarget | null
  onClose: () => void
  staff: boolean
  tables: WorkTable[]
  timezone: string
  onSaved: (appointment: Appointment) => void
  /** Describes a conflicting session: who planned it and when. */
  describe: (conflict: ScheduleConflict) => string
  /** Where saves go; signed-in users save to their account. */
  actions?: SaveActions
}

export interface SaveActions {
  create: (input: AppointmentInput) => Promise<Appointment>
  update: (id: string, input: AppointmentInput) => Promise<Appointment>
}

const ACCOUNT_ACTIONS: SaveActions = {
  create: async input => (await api.createAppointment(input)).appointment,
  update: async (id, input) => (await api.updateAppointment(id, input)).appointment,
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

function conflictsOf(error: unknown): ScheduleConflict[] | null {
  const data = (error as { status?: number; data?: { conflicts?: ScheduleConflict[] } } | null)
  return data?.status === 409 && Array.isArray(data.data?.conflicts) ? data.data.conflicts : null
}

export function SessionForm({ target, onClose, staff, tables, timezone, onSaved, describe, actions = ACCOUNT_ACTIONS }: SessionFormProps) {
  const { t } = useTranslation()
  const editing = target?.kind === 'edit' ? target.appointment : null
  const block = target?.kind === 'edit' ? target.appointment.isBlock : !!target?.block
  const [date, setDate] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [techId, setTechId] = useState('')
  const [company, setCompany] = useState('')
  const [position, setPosition] = useState('')
  const [managerId, setManagerId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null)
  const meId = useAuthStore(state => state.user?.id ?? '')
  const { options: managers, listed } = useManagerOptions(staff && !!target && !block, editing?.manager)
  // A new session belongs to whoever books it when they are among the 管理 to choose from.
  const chosenManager = managerId || (!editing && managers.some(manager => manager.id === meId) ? meId : '')

  useEffect(() => {
    if (!target) return
    if (target.kind === 'edit') {
      const a = target.appointment
      const from = Date.parse(a.startsAt)
      setDate(dateKeyOf(from, timezone))
      setStart(timeInputValue(from, timezone))
      setEnd(timeInputValue(Date.parse(a.endsAt), timezone))
      setTechId(a.tech?.id ?? '')
      setCompany(a.company ?? '')
      setPosition(a.position ?? '')
      setManagerId(a.manager?.id ?? '')
      setNotes(a.notes ?? '')
    } else {
      setDate(target.day)
      setStart(hhmm(target.minute))
      setEnd(hhmm(target.minute + 60))
      setTechId(target.techId)
      setCompany('')
      setPosition('')
      setManagerId('')
      setNotes('')
    }
    setError('')
    setConflicts(null)
  }, [target, timezone])

  const save = useMutation({
    mutationFn: async () => {
      const from = parseTimeInput(start)
      const to = parseTimeInput(end)
      if (!date || from === null || to === null) throw new Error(t('workTable.mustEnd'))
      // An end at or before the start runs past midnight.
      const duration = to > from ? to - from : to + DAY_MINUTES - from
      if (duration < 5) throw new Error(t('workTable.mustEnd'))
      const startsAt = toZonedIso(atMinute(date, from, timezone), timezone)
      if (!block && staff && !editing && listed && !chosenManager) throw new Error(t('workTable.chooseManager'))
      const input: AppointmentInput = block
        ? { startsAt, durationMinutes: duration, notes: notes.trim() || null, ...(editing ? {} : { isBlock: true }) }
        : {
            techId: techId || null,
            startsAt,
            durationMinutes: duration,
            company: company.trim() || null,
            position: position.trim() || null,
            // The customer stays as it was; the 管理 is sent when chosen.
            ...(chosenManager && chosenManager !== editing?.manager?.id ? { managerId: chosenManager } : {}),
            notes: notes.trim() || null,
          }
      return editing ? actions.update(editing.id, input) : actions.create(input)
    },
    onSuccess: saved => {
      toast.success(editing ? t('workTable.saved') : block ? t('workTable.saved') : t('workTable.booked'))
      onSaved(saved)
    },
    onError: err => {
      const found = conflictsOf(err)
      setConflicts(found)
      setError(found ? '' : translateError(err instanceof Error ? err.message : t('common.requestFailed')))
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setConflicts(null)
    setError('')
    save.mutate()
  }

  const title = block ? (editing ? t('workTable.editBusy') : t('workTable.newBusy')) : editing ? t('workTable.edit') : t('workTable.new')
  const today = todayKey(timezone)

  return (
    <Sheet
      open={!!target}
      onOpenChange={open => !open && onClose()}
      title={title}
      start={<Button type="button" variant="ghost" size="sm" className="wt-link" onClick={onClose}>{t('common.cancel')}</Button>}
    >
      <form className="wt-form" onSubmit={submit} noValidate>
        <div className="wt-field">
          <Label htmlFor="wt-date">{t('workTable.date')}</Label>
          <DatePicker id="wt-date" value={date} onChange={setDate} today={today} />
        </div>
        <div className="wt-pair">
          <div className="wt-field">
            <Label htmlFor="wt-start">{t('workTable.start')}</Label>
            <TimePicker id="wt-start" value={start} onChange={value => {
              // Moving the start keeps the length.
              const from = parseTimeInput(start), to = parseTimeInput(end), next = parseTimeInput(value)
              if (from !== null && to !== null && next !== null) {
                const length = to > from ? to - from : to + DAY_MINUTES - from
                setEnd(hhmm((next + length) % DAY_MINUTES))
              }
              setStart(value)
            }} />
          </div>
          <div className="wt-field">
            <Label htmlFor="wt-end">{t('workTable.end')}</Label>
            <TimePicker id="wt-end" value={end} onChange={setEnd} />
          </div>
        </div>
        {!block && staff && (
          <div className="wt-field">
            <Label>{t('workTable.tech')}</Label>
            <Select value={techId} onValueChange={setTechId}>
              <SelectTrigger aria-label={t('workTable.tech')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {tables.map(table => (
                  <SelectItem key={table.id} value={table.id}>
                    <span className="flex items-center gap-1.5">
                      <span className="wt-dot" style={{ background: table.color }} aria-hidden="true" />
                      {table.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!block && (
          <div className="wt-pair">
            <div className="wt-field">
              <Label htmlFor="wt-company">{t('workTable.company')}</Label>
              <Input id="wt-company" value={company} maxLength={100} onChange={e => setCompany(e.target.value)} />
            </div>
            <div className="wt-field">
              <Label htmlFor="wt-position">{t('workTable.position')}</Label>
              <Input id="wt-position" value={position} maxLength={100} onChange={e => setPosition(e.target.value)} />
            </div>
          </div>
        )}
        {!block && staff && (
          <div className="wt-field">
            <Label>{t('workTable.manager')}</Label>
            <Select value={chosenManager} onValueChange={setManagerId}>
              <SelectTrigger aria-label={t('workTable.manager')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {managers.map(manager => (
                  <SelectItem key={manager.id} value={manager.id}>
                    <span className="flex items-center gap-1.5">
                      <span className="wt-dot" style={{ background: manager.color }} aria-hidden="true" />
                      {manager.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="wt-field">
          <Label htmlFor="wt-notes">{t('workTable.notes')}</Label>
          <Textarea id="wt-notes" value={notes} rows={2} maxLength={2000} onChange={e => setNotes(e.target.value)} />
        </div>
        {conflicts && (
          <div className="wt-conflict" role="alert">
            <strong>{t('workTable.conflictTitle')}</strong>
            <ul>{conflicts.map(conflict => <li key={conflict.id}>{describe(conflict)}</li>)}</ul>
          </div>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" size="lg" className="wt-submit" disabled={save.isPending}>
          {editing || block ? t('workTable.save') : t('workTable.book')}
        </Button>
      </form>
    </Sheet>
  )
}

/** Where a new session starts by default: the next half hour on the chosen day. */
export function nextSlot(timezone: string): number {
  return Math.min(DAY_MINUTES - 30, Math.ceil(minuteOfDay(Date.now(), timezone) / 30) * 30)
}
