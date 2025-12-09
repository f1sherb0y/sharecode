export function isTauriApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isScreenCaptureProtectionSupported(): boolean {
  return isTauriApp()
}

export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
  if (!isTauriApp()) return

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()
    await currentWindow.setContentProtected(enabled)
  } catch (error) {
    console.error('Failed to set screen capture protection:', error)
  }
}

export async function setTaskbarVisibility(visible: boolean): Promise<void> {
  if (!isTauriApp()) return

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()
    await currentWindow.setSkipTaskbar(!visible)
  } catch (error) {
    console.error('Failed to set taskbar visibility:', error)
  }
}
