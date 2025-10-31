import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { yCollab, yUndoManagerKeymap, YSyncConfig } from 'y-codemirror.next'
import { useAuth } from '../contexts/AuthContext'
import { useYjsProvider } from '../hooks/useYjsProvider'
import { api } from '../lib/api'
import type { Room, RemoteUser, Language } from '../types'

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
    const navigate = useNavigate()
    const [room, setRoom] = useState<Room | null>(null)
    const [error, setError] = useState('')
    const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
    const [followingUser, setFollowingUser] = useState<number | null>(null)
    const [isChangingLanguage, setIsChangingLanguage] = useState(false)
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

    // Set up CodeMirror editor
    useEffect(() => {
        if (!editorRef.current || !provider || !room) return

        const userColor = user?.color || '#30bced'
        const userColorLight = userColor + '33'

        // Create YSyncConfig for position conversion
        const ySyncConfig = new YSyncConfig(ytext, provider.awareness)
        ySyncConfigRef.current = ySyncConfig

        // Set awareness state
        provider.awareness?.setLocalStateField('user', {
            name: user?.username || 'Anonymous',
            color: userColor,
            colorLight: userColorLight,
        })

        const languageExt = languageExtensions[room.language] || javascript()

        const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
                keymap.of([...yUndoManagerKeymap]),
                basicSetup,
                languageExt,
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
    }, [provider, room, ytext, user])

    // Track remote users via awareness
    useEffect(() => {
        if (!provider?.awareness) return

        const updateRemoteUsers = () => {
            if (!provider.awareness) return
            const users: RemoteUser[] = []
            provider.awareness.getStates().forEach((state: any, clientId: number) => {
                if (provider.awareness && clientId !== provider.awareness.clientID && state.user) {
                    users.push({
                        clientId,
                        username: state.user.name,
                        color: state.user.color,
                        colorLight: state.user.colorLight,
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

    const handleLanguageChange = async (newLanguage: Language) => {
        if (!roomId || !room) return

        setIsChangingLanguage(true)
        try {
            await api.updateRoom(roomId, { language: newLanguage })
            // Update local room state
            setRoom({ ...room, language: newLanguage })
            // Reload to apply new language extension
            window.location.reload()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to change language')
        } finally {
            setIsChangingLanguage(false)
        }
    }

    const isOwner = room?.ownerId === user?.id

    if (!room) {
        return <div style={{ padding: '20px' }}>Loading room...</div>
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            {/* Header */}
            <div style={{ padding: '10px', borderBottom: '1px solid #ccc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <button onClick={() => navigate('/rooms')}>← Back to Rooms</button>
                    <span style={{ marginLeft: '20px', fontWeight: 'bold' }}>{room.name}</span>
                    {isOwner ? (
                        <select
                            value={room.language}
                            onChange={(e) => handleLanguageChange(e.target.value as Language)}
                            disabled={isChangingLanguage}
                            style={{ marginLeft: '10px' }}
                        >
                            {LANGUAGES.map((lang) => (
                                <option key={lang} value={lang}>
                                    {lang}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span style={{ marginLeft: '10px', color: '#666' }}>({room.language})</span>
                    )}
                </div>
                <div>
                    <span style={{ marginRight: '10px' }}>
                        {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
                    </span>
                    <span style={{ marginRight: '10px' }}>
                        {isSynced ? '✓ Synced' : '⟳ Syncing...'}
                    </span>
                </div>
            </div>

            {/* Main content */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Editor */}
                <div style={{ flex: 1, overflow: 'auto' }}>
                    <div ref={editorRef} style={{ height: '100%' }} />
                </div>

                {/* Users sidebar */}
                <div style={{ width: '200px', borderLeft: '1px solid #ccc', padding: '10px', overflowY: 'auto' }}>
                    <h3>Users ({remoteUsers.length + 1})</h3>

                    {/* Current user */}
                    <div style={{ marginBottom: '10px', padding: '5px', backgroundColor: '#f0f0f0' }}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <div
                                style={{
                                    width: '12px',
                                    height: '12px',
                                    backgroundColor: user?.color,
                                    marginRight: '5px',
                                }}
                            />
                            <span>{user?.username} (You)</span>
                        </div>
                    </div>

                    {/* Remote users */}
                    {remoteUsers.map((remoteUser) => (
                        <div key={remoteUser.clientId} style={{ marginBottom: '10px', padding: '5px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <div
                                        style={{
                                            width: '12px',
                                            height: '12px',
                                            backgroundColor: remoteUser.color,
                                            marginRight: '5px',
                                        }}
                                    />
                                    <span>{remoteUser.username}</span>
                                </div>
                                <button
                                    onClick={() =>
                                        setFollowingUser(
                                            followingUser === remoteUser.clientId ? null : remoteUser.clientId
                                        )
                                    }
                                    style={{
                                        fontSize: '10px',
                                        padding: '2px 5px',
                                    }}
                                >
                                    {followingUser === remoteUser.clientId ? 'Unfollow' : 'Follow'}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
