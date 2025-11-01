import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, StateEffect } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { oneDark } from '@codemirror/theme-one-dark'
import * as Y from 'yjs'
import pako from 'pako'
import { api } from '../lib/api'
import { ThemeToggle } from './ThemeToggle'
import { PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon } from './PlaybackIcons'
import { useTheme } from '../contexts/ThemeContext'
import type { Language } from '../types'

const languageExtensions: Record<Language, any> = {
    javascript: javascript(),
    typescript: javascript({ typescript: true }),
    python: python(),
    java: java(),
    cpp: cpp(),
    rust: rust(),
    go: go(),
    php: php(),
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
}

function decompressUpdate(compressedBase64: string): Uint8Array {
    const compressed = base64ToUint8Array(compressedBase64)
    return pako.ungzip(compressed)
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
}

interface Update {
    id: string
    timestamp: string
    timestampMs: number
    update: Uint8Array
    userId: string | null
}

export function RoomPlayback() {
    const { roomId } = useParams<{ roomId: string }>()
    const navigate = useNavigate()
    const { theme } = useTheme()

    const [room, setRoom] = useState<any>(null)
    const [updates, setUpdates] = useState<Update[]>([])
    const [startMs, setStartMs] = useState(0)
    const [endMs, setEndMs] = useState(0)
    const [currentTimestamp, setCurrentTimestamp] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
    const [editorView, setEditorView] = useState<EditorView | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState('')

    // Load room and updates
    useEffect(() => {
        if (!roomId) return

        const load = async () => {
            try {
                setIsLoading(true)
                const [roomData, updatesData] = await Promise.all([
                    api.getRoom(roomId),
                    api.getPlaybackUpdates(roomId),
                ])

                setRoom(roomData.room)

                if (updatesData.updates.length === 0) {
                    setError('No playback data available for this room')
                    setIsLoading(false)
                    return
                }

                const processedUpdates: Update[] = updatesData.updates.map((u) => ({
                    id: u.id,
                    timestamp: u.timestamp,
                    timestampMs: new Date(u.timestamp).getTime(),
                    update: decompressUpdate(u.update),
                    userId: u.userId,
                }))

                setUpdates(processedUpdates)
                const start = processedUpdates[0].timestampMs
                const end = processedUpdates[processedUpdates.length - 1].timestampMs
                setStartMs(start)
                setEndMs(end)
                setCurrentTimestamp(start)
                setIsLoading(false)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load playback data')
                setIsLoading(false)
            }
        }

        load()
    }, [roomId])

    // Initialize CodeMirror (only once when room is loaded)
    useEffect(() => {
        if (!room || editorView) return

        const container = document.getElementById('playback-editor')
        if (!container) return

        const languageExt = languageExtensions[room.language as Language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        const state = EditorState.create({
            doc: '',
            extensions: [
                basicSetup,
                languageExt,
                ...themeExt,
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
            ],
        })

        const view = new EditorView({
            state,
            parent: container,
        })

        setEditorView(view)

        return () => {
            view.destroy()
            setEditorView(null)
        }
    }, [room])

    // Update theme when it changes (using reconfigure, not recreating editor)
    useEffect(() => {
        if (!editorView || !room) return

        const languageExt = languageExtensions[room.language as Language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        editorView.dispatch({
            effects: StateEffect.reconfigure.of([
                basicSetup,
                languageExt,
                ...themeExt,
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
            ]),
        })
    }, [theme, editorView, room])

    // Reconstruct document at current timestamp
    useEffect(() => {
        if (updates.length === 0 || !editorView) return

        const relevantUpdates = updates.filter((u) => u.timestampMs <= currentTimestamp)

        // Reconstruct Y.Doc
        const tempDoc = new Y.Doc()
        const ytext = tempDoc.getText('codemirror')

        relevantUpdates.forEach((u) => {
            try {
                Y.applyUpdate(tempDoc, u.update)
            } catch (err) {
                console.error('Error applying update:', err)
            }
        })

        const content = ytext.toString()

        // Update editor content
        editorView.dispatch({
            changes: {
                from: 0,
                to: editorView.state.doc.length,
                insert: content,
            },
        })
    }, [currentTimestamp, updates, editorView])

    // Auto-play logic
    useEffect(() => {
        if (!isPlaying || endMs === 0) return

        const interval = setInterval(() => {
            setCurrentTimestamp((t) => {
                const next = t + 100 * playbackSpeed
                if (next >= endMs) {
                    setIsPlaying(false)
                    return endMs
                }
                return next
            })
        }, 100)

        return () => clearInterval(interval)
    }, [isPlaying, playbackSpeed, endMs])

    if (isLoading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                Loading playback...
            </div>
        )
    }

    if (error) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', gap: '1rem' }}>
                <div style={{ color: 'var(--error)' }}>{error}</div>
                <button onClick={() => navigate('/rooms')}>Back to Rooms</button>
            </div>
        )
    }

    return (
        <div className="editor-container">
            {/* Header */}
            <div className="editor-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button className="toolbar-button" onClick={() => navigate('/rooms')}>
                        ← Back
                    </button>
                    <span style={{ fontWeight: 600, fontSize: '1rem' }}>Playback: {room?.name}</span>
                    <span className="language-badge">{room?.language}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <ThemeToggle />
                </div>
            </div>

            {/* Editor */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <div id="playback-editor" style={{ height: '100%' }} />
            </div>

            {/* Playback Controls */}
            <div className="status-bar" style={{ flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
                {/* Timeline */}
                <input
                    type="range"
                    min={startMs}
                    max={endMs}
                    step={100}
                    value={currentTimestamp}
                    onChange={(e) => {
                        setCurrentTimestamp(Number(e.target.value))
                        setIsPlaying(false)
                    }}
                    style={{
                        width: '100%',
                        cursor: 'pointer',
                    }}
                />

                {/* Controls Row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {/* Skip to start */}
                        <button
                            className="toolbar-button"
                            onClick={() => {
                                setCurrentTimestamp(startMs)
                                setIsPlaying(false)
                            }}
                            style={{ width: '2rem', height: '2rem', padding: '0.25rem' }}
                        >
                            <SkipBackIcon />
                        </button>

                        {/* Play/Pause */}
                        <button
                            className="toolbar-button"
                            onClick={() => setIsPlaying(!isPlaying)}
                            style={{ width: '2rem', height: '2rem', padding: '0.25rem' }}
                        >
                            {isPlaying ? <PlayIcon /> : <PauseIcon />}
                        </button>

                        {/* Skip to end */}
                        <button
                            className="toolbar-button"
                            onClick={() => {
                                setCurrentTimestamp(endMs)
                                setIsPlaying(false)
                            }}
                            style={{ width: '2rem', height: '2rem', padding: '0.25rem' }}
                        >
                            <SkipForwardIcon />
                        </button>

                        {/* Time display */}
                        <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                            {formatTime(currentTimestamp)} / {formatTime(endMs)}
                        </span>
                    </div>

                    {/* Speed control */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Speed:</span>
                        <select
                            className="toolbar-select"
                            value={playbackSpeed}
                            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.875rem' }}
                        >
                            <option value={0.5}>0.5x</option>
                            <option value={1}>1x</option>
                            <option value={2}>2x</option>
                            <option value={5}>5x</option>
                            <option value={10}>10x</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    )
}
