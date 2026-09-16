import * as Y from 'yjs'

export const LINE_ENDING_NORMALIZATION_ORIGIN = {
  source: 'sharecode-line-ending-normalizer',
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function normalizeYTextLineEndings(
  ytext: Y.Text,
  origin: unknown = LINE_ENDING_NORMALIZATION_ORIGIN
): boolean {
  const text = ytext.toString()
  if (!text.includes('\r')) {
    return false
  }

  const doc = ytext.doc
  if (!doc) {
    return false
  }

  doc.transact(() => {
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (text[index] !== '\r') {
        continue
      }

      if (text[index + 1] === '\n') {
        ytext.delete(index, 1)
        continue
      }

      ytext.delete(index, 1)
      ytext.insert(index, '\n')
    }
  }, origin)

  return true
}

/** Canonical input: Unicode scalar values and LF. No NFC/NFKC folding: code
 * identifiers and combining sequences must retain their exact meaning.
 * Isolated UTF-16 surrogates have no UTF-8 representation. Match the wire
 * encoder's U+FFFD replacement locally so display and peers cannot disagree. */
export function normalizeCollaborativeText(text: string): string {
  const lf = normalizeLineEndings(text)
  let result = ''
  for (let i = 0; i < lf.length; i++) {
    const code = lf.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = lf.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { result += lf[i]! + lf[++i]!; continue }
      result += '\ufffd'
    } else if (code >= 0xdc00 && code <= 0xdfff) result += '\ufffd'
    else result += lf[i]
  }
  return result
}
