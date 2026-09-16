/** Re-audit CDN peer dependencies after upgrading exported player dependencies.
 * Run: bun tooling/audit-session-cdn.ts [--write]
 * This does NOT run during normal builds; builds use the checked-in import map.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionCdnDependencies } from './session-player'

const base = 'https://cdn.jsdelivr.net'
const frontend = fileURLToPath(new URL('../', import.meta.url))
const packages = ['react', 'react-dom', 'yjs', 'i18next', 'prosemirror-model', 'prosemirror-state', 'prosemirror-transform', 'prosemirror-view']
const versions = Object.fromEntries(await Promise.all(packages.map(async name => [name, JSON.parse(await readFile(resolve(frontend, `node_modules/${name}/package.json`), 'utf8')).version])))
const roots = [...Object.values(sessionCdnDependencies).filter(url => url.endsWith('/+esm')),
  ...['core', 'preset/commonmark', 'preset/gfm', 'utils', 'prose/model', 'prose/view', 'prose/inputrules', 'prose/commands', 'prose/state']
    .map(path => `${base}/npm/@milkdown/kit@7.22.1/${path}/+esm`)]
const visited = new Set<string>(), queue = new Set(roots), imports: Record<string, string> = {}
const peer = new RegExp(`^/npm/(${packages.join('|')})@[^/]+(/[^?]*)$`)
while (queue.size) {
  const batch = [...queue].slice(0, 12)
  batch.forEach(url => { queue.delete(url); visited.add(url) })
  await Promise.all(batch.map(async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(40_000) })
    if (!response.ok) throw new Error(`${response.status}: ${url}`)
    const source = await response.text()
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?)['"](\/npm\/[^'"]+)['"]/g)) {
      const path = match[1]!, original = base + path, singleton = path.match(peer)
      const target = singleton ? `${base}/npm/${singleton[1]}@${versions[singleton[1]!]}${singleton[2]}` : original
      if (target !== original) imports[original] = target
      if (!visited.has(target)) queue.add(target)
    }
  }))
}
const result = JSON.stringify(Object.fromEntries(Object.entries(imports).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n'
const filename = resolve(frontend, 'tooling/session-cdn-imports.json')
if (process.argv.includes('--write')) await writeFile(filename, result)
else {
  const current = JSON.parse(await readFile(filename, 'utf8'))
  for (const [url, target] of Object.entries(imports)) if (current[url] !== target) throw new Error(`Missing peer mapping: ${url} -> ${target}. Run with --write, rebuild and run session-export-browser.ts.`)
}
console.log(`Audited ${visited.size} CDN modules; ${Object.keys(imports).length} singleton mappings.`)
