import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Appointment } from '@/types'
import { SNAP_MINUTES, clamp, snap } from '@/lib/schedule'
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
  /** Day of the row under the pointer and its tech: undefined in week view, null for unassigned. */
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
  /** The row a new session is drawn in, or a session stretched in, and the minute the pointer went down. */
  origin: Hit | null
  /** That row's element: drawing and stretching follow the pointer along it, wherever it is vertically. */
  row: HTMLElement | null
  active: boolean
  preview: DragPreview | null
}

const THRESHOLD = 4
const EDGE = 40

// Rows carry data-schedule-row, data-day, the minutes they span (data-from,
// data-to) and, in the day view, data-tech ('' for unassigned). Moves hit-test
// whatever row is under the pointer, so the same code serves the grid and the
// unassigned strip above it.
function minuteAt(row: HTMLElement, x: number): number {
  const rect = row.getBoundingClientRect()
  const from = Number(row.dataset.from)
  const to = Number(row.dataset.to)
  return clamp(from + ((x - rect.left) / rect.width) * (to - from), from, to)
}

function hitTest(x: number, y: number): Hit | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-schedule-row]')
  const day = row?.dataset.day
  if (!row || !day) return null
  const tech = row.dataset.tech
  return { day, techId: tech === undefined ? undefined : tech || null, minute: minuteAt(row, x) }
}

/** The minute of the day under a pointer event inside a row. */
export function pointerMinute(event: { clientX: number; currentTarget: Element }): number {
  return minuteAt(event.currentTarget as HTMLElement, event.clientX)
}

/**
 * Mouse and pen drags on the timeline: draw a new session, move one (to another
 * day in the week view, another tech in the day view) or stretch its end. Touch
 * keeps scrolling and uses taps instead.
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
      const end = atMinute(current.origin!.day, snap(hit.minute - current.grabOffset), timezone).getTime()
      return {
        kind: 'resize',
        appointment,
        startsAt: new Date(start),
        durationMinutes: clamp(Math.round((end - start) / 60000), SNAP_MINUTES, 1440),
        day: current.origin!.day,
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
    // Drawing and stretching stay in their row; a move lands on the row under the pointer.
    const hit = current.kind !== 'move' && current.row && current.origin
      ? { ...current.origin, minute: minuteAt(current.row, x) }
      : hitTest(x, y)
    if (hit) {
      current.preview = compute(current, hit)
      setPreview(current.preview)
    }
  }, [compute])

  // Near an edge of the grid, keep scrolling it under a still pointer.
  const autoScroll = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>('[data-schedule-scroll]')
    const current = session.current
    if (!scroller || !current?.active) return stopScrolling()
    const rect = scroller.getBoundingClientRect()
    const { x, y } = lastPointer.current
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    const stepX = !inside ? 0 : x < rect.left + EDGE ? -12 : x > rect.right - EDGE ? 12 : 0
    const stepY = !inside ? 0 : y < rect.top + EDGE ? -12 : y > rect.bottom - EDGE ? 12 : 0
    const canScroll = (stepX < 0 && scroller.scrollLeft > 0)
      || (stepX > 0 && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth)
      || (stepY < 0 && scroller.scrollTop > 0)
      || (stepY > 0 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight)
    if (!canScroll) return stopScrolling()
    scroller.scrollLeft += stepX
    scroller.scrollTop += stepY
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
   * start it was grabbed to move it, or from its end to stretch it; `origin` and
   * `row` are where a new session is drawn or a session stretched.
   */
  const begin = useCallback((
    event: ReactPointerEvent,
    init: { kind: DragPreview['kind']; appointment?: Appointment; grabOffset?: number; origin?: Hit; row?: HTMLElement },
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
      row: init.row ?? null,
      active: false,
      preview: null,
    }
    lastPointer.current = { x: event.clientX, y: event.clientY }
  }, [])

  /** Whether the click being handled ends a drag, and should do nothing else. */
  const endsDrag = useCallback(() => suppressClick.current, [])

  return { preview, begin, endsDrag }
}
