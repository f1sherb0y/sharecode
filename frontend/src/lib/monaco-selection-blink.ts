import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type * as Monaco from 'monaco-editor'
import { MonacoBinding, toModelOffset, toYTextOffset } from './monaco-binding'

const DURATION = 2000
interface Blink { id: string; anchor: Y.RelativePosition; head: Y.RelativePosition }
interface PendingBlink { blink: Blink; variant: number; expires: number; shown: boolean; timer: ReturnType<typeof setTimeout> }

// Ephemeral awareness, never document content or playback history. Each click
// has its own ID so repeating a selection restarts the feedback on every peer.
export class MonacoSelectionBlink {
  private seen = new Map<number, { id: string; variant: number }>()
  private pending = new Map<number, PendingBlink>()
  private clearPublished: ReturnType<typeof setTimeout> | undefined
  private frame = 0

  constructor(
    private editor: Monaco.editor.IStandaloneCodeEditor,
    private ytext: Y.Text,
    private awareness: Awareness,
    private binding: MonacoBinding,
  ) {
    // Mounting/reconnecting a view must not replay another client's old pulse.
    awareness.getStates().forEach((state, client) => { if (state.blink?.id) this.seen.set(client, { id: state.blink.id, variant: 0 }) })
    awareness.on('change', this.onAwareness)
    ytext.observe(this.scheduleRender)
  }

  send() {
    const model = this.editor.getModel(), selection = this.editor.getSelection()
    if (!model || !selection || selection.isEmpty() || !this.awareness.getLocalState()) return
    const raw = this.ytext.toString()
    const blink: Blink = {
      id: crypto.randomUUID(),
      anchor: Y.createRelativePositionFromTypeIndex(this.ytext, toYTextOffset(raw, model.getOffsetAt(selection.getStartPosition()))),
      head: Y.createRelativePositionFromTypeIndex(this.ytext, toYTextOffset(raw, model.getOffsetAt(selection.getEndPosition()))),
    }
    this.awareness.setLocalStateField('blink', blink)
    clearTimeout(this.clearPublished)
    this.clearPublished = setTimeout(() => {
      if (this.awareness.getLocalState()?.blink?.id === blink.id) this.awareness.setLocalStateField('blink', null)
    }, DURATION)
  }

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    for (const client of removed) { this.clear(client); this.seen.delete(client) }
    for (const client of [...added, ...updated]) {
      const value = this.awareness.getStates().get(client)?.blink
      if (!value || typeof value.id !== 'string' || value.id.length > 100 || !value.anchor || !value.head || this.seen.get(client)?.id === value.id) continue
      const variant = 1 - (this.seen.get(client)?.variant ?? 0)
      this.seen.set(client, { id: value.id, variant })
      // Newly added remote states are join/reconnect snapshots, not new clicks.
      if (client !== this.awareness.clientID && added.includes(client)) continue
      this.clear(client)
      this.pending.set(client, {
        blink: value, variant, expires: performance.now() + DURATION, shown: false,
        timer: setTimeout(() => this.clear(client), DURATION),
      })
    }
    this.scheduleRender()
  }

  private scheduleRender = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render() })
  }

  private render() {
    const model = this.editor.getModel(), doc = this.ytext.doc
    if (!model || !doc) return
    for (const [client, pulse] of this.pending) {
      if (performance.now() >= pulse.expires) { this.clear(client); continue }
      try {
        const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(pulse.blink.anchor), doc)
        const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(pulse.blink.head), doc)
        // Awareness can arrive before the document update it refers to. Retry
        // after Y.Text changes rather than permanently discarding the pulse.
        if (!start || !end || start.type !== this.ytext || end.type !== this.ytext) continue
        if (start.index === end.index) { this.clear(client); continue }
        if (!pulse.shown) {
          if (client === this.awareness.clientID) {
            const root = this.editor.getDomNode()
            root?.style.setProperty('--selection-blink-color', this.awareness.getLocalState()?.user?.color ?? '#3b82f6')
            root?.classList.add(`selection-blink-local-${pulse.variant}`)
          } else {
            // Animate the existing collaborator selection, not a second overlay.
            this.binding.setSelectionBlink(client, pulse.variant)
            if (this.awareness.getLocalState()?.view !== 'canvas') {
              const raw = this.ytext.toString()
              const a = model.getPositionAt(toModelOffset(raw, Math.min(start.index, end.index)))
              const b = model.getPositionAt(toModelOffset(raw, Math.max(start.index, end.index)))
              this.editor.revealRangeInCenterIfOutsideViewport({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column })
            }
          }
        }
        pulse.shown = true
      } catch { this.clear(client) }
    }
  }

  private clear(client: number) {
    const pulse = this.pending.get(client)
    if (!pulse) return
    clearTimeout(pulse.timer)
    if (client === this.awareness.clientID) {
      this.editor.getDomNode()?.classList.remove('selection-blink-local-0', 'selection-blink-local-1')
    } else this.binding.setSelectionBlink(client, null)
    this.pending.delete(client)
  }

  destroy() {
    this.awareness.off('change', this.onAwareness)
    this.ytext.unobserve(this.scheduleRender)
    clearTimeout(this.clearPublished)
    cancelAnimationFrame(this.frame)
    for (const client of this.pending.keys()) this.clear(client)
    if (this.awareness.getLocalState()?.blink) this.awareness.setLocalStateField('blink', null)
    this.seen.clear()
  }
}
