import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, BellRing } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import { cn, formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores'
import type { NotificationSeverity } from '@/types'

const SEVERITIES: NotificationSeverity[] = ['normal', 'emergency']

export function NotificationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [severity, setSeverity] = useState<NotificationSeverity>('normal')
  const [error, setError] = useState('')
  const autoMarkedRef = useRef(false)

  const canPublish = user?.role === 'superuser'

  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: async () => {
      const { notifications } = await api.getNotifications()
      return notifications
    },
  })

  const markAllReadMutation = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
        queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications }),
      ])
    },
  })

  useEffect(() => {
    const notifications = notificationsQuery.data ?? []
    const hasUnread = notifications.some((notification) => !notification.isRead)
    if (!hasUnread || autoMarkedRef.current) return
    autoMarkedRef.current = true
    markAllReadMutation.mutate()
  }, [notificationsQuery.data, markAllReadMutation])

  const createNotificationMutation = useMutation({
    mutationFn: () => api.createNotification({ title: title.trim(), content: content.trim(), severity }),
    onSuccess: async () => {
      setTitle('')
      setContent('')
      setSeverity('normal')
      setError('')
      toast.success(t('notifications.publish.success'))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
        queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications }),
      ])
    },
  })

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!title.trim() || !content.trim()) {
      setError(t('notifications.publish.required'))
      return
    }

    try {
      await createNotificationMutation.mutateAsync()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notifications.publish.failed'))
    }
  }

  const notifications = notificationsQuery.data ?? []

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar
        leftContent={
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back')}
          </Button>
        }
        title={null}
        centerContent={<span className="font-semibold">{t('notifications.title')}</span>}
      />

      <PageContainer className="max-w-5xl mx-auto space-y-4">
        {canPublish && (
          <Card>
            <CardHeader>
              <CardTitle>{t('notifications.publish.title')}</CardTitle>
              <CardDescription>{t('notifications.publish.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePublish} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                  <div className="space-y-2">
                    <Label htmlFor="notificationTitle">{t('notifications.publish.fields.title')}</Label>
                    <Input
                      id="notificationTitle"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={t('notifications.publish.fields.titlePlaceholder')}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('notifications.publish.fields.severity')}</Label>
                    <Select value={severity} onValueChange={(value) => setSeverity(value as NotificationSeverity)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEVERITIES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value === 'emergency'
                              ? t('notifications.severity.emergency')
                              : t('notifications.severity.normal')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notificationContent">{t('notifications.publish.fields.content')}</Label>
                  <Textarea
                    id="notificationContent"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('notifications.publish.fields.contentPlaceholder')}
                    rows={6}
                    required
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={createNotificationMutation.isPending}>
                  {createNotificationMutation.isPending
                    ? t('notifications.publish.submitting')
                    : t('notifications.publish.submit')}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-5 w-5" />
              {t('notifications.history.title')}
            </CardTitle>
            <CardDescription>{t('notifications.history.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {notificationsQuery.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : notifications.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('notifications.history.empty')}</p>
            ) : (
              notifications.map((notification) => {
                const isEmergency = notification.severity === 'emergency'
                return (
                <div
                  key={notification.id}
                  className={cn(
                    'rounded-lg border p-4 space-y-3',
                    isEmergency && 'border-l-4 border-l-destructive'
                  )}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className={cn('font-medium', isEmergency && 'font-bold')}>
                          {notification.title}
                        </h3>
                        <Badge variant={notification.severity === 'emergency' ? 'destructive' : 'secondary'}>
                          {notification.severity === 'emergency'
                            ? t('notifications.severity.emergency')
                            : t('notifications.severity.normal')}
                        </Badge>
                        <Badge variant={notification.isRead ? 'outline' : 'secondary'}>
                          {notification.isRead
                            ? t('notifications.status.read')
                            : t('notifications.status.unread')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(notification.createdAt)} · {notification.createdBy.username}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{notification.content}</p>
                </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </PageContainer>
    </div>
  )
}
