import { formatDateTime } from '@/lib/utils'
import { translateError } from '@/i18n/errors'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { Navbar, PageContainer } from '@/components/layout'
import { Button, Input, Spinner } from '@/components/ui'

export function AuditPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore(state => state.user)
  const allowed = user?.role === 'admin' || user?.role === 'superuser'
  const [cursor, setCursor] = useState<number | undefined>()
  const [username, setUsername] = useState('')
  const [filter, setFilter] = useState('')
  const query = useQuery({ queryKey: ['audit', cursor, filter, user?.id],
    queryFn: () => api.getAuditEvents(cursor, filter), enabled: allowed })
  if (!allowed) return <p role="alert">{t('audit.denied')}</p>
  return <div>
    <Navbar title={null} centerContent={<strong>{t('audit.title')}</strong>}
      leftContent={<Button variant="ghost" onClick={() => navigate('/admin')}>{t('common.back')}</Button>} />
    <PageContainer>
      <p className="text-sm text-muted-foreground mb-2">{t('audit.description')}</p>
      <form className="flex gap-1 mb-2" onSubmit={event => { event.preventDefault(); setCursor(undefined); setFilter(username.trim()) }}>
        <Input aria-label={t('audit.account')} placeholder={t('audit.account')} value={username} onChange={event => setUsername(event.target.value)} />
        <Button type="submit">{t('audit.filter')}</Button>
        <Button type="button" variant="outline" onClick={() => { setCursor(undefined); void query.refetch() }}>{t('audit.refresh')}</Button>
      </form>
      {query.isLoading && <Spinner />}
      {query.error && <p role="alert">{translateError(query.error.message)}</p>}
      <div className="overflow-x-auto"><table className="w-full text-sm text-left [&_th]:whitespace-nowrap">
        <thead><tr>{['time','action','account','result','ip','browser','target'].map(key => <th key={key} className="p-1.5 border-b">{t(`audit.${key}`)}</th>)}</tr></thead>
        <tbody>{query.data?.events.map(event => <tr key={event.id}>
          <td className="p-1.5 border-b whitespace-nowrap">{formatDateTime(event.createdAt)}</td>
          <td className="p-1.5 border-b">{event.action}</td>
          <td className="p-1.5 border-b">{event.username || '—'}</td>
          <td className="p-1.5 border-b">{event.success ? t('audit.success') : t('audit.failure')} {event.reason && <small>({event.reason})</small>}</td>
          <td className="p-1.5 border-b whitespace-nowrap"><code>{event.clientIp}</code><div className="text-xs text-muted-foreground">{event.ipSource} · {t('audit.peer')} {event.peerIp}</div></td>
          <td className="p-1.5 border-b max-w-xs break-words">{event.userAgent || '—'}</td>
          <td className="p-1.5 border-b"><code>{event.targetId || '—'}</code><div className="text-xs text-muted-foreground">{event.requestId}</div></td>
        </tr>)}</tbody>
      </table></div>
      {query.data?.events.length === 0 && <p className="py-2">{t('audit.empty')}</p>}
      <div className="flex gap-1 mt-2">
        <Button variant="outline" disabled={!cursor} onClick={() => setCursor(undefined)}>{t('audit.latest')}</Button>
        <Button disabled={!query.data?.nextCursor} onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>{t('audit.older')}</Button>
      </div>
    </PageContainer>
  </div>
}
