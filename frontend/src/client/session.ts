import { useAuthStore } from '@/stores/auth'

// Invitations are single-use, so a customer who closes the app could never get back in
// if the guest seat lived only as long as the window. The web keeps it per tab
// (sessionStorage); the client also keeps the latest seat here until the guest leaves.
const SAVED_SESSION_KEY = 'sharecode-client-session'
const RESTORE_TIMEOUT_MS = 15_000

export interface SavedSession {
  token: string
  roomId: string
  roomName: string
}

export function loadSavedSession(): SavedSession | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_SESSION_KEY) ?? 'null') as Partial<SavedSession> | null
    if (saved && typeof saved.token === 'string' && typeof saved.roomId === 'string') {
      return { token: saved.token, roomId: saved.roomId, roomName: saved.roomName ?? '' }
    }
  } catch {
    // A corrupt entry is treated as no saved session.
  }
  return null
}

export function forgetSavedSession() {
  localStorage.removeItem(SAVED_SESSION_KEY)
}

/** Mirrors the guest seat into storage; leaving the room (or losing the seat) removes it. */
export function rememberGuestSessions(): () => void {
  return useAuthStore.subscribe((state, previous) => {
    if (state.actorType === 'guest' && state.token && state.guestProfile) {
      if (state.token !== previous.token || state.guestProfile !== previous.guestProfile) {
        const saved: SavedSession = {
          token: state.token,
          roomId: state.guestProfile.room.id,
          roomName: state.guestProfile.room.name,
        }
        localStorage.setItem(SAVED_SESSION_KEY, JSON.stringify(saved))
      }
    } else if (previous.actorType === 'guest') {
      forgetSavedSession()
    }
  })
}

export type RestoreResult = 'restored' | 'expired' | 'unreachable'

/**
 * Validates the saved seat with the server the app now points at. The auth store keeps
 * retrying on network errors, so an unresolved check reports 'unreachable' and keeps the seat.
 */
export async function restoreSavedSession(saved: SavedSession): Promise<RestoreResult> {
  const auth = useAuthStore.getState()
  // After a reload the tab-scoped store may already hold the token; otherwise seed it.
  if (!auth.token) useAuthStore.setState({ token: saved.token, sessionId: crypto.randomUUID() })
  void useAuthStore.getState().initialize()

  const initialized = await new Promise<boolean>((resolve) => {
    if (useAuthStore.getState().isInitialized) {
      resolve(true)
      return
    }
    const timeout = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, RESTORE_TIMEOUT_MS)
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (!state.isInitialized) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(true)
    })
  })

  if (!initialized) return 'unreachable'
  if (useAuthStore.getState().actorType === 'guest') return 'restored'
  forgetSavedSession()
  return 'expired'
}
