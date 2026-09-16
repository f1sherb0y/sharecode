import * as Y from 'yjs'
import pako from 'pako'
import type { Language, PlaybackData } from '@/types'

export interface SessionExport {
  version: 1
  language: Language
  users: number
  duration: number
  updates: { at: number; actor: number | null; data: string }[]
  notes: string[]
  images: Record<string, string>
}
export const encodeBytes = (bytes: Uint8Array): string => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(result)
}
export const decodeBytes = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
export const packSession = (session: SessionExport) => encodeBytes(pako.gzip(JSON.stringify(session)))
export const unpackSession = (data: string): SessionExport => JSON.parse(pako.ungzip(decodeBytes(data), { to: 'string' }))

const languages = new Set(['javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'rust', 'go', 'php', 'markdown', 'verilog'])
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]))
const mapSet = (map: Y.Map<unknown>, key: string, value: unknown) => { if (!same(map.get(key), value)) map.set(key, value) }

// Project visible state into a NEW CRDT. Never copy original binary updates:
// those can contain tombstoned metadata, client IDs and arbitrary shared maps.
function syncText(target: Y.Text, text: string) {
  const old = target.toString()
  if (old === text) return
  let start = 0, tail = 0
  while (start < old.length && start < text.length && old[start] === text[start]) start++
  while (tail < old.length - start && tail < text.length - start && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail++
  if (old.length - start - tail) target.delete(start, old.length - start - tail)
  if (text.length - start - tail) target.insert(start, text.slice(start, text.length - tail))
}
const nodeAttrs: Record<string, string[]> = {
  paragraph: [], heading: ['level'], blockquote: [], bullet_list: ['spread'], ordered_list: ['order', 'spread'],
  list_item: ['label', 'listType', 'spread', 'checked'], task_list_item: ['checked', 'label', 'listType', 'spread'],
  code_block: ['language'], hardbreak: ['isInline'], hr: [], image: ['src', 'alt', 'title'],
  table: [], table_header_row: [], table_row: [], table_cell: ['alignment', 'colspan', 'rowspan', 'colwidth'], table_header: ['alignment', 'colspan', 'rowspan', 'colwidth'],
  html: ['value'], footnote_reference: ['label'], footnote_definition: ['label'],
  diagram: ['value'], math_inline: [], math_block: [],
}
function syncXml(source: Y.XmlFragment, target: Y.XmlFragment) {
  const children = source.toArray()
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    let dest = target.get(i)
    if (child instanceof Y.XmlText) {
      if (!(dest instanceof Y.XmlText)) { if (dest) target.delete(i, 1); dest = new Y.XmlText(); target.insert(i, [dest]) }
      const delta = (child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]).filter(d => typeof d.insert === 'string').map(d => ({ insert: d.insert as string,
        attributes: Object.fromEntries(Object.entries(d.attributes ?? {}).flatMap(([key, val]) => {
          // y-prosemirror may suffix overlapping marks with a hash. Rebuild clean mark names.
          const name = key.split('--')[0]!
          if (name === 'link') return [[name, pick((val ?? {}) as Record<string, unknown>, ['href', 'title'])]]
          return ['strong', 'emphasis', 'inlineCode', 'strike_through'].includes(name) ? [[name, {}]] : []
        })) }))
      if (!delta.some(d => Object.keys(d.attributes).length) && !(dest as Y.XmlText).toDelta().some((d: { attributes?: object }) => d.attributes && Object.keys(d.attributes).length)) {
        syncText(dest as Y.XmlText, delta.map(d => d.insert).join(''))
      } else if (!same((dest as Y.XmlText).toDelta().map((d: { insert: unknown; attributes?: object }) => ({ insert: d.insert, attributes: d.attributes ?? {} })), delta)) {
        (dest as Y.XmlText).delete(0, (dest as Y.XmlText).length)
        ;(dest as Y.XmlText).applyDelta(delta)
      }
    } else if (child instanceof Y.XmlElement) {
      if (!(child.nodeName in nodeAttrs)) throw new Error('Unsupported document node')
      if (!(dest instanceof Y.XmlElement) || dest.nodeName !== child.nodeName) {
        if (dest) target.delete(i, 1)
        dest = new Y.XmlElement(child.nodeName); target.insert(i, [dest])
      }
      const element = dest as Y.XmlElement
      const attrs = pick(child.getAttributes(), nodeAttrs[child.nodeName]!)
      for (const key of Object.keys(element.getAttributes())) if (!(key in attrs)) element.removeAttribute(key)
      for (const [key, value] of Object.entries(attrs)) if (!same(element.getAttribute(key), value)) element.setAttribute(key, value as string)
      syncXml(child, element)
    } else throw new Error('Unsupported document node')
  }
  if (target.length > children.length) target.delete(children.length, target.length - children.length)
}

