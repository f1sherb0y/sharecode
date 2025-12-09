import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'
import { api } from '@/api'

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  isInitialized: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  logout: () => void
  initialize: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      isInitialized: false,

      login: async (username: string, password: string) => {
        const { user, token } = await api.login(username, password)
        localStorage.setItem('token', token)
        set({ user, token })
      },

      register: async (username: string, password: string, email?: string) => {
        const { user, token } = await api.register(username, password, email)
        localStorage.setItem('token', token)
        set({ user, token })
      },

      logout: () => {
        localStorage.removeItem('token')
        set({ user: null, token: null })
      },

      initialize: async () => {
        const { token, isInitialized } = get()
        if (isInitialized) return

        set({ isLoading: true })

        const storedToken = localStorage.getItem('token')
        if (storedToken && !token) {
          set({ token: storedToken })
        }

        const currentToken = storedToken || token
        if (currentToken) {
          try {
            const { user } = await api.getProfile()
            set({ user, isLoading: false, isInitialized: true })
          } catch {
            localStorage.removeItem('token')
            set({ user: null, token: null, isLoading: false, isInitialized: true })
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
