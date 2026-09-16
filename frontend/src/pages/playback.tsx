import { translateError } from '@/i18n/errors'
import { type CSSProperties, useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useViewportHeight } from '@/hooks/use-viewport-height'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, StickyNote, PanelRightClose } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import pako from 'pako'
import type * as Y from 'yjs'
import { DocumentReplay } from '@/lib/document-replay'
import { RoomViewSwitch } from '@/components/features/room-view-switch'
const CanvasView = lazy(() => import('@/components/features/canvas-view').then(m => ({ default: m.CanvasView })))
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
import { useAuthStore, useThemeStore, useFontStore } from '@/stores'
import { queryKeys } from '@/lib/query-keys'
import { fontFamilyStack } from '@/stores/font'
import { useCompactViewport } from '@/hooks'
import { cn, formatTime } from '@/lib/utils'
import { createMonacoEditorOptions, resolveMonacoLanguage } from '@/lib/monaco-config'
import { loadMonaco } from '@/lib/monaco-loader'
import { mermaidPlugins } from '@/lib/milkdown-mermaid'
import { imagePlugins } from '@/lib/milkdown-image'
import { mathPlugins } from '@/lib/milkdown-math'
import { Editor, editorViewOptionsCtx, rootCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { replaceAll } from '@milkdown/kit/utils'
import '@/styles/markdown.css'
// Must-have ProseMirror layout CSS + table base styles (same as live editor).
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'
import type { Room } from '@/types'

const PLAYBACK_SPEED_OPTIONS = [0.5, 1, 2, 5, 10] as const

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

function getCodeFromDocument(doc: Y.Doc, markdownEditor?: Editor | null): string {
  if (markdownEditor && (doc.getMap('meta').get('markdownInitialized') || doc.getXmlFragment('prosemirror').length > 0)) {
    return markdownEditor.action((ctx) => ctx.get(serializerCtx)(
      yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), ctx.get(schemaCtx)),
    ))
  }
  return doc.getText('codemirror').toString()
}

