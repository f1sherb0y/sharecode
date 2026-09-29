import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Button, Spinner } from '@/components/ui'
import { PageNavigation } from '@/components/ui/page-navigation'
import { AuditDevice } from './audit-device'
import { formatDateTime } from '@/lib/utils'
import { translateError } from '@/i18n/errors'
export function UserDevicesDialog({ user, onClose }: { user: { id: string; username: string }; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const viewer = useAuthStore(state => state.user)
  const allowed = viewer?.role === 'superuser'
  const [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ['user-devices',viewer?.id,viewer?.role,user.id,page], queryFn: () => api.getUserDevices(user.id,page), refetchInterval: 15000, enabled: allowed })
  if (!allowed) return null
  return <Dialog open onOpenChange={open => !open && onClose()}><DialogContent className="sm:max-w-2xl">
    <DialogHeader><DialogTitle>{t('audit.userDevices', { username: user.username })}</DialogTitle><DialogDescription>{t('audit.deviceHint')}</DialogDescription></DialogHeader>
    {query.isLoading && <Spinner />}
    {query.error && <p role="alert">{translateError(query.error.message)}</p>}
    <div className="max-h-[60vh] overflow-auto space-y-2">
      {query.data?.devices.map(device => <div key={device.deviceId} className="border-b pb-2 text-xs">
        <div className="flex items-start justify-between gap-1"><AuditDevice {...device} /><Button size="sm" variant="outline" onClick={() => navigate(`/admin/audit?${new URLSearchParams({ username: user.username, deviceId: device.deviceId })}`)}>{t('audit.events')}</Button></div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1">
          <dt className="text-muted-foreground">{t('audit.firstSeen')}</dt><dd>{formatDateTime(device.firstSeen)}</dd>
          <dt className="text-muted-foreground">{t('audit.lastSeen')}</dt><dd>{formatDateTime(device.lastSeen)}</dd>
          <dt className="text-muted-foreground">{t('audit.lastIp')}</dt><dd><code>{device.lastIp}</code> · {t('audit.loginCount', { count: device.loginCount })}</dd>
        </dl>
        <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">{t('audit.details')}</summary><div className="break-all">{device.deviceId}<br />{device.fingerprint}<br />{device.userAgent}</div></details>
      </div>)}
      {query.data?.devices.length === 0 && <p>{t('audit.noDevices')}</p>}
    </div>
    {query.data && <PageNavigation pagination={query.data.pagination} disabled={query.isFetching} onPage={setPage} />}
  </DialogContent></Dialog>
}
