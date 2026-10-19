import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/ui'
import { Navbar, NavbarBack, PageContainer } from '@/components/layout'
import { AgendaList } from '@/components/schedule/agenda-list'
import { AppointmentDialog, type SessionDraft } from '@/components/schedule/appointment-dialog'
import { MonthGrid } from '@/components/schedule/month-grid'
import { SessionRoomActions } from '@/components/schedule/session-room-actions'
import { ScheduleTour } from '@/components/schedule/schedule-tour'
import { SessionsPanel } from '@/components/schedule/sessions-panel'
import { DaysGrid, type DaysFocus, type DaysGridHandle } from '@/components/schedule/days-grid'
import { inRow } from '@/components/schedule/timeline-parts'
import { TimeGrid, type DayRow } from '@/components/schedule/time-grid'
import { UnassignedPanel } from '@/components/schedule/unassigned-panel'
import { useOnlyMine } from '@/components/schedule/use-only-mine'
import { useScheduleDrag, type GridDrop } from '@/components/schedule/use-schedule-drag'
import { useScheduleWeeks } from '@/components/schedule/use-schedule-weeks'
import { useDebounced } from '@/components/schedule/customer-picker'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { useNow } from '@/hooks/use-now'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import {
  DAY_MINUTES,
  DAY_MS,
  MINUTE_MS,
  MIN_WINDOW_MINUTES,
  SCHEDULE_VIEWS,
  UNASSIGNED_COLOR,
  clamp,
  formatDayKey,
  indexSessions,
  layoutDay,
  layoutRange,
  sessionsIn,
  sessionsOnDay,
  stepAnchor,
  techColors,
  viewRange,
  windowDay,
  windowPhase,
  windowStart,
  DEFAULT_ZONE,
  SCHEDULE_ZONES,
  zoneName,
  type DayLayout,
  type ScheduleView,
} from '@/lib/schedule'
import { addDays, dateKeyOf, dayStart, minuteOfDay, parseDateKey, startOfWeek, timeInputValue, todayKey, toZonedIso } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores'
import type { Appointment, AppointmentInput, ScheduleConflict, User } from '@/types'
import '@/styles/schedule.css'

type Tab = 'calendar' | 'sessions'
const ALL_TECHS = 'all'
const NO_SESSIONS: Appointment[] = []
const everyone = () => true
const UNASSIGNED_ROW = 'unassigned'

