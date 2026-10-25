import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { isMacOSClient } from './window'
import i18n from '@/i18n'

export type HotkeyPhase = 'starting' | 'permissionRequired' | 'listening' | 'recovering' | 'secureInput' | 'failed'
export interface HotkeyStatus {
  revision: number
  ready: boolean
  phase: HotkeyPhase
  received: number
  testing: boolean
  lastAction: 'tested' | 'enabled' | 'disabled' | 'failed' | 'testTimedOut' | null
  error: string | null
}

interface HotkeyStore extends HotkeyStatus {
  busy: boolean
  commandError: string | null
  run: (command: 'request_client_hotkey_permission' | 'open_client_hotkey_settings' | 'open_client_hotkey_setup' | 'test_client_hotkey') => Promise<void>
}

function accept(status: HotkeyStatus) {
  // The initial IPC read, periodic reads and native events can arrive out of order.
  if (status.revision >= useMacHotkey.getState().revision) useMacHotkey.setState(status)
}

export const useMacHotkey = create<HotkeyStore>((set, get) => ({
  revision: -1, ready: false, phase: 'starting', received: 0, testing: false, lastAction: null, error: null,
  busy: false, commandError: null,
  run: async (command) => {
    if (!isMacOSClient || get().busy) return
    set({ busy: true, commandError: null })
    try {
      await invoke(command, command === 'open_client_hotkey_setup' ? { language: i18n.language } : undefined)
      accept(await invoke<HotkeyStatus>('get_client_hotkey_status'))
    } catch (error) {
      set({ commandError: String(error) })
    } finally {
      set({ busy: false })
    }
  },
}))

export function watchMacHotkey(): () => void {
  if (!isMacOSClient) return () => {}
  let cancelled = false
  let stop: (() => void) | undefined
  const refresh = async () => {
    try {
      const status = await invoke<HotkeyStatus>('get_client_hotkey_status')
      if (!cancelled) accept(status)
    } catch (error) {
      if (!cancelled) useMacHotkey.setState({ phase: 'failed', ready: false, commandError: String(error) })
    }
  }
  void listen<HotkeyStatus>('sharecode:hotkey-status', ({ payload }) => {
    if (!cancelled) accept(payload)
  }).then((unlisten) => {
    if (cancelled) unlisten()
    else { stop = unlisten; void refresh() }
  }).catch((error) => {
    if (!cancelled) useMacHotkey.setState({ phase: 'failed', ready: false, commandError: String(error) })
  })
  // Also recover missed events after the WebView was suspended or reloaded.
  const timer = window.setInterval(() => void refresh(), 2000)
  return () => { cancelled = true; stop?.(); window.clearInterval(timer) }
}
