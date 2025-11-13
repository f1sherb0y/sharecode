import { invoke } from '@tauri-apps/api/core'

/**
 * Enable or disable screen capture protection
 * When enabled, the window will be hidden from screen recording software
 * @param enabled - true to hide from screen capture, false to allow capture
 */
export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
    try {
        await invoke('set_screen_capture_protection', { enabled })
    } catch (error) {
        console.error('Failed to set screen capture protection:', error)
        throw error
    }
}

/**
 * Show or hide the application from taskbar (Windows) or dock (macOS)
 * @param visible - true to show in taskbar/dock, false to hide
 */
export async function setTaskbarVisibility(visible: boolean): Promise<void> {
    try {
        await invoke('set_taskbar_visibility', { visible })
    } catch (error) {
        console.error('Failed to set taskbar visibility:', error)
        throw error
    }
}

/**
 * Check if we're running in Tauri environment
 */
export function isTauriApp(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Check if screen capture protection is supported on the current platform
 */
export function isScreenCaptureProtectionSupported(): boolean {
    if (!isTauriApp()) return false

    // Only Windows and macOS are supported
    return navigator.platform.includes('Win') || navigator.platform.includes('Mac')
}
