import * as Y from 'yjs'

export interface TimedUpdate { timestampMs: number; update: Uint8Array }

// Forward playback applies each delta once. Seeking backward rebuilds once;
// code, rich text and canvas all read the same document at the same timestamp.
export class DocumentReplay {
  doc = new Y.Doc()
  private cursor = 0
  private timestamp = -Infinity
  constructor(private updates: readonly TimedUpdate[]) {}

  seek(timestamp: number) {
    if (timestamp < this.timestamp) {
      this.doc.destroy()
      this.doc = new Y.Doc()
      this.cursor = 0
    }
    this.doc.transact(() => {
      while (this.cursor < this.updates.length && this.updates[this.cursor]!.timestampMs <= timestamp) {
        Y.applyUpdate(this.doc, this.updates[this.cursor++]!.update, 'playback')
      }
    }, 'playback')
    this.timestamp = timestamp
    return this.doc
  }

  destroy() { this.doc.destroy() }
}
