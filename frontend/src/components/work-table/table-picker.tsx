import { useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { WorkTable } from '@/types'

/** Tables a page of the picker holds: short enough for a phone. */
const PAGE_SIZE = 8

interface TablePickerProps {
  tables: WorkTable[]
  /** The chosen table's id, or `unassigned`. */
  value: string | null
  label: string
  unassigned: { id: string; count: number }
  onPick: (id: string) => void
  onNew: () => void
  /** Phones skip focusing the search, which would raise the keyboard over the list. */
  phone: boolean
}

/** The table switcher: new table first, then a search over the tables, a page at a time. */
export function TablePicker({ tables, value, label, unassigned, onPick, onNew, phone }: TablePickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const found = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return term ? tables.filter(table => [table.name, table.username].some(name => name.toLocaleLowerCase().includes(term))) : tables
  }, [tables, query])
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE))
  const shown = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const unassignedShown = unassigned.count > 0 && !query.trim()

  const toggle = (next: boolean) => {
    setOpen(next)
    if (!next) return
    // Open on the page holding the chosen table.
    setQuery('')
    const index = tables.findIndex(table => table.id === value)
    setPage(index > 0 ? Math.floor(index / PAGE_SIZE) : 0)
  }
  const pick = (id: string) => {
    setOpen(false)
    onPick(id)
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && shown[0]) pick(shown[0].id)
  }

  const item = (id: string, name: string, count: number, dot: { color?: string; striped?: boolean }) => (
    <button key={id} type="button" className={cn('wt-table-item', id === value && 'is-active')} onClick={() => pick(id)}>
      <span className={cn('wt-dot', dot.striped && 'is-striped')} style={dot.color ? { background: dot.color } : undefined} aria-hidden="true" />
      <span className="wt-table-name">{name}</span>
      <span className="wt-table-count">{t('workTable.sessionCount', { count })}</span>
      <Check className={cn('wt-table-check', id !== value && 'invisible')} aria-hidden="true" />
    </button>
  )

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button type="button" className="wt-chip" aria-label={t('workTable.switchTable')}>
          <span className="wt-chip-name">{label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="wt-tables"
        onOpenAutoFocus={event => { if (phone) event.preventDefault() }}
      >
        <button type="button" className="wt-table-item wt-table-new" onClick={() => { setOpen(false); onNew() }}>
          <Plus className="wt-table-check" aria-hidden="true" />
          <span className="wt-table-name">{t('workTable.newTable')}</span>
        </button>
        <label className="wt-table-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            aria-label={t('workTable.searchTables')}
            placeholder={t('workTable.searchTables')}
            onChange={event => { setQuery(event.target.value); setPage(0) }}
            onKeyDown={onSearchKey}
          />
        </label>
        <div className="wt-table-list">
          {unassignedShown && item(unassigned.id, t('schedule.unassigned'), unassigned.count, { striped: true })}
          {shown.map(table => item(table.id, table.name, table.upcoming, { color: table.color }))}
          {found.length === 0 && <p className="wt-table-empty">{t('workTable.noTables')}</p>}
        </div>
        {pages > 1 && (
          <div className="wt-table-pages">
            <button type="button" aria-label={t('rooms.pagination.prev')} disabled={page === 0} onClick={() => setPage(page - 1)}>
              <ChevronLeft />
            </button>
            <span>{page + 1} / {pages}</span>
            <button type="button" aria-label={t('rooms.pagination.next')} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              <ChevronRight />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
