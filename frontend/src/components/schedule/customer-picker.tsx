import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, UserRound } from 'lucide-react'
import { Button, Input, Label, Spinner } from '@/components/ui'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import type { Customer } from '@/types'

export type PickedCustomer = Pick<Customer, 'id' | 'name'> & { contact?: string | null; createdBy?: { id: string } }

interface CustomerPickerProps {
  id: string
  value: PickedCustomer | null
  onChange: (customer: PickedCustomer | null) => void
}

export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Search the shared customer list, or add a customer without leaving the session form. */
export function CustomerPicker({ id, value, onChange }: CustomerPickerProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContact, setNewContact] = useState('')
  const search = useDebounced(query.trim())

  const params = { q: search, page: 1, pageSize: 8 }
  const { data, isFetching } = useQuery({
    queryKey: queryKeys.customers(params),
    queryFn: ({ signal }) => api.listCustomers(params, signal),
    enabled: open && !value,
    staleTime: 10_000,
  })
  const customers = data?.customers ?? []
  // The last option adds a new customer named after the search.
  const optionCount = customers.length + 1

  const createMutation = useMutation({
    mutationFn: () => api.createCustomer({ name: newName.trim(), contact: newContact.trim() || null }),
    onSuccess: async ({ customer }) => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
      setAdding(false)
      setQuery('')
      onChange(customer)
    },
  })

  const startAdding = () => {
    setNewName(query.trim())
    setNewContact('')
    setAdding(true)
    setOpen(false)
  }

  const choose = (index: number) => {
    const customer = customers[index]
    if (customer) {
      onChange(customer)
      setQuery('')
      setOpen(false)
    } else {
      startAdding()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : optionCount - 1)) % optionCount)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      choose(highlight)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  if (value) {
    return (
      <div className="flex min-h-control items-center gap-1.5 rounded-md border border-input px-2 py-1">
        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span id={id} className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium">{value.name}</span>
          {value.contact && <span className="text-muted-foreground"> · {value.contact}</span>}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t('schedule.dialog.changeCustomer')}
        </Button>
      </div>
    )
  }

  if (adding) {
    return (
      <div className="grid gap-1.5 rounded-md border border-dashed p-2" role="group" aria-label={t('schedule.dialog.newCustomerTitle')}>
        <div className="grid gap-1.5">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>{t('schedule.dialog.customerName')}</Label>
            <Input id={`${id}-name`} value={newName} maxLength={100} autoFocus onChange={e => setNewName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-contact`}>{t('schedule.dialog.customerContact')}</Label>
            <Input id={`${id}-contact`} value={newContact} maxLength={200} onChange={e => setNewContact(e.target.value)} />
          </div>
        </div>
        {createMutation.error && <p className="text-xs text-destructive">{translateError(createMutation.error.message)}</p>}
        <div className="flex justify-end gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
          <Button type="button" size="sm" disabled={!newName.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {t('schedule.dialog.addCustomer')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); setHighlight(0) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" className="schedule-picker-list">
          {customers.map((customer, index) => (
            <li
              key={customer.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={highlight === index}
              className={cn('schedule-picker-option', highlight === index && 'is-active')}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => choose(index)}
            >
              <span className="truncate font-medium">{customer.name}</span>
              {(customer.contact || customer.upcomingCount > 0) && (
                <span className="truncate text-xs text-muted-foreground">
                  {[customer.contact, customer.upcomingCount > 0 ? t('schedule.dialog.customerUpcoming', { count: customer.upcomingCount }) : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </li>
          ))}
          {customers.length === 0 && !isFetching && search && (
            <li className="px-2 py-1 text-xs text-muted-foreground" aria-hidden="true">{t('schedule.dialog.noCustomers')}</li>
          )}
          {isFetching && customers.length === 0 && (
            <li className="flex justify-center py-1" aria-hidden="true"><Spinner size="sm" /></li>
          )}
          <li
            id={`${listId}-${customers.length}`}
            role="option"
            aria-selected={highlight === customers.length}
            className={cn('schedule-picker-option schedule-picker-add', highlight === customers.length && 'is-active')}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setHighlight(customers.length)}
            onClick={startAdding}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {query.trim() ? t('schedule.dialog.newCustomer', { name: query.trim() }) : t('schedule.dialog.newCustomerTitle')}
          </li>
        </ul>
      )}
    </div>
  )
}
