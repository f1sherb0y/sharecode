import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController'
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations'

import type * as monaco from 'monaco-editor'

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

    const workers: Record<string, () => Worker> = {
        json: () => new jsonWorker(),
        css: () => new cssWorker(),
        scss: () => new cssWorker(),
        less: () => new cssWorker(),
        html: () => new htmlWorker(),
        handlebars: () => new htmlWorker(),
        razor: () => new htmlWorker(),
        typescript: () => new tsWorker(),
        javascript: () => new tsWorker(),
    }

    window.MonacoEnvironment = {
        getWorker(_, label) {
            if (workers[label]) {
                return workers[label]()
            }
            return new editorWorker()
        },
    }
}

let monacoPromise: Promise<typeof monaco> | null = null

export const loadMonaco = () => {
    if (!monacoPromise) {
        setupEnvironment()
        monacoPromise = import('monaco-editor/esm/vs/editor/editor.api')
    }

    return monacoPromise
}
