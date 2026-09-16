import i18n from '@/i18n'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import 'monaco-editor/min/vs/editor/editor.main.css'

import type * as Monaco from 'monaco-editor'

type MonacoEnvironment = {
  getWorker?: (moduleId: string, label: string) => Worker
}

declare global {
  interface Window {
    MonacoEnvironment?: MonacoEnvironment
  }
}

const setupEnvironment = () => {
  if (typeof window === 'undefined') return
  if (window.MonacoEnvironment?.getWorker) return

  window.MonacoEnvironment = {
    getWorker() {
      return new editorWorker()
    },
  }
}

let monacoPromise: Promise<typeof Monaco> | null = null

export const loadMonaco = () => {
  if (!monacoPromise) {
    setupEnvironment()
    monacoPromise = (async () => {
      // Monaco resolves module-level messages once. Load its locale before any
      // editor modules; changing this language later requires a page reload.
      if (i18n.resolvedLanguage === 'zh') {
        await import('monaco-editor/esm/nls.messages.zh-cn.js')
      }
      const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js')
      await Promise.all([
        import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'),
        import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'),
        import('monaco-editor/esm/vs/basic-languages/python/python.contribution'),
        import('monaco-editor/esm/vs/basic-languages/java/java.contribution'),
        import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'),
        import('monaco-editor/esm/vs/basic-languages/rust/rust.contribution'),
        import('monaco-editor/esm/vs/basic-languages/go/go.contribution'),
        import('monaco-editor/esm/vs/basic-languages/php/php.contribution'),
        import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'),
        import('monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution'),
        import('monaco-editor/esm/vs/editor/contrib/find/browser/findController'),
      ])
      return monaco as unknown as typeof Monaco
    })()
  }

  return monacoPromise
}