// Only rendering fields survive. Unknown future fields fail closed by omission.
const shapeFields = 'type x y width height angle strokeColor backgroundColor fillStyle strokeWidth strokeStyle roughness opacity seed version isDeleted index locked text originalText fontSize fontFamily textAlign verticalAlign autoResize lineHeight link name status simulatePressure startArrowhead endArrowhead elbowed startIsSpecial endIsSpecial'.split(' ')
const point = (v: unknown) => Array.isArray(v) ? [Number(v[0]), Number(v[1])] : null
function projector() {
  const ids = new Map<string, string>()
  const id = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    if (!ids.has(v)) ids.set(v, `item${ids.size + 1}`)
    return ids.get(v)!
  }
  const shape = (e: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...pick(e, shapeFields), id: id(e.id), updated: 0, versionNonce: 0 }
    for (const key of ['frameId', 'containerId', 'fileId']) if (key in e) out[key] = id(e[key])
    out.groupIds = Array.isArray(e.groupIds) ? e.groupIds.map(id) : []
    out.boundElements = Array.isArray(e.boundElements) ? e.boundElements.map(b => ({ id: id(b.id), type: b.type })) : null
    for (const key of ['startBinding', 'endBinding']) if (key in e) {
      const binding = e[key] as Record<string, unknown> | null
      out[key] = binding ? { ...pick(binding, ['focus', 'gap']), elementId: id(binding.elementId), ...(binding.fixedPoint ? { fixedPoint: point(binding.fixedPoint) } : {}) } : null
    }
    if ('roundness' in e) out.roundness = e.roundness ? pick(e.roundness as Record<string, unknown>, ['type', 'value']) : null
    if ('crop' in e) out.crop = e.crop ? pick(e.crop as Record<string, unknown>, ['x', 'y', 'width', 'height', 'naturalWidth', 'naturalHeight']) : null
    for (const key of ['scale', 'lastCommittedPoint']) if (key in e) out[key] = point(e[key])
    if (Array.isArray(e.points)) out.points = e.points.map(point)
    if (Array.isArray(e.pressures)) out.pressures = e.pressures.map(Number)
    if ('fixedSegments' in e) out.fixedSegments = Array.isArray(e.fixedSegments) ? e.fixedSegments.map(s => ({ start: point(s.start), end: point(s.end), index: Number(s.index) })) : null
    return out
  }
  return (source: Y.Doc, target: Y.Doc) => {
    syncText(target.getText('codemirror'), source.getText('codemirror').toString())
    syncXml(source.getXmlFragment('prosemirror'), target.getXmlFragment('prosemirror'))
    const meta = target.getMap('meta'), originalMeta = source.getMap('meta')
    const language = originalMeta.get('language')
    if (typeof language === 'string' && languages.has(language)) mapSet(meta, 'language', language)
    else meta.delete('language')
    mapSet(meta, 'markdownInitialized', originalMeta.get('markdownInitialized') === true)
    const settings = source.getMap('canvas-settings')
    if (typeof settings.get('background') === 'string') mapSet(target.getMap('canvas-settings'), 'background', settings.get('background'))
    else target.getMap('canvas-settings').delete('background')
    for (const name of ['canvas-elements', 'canvas-files', 'canvas-paths']) {
      const src = source.getMap<Record<string, unknown>>(name), dst = target.getMap(name)
      const present = new Set<string>()
      for (const [key, value] of src) {
        const cleanKey = id(key)!; present.add(cleanKey)
        if (name === 'canvas-elements') mapSet(dst, cleanKey, { element: shape(value.element as Record<string, unknown>), ...(value.path ? { path: id(value.path), count: Number(value.count) } : {}) })
        if (name === 'canvas-files') mapSet(dst, cleanKey, { id: cleanKey, dataURL: value.dataURL, mimeType: value.mimeType, created: 0 })
        if (name === 'canvas-paths') {
          const samples = (value as unknown as Y.Array<Record<string, unknown>>).toArray().map(s => ({ point: point(s.point), ...(typeof s.pressure === 'number' ? { pressure: s.pressure } : {}) }))
          let array = dst.get(cleanKey) as Y.Array<unknown> | undefined
          if (!array) { array = new Y.Array(); dst.set(cleanKey, array) }
          let prefix = 0
          while (prefix < array.length && prefix < samples.length && same(array.get(prefix), samples[prefix])) prefix++
          if (array.length > prefix) array.delete(prefix, array.length - prefix)
          if (samples.length > prefix) array.push(samples.slice(prefix))
        }
      }
      for (const key of dst.keys()) if (!present.has(key)) dst.delete(key)
    }
  }
}

export async function sanitizeSession(data: PlaybackData, language: Language, notes: readonly { text: string }[] = [],
  onDocument?: (doc: Y.Doc) => void | Promise<void>): Promise<SessionExport> {
  const original = new Y.Doc(), clean = new Y.Doc()
  clean.clientID = 1
  const project = projector(), users = new Map<string, number>()
  const session: SessionExport = { version: 1, language, users: 0, duration: 0, updates: [], notes: notes.map(n => n.text), images: {} }
  const start = data.updates.length ? Date.parse(data.updates[0]!.timestamp) : 0
  let pending: Uint8Array | undefined
  clean.on('update', update => { pending = update })
  try {
    for (let i = 0; i < data.updates.length; i++) {
      const update = data.updates[i]!
      const at = Date.parse(update.timestamp) - start
      if (!Number.isFinite(at) || at < session.duration) throw new Error('Invalid session timeline')
      session.duration = at
      Y.applyUpdate(original, pako.ungzip(decodeBytes(update.update)))
      pending = undefined
      clean.transact(() => project(original, clean))
      await onDocument?.(clean)
      if (update.userId && !users.has(update.userId)) users.set(update.userId, users.size + 1)
      // Preserve event timing even when an event changed metadata only.
      session.updates.push({ at, actor: update.userId ? users.get(update.userId)! : null, data: pending ? encodeBytes(pending) : '' })
      if (i % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    session.users = users.size
    return session
  } finally { original.destroy(); clean.destroy() }
}
