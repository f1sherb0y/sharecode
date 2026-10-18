import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { TimeGrid, type GridRow } from '@/components/schedule/time-grid'
import { UnassignedPanel } from '@/components/schedule/unassigned-panel'
import { useOnlyMine } from '@/components/schedule/use-only-mine'
import { useScheduleDrag, type GridDrop } from '@/components/schedule/use-schedule-drag'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { useNow } from '@/hooks/use-now'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import {
  MAX_WINDOW_HOURS,
  MIN_WINDOW_HOURS,
  SCHEDULE_VIEWS,
  UNASSIGNED_COLOR,
  WINDOW_START_HOUR,
  clamp,
  clampPhase,
  formatDayKey,
  sessionsOnDay,
  stepAnchor,
  techColors,
  viewRange,
  windowStart,
  DEFAULT_ZONE,
  SCHEDULE_ZONES,
  zoneName,
  type ScheduleView,
} from '@/lib/schedule'
import { addDays, dateKeyOf, dayStart, minuteOfDay, parseDateKey, timeInputValue, todayKey, toZonedIso } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores'
import type { Appointment, AppointmentInput, ScheduleConflict, User } from '@/types'
import '@/styles/schedule.css'

type Tab = 'calendar' | 'sessions'
const ALL_TECHS = 'all'

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

  // The timelines' window of hours: where it starts on each row's day (minutes from
  // midnight, negative for the evening before) and how many hours fit the screen.
  const [phase, setPhase] = useState(WINDOW_START_HOUR * 60)
  const [fitHours, setFitHours] = useState(() => clamp(Math.floor((window.innerWidth - 120) / 44), MIN_WINDOW_HOURS, MAX_WINDOW_HOURS))
  const span = fitHours * 60
  const pan = useCallback((minutes: number) => setPhase(current => clampPhase(current + minutes, span, current)), [span])

  const range = useMemo(() => viewRange(view, anchor), [view, anchor])
  const rangeParams = useMemo(() => {
    // Timelines load whole UTC days with a margin around their rows, so moving the
    // window or switching the zone needs nothing new.
    const utc = (key: string) => {
      const day = parseDateKey(key)!
      return new Date(Date.UTC(day.year, day.month - 1, day.day)).toISOString()
    }
    return {
      from: timeline ? utc(addDays(range.from, -3)) : dayStart(range.from, timezone).toISOString(),
      to: timeline ? utc(addDays(range.to, 3)) : dayStart(range.to, timezone).toISOString(),
      // A tech's calendar shows every session they have, whoever's customer it is.
      mine: mine && !techFilter,
      ...(techFilter ? { techId: techFilter } : {}),
    }
  }, [timeline, range.from, range.to, timezone, mine, techFilter])
  const appointmentsQuery = useQuery({
    queryKey: queryKeys.appointments(rangeParams),
    queryFn: async ({ signal }) => (await api.listAppointments(rangeParams, signal)).appointments,
    enabled: !!user,
    placeholderData: keepPreviousData,
    // Several agents plan at once; pick up their changes.
    refetchInterval: 60_000,
  })
  const usersQuery = useQuery({
    queryKey: queryKeys.roomCreationUsers,
    queryFn: async () => (await api.getRoomOwners()).users,
    enabled: staff,
  })
  const unassignedParams = useMemo(() => ({
    from: dayStart(today, timezone).toISOString(),
    to: dayStart(addDays(today, 90), timezone).toISOString(),
    unassigned: true,
    mine,
  }), [today, timezone, mine])
  const unassignedQuery = useQuery({
    queryKey: queryKeys.appointments(unassignedParams),
    queryFn: async ({ signal }) => (await api.listAppointments(unassignedParams, signal)).appointments,
    enabled: staff,
    refetchInterval: 60_000,
  })
  const appointments = useMemo(() => appointmentsQuery.data ?? [], [appointmentsQuery.data])
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data])

  // A linked session (from a notice or the customer history) may lie outside the range.
  const linkedQuery = useQuery({
    queryKey: queryKeys.appointment(sessionId ?? ''),
    queryFn: async () => (await api.getAppointment(sessionId!)).appointment,
    enabled: !!sessionId && !appointments.some(a => a.id === sessionId) && !appointmentsQuery.isFetching,
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
    moveMutation.mutate({ appointment, input })
  }, [staff, timezone, users, moveMutation])

  const drag = useScheduleDrag({ onDrop: handleDrop, onPan: pan })

  // Escape leaves "Add".
  useEffect(() => {
    if (!adding) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setAdding(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [adding])

  const openSession = (appointment: Appointment) => setParams({ session: appointment.id })
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
    const on = tab === 'calendar' ? anchor : today
    const base = on === today ? Math.ceil((minuteOfDay(now, timezone) + 1) / 30) * 30 : 10 * 60
    const day = base >= 1440 ? addDays(on, 1) : on
    const startsAt = dayStart(day, timezone)
    // On a tech's calendar, the session is theirs.
    setDraft({ startsAt: new Date(startsAt.getTime() + (base % 1440) * 60000), durationMinutes: 60, ...(tab === 'calendar' && techFilter ? { techId: techFilter } : {}), ...preset })
    setParams({ session: null })
  }

  // Each row's window starts at the same time of its day; a row is named after the day
  // most of its window shows.
  const starts = useMemo(() => (timeline ? range.days.map(day => windowStart(day, phase, timezone)) : []), [timeline, range.days, phase, timezone])
  const shownDays = useMemo(() => starts.map(start => dateKeyOf(start + span * 30000, timezone)), [starts, span, timezone])

  /** Moves the window onto a session's hours; returns the date that shows its day, if another. */
  const bringIntoView = (appointment: Appointment): Record<string, string> => {
    const start = Date.parse(appointment.startsAt)
    const end = Date.parse(appointment.endsAt)
    const day = dateKeyOf(start, timezone)
    if (!timeline) return { date: day }
    const from = windowStart(day, phase, timezone)
    if (end <= from || start >= from + span * 60000) {
      const middle = (start + Math.min(end, start + span * 60000)) / 2
      setPhase(clampPhase((middle - dayStart(day, timezone).getTime()) / 60000 - span / 2, span))
    }
    return range.days.includes(day) ? {} : { date: day }
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

  // The window stays on the same instants in another zone: only the hours above it change.
  const switchZone = (zone: string) => {
    if (timeline && starts[0] !== undefined) setPhase((starts[0] - dayStart(range.days[0]!, zone).getTime()) / 60000)
    setParams({ tz: zone === DEFAULT_ZONE ? null : zone, date: anchor })
  }

  const techName = (id: string) => users.find(account => account.id === id)?.username ?? people.find(person => person.id === id)?.username ?? ''
  // Every tech, and whoever is chosen even if they are not a tech.
  const techOptions = useMemo(() => {
    const extra = techFilter && !techs.some(tech => tech.id === techFilter) ? users.filter(account => account.id === techFilter) : []
    return [...techs, ...extra]
  }, [techs, techFilter, users])

  const rows: GridRow[] = (() => {
    if (!timeline) return []
    if (view === 'day') {
      const row = (key: string, techId: string | null | undefined, label: string, onPick?: () => void): GridRow =>
        ({ key, start: starts[0]!, day: shownDays[0]!, techId, label, isToday: shownDays[0] === today, onPick })
      // A tech's day is a single row; the title above names it.
      if (!staff) return [row(anchor, undefined, '')]
      if (techFilter) return [row(techFilter, techFilter, techName(techFilter))]
      // A row for every tech to plan on (a name opens their own calendar); colors belong to agents.
      return [
        ...people.map(person => row(person.id, person.id, person.username, () => setParams({ tech: person.id, view: 'week', session: null }))),
        row('unassigned', null, t('schedule.unassigned')),
      ]
    }
    return range.days.map((key, index) => ({
      key,
      start: starts[index]!,
      day: shownDays[index]!,
      // One tech's week: what is drawn or dropped on it is theirs.
      ...(techFilter ? { techId: techFilter } : {}),
      label: formatDayKey(shownDays[index]!, locale, { weekday: 'short' }),
      sublabel: formatDayKey(shownDays[index]!, locale, { month: 'numeric', day: 'numeric' }),
      isToday: shownDays[index] === today,
    }))
  })()

  const rangeLabel = (() => {
    const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    const utc = (key: string) => { const p = parseDateKey(key)!; return Date.UTC(p.year, p.month - 1, p.day) }
    const days = timeline ? shownDays : range.days
    if (view === 'day') return format({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(utc(days[0] ?? anchor))
    if (view === 'month') return format({ year: 'numeric', month: 'long' }).format(utc(anchor))
    // formatRange is typed in the ES2021 lib; every supported browser has it.
    const week = format({ year: 'numeric', month: 'short', day: 'numeric' }) as Intl.DateTimeFormat & { formatRange: (start: number, end: number) => string }
    return week.formatRange(utc(days[0]!), utc(days[days.length - 1]!))
  })()

  const toggle = (id: string) => setHidden(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const listEmpty = staff ? t('schedule.noSessions') : t('schedule.noSessionsTech')
  const dayCount = sessionsOnDay(visible, anchor, timezone).length
  // Unassigned sessions the calendar already shows are not listed again above it: the
  // rows' windows and the days around them, which a marker at the edge brings in.
  const shownFrom = starts.length ? starts[0]! + span * 30000 - 12 * 3600e3 : -Infinity
  const shownTo = starts.length ? starts[starts.length - 1]! + span * 30000 + 12 * 3600e3 : Infinity
  const onCalendar = new Set(visible.filter(a => Date.parse(a.endsAt) > shownFrom && Date.parse(a.startsAt) < shownTo).map(a => a.id))
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
                <Button variant="outline" onClick={() => setParams({ date: today })}>{t('schedule.today')}</Button>
                <Button variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => setParams({ date: stepAnchor(view, anchor, -1) })}>
                  <ChevronLeft />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => setParams({ date: stepAnchor(view, anchor, 1) })}>
                  <ChevronRight />
                </Button>
                <h1 className="ui-page-title schedule-range" aria-live="polite">{rangeLabel}</h1>
                {appointmentsQuery.isFetching && <Spinner size="sm" />}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {staff && (
                  <Select value={techFilter ?? ALL_TECHS} onValueChange={value => setParams({ tech: value === ALL_TECHS ? null : value, session: null })}>
                    <SelectTrigger className="h-control-sm w-auto gap-1 text-sm" aria-label={t('schedule.dialog.tech')} data-tour="tech-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_TECHS}>{t('schedule.allTechs')}</SelectItem>
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
                      onClick={() => {
                        setAdding(false)
                        setParams({ view: value })
                      }}
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

            {appointmentsQuery.error && (
              <p role="alert" className="mb-1 text-sm text-destructive">{t('schedule.loadFailed')} {translateError(appointmentsQuery.error.message)}</p>
            )}

            <div className="schedule-body">
              {staff && view !== 'month' && waiting.length > 0 && (
                <UnassignedPanel appointments={waiting} timezone={timezone} onOpen={openSession} drag={drag} />
              )}
              <div className="schedule-main">
                {(view === 'week' || view === 'day') && (
                  <>
                    {view === 'day' && !staff && dayCount === 0 && <p className="schedule-empty">{t('schedule.noSessionsDay')}</p>}
                    <TimeGrid
                      rows={rows}
                      span={span}
                      appointments={visible}
                      timezone={timezone}
                      now={now}
                      editable={staff}
                      adding={adding}
                      showTech={staff && view === 'week' && !techFilter}
                      colorOf={colorOf}
                      laneRank={laneRank}
                      onOpen={openSession}
                      onDrop={handleDrop}
                      onPan={pan}
                      onFit={setFitHours}
                      drag={drag}
                      label={rangeLabel}
                    />
                  </>
                )}
                {view === 'month' && (
                  <MonthGrid
                    days={range.days}
                    month={anchor.slice(0, 7)}
                    today={today}
                    appointments={visible}
                    timezone={timezone}
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
        onDeleted={async () => {
          await refresh()
          closeDialog()
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
