import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal, Pin, Plus, Share2, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@/components/ui'
import { DayColumns } from '@/components/work-table/day-columns'
import { SessionDetails } from '@/components/work-table/session-details'
import { SessionForm, nextSlot, type FormTarget, type SaveActions } from '@/components/work-table/session-form'
import { api } from '@/api'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import { SCHEDULE_ZONES, UNASSIGNED_COLOR, formatDayKey, sessionAgent, techColors, zoneName } from '@/lib/schedule'
import { addDays, addMonths, dateKeyOf, dayStart, minuteOfDay, parseDateKey, startOfMonth, startOfWeek, timeInputValue, todayKey } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore, useSettingsStore } from '@/stores'
import type { Appointment, ScheduleConflict, User, WorkTable } from '@/types'
import '@/styles/work-table.css'

const UNASSIGNED = 'unassigned'
const LAST_TABLE = 'sharecode-work-table'
const PHONE = '(max-width: 767px)'

export function WorkTablePage() {
  return <WorkTable />
}

/** A tech's table opened through its link, without signing in; 管理 signed in get the table itself to edit. */
export function TableLinkPage() {
  const { token } = useParams()
  const user = useAuthStore(state => state.user)
  const ready = useAuthStore(state => state.isInitialized && !state.isLoading)
  const staff = ready && isStaff(user)
  const owner = useQuery({
    queryKey: ['table-link-owner', token],
    queryFn: ({ signal }) => {
      const from = Date.now()
      return api.openTableLink(token!, { from: new Date(from).toISOString(), to: new Date(from + 60_000).toISOString() }, signal)
    },
    enabled: staff && !!token,
    retry: false,
  })
  if (!ready || (staff && owner.isPending)) {
    return <div className="flex min-h-screen items-center justify-center"><Spinner size="lg" /></div>
  }
  if (staff && owner.data) return <Navigate to={`/schedule?table=${encodeURIComponent(owner.data.table.id)}`} replace />
  return <WorkTable token={token} />
}

/**
 * 排班 as work tables (工作表): one per tech, their week of sessions and busy time.
 * Staff pick a table and book free time on it; a clash is refused. A tech sees
 * their own table (signed in, or through its link), marks busy time on it, which
 * may cover sessions and then shows red on both, and pins a note above it.
 */
