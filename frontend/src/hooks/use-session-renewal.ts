import { useEffect } from 'react'
import { useAuthStore } from '@/stores/auth'
import { ensureFreshSession } from '@/lib/session-renewal'

export function useSessionRenewal() {
  const actorType = useAuthStore(state => state.actorType)
  const initialized = useAuthStore(state => state.isInitialized)
  useEffect(() => {
    const loggedOut = (event: StorageEvent) => {
      if (event.key !== 'sharecode-logout' || !event.newValue) return
      try {
        const { browserSessionId } = JSON.parse(event.newValue)
        const state = useAuthStore.getState()
        if (browserSessionId && state.actorType === 'user' && state.browserSessionId === browserSessionId) state.forgetSession()
      } catch { /* Ignore unrelated or malformed storage values. */ }
    }
    window.addEventListener('storage', loggedOut)
    return () => window.removeEventListener('storage', loggedOut)
  }, [])
  useEffect(() => {
    if (!initialized || actorType !== 'user') return
    const renew = () => { void ensureFreshSession() }
    const visible = () => { if (document.visibilityState === 'visible') renew() }
    renew()
    const interval = setInterval(renew, 60_000)
    window.addEventListener('online', renew)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('online', renew)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [actorType, initialized])
}
