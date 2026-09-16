import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
// jsDelivr's ESM bundles can reference different peer versions. Keep React, Yjs
// and ProseMirror singletons aligned with the app (see audit-session-cdn.ts).
import cdnImports from './session-cdn-imports.json'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cdn = 'https://cdn.jsdelivr.net/npm/'
export const sessionCdnDependencies: Record<string, string> = {
  react: `${cdn}react@19.2.4/+esm`,
  'react/jsx-runtime': `${cdn}react@19.2.4/jsx-runtime/+esm`,
  'react-dom': `${cdn}react-dom@19.2.4/+esm`,
  'react-dom/client': `${cdn}react-dom@19.2.4/client/+esm`,
  '@excalidraw/excalidraw': `${cdn}@excalidraw/excalidraw@0.18.1/+esm`,
  mermaid: `${cdn}mermaid@11.16.1/dist/mermaid.esm.min.mjs`,
  katex: `${cdn}katex@0.16.47/dist/katex.mjs`,
  yjs: `${cdn}yjs@13.6.30/+esm`,
  pako: `${cdn}pako@2.1.0/+esm`,
  i18next: `${cdn}i18next@26.0.3/+esm`,
  'react-i18next': `${cdn}react-i18next@17.0.2/+esm`,
  'y-prosemirror': `${cdn}y-prosemirror@1.3.7/+esm`,
  'remark-math': `${cdn}remark-math@6.0.0/+esm`,
  '@radix-ui/react-select': `${cdn}@radix-ui/react-select@2.2.6/+esm`,
  '@radix-ui/react-slot': `${cdn}@radix-ui/react-slot@1.2.4/+esm`,
  'tailwind-merge': `${cdn}tailwind-merge@3.5.0/+esm`,
}
const styles = [`${cdn}@excalidraw/excalidraw@0.18.1/dist/prod/index.css`, `${cdn}katex@0.16.47/dist/katex.min.css`]


