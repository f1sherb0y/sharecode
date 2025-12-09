import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

let monacoPromise: Promise<typeof import('monaco-editor')> | null = null

export async function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      // Configure Monaco workers before importing
      self.MonacoEnvironment = {
        getWorker(_, label) {
          switch (label) {
            case 'json':
              return new jsonWorker()
            case 'css':
            case 'scss':
            case 'less':
              return new cssWorker()
            case 'html':
            case 'handlebars':
            case 'razor':
              return new htmlWorker()
            case 'typescript':
            case 'javascript':
              return new tsWorker()
            default:
              return new editorWorker()
          }
        },
      }

      const monaco = await import('monaco-editor')
      return monaco
    })()
  }

  return monacoPromise
}
