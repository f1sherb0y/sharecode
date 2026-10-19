import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import type { RosterEntry, RosterKind, User } from '@/types'

const NO_ACCOUNT = 'none'

/**
 * The work tables' two lists: techs whose tables show and 管理 who book. A name
 * stands for an account, or for nobody's yet until one is linked to it.
 */
export function RosterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<RosterKind>('tech')
  const roster = useQuery({ queryKey: ['roster'], queryFn: () => api.getRoster(), enabled: open })
  const accountsQuery = useQuery({
    queryKey: queryKeys.roomCreationUsers,
    queryFn: async () => (await api.getRoomOwners()).users,
    enabled: open,
    staleTime: 60_000,
  })
  const entries = (kind === 'tech' ? roster.data?.techs : roster.data?.managers) ?? []
  // 管理 stand for staff accounts; techs for anyone's.
  const accounts = (accountsQuery.data ?? [])
    .filter(user => kind === 'tech' || user.role !== 'tech')
    .filter(user => !entries.some(entry => entry.userId === user.id))
    .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }))

  const refresh = () => Promise.all(
    [['roster'], ['work-tables'], ['work-table'], ['appointments']].map(queryKey => queryClient.invalidateQueries({ queryKey })),
  )
  const failed = (err: unknown) => toast.error(translateError(err instanceof Error ? err.message : t('common.requestFailed')))
  const [name, setName] = useState('')
  const [account, setAccount] = useState(NO_ACCOUNT)
  const add = useMutation({
    mutationFn: () => api.addRosterEntry(kind, name.trim(), account === NO_ACCOUNT ? null : account),
    onSuccess: async () => {
      setName('')
      setAccount(NO_ACCOUNT)
      await refresh()
    },
    onError: failed,
  })
  const change = useMutation({
    mutationFn: ({ entry, ...change }: { entry: RosterEntry; name?: string; accountId?: string }) => api.updateRosterEntry(kind, entry.userId, change),
    onSuccess: refresh,
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: (entry: RosterEntry) => api.removeRosterEntry(kind, entry.userId),
    onSuccess: refresh,
    onError: failed,
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) add.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wt-roster" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('workTable.roster')}</DialogTitle></DialogHeader>
        <div className="wt-roster-tabs" role="tablist">
          {(['tech', 'manager'] as const).map(value => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} className={cn(kind === value && 'is-active')} onClick={() => setKind(value)}>
              {value === 'tech' ? t('workTable.tech') : t('workTable.manager')}
              <span className="wt-table-count">{(value === 'tech' ? roster.data?.techs : roster.data?.managers)?.length ?? ''}</span>
            </button>
          ))}
        </div>
        <ul className="wt-roster-list">
          {entries.map(entry => (
            <RosterRow
              key={entry.userId}
              entry={entry}
              accounts={accounts}
              busy={change.isPending || remove.isPending}
              onRename={value => change.mutate({ entry, name: value })}
              onLink={accountId => change.mutate({ entry, accountId })}
              onRemove={() => remove.mutate(entry)}
            />
          ))}
        </ul>
        <form className="wt-roster-add" onSubmit={submit}>
          <Input value={name} maxLength={32} aria-label={t('workTable.rosterName')} placeholder={t('workTable.rosterName')} onChange={event => setName(event.target.value)} />
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger aria-label={t('workTable.account')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ACCOUNT}>{t('workTable.noAccount')}</SelectItem>
              {accounts.map(user => <SelectItem key={user.id} value={user.id}>{user.username}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={!name.trim() || add.isPending}>{t('workTable.add')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface RosterRowProps {
  entry: RosterEntry
  accounts: User[]
  busy: boolean
  onRename: (name: string) => void
  onLink: (accountId: string) => void
  onRemove: () => void
}

function RosterRow({ entry, accounts, busy, onRename, onLink, onRemove }: RosterRowProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  const save = () => {
    const value = editing?.trim()
    setEditing(null)
    if (value && value !== entry.name) onRename(value)
  }
  return (
    <li className="wt-roster-row">
      <span className="wt-dot" style={{ background: entry.color }} aria-hidden="true" />
      {editing === null ? (
        <button type="button" className="wt-roster-name" onClick={() => setEditing(entry.name)}>
          {entry.name}
          {!entry.linkOnly && entry.username !== entry.name && <span className="wt-table-count"> · {entry.username}</span>}
        </button>
      ) : (
        <Input
          autoFocus
          value={editing}
          maxLength={32}
          aria-label={t('workTable.rosterName')}
          className="wt-roster-input"
          onChange={event => setEditing(event.target.value)}
          onBlur={save}
          onKeyDown={event => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') setEditing(null)
          }}
        />
      )}
      {entry.linkOnly && (
        <Select value="" onValueChange={onLink} disabled={busy}>
          <SelectTrigger className="wt-roster-link" aria-label={t('workTable.linkAccount')}>
            <SelectValue placeholder={t('workTable.linkAccount')} />
          </SelectTrigger>
          <SelectContent>
            {accounts.map(user => <SelectItem key={user.id} value={user.id}>{user.username}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <button type="button" className="wt-note-close" aria-label={t('workTable.remove')} disabled={busy} onClick={onRemove}>
        <X />
      </button>
    </li>
  )
}
