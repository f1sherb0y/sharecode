import './i18n'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { Moon, Sun, StickyNote } from 'lucide-react'
import * as Y from 'yjs'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Editor, rootCtx, editorViewOptionsCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark, imageSchema } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { replaceAll, $view } from '@milkdown/kit/utils'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { mathPlugins } from '@/lib/milkdown-math'
import { mermaidPlugins } from '@/lib/milkdown-mermaid'
import { loadMonaco } from '@/lib/monaco-loader'
import { createMonacoEditorOptions, resolveMonacoLanguage } from '@/lib/monaco-config'
import { DocumentReplay } from '@/lib/document-replay'
import { CANVAS_FONT, monoCanvasElements } from '@/lib/canvas-font'
import { DEFAULT_EDITOR_FONT_SIZE, EDITOR_FONT_STACK, loadEditorFont, watchEditorFontMetrics } from '@/lib/editor-font'
import { canvasFiles, orderedCanvasElements } from '@/lib/canvas-sync'
import { PlaybackControls } from '@/components/features/playback-controls'
import { RoomViewSwitch } from '@/components/features/room-view-switch'
import { Button } from '@/components/ui/button'
import { unpackSession, decodeBytes } from './data'
import type { Language } from '@/types'
import type * as Monaco from 'monaco-editor'
import '@/styles/globals.css'
import '@/styles/markdown.css'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'
import '@excalidraw/excalidraw/index.css'
import '@/styles/canvas.css'

