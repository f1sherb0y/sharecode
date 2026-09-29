import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Excalidraw 0.18.1 has no public font-registry option. Keep this small,
 * version-guarded adaptation in the build rather than mutating browser APIs.
 * Both dev and production use the same single font and real monospace fallback.
 * Fail closed when upgrading the vendor, so new font downloads cannot slip in.
 */
export function canvasFontPlugin(): Plugin {
  return {
    name: 'canvas-single-font',
    enforce: 'pre',
    configResolved(config) {
      const { version } = JSON.parse(readFileSync(resolve(config.root, 'node_modules/@excalidraw/excalidraw/package.json'), 'utf8'))
      if (version !== '0.18.1') throw new Error('Re-audit the Excalidraw single-font adapter before upgrading.')
    },
    transform(code, id) {
      // Vite appends dependency-version queries to excluded vendor modules.
      id = id.split('?')[0]!
      if (id.includes('/monaco-editor/') && id.endsWith('.css')) {
        return code.replace(/url\((?:["'])?[^)]*codicon\.ttf(?:["'])?\)/g,
          'url("https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf")')
      }
      if (!id.includes('/@excalidraw/excalidraw/dist/')) return
      if (id.endsWith('/index.css')) {
        return code.replace(/@font-face\s*\{[^}]*\}/g, '').replaceAll('"Assistant"', '"Sarasa Mono", monospace')
      }
      if (!id.endsWith('/chunk-4FTI6OG3.js') && !id.endsWith('/chunk-K2UTITRG.js')) return
      const dev = id.includes('/dev/')
      const family = dev
        ? /var getFontFamilyString = \(\{[\s\S]*?\n\};/
        : /ea=\(\{fontFamily:e\}\)=>\{for\(let\[t,n\]of Object\.entries\(Ie\)\)[\s\S]*?return Tn\}/
      const registry = dev
        ? /    init\("Cascadia",[\s\S]*?    init\(WINDOWS_EMOJI_FALLBACK_FONT, \.\.\.EmojiFontFaces\);/
        : /n\("Cascadia",\.\.\.Gd\),[\s\S]*?n\(Tn,\.\.\.jd\),/
      const face = dev
        ? /this\.fontFace = new FontFace\(family, sources, \{[\s\S]*?\}\);/
        : /this\.fontFace=new FontFace\(t,o,\{display:"swap",style:"normal",weight:"400",\.\.\.r\}\)/
      const metrics = dev
        ? /\[FONT_FAMILY\.Cascadia\]: \{\s*metrics: \{[^}]+\}/
        : /\[Ie\.Cascadia\]:\{metrics:\{[^}]+\}/
      if (![family, registry, face, metrics].every(pattern => pattern.test(code))) throw new Error('Re-audit the Excalidraw font adapter after upgrading @excalidraw/excalidraw.')
      // Keep persisted family ID 3, but replace its face, metrics and display
      // family. SVG export can still subset/embed the actual Sarasa glyphs.
      return 'import { sarasaFontDescriptors, sarasaFontFace } from "@/lib/sarasa-font";\n' + code
        .replace(family, `${dev ? 'var getFontFamilyString = ' : 'ea='}()=>${JSON.stringify('"Sarasa Mono", monospace')}${dev ? ';' : ''}`)
        .replace(registry, dev ? '    init("Cascadia", ...sarasaFontDescriptors);' : 'n("Cascadia",...sarasaFontDescriptors),')
        .replace(face, dev ? 'this.fontFace = sarasaFontFace(uri, descriptors);' : 'this.fontFace=sarasaFontFace(n,r)')
        .replace(metrics, `${dev ? '[FONT_FAMILY.Cascadia]: { metrics: ' : '[Ie.Cascadia]:{metrics:'}{unitsPerEm:1000,ascender:965,descender:-285,lineHeight:1.25}`)
    },
  }
}
