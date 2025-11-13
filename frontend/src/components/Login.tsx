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
    const [joinLink, setJoinLink] = useState('')
    const [joinLinkError, setJoinLinkError] = useState('')
    const [isJoining, setIsJoining] = useState(false)
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

    const parseShareLink = (link: string): { documentId: string; token: string } | null => {
        try {
            // Try to parse as URL
            const url = new URL(link)

            // Check for hash-based route format (Tauri): #/room/{documentId}?share={token}
            if (url.hash) {
                const hashMatch = url.hash.match(/#\/room\/([^?]+)\?share=([^&]+)/)
                if (hashMatch) {
                    return { documentId: hashMatch[1], token: hashMatch[2] }
                }
            }

            // Check for path-based route format (Web): /room/{documentId}?share={token}
            const pathMatch = url.pathname.match(/\/room\/([^/?]+)/)
            if (pathMatch) {
                const searchParams = new URLSearchParams(url.search)
                const shareToken = searchParams.get('share')
                if (shareToken) {
                    return { documentId: pathMatch[1], token: shareToken }
                }
            }

            return null
        } catch {
            // Not a valid URL
            return null
        }
    }

    const handleJoinLink = async (e: React.FormEvent) => {
        e.preventDefault()
        setJoinLinkError('')

        if (!joinLink.trim()) return

        setIsJoining(true)

        try {
            const parsed = parseShareLink(joinLink)

            if (!parsed) {
                setJoinLinkError(t('auth.login.joinLink.invalid'))
                return
            }

            // Navigate to room with share token
            navigate(`/room/${parsed.documentId}?share=${parsed.token}`)
        } catch (err) {
            setJoinLinkError(err instanceof Error ? err.message : 'Failed to parse link')
        } finally {
            setIsJoining(false)
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

                {isTauri && (
                    <>
                        <div style={{
                            margin: '2rem 0 1.5rem',
                            textAlign: 'center',
                            position: 'relative',
                            color: 'var(--text-secondary)'
                        }}>
                            <div style={{
                                position: 'absolute',
                                top: '50%',
                                left: 0,
                                right: 0,
                                height: '1px',
                                background: 'var(--border)',
                                zIndex: 0
                            }} />
                            <span style={{
                                position: 'relative',
                                background: 'var(--bg-card)',
                                padding: '0 1rem',
                                zIndex: 1,
                                fontSize: '0.875rem'
                            }}>
                                {t('auth.login.joinLink.title')}
                            </span>
                        </div>

                        <form onSubmit={handleJoinLink}>
                            <div className="form-group" style={{ marginBottom: '1rem' }}>
                                <label className="form-label">{t('auth.login.joinLink.label')}</label>
                                <input
                                    type="text"
                                    placeholder={t('auth.login.joinLink.placeholder')}
                                    value={joinLink}
                                    onChange={(e) => {
                                        setJoinLink(e.target.value)
                                        setJoinLinkError('')
                                    }}
                                />
                            </div>
                            {joinLinkError && <div className="error-message" style={{ marginBottom: '0.75rem' }}>{joinLinkError}</div>}
                            <button type="submit" disabled={isJoining || !joinLink.trim()}>
                                {isJoining ? t('auth.login.joinLink.joining') : t('auth.login.joinLink.button')}
                            </button>
                        </form>
                    </>
                )}
            </div>
        </div>
    )
}
