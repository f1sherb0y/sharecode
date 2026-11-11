import { isMyGoApp } from '@/lib/mygo-core'

/** Host detection only; the MyGo build aliases IPC imports, the Tauri build does not. */
export const isDesktopClient = typeof window !== 'undefined'
  && ('__TAURI_INTERNALS__' in window || isMyGoApp())

/** Enable MyGo's documented native --app-region handler for the existing explicit
 * drag targets. No synthetic input or private bridge messages are needed. */
export function initializeMyGoClient() {
  if (!isMyGoApp()) return () => {}
  document.documentElement.dataset.mygoClient = 'true'
  return () => { delete document.documentElement.dataset.mygoClient }
}
