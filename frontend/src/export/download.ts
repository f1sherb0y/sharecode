import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import * as Y from 'yjs'
import { api } from '@/api'
import type { Room } from '@/types'
import { packSession, sanitizeSession } from './data'
import playerUrl from 'virtual:session-player-url'

// Discover Markdown images via the syntax tree (including reference-style images),
// never regular expressions that mistake code examples for images.
function markdownImages(text: string, sources: Set<string>) {
  const tree = unified().use(remarkParse).parse(text) as Root
  const definitions = new Map<string, string>()
  const refs = new Set<string>()
  const visit = (node: Root | RootContent) => {
    if (node.type === 'image') sources.add(node.url)
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
    if (node.type === 'imageReference') refs.add(node.identifier)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  for (const ref of refs) { const url = definitions.get(ref); if (url) sources.add(url) }
}
export class ExportImageError extends Error {}
async function embedImage(src: string): Promise<string> {
  if (src.startsWith('data:image/')) return src
  try {
    const url = new URL(src, location.href)
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Unsupported image')
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error('Image fetch failed')
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) throw new Error('Invalid image')
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = reject; reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(blob)
    })
  } catch { throw new ExportImageError('Could not embed an image') }
}
export async function createSessionHtml(room: Pick<Room, 'id' | 'language'>): Promise<string> {
  const [history, { notes }, response] = await Promise.all([api.getPlaybackUpdates(room.id), api.getNotes(room.id), fetch(playerUrl)])
  if (!response.ok) throw new Error('Could not load session player')
  const template = await response.text()
  if (!template.includes('__SESSION_PAYLOAD__')) throw new Error('Invalid session player')
  const images = new Set<string>()
  let previousMarkdown = ''
  const session = await sanitizeSession(history, room.language, notes, doc => {
    if ((doc.getMap('meta').get('language') ?? room.language) === 'markdown' && !doc.getMap('meta').get('markdownInitialized')) {
      const text = doc.getText('codemirror').toString()
      if (text !== previousMarkdown) { markdownImages(text, images); previousMarkdown = text }
    }
    const walk = (node: Y.XmlFragment) => {
      for (const child of node.toArray()) if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'image') { const src = child.getAttribute('src'); if (src) images.add(String(src)) }
        walk(child)
      }
    }
    walk(doc.getXmlFragment('prosemirror'))
    for (const file of doc.getMap<{ dataURL: string }>('canvas-files').values()) {
      // Live Canvas stores image bytes inline. Do not accept remote files silently.
      if (!file.dataURL.startsWith('data:image/')) throw new ExportImageError('Invalid canvas image')
    }
  })
  // Bound concurrency so long histories don't flood image hosts.
  const urls = [...images]
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(urls.slice(i, i + 4).map(async src => { if (!src.startsWith('data:image/')) session.images[src] = await embedImage(src) }))
  }
  return template.replace('__SESSION_PAYLOAD__', packSession(session))
}
export async function downloadSession(room: Pick<Room, 'id' | 'language'>) {
  const html = await createSessionHtml(room)
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'session-replay.html'; document.body.appendChild(link)
  link.click(); link.remove()
  // WebKit may consume the blob after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
