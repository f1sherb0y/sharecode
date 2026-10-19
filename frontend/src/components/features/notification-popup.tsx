import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button } from '@/components/ui'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { describeScheduleNotice, isScheduleNotice } from '@/lib/schedule-notices'
import { cn, formatDateTime } from '@/lib/utils'
import { useAuthStore, useSettingsStore } from '@/stores'
import type { NotificationItem } from '@/types'
import { useTranslation } from 'react-i18next'

export function NotificationPopup() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const actorType = useAuthStore((state) => state.actorType)
  const [dismissed, setDismissed] = useState(false)
  // A shared table link shows the table only, whoever is signed in on the browser.
  const shown = actorType === 'user' && !location.pathname.startsWith('/t/')

  const unreadQuery = useQuery({
    queryKey: queryKeys.unreadNotifications,
    queryFn: async () => {
      const { notifications } = await api.getUnreadNotifications()
      return notifications
    },
    enabled: shown,
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

  // Announcements take over the screen; a tech's schedule notices are toasts.
  const unread = unreadQuery.data ?? []
  const unreadNotifications = unread.filter(notification => !notification.kind)
  useScheduleToasts(unread.filter(isScheduleNotice), shown && location.pathname !== '/notifications')
  const shouldSuppressPopup = location.pathname === '/notifications'
  const isVisible =
    shown &&
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-2 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border bg-background shadow-2xl">
        <div className="border-b px-3 py-2">
          <div className="flex items-center gap-1 text-lg font-semibold">
            <BellRing className="h-5 w-5" />
            {t('notifications.popup.title', { count: unreadNotifications.length })}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-3 py-2 space-y-1.5">
          {previewNotifications.map((notification) => {
            const isEmergency = notification.severity === 'emergency'
            return (
            <div
              key={notification.id}
              className={cn(
                'rounded-lg border p-2 space-y-1',
                isEmergency && 'border-l-4 border-l-destructive'
              )}
            >
              <div className="flex items-start justify-between gap-1.5">
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

        <div className="flex flex-col-reverse gap-1 border-t px-3 py-2 sm:flex-row sm:justify-end">
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

const toasted = new Set<string>()

/** Shows each unread schedule notice once per tab; acknowledging it marks it read. */
function useScheduleToasts(notices: NotificationItem[], enabled: boolean) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const timezone = useSettingsStore(state => state.timezone)
  const latest = useRef({ t, navigate })
  latest.current = { t, navigate }
  const ids = notices.map(notice => notice.id).join(',')

  useEffect(() => {
    if (!enabled) return
    const fresh = notices.filter(notice => !toasted.has(notice.id))
    if (fresh.length === 0) return
    for (const notice of fresh) toasted.add(notice.id)
    const { t, navigate } = latest.current
    const acknowledge = () => {
      void api.markNotificationsRead(fresh.map(notice => notice.id))
        .then(() => Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
          queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications }),
        ]))
        .catch(() => {})
    }
    const single = fresh.length === 1 ? describeScheduleNotice(fresh[0]!, t, timezone) : null
    toast(single ? single.title : t('schedule.notice.many', { count: fresh.length }), {
      id: `schedule-${fresh.map(notice => notice.id).join('-')}`,
      description: single?.description,
      duration: Infinity,
      closeButton: true,
      action: {
        label: t('schedule.notice.view'),
        onClick: () => {
          acknowledge()
          navigate(single ? single.href : '/notifications')
        },
      },
      onDismiss: acknowledge,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, enabled, timezone, queryClient])
}
