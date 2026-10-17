import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
  Textarea,
} from '@/components/ui'
import { api } from '@/api'
import { getLocale } from '@/i18n'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { formatDayKey } from '@/lib/schedule'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'
import type { Appointment, Customer } from '@/types'
import { StatusBadge } from './appointment-dialog'
import { useDebounced } from './customer-picker'

interface CustomersPanelProps {
  timezone: string
  onOpenSession: (appointment: Appointment) => void
  onPlanSession: (customer: Customer) => void
}

const PAGE_SIZE = 25

/** The customer list every agent and admin shares. */
export function CustomersPanel({ timezone, onOpenSession, onPlanSession }: CustomersPanelProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const search = useDebounced(query.trim())
  useEffect(() => { setPage(1) }, [search])

  const params = { q: search, page, pageSize: PAGE_SIZE }
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.customers(params),
    queryFn: ({ signal }) => api.listCustomers(params, signal),
  })
  const customers = data?.customers ?? []
  const pagination = data?.pagination
  const locale = getLocale()
  const day = (instant: string | null) =>
    instant ? formatDayKey(dateKeyOf(Date.parse(instant), timezone), locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

  return (
    <section className="schedule-customers" aria-labelledby="customers-title">
      <div className="schedule-customers-toolbar">
        <div>
          <h2 id="customers-title" className="ui-page-title text-base font-semibold">{t('schedule.customers.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('schedule.customers.description')}</p>
        </div>
        <div className="flex w-full gap-1 sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label={t('schedule.customers.search')}
              value={query}
              className="pl-7"
              placeholder={t('schedule.customers.searchPlaceholder')}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <Button onClick={() => setEditing('new')}>
            <Plus /><span className="max-sm:sr-only">{t('schedule.customers.new')}</span>
          </Button>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{translateError(error.message)}</p>}
      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : customers.length === 0 ? (
        <p className="schedule-empty">{search ? t('schedule.customers.noMatches') : t('schedule.customers.empty')}</p>
      ) : (
        <div className="schedule-table-wrap">
          <table className="schedule-table">
            <thead>
              <tr>
                <th scope="col">{t('schedule.customers.columns.name')}</th>
                <th scope="col">{t('schedule.customers.columns.contact')}</th>
                <th scope="col" className="text-right">{t('schedule.customers.columns.upcoming')}</th>
                <th scope="col">{t('schedule.customers.columns.next')}</th>
                <th scope="col">{t('schedule.customers.columns.last')}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map(customer => (
                <tr key={customer.id}>
                  <td>
                    <button type="button" className="schedule-table-link" onClick={() => setEditing(customer)}>{customer.name}</button>
                  </td>
                  <td className="text-muted-foreground">{customer.contact ?? '—'}</td>
                  <td className="text-right tabular-nums">{customer.upcomingCount}</td>
                  <td className="tabular-nums">{day(customer.nextSessionAt)}</td>
                  <td className="tabular-nums">{day(customer.lastSessionAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <nav className="mt-2 flex items-center justify-center gap-1" aria-label={t('rooms.pagination.label')}>
          <Button size="sm" variant="outline" disabled={!pagination.hasPrev} onClick={() => setPage(p => p - 1)}>{t('rooms.pagination.prev')}</Button>
          <span className="px-1 text-xs text-muted-foreground tabular-nums">{pagination.page} / {pagination.totalPages}</span>
          <Button size="sm" variant="outline" disabled={!pagination.hasNext} onClick={() => setPage(p => p + 1)}>{t('rooms.pagination.next')}</Button>
        </nav>
      )}

      <CustomerDialog
        customer={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={open => !open && setEditing(null)}
        timezone={timezone}
        onOpenSession={appointment => { setEditing(null); onOpenSession(appointment) }}
        onPlanSession={customer => { setEditing(null); onPlanSession(customer) }}
      />
    </section>
  )
}

interface CustomerDialogProps {
  customer: Customer | null
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
  onOpenSession: (appointment: Appointment) => void
  onPlanSession: (customer: Customer) => void
}

function CustomerDialog({ customer, open, onOpenChange, timezone, onOpenSession, onPlanSession }: CustomerDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(customer?.name ?? '')
    setContact(customer?.contact ?? '')
    setNotes(customer?.notes ?? '')
    setConfirmDelete(false)
  }, [open, customer])

  const detail = useQuery({
    queryKey: queryKeys.customer(customer?.id ?? ''),
    queryFn: () => api.getCustomer(customer!.id),
    enabled: open && !!customer,
  })

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['customers'] }),
    queryClient.invalidateQueries({ queryKey: ['customer'] }),
    queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  ])

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), contact: contact.trim() || null, notes: notes.trim() || null }
      return customer ? (await api.updateCustomer(customer.id, body)).customer : (await api.createCustomer(body)).customer
    },
    onSuccess: async () => {
      await refresh()
      toast.success(customer ? t('schedule.customers.saved') : t('schedule.customers.created'))
      onOpenChange(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCustomer(customer!.id),
    onSuccess: async () => {
      await refresh()
      toast.success(t('schedule.customers.deleted'))
      setConfirmDelete(false)
      onOpenChange(false)
    },
    onError: () => setConfirmDelete(false),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) saveMutation.mutate()
  }

  const locale = getLocale()
  const sessions = detail.data?.appointments ?? []
  const mutationError = saveMutation.error ?? deleteMutation.error

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submit} className="grid gap-2">
            <DialogHeader>
              <DialogTitle>{customer ? customer.name : t('schedule.customers.createTitle')}</DialogTitle>
              <DialogDescription>{t('schedule.customers.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="customer-name">{t('schedule.customers.name')}</Label>
                <Input id="customer-name" value={name} maxLength={100} required autoFocus={!customer} onChange={e => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="customer-contact">{t('schedule.customers.contact')}</Label>
                <Input id="customer-contact" value={contact} maxLength={200} placeholder={t('schedule.customers.contactPlaceholder')} onChange={e => setContact(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="customer-notes">{t('schedule.customers.notes')}</Label>
              <Textarea id="customer-notes" value={notes} rows={3} maxLength={2000} placeholder={t('schedule.customers.notesPlaceholder')} onChange={e => setNotes(e.target.value)} />
            </div>
            {mutationError && <p role="alert" className="text-sm text-destructive">{translateError(mutationError.message)}</p>}

            {customer && (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <h3 className="text-sm font-medium">{t('schedule.customers.history')}</h3>
                  <Button type="button" size="sm" variant="outline" onClick={() => onPlanSession(customer)}>
                    <CalendarClock />{t('schedule.customers.planSession')}
                  </Button>
                </div>
                {detail.isLoading ? (
                  <div className="flex justify-center py-1"><Spinner size="sm" /></div>
                ) : sessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('schedule.customers.historyEmpty')}</p>
                ) : (
                  <ul className="schedule-history" aria-label={t('schedule.customers.history')}>
                    {sessions.map(session => (
                      <li key={session.id}>
                        <button type="button" onClick={() => onOpenSession(session)}>
                          <span className="tabular-nums">
                            {formatDayKey(dateKeyOf(Date.parse(session.startsAt), timezone), locale, { year: 'numeric', month: 'short', day: 'numeric' })}
                            {' '}{timeInputValue(Date.parse(session.startsAt), timezone)}
                          </span>
                          <span className="truncate text-muted-foreground">
                            {[session.tech?.username ?? t('schedule.unassigned'), session.company, session.position].filter(Boolean).join(' · ')}
                          </span>
                          <StatusBadge status={session.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <DialogFooter className={customer ? 'sm:justify-between' : undefined}>
              {customer && (
                <Button type="button" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                  {t('schedule.customers.delete')}
                </Button>
              )}
              <div className="flex flex-col-reverse gap-1 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
                <Button type="submit" disabled={!name.trim() || saveMutation.isPending}>
                  {saveMutation.isPending ? t('schedule.customers.saving') : t('schedule.customers.save')}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('schedule.customers.deleteTitle', { name: customer?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('schedule.customers.deleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
