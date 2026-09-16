import * as Y from 'yjs'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'

export const CANVAS_INTERVAL = 100
const POINTS_PER_BATCH = 6 // ~60 points/s, independent of mouse/pen polling rate.
export const MAX_CANVAS_FILE_BYTES = 350_000
export const MAX_CANVAS_FILES_BYTES = 1_000_000

type Point = readonly [number, number]
type StrokeSample = { point: Point; pressure?: number }
type StoredElement = { element: ExcalidrawElement; path?: string; count?: number }
const stamp = (e: ExcalidrawElement) => `${e.version}:${e.versionNonce}:${e.isDeleted}:${e.index}`

export function canvasElements(doc: Y.Doc): ExcalidrawElement[] {
  const paths = doc.getMap<Y.Array<StrokeSample>>('canvas-paths')
  return [...doc.getMap<StoredElement>('canvas-elements').values()].map(({ element, path, count }) => {
    if (!path || element.type !== 'freedraw') return element
    const samples = paths.get(path)?.slice(0, count) ?? []
    return { ...element, points: samples.map(s => s.point),
      pressures: element.simulatePressure ? [] : samples.map(s => s.pressure ?? 0.5) } as ExcalidrawElement
  })
}

// Fractional indexes use ASCII order, not locale-aware collation.
export function orderedCanvasElements(doc: Y.Doc) {
  return canvasElements(doc).sort((a, b) => {
    const left = a.index ?? a.id, right = b.index ?? b.id
    return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function canvasFiles(doc: Y.Doc): BinaryFiles {
  return Object.fromEntries(doc.getMap<BinaryFiles[string]>('canvas-files').entries())
}

export class CanvasSync {
  private elements: Y.Map<StoredElement>
  private paths: Y.Map<Y.Array<StrokeSample>>
  private files: Y.Map<BinaryFiles[string]>
  private observed = new Map<string, string>()
  private pending = new Map<string, ExcalidrawElement>()
  private pendingFiles: BinaryFiles = {}
  private strokes = new Map<string, { raw: readonly Point[]; path: string }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFlush = -Infinity
  private background: string
  private pendingBackground: string | undefined
  private activeStroke: string | null = null

  constructor(private doc: Y.Doc, private onPending: (pending: boolean) => void = () => {}) {
    this.elements = doc.getMap('canvas-elements')
    this.paths = doc.getMap('canvas-paths')
    this.files = doc.getMap('canvas-files')
    this.background = doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff'
    this.acceptRemote(orderedCanvasElements(doc))
  }

  // Update only the baseline for remote elements. Pending local edits survive
  // unrelated remote updates; remote changes are never echoed back into history.
  acceptRemote(elements: readonly ExcalidrawElement[]) {
    if (this.pendingBackground === undefined) this.background = this.doc.getMap<string>('canvas-settings').get('background') ?? '#ffffff'
    for (const element of elements) {
      if (!this.pending.has(element.id)) this.observed.set(element.id, stamp(element))
    }
  }

  pendingIds() { return new Set(this.pending.keys()) }
  get hasPending() { return this.pending.size > 0 || Object.keys(this.pendingFiles).length > 0 || this.pendingBackground !== undefined }

  stage(elements: readonly ExcalidrawElement[], files: BinaryFiles, activeStroke: string | null, background?: string) {
    this.activeStroke = activeStroke
    const neededFiles = new Set(elements.filter(e => !e.isDeleted && e.type === 'image').map(e => e.type === 'image' ? e.fileId : null))
    let total = [...this.files.values()].reduce((sum, f) => sum + f.dataURL.length, 0)
    const newFiles: BinaryFiles = {}
    for (const [id, file] of Object.entries(files)) {
      if (this.files.has(id) || !neededFiles.has(file.id)) continue
      total += file.dataURL.length
      if (file.dataURL.length > MAX_CANVAS_FILE_BYTES || total > MAX_CANVAS_FILES_BYTES) throw new Error('fileTooLarge')
      newFiles[id] = file
    }
    if (background !== undefined && background !== this.background) { this.background = background; this.pendingBackground = background }
    const present = new Set(elements.map(e => e.id))
    for (const [id, stored] of this.elements) {
      if (this.observed.has(id) && !present.has(id) && !stored.element.isDeleted && !this.pending.get(id)?.isDeleted) {
        const removed = { ...stored.element, isDeleted: true, version: stored.element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }
        this.observed.set(id, stamp(removed))
        this.pending.set(id, removed)
      }
    }
    for (const element of elements) {
      if (this.observed.get(element.id) === stamp(element)) continue
      this.observed.set(element.id, stamp(element))
      this.pending.set(element.id, element)
    }
    this.pendingFiles = newFiles
    if (!this.hasPending) return
    this.onPending(true)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), Math.max(0, CANVAS_INTERVAL - (performance.now() - this.lastFlush)))
  }

  flush = () => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.hasPending) return
    this.lastFlush = performance.now()
    const pending = [...this.pending.values()]
    this.pending.clear()
    // Each image is written once, in a bounded update. Never resend image data
    // with every shape move. UI rejects oversized imports before queuing edits.
    for (const [id, file] of Object.entries(this.pendingFiles)) {
      if (!this.files.has(id)) this.doc.transact(() => this.files.set(id, file), this)
    }
    this.pendingFiles = {}
    this.doc.transact(() => {
      if (this.pendingBackground !== undefined) {
        this.doc.getMap('canvas-settings').set('background', this.pendingBackground)
        this.pendingBackground = undefined
      }
      for (const element of pending) {
        if (element.type !== 'freedraw' || !element.points.length) {
          this.elements.set(element.id, { element })
          continue
        }
        const previous = this.strokes.get(element.id)
        const raw = element.points as readonly Point[]
        const extendsPrevious = previous && previous.raw.length <= raw.length && previous.raw.every((p, i) => p[0] === raw[i]![0] && p[1] === raw[i]![1])
        let path: string
        let samples: Y.Array<StrokeSample>
        let offset = 0
        if (extendsPrevious) {
          path = previous.path
          samples = this.paths.get(path)!
          offset = previous.raw.length
        } else {
          path = `${this.doc.clientID}:${element.id}:${element.version}:${element.versionNonce}`
          samples = new Y.Array<StrokeSample>()
          this.paths.set(path, samples)
        }
        // Active pointer strokes are sampled over time. Completed/imported
        // paths are bounded too; edits to existing paths get their own immutable
        // generation so concurrent transforms cannot interleave point arrays.
        const budget = this.activeStroke === element.id || extendsPrevious ? POINTS_PER_BATCH : 2048
        const remaining = raw.length - offset
        const count = Math.min(remaining, budget)
        const next: StrokeSample[] = []
        for (let i = 0; i < count; i++) {
          const index = count === 1 ? raw.length - 1 : offset + Math.round(i * (remaining - 1) / (count - 1))
          next.push({ point: [raw[index]![0], raw[index]![1]], ...(element.simulatePressure ? {} : { pressure: element.pressures[index] ?? 0.5 }) })
        }
        if (next.length) samples.push(next)
        this.strokes.set(element.id, { raw, path })
        this.elements.set(element.id, { element: { ...element, points: [], pressures: [] }, path, count: samples.length })
      }
    }, this)
    this.onPending(false)
  }

  destroy() { this.flush(); this.strokes.clear() }
}

export interface CanvasViewport { x: number; y: number; width: number; height: number }
export function containViewport(target: CanvasViewport, width: number, height: number) {
  if (![target.x, target.y, target.width, target.height, width, height].every(Number.isFinite) || target.width <= 0 || target.height <= 0 || width <= 0 || height <= 0) return null
  const zoom = Math.min(width / target.width, height / target.height)
  return { zoom, scrollX: width / (2 * zoom) - target.x - target.width / 2,
    scrollY: height / (2 * zoom) - target.y - target.height / 2 }
}
