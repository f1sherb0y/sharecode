import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { getLocale } from '@/i18n'
import { formatDayKey } from '@/lib/schedule'
import { cn } from '@/lib/utils'
import { addDays, addMonths, parseDateKey, startOfMonth, startOfWeek } from '@/lib/zoned-time'
import { Button } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

interface DatePickerProps {
  id?: string
  /** YYYY-MM-DD */
  value: string
  onChange: (value: string) => void
  /** Today's date, marked in the calendar. */
  today: string
}

// A known Monday, for the weekday headings.
const MONDAY = '2024-01-01'

/** A date field whose calendar matches the app instead of the browser's own picker. */
export function DatePicker({ id, value, onChange, today }: DatePickerProps) {
  const { t } = useTranslation()
  const locale = getLocale()
  const valid = !!parseDateKey(value)
  const [open, setOpen] = React.useState(false)
  // The day with keyboard focus; its month is the one shown.
  const [focused, setFocused] = React.useState(valid ? value : today)
  const grid = React.useRef<HTMLDivElement>(null)
  const moved = React.useRef(false)

  const openChange = (next: boolean) => {
    if (next) {
      setFocused(valid ? value : today)
      moved.current = false
    }
    setOpen(next)
  }

  const month = startOfMonth(focused)
  const first = startOfWeek(month)
  const days = Array.from({ length: 42 }, (_, index) => addDays(first, index))
  // Six rows only when the month needs them.
  const shown = days[35]!.slice(0, 7) === month.slice(0, 7) ? days : days.slice(0, 35)

  React.useEffect(() => {
    if (open && moved.current) grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus()
  }, [open, focused])

  const move = (key: string) => {
    moved.current = true
    setFocused(key)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1),
      Home: () => startOfWeek(focused),
      End: () => addDays(startOfWeek(focused), 6),
    }
    const next = step[event.key]
    if (!next) return
    event.preventDefault()
    move(next())
  }
  const pick = (key: string) => {
    onChange(key)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button id={id} type="button" className="ui-field cursor-pointer items-center justify-between gap-1 text-left" data-value={value}>
          <span className="truncate">{valid ? formatDayKey(value, locale, { ...(value.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', weekday: 'short' }) : ''}</span>
          <CalendarDays className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="ui-date-picker" onOpenAutoFocus={event => {
        event.preventDefault()
        grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus()
      }}>
        <div className="flex items-center justify-between gap-1 pb-1">
          <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => setFocused(addMonths(focused, -1))}>
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium" aria-live="polite" data-month={month.slice(0, 7)}>
            {formatDayKey(month, locale, { year: 'numeric', month: 'long' })}
          </span>
          <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => setFocused(addMonths(focused, 1))}>
            <ChevronRight />
          </Button>
        </div>
        <div className="ui-date-grid" role="grid" ref={grid} onKeyDown={onKeyDown}>
          <div className="contents" role="row">
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} role="columnheader" className="ui-date-weekday">
                {formatDayKey(addDays(MONDAY, index), locale, { weekday: 'narrow' })}
              </span>
            ))}
          </div>
          {Array.from({ length: shown.length / 7 }, (_, row) => (
            <div key={row} className="contents" role="row">
              {shown.slice(row * 7, row * 7 + 7).map(key => (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  data-date={key}
                  tabIndex={key === focused ? 0 : -1}
                  aria-selected={key === value}
                  aria-current={key === today ? 'date' : undefined}
                  aria-label={formatDayKey(key, locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
                  className={cn('ui-date-day', key.slice(0, 7) !== month.slice(0, 7) && 'is-outside', key === today && 'is-today', key === value && 'is-selected')}
                  onClick={() => pick(key)}
                >
                  {Number(key.slice(8))}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
