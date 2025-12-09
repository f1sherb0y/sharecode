import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, X } from 'lucide-react'
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
import { isTauriApp, isScreenCaptureProtectionSupported, setScreenCaptureProtection, setTaskbarVisibility } from '@/lib/tauri'

// Empty string means relative URL (same origin)
const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL || ''
const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || ''

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [hideFromCapture, setHideFromCapture] = useState(false)
  const [hideFromTaskbar, setHideFromTaskbar] = useState(false)

  const isTauri = isTauriApp()
  const supportsCaptureProtection = isScreenCaptureProtectionSupported()

  useEffect(() => {
    const saved = localStorage.getItem('sharecode_settings')
    if (saved) {
      try {
        const settings = JSON.parse(saved)
        // Use empty string as default (relative URL)
        setServerUrl(settings.serverUrl ?? DEFAULT_SERVER_URL)
        setWsUrl(settings.wsUrl ?? DEFAULT_WS_URL)
        setHideFromCapture(settings.hideFromCapture || false)
        setHideFromTaskbar(settings.hideFromTaskbar || false)
      } catch {
        // Ignore parse errors
      }
    }
  }, [])

  const handleSave = async () => {
    const settings = {
      // Store empty string for relative, or trimmed URL for absolute
      serverUrl: serverUrl.trim().replace(/\/$/, '') || undefined,
      wsUrl: wsUrl.trim().replace(/\/$/, '') || undefined,
      hideFromCapture,
      hideFromTaskbar,
    }

    localStorage.setItem('sharecode_settings', JSON.stringify(settings))

    if (isTauri && supportsCaptureProtection) {
      try {
        await setScreenCaptureProtection(hideFromCapture)
        await setTaskbarVisibility(!hideFromTaskbar)
      } catch (error) {
        console.error('Failed to apply privacy settings:', error)
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
    // Also clear from localStorage
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

      <PageContainer className="max-w-xl mx-auto">
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

            {supportsCaptureProtection && (
              <div className="border-t pt-6 space-y-4">
                <h3 className="font-medium">{t('settings.privacy.title')}</h3>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideFromCapture}
                    onChange={(e) => setHideFromCapture(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-sm">{t('settings.privacy.hideFromCapture.label')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.privacy.hideFromCapture.hint')}</p>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideFromTaskbar}
                    onChange={(e) => setHideFromTaskbar(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-sm">{t('settings.privacy.hideFromTaskbar.label')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.privacy.hideFromTaskbar.hint')}</p>
                  </div>
                </label>

                <p className="text-xs text-muted-foreground bg-muted p-3 rounded-md">{t('settings.privacy.note')}</p>
              </div>
            )}

            <div className="flex gap-2 pt-4">
              <Button className="flex-1" onClick={handleSave}>
                {t('settings.saveSettings')}
              </Button>
              <Button variant="outline" className="flex-1" onClick={handleReset}>
                {t('settings.resetToDefault')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </PageContainer>
    </div>
  )
}
