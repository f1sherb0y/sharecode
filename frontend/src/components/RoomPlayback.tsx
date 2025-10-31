import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
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

function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
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
    const [duration, setDuration] = useState(0)
    const [currentTime, setCurrentTime] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
    const [documentContent, setDocumentContent] = useState('')
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
                setStartMs(processedUpdates[0].timestampMs)
                setDuration(updatesData.duration)
                setIsLoading(false)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load playback data')
                setIsLoading(false)
            }
        }

        load()
    }, [roomId])

    // Reconstruct document at current time
    useEffect(() => {
        if (updates.length === 0 || !room) return

        const targetMs = startMs + currentTime * 1000
        const relevantUpdates = updates.filter((u) => u.timestampMs <= targetMs)

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
        setDocumentContent(content)

        // Update editor if it exists
        if (editorView) {
            editorView.dispatch({
                changes: {
                    from: 0,
                    to: editorView.state.doc.length,
                    insert: content,
                },
            })
        }
    }, [currentTime, updates, startMs, room, editorView])

    // Auto-play logic
    useEffect(() => {
        if (!isPlaying || duration === 0) return

        const interval = setInterval(() => {
            setCurrentTime((t) => {
                const next = t + 0.1 * playbackSpeed
                if (next >= duration) {
                    setIsPlaying(false)
                    return duration
                }
                return next
            })
        }, 100)

        return () => clearInterval(interval)
    }, [isPlaying, playbackSpeed, duration])

    // Initialize CodeMirror
    useEffect(() => {
        if (!room || editorView) return

        const container = document.getElementById('playback-editor')
        if (!container) return

        const languageExt = languageExtensions[room.language as Language] || javascript()
        const themeExt = theme === 'dark' ? [oneDark] : []

        const state = EditorState.create({
            doc: documentContent,
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
    }, [room, theme])

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
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            {/* Toolbar */}
            <div className="toolbar">
                <div className="toolbar-left">
                    <button className="toolbar-button" onClick={() => navigate('/rooms')}>
                        ← Back
                    </button>
                    <span className="toolbar-text">Playback: {room?.name}</span>
                </div>
                <div className="toolbar-right">
                    <ThemeToggle />
                </div>
            </div>

            {/* Editor */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <div id="playback-editor" style={{ height: '100%' }} />
            </div>

            {/* Playback Controls */}
            <div
                style={{
                    borderTop: '1px solid var(--border)',
                    padding: '1rem',
                    backgroundColor: 'var(--surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                }}
            >
                {/* Timeline */}
                <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={currentTime}
                    onChange={(e) => {
                        setCurrentTime(Number(e.target.value))
                        setIsPlaying(false)
                    }}
                    style={{
                        width: '100%',
                        cursor: 'pointer',
                    }}
                />

                {/* Controls Row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {/* Play/Pause */}
                        <button
                            onClick={() => setIsPlaying(!isPlaying)}
                            style={{ width: '2.5rem' }}
                        >
                            {isPlaying ? '⏸' : '⏵'}
                        </button>

                        {/* Skip to start */}
                        <button
                            onClick={() => {
                                setCurrentTime(0)
                                setIsPlaying(false)
                            }}
                            style={{ width: '2.5rem' }}
                        >
                            ⏮
                        </button>

                        {/* Skip to end */}
                        <button
                            onClick={() => {
                                setCurrentTime(duration)
                                setIsPlaying(false)
                            }}
                            style={{ width: '2.5rem' }}
                        >
                            ⏭
                        </button>

                        {/* Time display */}
                        <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>

                    {/* Speed control */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Speed:</span>
                        <select
                            value={playbackSpeed}
                            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                            style={{ padding: '0.25rem 0.5rem' }}
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
