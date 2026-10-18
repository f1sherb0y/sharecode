import { useMemo } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

interface TimePickerProps {
  id?: string
  /** HH:MM */
  value: string
  onChange: (value: string) => void
  /** Minutes between the offered times. */
  step?: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A time field listing the day in steps, styled like every other select. */
export function TimePicker({ id, value, onChange, step = 15 }: TimePickerProps) {
  const times = useMemo(() => {
    const list = Array.from({ length: (24 * 60) / step }, (_, index) => `${pad(Math.floor((index * step) / 60))}:${pad((index * step) % 60)}`)
    // A time between the steps (e.g. saved earlier) stays selectable.
    return /^\d{2}:\d{2}$/.test(value) && !list.includes(value) ? [...list, value].sort() : list
  }, [step, value])

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="tabular-nums" data-value={value}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {times.map(time => <SelectItem key={time} value={time} className="tabular-nums">{time}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
