import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

function applyTheme(theme: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',

      setTheme: (theme: Theme) => {
        applyTheme(theme)
        set({ theme })
      },

      toggleTheme: () => {
        const newTheme = get().theme === 'light' ? 'dark' : 'light'
        applyTheme(newTheme)
        set({ theme: newTheme })
      },
    }),
    {
      name: 'theme-storage',
      onRehydrateStorage: () => (state) => {
        if (state?.theme) {
          applyTheme(state.theme)
        }
      },
    }
  )
)
