import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import 'monaco-editor/min/vs/editor/editor.main.css'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution'
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController'

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
    monacoPromise = import('monaco-editor/esm/vs/editor/editor.api.js').then(
      (module) => {
        const monaco = module as unknown as typeof Monaco
        return monaco
      },
    )
  }

  return monacoPromise
}
