import type * as Monaco from 'monaco-editor'
const base = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs'
type AmdRequire = { (modules: string[], ready: () => void, error: (error: unknown) => void): void; config: (value: unknown) => void }
let pending: Promise<typeof Monaco> | undefined
export function loadMonaco(): Promise<typeof Monaco> {
  return pending ??= new Promise((resolve, reject) => {
    const globals = window as unknown as { require: AmdRequire; monaco: typeof Monaco; MonacoEnvironment: unknown }
    const worker = URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:${JSON.stringify(base + '/../')}};importScripts(${JSON.stringify(base + '/base/worker/workerMain.js')});`], { type: 'text/javascript' }))
    globals.MonacoEnvironment = { getWorkerUrl: () => worker }
    const script = document.createElement('script')
    script.src = `${base}/loader.js`; script.crossOrigin = 'anonymous'; script.referrerPolicy = 'no-referrer'
    script.onerror = () => reject(new Error('Could not load editor from CDN'))
    script.onload = () => {
      globals.require.config({ paths: { vs: base } })
      globals.require(['vs/editor/editor.main'], () => resolve(globals.monaco), reject)
    }
    document.head.append(script)
  })
}
