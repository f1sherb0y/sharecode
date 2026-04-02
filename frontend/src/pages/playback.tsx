import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, FileCode, Brush, StickyNote, PanelRightClose } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import * as Y from 'yjs'
import pako from 'pako'
import { createTLStore, defaultShapeUtils, loadSnapshot, type TLRecord, type TLStore } from 'tldraw'
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
import { NotesView } from '@/components/features/notes-view'
import { api } from '@/api'
import { useAuthStore, useThemeStore, useNotesStore, useFontStore } from '@/stores'
import { useCompactViewport } from '@/hooks'
import { cn, formatTime } from '@/lib/utils'
import { createMonacoEditorOptions, resolveMonacoLanguage } from '@/lib/monaco-config'
import { loadMonaco } from '@/lib/monaco-loader'
import { CanvasView } from '@/components/features/canvas-view'
import type { Room } from '@/types'

const PLAYBACK_DOC_VIEWS = ['code', 'canvas'] as const
const PLAYBACK_SPEED_OPTIONS = [0.5, 1, 2, 5, 10] as const

function parsePlaybackView(value: string | null): 'code' | 'canvas' {
  return PLAYBACK_DOC_VIEWS.includes((value ?? '') as (typeof PLAYBACK_DOC_VIEWS)[number])
    ? (value as 'code' | 'canvas')
    : 'code'
}

function parsePlaybackSpeed(value: string | null): number {
  const numeric = Number(value)
  return PLAYBACK_SPEED_OPTIONS.includes(numeric as (typeof PLAYBACK_SPEED_OPTIONS)[number])
    ? numeric
    : 1
}

interface Update {
  id: string
  timestamp: string
  timestampMs: number
  update: Uint8Array
  userId: string | null
}

