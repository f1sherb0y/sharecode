import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import * as Y from 'yjs'
import pako from 'pako'
import {
  Button,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/ui'
import { ThemeToggle } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore, useThemeStore } from '@/stores'
import { loadMonaco } from '@/lib/monaco-loader'
import { formatTime } from '@/lib/utils'
import type { Room, Language } from '@/types'
import type * as Monaco from 'monaco-editor'

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

interface Update {
  id: string
  timestamp: string
  timestampMs: number
  update: Uint8Array
  userId: string | null
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

export function PlaybackPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const { theme } = useThemeStore()

  const [room, setRoom] = useState<Room | null>(null)
  const [updates, setUpdates] = useState<Update[]>([])
  const [startMs, setStartMs] = useState(0)
  const [endMs, setEndMs] = useState(0)
  const [currentTimestamp, setCurrentTimestamp] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const monacoEditorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoModelRef = useRef<MonacoModel | null>(null)

  const getContentAtTimestamp = useCallback(
    (timestamp: number) => {
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
    },
    [updates]
  )

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
        const isPrivileged = user.role === 'admin' || user.role === 'superuser' ||
          user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms

        if (!isOwner && !isPrivileged) {
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
        const start = processedUpdates[0]!.timestampMs
        const end = processedUpdates[processedUpdates.length - 1]!.timestampMs
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

  // Initialize Monaco
  useEffect(() => {
    if (!room || !editorRef.current || monacoEditorRef.current) return
    if (updates.length === 0) return

    let isCancelled = false

    loadMonaco()
      .then((monaco) => {
        if (isCancelled || !editorRef.current) return
        monacoRef.current = monaco

        const languageId = monacoLanguageIds[room.language] ?? 'javascript'
        const model = monaco.editor.createModel('', languageId)
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
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
          padding: { top: 16, bottom: 16 },
        })
        monacoEditorRef.current = editor

        const initialContent = getContentAtTimestamp(currentTimestamp)
        model.setValue(initialContent)
        editor.focus()
      })
      .catch((err) => {
        console.error('Failed to initialize playback editor:', err)
        setError('Failed to initialize playback editor')
      })

    return () => {
      isCancelled = true
    }
  }, [room, updates, theme, getContentAtTimestamp, currentTimestamp])

  // Cleanup
  useEffect(() => {
    return () => {
      monacoEditorRef.current?.dispose()
      monacoModelRef.current?.dispose()
    }
  }, [])

  // Update theme
  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  // Update content at timestamp
  useEffect(() => {
    if (!monacoModelRef.current) return
    const content = getContentAtTimestamp(currentTimestamp)
    monacoModelRef.current.setValue(content)
  }, [currentTimestamp, getContentAtTimestamp])

  // Auto-play
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
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={() => navigate('/rooms')}>{t('playback.backToRooms')}</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between h-12 px-4 border-b bg-background shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/rooms')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-medium mr-3">Playback: {room?.name}</span>
          <Badge variant="secondary" className="rounded-sm text-xs px-1.5 py-0">{room?.language}</Badge>
        </div>
        <ThemeToggle className="h-8 w-8" />
      </header>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <div ref={editorRef} className="h-full w-full" />
      </div>

      {/* Playback controls */}
      <footer className="border-t bg-muted/50 p-4 shrink-0">
        {/* Timeline with marks */}
        <div className="relative mb-4">
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
            className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer relative z-10"
          />
          {/* Update marks - group close updates into regions */}
          <div className="absolute top-0 left-0 right-0 h-2 pointer-events-none">
            {(() => {
              const duration = endMs - startMs
              if (duration === 0) return null

              const regions: { start: number; end: number }[] = []
              const threshold = 0.5 // 0.5% threshold for grouping

              updates.forEach((update) => {
                const pos = ((update.timestampMs - startMs) / duration) * 100
                const lastRegion = regions[regions.length - 1]

                if (lastRegion && pos - lastRegion.end < threshold) {
                  // Extend existing region
                  lastRegion.end = pos
                } else {
                  // Start new region
                  regions.push({ start: pos, end: pos })
                }
              })

              return regions.map((region, i) => {
                const width = Math.max(region.end - region.start, 0.3) // Min width for visibility
                return (
                  <div
                    key={i}
                    className="absolute top-0 h-2 bg-primary/50 rounded-sm"
                    style={{
                      left: `${region.start}%`,
                      width: `${width}%`,
                    }}
                  />
                )
              })
            })()}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setCurrentTimestamp(startMs)
                setIsPlaying(false)
              }}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={() => setIsPlaying(!isPlaying)}>
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setCurrentTimestamp(endMs)
                setIsPlaying(false)
              }}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
            <span className="ml-2 text-sm text-muted-foreground font-mono">
              {formatTime(currentTimestamp)} / {formatTime(endMs)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('playback.speed')}:</span>
            <Select value={String(playbackSpeed)} onValueChange={(v) => setPlaybackSpeed(Number(v))}>
              <SelectTrigger className="w-20 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0.5">0.5x</SelectItem>
                <SelectItem value="1">1x</SelectItem>
                <SelectItem value="2">2x</SelectItem>
                <SelectItem value="5">5x</SelectItem>
                <SelectItem value="10">10x</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </footer>
    </div>
  )
}
