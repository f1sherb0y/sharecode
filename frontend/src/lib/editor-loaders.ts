// Reuse the same import promises for intent preloading and React.lazy.
// Hashed URLs use the browser's persistent HTTP cache across page visits.
let canvas: ReturnType<typeof importCanvas> | undefined
let markdown: ReturnType<typeof importMarkdown> | undefined
const importCanvas = () => import('@/components/features/canvas-view')
const importMarkdown = () => import('@/components/features/markdown-editor')
export const loadCanvasView = () => canvas ??= importCanvas().catch(error => { canvas = undefined; throw error })
export const loadMarkdownEditor = () => markdown ??= importMarkdown().catch(error => { markdown = undefined; throw error })
export function prepareEditorView(view: 'canvas' | 'editor', isMarkdown: boolean) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || connection?.effectiveType?.includes('2g')) return
  const load = view === 'canvas' ? loadCanvasView() : isMarkdown ? loadMarkdownEditor()
    : import('./monaco-loader').then(module => module.loadMonaco())
  void load.catch(() => {}) // A failed speculative request must not interrupt the current editor.
}
