import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SettingsState {
  timezone: string
  setTimezone: (tz: string) => void
  /** Whether other participants may follow this browser's cursor and view. */
  allowFollow: boolean
  setAllowFollow: (allow: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      timezone: 'Asia/Shanghai',

      setTimezone: (timezone: string) => {
        set({ timezone })
      },

      allowFollow: true,

      setAllowFollow: (allowFollow: boolean) => {
        set({ allowFollow })
      },
    }),
    {
      name: 'settings-storage',
    }
  )
)
