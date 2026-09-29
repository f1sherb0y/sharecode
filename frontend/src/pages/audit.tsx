import { formatDateTime } from '@/lib/utils'
import { translateError } from '@/i18n/errors'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DatePicker from 'react-datepicker'
import { zhCN } from 'date-fns/locale/zh-CN'
import { enUS } from 'date-fns/locale/en-US'
import 'react-datepicker/dist/react-datepicker.css'
import '@/styles/audit.css'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { Navbar, PageContainer } from '@/components/layout'
import { Button, Input, Spinner, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui'
import { PageNavigation } from '@/components/ui/page-navigation'
import { AuditDevice } from '@/components/features/audit-device'
import { AUDIT_ACTIONS, type AuditFilters } from '@/types/audit'

export function AuditPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const user = useAuthStore(state => state.user)
  const canViewDevices = user?.role === 'superuser'
  const allowed = user?.role === 'admin' || user?.role === 'superuser'
  const [username, setUsername] = useState(params.get('username') ?? '')
  const [action, setAction] = useState('all')
  const [start, setStart] = useState<Date | null>(null)
  const [end, setEnd] = useState<Date | null>(null)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [filters, setFilters] = useState<AuditFilters>({ page: 1, pageSize: 25, username: params.get('username') ?? '', deviceId: canViewDevices ? params.get('deviceId') ?? undefined : undefined })
  const [refresh, setRefresh] = useState(0)
  const invalidRange = !!(start && end && start > end)
  const query = useQuery({ queryKey: ['audit', filters, refresh, user?.id, user?.role], queryFn: () => api.getAuditEvents({ ...filters, deviceId: canViewDevices ? filters.deviceId : undefined }), enabled: allowed,
    refetchInterval: filters.page === 1 && !filters.snapshot ? 15000 : false })
  const locale = i18n.language.startsWith('zh') ? zhCN : enUS
  if (!allowed) return <p role="alert">{t('audit.denied')}</p>
  return <div>
    <Navbar title={null} centerContent={<strong>{t('audit.title')}</strong>}
      leftContent={<Button variant="ghost" onClick={() => navigate('/admin')}>{t('common.back')}</Button>} />
    <PageContainer>
      <p className="text-xs text-muted-foreground mb-2">{t('audit.description')}</p>
      <form className="audit-filters mb-2" onSubmit={event => { event.preventDefault(); if (!invalidRange) setFilters({ ...filters, page: 1, snapshot: undefined, username: username.trim(), action: action === 'all' ? undefined : action, start: start?.toISOString(), end: end?.toISOString() }) }}>
        <label>{t('audit.account')}<Input placeholder={t('audit.account')} value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label>{t('audit.action')}<Select value={action} onValueChange={setAction}><SelectTrigger aria-label={t('audit.action')}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="all">{t('audit.allActions')}</SelectItem>
          {AUDIT_ACTIONS.map(value => <SelectItem key={value} value={value}>{t(`audit.actions.${value}`)}</SelectItem>)}
        </SelectContent></Select></label>
        {[{ id: 'start', date: start, set: setStart }, { id: 'end', date: end, set: setEnd }].map(field => <label key={field.id} htmlFor={`audit-${field.id}`}>
          {t(`audit.${field.id}`)}
          <DatePicker id={`audit-${field.id}`} selected={field.date} onChange={field.set} showTimeInput timeInputLabel={t('audit.time')}
            open={openDate === field.id} onFocus={() => setOpenDate(field.id)} onInputClick={() => setOpenDate(field.id)}
            onClickOutside={() => setOpenDate(null)} onCalendarClose={() => setOpenDate(current => current === field.id ? null : current)}
            onKeyDown={event => { if (event.key === 'Escape') setOpenDate(null) }}
            dateFormat="yyyy-MM-dd HH:mm" locale={locale} strictParsing isClearable autoComplete="off" placeholderText="YYYY-MM-DD HH:mm"
            className="ui-field" calendarClassName="audit-calendar" popperClassName="audit-datepicker" popperPlacement="bottom-start"
            previousMonthAriaLabel={t('audit.previousMonth')} nextMonthAriaLabel={t('audit.nextMonth')} clearButtonTitle={t('audit.clear')}
            ariaInvalid={invalidRange ? 'true' : undefined} />
        </label>)}
        <div className="flex gap-1 items-end">
          <Button type="submit" disabled={invalidRange}>{t('audit.filter')}</Button>
          <Button type="button" variant="outline" onClick={() => { setFilters({ ...filters, page: 1, snapshot: undefined }); setRefresh(v => v+1) }}>{t('audit.refresh')}</Button>
          <Button type="button" variant="ghost" onClick={() => { setUsername(''); setAction('all'); setStart(null); setEnd(null); setFilters({ page: 1, pageSize: filters.pageSize }); navigate('/admin/audit', { replace: true }) }}>{t('audit.clear')}</Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2 justify-between items-center mb-2 text-xs text-muted-foreground">
        <span>{t('audit.localTime', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}{canViewDevices && filters.deviceId && <> · {t('audit.device')}: <code>{filters.deviceId.slice(0,8)}</code></>}</span>
        <Select value={String(filters.pageSize)} onValueChange={value => setFilters({ ...filters, page: 1, snapshot: undefined, pageSize: Number(value) })}>
          <SelectTrigger className="w-28" aria-label={t('rooms.pagination.pageSize')}><SelectValue /></SelectTrigger>
          <SelectContent>{[25,50,100].map(size => <SelectItem key={size} value={String(size)}>{t('rooms.pagination.perPage', { count: size })}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {invalidRange && <p role="alert" className="text-sm text-destructive">{t('audit.invalidRange')}</p>}
      {query.isLoading && <Spinner />}
      {query.error && <p role="alert">{translateError(query.error.message)}</p>}
      <div className="overflow-x-auto"><table className="audit-table w-full text-xs text-left">
        <thead><tr>{['time','action','account','result',canViewDevices ? 'device' : 'browser','ip','details'].map(key => <th key={key}>{t(`audit.${key}`)}</th>)}</tr></thead>
        <tbody>{query.data?.events.map(event => <tr key={event.id}>
          <td className="whitespace-nowrap">{formatDateTime(event.createdAt)}</td>
          <td>{t(`audit.actions.${event.action}`, { defaultValue: event.action })}</td>
          <td>{event.username || '—'}</td>
          <td>{event.success ? t('audit.success') : t('audit.failure')}{event.reason && <div className="text-muted-foreground">{t(`audit.reasons.${event.reason}`, { defaultValue: event.reason })}</div>}</td>
          <td>{canViewDevices ? <AuditDevice {...event} /> : <span className="break-words">{event.userAgent || '—'}</span>}</td>
          <td className="whitespace-nowrap"><code>{event.clientIp}</code></td>
          <td><details><summary className="cursor-pointer">{t('audit.details')}</summary><dl className="audit-details">
            {[['target',event.targetId],['request',event.requestId],...(canViewDevices ? [['device',event.deviceId],['fingerprint',event.fingerprint]] : []),['browser',event.userAgent],['peer',event.peerIp],['ipSource',event.ipSource]].map(([key,value]) => <div key={key}><dt>{t(`audit.${key}`)}</dt><dd>{value || '—'}</dd></div>)}
            {Object.keys(event.details).length > 0 && <div><dt>{t('audit.changes')}</dt><dd><pre>{JSON.stringify(event.details,null,2)}</pre></dd></div>}
          </dl></details></td>
        </tr>)}</tbody>
      </table></div>
      {query.data?.events.length === 0 && <p className="py-2">{t('audit.empty')}</p>}
      {query.data && <PageNavigation pagination={query.data.pagination} disabled={query.isFetching} onPage={page => setFilters({ ...filters, page, snapshot: page === 1 ? undefined : query.data.snapshot })} />}
    </PageContainer>
  </div>
}