export function PlaybackPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()
  const viewportHeight = useViewportHeight()
  const { user } = useAuthStore()
  const { theme } = useThemeStore()
  const { font, fontSize } = useFontStore()
  const isCompactViewport = useCompactViewport()

  const view = searchParams.get('view') === 'canvas' ? 'canvas' : 'editor'
  const replayRef = useRef<DocumentReplay | null>(null)
  const [replayDoc, setReplayDoc] = useState<Y.Doc | null>(null)
  const timestampRef = useRef(0)
  const [room, setRoom] = useState<Room | null>(null)
  const [updates, setUpdates] = useState<Update[]>([])
  const playbackSpeed = parsePlaybackSpeed(searchParams.get('speed'))
  const [startMs, setStartMs] = useState(0)
  const [endMs, setEndMs] = useState(0)
  const [currentTimestamp, setCurrentTimestamp] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNotes, setShowNotes] = useState(false)
  const { data: notes = [] } = useQuery({
    queryKey: queryKeys.notes(roomId ?? ''),
    queryFn: async () => {
      if (!roomId) return []
      const { notes } = await api.getNotes(roomId)
      return notes
    },
    enabled: !!roomId,
  })

  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const playbackEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const playbackModelRef = useRef<Monaco.editor.ITextModel | null>(null)

  const isMarkdown = room?.language === 'markdown'
  const markdownContainerRef = useRef<HTMLDivElement>(null)
  const markdownEditorRef = useRef<Editor | null>(null)
  const lastMarkdownRef = useRef<string | null>(null)

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (normalized.get('speed') !== String(playbackSpeed)) {
      normalized.set('speed', String(playbackSpeed))
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, playbackSpeed, setSearchParams])

  useEffect(() => {
    if (startMs === 0 || endMs === 0) return
    const clamped = Math.min(endMs, Math.max(startMs, currentTimestamp))
    if (clamped !== currentTimestamp) {
      setCurrentTimestamp(clamped)
    }
  }, [startMs, endMs, currentTimestamp])

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
        const isPrivileged = user.role === 'superuser' ||
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

  useEffect(() => {
    const replay = new DocumentReplay(updates)
    replayRef.current = replay
    setReplayDoc(replay.seek(timestampRef.current))
    return () => { replay.destroy(); replayRef.current = null }
  }, [updates])

  useEffect(() => {
    timestampRef.current = currentTimestamp
    try {
      if (replayRef.current) setReplayDoc(replayRef.current.seek(currentTimestamp))
    } catch { setError(t('playback.loadFailed')) }
  }, [currentTimestamp, updates, t])

  // Initialize Monaco playback editor (code rooms only)
  useEffect(() => {
    if (isMarkdown) return
    if (!room || !editorRef.current || playbackEditorRef.current) return
    if (updates.length === 0) return

    let cancelled = false

    try {
      const initialText = getCodeFromDocument(replayRef.current!.doc, markdownEditorRef.current)
      loadMonaco().then((monaco) => {
        if (cancelled || !editorRef.current) return
        monacoRef.current = monaco

        const model = monaco.editor.createModel(
          initialText,
          resolveMonacoLanguage(room.language),
        )
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
        playbackModelRef.current = model

        const editor = monaco.editor.create(editorRef.current, {
          ...createMonacoEditorOptions({
            model,
            fontFamily: fontFamilyStack(font),
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
  }, [room, updates, isMarkdown])

  // Initialize read-only Milkdown preview for markdown rooms.
  // Reconstruct the canonical XML fragment, then serialize with the same schema as the
  // live editor (including mermaid diagrams and inline images) instead of
  // showing raw base64 data-URLs in a code editor.
  useEffect(() => {
    if (!isMarkdown || !room || updates.length === 0) return
    if (!markdownContainerRef.current || markdownEditorRef.current) return

    let cancelled = false
    const container = markdownContainerRef.current

    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, container)
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => false,
        }))
      })
      .use(commonmark)
      .use(gfm)
      .use(mermaidPlugins)
      .use(imagePlugins)
      .use(mathPlugins)

    editor
      .create()
      .then(() => {
        if (cancelled) return
        markdownEditorRef.current = editor
        lastMarkdownRef.current = null
        const text = getCodeFromDocument(replayRef.current!.doc, markdownEditorRef.current)
        editor.action(replaceAll(text))
        lastMarkdownRef.current = text
      })
      .catch((err) => {
        console.error('Failed to initialize markdown playback:', err)
      })

    return () => {
      cancelled = true
      void editor.destroy()
      markdownEditorRef.current = null
      lastMarkdownRef.current = null
    }
  }, [isMarkdown, room, updates])

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
      fontFamily: fontFamilyStack(font),
      fontSize,
    })
  }, [font, fontSize])

  // Update content at timestamp
  useEffect(() => {
    if (updates.length === 0) return

    if (isMarkdown) {
      const editor = markdownEditorRef.current
      if (!editor) return
      const text = getCodeFromDocument(replayRef.current!.doc, markdownEditorRef.current)
      if (text === lastMarkdownRef.current) return
      editor.action(replaceAll(text))
      lastMarkdownRef.current = text
      return
    }

    if (playbackModelRef.current) {
      const newText = getCodeFromDocument(replayRef.current!.doc, markdownEditorRef.current)
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
  }, [currentTimestamp, updates, isMarkdown, room?.language])

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
      <div className="flex flex-col items-center justify-center min-h-screen gap-2">
        <p className="text-destructive">{translateError(error)}</p>
        <Button onClick={() => navigate('/rooms')}>{t('playback.backToRooms')}</Button>
      </div>
    )
  }

  return (
    <div
      className="playback-shell flex flex-col h-screen safe-x"
      style={{ height: viewportHeight }}
    >
      {/* Header */}
      <header
        className={cn(
          'flex items-center justify-between border-b bg-background shrink-0 gap-1',
          'h-9 px-1.5'
        )}
      >
        <div className="flex items-center gap-1 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.back')}
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
              isCompactViewport ? 'px-1 py-0 leading-5' : 'px-1 py-0'
            )}
          >
            {room?.language}
          </Badge>
        </div>
        <RoomViewSwitch value={view} onChange={value => setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('view', value); return next }, { replace: true })} />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button
            variant={showNotes ? 'secondary' : 'ghost'}
            size="icon"
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
          <div className={view === 'canvas' ? 'hidden' : 'h-full w-full'}>
          {isMarkdown ? (
            // `.md-editor` wrapper reuses the live editor's typography & theme CSS
            <div className="md-editor h-full w-full overflow-y-auto" style={{ '--md-font-size': `${fontSize}px`, '--md-font-family': fontFamilyStack(font) } as CSSProperties}>
              <div translate="no" className="notranslate min-h-full" ref={markdownContainerRef} />
            </div>
          ) : (
            <div ref={editorRef} className="h-full w-full" />
          )}
          </div>
          {view === 'canvas' && replayDoc && <Suspense fallback={<Spinner />}>
            <CanvasView key={replayDoc.guid} doc={replayDoc} canEdit={false} theme={theme} replay />
          </Suspense>}
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
            <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
              <div className="flex items-center gap-1">
                <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{t('playback.notes')}</span>
                {notes.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">{notes.length}</Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.close')}
                onClick={() => setShowNotes(false)}
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden p-1.5">
              <NotesView roomId={roomId} readOnly />
            </div>
          </div>
        )}
      </div>

      {/* Playback controls */}
      <footer
        className={cn(
          'safe-bottom border-t bg-background shrink-0',
          'px-2 py-1'
        )}
      >
        {/* Timeline with marks */}
        <div className="relative mb-1">
          <input
            type="range"
            aria-label={t('playback.progress')}
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
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-[auto_1fr_auto]">
          <div className="order-1 flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={t('playback.goToStart')}
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
              aria-label={t(isPlaying ? 'playback.pause' : 'playback.play')}
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('playback.goToEnd')}
              onClick={() => {
                setCurrentTimestamp(endMs)
                setIsPlaying(false)
              }}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>
          <span className="order-3 col-span-2 text-center text-xs text-muted-foreground font-mono tabular-nums sm:order-2 sm:col-span-1 sm:text-left">
            {formatTime(currentTimestamp)} / {formatTime(endMs)}
          </span>

          <div className="order-2 flex items-center gap-1 sm:order-3">
            {!isCompactViewport && <span className="text-sm text-muted-foreground">{t('playback.speed')}:</span>}
            <Select
              value={String(playbackSpeed)}
              onValueChange={(v) => {
                const next = new URLSearchParams(searchParams)
                next.set('speed', String(parsePlaybackSpeed(v)))
                setSearchParams(next)
              }}
            >
              <SelectTrigger aria-label={t('playback.speed')} className="w-20">
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