/** 排班: agents and admins plan every tech's sessions and keep the customer list; techs see their own sessions. */
export function SchedulePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore(state => state.user)
  const staff = isStaff(user)
  const onlyMine = useOnlyMine()
  const { mine } = onlyMine
  const narrow = useCompactViewport('(max-width: 767px)')
  const [searchParams, setSearchParams] = useSearchParams()
  const now = useNow()
  const locale = getLocale()
  const tab: Tab = staff && searchParams.get('tab') === 'sessions' ? 'sessions' : 'calendar'
  // The calendar can be viewed in a customer's zone; everything else keeps the usual one.
  const zoneParam = searchParams.get('tz')
  const calendarZone = zoneParam && SCHEDULE_ZONES.includes(zoneParam) ? zoneParam : DEFAULT_ZONE
  const timezone = tab === 'calendar' ? calendarZone : DEFAULT_ZONE
  const today = todayKey(timezone)

  const viewParam = searchParams.get('view') as ScheduleView | null
  const view: ScheduleView = viewParam && SCHEDULE_VIEWS.includes(viewParam) ? viewParam : narrow ? 'list' : 'week'
  const dateParam = searchParams.get('date')
  const anchor = dateParam && parseDateKey(dateParam) ? dateParam : today
  const sessionId = searchParams.get('session')
  // One tech's calendar: every session they have, to see when they are free.
  const techParam = searchParams.get('tech')
  const techFilter = staff && techParam ? techParam : null
  const timeline = tab === 'calendar' && (view === 'week' || view === 'day')

  const setParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<SessionDraft | null>(null)
  const [pending, setPending] = useState<Appointment | null>(null)
  const [moveConflict, setMoveConflict] = useState<{ appointment: Appointment; input: AppointmentInput; conflicts: ScheduleConflict[] } | null>(null)
  // "Add" is on: clicking or drawing on the timeline plans a session.
  const [adding, setAdding] = useState(false)

  // The day view's window of hours starts at an instant that moves through the days
  // without end: the whole day at first, zoomed in to as little as MIN_WINDOW_MINUTES.
  const [dayWindow, setDayWindow] = useState(() => ({ origin: dayStart(anchor, timezone).getTime(), span: DAY_MINUTES }))
  const { origin, span } = dayWindow
  const setOrigin = useCallback((next: number) => setDayWindow(current => (current.origin === next ? current : { ...current, origin: next })), [])
  const panDay = useCallback((minutes: number) => setDayWindow(current => ({ ...current, origin: current.origin + minutes * MINUTE_MS })), [])
  // Zooming keeps the time under the pointer where it is.
  const zoomDay = useCallback((at: number, factor: number) => setDayWindow(current => {
    const next = clamp(current.span * factor, MIN_WINDOW_MINUTES, DAY_MINUTES)
    return next === current.span ? current : { origin: current.origin + at * (current.span - next) * MINUTE_MS, span: next }
  }), [])
  // A row lays out its day and half a day either side, as far as the window can reach.
  const reach = DAY_MS / 2
  const shownDay = windowDay(origin, span, timezone)
  // The days the week shows, as it scrolls, and where it is asked to go.
  const [visibleDays, setVisibleDays] = useState<{ first: string; last: string } | null>(null)
  const onVisible = useCallback((first: string, last: string) => setVisibleDays(current => (current?.first === first && current.last === last ? current : { first, last })), [])
  const [focus, setFocus] = useState<DaysFocus>(() => ({ day: anchor, seq: 0, align: 'week' }))
  const inWeek = (day: string) => !!visibleDays && day >= visibleDays.first && day <= visibleDays.last
  // The day the calendar is on: the day view's, today or the first day the week shows, else the address's.
  const currentDay = !timeline ? anchor : view === 'day' ? shownDay : visibleDays ? (inWeek(today) ? today : visibleDays.first) : anchor
  // The date the page last wrote to the address itself.
  const written = useRef<string | null>(null)

  const range = useMemo(() => viewRange(view, anchor), [view, anchor])
  const listParams = useMemo(() => ({
    from: dayStart(range.from, timezone).toISOString(),
    to: dayStart(range.to, timezone).toISOString(),
    // A tech's calendar shows every session they have, whoever's customer it is.
    mine: mine && !techFilter,
    ...(techFilter ? { techId: techFilter } : {}),
  }), [range.from, range.to, timezone, mine, techFilter])
  const listQuery = useQuery({
    queryKey: queryKeys.appointments(listParams),
    queryFn: async ({ signal }) => (await api.listAppointments(listParams, signal)).appointments,
    enabled: !!user && !timeline,
    placeholderData: keepPreviousData,
    // Several agents plan at once; pick up their changes.
    refetchInterval: 60_000,
  })
  // Timelines load a week at a time around the days in view, a little after they stop moving.
  const loadNow = !timeline ? '' : view === 'day' ? `${addDays(shownDay, -2)}/${addDays(shownDay, 2)}` : visibleDays ? `${addDays(visibleDays.first, -7)}/${addDays(visibleDays.last, 7)}` : ''
  const loadKey = useDebounced(loadNow, 150) || loadNow
  const [loadFirst, loadLast] = loadKey ? loadKey.split('/') as [string, string] : [null, null]
  const weeks = useScheduleWeeks({
    from: loadFirst ? dayStart(loadFirst, timezone).getTime() - DAY_MS : 0,
    to: loadLast ? dayStart(addDays(loadLast, 1), timezone).getTime() + DAY_MS : 0,
    mine: mine && !techFilter,
    techId: techFilter,
    enabled: !!user && timeline && !!loadKey,
  })
  const appointments = timeline ? weeks.appointments : listQuery.data ?? NO_SESSIONS
  const fetching = timeline ? weeks.fetching : listQuery.isFetching
  const loadError = timeline ? weeks.error : listQuery.error
  const usersQuery = useQuery({
    queryKey: queryKeys.roomCreationUsers,
    queryFn: async () => (await api.getRoomOwners()).users,
    enabled: staff,
  })
  // The next 90 days from the start of the UTC day, whatever zone is shown: the strip
  // stays as it is when the zone changes.
  const utcDay = Math.floor(now / DAY_MS) * DAY_MS
  const unassignedParams = useMemo(() => ({
    from: new Date(utcDay).toISOString(),
    to: new Date(utcDay + 90 * DAY_MS).toISOString(),
    unassigned: true,
    mine,
  }), [utcDay, mine])
  const unassignedQuery = useQuery({
    queryKey: queryKeys.appointments(unassignedParams),
    queryFn: async ({ signal }) => (await api.listAppointments(unassignedParams, signal)).appointments,
    enabled: staff,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  })
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data])

  // A linked session (from a notice or the customer history) may lie outside the range;
  // one just deleted here is not fetched again while the address still names it.
  const deleted = useRef(new Set<string>())
  const linkedQuery = useQuery({
    queryKey: queryKeys.appointment(sessionId ?? ''),
    queryFn: async () => (await api.getAppointment(sessionId!)).appointment,
    enabled: !!sessionId && !deleted.current.has(sessionId) && !appointments.some(a => a.id === sessionId) && !fetching,
    retry: false,
  })
  const openAppointment = (sessionId && (appointments.find(a => a.id === sessionId) ?? linkedQuery.data)) || null
  useEffect(() => {
    if (linkedQuery.error) {
      toast.error(translateError(linkedQuery.error.message))
      setParams({ session: null })
    }
  }, [linkedQuery.error, setParams])

  // Calendar colors: the account color, unless another tech already shows it.
  const colors = useMemo(() => {
    const accounts = new Map<string, Pick<User, 'id' | 'color' | 'username'>>()
    for (const account of users) accounts.set(account.id, account)
    for (const appointment of appointments) {
      if (appointment.tech && !accounts.has(appointment.tech.id)) accounts.set(appointment.tech.id, appointment.tech)
    }
    return techColors([...accounts.values()])
  }, [users, appointments])
  // Sessions take the color of their customer's agent: one agent, one color.
  const agents = useMemo(() => {
    const owners = new Map<string, Pick<User, 'id' | 'color' | 'username'>>()
    for (const appointment of appointments) owners.set(appointment.customer.owner.id, appointment.customer.owner)
    return [...owners.values()].sort((a, b) => a.username.localeCompare(b.username))
  }, [appointments])
  const agentColors = useMemo(() => techColors(agents), [agents])
  const colorOf = useCallback(
    (appointment: Appointment) => agentColors.get(appointment.customer.owner.id) ?? appointment.customer.owner.color ?? UNASSIGNED_COLOR,
    [agentColors],
  )

  const visible = useMemo(() => appointments
    .map(appointment => (pending?.id === appointment.id ? pending : appointment))
    .filter(appointment => !hidden.has(appointment.customer.owner.id)),
  [appointments, pending, hidden])

  const techs = useMemo(() => users.filter(account => account.role === 'tech').sort((a, b) => a.username.localeCompare(b.username)), [users])
  const people = useMemo(() => {
    // Staff accounts that took a session in view join the techs.
    const extra = new Map<string, Pick<User, 'id' | 'username'>>()
    for (const appointment of appointments) {
      if (appointment.tech && !techs.some(tech => tech.id === appointment.tech!.id)) extra.set(appointment.tech.id, appointment.tech)
    }
    return [...techs, ...[...extra.values()].sort((a, b) => a.username.localeCompare(b.username))]
  }, [techs, appointments])

  // Simultaneous sessions keep the same order everywhere: each tech has the same place in every row.
  const laneRank = useCallback((appointment: Appointment) => {
    const index = appointment.tech ? people.findIndex(person => person.id === appointment.tech!.id) : -1
    return index === -1 ? people.length + (appointment.tech ? 0 : 1) : index
  }, [people])

  const moveMutation = useMutation({
    mutationFn: ({ appointment, input }: { appointment: Appointment; input: AppointmentInput }) =>
      api.updateAppointment(appointment.id, input),
    onSuccess: async ({ appointment }, { input }) => {
      await queryClient.invalidateQueries({ queryKey: ['appointments'] })
      setPending(null)
      setMoveConflict(null)
      toast.success(input.techId !== undefined
        ? (appointment.tech ? t('schedule.drag.assigned', { tech: appointment.tech.username }) : t('schedule.drag.unassigned'))
        : t('schedule.drag.moved'))
    },
    onError: (error, variables) => {
      const failure = error as Error & { status?: number; data?: { conflicts?: ScheduleConflict[] } }
      if (failure.status === 409 && failure.data?.conflicts && !variables.input.allowConflicts) {
        setMoveConflict({ ...variables, conflicts: failure.data.conflicts })
        return
      }
      setPending(null)
      setMoveConflict(null)
      toast.error(translateError(failure.message || t('schedule.drag.failed')))
    },
  })

  // Stable, so the days drawn do not redraw for every change on the page.
  const moveSession = moveMutation.mutate
  const handleDrop = useCallback((drop: GridDrop) => {
    if (!staff) return
    if (drop.kind === 'create') {
      setAdding(false)
      setDraft({ startsAt: drop.startsAt, durationMinutes: drop.durationMinutes, techId: drop.techId ?? null })
      return
    }
    const { appointment } = drop
    const techChanged = drop.techId !== undefined && drop.techId !== (appointment.tech?.id ?? null)
    const timeChanged = drop.startsAt.getTime() !== Date.parse(appointment.startsAt) || drop.durationMinutes !== appointment.durationMinutes
    if (!techChanged && !timeChanged) return
    const input: AppointmentInput = {
      startsAt: toZonedIso(drop.startsAt, timezone),
      durationMinutes: drop.durationMinutes,
      ...(techChanged ? { techId: drop.techId } : {}),
    }
    const newTech = techChanged ? users.find(account => account.id === drop.techId) : null
    setPending({
      ...appointment,
      startsAt: drop.startsAt.toISOString(),
      endsAt: new Date(drop.startsAt.getTime() + drop.durationMinutes * 60000).toISOString(),
      durationMinutes: drop.durationMinutes,
      tech: !techChanged ? appointment.tech : newTech ? { id: newTech.id, username: newTech.username, color: newTech.color, role: newTech.role, isDeleted: false } : null,
    })
    moveSession({ appointment, input })
  }, [staff, timezone, users, moveSession])

  const daysRef = useRef<DaysGridHandle>(null)
  const scrollDays = useCallback((pixels: number) => daysRef.current?.scrollBy(pixels), [])
  const panWeek = useCallback((minutes: number) => daysRef.current?.panBy(minutes), [])
  // A drag at the left or right edge moves the hours (in the week, once zoomed in); at its
  // top or bottom, the week's days.
  const drag = useScheduleDrag({ onDrop: handleDrop, onPan: view === 'day' ? panDay : panWeek, onScrollBy: view === 'week' ? scrollDays : undefined })

  // Escape leaves "Add".
  useEffect(() => {
    if (!adding) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setAdding(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [adding])

  const openSession = useCallback((appointment: Appointment) => setParams({ session: appointment.id }), [setParams])
  const closeDialog = () => {
    setDraft(null)
    setParams({ session: null })
  }
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['appointments'] }),
    queryClient.invalidateQueries({ queryKey: ['appointment'] }),
    queryClient.invalidateQueries({ queryKey: ['customers'] }),
    queryClient.invalidateQueries({ queryKey: ['customer'] }),
  ])

  const newSession = (preset?: Partial<SessionDraft>) => {
    // The next half hour on the day in view (or today), an hour long.
    const on = tab === 'calendar' ? currentDay : today
    const base = on === today ? Math.ceil((minuteOfDay(now, timezone) + 1) / 30) * 30 : 10 * 60
    const day = base >= 1440 ? addDays(on, 1) : on
    const startsAt = dayStart(day, timezone)
    // On a tech's calendar, the session is theirs.
    setDraft({ startsAt: new Date(startsAt.getTime() + (base % 1440) * 60000), durationMinutes: 60, ...(tab === 'calendar' && techFilter ? { techId: techFilter } : {}), ...preset })
    setParams({ session: null })
  }

  /** Moves the calendar onto a session; returns the date for the address in the month and the list. */
  const bringIntoView = (appointment: Appointment): Record<string, string> => {
    const start = Date.parse(appointment.startsAt)
    const end = Date.parse(appointment.endsAt)
    const day = dateKeyOf(start, timezone)
    if (!timeline) return { date: day }
    const length = span * MINUTE_MS
    const middle = (start + Math.min(end, start + length)) / 2
    if (view === 'day') {
      if (end <= origin || start >= origin + length) setOrigin(middle - length / 2)
      return {}
    }
    if (!inWeek(day)) setFocus(current => ({ day, seq: current.seq + 1, align: 'week' }))
    return {}
  }
  // A session opened from a link comes into view.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!openAppointment || tab !== 'calendar') {
      revealed.current = null
      return
    }
    if (revealed.current === openAppointment.id) return
    revealed.current = openAppointment.id
    if (!timeline && appointments.some(a => a.id === openAppointment.id)) return
    const update = bringIntoView(openAppointment)
    if (update.date) setParams(update)
  }, [openAppointment?.id, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // The day view goes to the day the address names when it changes from elsewhere (a
  // link, a day picked in the month); its own moves are written there.
  useLayoutEffect(() => {
    if (!timeline || view !== 'day' || anchor === written.current || anchor === windowDay(origin, span, timezone)) return
    setOrigin(windowStart(anchor, windowPhase(origin, span, timezone), timezone))
  }, [timeline, view, anchor]) // eslint-disable-line react-hooks/exhaustive-deps
  // The week opens on the address's week, and goes there when it changes from elsewhere.
  const weekOpen = useRef(false)
  useLayoutEffect(() => {
    if (!timeline || view !== 'week') {
      weekOpen.current = false
      return
    }
    if (weekOpen.current && (anchor === written.current || inWeek(anchor))) return
    weekOpen.current = true
    setFocus(current => ({ day: anchor, seq: current.seq + 1, align: 'week' }))
  }, [timeline, view, anchor]) // eslint-disable-line react-hooks/exhaustive-deps
  // The address keeps the day in view, for a reload or a link: in the week, once its date has scrolled away.
  const dayToWrite = !timeline ? null : view === 'day' ? shownDay : visibleDays && !inWeek(anchor) ? visibleDays.first : null
  useEffect(() => {
    if (!dayToWrite || dayToWrite === anchor) return
    const timer = setTimeout(() => {
      written.current = dayToWrite
      setParams({ date: dayToWrite })
    }, 300)
    return () => clearTimeout(timer)
  }, [dayToWrite, anchor, setParams])

  // Back to today and the whole day.
  const reset = () => {
    if (view === 'day') setDayWindow({ origin: dayStart(today, timezone).getTime(), span: DAY_MINUTES })
    else {
      daysRef.current?.resetZoom()
      setFocus(current => ({ day: today, seq: current.seq + 1, align: 'week' }))
    }
  }
  const goToday = () => {
    if (timeline && view === 'day') setOrigin(windowStart(today, windowPhase(origin, span, timezone), timezone))
    else if (timeline) setFocus(current => ({ day: today, seq: current.seq + 1, align: 'week' }))
    else setParams({ date: today })
  }
  const step = (direction: 1 | -1) => {
    if (timeline && view === 'day') setOrigin(windowStart(addDays(shownDay, direction), windowPhase(origin, span, timezone), timezone))
    else if (timeline) setFocus(current => ({ day: addDays(visibleDays?.first ?? startOfWeek(anchor), 7 * direction), seq: current.seq + 1, align: 'start' }))
    else setParams({ date: stepAnchor(view, anchor, direction) })
  }
  // The router applies address changes as transitions: changes to the page's own state
  // that go with one are made in the same transition, so they show in the same frame.
  const switchView = (value: ScheduleView, extra: Record<string, string | null> = {}) => startTransition(() => {
    setAdding(false)
    // The day view opens on today if the week shows it, else on the first day it shows,
    // at the hours it showed last.
    const date = value === 'day' && timeline && view === 'week' && visibleDays ? (inWeek(today) ? today : visibleDays.first) : currentDay
    if (value === 'day' && view !== 'day') setOrigin(windowStart(date, windowPhase(origin, span, timezone), timezone))
    setParams({ view: value, date, ...extra })
  })
  // In another zone the day view stays on the same instants (only the hours above change)
  // and the week's rows become that zone's days.
  const switchZone = (zone: string) => startTransition(() => {
    const date = timeline && view === 'day' ? windowDay(origin, span, zone) : anchor
    written.current = date
    setParams({ tz: zone === DEFAULT_ZONE ? null : zone, date })
  })

  const techName = (id: string) => users.find(account => account.id === id)?.username ?? people.find(person => person.id === id)?.username ?? ''
  // Anyone can take a session: techs, 管理 and 超级管理员, in one list by name.
  const techOptions = useMemo(() => [...users].sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' })), [users])

  // Sessions by time, so each day finds its own without going through them all.
  const index = useMemo(() => indexSessions(visible), [visible])
  // The day view: a row for each person with sessions that day (or in the hours shown) and
  // one for sessions waiting for a tech when there are any; with none, one unnamed row to
  // plan on. A tech sees a single row, and one person's calendar is theirs alone.
  const filterName = techFilter ? techName(techFilter) : ''
  const dayFrom = Math.min(dayStart(shownDay, timezone).getTime(), origin)
  const dayTo = Math.max(dayStart(addDays(shownDay, 1), timezone).getTime(), origin + span * MINUTE_MS)
  const dayKeys = useMemo(() => {
    if (!timeline || view !== 'day') return ''
    const busy = new Set(sessionsIn(index, dayFrom, dayTo).map(appointment => appointment.tech?.id ?? UNASSIGNED_ROW))
    return [...people.filter(person => busy.has(person.id)).map(person => person.id), ...(busy.has(UNASSIGNED_ROW) ? [UNASSIGNED_ROW] : [])].join(',')
  }, [timeline, view, index, dayFrom, dayTo, people])
  const dayRows = useMemo<Pick<DayRow, 'key' | 'techId' | 'label'>[]>(() => {
    if (!timeline || view !== 'day') return []
    if (!staff) return [{ key: 'self', label: '' }]
    if (techFilter) return [{ key: techFilter, techId: techFilter, label: filterName }]
    const rows = dayKeys.split(',').filter(Boolean).map(key => key === UNASSIGNED_ROW
      ? { key, techId: null, label: t('schedule.unassigned') }
      : { key, techId: key, label: people.find(person => person.id === key)?.username ?? '' })
    return rows.length ? rows : [{ key: UNASSIGNED_ROW, techId: null, label: '' }]
  }, [timeline, view, staff, techFilter, filterName, dayKeys, people, t])
  const dayLayouts = useMemo(
    () => dayRows.map(row => layoutDay(index, shownDay, timezone, reach, appointment => inRow(appointment.tech?.id ?? null, row), laneRank)),
    [dayRows, index, shownDay, timezone, reach, laneRank],
  )
  // A name opens that tech's own calendar; colors belong to agents.
  const rows: DayRow[] = dayRows.map(row => ({
    ...row,
    start: origin,
    day: shownDay,
    ...(row.techId && !techFilter ? { onPick: () => switchView('week', { tech: row.techId!, session: null }) } : {}),
  }))
  // The week: every day loaded, laid out once, from midnight to midnight.
  const weekLayouts = useMemo(() => {
    const layouts = new Map<string, DayLayout>()
    if (!timeline || view !== 'week' || !loadFirst || !loadLast) return layouts
    for (let day = loadFirst; day <= loadLast; day = addDays(day, 1)) {
      layouts.set(day, layoutRange(index, dayStart(day, timezone).getTime(), dayStart(addDays(day, 1), timezone).getTime(), everyone, laneRank))
    }
    return layouts
  }, [timeline, view, loadFirst, loadLast, index, timezone, laneRank])

  const rangeLabel = (() => {
    const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    const utc = (key: string) => { const p = parseDateKey(key)!; return Date.UTC(p.year, p.month - 1, p.day) }
    if (view === 'day') return format({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(utc(timeline ? shownDay : anchor))
    if (view === 'month') return format({ year: 'numeric', month: 'long' }).format(utc(anchor))
    const [from, to] = !timeline ? [range.from, addDays(range.to, -1)] : visibleDays ? [visibleDays.first, visibleDays.last] : [startOfWeek(anchor), addDays(startOfWeek(anchor), 6)]
    // formatRange is typed in the ES2021 lib; every supported browser has it.
    const week = format({ year: 'numeric', month: 'short', day: 'numeric' }) as Intl.DateTimeFormat & { formatRange: (start: number, end: number) => string }
    return week.formatRange(utc(from), utc(to))
  })()

  const toggle = (id: string) => setHidden(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const listEmpty = staff ? t('schedule.noSessions') : t('schedule.noSessionsTech')
  const dayCount = sessionsOnDay(visible, timeline ? shownDay : anchor, timezone).length
  // Unassigned sessions the calendar shows are not listed again above it: on the timelines,
  // what the rows in view hold, in their window or counted at its edge (one tech's
  // calendar shows none); the month and the list, whatever they hold.
  const calendarSpan = !timeline || techFilter ? null
    : view === 'day' ? [dayFrom, dayTo]
      : visibleDays ? [dayStart(visibleDays.first, timezone).getTime(), dayStart(addDays(visibleDays.last, 1), timezone).getTime()] : null
  const onCalendar = new Set((calendarSpan ? sessionsIn(index, calendarSpan[0]!, calendarSpan[1]!) : timeline ? [] : visible).map(a => a.id))
  const waiting = (unassignedQuery.data ?? []).filter(a => Date.parse(a.endsAt) > now && !onCalendar.has(a.id))
  const fit = tab === 'sessions' || view !== 'list'

  return (
    <div className={cn('schedule-page flex flex-col', fit ? 'is-fit' : 'min-h-screen')}>
      <Navbar
        fullWidth
        leftContent={<NavbarBack label={t('common.back')} onClick={() => navigate('/rooms')} />}
        title={null}
        centerContent={<span className="font-semibold">{t('schedule.title')}</span>}
      />

      <PageContainer className="schedule-container" fullWidth>
        {staff && (
          <div className="schedule-tabs">
            <div className="flex gap-1" role="tablist" aria-label={t('schedule.tabs.label')}>
              {(['calendar', 'sessions'] as Tab[]).map(value => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className={cn('schedule-tab', tab === value && 'is-active')}
                  onClick={() => {
                    setAdding(false)
                    setParams({ tab: value === 'calendar' ? null : value, session: null })
                  }}
                >
                  {t(`schedule.tabs.${value}`)}
                </button>
              ))}
            </div>
            {onlyMine.available && (
              <label className="ui-check-row ml-auto flex cursor-pointer items-center gap-1.5 text-sm" data-tour="only-mine">
                <Checkbox checked={mine} onCheckedChange={value => onlyMine.setOnlyMine(value === true)} aria-label={t('schedule.onlyMine')} />
                <span aria-hidden="true">{t('schedule.onlyMine')}</span>
              </label>
            )}
          </div>
        )}

        {tab === 'sessions' ? (
          <SessionsPanel
            timezone={timezone}
            now={now}
            colorOf={colorOf}
            laneRank={laneRank}
            customerId={searchParams.get('customer')}
            onSelectCustomer={customerId => setParams({ customer: customerId })}
            onOpenSession={openSession}
            onNewSession={customer => newSession(customer ? { customer } : undefined)}
            mine={mine}
          />
        ) : (
          <>
            <div className="schedule-toolbar">
              <div className="flex items-center gap-1">
                <Button variant="outline" onClick={goToday}>{t('schedule.today')}</Button>
                <Button variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => step(-1)}>
                  <ChevronLeft />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => step(1)}>
                  <ChevronRight />
                </Button>
                <h1 className="ui-page-title schedule-range" aria-live="polite">{rangeLabel}</h1>
                {fetching && <Spinner size="sm" />}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {staff && (
                  <Select value={techFilter ?? ALL_TECHS} onValueChange={value => setParams({ tech: value === ALL_TECHS ? null : value, session: null })}>
                    <SelectTrigger className="h-control-sm w-auto gap-1 text-sm" aria-label={t('schedule.dialog.tech')} data-tour="tech-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_TECHS}>{t('schedule.everyone')}</SelectItem>
                      {techOptions.map(person => <SelectItem key={person.id} value={person.id}>{person.username}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <Select value={calendarZone} onValueChange={switchZone}>
                  <SelectTrigger className="h-control-sm w-auto gap-1 text-sm" aria-label={t('schedule.zone')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_ZONES.map(zone => <SelectItem key={zone} value={zone}>{zoneName(zone, locale)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="schedule-views" role="group" aria-label={t('schedule.views.label')}>
                  {SCHEDULE_VIEWS.map(value => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={view === value}
                      data-tour={`view-${value}`}
                      className={cn('schedule-view', view === value && 'is-active')}
                      onClick={() => switchView(value)}
                    >
                      {t(`schedule.views.${value}`)}
                    </button>
                  ))}
                </div>
                {staff && (
                  // On the timelines it turns on drawing a session; the month and the list open the form.
                  <Button
                    size="sm"
                    className={cn(adding && timeline && 'schedule-adding')}
                    aria-pressed={timeline ? adding : undefined}
                    onClick={() => (timeline ? setAdding(value => !value) : newSession())}
                    data-tour="new-session"
                  >
                    <Plus />{t('schedule.add')}
                  </Button>
                )}
              </div>
            </div>

            {staff && agents.length > 0 && (
              <div className="schedule-filters">
                <div className="schedule-legend" role="group" aria-label={t('schedule.legend.label')}>
                  {agents.map(person => (
                    <button
                      key={person.id}
                      type="button"
                      aria-pressed={!hidden.has(person.id)}
                      className="schedule-legend-item"
                      onClick={() => toggle(person.id)}
                    >
                      <span className="schedule-dot" style={{ background: agentColors.get(person.id) }} aria-hidden="true" />
                      {person.username}
                    </button>
                  ))}
                  {hidden.size > 0 && (
                    <button type="button" className="schedule-legend-reset" onClick={() => setHidden(new Set())}>{t('schedule.legend.showAll')}</button>
                  )}
                </div>
              </div>
            )}

            {loadError && (
              <p role="alert" className="mb-1 text-sm text-destructive">{t('schedule.loadFailed')} {translateError(loadError.message)}</p>
            )}

            <div className="schedule-body">
              {staff && view !== 'month' && waiting.length > 0 && (
                <UnassignedPanel appointments={waiting} timezone={timezone} colorOf={colorOf} onOpen={openSession} drag={drag} />
              )}
              <div className="schedule-main">
                {view === 'day' && (
                  <>
                    {!staff && dayCount === 0 && <p className="schedule-empty">{t('schedule.noSessionsDay')}</p>}
                    <TimeGrid
                      rows={rows}
                      labeled={staff}
                      layouts={dayLayouts}
                      span={span}
                      timezone={timezone}
                      now={now}
                      editable={staff}
                      adding={adding}
                      showTech={false}
                      colorOf={colorOf}
                      onOpen={openSession}
                      onDrop={handleDrop}
                      onPan={panDay}
                      onZoom={zoomDay}
                      onReset={reset}
                      drag={drag}
                      label={rangeLabel}
                    />
                  </>
                )}
                {view === 'week' && (
                  <DaysGrid
                    ref={daysRef}
                    focus={focus}
                    layouts={weekLayouts}
                    techId={techFilter ?? undefined}
                    today={today}
                    timezone={timezone}
                    now={now}
                    editable={staff}
                    adding={adding}
                    showTech={staff && !techFilter}
                    colorOf={colorOf}
                    onOpen={openSession}
                    onDrop={handleDrop}
                    onReset={reset}
                    drag={drag}
                    label={rangeLabel}
                    onVisible={onVisible}
                  />
                )}
                {view === 'month' && (
                  <MonthGrid
                    days={range.days}
                    month={anchor.slice(0, 7)}
                    today={today}
                    appointments={visible}
                    timezone={timezone}
                    showTech={staff && !techFilter}
                    colorOf={colorOf}
                    onOpen={openSession}
                    onPickDay={day => setParams({ view: 'day', date: day })}
                  />
                )}
                {view === 'list' && (
                  <AgendaList
                    days={range.days}
                    today={today}
                    appointments={visible}
                    timezone={timezone}
                    showTech={staff}
                    colorOf={colorOf}
                    laneRank={laneRank}
                    onOpen={openSession}
                    actions={appointment => <SessionRoomActions appointment={appointment} compact />}
                    empty={listEmpty}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </PageContainer>

      <ScheduleTour userId={user?.role === 'agent' ? user.id : null} params={searchParams} setParams={setParams} />

      <AppointmentDialog
        open={!!draft || !!openAppointment}
        onOpenChange={open => !open && closeDialog()}
        appointment={draft ? null : openAppointment}
        draft={draft}
        staff={staff}
        users={users}
        colors={colors}
        timezone={timezone}
        onSaved={async (saved) => {
          await refresh()
          setDraft(null)
          setParams({ session: null, ...(tab === 'calendar' ? bringIntoView(saved) : {}) })
        }}
        onDeleted={async (appointmentId) => {
          deleted.current.add(appointmentId)
          closeDialog()
          queryClient.removeQueries({ queryKey: queryKeys.appointment(appointmentId) })
          await refresh()
        }}
      />

      <Dialog open={!!moveConflict} onOpenChange={open => { if (!open) { setMoveConflict(null); setPending(null) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1"><TriangleAlert className="h-5 w-5" aria-hidden="true" />{t('schedule.dialog.conflictTitle')}</DialogTitle>
            <DialogDescription>
              {t('schedule.dialog.conflictDescription', { tech: pending?.tech?.username ?? moveConflict?.appointment.tech?.username ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <ul className="text-sm">
            {moveConflict?.conflicts.map(conflict => (
              <li key={conflict.id}>
                {formatDayKey(dateKeyOf(Date.parse(conflict.startsAt), timezone), locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                {' '}{timeInputValue(Date.parse(conflict.startsAt), timezone)}–{timeInputValue(Date.parse(conflict.endsAt), timezone)} · {conflict.customer.name}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMoveConflict(null); setPending(null) }}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              disabled={moveMutation.isPending}
              onClick={() => moveConflict && moveMutation.mutate({ appointment: moveConflict.appointment, input: { ...moveConflict.input, allowConflicts: true } })}
            >
              {t('schedule.dialog.saveAnyway')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
