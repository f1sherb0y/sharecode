import { useEffect, useRef, useState, useContext } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, StateEffect } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { yCollab, yUndoManagerKeymap, YSyncConfig } from 'y-codemirror.next'
import { oneDark } from '@codemirror/theme-one-dark'
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

const languageExtensions: Record<string, any> = {
    javascript: javascript(),
    typescript: javascript({ typescript: true }),
    python: python(),
    java: java(),
    cpp: cpp(),
    rust: rust(),
    go: go(),
    php: php(),
}

export function Editor() {
    const { roomId, shareToken } = useParams<{ roomId?: string; shareToken?: string }>()
    const { user, token } = useAuth()
    const { theme } = useTheme()
    const { t } = useTranslation()
    const navigate = useNavigate()

    // Try to access share session - will be undefined if not in ShareSessionProvider context
    let shareSession = null
    let isLoadingShare = false
    try {
        const ctx = useShareSession()
        shareSession = ctx.session
        isLoadingShare = ctx.isLoading
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
    const viewRef = useRef<EditorView | null>(null)
    const ySyncConfigRef = useRef<YSyncConfig | null>(null)
    const [isShareModalOpen, setIsShareModalOpen] = useState(false)

    // Load room from guest session if in guest mode
    useEffect(() => {
        if (!isGuestMode || !shareSession) return
        setRoom(shareSession.room as Room)
    }, [isGuestMode, shareSession])

    // Load room details for authenticated users
    useEffect(() => {
        if (isGuestMode || !roomId) return

        const loadRoom = async () => {
            try {
                const { room } = await api.getRoom(roomId)
                setRoom(room)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load room')
            }
        }

        loadRoom()
    }, [roomId, isGuestMode])

    // Determine document ID and auth token based on mode
    const documentId = isGuestMode
        ? (shareSession?.room.documentId || '')
        : (room?.documentId || '')
    const authToken = isGuestMode
        ? (shareSession?.authToken || '')
        : (token || '')

    // Only create provider once we have the room data
    const { provider, ytext, isConnected, isSynced } = useYjsProvider(
        documentId,
        authToken
    )

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

    // Set up CodeMirror editor (only once)
    useEffect(() => {
        if (!editorRef.current || !provider || !room || viewRef.current) return

        // Create YSyncConfig for position conversion
        const ySyncConfig = new YSyncConfig(ytext, provider.awareness)
        ySyncConfigRef.current = ySyncConfig

        const languageExt = languageExtensions[room.language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        // Check if guest mode and no edit permission
        const readOnly = isGuestMode && !shareSession?.guest.canEdit

        const extensions = [
            keymap.of([...yUndoManagerKeymap, indentWithTab]),
            basicSetup,
            languageExt,
            ...themeExt,
            EditorView.lineWrapping,
            yCollab(ytext, provider.awareness),
        ]

        if (readOnly) {
            extensions.push(EditorState.readOnly.of(true))
        }

        const state = EditorState.create({
            doc: ytext.toString(),
            extensions,
        })

        const view = new EditorView({
            state,
            parent: editorRef.current,
        })

        viewRef.current = view

        return () => {
            view.destroy()
            viewRef.current = null
        }
    }, [provider, room, ytext])

    // Update theme when it changes (using reconfigure, not recreating editor)
    useEffect(() => {
        if (!viewRef.current || !room || !provider) return

        const languageExt = languageExtensions[room.language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        viewRef.current.dispatch({
            effects: StateEffect.reconfigure.of([
                keymap.of([...yUndoManagerKeymap, indentWithTab]),
                basicSetup,
                languageExt,
                ...themeExt,
                EditorView.lineWrapping,
                yCollab(ytext, provider.awareness),
            ]),
        })
    }, [theme])

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
        if (!followingUser || !provider?.awareness || !viewRef.current || !ySyncConfigRef.current) return

        const handleAwarenessChange = () => {
            if (!provider.awareness || !viewRef.current || !ySyncConfigRef.current) return

            const state = provider.awareness.getStates().get(followingUser)
            if (state?.cursor?.head) {
                try {
                    // Convert Yjs relative position to absolute position
                    const absolutePos = ySyncConfigRef.current.fromYPos(state.cursor.head)

                    // Scroll to the followed user's cursor
                    viewRef.current.dispatch({
                        effects: EditorView.scrollIntoView(absolutePos.pos, { y: 'center' }),
                    })
                } catch (err) {
                    console.error('Error following user:', err)
                }
            }
        }

        // Trigger immediately on follow
        handleAwarenessChange()

        // Then listen for changes
        provider.awareness.on('change', handleAwarenessChange)

        return () => {
            if (provider.awareness) {
                provider.awareness.off('change', handleAwarenessChange)
            }
        }
    }, [followingUser, provider])

    // Redirect guest to join page if session expired
    if (isGuestMode && !isLoadingShare && !shareSession) {
        return <Navigate to={`/share/${shareToken}`} replace />
    }

    if (!roomId && !isGuestMode) {
        return <div>Room ID not provided</div>
    }

    if (error) {
        return (
            <div style={{ padding: '20px' }}>
                <div style={{ color: 'red' }}>{error}</div>
                <button onClick={() => navigate(isGuestMode ? `/share/${shareToken}` : '/rooms')}>
                    {t('common.back')}
                </button>
            </div>
        )
    }

    // Reconfigure editor with new language extension
    const reconfigureLanguage = (newLanguage: Language) => {
        if (!viewRef.current || !provider) return

        const languageExt = languageExtensions[newLanguage] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        viewRef.current.dispatch({
            effects: StateEffect.reconfigure.of([
                keymap.of([...yUndoManagerKeymap, indentWithTab]),
                basicSetup,
                languageExt,
                ...themeExt,
                EditorView.lineWrapping,
                yCollab(ytext, provider.awareness),
            ]),
        })
    }

    const handleLanguageChange = async (newLanguage: Language) => {
        if (!roomId || !room || !provider) return

        setIsChangingLanguage(true)
        try {
            // Update database
            await api.updateRoom(roomId, { language: newLanguage })

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

    // Listen for language changes from owner via awareness
    useEffect(() => {
        if (!provider?.awareness || !room) return

        const handleLanguageUpdate = () => {
            if (!provider.awareness) return

            // Find the owner's awareness state
            provider.awareness.getStates().forEach((state: any) => {
                if (state.user && state.roomLanguage && state.roomLanguage !== room.language) {
                    // Owner changed the language
                    console.log(`Language changed to ${state.roomLanguage} by owner`)
                    setRoom({ ...room, language: state.roomLanguage })
                    reconfigureLanguage(state.roomLanguage)
                }
            })
        }

        provider.awareness.on('change', handleLanguageUpdate)

        return () => {
            if (provider.awareness) {
                provider.awareness.off('change', handleLanguageUpdate)
            }
        }
    }, [provider, room])

    const isOwner = !isGuestMode && room?.ownerId === user?.id
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

    return (
        <div className="editor-container">
            {/* Header */}
            <div className="editor-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button
                        className="toolbar-button"
                        onClick={() => navigate(isGuestMode ? `/share/${shareToken}` : '/rooms')}
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
                                        await api.endRoom(roomId!)
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
