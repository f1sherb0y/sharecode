import subsets from './sarasa-subsets.json'
import { EDITOR_FONT, SARASA_CDN_BASE } from './editor-font'

export const sarasaFontDescriptors = subsets.map(({ file, unicodeRange }) => ({
  uri: SARASA_CDN_BASE + file,
  descriptors: { unicodeRange },
}))
const faces = new Map<string, FontFace>()

// Shared with Excalidraw's registry, including its SVG font-embedding path.
// Using the same FontFace objects avoids duplicate registration across editors.
export function sarasaFontFace(uri: string, descriptors: FontFaceDescriptors) {
  let face = faces.get(uri)
  if (!face) {
    face = new FontFace(EDITOR_FONT, `url("${uri}") format("woff2")`, {
      display: 'swap', style: 'normal', weight: '400', ...descriptors,
    })
    faces.set(uri, face)
  }
  return face
}

export function registerSarasaFonts() {
  for (const { uri, descriptors } of sarasaFontDescriptors) {
    const face = sarasaFontFace(uri, descriptors)
    if (!document.fonts.has(face)) document.fonts.add(face)
  }
}
