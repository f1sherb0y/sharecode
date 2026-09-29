// bun tooling/update-sarasa-subsets.ts
// Font binaries stay on the CDN; only their unicode-range metadata is vendored.
import { writeFile } from 'node:fs/promises'
import { SARASA_CDN_BASE } from '../src/lib/editor-font'

const response = await fetch(`${SARASA_CDN_BASE}SarasaMonoCL-Regular.css`)
if (!response.ok) throw new Error(`Font manifest request failed: ${response.status}`)
const css = await response.text()
const subsets = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(([, block]) => {
  const file = block!.match(/url\('([^']+)'\)/)?.[1]
  const unicodeRange = block!.match(/unicode-range:\s*([^;]+)/)?.[1]
  if (!file || !/^SarasaMonoCL-Regular\.\d+\.woff2$/.test(file) || !unicodeRange || !/^U\+[0-9a-f]+(?:-[0-9a-f]+)?(?:,U\+[0-9a-f]+(?:-[0-9a-f]+)?)*$/i.test(unicodeRange)) {
    throw new Error('Unexpected Sarasa font stylesheet: re-audit before updating')
  }
  return { file, unicodeRange }
})
if (subsets.length !== 97) throw new Error('Expected 97 pinned Sarasa subsets')
await writeFile(new URL('../src/lib/sarasa-subsets.json', import.meta.url), JSON.stringify(subsets) + '\n')
console.log(`Updated ${subsets.length} Sarasa Mono subset descriptors`)
