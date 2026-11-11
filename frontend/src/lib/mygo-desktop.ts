import { isMyGoApp } from './mygo-core'

// Build-only alias of the shared web application's host query. No staff window helpers:
// importing one here fails the build instead of shipping staff behavior to customers.
export function isTauriApp(): boolean { return isMyGoApp() }
