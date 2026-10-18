import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
  Textarea,
} from '@/components/ui'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import { cn } from '@/lib/utils'
import type { LaneRank } from '@/lib/schedule'
import { addDays, dateKeyOf, dayStart, todayKey } from '@/lib/zoned-time'
import type { Appointment, Customer } from '@/types'
import { AgendaList } from './agenda-list'
import { useDebounced } from './customer-picker'
import { SessionRoomActions } from './session-room-actions'

interface SessionsPanelProps {
  timezone: string
  now: number
  colorOf: (appointment: Appointment) => string
  laneRank: LaneRank
  /** The customer shown, 'all', or null: all sessions on wide screens, the customer list on phones. */
  customerId: string | null
  onSelectCustomer: (customerId: string | null) => void
  onOpenSession: (appointment: Appointment) => void
  onNewSession: (customer: Customer | null) => void
  /** 只看我的: the agent's own customers and sessions. */
  mine: boolean
}

const PAGE_SIZE = 50
/** Upcoming sessions of everyone: this far ahead (the API's longest range). */
const AHEAD_DAYS = 100
/** Past sessions of everyone load this many days at a time. */
const BACK_DAYS = 30
const ALL = 'all'

/**
 * 场次: customers on the left, the chosen customer's sessions (or everyone's) on
 * the right, each with its own add button. Phones show one side at a time.
 */
