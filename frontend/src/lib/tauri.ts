import { invoke } from '@tauri-apps/api/core'

export function isTauriApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Screen capture protection
export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
  if (!isTauriApp()) return
  await invoke('set_content_protected', { protected: enabled })
}

// Always on top
export async function setAlwaysOnTop(onTop: boolean): Promise<void> {
  if (!isTauriApp()) return
  await invoke('set_always_on_top', { onTop })
}

// Taskbar visibility
export async function setTaskbarVisibility(visible: boolean): Promise<void> {
  if (!isTauriApp()) return
  await invoke('set_skip_taskbar', { skip: !visible })
}

// Window visibility
export async function toggleVisibility(): Promise<boolean> {
  if (!isTauriApp()) return true
  return await invoke('toggle_visibility')
}

export async function showWindow(): Promise<void> {
  if (!isTauriApp()) return
  await invoke('show_window')
}

export async function hideWindow(): Promise<void> {
  if (!isTauriApp()) return
  await invoke('hide_window')
}

// Window position (1-9 numpad style)
export async function moveWindowToPosition(position: number): Promise<void> {
  if (!isTauriApp()) return
  await invoke('move_window_to_position', { position })
}

// Stealth mode settings
export interface StealthSettings {
  hideFromTaskbar: boolean
  screenCaptureProtection: boolean
}

const STEALTH_SETTINGS_KEY = 'sharecode_stealth_settings'

export function getStealthSettings(): StealthSettings {
  const defaults: StealthSettings = {
    hideFromTaskbar: false,
    screenCaptureProtection: false,
  }

  try {
    const stored = localStorage.getItem(STEALTH_SETTINGS_KEY)
    if (stored) {
      return { ...defaults, ...JSON.parse(stored) }
    }
  } catch {}

  return defaults
}

export function saveStealthSettings(settings: StealthSettings): void {
  localStorage.setItem(STEALTH_SETTINGS_KEY, JSON.stringify(settings))
}

export async function applyStealthSettings(settings: StealthSettings): Promise<void> {
  if (!isTauriApp()) return

  await setScreenCaptureProtection(settings.screenCaptureProtection)
  await setTaskbarVisibility(!settings.hideFromTaskbar)
}
