import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as Y from 'yjs'
import pako from 'pako'
import { api } from '../lib/api'
import { ThemeToggle } from './ThemeToggle'
import { PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon } from './PlaybackIcons'
import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import type { Language, Room } from '../types'
import type * as Monaco from 'monaco-editor'
import { loadMonaco } from '../lib/monacoLoader'
import 'monaco-editor/min/vs/editor/editor.main.css'

type MonacoModule = typeof Monaco
type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModel = Monaco.editor.ITextModel

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

const resolveMonacoLanguage = (language?: string) =>
    monacoLanguageIds[language as Language] ?? 'javascript'

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
    const { t } = useTranslation()
    const { user } = useAuth()

    const [room, setRoom] = useState<Room | null>(null)
    const [updates, setUpdates] = useState<Update[]>([])
    const [startMs, setStartMs] = useState(0)
    const [endMs, setEndMs] = useState(0)
    const [currentTimestamp, setCurrentTimestamp] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState('')
    const editorRef = useRef<HTMLDivElement | null>(null)
    const monacoRef = useRef<MonacoModule | null>(null)
    const monacoEditorRef = useRef<MonacoEditorInstance | null>(null)
    const monacoModelRef = useRef<MonacoModel | null>(null)

    const destroyMonaco = useCallback(() => {
        monacoEditorRef.current?.dispose()
        monacoEditorRef.current = null
        monacoModelRef.current?.dispose()
        monacoModelRef.current = null
        monacoRef.current = null
    }, [])

    const getContentAtTimestamp = useCallback((timestamp: number) => {
        if (updates.length === 0) return ''

        const tempDoc = new Y.Doc()
        const ytext = tempDoc.getText('codemirror')

        updates
            .filter((u) => u.timestampMs <= timestamp)
            .forEach((u) => {
                try {
                    Y.applyUpdate(tempDoc, u.update)
                } catch (err) {
                    console.error('Error applying update:', err)
                }
            })

        return ytext.toString()
    }, [updates])

    // Load room and updates
    useEffect(() => {
        if (!roomId || !user) return

        let isCancelled = false

        const load = async () => {
            try {
                setIsLoading(true)
                setError('')

                const { room } = await api.getRoom(roomId)
                if (isCancelled) return
                setRoom(room)

                const isOwner = room.ownerId === user.id
                const isAdminOrSuper = user.role === 'admin' || user.role === 'superuser'

                if (!isOwner && !isAdminOrSuper) {
                    setError(t('playback.accessDenied'))
                    setIsLoading(false)
                    return
                }

                const updatesData = await api.getPlaybackUpdates(roomId)
                if (isCancelled) return

                if (updatesData.updates.length === 0) {
                    setError(t('playback.noData'))
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
                if (isCancelled) return
                if (err instanceof Error) {
                    if (err.message === 'Access denied') {
                        setError(t('playback.accessDenied'))
                    } else if (err.message === 'Room has not ended yet') {
                        setError(t('playback.notEnded'))
                    } else {
                        setError(err.message)
                    }
                } else {
                    setError(t('playback.loadFailed'))
                }
                setIsLoading(false)
            }
        }

        load()

        return () => {
            isCancelled = true
        }
    }, [roomId, user, t])

    // Initialize Monaco editor once room data is ready
    const hasPlaybackPrivileges = !!user && (user.role === 'admin' || user.role === 'superuser')
    const isOwner = !!room && !!user && room.ownerId === user.id
    const canViewPlayback = !!room && !!user && (isOwner || hasPlaybackPrivileges)

    useEffect(() => {
        if (!room?.id || !editorRef.current || monacoEditorRef.current) return
        if (!canViewPlayback) return

        let isCancelled = false

        loadMonaco()
            .then((monaco) => {
                if (isCancelled || !editorRef.current) return
                monacoRef.current = monaco

                const languageId = resolveMonacoLanguage(room.language)
                const model = monaco.editor.createModel('', languageId)
                monacoModelRef.current = model

                const editor = monaco.editor.create(editorRef.current, {
                    model,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, "Liberation Mono", monospace',
                    fontSize: 14,
                    theme: theme === 'dark' ? 'vs-dark' : 'vs',
                })
                monacoEditorRef.current = editor
                const initialContent = getContentAtTimestamp(currentTimestamp)
                model.setValue(initialContent)
                editor.focus()
            })
            .catch((err) => {
                console.error('Failed to initialize Monaco playback editor', err)
                setError(err instanceof Error ? err.message : 'Failed to initialize playback editor')
            })

        return () => {
            isCancelled = true
        }
    }, [room, theme, getContentAtTimestamp, currentTimestamp, canViewPlayback])

    // Cleanup Monaco on unmount
    useEffect(() => destroyMonaco, [destroyMonaco])

    // Update theme dynamically
    useEffect(() => {
        if (!monacoRef.current) return
        monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }, [theme])

    // Ensure language stays in sync with room metadata
    useEffect(() => {
        if (!monacoRef.current || !monacoModelRef.current) return
        const languageId = resolveMonacoLanguage(room?.language)
        monacoRef.current.editor.setModelLanguage(monacoModelRef.current, languageId)
    }, [room?.language])

    // Reconstruct document at current timestamp
    useEffect(() => {
        if (!monacoModelRef.current || !canViewPlayback) return
        const content = getContentAtTimestamp(currentTimestamp)
        monacoModelRef.current.setValue(content)
    }, [currentTimestamp, getContentAtTimestamp, canViewPlayback])

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
                {t('common.loading')}
            </div>
        )
    }

    if (error) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', gap: '1rem' }}>
                <div style={{ color: 'var(--error)' }}>{error}</div>
                <button onClick={() => navigate('/rooms')}>{t('playback.backToRooms')}</button>
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
                <div ref={editorRef} style={{ height: '100%' }} />
            </div>

            {/* Playback Controls */}
            <div className="status-bar" style={{ flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
                {/* Timeline with markers */}
                <div style={{ position: 'relative', width: '100%' }}>
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
                            margin: 0,
                            padding: 0
                        }}
                    />
                    {/* Render markers for each update */}
                    {updates.map((update) => {
                        const position = ((update.timestampMs - startMs) / (endMs - startMs)) * 100
                        return (
                            <div
                                key={update.id}
                                title={formatTime(update.timestampMs)}
                                style={{
                                    position: 'absolute',
                                    left: `${position}%`,
                                    top: 0,
                                    bottom: 0,
                                    margin: 'auto',
                                    transform: 'translateX(-50%)',
                                    width: '2px',
                                    height: '16px',
                                    backgroundColor: theme === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)',
                                    pointerEvents: 'none',
                                    zIndex: 0,
                                }}
                            />
                        )
                    })}
                </div>

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
