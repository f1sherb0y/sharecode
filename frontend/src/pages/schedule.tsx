import { useCallback, useEffect, useMemo, useState } from 'react'
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
  Spinner,
} from '@/components/ui'
import { Navbar, NavbarBack, PageContainer } from '@/components/layout'
import { AgendaList } from '@/components/schedule/agenda-list'
import { AppointmentDialog, type SessionDraft } from '@/components/schedule/appointment-dialog'
import { CustomersPanel } from '@/components/schedule/customers-panel'
import { MonthGrid } from '@/components/schedule/month-grid'
import { SessionRoomActions } from '@/components/schedule/session-room-actions'
import { TimeGrid, type GridColumn } from '@/components/schedule/time-grid'
import { UnassignedPanel } from '@/components/schedule/unassigned-panel'
import { useScheduleDrag, type GridDrop } from '@/components/schedule/use-schedule-drag'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { isStaff } from '@/lib/room-permissions'
import {
  SCHEDULE_VIEWS,
  UNASSIGNED_COLOR,
  formatDayKey,
  sessionsOnDay,
  stepAnchor,
  techColors,
  viewRange,
  type ScheduleView,
} from '@/lib/schedule'
import { addDays, dateKeyOf, dayStart, minuteOfDay, parseDateKey, timeInputValue, todayKey, toZonedIso } from '@/lib/zoned-time'
import { cn } from '@/lib/utils'
import { useAuthStore, useSettingsStore } from '@/stores'
import type { Appointment, AppointmentInput, Customer, ScheduleConflict, User } from '@/types'
import '@/styles/schedule.css'

type Tab = 'calendar' | 'customers'

