import { invoke } from './mygo-core'
import { listen, type Event } from './mygo-event'

// Desktop.Invoke resolves the calling window from MyGo's context. Never assume "main":
// the same bundle also runs in the separate input/recording-permission helper window.
const currentWindow = {
  minimize: () => invoke<void>('client_window_minimize'),
  toggleMaximize: () => invoke<void>('client_window_toggle_maximize'),
  close: () => invoke<void>('client_window_close'),
  setFocus: () => invoke<void>('client_window_focus'),
  setTitle: (title: string) => invoke<void>('client_window_set_title', { title }),
  onResized: (handler: (event: Event<{ width: number; height: number }>) => void) =>
    listen('tauri://resize', handler),
}

export function getCurrentWindow() { return currentWindow }
