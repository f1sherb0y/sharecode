import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SettingsState {
  timezone: string
  setTimezone: (tz: string) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      timezone: 'Asia/Shanghai',

      setTimezone: (timezone: string) => {
        set({ timezone })
      },
    }),
    {
      name: 'settings-storage',
    }
  )
)
