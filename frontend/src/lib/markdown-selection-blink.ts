import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, yCursorPluginKey, ySyncPluginKey } from 'y-prosemirror'

const DURATION = 2000
interface Blink { id: string; mode: 'markdown'; anchor: Y.RelativePosition; head: Y.RelativePosition }
interface Pulse { blink: Blink; variant: number; shown: boolean; expires: number; timer: ReturnType<typeof setTimeout> }

/** Pulses existing y-prosemirror selections through ephemeral awareness only. */
export class MarkdownSelectionBlink {
  private seen = new Map<number, { id: string; variant: number }>()
  private pulses = new Map<number, Pulse>()
  private frame = 0
  private clearPublished: ReturnType<typeof setTimeout> | undefined
  private destroyed = false

  constructor(private view: EditorView, private awareness: Awareness, private scrollContainer: HTMLElement) {
    awareness.getStates().forEach((state, client) => {
      if (state.blink?.id) this.seen.set(client, { id: state.blink.id, variant: 0 })
    })
    awareness.on('change', this.onAwareness)
  }

  send() {
    const { selection } = this.view.state
    const sync = ySyncPluginKey.getState(this.view.state)
    if (selection.empty || !sync || !this.awareness.getLocalState()) return
    // Keyboard activation may move focus to the toolbar; restore the same
    // selection before publishing so the standard cursor decoration stays visible.
    this.view.dom.focus({ preventScroll: true })
    this.view.focus()
    const anchor = absolutePositionToRelativePosition(selection.anchor, sync.type, sync.binding.mapping)
    const head = absolutePositionToRelativePosition(selection.head, sync.type, sync.binding.mapping)
    const blink: Blink = { id: crypto.randomUUID(), mode: 'markdown', anchor, head }
    this.awareness.setLocalStateField('cursor', { anchor, head })
    this.awareness.setLocalStateField('blink', blink)
    clearTimeout(this.clearPublished)
    this.clearPublished = setTimeout(() => {
      if (this.awareness.getLocalState()?.blink?.id === blink.id) this.awareness.setLocalStateField('blink', null)
    }, DURATION)
  }

  variant(client: number | undefined) {
    const pulse = client == null ? undefined : this.pulses.get(client)
    return pulse?.shown ? pulse.variant : undefined
  }

  localDecorations() {
    const variant = this.variant(this.awareness.clientID)
    const { selection, doc } = this.view.state
    if (variant == null || selection.empty) return DecorationSet.empty
    const color = this.awareness.getLocalState()?.user?.color ?? '#3b82f6'
    return DecorationSet.create(doc, [Decoration.inline(selection.from, selection.to, {
      class: `ProseMirror-yjs-selection selection-blink-${variant}`,
      style: `--selection-blink-color: ${color}`,
    })])
  }

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    for (const client of removed) { this.clear(client); this.seen.delete(client) }
    for (const client of [...added, ...updated]) {
      const blink = this.awareness.getStates().get(client)?.blink
      if (blink?.mode !== 'markdown' || typeof blink.id !== 'string' || blink.id.length > 100 || !blink.anchor || !blink.head || this.seen.get(client)?.id === blink.id) continue
      const variant = 1 - (this.seen.get(client)?.variant ?? 0)
      this.seen.set(client, { id: blink.id, variant })
      if (client !== this.awareness.clientID && added.includes(client)) continue
      this.clear(client)
      this.pulses.set(client, { blink, variant, shown: false, expires: performance.now() + DURATION, timer: setTimeout(() => this.clear(client), DURATION) })
    }
    this.update()
  }

  // Called after ProseMirror updates too: awareness may precede the XML update
  // and its mapping, so an unresolved range must be retried.
  update = () => {
    if (this.destroyed || this.frame || !this.pulses.size) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render() })
  }

  private render() {
    const sync = ySyncPluginKey.getState(this.view.state)
    if (!sync) return
    let changed = false
    for (const [client, pulse] of this.pulses) {
      if (performance.now() >= pulse.expires) { this.clear(client); continue }
      if (pulse.shown) continue
      try {
        const resolve = (pos: Y.RelativePosition) => relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(pos), sync.binding.mapping)
        const anchor = resolve(pulse.blink.anchor), head = resolve(pulse.blink.head)
        if (anchor == null || head == null) continue
        if (anchor === head) { this.clear(client); continue }
        pulse.shown = true
        changed = true
        if (client !== this.awareness.clientID && this.awareness.getLocalState()?.view !== 'canvas') {
          const start = this.view.coordsAtPos(Math.min(anchor, head)), end = this.view.coordsAtPos(Math.max(anchor, head))
          const rect = this.scrollContainer.getBoundingClientRect()
          if (start.top < rect.top || end.bottom > rect.bottom) {
            this.scrollContainer.scrollTop += (start.top + end.bottom - rect.top - rect.bottom) / 2
          }
        }
      } catch { this.clear(client) }
    }
    if (changed) this.refresh()
  }

  private refresh() {
    if (this.destroyed || this.view.isDestroyed) return
    this.view.dom.classList.toggle('selection-blink-local', this.variant(this.awareness.clientID) != null)
    // Rebuild the existing remote selection decorations; no document/history edit.
    this.view.dispatch(this.view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }).setMeta('addToHistory', false))
  }

  private clear(client: number) {
    const pulse = this.pulses.get(client)
    if (!pulse) return
    clearTimeout(pulse.timer)
    this.pulses.delete(client)
    this.refresh()
  }

  destroy() {
    this.destroyed = true
    this.awareness.off('change', this.onAwareness)
    clearTimeout(this.clearPublished)
    cancelAnimationFrame(this.frame)
    for (const client of this.pulses.keys()) this.clear(client)
    this.view.dom.classList.remove('selection-blink-local')
    if (this.awareness.getLocalState()?.blink?.mode === 'markdown') this.awareness.setLocalStateField('blink', null)
    this.seen.clear()
  }
}
