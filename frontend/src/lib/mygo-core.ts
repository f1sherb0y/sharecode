/** The public runtime injected at document start by MyGo 0.8.3.
 * Use its authenticated transport, never __mygo.receive or raw WebView messages. */
export interface MyGoRuntime {
  call<T>(method: string, ...args: unknown[]): Promise<T>
  on<T>(event: string, listener: (payload: T) => void): () => void
}

declare global {
  interface Window { mygo?: MyGoRuntime }
}

export function isMyGoApp(): boolean {
  return typeof window !== 'undefined'
    && typeof window.mygo?.call === 'function'
    && typeof window.mygo?.on === 'function'
}

export function getMyGoRuntime(): MyGoRuntime {
  if (!isMyGoApp()) throw new Error('The MyGo desktop bridge is unavailable')
  return window.mygo!
}

/** Build-only replacement for the Tauri command transport. Go errors reject unchanged. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return getMyGoRuntime().call<T>('Desktop.Invoke', command, args)
}

/** Compatibility export for libraries that ask the aliased core about their host. */
export const isTauri = isMyGoApp

export interface NativeEvent<T = unknown> { event: string; payload: T }

/** MyGo requires declared event types; the host declares one typed envelope. */
export function onNativeEvent<T>(name: string, listener: (payload: T) => void): () => void {
  return getMyGoRuntime().on<NativeEvent<T>>('sharecode:native-event', (message) => {
    if (message && message.event === name) listener(message.payload)
  })
}
