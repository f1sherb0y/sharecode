import { invoke, onNativeEvent } from './mygo-core'

// The part of @tauri-apps/plugin-updater the client uses, over the MyGo host's
// update commands (src-mygo-client/update.go).

export interface CheckOptions { timeout?: number }
export interface DownloadOptions { timeout?: number }
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

interface UpdateMetadata {
  id: string
  currentVersion: string
  version: string
  body?: string
  date?: string
}

/** A release the host found. The download and its signature check stay native. */
export class Update {
  readonly id: string
  readonly currentVersion: string
  readonly version: string
  readonly body?: string
  readonly date?: string

  constructor(metadata: UpdateMetadata) {
    this.id = metadata.id
    this.currentVersion = metadata.currentVersion
    this.version = metadata.version
    this.body = metadata.body
    this.date = metadata.date
  }

  /** Resolves once the download's signature has been verified. */
  async download(onEvent?: (event: DownloadEvent) => void, options: DownloadOptions = {}): Promise<void> {
    const stop = onNativeEvent<DownloadEvent & { id: string }>('sharecode:update-download', (message) => {
      if (message.id === this.id) onEvent?.(message)
    })
    try {
      await invoke<void>('client_update_download', { id: this.id, ...options })
    } finally {
      stop()
    }
  }

  install(): Promise<void> {
    return invoke<void>('client_update_install', { id: this.id })
  }

  close(): Promise<void> {
    return invoke<void>('client_update_close', { id: this.id })
  }
}

/** Null means the host got an explicit "no update"; anything unexpected throws. */
export async function check(options: CheckOptions = {}): Promise<Update | null> {
  const metadata = await invoke<UpdateMetadata | null>('client_update_check', { ...options })
  if (metadata === null) return null
  if (typeof metadata?.id !== 'string' || !metadata.id || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('Invalid response from the native update checker')
  }
  return new Update(metadata)
}