function WorkTable({ token }: { token?: string }) {
  const { t } = useTranslation()
  const locale = getLocale()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore(state => state.user)
  const linked = token !== undefined
  const staff = !linked && isStaff(user)
  const phone = useCompactViewport(PHONE)
  const homeZone = useSettingsStore(state => state.timezone)
  const [params, setParams] = useSearchParams()
  const timezone = SCHEDULE_ZONES.includes(params.get('tz') ?? '') ? params.get('tz')! : homeZone
  const today = todayKey(timezone)
  const date = parseDateKey(params.get('date') ?? '') ? params.get('date')! : today
  const weekStart = startOfWeek(date)
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const sessionId = params.get('session')

  const update = useCallback((changes: Record<string, string | null>, replace = true) => {
    setParams(current => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace })
  }, [setParams])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // Tables: every tech's for staff, a tech's own for them.
  const tablesQuery = useQuery({ queryKey: ['work-tables'], queryFn: () => api.listWorkTables(), staleTime: 15_000, enabled: !linked })
  const tables = useMemo(() => tablesQuery.data?.tables ?? [], [tablesQuery.data])
  const unassignedCount = tablesQuery.data?.unassigned ?? 0
  const wanted = params.get('table') ?? (staff ? localStorage.getItem(LAST_TABLE) : user?.id ?? null)
  const accountTable = !staff ? user?.id ?? null
    : wanted === UNASSIGNED || tables.some(table => table.id === wanted) ? wanted!
      : tables[0]?.id ?? null
  const pickTable = (id: string) => {
    localStorage.setItem(LAST_TABLE, id)
    update({ table: id, session: null })
  }

  const range = useMemo(() => ({
    from: dayStart(weekStart, timezone).toISOString(),
    to: dayStart(addDays(weekStart, 7), timezone).toISOString(),
  }), [weekStart, timezone])
  const sessionsQuery = useQuery<{ appointments: Appointment[]; table?: Pick<WorkTable, 'id' | 'username' | 'color' | 'note'> }>({
    queryKey: ['work-table', token ?? accountTable, range],
    queryFn: ({ signal }) => linked
      ? api.openTableLink(token!, range, signal)
      : api.listAppointments({ ...range, ...(accountTable === UNASSIGNED ? { unassigned: true } : { techId: accountTable ?? undefined }) }, signal),
    enabled: linked || !!accountTable,
    placeholderData: keepPreviousData,
    retry: linked ? false : 3,
  })
  const appointments = useMemo(() => sessionsQuery.data?.appointments ?? [], [sessionsQuery.data])
  const linkTable = sessionsQuery.data?.table ?? null
  const tableId = linked ? linkTable?.id ?? null : accountTable
  const table = linked ? linkTable : tables.find(item => item.id === tableId) ?? null
  const accountRow = linked ? null : tables.find(item => item.id === tableId) ?? null
  const own = linked || (!!user && tableId === user.id)
  // Through a link, everything goes to that table only.
  const linkActions: SaveActions | undefined = linked ? {
    create: async input => (await api.createTableLinkBusy(token!, input)).appointment,
    update: async (id, input) => (await api.updateTableLinkBusy(token!, id, input)).appointment,
  } : undefined
  const refresh = useCallback(() => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['work-table'] }),
    queryClient.invalidateQueries({ queryKey: ['work-tables'] }),
    queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  ]), [queryClient])

  // Each 管理 keeps one color; busy time is grey.
  const agentColors = useMemo(() => {
    const agents = new Map<string, Pick<User, 'id' | 'color' | 'username'>>()
    for (const appointment of appointments) if (!appointment.isBlock) agents.set(sessionAgent(appointment).id, sessionAgent(appointment))
    return techColors([...agents.values()].sort((a, b) => a.username.localeCompare(b.username)))
  }, [appointments])
  const colorOf = useCallback((appointment: Appointment) => (appointment.isBlock ? UNASSIGNED_COLOR
    : agentColors.get(sessionAgent(appointment).id) ?? sessionAgent(appointment).color), [agentColors])

  const countOn = useCallback((day: string) => {
    const from = dayStart(day, timezone).getTime(), to = dayStart(addDays(day, 1), timezone).getTime()
    return appointments.filter(a => !a.isBlock && Date.parse(a.startsAt) < to && Date.parse(a.endsAt) > from).length
  }, [appointments, timezone])

  // A linked session (from a notice or today's card) opens on its own table and day.
  const linkedQuery = useQuery({
    queryKey: queryKeys.appointment(sessionId ?? ''),
    queryFn: async () => (await api.getAppointment(sessionId!)).appointment,
    enabled: !linked && !!sessionId && !appointments.some(a => a.id === sessionId),
    retry: false,
  })
  const opened = (sessionId && (appointments.find(a => a.id === sessionId) ?? linkedQuery.data)) || null
  useEffect(() => {
    const linked = linkedQuery.data
    if (!linked || linked.id !== sessionId) return
    const day = dateKeyOf(Date.parse(linked.startsAt), timezone)
    const home = linked.tech?.id ?? UNASSIGNED
    if (day !== date || (staff && home !== tableId)) update({ date: day, ...(staff ? { table: home } : {}) })
  }, [linkedQuery.data, sessionId, timezone, date, staff, tableId, update])

  const [form, setForm] = useState<FormTarget | null>(null)
  const canAdd = staff ? !!tableId && tableId !== UNASSIGNED : own
  const addAt = (day: string, minute: number) => {
    if (!canAdd || !tableId) return
    setForm({ kind: 'new', day, minute, techId: tableId, block: !staff })
  }
  const describeConflict = (conflict: ScheduleConflict) => {
    const start = Date.parse(conflict.startsAt)
    return `${conflict.isBlock ? t('schedule.busy') : conflict.createdBy.username} · ${formatDayKey(dateKeyOf(start, timezone), locale, { weekday: 'short', month: 'numeric', day: 'numeric' })} ${timeInputValue(start, timezone)}–${timeInputValue(Date.parse(conflict.endsAt), timezone)}`
  }

  // The note pinned above the table, hidden until it changes once closed.
  const noteKey = `sharecode-work-table-note:${tableId}`
  const [hiddenNote, setHiddenNote] = useState<string | null>(null)
  useEffect(() => setHiddenNote(localStorage.getItem(noteKey)), [noteKey])
  const note = table?.note && table.note !== hiddenNote ? table.note : null
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const saveNote = useMutation({
    mutationFn: (value: string) => (linked ? api.updateTableLinkNote(token!, value.trim() || null) : api.updateWorkTableNote(value.trim() || null)),
    onSuccess: async () => {
      toast.success(t('workTable.noteSaved'))
      setEditingNote(null)
      localStorage.removeItem(noteKey)
      setHiddenNote(null)
      await refresh()
    },
    onError: err => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed'))),
  })

  const unread = useQuery({
    queryKey: queryKeys.unreadNotifications,
    queryFn: async () => (await api.getUnreadNotifications()).notifications,
    refetchInterval: 30_000,
    enabled: !linked,
  }).data?.length ?? 0

  // Staff hand out links, make tables for techs without an account and merge them later.
  const [resetting, setResetting] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [merging, setMerging] = useState<string | null>(null)
  /** Copies a table's link, even one still being made: Safari lets only the click itself start a copy. */
  const copyLink = async (link: string | Promise<string>, done = t('workTable.copied')) => {
    const url = Promise.resolve(link).then(token => `${window.location.origin}/t/${token}`)
    try {
      if (typeof link !== 'string' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': url.then(text => new Blob([text], { type: 'text/plain' })) })])
      } else {
        await navigator.clipboard.writeText(await url)
      }
      toast.success(done)
    } catch {
      // Not copied: show it to copy by hand (a failed request has said so already).
      const text = await url.catch(() => null)
      if (text) toast(text, { duration: 15_000 })
    }
  }
  const resetLink = useMutation({
    mutationFn: (id: string) => api.resetWorkTableLink(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-tables'] }),
    onError: err => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed'))),
  })
  const share = () => {
    if (accountRow) void copyLink(accountRow.link ?? resetLink.mutateAsync(accountRow.id).then(made => made.link))
  }
  const createTable = useMutation({
    mutationFn: (name: string) => api.createWorkTable(name.trim()),
    onSuccess: async ({ table: made }) => {
      setNaming(null)
      await queryClient.invalidateQueries({ queryKey: ['work-tables'] })
      pickTable(made.id)
    },
    onError: err => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed'))),
  })
  const mergeTable = useMutation({
    mutationFn: ({ from, into }: { from: string; into: string }) => api.mergeWorkTable(from, into),
    onSuccess: async (_, { into }) => {
      setMerging(null)
      toast.success(t('workTable.merged'))
      pickTable(into)
      await refresh()
    },
    onError: err => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed'))),
  })
  const accounts = tables.filter(item => !item.linkOnly && item.id !== tableId)

  // Phones show the chosen day; wider screens the whole week.
  const shown = phone ? [date] : days
  const scroller = useRef<HTMLDivElement>(null)
  const placedFor = useRef('')
  useLayoutEffect(() => {
    const body = scroller.current
    const key = `${tableId}|${shown.join(',')}`
    if (!body || sessionsQuery.isPlaceholderData || !sessionsQuery.data || placedFor.current === key) return
    placedFor.current = key
    // Open on the first session in view, or the hour before now, or the morning.
    const from = dayStart(shown[0]!, timezone).getTime(), to = dayStart(addDays(shown[shown.length - 1]!, 1), timezone).getTime()
    const starts = appointments.map(a => Date.parse(a.startsAt)).filter(start => start >= from && start < to).map(start => minuteOfDay(start, timezone))
    const minute = starts.length ? Math.min(...starts) - 30 : shown.includes(today) ? minuteOfDay(now, timezone) - 60 : 8 * 60
    const hour = body.scrollHeight / 24
    body.scrollTop = Math.max(0, (minute / 60) * hour)
  })

  // Swipes on phones: across the week strip a week, across the hours a day.
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const onSwipeStart = (event: ReactPointerEvent) => {
    swipe.current = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY }
  }
  const onSwipeEnd = (step: number) => (event: ReactPointerEvent) => {
    const start = swipe.current
    swipe.current = null
    if (!start) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) update({ date: addDays(date, dx < 0 ? step : -step) })
  }

  const [monthOpen, setMonthOpen] = useState(false)
  const [shownMonth, setShownMonth] = useState(startOfMonth(date))
  const dayCount = countOn(date)

  if (linked && sessionsQuery.isError && !sessionsQuery.data) {
    return <div className="wt-page wt-gone"><p>{t('workTable.linkGone')}</p></div>
  }

  return (
    <div className="wt-page">
      <header className="wt-head">
        <div className="wt-head-main">
          <div className="wt-title-row">
            <Popover open={monthOpen} onOpenChange={open => { setMonthOpen(open); if (open) setShownMonth(startOfMonth(date)) }}>
              <PopoverTrigger asChild>
                <button type="button" className="wt-month">
                  {formatDayKey(date, locale, { month: locale.startsWith('zh') ? 'short' : 'long' })}
                  <ChevronDown aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-2">
                <MonthCalendar
                  month={shownMonth}
                  value={date}
                  today={today}
                  onMonth={setShownMonth}
                  onPick={day => { update({ date: day }); setMonthOpen(false) }}
                />
              </PopoverContent>
            </Popover>
            {staff ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="wt-chip" aria-label={t('workTable.switchTable')}>
                    {tableId === UNASSIGNED ? t('schedule.unassigned') : table?.username ?? '…'}
                    <ChevronDown aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="wt-tables">
                  {tables.map(item => (
                    <DropdownMenuItem key={item.id} onSelect={() => pickTable(item.id)} className={cn('wt-table-item', item.id === tableId && 'is-active')}>
                      <span className="wt-dot" style={{ background: item.color }} aria-hidden="true" />
                      <span className="wt-table-name">{item.username}</span>
                      <span className="wt-table-count">{t('workTable.sessionCount', { count: item.upcoming })}</span>
                      <Check className={cn('wt-table-check', item.id !== tableId && 'invisible')} aria-hidden="true" />
                    </DropdownMenuItem>
                  ))}
                  {unassignedCount > 0 && (
                    <DropdownMenuItem onSelect={() => pickTable(UNASSIGNED)} className={cn('wt-table-item', tableId === UNASSIGNED && 'is-active')}>
                      <span className="wt-dot is-striped" aria-hidden="true" />
                      <span className="wt-table-name">{t('schedule.unassigned')}</span>
                      <span className="wt-table-count">{t('workTable.sessionCount', { count: unassignedCount })}</span>
                      <Check className={cn('wt-table-check', tableId !== UNASSIGNED && 'invisible')} aria-hidden="true" />
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setNaming('')} className="wt-table-item">
                    <Plus className="wt-table-check" aria-hidden="true" />
                    <span className="wt-table-name">{t('workTable.newTable')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="wt-chip is-static">{table?.username ?? user?.username ?? '…'}</span>
            )}
          </div>
          <Select value={timezone} onValueChange={zone => update({ tz: zone === homeZone ? null : zone })}>
            <SelectTrigger className="wt-zone" aria-label={t('schedule.zone')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {SCHEDULE_ZONES.map(zone => <SelectItem key={zone} value={zone}>{zoneName(zone, locale)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="wt-actions">
          {!phone && (
            <>
              <Button variant="ghost" size="icon" aria-label={t('workTable.previousWeek')} onClick={() => update({ date: addDays(date, -7) })}><ChevronLeft /></Button>
              <Button variant="ghost" size="icon" aria-label={t('workTable.nextWeek')} onClick={() => update({ date: addDays(date, 7) })}><ChevronRight /></Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="wt-today" onClick={() => update({ date: null })}>
            {t('workTable.today')}
          </Button>
          {staff && accountRow && (
            <Button variant="ghost" size="icon" aria-label={t('workTable.share')} disabled={resetLink.isPending} onClick={share}><Share2 /></Button>
          )}
          {!linked && (
            <Button variant="ghost" size="icon" className="relative" aria-label={t('workTable.notifications')} asChild>
              <Link to="/notifications">
                <Bell />
                {unread > 0 && <span className="wt-unread" aria-hidden="true" />}
              </Link>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('workTable.more')}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!linked && <DropdownMenuItem onSelect={() => navigate('/rooms')}>{t('workTable.rooms')}</DropdownMenuItem>}
              {own && <DropdownMenuItem onSelect={() => setEditingNote(table?.note ?? '')}>{t('workTable.note')}</DropdownMenuItem>}
              {staff && accountRow?.link && <DropdownMenuItem onSelect={() => setResetting(true)}>{t('workTable.resetLink')}</DropdownMenuItem>}
              {staff && accountRow?.linkOnly && <DropdownMenuItem onSelect={() => setMerging('')}>{t('workTable.merge')}</DropdownMenuItem>}
              {staff && <DropdownMenuItem onSelect={() => navigate('/schedule/full')}>{t('workTable.full')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className={cn('wt-week', !phone && 'is-columns')} onPointerDown={onSwipeStart} onPointerUp={onSwipeEnd(7)}>
        {!phone && <span className="wt-week-gutter" />}
        {days.map(day => {
          const busy = countOn(day) > 0
          return (
            <button
              key={day}
              type="button"
              className={cn('wt-day', day === date && 'is-selected', day === today && 'is-today')}
              aria-pressed={day === date}
              onClick={() => update({ date: day })}
            >
              <span className="wt-day-name">{day === today && phone ? t('workTable.today') : formatDayKey(day, locale, { weekday: 'short' })}</span>
              <span className="wt-day-number">{Number(day.slice(8))}</span>
              <span className={cn('wt-day-dot', !busy && 'invisible')} aria-hidden="true" />
            </button>
          )
        })}
      </div>

      {phone && (
        <div className="wt-day-summary">
          <span className={cn('wt-pill', dayCount === 0 && 'is-empty')}>
            {dayCount ? t('workTable.sessionCount', { count: dayCount }) : t('workTable.noSessions')}
          </span>
        </div>
      )}

      {note && (
        <div className="wt-note">
          <Pin aria-hidden="true" />
          <span className="wt-note-text">{note}</span>
          <button type="button" className="wt-note-close" aria-label={t('workTable.hideNote')} onClick={() => { localStorage.setItem(noteKey, note); setHiddenNote(note) }}>
            <X />
          </button>
        </div>
      )}

      <div ref={scroller} className="wt-body" onPointerDown={phone ? onSwipeStart : undefined} onPointerUp={phone ? onSwipeEnd(1) : undefined}>
        <DayColumns
          days={shown}
          today={today}
          timezone={timezone}
          now={now}
          appointments={appointments}
          colorOf={colorOf}
          onSlot={canAdd ? addAt : undefined}
          onOpen={appointment => update({ session: appointment.id }, false)}
        />
      </div>

      {canAdd && (
        <button type="button" className="wt-fab" aria-label={staff ? t('workTable.new') : t('workTable.newBusy')} onClick={() => addAt(date, nextSlot(timezone))}>
          <Plus />
        </button>
      )}

      <SessionDetails
        appointment={form ? null : opened}
        onClose={() => update({ session: null })}
        editable={!!opened && (staff || (opened.isBlock && own))}
        meId={user?.id ?? ''}
        rooms={!linked}
        remove={linked ? id => api.deleteTableLinkBusy(token!, id) : undefined}
        color={opened ? colorOf(opened) : UNASSIGNED_COLOR}
        timezone={timezone}
        onEdit={appointment => setForm({ kind: 'edit', appointment })}
        onDeleted={async () => {
          update({ session: null })
          await refresh()
        }}
        onChanged={() => void refresh()}
      />
      <SessionForm
        target={form}
        onClose={() => setForm(null)}
        staff={staff}
        tables={tables}
        timezone={timezone}
        describe={describeConflict}
        actions={linkActions}
        onSaved={async saved => {
          setForm(null)
          const day = dateKeyOf(Date.parse(saved.startsAt), timezone)
          update({ session: null, ...(day !== date ? { date: day } : {}), ...(staff && saved.tech && saved.tech.id !== tableId ? { table: saved.tech.id } : {}) })
          await refresh()
        }}
      />
      <Dialog open={editingNote !== null} onOpenChange={open => !open && setEditingNote(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('workTable.note')}</DialogTitle></DialogHeader>
          <Textarea value={editingNote ?? ''} rows={3} maxLength={200} autoFocus onChange={e => setEditingNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingNote(null)}>{t('common.cancel')}</Button>
            <Button disabled={saveNote.isPending} onClick={() => saveNote.mutate(editingNote ?? '')}>{t('workTable.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={resetting && !!accountRow} onOpenChange={setResetting}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('workTable.resetLinkTitle', { name: accountRow?.username })}</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetting(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => {
              setResetting(false)
              if (accountRow) void copyLink(resetLink.mutateAsync(accountRow.id).then(made => made.link), t('workTable.linkReset'))
            }}>{t('workTable.resetLink')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={naming !== null} onOpenChange={open => !open && setNaming(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('workTable.newTable')}</DialogTitle></DialogHeader>
          <form className="wt-field" onSubmit={event => { event.preventDefault(); if (naming?.trim()) void copyLink(createTable.mutateAsync(naming).then(made => made.table.link)) }}>
            <Label htmlFor="wt-table-name">{t('workTable.tableName')}</Label>
            <Input id="wt-table-name" value={naming ?? ''} maxLength={32} autoFocus onChange={e => setNaming(e.target.value)} />
            <DialogFooter className="mt-2">
              <Button variant="outline" type="button" onClick={() => setNaming(null)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!naming?.trim() || createTable.isPending}>{t('workTable.create')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={merging !== null} onOpenChange={open => !open && setMerging(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('workTable.merge')} · {accountRow?.username}</DialogTitle></DialogHeader>
          <div className="wt-field">
            <Label>{t('workTable.account')}</Label>
            <Select value={merging ?? ''} onValueChange={setMerging}>
              <SelectTrigger aria-label={t('workTable.account')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {accounts.map(item => <SelectItem key={item.id} value={item.id}>{item.username}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMerging(null)}>{t('common.cancel')}</Button>
            <Button disabled={!merging || mergeTable.isPending} onClick={() => tableId && merging && mergeTable.mutate({ from: tableId, into: merging })}>{t('workTable.mergeAction')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// A known Monday, for the weekday headings.
const MONDAY = '2024-01-01'

/** A month of days to jump to. */
function MonthCalendar({ month, value, today, onMonth, onPick }: { month: string; value: string; today: string; onMonth: (month: string) => void; onPick: (day: string) => void }) {
  const { t } = useTranslation()
  const locale = getLocale()
  const first = startOfWeek(month)
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index))
  const weeks = cells[35]!.slice(0, 7) === month.slice(0, 7) ? cells : cells.slice(0, 35)
  return (
    <div className="wt-calendar">
      <div className="wt-calendar-head">
        <Button variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => onMonth(addMonths(month, -1))}><ChevronLeft /></Button>
        <span>{formatDayKey(month, locale, { year: 'numeric', month: 'long' })}</span>
        <Button variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => onMonth(addMonths(month, 1))}><ChevronRight /></Button>
      </div>
      <div className="wt-calendar-grid">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} className="wt-calendar-weekday">{formatDayKey(addDays(MONDAY, index), locale, { weekday: 'narrow' })}</span>
        ))}
        {weeks.map(day => (
          <button
            key={day}
            type="button"
            className={cn('wt-calendar-day', day.slice(0, 7) !== month.slice(0, 7) && 'is-outside', day === value && 'is-selected', day === today && 'is-today')}
            onClick={() => onPick(day)}
          >
            {Number(day.slice(8))}
          </button>
        ))}
      </div>
    </div>
  )
}
