import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { queryClient } from '@/lib/query-client'
import type { User, ShareGuest, ShareRoomDetails } from '@/types'
import { api, getSessionProfile } from '@/api'

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
  isLoading: boolean
  isInitialized: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  replaceToken: (token: string) => void
  logout: () => void
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
      isLoading: false,
      isInitialized: false,

      login: async (username, password) => {
        const { user, token } = await api.login(username, password)
        sessionRevision++
        queryClient.clear()
        set({ user, token, actorType: 'user', guestProfile: null, isLoading: false, isInitialized: true })
      },

      register: async (username, password, email) => {
        const { user, token } = await api.register(username, password, email)
        sessionRevision++
        queryClient.clear()
        set({ user, token, actorType: 'user', guestProfile: null, isLoading: false, isInitialized: true })
      },

      replaceToken: (token) => { sessionRevision++; set({ token }) },

      logout: () => {
        sessionRevision++
        queryClient.clear()
        set({ user: null, token: null, actorType: null, guestProfile: null, isLoading: false, isInitialized: true })
      },

      setGuestSession: (token, guest, room, shareToken) => {
        sessionRevision++
        queryClient.clear()
        set({ token, guestProfile: { guest, room, shareToken }, actorType: 'guest', user: null, isLoading: false, isInitialized: true })
      },

      clearGuestSession: () => {
        sessionRevision++
        queryClient.clear()
        set({ token: null, guestProfile: null, actorType: null })
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
        if (storedToken) {
          try {
            const data = await getSessionProfile(storedToken)
            if (revision !== sessionRevision) return
            if (data.actorType === 'user') {
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
            if (status !== 401 && status !== 403) {
              // A network outage must not destroy a valid identity or its
              // room-scoped recovery journal. Retry while this identity lives.
              set({ isLoading: false })
              setTimeout(() => {
                if (revision === sessionRevision && !get().isInitialized) void get().initialize()
              }, 1500)
              return
            }
            set({ user: null, guestProfile: null, token: null, actorType: null, isLoading: false, isInitialized: true })
          }
        } else {
          set({ isLoading: false, isInitialized: true })
        }
      },
    }),
    {
      name: 'sharecode-tab-auth',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ token: state.token }),
    }
  )
)