function useNow(interval = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

/** 排班: agents and admins plan every tech's sessions; techs see their own. */
export function SchedulePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore(state => state.user)
  const timezone = useSettingsStore(state => state.timezone)
  const staff = isStaff(user)
  const narrow = useCompactViewport('(max-width: 767px)')
  const [searchParams, setSearchParams] = useSearchParams()
  const now = useNow()
  const today = todayKey(timezone)
  const locale = getLocale()

  const viewParam = searchParams.get('view') as ScheduleView | null
  const view: ScheduleView = viewParam && SCHEDULE_VIEWS.includes(viewParam) ? viewParam : narrow ? 'list' : 'week'
  const dateParam = searchParams.get('date')
  const anchor = dateParam && parseDateKey(dateParam) ? dateParam : today
  const tab: Tab = staff && searchParams.get('tab') === 'customers' ? 'customers' : 'calendar'
  const sessionId = searchParams.get('session')

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
  const [showCancelled, setShowCancelled] = useState(false)
  const [draft, setDraft] = useState<SessionDraft | null>(null)
  const [pending, setPending] = useState<Appointment | null>(null)
  const [moveConflict, setMoveConflict] = useState<{ appointment: Appointment; input: AppointmentInput; conflicts: ScheduleConflict[] } | null>(null)

  const range = useMemo(() => viewRange(view, anchor), [view, anchor])
  const rangeParams = useMemo(() => ({
    from: dayStart(range.from, timezone).toISOString(),
    to: dayStart(range.to, timezone).toISOString(),
  }), [range.from, range.to, timezone])
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
  }), [today, timezone])
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
    if (!linkedQuery.data || appointments.some(a => a.id === linkedQuery.data.id)) return
    setParams({ date: dateKeyOf(Date.parse(linkedQuery.data.startsAt), timezone) })
  }, [linkedQuery.data]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const colorOf = useCallback(
    (appointment: Appointment) => (appointment.tech ? colors.get(appointment.tech.id) ?? appointment.tech.color : UNASSIGNED_COLOR),
    [colors],
  )

  const visible = useMemo(() => appointments
    .map(appointment => (pending?.id === appointment.id ? pending : appointment))
    .filter(appointment => (showCancelled || appointment.status !== 'cancelled') && !hidden.has(appointment.tech?.id ?? '')),
  [appointments, pending, showCancelled, hidden])

  const techs = useMemo(() => users.filter(account => account.role === 'tech').sort((a, b) => a.username.localeCompare(b.username)), [users])
  const legend = useMemo(() => {
    // Staff accounts that took a session in view join the techs.
    const extra = new Map<string, Pick<User, 'id' | 'username'>>()
    for (const appointment of appointments) {
      if (appointment.tech && !techs.some(tech => tech.id === appointment.tech!.id)) extra.set(appointment.tech.id, appointment.tech)
    }
    return [...techs, ...[...extra.values()].sort((a, b) => a.username.localeCompare(b.username))]
  }, [techs, appointments])

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

  const drag = useScheduleDrag({ timezone, onDrop: handleDrop })

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
    const base = anchor === today ? Math.ceil((minuteOfDay(now, timezone) + 1) / 30) * 30 : 10 * 60
    const day = base >= 1440 ? addDays(anchor, 1) : anchor
    const startsAt = dayStart(day, timezone)
    setDraft({ startsAt: new Date(startsAt.getTime() + (base % 1440) * 60000), durationMinutes: 60, ...preset })
    setParams({ session: null })
  }

  const columns: GridColumn[] = useMemo(() => {
    if (view === 'day' && staff) {
      const people = legend.filter(person => !hidden.has(person.id)).map(person => ({
        key: person.id,
        day: anchor,
        techId: person.id,
        label: person.username,
        color: colors.get(person.id),
        isToday: anchor === today,
      }))
      return hidden.has('') ? people : [...people, { key: 'unassigned', day: anchor, techId: null, label: t('schedule.unassigned'), color: UNASSIGNED_COLOR, isToday: anchor === today }]
    }
    return range.days.map(day => ({
      key: day,
      day,
      label: formatDayKey(day, locale, { weekday: 'short' }),
      sublabel: formatDayKey(day, locale, { month: 'numeric', day: 'numeric' }),
      isToday: day === today,
    }))
  }, [view, staff, legend, hidden, anchor, colors, range.days, locale, today, t])

  const rangeLabel = (() => {
    const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    const utc = (key: string) => { const p = parseDateKey(key)!; return Date.UTC(p.year, p.month - 1, p.day) }
    if (view === 'day') return format({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(utc(anchor))
    if (view === 'month') return format({ year: 'numeric', month: 'long' }).format(utc(anchor))
    // formatRange is typed in the ES2021 lib; every supported browser has it.
    const week = format({ year: 'numeric', month: 'short', day: 'numeric' }) as Intl.DateTimeFormat & { formatRange: (start: number, end: number) => string }
    return week.formatRange(utc(range.days[0]!), utc(range.days[range.days.length - 1]!))
  })()

  const toggle = (id: string) => setHidden(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const focusMinute = openAppointment && dateKeyOf(Date.parse(openAppointment.startsAt), timezone) === anchor
    ? minuteOfDay(Date.parse(openAppointment.startsAt), timezone)
    : null
  const listEmpty = staff ? t('schedule.noSessions') : t('schedule.noSessionsTech')
  const dayCount = sessionsOnDay(visible, anchor, timezone).length

  return (
    <div className="schedule-page flex min-h-screen flex-col">
      <Navbar
        leftContent={<NavbarBack label={t('common.back')} onClick={() => navigate('/rooms')} />}
        title={null}
        centerContent={<span className="font-semibold">{t('schedule.title')}</span>}
        rightContent={staff && tab === 'calendar' ? (
          <Button onClick={() => newSession()} aria-label={t('schedule.newSession')}>
            <Plus /><span className="hidden sm:inline">{t('schedule.newSession')}</span>
          </Button>
        ) : undefined}
      />

      <PageContainer fullWidth className="schedule-container">
        {staff && (
          <div className="schedule-tabs" role="tablist" aria-label={t('schedule.tabs.label')}>
            {(['calendar', 'customers'] as Tab[]).map(value => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={cn('schedule-tab', tab === value && 'is-active')}
                onClick={() => setParams({ tab: value === 'calendar' ? null : value, session: null })}
              >
                {t(`schedule.tabs.${value}`)}
              </button>
            ))}
          </div>
        )}

        {tab === 'customers' ? (
          <CustomersPanel
            timezone={timezone}
            onOpenSession={appointment => setParams({ tab: null, view: 'day', date: dateKeyOf(Date.parse(appointment.startsAt), timezone), session: appointment.id })}
            onPlanSession={(customer: Customer) => { setParams({ tab: null }); newSession({ customer }) }}
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
              <div className="schedule-views" role="group" aria-label={t('schedule.views.label')}>
                {SCHEDULE_VIEWS.map(value => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    className={cn('schedule-view', view === value && 'is-active')}
                    onClick={() => setParams({ view: value })}
                  >
                    {t(`schedule.views.${value}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="schedule-filters">
              {staff && legend.length > 0 && (
                <div className="schedule-legend" role="group" aria-label={t('schedule.legend.label')}>
                  {legend.map(person => (
                    <button
                      key={person.id}
                      type="button"
                      aria-pressed={!hidden.has(person.id)}
                      className="schedule-legend-item"
                      onClick={() => toggle(person.id)}
                    >
                      <span className="schedule-dot" style={{ background: colors.get(person.id) }} aria-hidden="true" />
                      {person.username}
                    </button>
                  ))}
                  <button type="button" aria-pressed={!hidden.has('')} className="schedule-legend-item" onClick={() => toggle('')}>
                    <span className="schedule-dot schedule-dot-unassigned" aria-hidden="true" />
                    {t('schedule.unassigned')}
                  </button>
                  {hidden.size > 0 && (
                    <button type="button" className="schedule-legend-reset" onClick={() => setHidden(new Set())}>{t('schedule.legend.showAll')}</button>
                  )}
                </div>
              )}
              {!staff && <p className="text-xs text-muted-foreground">{t('schedule.techHint')}</p>}
              <label className="ui-check-row ml-auto flex cursor-pointer items-center gap-1.5 text-sm">
                <Checkbox checked={showCancelled} onCheckedChange={value => setShowCancelled(value === true)} aria-label={t('schedule.legend.showCancelled')} />
                <span aria-hidden="true">{t('schedule.legend.showCancelled')}</span>
              </label>
            </div>

            {appointmentsQuery.error && (
              <p role="alert" className="mb-1 text-sm text-destructive">{t('schedule.loadFailed')} {translateError(appointmentsQuery.error.message)}</p>
            )}

            <div className={cn('schedule-body', staff && view !== 'month' && 'has-side')}>
              <div className="schedule-main">
                {(view === 'week' || view === 'day') && (
                  <>
                    {view === 'day' && !staff && dayCount === 0 && <p className="schedule-empty">{t('schedule.noSessionsDay')}</p>}
                    <TimeGrid
                      columns={columns}
                      appointments={visible}
                      timezone={timezone}
                      now={now}
                      editable={staff}
                      showTech={staff && view === 'week'}
                      colorOf={colorOf}
                      onOpen={openSession}
                      onDrop={handleDrop}
                      drag={drag}
                      focusMinute={focusMinute}
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
                    onOpen={openSession}
                    actions={appointment => <SessionRoomActions appointment={appointment} compact />}
                    empty={listEmpty}
                  />
                )}
              </div>
              {staff && view !== 'month' && (
                <UnassignedPanel
                  appointments={(unassignedQuery.data ?? []).filter(a => a.status !== 'cancelled' && Date.parse(a.endsAt) > now)}
                  isLoading={unassignedQuery.isLoading}
                  timezone={timezone}
                  canDropOnTech={view === 'day'}
                  onOpen={openSession}
                  drag={drag}
                />
              )}
            </div>
          </>
        )}
      </PageContainer>

      <AppointmentDialog
        open={!!draft || !!openAppointment}
        onOpenChange={open => !open && closeDialog()}
        appointment={draft ? null : openAppointment}
        draft={draft}
        staff={staff}
        viewer={user}
        users={users}
        colors={colors}
        timezone={timezone}
        onSaved={async (saved) => {
          await refresh()
          setDraft(null)
          setParams({ session: null, date: dateKeyOf(Date.parse(saved.startsAt), timezone) })
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
