import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const isMacOSClient = isTauri && navigator.userAgent.includes('Macintosh')

// No-ops outside Tauri so the client UI can also be developed in a plain browser.
export const appWindow = {
  minimize: () => (isTauri ? getCurrentWindow().minimize() : Promise.resolve()),
  // The macOS client is not maximizable (a zoomed borderless translucent window loses
  // its rounded frame and can disappear), so toggling is a no-op there.
  toggleMaximize: () => (isTauri && !isMacOSClient ? getCurrentWindow().toggleMaximize() : Promise.resolve()),
  close: () => (isTauri ? getCurrentWindow().close() : Promise.resolve()),
  // The native macOS query avoids Tao's borderless style-mask/resize feedback loop; on
  // macOS it is constant false because the window can never be maximized.
  isMaximized: () => (isTauri && !isMacOSClient ? invoke<boolean>('client_is_maximized') : Promise.resolve(false)),
  setAlwaysOnTop: (onTop: boolean) => (isTauri ? getCurrentWindow().setAlwaysOnTop(onTop) : Promise.resolve()),
  setFocus: () => (isTauri ? getCurrentWindow().setFocus() : Promise.resolve()),
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

// New windows start with the recommended translucent appearance.
export const DEFAULT_TEXT_OPACITY = 0.9
export const DEFAULT_BACKGROUND_OPACITY = 0.65

export const OPACITY_PRESETS = [
  { id: 'opaque', text: 1, background: 1 },
  { id: 'recommended', text: DEFAULT_TEXT_OPACITY, background: DEFAULT_BACKGROUND_OPACITY },
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
      textOpacity: DEFAULT_TEXT_OPACITY,
      backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
      setPinned: (pinned) => set({ pinned }),
      setTextOpacity: (opacity) => set({ textOpacity: clamp(opacity, MIN_TEXT_OPACITY) }),
      setBackgroundOpacity: (opacity) => set({ backgroundOpacity: clamp(opacity, MIN_BACKGROUND_OPACITY) }),
      setOpacity: (text, background) =>
        set({ textOpacity: clamp(text, MIN_TEXT_OPACITY), backgroundOpacity: clamp(background, MIN_BACKGROUND_OPACITY) }),
    }),
    {
      name: 'sharecode-client-window',
      version: 1,
      migrate: (persisted) => {
        const saved = {
          pinned: false,
          textOpacity: DEFAULT_TEXT_OPACITY,
          backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
          ...((persisted ?? {}) as Partial<Pick<WindowPreferences, 'pinned' | 'textOpacity' | 'backgroundOpacity'>>),
        }
        // Upgrade the old stock appearance once, preserving custom slider settings.
        return saved.textOpacity === 1 && saved.backgroundOpacity === 1
          ? { ...saved, textOpacity: DEFAULT_TEXT_OPACITY, backgroundOpacity: DEFAULT_BACKGROUND_OPACITY }
          : saved
      },
      partialize: (state) => ({ pinned: state.pinned, textOpacity: state.textOpacity, backgroundOpacity: state.backgroundOpacity }),
    }
  )
)

/** What the native window does with itself; the three switches below drive it. */
export interface StealthState {
  /** No mouse or keyboard focus: every event reaches the app behind the client. */
  clickThrough: boolean
  /** Requests capture exclusion on Windows (`WDA_EXCLUDEFROMCAPTURE`). */
  screenCaptureProtection: boolean
  /** No taskbar entry. The client deliberately has no tray icon either. */
  hideFromTaskbar: boolean
}

interface StealthPreferences extends StealthState {
  /** False until the native state has been read once, so the UI does not flash wrong values. */
  ready: boolean
  busy: boolean
  error: string | null
  setClickThrough: (enabled: boolean) => void
  setScreenCaptureProtection: (enabled: boolean) => void
  setHideFromTaskbar: (enabled: boolean) => void
  /** Pushes the current values to the native window. */
  apply: () => Promise<void>
  /** Reads the native window back (after a shortcut changed it natively). */
  sync: () => Promise<void>
}

/**
 * The switches start from what a fresh install wants, then the window's real state wins: the
 * native side is the authority because the global shortcut changes it while this window cannot
 * take focus and therefore cannot handle the key itself.
 */
export const useStealthPreferences = create<StealthPreferences>()(
  persist(
    (set, get) => ({
      // Privacy and camouflage are on for a fresh install; click-through starts off because a
      // first-run client with it on cannot be operated without knowing the shortcut.
      clickThrough: false,
      screenCaptureProtection: true,
      hideFromTaskbar: true,
      ready: false,
      busy: false,
      error: null,

      setClickThrough: (clickThrough) => {
        if (get().busy || !get().ready) return
        set({ clickThrough })
        void get().apply()
      },
      setScreenCaptureProtection: (screenCaptureProtection) => {
        if (get().busy || !get().ready) return
        set({ screenCaptureProtection })
        void get().apply()
      },
      setHideFromTaskbar: (hideFromTaskbar) => {
        if (get().busy || !get().ready) return
        set({ hideFromTaskbar })
        void get().apply()
      },

      apply: async () => {
        if (get().busy) return
        set({ busy: true, error: null })
        if (!isTauri) {
          if (get().clickThrough) useWindowPreferences.setState({ pinned: true })
          set({ ready: true, busy: false })
          return
        }
        const { clickThrough, screenCaptureProtection, hideFromTaskbar } = get()
        try {
          const state = await invoke<StealthState>('set_stealth_state', {
            clickThrough,
            screenCaptureProtection,
            hideFromTaskbar,
          })
          if (state.clickThrough) useWindowPreferences.setState({ pinned: true })
          set({ ...state, ready: true })
        } catch (error) {
          console.error('The client could not apply its camouflage settings:', error)
          await get().sync()
          set({ error: String(error) })
        } finally {
          set({ busy: false })
        }
      },

      sync: async () => {
        if (!isTauri) {
          set({ ready: true })
          return
        }
        try {
          const state = await invoke<StealthState>('get_stealth_state')
          if (state.clickThrough) useWindowPreferences.setState({ pinned: true })
          set({ ...state, ready: true })
        } catch (error) {
          console.error('The client could not read its camouflage settings:', error)
          set({ ready: false, error: String(error) })
        }
      },
    }),
    {
      name: 'sharecode-client-stealth',
      // Startup applies these preferences, then reads back the actual native state.
      partialize: (state) => ({
        clickThrough: state.clickThrough,
        screenCaptureProtection: state.screenCaptureProtection,
        hideFromTaskbar: state.hideFromTaskbar,
      }),
    }
  )
)

/**
 * The shortcut is registered by the native client, so it works while the window takes no focus.
 * It changes the window itself and reports the result here; the store forwards that to the switch.
 */
export function watchStealthShortcut(): () => void {
  if (!isTauri) {
    void useStealthPreferences.getState().apply()
    return () => {}
  }
  let stop: (() => void) | undefined
  let cancelled = false
  void listen<StealthState>('sharecode:stealth-state', (event) => {
    if (event.payload.clickThrough) useWindowPreferences.setState({ pinned: true })
    useStealthPreferences.setState({ ...event.payload, ready: true })
  })
    .then((unlisten) => {
      if (cancelled) unlisten()
      else {
        stop = unlisten
        // Subscribe before applying saved settings so no shortcut event is lost on launch.
        const { apply, sync } = useStealthPreferences.getState()
        void apply().then(sync)
      }
    })
    .catch((error) => console.error('Failed to watch the click-through shortcut:', error))
  return () => {
    cancelled = true
    stop?.()
  }
}
