import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const SELECTABLE_FONTS = ['JetBrains Mono', 'JuliaMono'] as const
type SelectableFont = (typeof SELECTABLE_FONTS)[number]

const FONT_FALLBACK_STACK =
  "'Fira Code', 'DejaVu Sans Mono', 'Liberation Mono', 'ui-monospace', 'monospace'"

interface FontState {
  font: string
  fontSize: number
  setFont: (font: SelectableFont) => void
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
      font: `'JetBrains Mono', ${FONT_FALLBACK_STACK}`,
      fontSize: 14,

      setFont: (font: SelectableFont) => {
        set({ font: `'${font}', ${FONT_FALLBACK_STACK}` })
      },

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
