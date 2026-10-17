import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Appointment } from '@/types'
import { HOUR_HEIGHT, SNAP_MINUTES, clamp, snap } from '@/lib/schedule'
import { atMinute } from '@/lib/zoned-time'

/** What a drag or click on the time grid asks for. */
export type GridDrop =
  | { kind: 'create'; startsAt: Date; durationMinutes: number; techId?: string | null }
  | { kind: 'move'; appointment: Appointment; startsAt: Date; durationMinutes: number; techId?: string | null }

export interface DragPreview {
  kind: 'create' | 'move' | 'resize'
  appointment: Appointment | null
  startsAt: Date
  durationMinutes: number
  /** Day of the column under the pointer and its tech: undefined in week view, null for unassigned. */
  day: string
  techId: string | null | undefined
}

interface Hit {
  day: string
  techId: string | null | undefined
  minute: number
}

interface Session {
  kind: DragPreview['kind']
  appointment: Appointment | null
  pointerId: number
  x: number
  y: number
  /** Minutes from the session start to where it was grabbed. */
  grabOffset: number
  /** The column a new session is drawn in, and the minute the pointer went down. */
  origin: Hit | null
  active: boolean
  preview: DragPreview | null
}

const THRESHOLD = 4
const EDGE = 40

// Columns carry data-schedule-column, data-day and, in the day view, data-tech
// ('' for unassigned). Drags hit-test whatever column is under the pointer, so
// the same code serves the grid and the unassigned list beside it.
function hitTest(x: number, y: number): Hit | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-schedule-column]')
  const day = column?.dataset.day
  if (!column || !day) return null
  const rect = column.getBoundingClientRect()
  const tech = column.dataset.tech
  return {
    day,
    techId: tech === undefined ? undefined : tech || null,
    minute: clamp(((y - rect.top) / HOUR_HEIGHT) * 60, 0, 1440),
  }
}

/** The grid minute under a pointer event inside a column. */
export function pointerMinute(event: { clientY: number; currentTarget: Element }): number {
  const rect = event.currentTarget.getBoundingClientRect()
  return clamp(((event.clientY - rect.top) / HOUR_HEIGHT) * 60, 0, 1440)
}

/**
 * Mouse and pen drags on the time grid: draw a new session, move one (also to
 * another tech's column in the day view) or stretch its end. Touch keeps
 * scrolling and uses taps instead.
 */
export function useScheduleDrag({ timezone, onDrop }: { timezone: string; onDrop: (drop: GridDrop) => void }) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const session = useRef<Session | null>(null)
  const suppressClick = useRef(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const scrollFrame = useRef(0)
  const lastPointer = useRef({ x: 0, y: 0 })

  const compute = useCallback((current: Session, hit: Hit): DragPreview | null => {
    if (current.kind === 'create') {
      const origin = current.origin
      if (!origin) return null
      // A new session is drawn within the column it started in.
      if (hit.day !== origin.day || hit.techId !== origin.techId) return current.preview
      const from = Math.floor(origin.minute / SNAP_MINUTES) * SNAP_MINUTES
      const to = snap(hit.minute)
      const start = Math.min(from, to)
      const end = Math.max(start + SNAP_MINUTES, Math.max(from + SNAP_MINUTES, to))
      return {
        kind: 'create',
        appointment: null,
        startsAt: atMinute(origin.day, start, timezone),
        durationMinutes: end - start,
        day: origin.day,
        techId: origin.techId,
      }
    }
    const appointment = current.appointment!
    if (current.kind === 'resize') {
      const start = Date.parse(appointment.startsAt)
      const end = atMinute(hit.day, snap(hit.minute - current.grabOffset), timezone).getTime()
      return {
        kind: 'resize',
        appointment,
        startsAt: new Date(start),
        durationMinutes: clamp(Math.round((end - start) / 60000), SNAP_MINUTES, 1440),
        day: hit.day,
        techId: undefined,
      }
    }
    return {
      kind: 'move',
      appointment,
      startsAt: atMinute(hit.day, snap(hit.minute - current.grabOffset), timezone),
      durationMinutes: appointment.durationMinutes,
      day: hit.day,
      techId: hit.techId,
    }
  }, [timezone])

  const stopScrolling = () => {
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = 0
  }

  const update = useCallback((x: number, y: number) => {
    const current = session.current
    if (!current) return
    if (!current.active) {
      if (Math.abs(x - current.x) + Math.abs(y - current.y) < THRESHOLD) return
      current.active = true
    }
    const hit = hitTest(x, y)
    if (hit) {
      current.preview = compute(current, hit)
      setPreview(current.preview)
    }
  }, [compute])

  // Near the top or bottom edge, keep scrolling the grid under a still pointer.
  const autoScroll = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>('[data-schedule-scroll]')
    const current = session.current
    if (!scroller || !current?.active) return stopScrolling()
    const rect = scroller.getBoundingClientRect()
    const { x, y } = lastPointer.current
    const step = y < rect.top + EDGE ? -12 : y > rect.bottom - EDGE ? 12 : 0
    if (!step) return stopScrolling()
    scroller.scrollTop += step
    update(x, y)
    scrollFrame.current = requestAnimationFrame(autoScroll)
  }, [update])

  const finish = useCallback((commit: boolean) => {
    const current = session.current
    session.current = null
    stopScrolling()
    setPreview(null)
    if (!current?.active) return
    // The click that follows a drag must not also open or create a session.
    suppressClick.current = true
    setTimeout(() => { suppressClick.current = false }, 0)
    const result = current.preview
    if (!commit || !result) return
    if (result.kind === 'create') {
      onDropRef.current({ kind: 'create', startsAt: result.startsAt, durationMinutes: result.durationMinutes, techId: result.techId })
    } else if (result.appointment) {
      onDropRef.current({
        kind: 'move',
        appointment: result.appointment,
        startsAt: result.startsAt,
        durationMinutes: result.durationMinutes,
        techId: result.kind === 'move' ? result.techId : undefined,
      })
    }
  }, [])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerId !== session.current?.pointerId) return
      lastPointer.current = { x: event.clientX, y: event.clientY }
      update(event.clientX, event.clientY)
      if (session.current?.active && !scrollFrame.current) scrollFrame.current = requestAnimationFrame(autoScroll)
    }
    const up = (event: PointerEvent) => {
      if (event.pointerId === session.current?.pointerId) finish(true)
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === session.current?.pointerId) finish(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && session.current) finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
      stopScrolling()
    }
  }, [autoScroll, finish, update])

  /**
   * Starts a possible drag. `grabOffset` is how far (in minutes) from the session's
   * start it was grabbed to move it, or from its end to stretch it; `origin` is the
   * column a new session is drawn in.
   */
  const begin = useCallback((
    event: ReactPointerEvent,
    init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: Hit },
  ) => {
    if (event.button !== 0 || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return
    event.stopPropagation()
    // Keep text from being selected while dragging.
    event.preventDefault()
    session.current = {
      kind: init.kind,
      appointment: init.appointment ?? null,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      grabOffset: init.grabOffset ?? 0,
      origin: init.origin ?? null,
      active: false,
      preview: null,
    }
    lastPointer.current = { x: event.clientX, y: event.clientY }
  }, [])

  /** Whether the click being handled ends a drag, and should do nothing else. */
  const endsDrag = useCallback(() => suppressClick.current, [])

  return { preview, begin, endsDrag }
}
