import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { LanguageSwitcher } from './LanguageSwitcher'

export function Login() {
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const { login } = useAuth()
    const navigate = useNavigate()
    const { t } = useTranslation()

    // Check if running in Tauri desktop environment
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

    // Check if registration is allowed (build-time environment variable)
    const ALLOW_REGISTRATION = import.meta.env.VITE_ALLOW_REGISTRATION !== 'false'

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            await login(username, password)
            navigate('/rooms')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="auth-container">
            <div className="auth-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <h2>{t('auth.login.title')}</h2>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {isTauri && (
                            <button
                                type="button"
                                onClick={() => navigate('/settings')}
                                className="theme-toggle"
                                title="Settings"
                            >
                                <Settings size={24} strokeWidth={2} />
                            </button>
                        )}
                        <LanguageSwitcher />
                        <ThemeToggle />
                    </div>
                </div>
                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">{t('auth.login.username')}</label>
                        <input
                            type="text"
                            placeholder={t('auth.login.usernamePlaceholder')}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">{t('auth.login.password')}</label>
                        <input
                            type="password"
                            placeholder={t('auth.login.passwordPlaceholder')}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    {error && <div className="error-message">{error}</div>}
                    <button type="submit" disabled={isLoading}>
                        {isLoading ? t('auth.login.loggingIn') : t('auth.login.button')}
                    </button>
                </form>
                {ALLOW_REGISTRATION && (
                    <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--text-secondary)' }}>
                        {t('auth.login.noAccount')}{' '}
                        <button
                            type="button"
                            onClick={() => navigate('/register')}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--accent)',
                                textDecoration: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                font: 'inherit'
                            }}
                        >
                            {t('auth.login.registerLink')}
                        </button>
                    </p>
                )}
            </div>
        </div>
    )
}
