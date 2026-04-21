import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const SELECTABLE_FONTS = ['JetBrains Mono', 'JuliaMono'] as const
export type SelectableFont = (typeof SELECTABLE_FONTS)[number]

const FONT_FALLBACK_STACK =
  "'Fira Code', 'DejaVu Sans Mono', 'Liberation Mono', 'ui-monospace', 'monospace'"

/** CSS `font-family` value combining the selected font and fallbacks.
 *  Defensively whitelists `font` — a legacy persisted value that slipped past
 *  migration would otherwise produce invalid CSS and cause the whole
 *  declaration to be dropped, inheriting the page's sans-serif font. */
export function fontFamilyStack(font: SelectableFont): string {
  const safe = (SELECTABLE_FONTS as readonly string[]).includes(font)
    ? font
    : 'JuliaMono'
  return `'${safe}', ${FONT_FALLBACK_STACK}`
}

interface FontState {
  /** Name of the selected font (not a CSS stack). Use `fontFamilyStack(font)`
   *  to get the value to hand to Monaco or CSS. */
  font: SelectableFont
  fontSize: number
  setFont: (font: SelectableFont) => void
  setFontSize: (size: number) => void
  increaseFontSize: () => void
  decreaseFontSize: () => void
}

const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24
const FONT_SIZE_STEP = 2

function normalizeFont(value: unknown): SelectableFont {
  if (typeof value === 'string') {
    // Legacy persisted value was a full CSS stack, e.g.
    // `'JetBrains Mono', 'Fira Code', ...`. Recover the first known font.
    for (const candidate of SELECTABLE_FONTS) {
      if (value.includes(candidate)) return candidate
    }
  }
  return 'JuliaMono'
}

export const useFontStore = create<FontState>()(
  persist(
    (set, get) => ({
      font: 'JuliaMono',
      fontSize: 14,

      setFont: (font: SelectableFont) => {
        set({ font })
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
      // Bump whenever the shape of persisted state changes. Without a version
      // bump, zustand's persist treats stored and current version both as 0
      // and skips migrate — so pre-refactor entries stay in localStorage.
      version: 1,
      migrate: (state: unknown) => {
        const s = (state ?? {}) as Partial<FontState> & { font?: unknown }
        return {
          ...s,
          font: normalizeFont(s.font),
          fontSize:
            typeof s.fontSize === 'number'
              ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, s.fontSize))
              : 14,
        } as FontState
      },
    }
  )
)
