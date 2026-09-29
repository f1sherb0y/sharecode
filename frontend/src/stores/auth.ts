import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { queryClient } from '@/lib/query-client'
import type { User, ShareGuest, ShareRoomDetails } from '@/types'
import { api, getSessionProfile } from '@/api'
import { restoreBrowserSession, tokenIdentity } from '@/lib/session-renewal'

let sessionRevision = 0

type ActorType = 'user' | 'guest' | null
type GuestProfile = {
  guest: ShareGuest
  room: ShareRoomDetails
  shareToken: string
}

interface AuthState {
  user: User | null
  guestProfile: GuestProfile | null
  actorType: ActorType
  token: string | null
  sessionId: string | null
  browserSessionId: string | null
  isLoading: boolean
  isInitialized: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  replaceToken: (token: string, browserSessionId?: string) => void
  renewToken: (previous: string, next: string, browserSessionId?: string) => void
  logout: () => Promise<void>
  forgetSession: () => void
  setGuestSession: (token: string, guest: ShareGuest, room: ShareRoomDetails, shareToken: string) => void
  clearGuestSession: () => void
  initialize: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      guestProfile: null,
      actorType: null,
      token: null,
      sessionId: null,
      browserSessionId: null,
      isLoading: false,
      isInitialized: false,

      login: async (username, password) => {
        const { user, token, browserSessionId } = await api.login(username, password)
        sessionRevision++
        queryClient.clear()
        set({ user, token, browserSessionId: browserSessionId ?? null, sessionId: crypto.randomUUID(), actorType: 'user', guestProfile: null, isLoading: false, isInitialized: true })
      },

      register: async (username, password, email) => {
        const { user, token, browserSessionId } = await api.register(username, password, email)
        sessionRevision++
        queryClient.clear()
        set({ user, token, browserSessionId: browserSessionId ?? null, sessionId: crypto.randomUUID(), actorType: 'user', guestProfile: null, isLoading: false, isInitialized: true })
      },

      replaceToken: (token, browserSessionId) => { sessionRevision++; set({ token, browserSessionId: browserSessionId ?? null, sessionId: crypto.randomUUID() }) },

      renewToken: (previous, next, browserSessionId) => {
        if (get().token !== previous) return // Ignore a late response after logout/account switch.
        set({ token: next, ...(browserSessionId ? { browserSessionId } : {}) })
      },

      forgetSession: () => {
        sessionRevision++
        queryClient.clear()
        set({ user: null, token: null, sessionId: null, browserSessionId: null, actorType: null, guestProfile: null, isLoading: false, isInitialized: true })
      },

      logout: async () => {
        const { actorType, browserSessionId } = get()
        if (actorType === 'user') {
          await api.logout(browserSessionId)
          try { localStorage.setItem('sharecode-logout', JSON.stringify({ browserSessionId, nonce: crypto.randomUUID() })) } catch { /* Cookies still revoke the session when web storage is unavailable. */ }
        }
        get().forgetSession()
      },

      setGuestSession: (token, guest, room, shareToken) => {
        sessionRevision++
        queryClient.clear()
        set({ token, sessionId: crypto.randomUUID(), browserSessionId: null, guestProfile: { guest, room, shareToken }, actorType: 'guest', user: null, isLoading: false, isInitialized: true })
      },

      clearGuestSession: () => {
        sessionRevision++
        queryClient.clear()
        set({ token: null, sessionId: null, browserSessionId: null, guestProfile: null, actorType: null })
      },

      initialize: async () => {
        const { isInitialized, isLoading } = get()
        if (isInitialized || isLoading) return
        const revision = sessionRevision

        set({ isLoading: true })

        // Never import an origin-wide guest token: another tab may own it.
        const storedToken = get().token
        localStorage.removeItem('auth-storage')
        localStorage.removeItem('token')
        const restore = async () => {
          const data = await restoreBrowserSession(storedToken ?? undefined, get().browserSessionId)
          if (revision !== sessionRevision) return
          set({ user: data.user, token: data.token, browserSessionId: data.browserSessionId,
            sessionId: get().sessionId ?? crypto.randomUUID(), actorType: 'user', guestProfile: null, isLoading: false, isInitialized: true })
        }
        const failOrRetry = (error: unknown) => {
          if (revision !== sessionRevision) return
          const status = (error as { status?: number }).status
          if (status === 401 || status === 403) { get().forgetSession(); return }
          set({ isLoading: false })
          setTimeout(() => { if (revision === sessionRevision && !get().isInitialized) void get().initialize() }, 1500)
        }
        if (storedToken) {
          // Legacy journals were keyed by this credential. Retain that scope
          // through renewal; new logins use a random per-session recovery scope.
          if (!get().sessionId) set({ sessionId: storedToken })
          try {
            const data = await getSessionProfile(storedToken)
            if (revision !== sessionRevision) return
            if (data.actorType === 'user') {
              // Upgrade valid pre-cookie logins immediately, not hours later.
              const identity = tokenIdentity(storedToken)
              if (identity.type === 'user' && !identity.sessionId) {
                await restore()
                return
              }
              set({ user: data.user, token: storedToken, actorType: 'user', isLoading: false, isInitialized: true })
            } else {
              set({
                guestProfile: { guest: data.guest, room: data.room, shareToken: data.share.token },
                token: storedToken,
                actorType: 'guest',
                user: null,
                isLoading: false,
                isInitialized: true,
              })
            }
          } catch (error) {
            if (revision !== sessionRevision) return
            const status = (error as { status?: number }).status
            if ((status === 401 || status === 403) && tokenIdentity(storedToken).type === 'user') {
              try { await restore() } catch (restoreError) { failOrRetry(restoreError) }
            } else {
              failOrRetry(error)
            }
          }
        } else {
          try { await restore() } catch (error) { failOrRetry(error) }
        }
      },
    }),
    {
      name: 'sharecode-tab-auth',
      storage: createJSONStorage(() => sessionStorage),
      // Access tokens are short-lived and tab-scoped. Only the HttpOnly cookie
      // persists login across browser restarts; no credential goes in localStorage.
      partialize: (state) => ({ token: state.token, sessionId: state.sessionId, browserSessionId: state.browserSessionId }),
    }
  )
)
