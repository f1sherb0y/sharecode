import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import type { ShareLink } from '../types'

interface ShareLinkManagerProps {
    roomId: string
    onClose: () => void
}

export function ShareLinkManager({ roomId, onClose }: ShareLinkManagerProps) {
    const { t } = useTranslation()
    const [links, setLinks] = useState<ShareLink[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isCreating, setIsCreating] = useState(false)
    const [error, setError] = useState('')
    const [info, setInfo] = useState('')

    const loadLinks = useCallback(async () => {
        try {
            setIsLoading(true)
            const { shareLinks } = await api.listShareLinks(roomId)
            setLinks(shareLinks)
        } catch (err) {
            console.error('Failed to load share links', err)
            setError(err instanceof Error ? err.message : 'Failed to load share links')
        } finally {
            setIsLoading(false)
        }
    }, [roomId])

    useEffect(() => {
        loadLinks()
    }, [loadLinks])

    const createLink = async (canEdit: boolean) => {
        try {
            setIsCreating(true)
            setError('')
            setInfo('')
            const { shareLink } = await api.createShareLink(roomId, canEdit)
            setLinks((prev) => [shareLink, ...prev])
            setInfo(t('share.manager.created'))
        } catch (err) {
            console.error('Failed to create share link', err)
            setError(err instanceof Error ? err.message : 'Failed to create share link')
        } finally {
            setIsCreating(false)
        }
    }

    const deleteLink = async (shareLink: ShareLink) => {
        if (!confirm(t('share.manager.deleteConfirm'))) {
            return
        }

        try {
            await api.deleteShareLink(roomId, shareLink.id)
            setLinks((prev) => prev.filter((link) => link.id !== shareLink.id))
        } catch (err) {
            console.error('Failed to delete share link', err)
            setError(err instanceof Error ? err.message : 'Failed to delete share link')
        }
    }

    const copyLink = async (shareLink: ShareLink) => {
        const shareUrl = resolveShareUrl(shareLink.token, shareLink.shareUrl)
        try {
            await navigator.clipboard.writeText(shareUrl)
            setInfo(t('share.manager.copied'))
        } catch (err) {
            console.error('Failed to copy share link', err)
            setError(t('share.manager.copyFailed'))
        }
    }

    const resolvedLinks = useMemo(
        () =>
            links.map((link) => ({
                ...link,
                shareUrl: resolveShareUrl(link.token, link.shareUrl),
            })),
        [links]
    )

    return (
        <div className="card share-link-modal">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>{t('share.manager.title')}</h3>
                <button type="button" className="btn-secondary" onClick={onClose}>
                    {t('share.manager.close')}
                </button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                {t('share.manager.description')}
            </p>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => createLink(false)} disabled={isCreating}>
                    {t('share.manager.createView')}
                </button>
                <button type="button" onClick={() => createLink(true)} disabled={isCreating}>
                    {t('share.manager.createEdit')}
                </button>
            </div>

            {error && (
                <div style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>
                    {error}
                </div>
            )}
            {info && (
                <div style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>
                    {info}
                </div>
            )}

            {isLoading ? (
                <div style={{ color: 'var(--text-secondary)' }}>{t('share.manager.loading')}</div>
            ) : resolvedLinks.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)' }}>{t('share.manager.empty')}</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {resolvedLinks.map((link) => (
                        <div
                            key={link.id}
                            style={{
                                border: '1px solid var(--border)',
                                borderRadius: '6px',
                                padding: '0.75rem',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.5rem',
                                backgroundColor: 'var(--bg-secondary)',
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontWeight: 600 }}>
                                    {link.canEdit ? t('share.manager.editLabel') : t('share.manager.viewLabel')}
                                </span>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={() => copyLink(link)}
                                    >
                                        {t('share.manager.copy')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-danger"
                                        onClick={() => deleteLink(link)}
                                    >
                                        {t('share.manager.delete')}
                                    </button>
                                </div>
                            </div>
                            <div
                                style={{
                                    fontFamily: 'monospace',
                                    fontSize: '0.8125rem',
                                    wordBreak: 'break-all',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                {link.shareUrl}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                {t('share.manager.guests', { count: link.guestCount })}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

function resolveShareUrl(token: string, preferred?: string | null) {
    if (preferred) return preferred

    const useHashRoutes =
        typeof window !== 'undefined' &&
        ('__TAURI_INTERNALS__' in window || window.location.hash.startsWith('#/'))

    if (typeof window !== 'undefined') {
        const origin = window.location.origin.replace(/\/$/, '')
        return useHashRoutes ? `${origin}/#/share/${token}` : `${origin}/share/${token}`
    }

    return token
}
