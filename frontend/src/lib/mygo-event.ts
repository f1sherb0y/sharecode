import { onNativeEvent } from './mygo-core'

export interface Event<T> { event: string; id: number; payload: T }
export type UnlistenFn = () => void
let nextListenerId = 0

/** Subscribe synchronously before returning the promise, like Tauri's listen contract. */
export async function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  const id = ++nextListenerId
  return onNativeEvent<T>(event, (payload) => handler({ event, id, payload }))
}

export async function once<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  const id = ++nextListenerId
  const stop = onNativeEvent<T>(event, (payload) => {
    stop()
    handler({ event, id, payload })
  })
  return stop
}
