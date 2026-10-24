import type { Plugin } from 'vite'

/** Fails the customer client build when code from outside the session flow reaches the bundle.
 * The client ships the share and room pages only; the rest of the site must stay out. */
export function clientScopeGuard(srcDir: string): Plugin {
  const src = `${srcDir.replaceAll('\\', '/').replace(/\/$/, '')}/`
  const allowedPages = new Set(['pages/share.tsx', 'pages/editor.tsx'])
  const forbiddenDirs = ['components/schedule/', 'components/work-table/', 'components/layout/', 'export/']
  const isForbidden = (path: string) =>
    path === 'App.tsx' ||
    path === 'main.tsx' ||
    path === 'components/features/share-link-manager.tsx' ||
    (path.startsWith('pages/') && !allowedPages.has(path)) ||
    forbiddenDirs.some((dir) => path.startsWith(dir))

  return {
    name: 'client-scope-guard',
    apply: 'build',
    generateBundle(_, bundle) {
      const leaks = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, info] of Object.entries(output.modules)) {
          const file = id.replaceAll('\\', '/')
          if (!file.startsWith(src)) continue
          const path = file.slice(src.length)
          if (isForbidden(path)) leaks.add(path)
          // The staff app's window helpers (capture protection, taskbar hiding) must not ship.
          const exported = info.renderedExports ?? []
          if (path === 'lib/tauri.ts' && exported.some((name) => name !== 'isTauriApp')) {
            leaks.add(`${path} (${exported.join(', ')})`)
          }
        }
      }
      if (leaks.size > 0) {
        this.error(`The client bundle includes code outside the session flow:\n  ${[...leaks].join('\n  ')}`)
      }
    },
  }
}
