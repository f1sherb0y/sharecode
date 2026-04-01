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
