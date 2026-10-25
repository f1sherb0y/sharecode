import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const supportsMeetingPrivacy = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && navigator.userAgent.includes('Windows')

export interface MeetingPrivacyStatus {
  enabled: boolean
  state: 'disabled' | 'waiting' | 'idle' | 'active' | 'partial' | 'restoring'
  meetingProcesses: number
  sharingProcesses: number
  protectedWindows: number
  hiddenTaskbarWindows: number
  error: string | null
}
interface Preferences {
  enabled: boolean
  busy: boolean
  status: MeetingPrivacyStatus | null
  error: string | null
  setEnabled: (enabled: boolean) => Promise<void>
}

export const useMeetingPrivacy = create<Preferences>()(persist((set, get) => ({
  enabled: false,
  busy: false,
  status: null,
  error: null,
  setEnabled: async (enabled) => {
    if (!supportsMeetingPrivacy || get().busy) return
    const previous = get().enabled
    set({ enabled, busy: true, error: null })
    try {
      const status = await invoke<MeetingPrivacyStatus>('set_meeting_privacy_enabled', { enabled })
      set({ enabled: status.enabled, status, error: status.error })
    } catch (error) {
      set({ enabled: previous, error: String(error) })
    } finally {
      set({ busy: false })
    }
  },
}), { name: 'sharecode-client-meeting-privacy', partialize: ({ enabled }) => ({ enabled }) }))

export function watchMeetingPrivacy(): () => void {
  if (!supportsMeetingPrivacy) return () => {}
  let cancelled = false
  let stop: (() => void) | undefined
  let received = false
  void listen<MeetingPrivacyStatus>('sharecode:meeting-privacy', ({ payload }) => {
    received = true
    useMeetingPrivacy.setState({ status: payload, error: payload.error })
  }).then(async (unlisten) => {
    if (cancelled) { unlisten(); return }
    stop = unlisten
    if (useMeetingPrivacy.getState().enabled) {
      await useMeetingPrivacy.getState().setEnabled(true)
    } else {
      const status = await invoke<MeetingPrivacyStatus>('get_meeting_privacy_status')
      if (!cancelled && !received) useMeetingPrivacy.setState({ status })
    }
  }).catch(error => {
    if (!cancelled) useMeetingPrivacy.setState({ error: String(error) })
  })
  return () => { cancelled = true; stop?.() }
}
