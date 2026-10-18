import { useRef } from 'react'
import { useQueries } from '@tanstack/react-query'
import { api } from '@/api'
import { DAY_MS, MINUTE_MS } from '@/lib/schedule'
import type { Appointment } from '@/types'

const WEEK_MS = 7 * DAY_MS
// Weeks are whole UTC weeks from a Monday, so their keys do not depend on the zone shown.
const EPOCH = Date.UTC(2024, 0, 1)
/** The most sessions one request returns; a range that fills it is fetched in halves. */
const PAGE_LIMIT = 2000

type Filters = { mine: boolean; techId?: string }

async function fetchRange(from: number, to: number, filters: Filters, signal: AbortSignal): Promise<Appointment[]> {
  const { appointments } = await api.listAppointments({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...filters }, signal)
  if (appointments.length < PAGE_LIMIT || to - from <= 60 * MINUTE_MS) return appointments
  const middle = from + Math.floor((to - from) / 2 / MINUTE_MS) * MINUTE_MS
  const halves = await Promise.all([fetchRange(from, middle, filters, signal), fetchRange(middle, to, filters, signal)])
  return halves.flat()
}

/**
 * Sessions overlapping from–to for the timelines that scroll without end: loaded a UTC
 * week at a time and cached per week, so moving through time fetches only the weeks
 * coming into view, and weeks left behind drop out of memory after a while.
 */
export function useScheduleWeeks({ from, to, mine, techId, enabled }: { from: number; to: number; mine: boolean; techId: string | null; enabled: boolean }) {
  const first = Math.floor((from - EPOCH) / WEEK_MS)
  const last = Math.floor((to - 1 - EPOCH) / WEEK_MS)
  const weeks = enabled && to > from ? Array.from({ length: Math.min(last - first + 1, 60) }, (_, i) => first + i) : []
  const filters: Filters = { mine, ...(techId ? { techId } : {}) }
  const results = useQueries({
    queries: weeks.map(week => ({
      queryKey: ['appointments', 'week', { week, ...filters }] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRange(EPOCH + week * WEEK_MS, EPOCH + (week + 1) * WEEK_MS, filters, signal),
      staleTime: 30_000,
      // Several agents plan at once; pick up their changes.
      refetchInterval: 60_000,
    })),
  })

  // One list for the weeks in view, rebuilt only when one of them brings new data.
  const merged = useRef<{ parts: (Appointment[] | undefined)[]; appointments: Appointment[] }>({ parts: [], appointments: [] })
  const parts = results.map(result => result.data)
  if (parts.length !== merged.current.parts.length || parts.some((part, i) => part !== merged.current.parts[i])) {
    const byId = new Map<string, Appointment>()
    for (const part of parts) for (const appointment of part ?? []) byId.set(appointment.id, appointment)
    merged.current = { parts, appointments: [...byId.values()] }
  }
  return {
    appointments: merged.current.appointments,
    fetching: results.some(result => result.isFetching),
    error: results.find(result => result.error)?.error ?? null,
  }
}
