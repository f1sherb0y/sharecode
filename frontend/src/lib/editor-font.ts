export const EDITOR_FONT = 'Sarasa Mono'
export const DEFAULT_EDITOR_FONT_SIZE = 13
export const EDITOR_FONT_STACK = '"Sarasa Mono", monospace'
export const SARASA_CDN_BASE = 'https://cdn.jsdelivr.net/npm/sarasa-mono-web@0.1.0/fonts/SarasaMonoCL-Regular/'

// Register unicode-range descriptors lazily. The browser fetches only the
// WOFF2 subsets used by visible text, never the complete CJK font collection.
export async function loadEditorFont(text = 'M') {
  const { registerSarasaFonts } = await import('@/lib/sarasa-font')
  await registerSarasaFonts()
  return document.fonts.load(`12px "${EDITOR_FONT}"`, text)
}

// New CJK subsets can arrive long after the initial Latin font. Monaco caches
// glyph measurements, so invalidate them after each font-loading batch.
export function watchEditorFontMetrics(remeasure: () => void) {
  const loaded = (event: FontFaceSetLoadEvent) => {
    if (event.fontfaces.some(face => face.family.replace(/"/g, '') === EDITOR_FONT)) remeasure()
  }
  document.fonts.addEventListener('loadingdone', loaded)
  return () => document.fonts.removeEventListener('loadingdone', loaded)
}
