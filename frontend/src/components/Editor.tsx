import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as Y from 'yjs'
import type * as Monaco from 'monaco-editor'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useShareSession } from '../contexts/ShareSessionContext'
import { useYjsProvider } from '../hooks/useYjsProvider'
import { ThemeToggle } from './ThemeToggle'
import { LanguageSwitcher } from './LanguageSwitcher'
import { ConnectedIcon, DisconnectedIcon, SyncedIcon, SyncingIcon } from './StatusIcons'
import { api } from '../lib/api'
import type { Room, RemoteUser, Language } from '../types'
import { ShareLinkManager } from './ShareLinkManager'
import { createPortal } from 'react-dom'
import 'monaco-editor/min/vs/editor/editor.main.css'
import { MonacoBinding } from '../lib/MonacoBinding'
import { loadMonaco } from '../lib/monacoLoader'

interface UserColorScheme {
    color: string
    colorLight: string
}

const generateUserColorScheme = (identifier: string | number | undefined): UserColorScheme => {
    const key = String(identifier ?? 'anonymous')
    let hash = 0

    for (let i = 0; i < key.length; i += 1) {
        hash = (hash << 5) - hash + key.charCodeAt(i)
        hash |= 0
    }

    const hue = Math.abs(hash) % 360
    const saturation = 78
    const baseLightness = 52
    const highlightLightness = Math.min(baseLightness + 20, 88)

    return {
        color: `hsl(${hue}, ${saturation}%, ${baseLightness}%)`,
        colorLight: `hsla(${hue}, ${saturation}%, ${highlightLightness}%, 0.35)`,
    }
}

const LANGUAGES: Language[] = [
    'javascript',
    'typescript',
    'python',
    'java',
    'cpp',
    'rust',
    'go',
    'php',
]

const monacoLanguageIds: Record<Language, string> = {
    javascript: 'javascript',
    typescript: 'typescript',
    python: 'python',
    java: 'java',
    cpp: 'cpp',
    rust: 'rust',
    go: 'go',
    php: 'php',
}

type MonacoModule = typeof import('monaco-editor')
type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModelInstance = Monaco.editor.ITextModel

const resolveMonacoLanguage = (language?: string) => {
    return monacoLanguageIds[language as Language] ?? 'javascript'
}

