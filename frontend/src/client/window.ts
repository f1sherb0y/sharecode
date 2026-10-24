import { getCurrentWindow } from '@tauri-apps/api/window'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// No-ops outside Tauri so the client UI can also be developed in a plain browser.
export const appWindow = {
  minimize: () => (isTauri ? getCurrentWindow().minimize() : Promise.resolve()),
  toggleMaximize: () => (isTauri ? getCurrentWindow().toggleMaximize() : Promise.resolve()),
  close: () => (isTauri ? getCurrentWindow().close() : Promise.resolve()),
  isMaximized: () => (isTauri ? getCurrentWindow().isMaximized() : Promise.resolve(false)),
  setAlwaysOnTop: (onTop: boolean) => (isTauri ? getCurrentWindow().setAlwaysOnTop(onTop) : Promise.resolve()),
  setTitle: (title: string) => {
    document.title = title
    return isTauri ? getCurrentWindow().setTitle(title) : Promise.resolve()
  },
  onResized: (handler: () => void): Promise<() => void> =>
    isTauri ? getCurrentWindow().onResized(handler) : Promise.resolve(() => {}),
}

// Text and background fade independently: a see-through background keeps what is behind the
// window visible while the text stays readable (see client.css for how each is applied).
export const MIN_TEXT_OPACITY = 0.3
export const MIN_BACKGROUND_OPACITY = 0.1

// The recommended combination keeps text at 100 % (fainter glyphs never read better) with the
// lowest background at which code stays readable over a page of the opposite brightness in
// both themes, the worst case for what shows through.
export const OPACITY_PRESETS = [
  { id: 'opaque', text: 1, background: 1 },
  { id: 'recommended', text: 1, background: 0.65 },
] as const

const clamp = (value: number, min: number) => Math.min(1, Math.max(min, value))

interface WindowPreferences {
  pinned: boolean
  textOpacity: number
  backgroundOpacity: number
  setPinned: (pinned: boolean) => void
  setTextOpacity: (opacity: number) => void
  setBackgroundOpacity: (opacity: number) => void
  setOpacity: (text: number, background: number) => void
}

export const useWindowPreferences = create<WindowPreferences>()(
  persist(
    (set) => ({
      pinned: false,
      textOpacity: 1,
      backgroundOpacity: 1,
      setPinned: (pinned) => set({ pinned }),
      setTextOpacity: (opacity) => set({ textOpacity: clamp(opacity, MIN_TEXT_OPACITY) }),
      setBackgroundOpacity: (opacity) => set({ backgroundOpacity: clamp(opacity, MIN_BACKGROUND_OPACITY) }),
      setOpacity: (text, background) =>
        set({ textOpacity: clamp(text, MIN_TEXT_OPACITY), backgroundOpacity: clamp(background, MIN_BACKGROUND_OPACITY) }),
    }),
    {
      name: 'sharecode-client-window',
      partialize: (state) => ({ pinned: state.pinned, textOpacity: state.textOpacity, backgroundOpacity: state.backgroundOpacity }),
    }
  )
)
