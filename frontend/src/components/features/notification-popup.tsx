import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { cn, formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores'
import { useTranslation } from 'react-i18next'

export function NotificationPopup() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const actorType = useAuthStore((state) => state.actorType)
  const [dismissed, setDismissed] = useState(false)

  const unreadQuery = useQuery({
    queryKey: queryKeys.unreadNotifications,
    queryFn: async () => {
      const { notifications } = await api.getUnreadNotifications()
      return notifications
    },
    enabled: actorType === 'user',
    // Poll so non-admin users see new notifications without needing to refocus/refresh.
    refetchInterval: 30_000,
    staleTime: 0,
  })

  const markAllReadMutation = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
        queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications }),
      ])
      setDismissed(true)
    },
  })

  useEffect(() => {
    setDismissed(false)
  }, [actorType])

  const unreadNotifications = unreadQuery.data ?? []
  const shouldSuppressPopup = location.pathname === '/notifications'
  const isVisible =
    actorType === 'user' &&
    !dismissed &&
    !shouldSuppressPopup &&
    unreadNotifications.length > 0

  const previewNotifications = useMemo(
    () => unreadNotifications.slice(0, 5),
    [unreadNotifications]
  )

  if (!isVisible) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border bg-background shadow-2xl">
        <div className="border-b px-6 py-4">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <BellRing className="h-5 w-5" />
            {t('notifications.popup.title', { count: unreadNotifications.length })}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('notifications.popup.description')}
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-3">
          {previewNotifications.map((notification) => {
            const isEmergency = notification.severity === 'emergency'
            return (
            <div
              key={notification.id}
              className={cn(
                'rounded-lg border p-4 space-y-2',
                isEmergency && 'border-l-4 border-l-destructive'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={cn('font-medium', isEmergency && 'font-bold')}>
                    {notification.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTime(notification.createdAt)} · {notification.createdBy.username}
                  </div>
                </div>
                <Badge variant={notification.severity === 'emergency' ? 'destructive' : 'secondary'}>
                  {notification.severity === 'emergency'
                    ? t('notifications.severity.emergency')
                    : t('notifications.severity.normal')}
                </Badge>
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{notification.content}</p>
            </div>
            )
          })}

          {unreadNotifications.length > previewNotifications.length && (
            <p className="text-center text-xs text-muted-foreground">
              {t('notifications.popup.more', {
                count: unreadNotifications.length - previewNotifications.length,
              })}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => setDismissed(true)}>
            {t('notifications.popup.later')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDismissed(true)
              navigate('/notifications')
            }}
          >
            {t('notifications.popup.openCenter')}
          </Button>
          <Button
            onClick={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending}
          >
            {markAllReadMutation.isPending
              ? t('notifications.popup.marking')
              : t('notifications.popup.markAllRead')}
          </Button>
        </div>
      </div>
    </div>
  )
}
