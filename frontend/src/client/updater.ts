import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { create } from 'zustand'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Updates come from the servers' update endpoint (plugins.updater in tauri.conf.json). They
// download in the background and install only when the user restarts from the title bar, so a
// session is never cut off; after the restart the saved seat reopens the room.
const FIRST_CHECK_DELAY_MS = 5_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

interface UpdateState {
  /** A downloaded update, its signature checked, waiting for a restart. */
  ready: { version: string } | null
  installing: boolean
  failed: boolean
}

export const useUpdateStore = create<UpdateState>()(() => ({ ready: null, installing: false, failed: false }))

let pending: Update | null = null
let checking = false

function setPending(update: Update | null) {
  const previous = pending
  pending = update
  if (previous && previous !== update) void previous.close().catch(() => {})
  useUpdateStore.setState({ ready: update ? { version: update.version } : null, failed: false })
}

async function checkForUpdate() {
  if (checking || useUpdateStore.getState().installing) return
  checking = true
  try {
    const update = await check({ timeout: 30_000 })
    // Nothing newer (a release can also be withdrawn after it downloaded).
    if (!update) return setPending(null)
    if (update.version === pending?.version) return void update.close().catch(() => {})
    // Download verifies the signature; an update that fails it is never offered.
    await update.download()
    setPending(update)
  } catch (error) {
    // Offline or no server reachable: the next check tries again.
    console.warn('Update check failed:', error)
  } finally {
    checking = false
  }
}

export async function installUpdate() {
  if (!pending || useUpdateStore.getState().installing) return
  useUpdateStore.setState({ installing: true, failed: false })
  try {
    // On Windows the installer closes the app and starts the new version itself.
    await pending.install()
    await relaunch()
  } catch (error) {
    console.error('Update install failed:', error)
    useUpdateStore.setState({ installing: false, failed: true })
  }
}

export function startUpdateChecks(): () => void {
  if (!isTauri) return () => {}
  const first = setTimeout(checkForUpdate, FIRST_CHECK_DELAY_MS)
  const interval = setInterval(checkForUpdate, CHECK_INTERVAL_MS)
  return () => {
    clearTimeout(first)
    clearInterval(interval)
  }
}
