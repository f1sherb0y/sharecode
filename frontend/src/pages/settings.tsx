import { translateError } from '@/i18n/errors'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { Check, X, Keyboard, Sun, Moon } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Input,
  Label,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { Navbar, NavbarBack, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore, useThemeStore, useSettingsStore } from '@/stores'
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
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { user, actorType } = useAuthStore()
  const { theme, setTheme } = useThemeStore()
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
        {/* User preferences — always visible */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {/* Appearance */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.appearance.title')}</CardTitle>
              <CardDescription>{t('settings.appearance.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-1">
                <Button
                  variant={theme === 'light' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => setTheme('light')}
                >
                  <Sun className="h-4 w-4 mr-1.5" />
                  {t('settings.appearance.light')}
                </Button>
                <Button
                  variant={theme === 'dark' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => setTheme('dark')}
                >
                  <Moon className="h-4 w-4 mr-1.5" />
                  {t('settings.appearance.dark')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Language */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.language.title')}</CardTitle>
              <CardDescription>{t('settings.language.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-1">
                <Button
                  variant={i18n.language === 'en' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => i18n.changeLanguage('en')}
                >
                  English
                </Button>
                <Button
                  variant={i18n.language === 'zh' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => i18n.changeLanguage('zh')}
                >
                  中文
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Timezone */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.timezone.title')}</CardTitle>
              <CardDescription>{t('settings.timezone.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="ui-field"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </CardContent>
          </Card>
        </div>

        {canChangePassword && (
          <Card className="mt-2">
            <CardHeader>
              <CardTitle>{t('settings.password.title')}</CardTitle>
              <CardDescription>{t('settings.password.description')}</CardDescription>
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
                    placeholder={t('settings.password.currentPlaceholder')}
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
                    placeholder={t('settings.password.newPlaceholder')}
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
                    placeholder={t('settings.password.confirmPlaceholder')}
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
                  <CardDescription>{t('settings.server.description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="serverUrl">{t('settings.serverUrl.label')}</Label>
                    <Input
                      id="serverUrl"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder={t('settings.serverUrl.placeholder')}
                    />
                    <p className="text-xs text-muted-foreground">{t('settings.serverUrl.hint')}</p>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="wsUrl">{t('settings.websocketUrl.label')}</Label>
                    <Input
                      id="wsUrl"
                      value={wsUrl}
                      onChange={(e) => setWsUrl(e.target.value)}
                      placeholder={t('settings.websocketUrl.placeholder')}
                    />
                    <p className="text-xs text-muted-foreground">{t('settings.websocketUrl.hint')}</p>
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
                  <CardDescription>{t('settings.privacy.description')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="flex items-start gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stealthSettings.screenCaptureProtection}
                      onChange={(e) => updateStealthSetting('screenCaptureProtection', e.target.checked)}
                      className="mt-1"
                    />
                    <div>
                      <p className="font-medium text-sm">{t('settings.privacy.hideFromCapture.label')}</p>
                      <p className="text-xs text-muted-foreground">{t('settings.privacy.hideFromCapture.hint')}</p>
                    </div>
                  </label>

                  <label className="flex items-start gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stealthSettings.hideFromTaskbar}
                      onChange={(e) => updateStealthSetting('hideFromTaskbar', e.target.checked)}
                      className="mt-1"
                    />
                    <div>
                      <p className="font-medium text-sm">{t('settings.privacy.hideFromTaskbar.label')}</p>
                      <p className="text-xs text-muted-foreground">{t('settings.privacy.hideFromTaskbar.hint')}</p>
                    </div>
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
