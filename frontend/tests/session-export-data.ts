import assert from 'node:assert/strict'
import * as Y from 'yjs'
import pako from 'pako'
import { sanitizeSession, encodeBytes, decodeBytes, packSession, unpackSession } from '../src/export/data'
import { DocumentReplay } from '../src/lib/document-replay'
import { orderedCanvasElements } from '../src/lib/canvas-sync'
import type { PlaybackData } from '../src/types'

export function fixture(markdownImage?: string) {
  const doc = new Y.Doc(), updates: PlaybackData['updates'] = []
  let at = 0, actor: string | null = 'private-user-alice'
  const base = Date.parse('2026-09-17T03:24:55Z')
  const secret = 'PRIVATE-METADATA-ROOM-USER-WEBSITE'
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BHMfe7gAAAABJRU5ErkJggg=='
  doc.on('update', update => updates.push({ id: `${secret}-${updates.length}`, timestamp: new Date(base + at).toISOString(), userId: actor, update: encodeBytes(pako.gzip(update)) }))
  doc.transact(() => {
    doc.getMap('private').set('domain', secret)
    doc.getMap('meta').set('markdownSeeder', secret)
    doc.getMap('meta').set('language', 'python')
    doc.getText('codemirror').insert(0, 'print("original content: Alice https://example.org")')
  })
  at = 1000; actor = 'private-user-bob'
  doc.transact(() => {
    doc.getText('codemirror').insert(doc.getText('codemirror').length, '\nprint("second step")')
    doc.getMap('private').delete('domain')
  })
  at = 2000
  doc.transact(() => {
    doc.getMap('meta').set('language', 'markdown')
    doc.getMap('meta').set('markdownInitialized', true)
    const heading = new Y.XmlElement('heading'); heading.setAttribute('level', 1 as unknown as string); heading.setAttribute('id', secret)
    const title = new Y.XmlText(); title.insert(0, 'Original Markdown'); heading.insert(0, [title])
    const p = new Y.XmlElement('paragraph'), text = new Y.XmlText(); text.insert(0, 'Visible Alice ', { strong: {} }); p.insert(0, [text])
    const image = new Y.XmlElement('image'); image.setAttribute('src', markdownImage ?? pixel); image.setAttribute('alt', 'Original image'); p.insert(1, [image])
    const math = new Y.XmlElement('math_block'), formula = new Y.XmlText(); formula.insert(0, 'E = mc^2'); math.insert(0, [formula])
    const diagram = new Y.XmlElement('diagram'); diagram.setAttribute('value', 'graph TD; A[Start] --> B[Finish]'); diagram.setAttribute('identity', secret)
    doc.getXmlFragment('prosemirror').insert(0, [heading, p, math, diagram])
  })
  at = 3000; actor = 'private-user-alice'
  const shape = { id: secret + '-shape', type: 'rectangle', x: 20, y: 20, width: 160, height: 100, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#ffccaa', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [secret + '-group'], frameId: null, roundness: null, seed: 1234, version: 1, versionNonce: 555, isDeleted: false, boundElements: null, updated: base, link: null, locked: false, index: 'a0', customData: { user: secret } }
  doc.transact(() => {
    doc.getMap('canvas-elements').set(shape.id, { element: shape })
    doc.getMap('canvas-settings').set('background', '#ffffff')
    doc.getMap('canvas-settings').set('private', secret)
    doc.getMap('canvas-files').set(secret + '-file', { id: secret + '-file', created: base, lastRetrieved: base + 1, dataURL: pixel, mimeType: 'image/png', secret })
    doc.getMap('canvas-elements').set(secret + '-image', { element: { ...shape, id: secret + '-image', type: 'image', x: 220, width: 100, height: 100, fileId: secret + '-file', scale: [1, 1], status: 'saved', index: 'a1' } })
    doc.getMap('canvas-elements').set(secret + '-text', { element: { ...shape, id: secret + '-text', type: 'text', x: 20, y: 160, width: 300, height: 25, index: 'a3', fontFamily: 3, fontSize: 20, text: 'Canvas 中文 日本語 한글', originalText: 'Canvas 中文 日本語 한글', textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 } })
  })
  at = 4000
  doc.transact(() => {
    const samples = new Y.Array(); samples.push([{ point: [0, 0], pressure: 0.5, secret }, { point: [100, 80], pressure: 0.6 }])
    doc.getMap('canvas-paths').set(secret + '-path', samples)
    doc.getMap('canvas-elements').set(secret + '-stroke', { element: { ...shape, id: secret + '-stroke', type: 'freedraw', points: [], pressures: [], simulatePressure: false, index: 'a2' }, path: secret + '-path', count: 2 })
  })
  at = 6000; actor = null
  doc.transact(() => {
    const path = doc.getMap('canvas-paths').get(secret + '-path') as Y.Array<unknown>
    path.push([{ point: [140, 50], pressure: 0.7 }])
    const value = doc.getMap('canvas-elements').get(secret + '-stroke') as { element: typeof shape; path: string; count: number }
    doc.getMap('canvas-elements').set(secret + '-stroke', { ...value, count: 3, element: { ...value.element, version: 2 } })
  })
  doc.destroy()
  return { history: { updates, startTime: new Date(base).toISOString(), endTime: new Date(base + at).toISOString(), duration: at }, secret, pixel }
}

export async function checkSanitizer() {
  const { history, secret, pixel } = fixture()
  const session = await sanitizeSession(history, 'markdown', [{ text: 'Original note Alice' }])
  assert.equal(session.users, 2)
  assert.deepEqual(session.updates.map(u => [u.at, u.actor]), [[0, 1], [1000, 2], [2000, 2], [3000, 1], [4000, 1], [6000, null]])
  assert.equal(session.duration, 6000)
  assert.deepEqual(unpackSession(packSession(session)), session)
  const raw = JSON.stringify(session) + session.updates.map(u => new TextDecoder().decode(decodeBytes(u.data))).join('')
  for (const privateValue of [secret, 'private-user', '2026-09-17', String(Date.parse('2026-09-17T03:24:55Z')), 'markdownSeeder', 'customData', 'lastRetrieved']) assert(!raw.includes(privateValue), privateValue)
  const replay = new DocumentReplay(session.updates.map(u => ({ timestampMs: u.at, update: u.data ? decodeBytes(u.data) : new Uint8Array([0, 0]) })))
  assert.equal(replay.seek(0).getText('codemirror').toString(), 'print("original content: Alice https://example.org")')
  assert(replay.seek(1000).getText('codemirror').toString().includes('second step'))
  assert(replay.seek(2000).getXmlFragment('prosemirror').toString().includes(pixel))
  let elements = orderedCanvasElements(replay.seek(6000))
  assert.equal(elements.length, 4)
  for (const element of elements) { assert.equal(element.updated, 0); assert.equal(element.customData, undefined); assert.match(element.id, /^item\d+$/) }
  const files = [...replay.doc.getMap<Record<string, unknown>>('canvas-files').values()]
  assert.equal(files[0]!.created, 0); assert.equal(files[0]!.lastRetrieved, undefined)
  assert.deepEqual([...replay.doc.getMap('meta').keys()].sort(), ['language', 'markdownInitialized'])
  assert(!replay.doc.share.has('private'))
  for (const update of session.updates.filter(u => u.data)) {
    for (const struct of Y.decodeUpdate(decodeBytes(update.data)).structs) assert.equal(struct.id.client, 1)
  }
  assert.equal(elements.find(e => e.type === 'freedraw')?.points.length, 3)
  elements = orderedCanvasElements(replay.seek(4000))
  assert.equal(elements.find(e => e.type === 'freedraw')?.points.length, 2)
  assert.equal(orderedCanvasElements(replay.seek(0)).length, 0)
  replay.destroy()
  const empty = await sanitizeSession({ updates: [], startTime: null, endTime: null, duration: 0 }, 'python')
  assert.equal(empty.duration, 0); assert.equal(empty.users, 0)
  console.log('Session sanitizer: relative timing, anonymous attribution, deep metadata removal, content, incremental strokes and seeking passed')
  return session
}
if (import.meta.main) await checkSanitizer()
