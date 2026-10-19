import { translateError } from '@/i18n/errors'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X, Keyboard } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Input,
  Label,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { Navbar, NavbarBack, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore, useSettingsStore } from '@/stores'
import { validatePasswordPolicy } from '@/lib/password-policy'
import {
  isTauriApp,
  getStealthSettings,
  saveStealthSettings,
  applyStealthSettings,
  type StealthSettings,
} from '@/lib/tauri'

const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL || ''
const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || ''

const TIMEZONE_OPTIONS = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, actorType } = useAuthStore()
  const { timezone, setTimezone } = useSettingsStore()

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [stealthSettings, setStealthSettings] = useState<StealthSettings>(getStealthSettings())
  const [passwordError, setPasswordError] = useState('')

  const isTauri = isTauriApp()
  const canChangePassword = actorType === 'user' && !!user

  const changePasswordMutation = useMutation({
    mutationFn: ({ oldPassword, nextPassword }: { oldPassword: string; nextPassword: string }) =>
      api.changePassword(oldPassword, nextPassword),
    onSuccess: () => {
      setPasswordError('')
      toast.success(t('settings.password.success'))
    },
  })

  useEffect(() => {
    const saved = localStorage.getItem('sharecode_settings')
    if (saved) {
      try {
        const settings = JSON.parse(saved)
        setServerUrl(settings.serverUrl ?? DEFAULT_SERVER_URL)
        setWsUrl(settings.wsUrl ?? DEFAULT_WS_URL)
      } catch {
        // Ignore
      }
    }
    setStealthSettings(getStealthSettings())
  }, [])

  const updateStealthSetting = <K extends keyof StealthSettings>(key: K, value: StealthSettings[K]) => {
    setStealthSettings(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    const settings = {
      serverUrl: serverUrl.trim().replace(/\/$/, '') || undefined,
      wsUrl: wsUrl.trim().replace(/\/$/, '') || undefined,
    }

    localStorage.setItem('sharecode_settings', JSON.stringify(settings))

    if (isTauri) {
      try {
        saveStealthSettings(stealthSettings)
        await applyStealthSettings(stealthSettings)
      } catch (error) {
        console.error('Failed to apply stealth settings:', error)
      }
    }

    navigate(-1)
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)

    try {
      const testUrl = serverUrl.trim().replace(/\/$/, '')
      const response = await fetch(`${testUrl}/api/rooms`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })

      if (response.ok || response.status === 401) {
        setTestResult({ success: true, message: t('settings.connectionSuccess') })
      } else {
        setTestResult({ success: false, message: t('settings.serverStatus', { status: response.status }) })
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: t('settings.connectionFailed', { error: translateError(error instanceof Error ? error.message : 'Unknown error') }),
      })
    } finally {
      setTesting(false)
    }
  }

  const handleReset = () => {
    setServerUrl(DEFAULT_SERVER_URL)
    setWsUrl(DEFAULT_WS_URL)
    const saved = localStorage.getItem('sharecode_settings')
    if (saved) {
      try {
        const settings = JSON.parse(saved)
        delete settings.serverUrl
        delete settings.wsUrl
        localStorage.setItem('sharecode_settings', JSON.stringify(settings))
      } catch {
        // Ignore
      }
    }
  }

  const handleChangePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fields = new FormData(form)
    const currentPassword = String(fields.get('currentPassword') ?? '')
    const newPassword = String(fields.get('newPassword') ?? '')
    const confirmPassword = String(fields.get('confirmPassword') ?? '')
    setPasswordError('')

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError(t('settings.password.required'))
      return
    }

    if (!validatePasswordPolicy(newPassword)) {
      setPasswordError(t('common.passwordPolicyError'))
      return
    }

    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.password.mismatch'))
      return
    }

    try {
      await changePasswordMutation.mutateAsync({
        oldPassword: currentPassword,
        nextPassword: newPassword,
      })
      form.reset()
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t('settings.password.failed'))
    }
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar
        leftContent={
          <NavbarBack label={t('common.back')} onClick={() => navigate(-1)} />
        }
        title={null}
        centerContent={<span className="font-semibold">{t('settings.title')}</span>}
        showUser={false}
      />

      <PageContainer className="max-w-4xl mx-auto">
        {/* User preferences — always visible. Theme and language switch in the top bar. */}
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.timezone.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              aria-label={t('settings.timezone.title')}
              className="ui-field sm:max-w-xs"
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>

        {canChangePassword && <UsernameCard username={user.username} />}

        {canChangePassword && (
          <Card className="mt-2">
            <CardHeader>
              <CardTitle>{t('settings.password.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form id="change-password-form" method="post" autoComplete="on" onSubmit={handleChangePassword} className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <input type="hidden" name="username" autoComplete="username" value={user.username} />
                <div className="space-y-1">
                  <Label htmlFor="currentPassword">{t('settings.password.current')}</Label>
                  <Input
                    id="currentPassword"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="newPassword">{t('settings.password.new')}</Label>
                  <Input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="confirmPassword">{t('settings.password.confirm')}</Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                </div>
                <div className="md:col-span-3 flex flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground">{t('common.passwordPolicyHint')}</p>
                  {passwordError && <p className="text-sm text-destructive">{translateError(passwordError)}</p>}
                  <div>
                    <Button type="submit" disabled={changePasswordMutation.isPending}>
                      {changePasswordMutation.isPending
                        ? t('settings.password.updating')
                        : t('settings.password.update')}
                    </Button>
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Server & stealth — Tauri only */}
        {isTauri && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t('settings.server.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="serverUrl">{t('settings.serverUrl.label')}</Label>
                    <Input
                      id="serverUrl"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="wsUrl">{t('settings.websocketUrl.label')}</Label>
                    <Input
                      id="wsUrl"
                      value={wsUrl}
                      onChange={(e) => setWsUrl(e.target.value)}
                    />
                  </div>

                  {testResult && (
                    <div
                      className={`flex items-center gap-1 p-2 rounded-md ${
                        testResult.success ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
                      }`}
                    >
                      {testResult.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                      <span className="text-sm">{testResult.message}</span>
                    </div>
                  )}

                  <Button variant="outline" className="w-full" onClick={handleTestConnection} disabled={testing}>
                    {testing ? t('settings.testing') : t('settings.testConnection')}
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('settings.privacy.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stealthSettings.screenCaptureProtection}
                      onChange={(e) => updateStealthSetting('screenCaptureProtection', e.target.checked)}
                    />
                    <span className="font-medium text-sm">{t('settings.privacy.hideFromCapture.label')}</span>
                  </label>

                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stealthSettings.hideFromTaskbar}
                      onChange={(e) => updateStealthSetting('hideFromTaskbar', e.target.checked)}
                    />
                    <span className="font-medium text-sm">{t('settings.privacy.hideFromTaskbar.label')}</span>
                  </label>

                  <div className="bg-muted p-2 rounded-md space-y-1">
                    <div className="flex items-center gap-1">
                      <Keyboard className="h-3.5 w-3.5" />
                      <span className="font-medium text-xs">{t('settings.shortcuts.title')}</span>
                    </div>
                    <div className="text-xs text-muted-foreground grid grid-cols-2 gap-1">
                      <span><kbd className="px-1 bg-background rounded text-[11px]">Ctrl+Shift+H</kbd> {t('settings.shortcuts.hide')}</span>
                      <span><kbd className="px-1 bg-background rounded text-[11px]">Ctrl+Shift+T</kbd> {t('settings.shortcuts.top')}</span>
                      <span className="col-span-2"><kbd className="px-1 bg-background rounded text-[11px]">Ctrl+Shift+U/I/O/J/K/L/M/,/.</kbd> {t('settings.shortcuts.move')}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="flex gap-1 mt-2">
              <Button className="flex-1" onClick={handleSave}>
                {t('settings.saveSettings')}
              </Button>
              <Button variant="outline" className="flex-1" onClick={handleReset}>
                {t('settings.resetToDefault')}
              </Button>
            </div>
          </>
        )}
      </PageContainer>
    </div>
  )
}

/** The account's own name: once a week, and nobody else's whatever its case. */
function UsernameCard({ username }: { username: string }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [value, setValue] = useState(username)
  const [error, setError] = useState('')
  useEffect(() => setValue(username), [username])
  const change = useQuery({ queryKey: ['username-change'], queryFn: () => api.getUsernameChange() })
  const nextAt = change.data?.nextChangeAt ?? null
  const save = useMutation({
    mutationFn: () => api.changeUsername(value.trim()),
    onSuccess: ({ username: renamed, nextChangeAt }) => {
      setError('')
      useAuthStore.setState(state => ({ user: state.user ? { ...state.user, username: renamed } : state.user }))
      queryClient.setQueryData(['username-change'], { nextChangeAt })
      void queryClient.invalidateQueries({ queryKey: ['work-tables'] })
      toast.success(t('settings.username.saved'))
    },
    onError: err => {
      const data = (err as { data?: { nextChangeAt?: string } }).data
      if (data?.nextChangeAt) queryClient.setQueryData(['username-change'], { nextChangeAt: data.nextChangeAt })
      setError(translateError(err instanceof Error ? err.message : t('common.requestFailed')))
    },
  })
  const when = nextAt
    ? new Date(nextAt).toLocaleString(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <Card className="mt-2">
      <CardHeader>
        <CardTitle>{t('settings.username.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={event => { event.preventDefault(); if (value.trim() && value.trim() !== username) save.mutate() }}
        >
          <div className="flex gap-2">
            <Input
              id="newUsername"
              aria-label={t('settings.username.title')}
              value={value}
              maxLength={32}
              autoComplete="username"
              disabled={!!nextAt}
              onChange={event => setValue(event.target.value)}
              className="max-w-xs"
            />
            <Button type="submit" disabled={!!nextAt || save.isPending || !value.trim() || value.trim() === username}>
              {t('settings.username.save')}
            </Button>
          </div>
          {nextAt && <p className="text-xs text-muted-foreground">{t('settings.username.next', { time: when })}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  )
}
