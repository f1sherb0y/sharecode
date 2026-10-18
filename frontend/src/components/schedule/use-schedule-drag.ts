import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Appointment } from '@/types'
import { SNAP_MINUTES, clamp } from '@/lib/schedule'

/** What a drag or click on the time grid asks for. */
export type GridDrop =
  | { kind: 'create'; startsAt: Date; durationMinutes: number; techId?: string | null }
  | { kind: 'move'; appointment: Appointment; startsAt: Date; durationMinutes: number; techId?: string | null }

export interface DragPreview {
  kind: 'create' | 'move' | 'resize'
  appointment: Appointment | null
  startsAt: Date
  durationMinutes: number
  /** The row under the pointer (a new session stays in the row it is drawn in) and its tech: undefined in the week view, null for unassigned. */
  row: string
  techId: string | null | undefined
}

interface Hit {
  row: string
  techId: string | null | undefined
  /** The instant under the pointer. */
  at: number
}

interface Session {
  kind: DragPreview['kind']
  appointment: Appointment | null
  pointerId: number
  x: number
  y: number
  /** Milliseconds from the session's start (move) or end (resize) to where it was grabbed. */
  grabOffset: number
  /** The row a new session is drawn in, or a session stretched in, and the instant the pointer went down. */
  origin: Hit | null
  /** That row's element: drawing and stretching follow the pointer along it, wherever it is vertically. */
  row: HTMLElement | null
  active: boolean
  preview: DragPreview | null
}

const MINUTE = 60000
const SNAP = SNAP_MINUTES * MINUTE
const THRESHOLD = 4
const EDGE = 40
/** Minutes the window moves per frame while a drag rests at its left or right edge. */
const EDGE_PAN = 4

const snapped = (instant: number) => Math.round(instant / SNAP) * SNAP

// Rows carry data-schedule-row, data-row (their key), the instant their window starts
// (data-start), the minutes it spans (data-span) and, in the day view or for one tech,
// data-tech ('' for unassigned). Moves hit-test whatever row is under the pointer, so
// the same code serves the grid and the unassigned strip above it.
function instantAt(row: HTMLElement, x: number): number {
  const rect = row.getBoundingClientRect()
  return Number(row.dataset.start) + clamp((x - rect.left) / rect.width, 0, 1) * Number(row.dataset.span) * MINUTE
}

function hitTest(x: number, y: number): Hit | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-schedule-row]')
  if (!row?.dataset.row) return null
  const tech = row.dataset.tech
  return { row: row.dataset.row, techId: tech === undefined ? undefined : tech || null, at: instantAt(row, x) }
}

/** The instant under a pointer event inside a row. */
export function pointerInstant(event: { clientX: number; currentTarget: Element }): number {
  return instantAt(event.currentTarget as HTMLElement, event.clientX)
}

/**
 * Mouse and pen drags on the timeline: draw a new session, move one (to another
 * day in the week view, another tech in the day view) or stretch its end. At the
 * left or right edge the window of hours moves along. Touch uses taps instead.
 */
export function useScheduleDrag({ onDrop, onPan }: { onDrop: (drop: GridDrop) => void; onPan: (minutes: number) => void }) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const session = useRef<Session | null>(null)
  const suppressClick = useRef(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const onPanRef = useRef(onPan)
  onPanRef.current = onPan
  const scrollFrame = useRef(0)
  const lastPointer = useRef({ x: 0, y: 0 })

  const compute = useCallback((current: Session, hit: Hit): DragPreview | null => {
    if (current.kind === 'create') {
      const origin = current.origin
      if (!origin) return null
      const from = Math.floor(origin.at / SNAP) * SNAP
      const to = snapped(hit.at)
      const start = Math.min(from, to)
      const end = Math.max(start + SNAP, from + SNAP, to)
      return { kind: 'create', appointment: null, startsAt: new Date(start), durationMinutes: (end - start) / MINUTE, row: origin.row, techId: origin.techId }
    }
    const appointment = current.appointment!
    if (current.kind === 'resize') {
      const start = Date.parse(appointment.startsAt)
      const end = snapped(hit.at - current.grabOffset)
      return {
        kind: 'resize',
        appointment,
        startsAt: new Date(start),
        durationMinutes: clamp(Math.round((end - start) / MINUTE), SNAP_MINUTES, 1440),
        row: current.origin!.row,
        techId: undefined,
      }
    }
    return {
      kind: 'move',
      appointment,
      startsAt: new Date(snapped(hit.at - current.grabOffset)),
      durationMinutes: appointment.durationMinutes,
      row: hit.row,
      techId: hit.techId,
    }
  }, [])

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
      ? { ...current.origin, at: instantAt(current.row, x) }
      : hitTest(x, y)
    if (hit) {
      current.preview = compute(current, hit)
      setPreview(current.preview)
    }
  }, [compute])

  // Near the top or bottom of the grid, keep scrolling it under a still pointer; near
  // the left or right of its rows, move the window of hours.
  const autoScroll = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>('[data-schedule-scroll]')
    const track = scroller?.querySelector<HTMLElement>('[data-schedule-row]')
    const current = session.current
    if (!scroller || !track || !current?.active) return stopScrolling()
    const rect = scroller.getBoundingClientRect()
    const rows = track.getBoundingClientRect()
    const { x, y } = lastPointer.current
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    const stepX = !inside ? 0 : x < rows.left + EDGE ? -1 : x > rows.right - EDGE ? 1 : 0
    const stepY = !inside ? 0 : y < rect.top + EDGE ? -12 : y > rect.bottom - EDGE ? 12 : 0
    const canScroll = (stepY < 0 && scroller.scrollTop > 0)
      || (stepY > 0 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight)
    if (!stepX && !canScroll) return stopScrolling()
    if (stepX) onPanRef.current(stepX * EDGE_PAN)
    if (canScroll) scroller.scrollTop += stepY
    // The rows show the new hours after React renders; hit-test them on the next frame.
    scrollFrame.current = requestAnimationFrame(() => {
      update(x, y)
      autoScroll()
    })
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
   * Starts a possible drag. `grabOffset` is how far (in milliseconds) from the session's
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
