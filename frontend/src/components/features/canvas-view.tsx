import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Excalidraw, CaptureUpdateAction, MainMenu } from '@excalidraw/excalidraw'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import { CanvasSync, canvasFiles, orderedCanvasElements } from '@/lib/canvas-sync'
import { useCanvasFollow, type CanvasPresence } from '@/hooks/use-canvas-follow'
import '@excalidraw/excalidraw/index.css'
import '@/styles/canvas.css'
import { CANVAS_FONT, monoCanvasElements } from '@/lib/canvas-font'

interface CanvasViewProps {
  doc: Y.Doc
  canEdit: boolean
  theme: 'light' | 'dark'
  provider?: HocuspocusProvider | null
  followClientId?: number | null
  onFollowChange?: (clientId: number | null) => void
  onPending?: (pending: boolean) => void
  replay?: boolean
}
export function CanvasView({ doc, canEdit, theme, provider, followClientId, onFollowChange, onPending, replay = false }: CanvasViewProps) {
  const { t, i18n } = useTranslation()
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [error, setError] = useState('')
  const syncRef = useRef<CanvasSync | null>(null)
  const applying = useRef(false)
  const rejected = useRef(false)
  const pointerDown = useRef(false)
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const onPendingRef = useRef(onPending)
  onPendingRef.current = onPending
  const presence = useRef<CanvasPresence>({})
  const initialData = useMemo(() => ({ elements: monoCanvasElements(orderedCanvasElements(doc)), files: canvasFiles(doc), appState: { currentItemFontFamily: CANVAS_FONT, viewBackgroundColor: doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff' }, scrollToContent: true }), [doc])

  useEffect(() => {
    if (!api) return
    const sync = new CanvasSync(doc, pending => onPendingRef.current?.(pending || rejected.current))
    syncRef.current = sync
    let frame = 0
    const addedFiles = new Map<string, BinaryFiles[string]>()
    const renderRemote = () => {
      frame = 0
      const remote = monoCanvasElements(orderedCanvasElements(doc))
      const pendingIds = sync.pendingIds()
      const local = api.getSceneElementsIncludingDeleted()
      const active = pointerDown.current ? api.getAppState().newElement?.id : null
      const localById = new Map(local.map(e => [e.id, e]))
      const merged = remote.map(e => (pendingIds.has(e.id) || e.id === active) ? localById.get(e.id) ?? e : e)
      for (const e of local) if (pendingIds.has(e.id) && !merged.some(r => r.id === e.id)) merged.push(e)
      sync.acceptRemote(remote)
      applying.current = true
      const changedFiles = Object.values(canvasFiles(doc)).filter(file => addedFiles.get(file.id) !== file)
      if (changedFiles.length) { api.addFiles(changedFiles); changedFiles.forEach(file => addedFiles.set(file.id, file)) }
      api.updateScene({ elements: merged, appState: { currentItemFontFamily: CANVAS_FONT, viewBackgroundColor: doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff' }, captureUpdate: CaptureUpdateAction.NEVER })
      if (replay && merged.some(e => !e.isDeleted)) api.scrollToContent(merged.filter(e => !e.isDeleted), { fitToContent: true, animate: false })
      applying.current = false
    }
    const update = (_update: Uint8Array, origin: unknown) => {
      if (origin === sync || frame) return
      frame = requestAnimationFrame(renderRemote)
    }
    const flush = (event?: Event) => {
      sync.flush()
      if (rejected.current) event?.preventDefault()
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const pending = sync.hasPending || rejected.current
      flush()
      if (pending) { event.preventDefault(); event.returnValue = '' }
    }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    renderRemote()
    doc.on('update', update)
    window.addEventListener('sharecode:flush', flush)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      sync.destroy()
      syncRef.current = null
      if (frame) cancelAnimationFrame(frame)
      doc.off('update', update)
      window.removeEventListener('sharecode:flush', flush)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [api, doc, replay])

  // Flush already accepted edits before a disconnect/permission transition.
  useEffect(() => { if (!canEdit) syncRef.current?.flush() }, [canEdit])

  useCanvasFollow({ api, provider, followClientId, onFollowChange, presence, anonymous: t('canvas.anonymous') })

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if (applying.current || !canEditRef.current) return
    try {
      const normalized = monoCanvasElements(elements)
      if (appState.currentItemFontFamily !== CANVAS_FONT || normalized.some((e, i) => e !== elements[i])) {
        api?.updateScene({ elements: normalized, appState: { currentItemFontFamily: CANVAS_FONT }, captureUpdate: CaptureUpdateAction.NEVER })
      }
      syncRef.current?.stage(normalized, files, appState.newElement?.type === 'freedraw' ? appState.newElement.id : null, appState.viewBackgroundColor)
      rejected.current = false
      onPendingRef.current?.(syncRef.current?.hasPending ?? false)
      setError('')
    } catch {
      rejected.current = true
      onPendingRef.current?.(true)
      setError('fileTooLarge')
    }
  }, [api])

  return (
    <div className="sharecode-canvas h-full w-full relative" aria-label={t('canvas.title')}>
      {error && <div role="alert" className="absolute z-50 top-12 inset-x-2 rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground">{t(`canvas.${error}`)}</div>}
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        onPointerDown={() => { pointerDown.current = true }}
        onPointerUp={() => { pointerDown.current = false; queueMicrotask(() => syncRef.current?.flush()) }}
        onPointerUpdate={({ pointer, button }) => { presence.current = { pointer, button } }}
        theme={theme}
        langCode={i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en'}
        viewModeEnabled={!canEdit}
        isCollaborating={!!provider}
        handleKeyboardGlobally={false}
        autoFocus
        aiEnabled={false}
        validateEmbeddable={false}
        UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false, loadScene: canEdit, clearCanvas: canEdit, export: { saveFileToDisk: true } } }}
      >
        <MainMenu>
          {canEdit && <MainMenu.DefaultItems.LoadScene />}
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          {!replay && canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  )
}
