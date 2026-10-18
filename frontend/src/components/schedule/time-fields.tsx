import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui'
import { getLocale } from '@/i18n'
import { DURATION_PRESETS, formatDuration, zoneName } from '@/lib/schedule'
import { cn } from '@/lib/utils'

interface TimeFieldsProps {
  /** Prefix for the field ids, e.g. `session` gives `session-date` and `session-time`. */
  id: string
  date: string
  time: string
  duration: number
  onDate: (date: string) => void
  onTime: (time: string) => void
  onDuration: (minutes: number) => void
  /** With a zone list, the time is entered in the chosen zone. */
  zone?: string
  zones?: string[]
  onZone?: (zone: string) => void
  required?: boolean
}

/** Date, start time, (zone) and length: one row shared by new sessions and new rooms. */
export function TimeFields({ id, date, time, duration, onDate, onTime, onDuration, zone, zones, onZone, required }: TimeFieldsProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  const units = { hours: t('schedule.hoursUnit'), minutes: t('schedule.minutesUnit') }
  const durations = useMemo(() => [...new Set([...DURATION_PRESETS, duration])].sort((a, b) => a - b), [duration])
  const withZone = !!zone && !!zones && !!onZone

  return (
    <div className={cn('grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2', withZone ? 'sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]' : 'sm:grid-cols-3')}>
      <div className="space-y-1">
        <Label htmlFor={`${id}-date`}>{t('schedule.dialog.date')}</Label>
        <Input id={`${id}-date`} type="date" value={date} required={required} onChange={e => onDate(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-time`}>{t('schedule.dialog.start')}</Label>
        <Input id={`${id}-time`} type="time" step={300} value={time} required={required} onChange={e => onTime(e.target.value)} />
      </div>
      {withZone && (
        <div className="space-y-1">
          <Label>{t('schedule.zone')}</Label>
          <Select value={zone} onValueChange={onZone}>
            <SelectTrigger aria-label={t('schedule.zone')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {zones.map(item => <SelectItem key={item} value={item}>{zoneName(item, locale)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className={cn('space-y-1', !withZone && 'col-span-2 sm:col-span-1')}>
        <Label>{t('schedule.dialog.duration')}</Label>
        <Select value={String(duration)} onValueChange={value => onDuration(Number(value))}>
          <SelectTrigger aria-label={t('schedule.dialog.duration')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {durations.map(minutes => (
              <SelectItem key={minutes} value={String(minutes)}>{formatDuration(minutes, units)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