export function SessionsPanel({ timezone, now, colorOf, laneRank, customerId, onSelectCustomer, onOpenSession, onNewSession, mine }: SessionsPanelProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Customer | null>(null)
  const search = useDebounced(query.trim())
  const selected = customerId && customerId !== ALL ? customerId : null

  const customersQuery = useInfiniteQuery({
    queryKey: ['customers', 'pages', search, mine],
    queryFn: ({ pageParam, signal }) => api.listCustomers({ q: search, page: pageParam, pageSize: PAGE_SIZE, mine }, signal),
    initialPageParam: 1,
    getNextPageParam: last => (last.pagination.hasNext ? last.pagination.page + 1 : undefined),
  })
  const customers = customersQuery.data?.pages.flatMap(page => page.customers) ?? []

  const detail = useQuery({
    queryKey: ['customer', selected ?? ''],
    queryFn: () => api.getCustomer(selected!),
    enabled: !!selected,
    retry: false,
  })
  useEffect(() => {
    // A removed customer's link shows everyone's sessions instead.
    if (detail.error) onSelectCustomer(null)
  }, [detail.error]) // eslint-disable-line react-hooks/exhaustive-deps
  const customer = detail.data?.customer ?? customers.find(c => c.id === selected) ?? null

  return (
    <section className="schedule-sessions" data-pane={customerId ? 'detail' : 'list'} aria-label={t('schedule.tabs.sessions')}>
      <div className="schedule-customer-pane">
        <div className="schedule-customer-search">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label={t('schedule.customers.search')}
              value={query}
              className="pl-7"
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <Button size="icon" variant="outline" aria-label={t('schedule.customers.new')} title={t('schedule.customers.new')} onClick={() => setEditing('new')} data-tour="customer-add">
            <Plus />
          </Button>
        </div>
        <nav className="schedule-customer-list" aria-label={t('schedule.customers.title')} data-tour="customer-list">
          <button
            type="button"
            className={cn('schedule-customer schedule-customer-all', !selected && customerId !== null && 'is-active', !customerId && 'is-default')}
            aria-current={!selected ? 'true' : undefined}
            onClick={() => onSelectCustomer(ALL)}
          >
            <span className="schedule-customer-name">{t('schedule.sessions.all')}</span>
          </button>
          {customersQuery.isLoading ? (
            <div className="flex justify-center py-3"><Spinner size="sm" /></div>
          ) : customers.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{search ? t('schedule.customers.noMatches') : t('schedule.customers.empty')}</p>
          ) : (
            <ul>
              {customers.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cn('schedule-customer', selected === item.id && 'is-active')}
                    aria-current={selected === item.id ? 'true' : undefined}
                    onClick={() => onSelectCustomer(item.id)}
                  >
                    <span className="schedule-customer-name">{item.name}</span>
                    {item.upcomingCount > 0 && (
                      <span className="schedule-count" title={t('schedule.dialog.customerUpcoming', { count: item.upcomingCount })}>
                        {item.upcomingCount}
                      </span>
                    )}
                    {item.contact && <span className="schedule-customer-contact">{item.contact}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {customersQuery.hasNextPage && (
            <Button variant="ghost" size="sm" className="w-full" disabled={customersQuery.isFetchingNextPage} onClick={() => customersQuery.fetchNextPage()}>
              {t('schedule.sessions.moreCustomers')}
            </Button>
          )}
        </nav>
      </div>

      <div className="schedule-session-pane">
        <div className="schedule-session-head">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('schedule.customers.title')} onClick={() => onSelectCustomer(null)}>
            <ChevronLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="schedule-session-title">{selected ? customer?.name ?? '' : t('schedule.sessions.allTitle')}</h2>
            {selected && customer && (customer.contact || customer.notes) && (
              <p className="schedule-session-subtitle">
                {/* The list beside it shows the contact on wide screens. */}
                {customer.contact && <span className="md:hidden">{customer.contact}{customer.notes ? ' · ' : ''}</span>}
                {customer.notes}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selected && customer && (
              <>
                <Button size="icon" variant="ghost" aria-label={t('schedule.customers.edit')} title={t('schedule.customers.edit')} onClick={() => setEditing(customer)}>
                  <Pencil />
                </Button>
                <Button size="icon" variant="ghost" className="text-destructive" aria-label={t('schedule.customers.delete')} title={t('schedule.customers.delete')} onClick={() => setDeleting(customer)}>
                  <Trash2 />
                </Button>
              </>
            )}
            <Button onClick={() => onNewSession(selected ? customer : null)} disabled={!!selected && !customer} data-tour="session-add">
              <Plus /><span className="max-sm:sr-only">{t('schedule.newSession')}</span>
            </Button>
          </div>
        </div>
        <div className="schedule-session-body">
          {selected ? (
            detail.isLoading ? <div className="flex justify-center py-4"><Spinner /></div> : (
              <SessionSections
                sessions={detail.data?.appointments ?? []}
                timezone={timezone}
                now={now}
                showCustomer={false}
                colorOf={colorOf}
                laneRank={laneRank}
                onOpen={onOpenSession}
              />
            )
          ) : (
            <AllSessions timezone={timezone} now={now} colorOf={colorOf} laneRank={laneRank} onOpen={onOpenSession} mine={mine} />
          )}
        </div>
      </div>

      <CustomerDialog
        customer={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={open => !open && setEditing(null)}
        onSaved={saved => { setEditing(null); onSelectCustomer(saved.id) }}
      />
      <DeleteCustomerDialog
        customer={deleting}
        onOpenChange={open => !open && setDeleting(null)}
        onDeleted={() => { setDeleting(null); onSelectCustomer(ALL) }}
      />
    </section>
  )
}

interface SectionsProps {
  sessions: Appointment[]
  timezone: string
  now: number
  showCustomer: boolean
  colorOf: (appointment: Appointment) => string
  laneRank: LaneRank
  onOpen: (appointment: Appointment) => void
  /** Below the past sessions, e.g. to load earlier ones. */
  pastFooter?: ReactNode
  pastEmpty?: string
}

/** Sessions to come, soonest first, then those that ended, latest first. */
function SessionSections({ sessions, timezone, now, showCustomer, colorOf, laneRank, onOpen, pastFooter, pastEmpty }: SectionsProps) {
  const { t } = useTranslation()
  const today = todayKey(timezone)
  const { upcoming, past } = useMemo(() => ({
    upcoming: sessions.filter(a => Date.parse(a.endsAt) > now),
    past: sessions.filter(a => Date.parse(a.endsAt) <= now),
  }), [sessions, now])
  const daysOf = (list: Appointment[]) => [...new Set(list.map(a => dateKeyOf(Date.parse(a.startsAt), timezone)))].sort()
  const common = { today, timezone, showTech: true, showCustomer, colorOf, laneRank, onOpen, actions: (a: Appointment) => <SessionRoomActions appointment={a} compact /> }
  return (
    <>
      <section className="schedule-session-section" aria-labelledby="sessions-upcoming">
        <h3 id="sessions-upcoming" className="schedule-session-section-title">
          {t('schedule.sessions.upcoming')}<span className="schedule-count">{upcoming.length}</span>
        </h3>
        <AgendaList {...common} days={daysOf(upcoming)} appointments={upcoming} empty={t('schedule.sessions.noUpcoming')} />
      </section>
      <section className="schedule-session-section" aria-labelledby="sessions-past">
        <h3 id="sessions-past" className="schedule-session-section-title">{t('schedule.sessions.past')}</h3>
        <AgendaList {...common} days={daysOf(past).reverse()} appointments={past} empty={pastEmpty ?? t('schedule.sessions.noPast')} />
        {pastFooter}
      </section>
    </>
  )
}

/** Everyone's sessions (or the agent's own): the next hundred days, and the past a month at a time. */
function AllSessions({ timezone, now, colorOf, laneRank, onOpen, mine }: Omit<SectionsProps, 'sessions' | 'showCustomer'> & { mine: boolean }) {
  const { t } = useTranslation()
  const today = todayKey(timezone)
  const upcoming = useQuery({
    queryKey: ['appointments', 'sessions-ahead', today, timezone, mine],
    queryFn: async ({ signal }) => (await api.listAppointments({
      from: dayStart(today, timezone).toISOString(),
      to: dayStart(addDays(today, AHEAD_DAYS), timezone).toISOString(),
      mine,
    }, signal)).appointments,
    refetchInterval: 60_000,
  })
  const past = useInfiniteQuery({
    queryKey: ['appointments', 'sessions-back', today, timezone, mine],
    queryFn: async ({ pageParam, signal }) => (await api.listAppointments({
      from: dayStart(addDays(today, -BACK_DAYS * (pageParam + 1)), timezone).toISOString(),
      to: dayStart(addDays(today, -BACK_DAYS * pageParam), timezone).toISOString(),
      mine,
    }, signal)).appointments,
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => pages.length,
  })
  const sessions = useMemo(
    () => [...(upcoming.data ?? []), ...(past.data?.pages.flat() ?? [])],
    [upcoming.data, past.data],
  )
  if (upcoming.isLoading || past.isLoading) return <div className="flex justify-center py-4"><Spinner /></div>
  const loadedDays = BACK_DAYS * (past.data?.pages.length ?? 1)
  return (
    <SessionSections
      sessions={sessions}
      timezone={timezone}
      now={now}
      showCustomer
      colorOf={colorOf}
      laneRank={laneRank}
      onOpen={onOpen}
      pastEmpty={t('schedule.sessions.noPastDays', { count: loadedDays })}
      pastFooter={(
        <Button variant="ghost" size="sm" className="mt-1" disabled={past.isFetchingNextPage} onClick={() => past.fetchNextPage()}>
          {t('schedule.sessions.earlier')}
        </Button>
      )}
    />
  )
}

interface CustomerDialogProps {
  customer: Customer | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (customer: Customer) => void
}

function CustomerDialog({ customer, open, onOpenChange, onSaved }: CustomerDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!open) return
    setName(customer?.name ?? '')
    setContact(customer?.contact ?? '')
    setNotes(customer?.notes ?? '')
  }, [open, customer])

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), contact: contact.trim() || null, notes: notes.trim() || null }
      return customer ? (await api.updateCustomer(customer.id, body)).customer : (await api.createCustomer(body)).customer
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['customer'] }),
        queryClient.invalidateQueries({ queryKey: ['appointments'] }),
      ])
      toast.success(customer ? t('schedule.customers.saved') : t('schedule.customers.created'))
      onSaved(saved)
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) saveMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <form onSubmit={submit} className="grid gap-2">
          <DialogHeader>
            <DialogTitle>{customer ? t('schedule.customers.editTitle') : t('schedule.customers.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="customer-name">{t('schedule.customers.name')}</Label>
              <Input id="customer-name" value={name} maxLength={100} required autoFocus onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="customer-contact">{t('schedule.customers.contact')}</Label>
              <Input id="customer-contact" value={contact} maxLength={200} onChange={e => setContact(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="customer-notes">{t('schedule.customers.notes')}</Label>
            <Textarea id="customer-notes" value={notes} rows={3} maxLength={2000} onChange={e => setNotes(e.target.value)} />
          </div>
          {saveMutation.error && <p role="alert" className="text-sm text-destructive">{translateError(saveMutation.error.message)}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!name.trim() || saveMutation.isPending}>
              {saveMutation.isPending ? t('schedule.customers.saving') : t('schedule.customers.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteCustomerDialog({ customer, onOpenChange, onDeleted }: { customer: Customer | null; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCustomer(customer!.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['customer'] }),
      ])
      toast.success(t('schedule.customers.deleted'))
      onDeleted()
    },
  })
  useEffect(() => { if (customer) deleteMutation.reset() }, [customer]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={!!customer} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('schedule.customers.deleteTitle', { name: customer?.name ?? '' })}</DialogTitle>
        </DialogHeader>
        {deleteMutation.error && <p role="alert" className="text-sm text-destructive">{translateError(deleteMutation.error.message)}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>{t('common.delete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
