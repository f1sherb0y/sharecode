import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Excalidraw, CaptureUpdateAction, MainMenu } from '@excalidraw/excalidraw'
import type { AppState, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import { CanvasSync, canvasFiles, orderedCanvasElements, containViewport, CANVAS_INTERVAL, type CanvasViewport } from '@/lib/canvas-sync'
import '@excalidraw/excalidraw/index.css'
import '@/styles/canvas.css'

interface CanvasViewProps {
  doc: Y.Doc
  canEdit: boolean
  theme: 'light' | 'dark'
  provider?: HocuspocusProvider | null
  followClientId?: number | null
  onPending?: (pending: boolean) => void
  replay?: boolean
}
interface CanvasPresence {
  viewport?: CanvasViewport
  pointer?: Collaborator['pointer']
  button?: 'up' | 'down'
}

export function CanvasView({ doc, canEdit, theme, provider, followClientId, onPending, replay = false }: CanvasViewProps) {
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
  const initialData = useMemo(() => ({ elements: orderedCanvasElements(doc), files: canvasFiles(doc), appState: { viewBackgroundColor: doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff' }, scrollToContent: true }), [doc])

  useEffect(() => {
    if (!api) return
    const sync = new CanvasSync(doc, pending => onPendingRef.current?.(pending || rejected.current))
    syncRef.current = sync
    let frame = 0
    const addedFiles = new Map<string, BinaryFiles[string]>()
    const renderRemote = () => {
      frame = 0
      const remote = orderedCanvasElements(doc)
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
      api.updateScene({ elements: merged, appState: { viewBackgroundColor: doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff' }, captureUpdate: CaptureUpdateAction.NEVER })
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

  useEffect(() => {
    const awareness = provider?.awareness
    if (!api || !awareness) return
    let lastPresence = ''
    const applyFollow = () => {
      const app = api.getAppState()
      const target = followClientId != null ? awareness.getStates().get(followClientId) : undefined
      const viewport = (target?.canvas as CanvasPresence | undefined)?.viewport
      if (target?.view === 'canvas' && viewport) {
        const fit = containViewport(viewport, app.width, app.height)
        if (fit && (Math.abs(app.zoom.value - fit.zoom) > 0.00001 || Math.abs(app.scrollX - fit.scrollX) > 0.01 || Math.abs(app.scrollY - fit.scrollY) > 0.01)) {
          api.updateScene({ appState: { scrollX: fit.scrollX, scrollY: fit.scrollY, zoom: { value: fit.zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER })
        }
      }
    }
    const refresh = () => {
      applyFollow()
      const collaborators = new Map<SocketId, Collaborator>()
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID || state.view !== 'canvas') return
        const p = state.canvas as CanvasPresence | undefined
        collaborators.set(String(id) as SocketId, { pointer: p?.pointer, button: p?.button,
          username: state.user?.name ?? state.user?.username ?? t('canvas.anonymous'),
          color: state.user?.color ? { background: state.user.color, stroke: state.user.color } : undefined })
      })
      api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
    }
    const publish = () => {
      const app = api.getAppState()
      // Followers advertise the original viewport, avoiding recursive zoom-out
      // when someone follows a follower with a different aspect ratio.
      const target = followClientId != null ? awareness.getStates().get(followClientId) : undefined
      const viewport = target?.view === 'canvas' ? target.canvas?.viewport as CanvasViewport | undefined : undefined
      const next: CanvasPresence = { ...presence.current, viewport: viewport ?? {
        x: -app.scrollX, y: -app.scrollY, width: app.width / app.zoom.value, height: app.height / app.zoom.value,
      } }
      const signature = JSON.stringify(next)
      if (signature !== lastPresence) { lastPresence = signature; awareness.setLocalStateField('canvas', next) }
      applyFollow() // Also handles follower viewport resize without a presenter event.
    }
    awareness.on('change', refresh)
    publish()
    const timer = setInterval(publish, CANVAS_INTERVAL)
    return () => {
      clearInterval(timer)
      awareness.off('change', refresh)
      awareness.setLocalStateField('canvas', null)
    }
  }, [api, provider, followClientId, t])

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if (applying.current || !canEditRef.current) return
    try {
      syncRef.current?.stage(elements, files, appState.newElement?.type === 'freedraw' ? appState.newElement.id : null, appState.viewBackgroundColor)
      rejected.current = false
      onPendingRef.current?.(syncRef.current?.hasPending ?? false)
      setError('')
    } catch {
      rejected.current = true
      onPendingRef.current?.(true)
      setError('fileTooLarge')
    }
  }, [])

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