(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = 'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/'
const session = unpackSession(document.getElementById('session-data')!.textContent!)
const fontFamily = EDITOR_FONT_STACK
const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  return `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
const imagePlugin = $view(imageSchema.node, () => node => {
  const img = document.createElement('img')
  const src = String(node.attrs.src ?? '')
  img.src = session.images[src] ?? (src.startsWith('data:image/') ? src : '')
  img.alt = String(node.attrs.alt ?? '')
  return { dom: img }
})
function Code({ doc, language, theme, timestamp }: { doc: Y.Doc; language: Language; theme: 'light' | 'dark'; timestamp: number }) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const latest = useRef({ doc, language, theme }); latest.current = { doc, language, theme }
  useEffect(() => {
    let cancelled = false
    let model: Monaco.editor.ITextModel | undefined
    let stopFontWatch: (() => void) | undefined
    void loadMonaco().then(monaco => {
      if (cancelled || !root.current) return
      const state = latest.current
      stopFontWatch = watchEditorFontMetrics(() => monaco.editor.remeasureFonts())
      void loadEditorFont().then(() => {
        if (!cancelled) monaco.editor.remeasureFonts()
      }).catch(() => {})
      model = monaco.editor.createModel(state.doc.getText('codemirror').toString(), resolveMonacoLanguage(state.language))
      editor.current = monaco.editor.create(root.current, createMonacoEditorOptions({ model, fontFamily, fontSize: DEFAULT_EDITOR_FONT_SIZE, readOnly: true, theme: state.theme }))
    })
    return () => { cancelled = true; stopFontWatch?.(); editor.current?.dispose(); editor.current = null; model?.dispose() }
  }, [])
  useEffect(() => {
    void loadMonaco().then(monaco => {
      const model = editor.current?.getModel()
      if (!model) return
      const value = latest.current.doc.getText('codemirror').toString()
      if (model.getValue() !== value) model.setValue(value)
      monaco.editor.setModelLanguage(model, resolveMonacoLanguage(latest.current.language))
      monaco.editor.setTheme(latest.current.theme === 'dark' ? 'vs-dark' : 'vs')
    })
  }, [doc, language, theme, timestamp])
  return <div ref={root} className="h-full w-full" />
}
function Markdown({ doc, timestamp, theme }: { doc: Y.Doc; timestamp: number; theme: string }) {
  const root = useRef<HTMLDivElement>(null), editor = useRef<Editor | null>(null), latest = useRef(doc), last = useRef('')
  latest.current = doc
  const render = () => {
    if (!editor.current) return
    const current = latest.current
    const text = current.getMap('meta').get('markdownInitialized') || current.getXmlFragment('prosemirror').length
      ? editor.current.action(ctx => ctx.get(serializerCtx)(yXmlFragmentToProseMirrorRootNode(current.getXmlFragment('prosemirror'), ctx.get(schemaCtx))))
      : current.getText('codemirror').toString()
    if (last.current !== text) { editor.current.action(replaceAll(text)); last.current = text }
  }
  useEffect(() => {
    let cancelled = false
    const instance = Editor.make().config(ctx => { ctx.set(rootCtx, root.current); ctx.update(editorViewOptionsCtx, prev => ({ ...prev, editable: () => false })) })
      .use(commonmark).use(gfm).use(mathPlugins).use(mermaidPlugins).use(imagePlugin)
    void instance.create().then(() => { if (cancelled) { void instance.destroy(); return }; editor.current = instance; last.current = ''; render() })
    return () => { cancelled = true; editor.current = null; void instance.destroy() }
  }, [theme])
  useEffect(render, [doc, timestamp])
  return <div className="md-editor h-full overflow-y-auto" style={{ '--md-font-size': `${DEFAULT_EDITOR_FONT_SIZE}px`, '--md-font-family': fontFamily } as CSSProperties}><div ref={root} translate="no" className="notranslate min-h-full" /></div>
}
function Canvas({ doc, timestamp, theme }: { doc: Y.Doc; timestamp: number; theme: 'light' | 'dark' }) {
  const { i18n } = useTranslation()
  const [library, setLibrary] = useState<typeof import('@excalidraw/excalidraw') | null>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [ready, setReady] = useState(false)
  const scene = useMemo(() => ({
    elements: monoCanvasElements(orderedCanvasElements(doc)), files: canvasFiles(doc),
    appState: { currentItemFontFamily: CANVAS_FONT, viewBackgroundColor: doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff' },
    scrollToContent: true,
  }), [doc, timestamp])
  useEffect(() => {
    let cancelled = false
    void Promise.all([import('@excalidraw/excalidraw'), Promise.race([
      loadEditorFont().catch(() => {}), new Promise(resolve => setTimeout(resolve, 250)),
    ])]).then(([library]) => {
      // The standalone player uses upstream CDN JS. Keep the legacy numeric
      // ID accessible to vendor internals, but let its family-name lookup
      // resolve to Sarasa. No browser globals or drawing APIs are patched.
      const families = library.FONT_FAMILY as unknown as Record<string, number>
      if (families.Cascadia !== CANVAS_FONT) throw new Error('Unexpected Canvas font IDs')
      Object.defineProperty(families, 'Cascadia', { enumerable: false })
      families[EDITOR_FONT_STACK] = CANVAS_FONT
      if (!cancelled) setLibrary(library)
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    // The API arrives before async scene initialization, which would overwrite
    // an early updateScene. Apply the latest frame once initialization finishes.
    if (!api || !library || !ready) return
    // Let Excalidraw finish clearing its initial image cache before adding files.
    const frame = requestAnimationFrame(() => {
      const { elements, files, appState } = scene
      api.updateScene({ elements, appState, captureUpdate: library.CaptureUpdateAction.NEVER })
      api.addFiles(Object.values(files))
      if (elements.some(e => !e.isDeleted)) api.scrollToContent(elements.filter(e => !e.isDeleted), { fitToContent: true, animate: false })
    })
    return () => cancelAnimationFrame(frame)
  }, [api, scene, library, ready])
  if (!library) return null
  const { Excalidraw, MainMenu } = library
  return <div className="sharecode-canvas h-full w-full"><Excalidraw excalidrawAPI={setApi} theme={theme} langCode={i18n.resolvedLanguage === 'zh' ? 'zh-CN' : 'en'}
    initialData={scene} onChange={(_, state) => { if (!state.isLoading) setReady(true) }}
    viewModeEnabled handleKeyboardGlobally={false} aiEnabled={false} validateEmbeddable={false}
    UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, clearCanvas: false, export: false, saveAsImage: false, toggleTheme: false } }}>
    <MainMenu />
  </Excalidraw></div>
}
function Player() {
  const { t, i18n } = useTranslation()
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1)
  const [view, setView] = useState<'editor' | 'canvas'>('editor'), [notes, setNotes] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const updates = useMemo(() => session.updates.map(u => ({ timestampMs: u.at, update: u.data ? decodeBytes(u.data) : new Uint8Array([0, 0]) })), [])
  const replay = useMemo(() => new DocumentReplay(updates), [updates])
  const revision = useMemo(() => {
    let lo = 0, hi = session.updates.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (session.updates[mid]!.at <= time) lo = mid + 1; else hi = mid }
    return lo - 1
  }, [time])
  const doc = useMemo(() => replay.seek(session.updates[revision]?.at ?? 0), [replay, revision])
  const language = (doc.getMap('meta').get('language') as Language | undefined) ?? session.language
  const actor = session.updates[revision]?.actor
  useEffect(() => () => replay.destroy(), [replay])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage === 'zh' ? 'zh-CN' : 'en'
    document.title = t('playback.exportTitle')
  }, [i18n.resolvedLanguage, t])
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(), elapsed = (now - last) * speed; last = now
      setTime(value => { if (value + elapsed >= session.duration) { setPlaying(false); return session.duration }; return value + elapsed })
    }, 50)
    return () => clearInterval(timer)
  }, [playing, speed])
  return <div className="playback-shell flex flex-col safe-x h-screen" style={{ height: '100dvh' }}>
    <header className="flex items-center justify-between border-b bg-background shrink-0 gap-1 h-9 px-1.5">
      <div className="flex items-center gap-1 min-w-0"><span className="font-medium truncate text-sm">{t('playback.exportTitle')}</span><span className="text-xs text-muted-foreground hidden sm:inline">{language}</span></div>
      <RoomViewSwitch value={view} onChange={setView} />
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => { void i18n.changeLanguage(i18n.resolvedLanguage === 'zh' ? 'en' : 'zh') }} aria-label="Language / 语言">{i18n.resolvedLanguage === 'zh' ? 'EN' : '中文'}</Button>
        <Button size="icon" variant="ghost" aria-label={t('playback.exportTheme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
        {!!session.notes.length && <Button size="icon" variant={notes ? 'secondary' : 'ghost'} aria-label={t('playback.notes')} onClick={() => setNotes(!notes)}><StickyNote /></Button>}
      </div>
    </header>
    {!!session.users && <div className="flex items-center gap-2 px-2 py-0.5 border-b overflow-x-auto shrink-0" aria-label={t('playback.exportUsers')}>
      {Array.from({ length: session.users }, (_, i) => <span key={i} className="inline-flex items-center gap-1 text-xs whitespace-nowrap" style={{ fontWeight: actor === i + 1 ? 700 : 400 }} aria-current={actor === i + 1 ? 'true' : undefined}><span className="w-2 h-2 rounded-full" style={{ background: `hsl(${(i * 137.508 + 215) % 360} 65% 50%)` }} />user{i + 1}</span>)}
    </div>}
    <main className="relative flex-1 flex overflow-hidden min-w-0 min-h-0">
      <div className="flex-1 overflow-hidden min-w-0">
        <div className={view === 'editor' && language !== 'markdown' ? 'h-full' : 'hidden'}><Code doc={doc} language={language} theme={theme} timestamp={revision} /></div>
        {view === 'canvas' ? <Canvas doc={doc} timestamp={revision} theme={theme} /> : language === 'markdown' ? <Markdown doc={doc} timestamp={revision} theme={theme} /> : null}
      </div>
      {notes && <aside className="absolute inset-y-0 right-0 z-10 w-[min(18rem,78vw)] sm:static sm:w-64 border-l bg-background flex flex-col"><div className="text-xs font-medium px-2 py-1.5 border-b">{t('playback.notes')}</div><div className="overflow-auto p-1.5">{session.notes.map((text, i) => <p className="whitespace-pre-wrap break-words text-sm border-b py-1.5" key={i}>{text}</p>)}</div></aside>}
    </main>
    <PlaybackControls startMs={0} endMs={session.duration} currentTimestamp={time} playbackSpeed={speed} isPlaying={playing} updates={updates}
      timeLabel={`${clock(time)} / ${clock(session.duration)}`} onSeek={setTime} onPlayingChange={value => { if (value && time >= session.duration) setTime(0); setPlaying(value) }} onSpeedChange={setSpeed} />
  </div>
}
// Content is untrusted. No submitted form, frame, network connection or automatic navigation.
document.addEventListener('click', event => { if ((event.target as Element).closest?.('a')) event.preventDefault() }, true)
document.getElementById('loading')!.hidden = true
createRoot(document.getElementById('root')!).render(<Player />)
