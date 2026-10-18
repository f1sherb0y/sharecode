import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Tour } from '@/components/ui'
import { api } from '@/api'
import { queryKeys } from '@/lib/query-keys'

type Params = Record<string, string | null>

const TOUR = 'schedule'
// Each step opens the part of the page it points at: customers, sessions, then arranging them.
const STEPS: { key: string; target: string; params: Params }[] = [
  { key: 'customerAdd', target: 'customer-add', params: { tab: 'sessions', customer: null } },
  { key: 'customerList', target: 'customer-list', params: { tab: 'sessions', customer: null } },
  { key: 'sessionAdd', target: 'session-add', params: { tab: 'sessions', customer: 'all' } },
  { key: 'newSession', target: 'new-session', params: { tab: null, customer: null } },
  { key: 'arrange', target: 'calendar', params: { tab: null, view: 'week' } },
  { key: 'assign', target: 'view-day', params: { tab: null, view: 'week' } },
  { key: 'onlyMine', target: 'only-mine', params: { tab: null } },
]
const RESTORED = ['tab', 'view', 'customer'] as const

/** Shows an agent the schedule once, on their first visit from any device. */
export function ScheduleTour({ userId, params, setParams }: {
  /** The agent to show it to; none for everyone else. */
  userId: string | null
  params: URLSearchParams
  setParams: (updates: Params) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [index, setIndex] = useState<number | null>(null)
  const started = useRef(false)
  const before = useRef<Params>({})
  const seen = useQuery({
    queryKey: queryKeys.seenTours(userId ?? ''),
    queryFn: async () => (await api.getSeenTours()).seen,
    enabled: !!userId,
    staleTime: Infinity,
  })
  const markSeen = useMutation({
    mutationFn: () => api.markTourSeen(TOUR),
    onSuccess: ({ seen }) => queryClient.setQueryData(queryKeys.seenTours(userId ?? ''), seen),
  })

  useEffect(() => {
    if (!userId || started.current || !seen.data || seen.data.includes(TOUR)) return
    started.current = true
    before.current = Object.fromEntries(RESTORED.map(key => [key, params.get(key)]))
    // Shown once: a reload or another device does not bring it back.
    markSeen.mutate()
    setIndex(0)
  }, [userId, seen.data]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (index !== null) setParams({ session: null, ...STEPS[index]!.params })
  }, [index]) // eslint-disable-line react-hooks/exhaustive-deps

  if (index === null) return null
  return (
    <Tour
      steps={STEPS.map(step => ({
        target: step.target,
        title: t(`schedule.tour.${step.key}.title`),
        body: t(`schedule.tour.${step.key}.body`),
      }))}
      index={index}
      onIndexChange={setIndex}
      onClose={() => {
        setIndex(null)
        setParams(before.current)
      }}
    />
  )
}
