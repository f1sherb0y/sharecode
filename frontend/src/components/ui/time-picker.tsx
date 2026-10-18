import * as React from 'react'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

interface TimePickerProps {
  id?: string
  /** HH:MM */
  value: string
  onChange: (value: string) => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, hour) => pad(hour))
const MINUTES = Array.from({ length: 12 }, (_, index) => pad(index * 5))

/** A time field: pick the hour, then the minute, from two small grids. */
export function TimePicker({ id, value, onChange }: TimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  const hour = match?.[1] ?? '09'
  const minute = match?.[2] ?? '00'
  const panel = React.useRef<HTMLDivElement>(null)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" className="ui-field cursor-pointer items-center justify-between gap-1 tabular-nums" data-value={value}>
          <span>{value}</span>
          <Clock className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={panel}
        className="ui-time-picker"
        onOpenAutoFocus={event => {
          event.preventDefault()
          panel.current?.querySelector<HTMLButtonElement>(`[data-hour="${hour}"]`)?.focus()
        }}
      >
        <div className="ui-time-hours" role="group">
          {HOURS.map(item => (
            <button
              key={item}
              type="button"
              data-hour={item}
              aria-pressed={item === hour}
              className={cn('ui-time-cell', item === hour && 'is-selected')}
              onClick={() => {
                onChange(`${item}:${minute}`)
                panel.current?.querySelector<HTMLButtonElement>(`[data-minute="${minute}"]`)?.focus()
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="ui-time-minutes" role="group">
          {MINUTES.map(item => (
            <button
              key={item}
              type="button"
              data-minute={item}
              aria-pressed={item === minute}
              className={cn('ui-time-cell', item === minute && 'is-selected')}
              onClick={() => {
                onChange(`${hour}:${item}`)
                setOpen(false)
              }}
            >
              :{item}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
