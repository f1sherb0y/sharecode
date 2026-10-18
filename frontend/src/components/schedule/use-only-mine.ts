import { useAuthStore, useSettingsStore } from '@/stores'

/**
 * 只看我的: an agent sees the sessions of the customers they created and the
 * sessions they planned, unless they turn it off. Admins and techs have no filter.
 */
export function useOnlyMine() {
  const isAgent = useAuthStore(state => state.user?.role === 'agent')
  const onlyMine = useSettingsStore(state => state.onlyMine)
  const setOnlyMine = useSettingsStore(state => state.setOnlyMine)
  return { available: isAgent, mine: isAgent && onlyMine, setOnlyMine }
}
