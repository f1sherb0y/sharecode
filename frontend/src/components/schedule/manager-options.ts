import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'
import type { Appointment } from '@/types'

export interface ManagerOption {
  id: string
  name: string
  color: string
}

/**
 * Who a session can belong to: the 管理 on the list when there is one, else every
 * agent and admin by name. A session's current 管理 stays among them.
 */
export function useManagerOptions(enabled: boolean, current?: Appointment['manager']) {
  const roster = useQuery({ queryKey: ['roster'], queryFn: () => api.getRoster(), enabled, staleTime: 60_000 })
  const listed = (roster.data?.managers.length ?? 0) > 0
  const users = useQuery({
    queryKey: queryKeys.roomCreationUsers,
    queryFn: async () => (await api.getRoomOwners()).users,
    enabled: enabled && roster.isSuccess && !listed,
    staleTime: 60_000,
  })
  const options = useMemo<ManagerOption[]>(() => {
    const found = listed
      ? roster.data!.managers.map(entry => ({ id: entry.userId, name: entry.name, color: entry.color }))
      : (users.data ?? [])
          .filter(user => user.role !== 'tech')
          .map(user => ({ id: user.id, name: user.username, color: user.color }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    if (current && !found.some(option => option.id === current.id)) {
      found.unshift({ id: current.id, name: current.name ?? current.username, color: current.color })
    }
    return found
  }, [listed, roster.data, users.data, current])
  return { options, listed }
}
