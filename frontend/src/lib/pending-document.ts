import * as Y from 'yjs'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_UPDATES = 4096
interface PendingRecord { key: string; update: Uint8Array }

/** Immutable outbox entries scoped by server, room and session fingerprint.
 * Duplicated tabs may replay the same entries (Yjs is idempotent), but can never
 * overwrite or acknowledge one another's newer edits. Tokens are never stored. */
export class PendingDocument {
  private records = new Map<string, { update: Uint8Array; version: number }>()
  private version = 0
  private bytes = 0
  private writes: Promise<void> = Promise.resolve()
  private constructor(private db: IDBDatabase, private prefix: string) {}

  static async open(server: string, room: string, sessionScope: string): Promise<PendingDocument> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionScope))
    const fingerprint = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
    const prefix = `${server}:${room}:${fingerprint}:`
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('sharecode-recovery', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Local recovery storage is blocked'))
    })
    const journal = new PendingDocument(db, prefix)
    const records = await new Promise<PendingRecord[]>((resolve, reject) => {
      const request = db.transaction('pending').objectStore('pending')
        .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    for (const record of records) {
      const update = new Uint8Array(record.update)
      journal.records.set(record.key, { update, version: ++journal.version })
      journal.bytes += update.byteLength
    }
    return journal
  }

  restore(doc: Y.Doc) {
    for (const { update } of this.records.values()) Y.applyUpdate(doc, update, this)
  }
  get hasPending() { return this.records.size > 0 }
  get currentVersion() { return this.version }

  append(update: Uint8Array): Promise<void> {
    if (this.bytes + update.byteLength > MAX_BYTES || this.records.size >= MAX_UPDATES) {
      return Promise.reject(new Error('Local recovery buffer is full'))
    }
    const key = this.prefix + crypto.randomUUID()
    const copy = update.slice()
    this.records.set(key, { update: copy, version: ++this.version })
    this.bytes += copy.byteLength
    return this.write(store => { store.put({ key, update: copy } satisfies PendingRecord) })
  }

  acknowledge(version: number): Promise<void> {
    const keys: string[] = []
    for (const [key, record] of this.records) {
      if (record.version <= version) {
        keys.push(key)
        this.records.delete(key)
        this.bytes -= record.update.byteLength
      }
    }
    return this.write(store => { for (const key of keys) store.delete(key) })
  }

  flush() { return this.writes }
  async close() { try { await this.writes } finally { this.db.close() } }

  private write(action: (store: IDBObjectStore) => void) {
    this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('pending', 'readwrite')
      action(tx.objectStore('pending'))
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Local recovery write failed'))
    }))
    return this.writes
  }
}
