import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, X, Keyboard } from 'lucide-react'
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
import { Navbar, PageContainer } from '@/components/layout'
import {
  isTauriApp,
  getStealthSettings,
  saveStealthSettings,
  applyStealthSettings,
  type StealthSettings,
} from '@/lib/tauri'

const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL || ''
const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || ''

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [stealthSettings, setStealthSettings] = useState<StealthSettings>(getStealthSettings())

  const isTauri = isTauriApp()

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
        message: t('settings.connectionFailed', { error: error instanceof Error ? error.message : 'Unknown error' }),
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
        centerContent={<span className="font-semibold">{t('settings.title')}</span>}
        showUser={false}
      />

      <PageContainer className="max-w-4xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.title')}</CardTitle>
              <CardDescription>Configure your server connection settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="serverUrl">{t('settings.serverUrl.label')}</Label>
                <Input
                  id="serverUrl"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder={t('settings.serverUrl.placeholder')}
                />
                <p className="text-xs text-muted-foreground">{t('settings.serverUrl.hint')}</p>
              </div>

              <div className="space-y-2">
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
                  className={`flex items-center gap-2 p-3 rounded-md ${
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

          {isTauri && (
            <Card>
              <CardHeader>
                <CardTitle>Stealth Mode</CardTitle>
                <CardDescription>Privacy and window control settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stealthSettings.screenCaptureProtection}
                    onChange={(e) => updateStealthSetting('screenCaptureProtection', e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-sm">Hide from screen capture</p>
                    <p className="text-xs text-muted-foreground">Window appears black in recordings</p>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stealthSettings.hideFromTaskbar}
                    onChange={(e) => updateStealthSetting('hideFromTaskbar', e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-sm">Hide from taskbar</p>
                    <p className="text-xs text-muted-foreground">Only show in system tray</p>
                  </div>
                </label>

                <div className="bg-muted p-3 rounded-md space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Keyboard className="h-3.5 w-3.5" />
                    <span className="font-medium text-xs">Shortcuts</span>
                  </div>
                  <div className="text-xs text-muted-foreground grid grid-cols-2 gap-1">
                    <span><kbd className="px-1 bg-background rounded text-[10px]">Ctrl+Shift+H</kbd> Hide</span>
                    <span><kbd className="px-1 bg-background rounded text-[10px]">Ctrl+Shift+T</kbd> Top</span>
                    <span className="col-span-2"><kbd className="px-1 bg-background rounded text-[10px]">Ctrl+Shift+U/I/O/J/K/L/M/,/.</kbd> Move</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <Button className="flex-1" onClick={handleSave}>
            {t('settings.saveSettings')}
          </Button>
          <Button variant="outline" className="flex-1" onClick={handleReset}>
            {t('settings.resetToDefault')}
          </Button>
        </div>
      </PageContainer>
    </div>
  )
}
