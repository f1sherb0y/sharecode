import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, FileCode, Brush, StickyNote, PanelRightClose } from 'lucide-react'
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
import { useAuthStore, useThemeStore, useNotesStore } from '@/stores'
import { formatTime } from '@/lib/utils'
import { CanvasView } from '@/components/features/canvas-view'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { go } from '@codemirror/lang-go'
import { markdown } from '@codemirror/lang-markdown'
import { StreamLanguage } from '@codemirror/language'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode'
import type { Room, Language } from '@/types'

const languageExtensions: Record<Language | string, any> = {
  javascript: javascript(),
  typescript: javascript({ typescript: true }),
  python: python(),
  java: java(),
  cpp: cpp(),
  rust: rust(),
  go: go(),
  php: php(),
  markdown: markdown(),
  verilog: StreamLanguage.define(verilog),
}

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
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const fontCompartment = useRef(new Compartment())
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

  // Initialize CodeMirror
  useEffect(() => {
    if (!room || !editorRef.current || viewRef.current) return
    if (updates.length === 0) return

    try {
      const languageExt = languageExtensions[room.language] ?? javascript()
      const initialDoc = getDocAtTimestamp(currentTimestamp)
      const ytext = initialDoc.getText('codemirror')

      const fontExt = EditorView.theme({
        "&": {
          height: "100%",
        },
        ".cm-scroller": {
           fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, "Liberation Mono", monospace',
           fontSize: "14px",
           paddingTop: "16px",
           paddingBottom: "16px",
        },
        ".cm-content": {
           fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, "Liberation Mono", monospace',
        }
      })

      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          languageCompartment.current.of(languageExt),
          themeCompartment.current.of(theme === 'dark' ? vscodeDark : vscodeLight),
          fontCompartment.current.of(fontExt),
          EditorView.editable.of(false), // Playback is read-only
        ]
      })

      const view = new EditorView({
        state,
        parent: editorRef.current
      })

      viewRef.current = view
    } catch (err) {
      console.error('Failed to initialize playback editor:', err)
      setError('Failed to initialize playback editor')
    }

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [room, updates.length, getDocAtTimestamp])

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
      viewRef.current?.destroy()
    }
  }, [])

  // Update theme
  useEffect(() => {
    if (!viewRef.current) return
    
    viewRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? vscodeDark : vscodeLight)
    })
  }, [theme])

  // Update content at timestamp
  useEffect(() => {
    if (updates.length === 0) return
    const doc = getDocAtTimestamp(currentTimestamp)

    if (viewRef.current) {
      const ytext = doc.getText('codemirror')
      const newText = ytext.toString()
      const currentText = viewRef.current.state.doc.toString()
      
      if (newText !== currentText) {
         viewRef.current.dispatch({
            changes: { from: 0, to: currentText.length, insert: newText }
         })
      }
    }

    updateCanvasFromDoc(doc)
  }, [currentTimestamp, updates.length, getDocAtTimestamp, updateCanvasFromDoc])

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
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
            <Button
              variant={activeDoc === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.set('view', 'code')
                setSearchParams(next)
              }}
            >
              <FileCode className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden md:inline">{t('editor.toolbar.code')}</span>
            </Button>
            <Button
              variant={activeDoc === 'canvas' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.set('view', 'canvas')
                setSearchParams(next)
              }}
            >
              <Brush className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden md:inline">{t('editor.toolbar.canvas')}</span>
            </Button>
          </div>
          <ThemeToggle className="h-8 w-8" />
          <Button
            variant={showNotes ? 'secondary' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowNotes(!showNotes)}
            title={t('playback.notes')}
          >
            <StickyNote className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Editor + Notes */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden">
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
          <div className="w-64 border-l bg-background flex flex-col shrink-0">
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
      <footer className="border-t bg-muted/50 p-4 shrink-0">
        {/* Timeline with marks */}
        <div className="relative mb-4">
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
            <Select
              value={String(playbackSpeed)}
              onValueChange={(v) => {
                const next = new URLSearchParams(searchParams)
                next.set('speed', String(parsePlaybackSpeed(v)))
                setSearchParams(next)
              }}
            >
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
