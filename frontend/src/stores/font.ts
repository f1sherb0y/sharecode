import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type FontFamily = 'JetBrains Mono' | 'Julia Mono'

interface FontState {
  font: FontFamily
  fontSize: number
  setFont: (font: FontFamily) => void
  setFontSize: (size: number) => void
  increaseFontSize: () => void
  decreaseFontSize: () => void
}

const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24
const FONT_SIZE_STEP = 2

export const useFontStore = create<FontState>()(
  persist(
    (set, get) => ({
      font: 'JetBrains Mono',
      fontSize: 14,

      setFont: (font: FontFamily) => set({ font }),

      setFontSize: (size: number) => {
        const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
        set({ fontSize: clampedSize })
      },

      increaseFontSize: () => {
        const { fontSize } = get()
        const newSize = Math.min(MAX_FONT_SIZE, fontSize + FONT_SIZE_STEP)
        set({ fontSize: newSize })
      },

      decreaseFontSize: () => {
        const { fontSize } = get()
        const newSize = Math.max(MIN_FONT_SIZE, fontSize - FONT_SIZE_STEP)
        set({ fontSize: newSize })
      },
    }),
    {
      name: 'font-storage',
    }
  )
)
