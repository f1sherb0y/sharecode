import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { LanguageSwitcher } from './LanguageSwitcher'
import { setScreenCaptureProtection, setTaskbarVisibility, isTauriApp, isScreenCaptureProtectionSupported } from '../lib/tauri'

const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'
const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000'

export function Settings() {
    const navigate = useNavigate()
    const { t } = useTranslation()
    const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
    const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
    const [hideFromCapture, setHideFromCapture] = useState(false)
    const [hideFromTaskbar, setHideFromTaskbar] = useState(false)
    const isTauri = isTauriApp()
    const supportsCaptureProtection = isScreenCaptureProtectionSupported()

    useEffect(() => {
        // Load saved settings
        const saved = localStorage.getItem('sharecode_settings')
        if (saved) {
            try {
                const settings = JSON.parse(saved)
                setServerUrl(settings.serverUrl || DEFAULT_SERVER_URL)
                setWsUrl(settings.wsUrl || DEFAULT_WS_URL)
                setHideFromCapture(settings.hideFromCapture || false)
                setHideFromTaskbar(settings.hideFromTaskbar || false)
            } catch (e) {
                console.error('Failed to load settings', e)
            }
        }
    }, [])

    const handleSave = async () => {
        const settings = {
            serverUrl: serverUrl.replace(/\/$/, ''), // Remove trailing slash
            wsUrl: wsUrl.replace(/\/$/, ''),
            hideFromCapture,
            hideFromTaskbar
        }

        localStorage.setItem('sharecode_settings', JSON.stringify(settings))

        // Apply privacy settings if in Tauri
        if (isTauri && supportsCaptureProtection) {
            try {
                await setScreenCaptureProtection(hideFromCapture)
                await setTaskbarVisibility(!hideFromTaskbar)
            } catch (error) {
                console.error('Failed to apply privacy settings:', error)
            }
        }

        // Navigate to login after saving
        navigate('/login')
    }

    const handleTestConnection = async () => {
        setTesting(true)
        setTestResult(null)

        try {
            const testUrl = serverUrl.replace(/\/$/, '')
            const response = await fetch(`${testUrl}/api/rooms`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            })

            if (response.ok || response.status === 401) {
                // 401 means server is reachable but user not authenticated
                setTestResult({
                    success: true,
                    message: t('settings.connectionSuccess')
                })
            } else {
                setTestResult({
                    success: false,
                    message: t('settings.serverStatus', { status: response.status })
                })
            }
        } catch (error) {
            setTestResult({
                success: false,
                message: t('settings.connectionFailed', { error: error instanceof Error ? error.message : 'Unknown error' })
            })
        } finally {
            setTesting(false)
        }
    }

    const handleReset = () => {
        setServerUrl(DEFAULT_SERVER_URL)
        setWsUrl(DEFAULT_WS_URL)
    }

    return (
        <div className="auth-container">
            <div className="auth-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <h2>{t('settings.title')}</h2>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <LanguageSwitcher />
                        <ThemeToggle />
                    </div>
                </div>

                <button
                    onClick={() => navigate(-1)}
                    className="btn-secondary"
                    style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                    <ArrowLeft size={16} />
                    {t('common.back')}
                </button>

                <form className="auth-form" onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
                    <div className="form-group">
                        <label className="form-label">{t('settings.serverUrl.label')}</label>
                        <input
                            type="text"
                            value={serverUrl}
                            onChange={(e) => setServerUrl(e.target.value)}
                            placeholder={t('settings.serverUrl.placeholder')}
                            required
                        />
                        <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '0.25rem', fontSize: '0.8125rem' }}>
                            {t('settings.serverUrl.hint')}
                        </small>
                    </div>

                    <div className="form-group">
                        <label className="form-label">{t('settings.websocketUrl.label')}</label>
                        <input
                            type="text"
                            value={wsUrl}
                            onChange={(e) => setWsUrl(e.target.value)}
                            placeholder={t('settings.websocketUrl.placeholder')}
                            required
                        />
                        <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '0.25rem', fontSize: '0.8125rem' }}>
                            {t('settings.websocketUrl.hint')}
                        </small>
                    </div>

                    {supportsCaptureProtection && (
                        <>
                            <div style={{
                                marginTop: '2rem',
                                marginBottom: '1rem',
                                paddingTop: '1.5rem',
                                borderTop: '1px solid var(--border)'
                            }}>
                                <h3 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 600 }}>
                                    {t('settings.privacy.title')}
                                </h3>

                                <div className="form-group">
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={hideFromCapture}
                                            onChange={(e) => setHideFromCapture(e.target.checked)}
                                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                        />
                                        <div>
                                            <div style={{ fontWeight: 500 }}>
                                                {t('settings.privacy.hideFromCapture.label')}
                                            </div>
                                            <small style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                                                {t('settings.privacy.hideFromCapture.hint')}
                                            </small>
                                        </div>
                                    </label>
                                </div>

                                <div className="form-group">
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={hideFromTaskbar}
                                            onChange={(e) => setHideFromTaskbar(e.target.checked)}
                                            style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                                        />
                                        <div>
                                            <div style={{ fontWeight: 500 }}>
                                                {t('settings.privacy.hideFromTaskbar.label')}
                                            </div>
                                            <small style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                                                {t('settings.privacy.hideFromTaskbar.hint')}
                                            </small>
                                        </div>
                                    </label>
                                </div>

                                <div style={{
                                    padding: '0.75rem',
                                    background: 'var(--bg-elevated)',
                                    borderRadius: '4px',
                                    border: '1px solid var(--border)',
                                    fontSize: '0.8125rem',
                                    color: 'var(--text-secondary)'
                                }}>
                                    {t('settings.privacy.note')}
                                </div>
                            </div>
                        </>
                    )}

                    {testResult && (
                        <div style={{
                            padding: '0.75rem',
                            marginBottom: '1rem',
                            borderRadius: '4px',
                            background: testResult.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            color: testResult.success ? 'var(--success)' : 'var(--danger)',
                            border: `1px solid ${testResult.success ? 'var(--success)' : 'var(--danger)'}`,
                            fontSize: '0.875rem'
                        }}>
                            {testResult.message}
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testing}
                        className="btn-secondary"
                        style={{ width: '100%', marginBottom: '0.5rem' }}
                    >
                        {testing ? t('settings.testing') : t('settings.testConnection')}
                    </button>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button type="submit" style={{ flex: 1 }}>
                            {t('settings.saveSettings')}
                        </button>
                        <button
                            type="button"
                            onClick={handleReset}
                            className="btn-secondary"
                            style={{ flex: 1 }}
                        >
                            {t('settings.resetToDefault')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}
