import { invoke } from './mygo-core'

export function relaunch(): Promise<void> {
  return invoke('client_relaunch')
}