export function Editor() {
    const { roomId } = useParams<{ roomId: string }>()
    const { user, token } = useAuth()
    const { theme } = useTheme()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const shareToken = searchParams.get('share')

    // Try to access share session - will be undefined if not in ShareSessionProvider context
    let shareSession = null
    let isLoadingShare = false
    let refreshShareSession: (() => Promise<void>) | null = null
    try {
        const ctx = useShareSession()
        shareSession = ctx.session
        isLoadingShare = ctx.isLoading
        refreshShareSession = ctx.refreshSession
    } catch {
        // Not in a share context, that's fine
    }

    const isGuestMode = !!shareToken && !!shareSession
    const [room, setRoom] = useState<Room | null>(null)
    const [error, setError] = useState('')
    const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
    const [followingUser, setFollowingUser] = useState<number | null>(null)
    const [isChangingLanguage, setIsChangingLanguage] = useState(false)
    const [localUserColors, setLocalUserColors] = useState<UserColorScheme>(() =>
        generateUserColorScheme(user?.id)
    )
    const editorRef = useRef<HTMLDivElement>(null)
    const monacoRef = useRef<MonacoModule | null>(null)
    const monacoEditorRef = useRef<MonacoEditorInstance | null>(null)
    const monacoModelRef = useRef<MonacoModelInstance | null>(null)
    const monacoBindingRef = useRef<MonacoBinding | null>(null)
    const [isEditorReady, setIsEditorReady] = useState(false)
    const roomRef = useRef<Room | null>(null)
    const destroyMonacoEditor = useCallback(() => {
        monacoBindingRef.current?.destroy()
        monacoBindingRef.current = null
        monacoEditorRef.current?.dispose()
        monacoEditorRef.current = null
        monacoModelRef.current?.dispose()
        monacoModelRef.current = null
        setIsEditorReady(false)
    }, [])
    const [isShareModalOpen, setIsShareModalOpen] = useState(false)

    // Keep roomRef in sync with room state
    useEffect(() => {
        roomRef.current = room
    }, [room])

    // Load room from guest session if in guest mode
    useEffect(() => {
        if (!isGuestMode || !shareSession) return
        setRoom(shareSession.room as Room)
    }, [isGuestMode, shareSession])

    const refreshedShareTokenRef = useRef<string | null>(null)

    useEffect(() => {
        if (!isGuestMode || !shareSession?.authToken || !refreshShareSession) return
        if (refreshedShareTokenRef.current === shareSession.authToken) return
        refreshedShareTokenRef.current = shareSession.authToken
        refreshShareSession().catch((err) => {
            console.error('Failed to refresh share session', err)
        })
    }, [isGuestMode, shareSession?.authToken, refreshShareSession])

    // Load room details for authenticated users
    useEffect(() => {
        if (isGuestMode || !roomId) return

        const loadRoom = async () => {
            try {
                // roomId is now documentId, need to fetch room by documentId
                const { room } = await api.getRoomByDocumentId(roomId)
                setRoom(room)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load room')
            }
        }

        loadRoom()
    }, [roomId, isGuestMode])

    // Determine document ID and auth token based on mode
    // roomId in the URL is now the documentId
    const documentId = roomId || ''
    const authToken = isGuestMode
        ? (shareSession?.authToken || '')
        : (token || '')

    // Only create provider once we have the room data
    const { provider, ydoc, ytext, isConnected, isSynced } = useYjsProvider(
        documentId,
        authToken
    )

    const hasPrivilegedRole = !isGuestMode && (user?.role === 'admin' || user?.role === 'superuser')
    const isOwner = !isGuestMode && room?.ownerId === user?.id
    const canAccessPlayback = !!room && (isOwner || hasPrivilegedRole)

    useEffect(() => {
        if (!room?.isEnded) return
        if (canAccessPlayback) {
            navigate(`/playback/${room.id}`, { replace: true })
        }
        // For guests and non-privileged users, stay on page to show ended message
        // The render logic below will handle displaying the ended UI
    }, [room?.isEnded, room?.id, canAccessPlayback, navigate])

    useEffect(() => {
        return () => {
            destroyMonacoEditor()
        }
        // Only destroy when documentId changes, not when destroyMonacoEditor changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId])

    useEffect(() => {
        if (!provider?.awareness) return

        const identifier = isGuestMode
            ? (shareSession?.guest.id ?? provider.awareness.clientID)
            : (user?.id ?? provider.awareness.clientID)
        const colors = generateUserColorScheme(identifier)

        const userName = isGuestMode
            ? (shareSession?.guest.displayName || 'Guest')
            : (user?.username || 'Anonymous')

        provider.awareness.setLocalStateField('user', {
            id: identifier,
            name: userName,
            color: colors.color,
            colorLight: colors.colorLight,
        })

        setLocalUserColors((prev) =>
            prev.color === colors.color && prev.colorLight === colors.colorLight ? prev : colors
        )
    }, [provider, isGuestMode, user?.id, user?.username, shareSession?.guest])

    // Initialize Monaco editor once we have the provider + room
    useEffect(() => {
        if (!editorRef.current || !provider || !room || monacoEditorRef.current) return
        if (room.isEnded && !canAccessPlayback) return

        let isCancelled = false

        loadMonaco()
            .then((monaco) => {
                if (isCancelled || !editorRef.current) return
                monacoRef.current = monaco

                const languageId = resolveMonacoLanguage(room.language)
                const model = monaco.editor.createModel(ytext.toString(), languageId)
                model.setEOL(monaco.editor.EndOfLineSequence.LF)
                monacoModelRef.current = model

                const editor = monaco.editor.create(editorRef.current, {
                    model,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    wrappingStrategy: 'advanced',
                    scrollBeyondLastLine: false,
                    fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, "Liberation Mono", monospace',
                    fontSize: 14,
                    theme: theme === 'dark' ? 'vs-dark' : 'vs',
                    readOnly: isGuestMode && !shareSession?.guest.canEdit,
                })
                monacoEditorRef.current = editor

                editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
                    () => {
                        editor.getAction('actions.find')?.run()
                    }
                )

                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketRight, () => {
                    editor.getAction('editor.action.indentLines')?.run()
                })

                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketLeft, () => {
                    editor.getAction('editor.action.outdentLines')?.run()
                })

                monacoBindingRef.current = new MonacoBinding(
                    monaco,
                    ytext,
                    model,
                    new Set([editor]),
                    provider.awareness ?? null
                )

                editor.focus()
                setIsEditorReady(true)
            })
            .catch((err) => {
                console.error('Failed to initialize Monaco editor', err)
                setError(err instanceof Error ? err.message : 'Failed to initialize editor')
            })

        return () => {
            isCancelled = true
        }
    }, [provider, room, ytext, theme, isGuestMode, shareSession?.guest?.canEdit, canAccessPlayback])

    useEffect(() => {
        const container = editorRef.current
        if (!container || !isEditorReady) return

        const focusEditor = () => {
            monacoEditorRef.current?.focus()
        }

        container.addEventListener('mousedown', focusEditor)

        return () => {
            container.removeEventListener('mousedown', focusEditor)
        }
    }, [isEditorReady])

    // Update Monaco theme when toggled
    useEffect(() => {
        if (!monacoRef.current) return
        monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }, [theme])

    useEffect(() => {
        if (!monacoEditorRef.current) return
        const readOnly = isGuestMode && !shareSession?.guest.canEdit
        monacoEditorRef.current.updateOptions({ readOnly })
    }, [isGuestMode, shareSession?.guest?.canEdit])

    // Track remote users via awareness
    useEffect(() => {
        if (!provider?.awareness) return

        const updateRemoteUsers = () => {
            if (!provider.awareness) return
            const users: RemoteUser[] = []
            provider.awareness.getStates().forEach((state: any, clientId: number) => {
                if (provider.awareness && clientId !== provider.awareness.clientID && state.user) {
                    const identifier = state.user.id ?? state.user.name ?? clientId
                    const colors =
                        state.user.color && state.user.colorLight
                            ? { color: state.user.color, colorLight: state.user.colorLight }
                            : generateUserColorScheme(identifier)

                    users.push({
                        clientId,
                        username: state.user.name,
                        color: colors.color,
                        colorLight: colors.colorLight,
                        cursor: state.cursor,
                    })
                }
            })
            setRemoteUsers(users)
        }

        provider.awareness.on('change', updateRemoteUsers)
        updateRemoteUsers()

        return () => {
            if (provider.awareness) {
                provider.awareness.off('change', updateRemoteUsers)
            }
        }
    }, [provider])

    // Follow user feature
    useEffect(() => {
        if (!followingUser || !provider?.awareness) return
        if (!monacoRef.current || !monacoEditorRef.current || !monacoModelRef.current) return

        const scrollToUser = () => {
            if (!provider.awareness) return
            const state = provider.awareness.getStates().get(followingUser)
            if (!state?.cursor?.head) return

            try {
                const absolutePos = Y.createAbsolutePositionFromRelativePosition(state.cursor.head, ydoc)
                if (!absolutePos || absolutePos.type !== ytext) return
                const position = monacoModelRef.current!.getPositionAt(absolutePos.index)
                monacoEditorRef.current!.revealPositionInCenter(
                    position,
                    monacoRef.current!.editor.ScrollType.Smooth
                )
                monacoEditorRef.current!.setPosition(position)
            } catch (err) {
                console.error('Error following user:', err)
            }
        }

        scrollToUser()
        provider.awareness.on('change', scrollToUser)

        return () => {
            provider.awareness?.off('change', scrollToUser)
        }
    }, [followingUser, provider, ydoc, ytext])

    // Redirect guest to join page if session expired
    if (isGuestMode && !isLoadingShare && !shareSession) {
        // Session expired, redirect to login or show error
        return (
            <div style={{ padding: '20px' }}>
                <div style={{ color: 'red' }}>Your session has expired. Please refresh the page to rejoin.</div>
            </div>
        )
    }

    if (!roomId) {
        return <div>Room ID not provided</div>
    }

    const backPath = '/rooms'

    if (error) {
        return (
            <div style={{ padding: '20px' }}>
                <div style={{ color: 'red' }}>{error}</div>
                <button onClick={() => navigate(backPath)}>
                    {t('common.back')}
                </button>
            </div>
        )
    }

    // Reconfigure editor with new language extension
    const reconfigureLanguage = (newLanguage: Language) => {
        if (!monacoRef.current || !monacoModelRef.current) return
        const languageId = resolveMonacoLanguage(newLanguage)
        monacoRef.current.editor.setModelLanguage(monacoModelRef.current, languageId)
    }

    const handleLanguageChange = async (newLanguage: Language) => {
        if (!roomId || !room || !provider) return

        setIsChangingLanguage(true)
        try {
            // Update database - use room.id not documentId
            await api.updateRoom(room.id, { language: newLanguage })

            // Update local room state
            setRoom({ ...room, language: newLanguage })

            // Broadcast language change via awareness
            provider.awareness?.setLocalStateField('roomLanguage', newLanguage)

            // Reconfigure local editor (no reload needed!)
            reconfigureLanguage(newLanguage)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to change language')
        } finally {
            setIsChangingLanguage(false)
        }
    }

    // Listen for room updates (language/status) via awareness
    useEffect(() => {
        if (!provider?.awareness || !roomRef.current) return

        const handleAwarenessUpdate = () => {
            if (!provider.awareness || !roomRef.current) return

            let nextLanguage: Language | null = null
            let ended = false
            let endedAt: string | null = null

            provider.awareness.getStates().forEach((state: any) => {
                if (!state) return

                // Listen to language changes from any user (not just owner)
                // The owner is the one who can change it, so we trust the broadcast
                if (state.roomLanguage) {
                    nextLanguage = state.roomLanguage
                }

                if (state.roomStatus === 'ended') {
                    ended = true
                    if (typeof state.roomEndedAt === 'string') {
                        endedAt = state.roomEndedAt
                    }
                }
            })

            if (nextLanguage && roomRef.current && nextLanguage !== roomRef.current.language) {
                setRoom((prevRoom) => {
                    if (!prevRoom || prevRoom.language === nextLanguage) return prevRoom
                    return { ...prevRoom, language: nextLanguage as Language }
                })
                reconfigureLanguage(nextLanguage)
            }

            if (ended) {
                setRoom((prevRoom) => {
                    if (!prevRoom || prevRoom.isEnded) return prevRoom
                    return {
                        ...prevRoom,
                        isEnded: true,
                        endedAt: endedAt ?? prevRoom.endedAt ?? new Date().toISOString(),
                    }
                })
            }
        }

        provider.awareness.on('change', handleAwarenessUpdate)
        handleAwarenessUpdate()

        return () => {
            if (provider.awareness) {
                provider.awareness.off('change', handleAwarenessUpdate)
            }
        }
        // Only depend on provider to avoid infinite loop
        // room is accessed via roomRef which is always current
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider])

    // Keep awareness in sync once the room ends so late listeners receive the signal
    useEffect(() => {
        if (!provider?.awareness) return
        if (!room?.isEnded) return

        provider.awareness.setLocalStateField('roomStatus', 'ended')
        if (room.endedAt) {
            provider.awareness.setLocalStateField('roomEndedAt', room.endedAt)
        }
    }, [provider, room?.isEnded, room?.endedAt])

    const currentUserName = isGuestMode
        ? (shareSession?.guest.displayName || 'Guest')
        : (user?.username || 'You')

    useEffect(() => {
        if (typeof document === 'undefined') return
        const previousOverflow = document.body.style.overflow
        if (isShareModalOpen) {
            document.body.style.overflow = 'hidden'
            return () => {
                document.body.style.overflow = previousOverflow
            }
        }
        document.body.style.overflow = previousOverflow
    }, [isShareModalOpen])

    if (!room) {
        return <div style={{ padding: '20px' }}>{t('common.loading')}</div>
    }

    if (room.isEnded && !canAccessPlayback) {
        const endedAtLabel = room.endedAt ? new Date(room.endedAt).toLocaleString() : null

        return (
            <div className="editor-container">
                <div className="editor-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <button
                            className="toolbar-button"
                            onClick={() => navigate(backPath)}
                        >
                            ← {t('common.back')}
                        </button>
                        <span style={{ fontWeight: 600, fontSize: '1rem' }}>{room.name}</span>
                        <span className="language-badge">{room.language}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <LanguageSwitcher />
                        <ThemeToggle />
                    </div>
                </div>

                <div className="editor-ended">
                    <div className="editor-ended-card">
                        <div className="editor-ended-icon" aria-hidden="true">
                            <span>⏹</span>
                        </div>
                        <h2>{t('editor.ended.title')}</h2>
                        <p className="editor-ended-subtitle">
                            {t('editor.ended.subtitle')}
                        </p>
                        <p className="editor-ended-description">
                            {t('editor.ended.description')}
                        </p>
                        {endedAtLabel && (
                            <p className="editor-ended-meta">
                                {t('editor.ended.endedAt', { time: endedAtLabel })}
                            </p>
                        )}
                        <div className="editor-ended-actions">
                            <button
                                type="button"
                                className="toolbar-button"
                                onClick={() => navigate(backPath)}
                            >
                                {t('editor.ended.back')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="editor-container">
            {/* Header */}
            <div className="editor-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button
                        className="toolbar-button"
                        onClick={() => navigate(backPath)}
                    >
                        ← {t('common.back')}
                    </button>
                    <span style={{ fontWeight: 600, fontSize: '1rem' }}>{room.name}</span>
                    {isOwner ? (
                        <select
                            className="toolbar-select"
                            value={room.language}
                            onChange={(e) => handleLanguageChange(e.target.value as Language)}
                            disabled={isChangingLanguage}
                        >
                            {LANGUAGES.map((lang) => (
                                <option key={lang} value={lang}>
                                    {lang}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className="language-badge">{room.language}</span>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {isOwner && !room.isEnded && (
                        <button
                            className="btn-secondary"
                            onClick={(event) => {
                                event.preventDefault()
                                setIsShareModalOpen(true)
                            }}
                        >
                            {t('share.manager.openPanel')}
                        </button>
                    )}
                    {isOwner && !room.isEnded && (
                        <button
                            className="btn-danger"
                            onClick={async (e) => {
                                e.preventDefault()
                                if (confirm(t('editor.toolbar.endRoom') + '?')) {
                                    try {
                                        // Use room.id not documentId
                                        const { room: endedRoom } = await api.endRoom(room.id)

                                        // Update local state first
                                        setRoom(endedRoom)

                                        // Broadcast to other users
                                        provider?.awareness?.setLocalStateField('roomStatus', 'ended')
                                        provider?.awareness?.setLocalStateField(
                                            'roomEndedAt',
                                            endedRoom?.endedAt ?? new Date().toISOString()
                                        )

                                        // Then navigate
                                        navigate('/rooms')
                                    } catch (err) {
                                        setError(err instanceof Error ? err.message : 'Failed to end room')
                                    }
                                }
                            }}
                        >
                            {t('editor.toolbar.endRoom')}
                        </button>
                    )}
                    <LanguageSwitcher />
                    <ThemeToggle />
                </div>
            </div>

            {/* Editor */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <div ref={editorRef} style={{ height: '100%' }} />
            </div>

            {/* Bottom Status Bar with Users */}
            <div className="status-bar">
                <div className="status-users">
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                        {t('editor.toolbar.users')} ({remoteUsers.length + 1}):
                    </span>
                    <div className="user-list-inline">
                        {/* Current user */}
                        <div
                            className="user-badge"
                            style={{
                                border: `1px solid ${localUserColors.color}`,
                                backgroundColor: localUserColors.colorLight,
                            }}
                        >
                            <div className="user-dot" style={{ backgroundColor: localUserColors.color }} />
                            <span style={{ fontWeight: 600 }}>{currentUserName}</span>
                        </div>

                        {/* Remote users */}
                        {remoteUsers.map((remoteUser) => (
                            <div
                                key={remoteUser.clientId}
                                className="user-badge"
                                style={{
                                    cursor: 'pointer',
                                    border: `1px solid ${remoteUser.color}`,
                                    backgroundColor:
                                        followingUser === remoteUser.clientId
                                            ? remoteUser.color
                                            : remoteUser.colorLight,
                                    boxShadow:
                                        followingUser === remoteUser.clientId
                                            ? `0 0 0 2px ${remoteUser.colorLight}`
                                            : 'none',
                                    color: followingUser === remoteUser.clientId ? '#ffffff' : 'var(--text-primary)',
                                }}
                                onClick={() =>
                                    setFollowingUser(
                                        followingUser === remoteUser.clientId ? null : remoteUser.clientId
                                    )
                                }
                                title={
                                    followingUser === remoteUser.clientId
                                        ? t('editor.toolbar.following')
                                        : t('editor.toolbar.follow')
                                }
                            >
                                <div className="user-dot" style={{ backgroundColor: remoteUser.color }} />
                                <span
                                    style={{
                                        fontWeight: followingUser === remoteUser.clientId ? 600 : 400,
                                    }}
                                >
                                    {remoteUser.username}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="status-indicators">
                    <div
                        className="status-badge"
                        style={{ color: isConnected ? 'var(--success)' : 'var(--danger)' }}
                    >
                        {isConnected ? <ConnectedIcon /> : <DisconnectedIcon />}
                        <span>{isConnected ? t('editor.status.connected') : t('editor.status.disconnected')}</span>
                    </div>
                    <div className="status-badge" style={{ color: 'var(--accent)' }}>
                        {isSynced ? <SyncedIcon /> : <SyncingIcon />}
                        <span>{isSynced ? t('editor.status.synced') : t('editor.status.syncing')}</span>
                    </div>
                </div>
            </div>

            {isShareModalOpen && typeof document !== 'undefined' && createPortal(
                <div
                    className="modal-overlay"
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.75)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '1rem',
                    }}
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setIsShareModalOpen(false)
                        }
                    }}
                >
                    <div
                        className="modal-content"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            borderRadius: '6px',
                            width: 'min(720px, 100%)',
                            maxHeight: '85vh',
                            overflowY: 'auto',
                            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
                            border: '1px solid var(--border)',
                            position: 'relative',
                            zIndex: 10001,
                            padding: '1.5rem',
                        }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <ShareLinkManager
                            roomId={room.id}
                            onClose={() => setIsShareModalOpen(false)}
                        />
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}
