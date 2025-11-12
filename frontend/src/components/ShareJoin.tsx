import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { fetchShareInfo, joinShare } from '../lib/shareApi'
import { useShareSession } from '../contexts/ShareSessionContext'

export function ShareJoin({ onJoined }: { onJoined?: () => void }) {
    const { shareToken, session, setSession, clearSession, refreshSession } = useShareSession()
    const [isLoading, setIsLoading] = useState(true)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [username, setUsername] = useState(session?.guest.displayName ?? '')
    const [email, setEmail] = useState(session?.guest.email ?? '')
    const [error, setError] = useState('')
    const [infoError, setInfoError] = useState('')
    const [shareInfo, setShareInfo] = useState<{
        canEdit: boolean
        effectiveCanEdit: boolean
    } | null>(null)
    const [roomInfo, setRoomInfo] = useState<{
        name: string
        language: string
        isEnded?: boolean
    } | null>(null)
    const navigate = useNavigate()
    const { t } = useTranslation()

    useEffect(() => {
        let isMounted = true

        const loadShareInfo = async () => {
            try {
                const { share, room } = await fetchShareInfo(shareToken)
                if (!isMounted) return
                setShareInfo({
                    canEdit: share.canEdit,
                    effectiveCanEdit: share.effectiveCanEdit,
                })
                setRoomInfo({
                    name: room.name,
                    language: room.language,
                    isEnded: room.isEnded,
                })
            } catch (err) {
                if (!isMounted) return
                console.error('Failed to load share info', err)
                setInfoError(err instanceof Error ? err.message : 'Failed to load share info')
            } finally {
                if (isMounted) setIsLoading(false)
            }
        }

        loadShareInfo()

        return () => {
            isMounted = false
        }
    }, [shareToken])

    const sessionRefreshTokenRef = useRef<string | null>(null)

    useEffect(() => {
        if (!session) return
        if (sessionRefreshTokenRef.current === session.authToken) return
        sessionRefreshTokenRef.current = session.authToken
        refreshSession().catch((err) => {
            console.error('Failed to refresh share session', err)
        })
    }, [session, refreshSession])

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()

        if (!username.trim()) {
            setError(t('share.join.validationName'))
            return
        }

        setIsSubmitting(true)
        setError('')

        try {
            const response = await joinShare(shareToken, {
                username,
                email: email.trim() ? email.trim() : undefined,
            })

            setSession({
                shareToken,
                authToken: response.token,
                guest: response.guest,
                room: response.room,
            })

            // If onJoined callback is provided (when embedded), call it
            if (onJoined) {
                onJoined()
            } else {
                // Otherwise navigate to the new room route format
                navigate(`/room/${response.room.documentId}?share=${shareToken}`)
            }
        } catch (err) {
            console.error('Failed to join shared room', err)
            setError(err instanceof Error ? err.message : 'Failed to join shared room')
        } finally {
            setIsSubmitting(false)
        }
    }

    if (isLoading) {
        return (
            <div className="auth-container">
                <div className="card">
                    <h2>{t('share.join.title')}</h2>
                    <p style={{ color: 'var(--text-secondary)' }}>{t('share.join.loading')}</p>
                </div>
            </div>
        )
    }

    if (infoError) {
        return (
            <div className="auth-container">
                <div className="card">
                    <h2>{t('share.join.title')}</h2>
                    <p style={{ color: 'var(--error)' }}>{infoError}</p>
                </div>
            </div>
        )
    }

    if (roomInfo?.isEnded) {
        return (
            <div className="auth-container">
                <div className="card">
                    <h2>{roomInfo.name}</h2>
                    <p style={{ color: 'var(--text-secondary)' }}>{t('share.join.ended')}</p>
                </div>
            </div>
        )
    }

    return (
        <div className="auth-container">
            <div className="card" style={{ maxWidth: '420px', width: '100%' }}>
                <h2>{roomInfo?.name ?? t('share.join.title')}</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                    {shareInfo?.effectiveCanEdit
                        ? t('share.join.descriptionEdit')
                        : t('share.join.descriptionView')}
                </p>

                {session && (
                    <div
                        style={{
                            background: 'var(--bg-elevated)',
                            padding: '0.75rem',
                            borderRadius: '8px',
                            marginBottom: '1rem',
                            border: '1px solid var(--border)',
                        }}
                    >
                        <strong>{t('share.join.existingSessionTitle')}</strong>
                        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                            {t('share.join.existingSessionDescription', {
                                name: session.guest.displayName,
                            })}
                        </p>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                            <button type="button" onClick={() => {
                                if (onJoined) {
                                    onJoined()
                                } else {
                                    navigate(`/room/${session.room.documentId}?share=${shareToken}`)
                                }
                            }}>
                                {t('share.join.resumeButton')}
                            </button>
                            <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => {
                                    clearSession()
                                    setUsername('')
                                    setEmail('')
                                }}
                            >
                                {t('share.join.resetButton')}
                            </button>
                        </div>
                    </div>
                )}

                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="share-username">
                            {t('share.join.nameLabel')}
                        </label>
                        <input
                            id="share-username"
                            type="text"
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder={t('share.join.namePlaceholder')}
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="share-email">
                            {t('share.join.emailLabel')}
                        </label>
                        <input
                            id="share-email"
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder={t('share.join.emailPlaceholder')}
                        />
                        <small style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                            {t('share.join.emailHint')}
                        </small>
                    </div>

                    {error && (
                        <div style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>
                            {error}
                        </div>
                    )}

                    <button type="submit" disabled={isSubmitting}>
                        {isSubmitting ? t('share.join.joining') : t('share.join.joinButton')}
                    </button>
                </form>
            </div>
        </div>
    )
}
