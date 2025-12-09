import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ShareGuest, ShareRoomDetails, ShareSession } from '@/types'
import { getGuestSession } from '@/api'

interface GuestState {
  session: ShareSession | null
  isLoading: boolean
  isInitialized: boolean

  // Actions
  setSession: (session: ShareSession) => void
  clearSession: () => void
  initialize: (shareToken: string) => Promise<boolean>
  validateSession: () => Promise<boolean>
}

export const useGuestStore = create<GuestState>()(
  persist(
    (set, get) => ({
      session: null,
      isLoading: false,
      isInitialized: false,

      setSession: (session) => {
        set({ session, isInitialized: true })
      },

      clearSession: () => {
        set({ session: null, isInitialized: true })
      },

      initialize: async (shareToken: string) => {
        const { session } = get()

        // Check if we have an existing session for this share token
        if (session && session.shareToken === shareToken && session.authToken) {
          set({ isLoading: true })
          try {
            const data = await getGuestSession(session.authToken)
            // Update session with fresh data
            set({
              session: {
                ...session,
                guest: data.guest,
                room: data.room,
              },
              isLoading: false,
              isInitialized: true,
            })
            return true
          } catch {
            // Session expired or invalid
            set({ session: null, isLoading: false, isInitialized: true })
            return false
          }
        }

        set({ isLoading: false, isInitialized: true })
        return false
      },

      validateSession: async () => {
        const { session } = get()
        if (!session?.authToken) return false

        try {
          const data = await getGuestSession(session.authToken)
          set({
            session: {
              ...session,
              guest: data.guest,
              room: data.room,
            },
          })
          return true
        } catch {
          set({ session: null })
          return false
        }
      },
    }),
    {
      name: 'sharecode_guest_session',
      partialize: (state) => ({ session: state.session }),
    }
  )
)
