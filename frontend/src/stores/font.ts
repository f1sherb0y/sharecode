import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_EDITOR_FONT_SIZE, EDITOR_FONT_STACK } from '@/lib/editor-font'

export type SelectableFont = 'Sarasa Mono'

// Also handles old persisted values without ever emitting another font family.
export function fontFamilyStack(_font?: SelectableFont): string {
  return EDITOR_FONT_STACK
}

interface FontState {
  /** Name of the selected font (not a CSS stack). Use `fontFamilyStack(font)`
   *  to get the value to hand to Monaco or CSS. */
  font: SelectableFont
  fontSize: number
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
      font: 'Sarasa Mono',
      fontSize: DEFAULT_EDITOR_FONT_SIZE,

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
      // Bump whenever the shape of persisted state changes. Without a version
      // bump, zustand's persist treats stored and current version both as 0
      // and skips migrate — so pre-refactor entries stay in localStorage.
      version: 5,
      // Upgrade the former 12px default; keep other customized sizes.
      migrate: (state: unknown) => {
        const s = (state ?? {}) as Partial<FontState> & { font?: unknown }
        return {
          ...s,
          font: 'Sarasa Mono',
          fontSize:
            typeof s.fontSize === 'number' && s.fontSize !== 12
              ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, s.fontSize))
              : DEFAULT_EDITOR_FONT_SIZE,
        } as FontState
      },
    }
  )
)