export async function buildSessionPlayer(): Promise<string> {
  const result = await build({
    configFile: false, root, publicDir: false, logLevel: 'warn',
    // A build invoked inside the dev server inherits NODE_ENV=development.
    // Explicitly emit production JSX to match the production React CDN runtime.
    oxc: { jsx: { development: false } },
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { alias: [
      { find: /^@\/i18n$/, replacement: resolve(root, 'src/export/i18n.ts') },
      { find: /^@\/lib\/monaco-loader$/, replacement: resolve(root, 'src/export/monaco-loader.ts') },
      { find: /^@\/lib\/utils$/, replacement: resolve(root, 'src/export/utils.ts') },
      { find: '@', replacement: resolve(root, 'src') },
    ] },
    plugins: [
      {
        name: 'session-player-assets', enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('@milkdown/kit/') && !id.endsWith('.css')) return { id: `${cdn}@milkdown/kit@7.22.1/${id.slice('@milkdown/kit/'.length)}/+esm`, external: true }
          if (sessionCdnDependencies[id]) return { id: sessionCdnDependencies[id], external: true }
          if (id === '@excalidraw/excalidraw/index.css' || id === 'katex/dist/katex.min.css') return '\0cdn-style'
          if (id === 'virtual:replay-translations') return '\0replay-translations'
        },
        load(id) {
          if (id === '\0cdn-style') return ''
          if (id !== '\0replay-translations') return
          const resources = Object.fromEntries(['en', 'zh'].map(lang => {
            const original = JSON.parse(readFileSync(resolve(root, `src/i18n/locales/${lang}.json`), 'utf8'))
            const playback = Object.fromEntries(['progress', 'goToStart', 'goToEnd', 'play', 'pause', 'speed', 'notes', 'exportTitle', 'exportTheme', 'exportUsers'].map(key => [key, original.playback[key]]))
            return [lang, { translation: { playback,
              common: { close: original.common.close },
              canvas: Object.fromEntries(['title', 'editor', 'canvas', 'switchView'].map(key => [key, original.canvas[key]])),
              editor: { toolbar: { renderingDiagram: original.editor.toolbar.renderingDiagram } } } }]
          }))
          return `export default ${JSON.stringify(resources)}`
        },
        transform(code, id) {
          if (id.includes('/src/lib/milkdown-mermaid.ts')) return code.replace("securityLevel: 'loose'", "securityLevel: 'strict'")
          if (id.includes('/src/styles/globals.css')) return code.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../export/runtime.tsx";\n@source "../components/ui/button.tsx";\n@source "../components/ui/select.tsx";\n@source "../components/features/playback-controls.tsx";\n@source "../components/features/room-view-switch.tsx";').replace('/fonts/JuliaMono-Regular.woff2', 'https://cdn.jsdelivr.net/gh/cormullion/juliamono@v0.062/webfonts/JuliaMono-Regular.woff2')
        },
      }, react(), tailwindcss(),
    ],
    build: {
      write: false, emptyOutDir: false, sourcemap: false, minify: 'oxc', target: 'es2022', cssCodeSplit: false,
      lib: { entry: resolve(root, 'src/export/runtime.tsx'), name: 'SessionPlayer', formats: ['es'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  const bundle = (Array.isArray(result) ? result[0] : result)
  if (!bundle || !('output' in bundle)) throw new Error('Could not build session player')
  const js = bundle.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n')
  const css = bundle.output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString()).join('\n')
  const extras = bundle.output.filter(item => item.type === 'asset' && !item.fileName.endsWith('.css'))
  if (extras.length) throw new Error(`Player emitted unexpected local assets: ${extras.map(item => item.fileName).join(', ')}`)
  const packed = gzipSync(JSON.stringify({ js: js.replaceAll('sharecode-canvas', 'session-canvas'), css: css.replaceAll('sharecode-canvas', 'session-canvas') }), { level: 9 }).toString('base64')
  // Bootstrap only decompresses our player code. Session content stays in a separate
  // base64 data block and is never interpreted as JavaScript or interpolated into HTML.
  const bootstrap = `const failed=()=>{document.getElementById('loading').hidden=false;document.getElementById('loading').textContent='Could not load replay dependencies. Check your internet connection and reopen this file. / 无法加载回放组件，请检查网络后重新打开。'};window.addEventListener('error',failed,{once:true});try{const bytes=Uint8Array.from(atob(document.getElementById('player-code').textContent),c=>c.charCodeAt(0));const source=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();const style=document.createElement('style');style.textContent=source.css;document.head.append(style);const script=document.createElement('script');script.type='module';script.textContent=source.js;script.onerror=failed;document.body.append(script)}catch{failed()}`
  const csp = "default-src 'none'; script-src 'unsafe-inline' blob: https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src data: blob:; font-src data: https://cdn.jsdelivr.net https://esm.sh; worker-src blob:; connect-src https://cdn.jsdelivr.net; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Session replay</title>${styles.map(href => `<link rel="stylesheet" href="${href}" crossorigin="anonymous">`).join('')}<script type="importmap">${JSON.stringify({ imports: cdnImports })}</script></head><body><div id="loading" role="status">Loading replay… / 正在加载回放…</div><div id="root"></div><script id="session-data" type="application/octet-stream">__SESSION_PAYLOAD__</script><script id="player-code" type="application/octet-stream">${packed}</script><script type="module">${bootstrap}</script></body></html>`
}

export function sessionPlayerPlugin(): Plugin {
  let dev = false, pending: Promise<string> | undefined
  const template = () => pending ??= buildSessionPlayer().catch(error => { pending = undefined; throw error })
  return {
    name: 'session-player',
    configResolved(config) { dev = config.command === 'serve' },
    resolveId(id) { if (id === 'virtual:session-player-url') return '\0session-player-url' },
    async load(id) {
      if (id !== '\0session-player-url') return
      if (dev) return 'export default "/__session-player.html"'
      const ref = this.emitFile({ type: 'asset', name: 'session-player.html', source: await template() })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },
    configureServer(server) {
      server.watcher.on('change', path => { if (path.includes('/src/') || path.includes('/tooling/')) pending = undefined })
      server.middlewares.use('/__session-player.html', (_req, res) => {
        void template().then(html => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store'); res.end(html) })
          .catch(error => { server.config.logger.error(String(error)); res.statusCode = 500; res.end('Could not build session player') })
      })
    },
  }
}