function normalizeAssetRecord(record: TLRecord, assets: Map<string, string>): TLRecord {
  if ((record as any).typeName !== 'asset') return record
  const props = (record as any).props
  if (!props || typeof props.src !== 'string') return record
  const src = props.src as string
  if (!src.startsWith('yjs:')) return record
  const resolved = assets.get(src.slice(4)) ?? ''
  if (resolved === src) return record
  return {
    ...(record as any),
    props: {
      ...props,
      src: resolved,
    },
  } as TLRecord
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
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const { theme } = useThemeStore()
  const { font, fontSize } = useFontStore()
  const isCompactViewport = useCompactViewport()

  const [room, setRoom] = useState<Room | null>(null)
  const [updates, setUpdates] = useState<Update[]>([])
  const activeDoc = parsePlaybackView(searchParams.get('view'))
  const playbackSpeed = parsePlaybackSpeed(searchParams.get('speed'))
  const [startMs, setStartMs] = useState(0)
  const [endMs, setEndMs] = useState(0)
  const [currentTimestamp, setCurrentTimestamp] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [canvasStore, setCanvasStore] = useState<TLStore | null>(null)
  const [canvasReady, setCanvasReady] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const { notes } = useNotesStore()

  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const playbackEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const playbackModelRef = useRef<Monaco.editor.ITextModel | null>(null)
  const assetMapRef = useRef<Map<string, string>>(new Map())

  const assetStore = useMemo(
    () => ({
      async upload() {
        throw new Error('Playback is read-only')
      },
      resolve(asset: any) {
        const src = asset?.props?.src ?? asset?.src ?? ''
        if (typeof src === 'string' && src.startsWith('yjs:')) {
          return assetMapRef.current.get(src.slice(4)) ?? ''
        }
        return typeof src === 'string' ? src : ''
      },
      async remove() {
        // no-op for playback
      },
    }),
    []
  )

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (normalized.get('view') !== activeDoc) {
      normalized.set('view', activeDoc)
      changed = true
    }
    if (normalized.get('speed') !== String(playbackSpeed)) {
      normalized.set('speed', String(playbackSpeed))
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, activeDoc, playbackSpeed, setSearchParams])

  useEffect(() => {
    if (startMs === 0 || endMs === 0) return
    const clamped = Math.min(endMs, Math.max(startMs, currentTimestamp))
    if (clamped !== currentTimestamp) {
      setCurrentTimestamp(clamped)
    }
  }, [startMs, endMs, currentTimestamp])

  const getDocAtTimestamp = useCallback(
    (timestamp: number) => {
      const tempDoc = new Y.Doc()

      updates
        .filter((u) => u.timestampMs <= timestamp)
        .forEach((u) => {
          try {
            Y.applyUpdate(tempDoc, u.update)
          } catch (err) {
            console.error('Error applying update:', err)
          }
        })

      return tempDoc
    },
    [updates]
  )

  const updateCanvasFromDoc = useCallback(
    (doc: Y.Doc) => {
      if (!canvasStore) return
      const yRecords = doc.getMap<TLRecord>('tldraw-records')
      const yAssets = doc.getMap<string>('tldraw-assets')

      const assets = new Map<string, string>()
      yAssets.forEach((value, key) => {
        assets.set(key, value)
      })
      assetMapRef.current = assets

      const originalRecords = Array.from(yRecords.values()) as TLRecord[]
      const normalizedRecords = originalRecords.map((record) => normalizeAssetRecord(record, assets))
      const snapshot = {
        schema: canvasStore.schema.serialize(),
        store: Object.fromEntries(normalizedRecords.map((record) => [record.id, record])),
      }
      loadSnapshot(canvasStore, { document: snapshot })
      setCanvasReady(true)
    },
    [canvasStore]
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

  // Initialize Monaco playback editor
  useEffect(() => {
    if (!room || !editorRef.current || playbackEditorRef.current) return
    if (updates.length === 0) return

    let cancelled = false

    try {
      const initialDoc = getDocAtTimestamp(currentTimestamp)
      const ytext = initialDoc.getText('codemirror')
      loadMonaco().then((monaco) => {
        if (cancelled || !editorRef.current) return
        monacoRef.current = monaco

        const model = monaco.editor.createModel(
          ytext.toString(),
          resolveMonacoLanguage(room.language),
        )
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
        playbackModelRef.current = model

        const editor = monaco.editor.create(editorRef.current, {
          ...createMonacoEditorOptions({
            model,
            font,
            fontSize,
            theme,
            readOnly: true,
          }),
        })

        playbackEditorRef.current = editor
      })
    } catch (err) {
      console.error('Failed to initialize playback editor:', err)
      setError('Failed to initialize playback editor')
    }

    return () => {
      cancelled = true
      playbackEditorRef.current?.dispose()
      playbackEditorRef.current = null
      playbackModelRef.current?.dispose()
      playbackModelRef.current = null
    }
  }, [room, updates.length, getDocAtTimestamp, currentTimestamp, theme, font, fontSize])

  // Initialize canvas store
  useEffect(() => {
    if (canvasStore || updates.length === 0) return
    const store = createTLStore({
      shapeUtils: defaultShapeUtils,
      assets: assetStore,
    })
    setCanvasStore(store)
  }, [canvasStore, updates.length, assetStore])

  // Cleanup
  useEffect(() => {
    return () => {
      playbackEditorRef.current?.dispose()
      playbackModelRef.current?.dispose()
    }
  }, [])

  // Update theme
  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  useEffect(() => {
    playbackEditorRef.current?.updateOptions({
      fontFamily: `${font}, monospace`,
      fontSize,
    })
  }, [font, fontSize])

  // Update content at timestamp
  useEffect(() => {
    if (updates.length === 0) return
    const doc = getDocAtTimestamp(currentTimestamp)

    if (playbackModelRef.current) {
      const ytext = doc.getText('codemirror')
      const newText = ytext.toString()
      const currentText = playbackModelRef.current.getValue()
      
      if (newText !== currentText) {
        playbackModelRef.current.pushEditOperations(
          [],
          [{ range: playbackModelRef.current.getFullModelRange(), text: newText }],
          () => null,
        )
      }
    }

    if (room?.language && monacoRef.current && playbackModelRef.current) {
      monacoRef.current.editor.setModelLanguage(
        playbackModelRef.current,
        resolveMonacoLanguage(room.language),
      )
    }

    updateCanvasFromDoc(doc)
  }, [currentTimestamp, updates.length, getDocAtTimestamp, updateCanvasFromDoc, room?.language])

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
    <div
      className={cn(
        'playback-shell flex flex-col h-screen safe-x',
        isCompactViewport && 'compact-ui'
      )}
      style={{ height: '100dvh' }}
    >
      {/* Header */}
      <header
        className={cn(
          'flex items-center justify-between border-b bg-background shrink-0 gap-2',
          isCompactViewport ? 'h-10 px-2' : 'h-11 px-3 sm:px-4'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')}
            onClick={() => navigate('/rooms')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span
            className={cn(
              'font-medium truncate text-sm',
              isCompactViewport ? 'max-w-[140px]' : 'max-w-[240px]'
            )}
          >
            {room?.name}
          </span>
          <Badge
            variant="secondary"
            className={cn(
              'rounded-sm text-xs',
              isCompactViewport ? 'px-1 py-0 leading-5' : 'px-1.5 py-0'
            )}
          >
            {room?.language}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <div className={cn('flex items-center rounded-md border p-0.5', isCompactViewport && 'gap-0.5')}>
            <Button
              variant={activeDoc === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(isCompactViewport ? 'h-7 px-1.5' : 'h-7 px-2')}
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.set('view', 'code')
                setSearchParams(next)
              }}
            >
              <FileCode className="h-3.5 w-3.5 sm:mr-1" />
              {!isCompactViewport && <span className="hidden md:inline">{t('editor.toolbar.code')}</span>}
            </Button>
            <Button
              variant={activeDoc === 'canvas' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(isCompactViewport ? 'h-7 px-1.5' : 'h-7 px-2')}
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.set('view', 'canvas')
                setSearchParams(next)
              }}
            >
              <Brush className="h-3.5 w-3.5 sm:mr-1" />
              {!isCompactViewport && <span className="hidden md:inline">{t('editor.toolbar.canvas')}</span>}
            </Button>
          </div>
          <ThemeToggle className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')} />
          <Button
            variant={showNotes ? 'secondary' : 'ghost'}
            size="icon"
            className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')}
            onClick={() => setShowNotes(!showNotes)}
            title={t('playback.notes')}
          >
            <StickyNote className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Editor + Notes */}
      <div className="relative flex-1 flex overflow-hidden min-w-0">
        <div className="flex-1 overflow-hidden min-w-0">
          <div className={`h-full w-full ${activeDoc === 'code' ? '' : 'hidden'}`}>
            <div ref={editorRef} className="h-full w-full" />
          </div>
          {activeDoc === 'canvas' && (
            <CanvasView
              store={canvasStore}
              ready={canvasReady}
              canEdit={false}
              theme={theme}
              provider={null}
              followUserId={null}
              followClientId={null}
              followEnabled={false}
            />
          )}
        </div>

        {/* Notes panel */}
        {showNotes && roomId && (
          <div
            className={cn(
              'border-l bg-background flex flex-col',
              isCompactViewport
                ? 'absolute inset-y-0 right-0 z-10 w-[min(18rem,78vw)] shadow-lg'
                : 'w-64 shrink-0'
            )}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
              <div className="flex items-center gap-1.5">
                <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{t('playback.notes')}</span>
                {notes.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">{notes.length}</Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowNotes(false)}
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden p-2">
              <NotesView roomId={roomId} readOnly />
            </div>
          </div>
        )}
      </div>

      {/* Playback controls */}
      <footer
        className={cn(
          'safe-bottom border-t bg-background shrink-0',
          isCompactViewport ? 'px-2 py-1.5' : 'px-3 py-2.5 sm:px-4 sm:py-3'
        )}
      >
        {/* Timeline with marks */}
        <div className={cn('relative', isCompactViewport ? 'mb-2' : 'mb-3')}>
          <input
            type="range"
            min={startMs}
            max={endMs}
            step="any"
            value={currentTimestamp}
            onChange={(e) => {
              setCurrentTimestamp(Number(e.target.value))
              setIsPlaying(false)
            }}
            className={cn(
              'w-full bg-secondary rounded-lg appearance-none cursor-pointer relative z-10',
              isCompactViewport ? 'h-1.5' : 'h-2'
            )}
          />
          {/* Update marks - group close updates into regions */}
          <div className={cn('absolute top-0 left-0 right-0 pointer-events-none', isCompactViewport ? 'h-1.5' : 'h-2')}>
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
                    className={cn('absolute top-0 bg-primary/50 rounded-sm', isCompactViewport ? 'h-1.5' : 'h-2')}
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Button
              variant="outline"
              size="icon"
              className={cn(isCompactViewport ? 'h-7 w-7' : 'h-9 w-9')}
              onClick={() => {
                setCurrentTimestamp(startMs)
                setIsPlaying(false)
              }}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn(isCompactViewport ? 'h-7 w-7' : 'h-9 w-9')}
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn(isCompactViewport ? 'h-7 w-7' : 'h-9 w-9')}
              onClick={() => {
                setCurrentTimestamp(endMs)
                setIsPlaying(false)
              }}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
            <span
              className={cn(
                'ml-1 text-muted-foreground font-mono whitespace-nowrap',
                isCompactViewport ? 'text-xs' : 'ml-2 text-sm'
              )}
            >
              {formatTime(currentTimestamp)} / {formatTime(endMs)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!isCompactViewport && <span className="text-sm text-muted-foreground">{t('playback.speed')}:</span>}
            <Select
              value={String(playbackSpeed)}
              onValueChange={(v) => {
                const next = new URLSearchParams(searchParams)
                next.set('speed', String(parsePlaybackSpeed(v)))
                setSearchParams(next)
              }}
            >
              <SelectTrigger className={cn(isCompactViewport ? 'h-7 w-[4.5rem]' : 'w-20 h-8')}>
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
