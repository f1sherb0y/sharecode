import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, ShareGuest, ShareRoomDetails } from '@/types'
import { api, getSessionProfile } from '@/api'

type ActorType = 'user' | 'guest' | null

interface AuthState {
  user: User | null
  guestProfile: { guest: ShareGuest; room: ShareRoomDetails } | null
  actorType: ActorType
  token: string | null
  isLoading: boolean
  isInitialized: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  logout: () => void
  setGuestSession: (token: string, guest: ShareGuest, room: ShareRoomDetails) => void
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
        localStorage.setItem('token', token)
        set({ user, token, actorType: 'user', guestProfile: null })
      },

      register: async (username, password, email) => {
        const { user, token } = await api.register(username, password, email)
        localStorage.setItem('token', token)
        set({ user, token, actorType: 'user', guestProfile: null })
      },

      logout: () => {
        localStorage.removeItem('token')
        set({ user: null, token: null, actorType: null, guestProfile: null })
      },

      setGuestSession: (token, guest, room) => {
        localStorage.setItem('token', token)
        set({ token, guestProfile: { guest, room }, actorType: 'guest', user: null })
      },

      clearGuestSession: () => {
        localStorage.removeItem('token')
        set({ token: null, guestProfile: null, actorType: null })
      },

      initialize: async () => {
        const { isInitialized } = get()
        if (isInitialized) return

        set({ isLoading: true })

        const storedToken = localStorage.getItem('token') || get().token
        if (storedToken) {
          try {
            const data = await getSessionProfile(storedToken)
            if (data.actorType === 'user') {
              set({ user: data.user, token: storedToken, actorType: 'user', isLoading: false, isInitialized: true })
            } else {
              set({
                guestProfile: { guest: data.guest, room: data.room },
                token: storedToken,
                actorType: 'guest',
                user: null,
                isLoading: false,
                isInitialized: true,
              })
            }
          } catch {
            localStorage.removeItem('token')
            set({ user: null, guestProfile: null, token: null, actorType: null, isLoading: false, isInitialized: true })
          }
        } else {
          set({ isLoading: false, isInitialized: true })
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token }),
    }
  )
)
