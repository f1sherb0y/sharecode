import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, StateEffect } from '@codemirror/state'
import { keymap } from '@codemirror/view'
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
import { useYjsProvider } from '../hooks/useYjsProvider'
import { ThemeToggle } from './ThemeToggle'
import { ConnectedIcon, DisconnectedIcon, SyncedIcon, SyncingIcon } from './StatusIcons'
import { api } from '../lib/api'
import type { Room, RemoteUser, Language } from '../types'

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
    const { roomId } = useParams<{ roomId: string }>()
    const { user, token } = useAuth()
    const { theme } = useTheme()
    const navigate = useNavigate()
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

    // Load room details first
    useEffect(() => {
        if (!roomId) return

        const loadRoom = async () => {
            try {
                const { room } = await api.getRoom(roomId)
                setRoom(room)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load room')
            }
        }

        loadRoom()
    }, [roomId])

    // Only create provider once we have the room data
    const { provider, ytext, isConnected, isSynced } = useYjsProvider(
        room?.documentId || '',
        token || ''
    )

    useEffect(() => {
        if (!provider?.awareness) return

        const identifier = user?.id ?? provider.awareness.clientID
        const colors = generateUserColorScheme(identifier)

        provider.awareness.setLocalStateField('user', {
            id: user?.id ?? provider.awareness.clientID,
            name: user?.username || 'Anonymous',
            color: colors.color,
            colorLight: colors.colorLight,
        })

        setLocalUserColors((prev) =>
            prev.color === colors.color && prev.colorLight === colors.colorLight ? prev : colors
        )
    }, [provider, user?.id, user?.username])

    // Set up CodeMirror editor
    useEffect(() => {
        if (!editorRef.current || !provider || !room) return

        // Create YSyncConfig for position conversion
        const ySyncConfig = new YSyncConfig(ytext, provider.awareness)
        ySyncConfigRef.current = ySyncConfig

        const languageExt = languageExtensions[room.language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
                keymap.of([...yUndoManagerKeymap]),
                basicSetup,
                languageExt,
                ...themeExt,
                EditorView.lineWrapping,
                yCollab(ytext, provider.awareness),
            ],
        })

        const view = new EditorView({
            state,
            parent: editorRef.current,
        })

        viewRef.current = view

        return () => {
            view.destroy()
        }
    }, [provider, room, ytext, theme])

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

    if (!roomId) {
        return <div>Room ID not provided</div>
    }

    if (error) {
        return (
            <div style={{ padding: '20px' }}>
                <div style={{ color: 'red' }}>{error}</div>
                <button onClick={() => navigate('/rooms')}>Back to Rooms</button>
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
                keymap.of([...yUndoManagerKeymap]),
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

    const isOwner = room?.ownerId === user?.id

    if (!room) {
        return <div style={{ padding: '20px' }}>Loading room...</div>
    }

    return (
        <div className="editor-container">
            {/* Header */}
            <div className="editor-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button className="toolbar-button" onClick={() => navigate('/rooms')}>
                        ← Back
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
                            className="toolbar-button"
                            onClick={async () => {
                                if (confirm('End this room? You can view playback afterwards.')) {
                                    try {
                                        await api.endRoom(roomId!)
                                        navigate('/rooms')
                                    } catch (err) {
                                        setError(err instanceof Error ? err.message : 'Failed to end room')
                                    }
                                }
                            }}
                            style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                        >
                            End Room
                        </button>
                    )}
                    <div
                        className="status-badge"
                        style={{ color: isConnected ? 'var(--success)' : 'var(--danger)' }}
                    >
                        {isConnected ? <ConnectedIcon /> : <DisconnectedIcon />}
                        <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
                    </div>
                    <div className="status-badge" style={{ color: 'var(--accent)' }}>
                        {isSynced ? <SyncedIcon /> : <SyncingIcon />}
                        <span>{isSynced ? 'Synced' : 'Syncing...'}</span>
                    </div>
                    <ThemeToggle />
                </div>
            </div>

            {/* Editor */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <div ref={editorRef} style={{ height: '100%' }} />
            </div>

            {/* Bottom Status Bar with Users */}
            <div className="status-bar">
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                    Users ({remoteUsers.length + 1}):
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
                        <span style={{ fontWeight: 600 }}>{user?.username || 'You'}</span>
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
                            title={`Click to ${followingUser === remoteUser.clientId ? 'stop following' : 'follow'} ${remoteUser.username}`}
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
        </div>
    )
}
