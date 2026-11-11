import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { create } from 'zustand'
import { isDesktopClient } from './host'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

interface UpdateState {
  phase: 'current' | 'downloading' | 'ready' | 'installing' | 'error'
  version: string | null
  received: number
  total: number | null
  checking: boolean
  failure: 'check' | 'download' | 'install' | 'restart' | null
}

// The client opens straight away and checks in the background. Only a found update
// blocks it (every phase but 'current'), until that update is installed or withdrawn.
export const useUpdateStore = create<UpdateState>()(() => ({
  phase: 'current', version: null,
  received: 0, total: null, checking: false, failure: null,
}))

let pending: Update | null = null
let installed = false
let started = false

function discardPending() {
  const previous = pending
  pending = null
  if (previous) void previous.close().catch(() => {})
}

/** Runs at launch, on retry, on reconnect and every six hours. */
export async function checkForUpdate() {
  const state = useUpdateStore.getState()
  if (!isDesktopClient || state.checking || state.phase === 'installing' || installed) return
  useUpdateStore.setState({ checking: true })
  let candidate: Update | null = null
  let failure: 'check' | 'download' = 'check'
  try {
    if (state.phase === 'error') useUpdateStore.setState({ failure: null })
    candidate = await check({ timeout: 30_000 })
    // An explicit no-update response also releases a withdrawn update's gate.
    // An unreachable server must never be mistaken for that response.
    if (!candidate) {
      if (useUpdateStore.getState().phase !== 'current') await invoke('set_client_update_locked', { locked: false })
      discardPending()
      useUpdateStore.setState({ phase: 'current', version: null, failure: null, received: 0, total: null })
      return
    }
    if (candidate.version === pending?.version) return

    const { version } = candidate
    discardPending()
    useUpdateStore.setState({ phase: 'downloading', version, received: 0, total: null, failure: null })
    await invoke('set_client_update_locked', { locked: true })
    failure = 'download'
    let received = 0
    let total: number | null = null
    await candidate.download((event) => {
      if (event.event === 'Started') total = event.data.contentLength || null
      else if (event.event === 'Progress') received += event.data.chunkLength
      else return
      useUpdateStore.setState({ received, total })
    }, { timeout: 5 * 60_000 })
    // Finished bytes alone are insufficient: download() must resolve after signature verification.
    pending = candidate
    candidate = null
    useUpdateStore.setState({ phase: 'ready', failure: null })
  } catch (error) {
    console.warn('Update check/download failed:', error)
    const current = useUpdateStore.getState()
    // A failed check changes nothing: an open client stays open and a verified download
    // stays ready. Once an update is known, errors keep the gate closed and offer retry.
    if (current.phase !== 'current' && current.phase !== 'ready') {
      useUpdateStore.setState({ phase: 'error', failure })
    }
  } finally {
    if (candidate) void candidate.close().catch(() => {})
    useUpdateStore.setState({ checking: false })
  }
}

export async function installUpdate() {
  const state = useUpdateStore.getState()
  if (!pending || state.phase !== 'ready' || state.checking) return
  useUpdateStore.setState({ phase: 'installing', failure: null })
  try {
    // Windows' installer closes/restarts the app itself. macOS/Linux need relaunch().
    if (!installed) {
      await pending.install()
      installed = true
    }
    await relaunch()
  } catch (error) {
    console.error('Update install/restart failed:', error)
    // If installation succeeded but relaunch failed, retry only the restart: its byte resource
    // was already consumed by Tauri. In either case keep all application features blocked.
    useUpdateStore.setState({ phase: 'ready', failure: installed ? 'restart' : 'install' })
  }
}

export function startUpdateChecks(): () => void {
  if (!isDesktopClient) return () => {}
  if (!started) {
    started = true
    void checkForUpdate()
  }
  const interval = setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS)
  const online = () => { void checkForUpdate() }
  window.addEventListener('online', online)
  return () => {
    clearInterval(interval)
    window.removeEventListener('online', online)
  }
}
