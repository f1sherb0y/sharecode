import { useEffect, useRef, type RefObject } from 'react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { AppState, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types'
import { CANVAS_INTERVAL, containViewport, type CanvasViewport } from '@/lib/canvas-sync'
import { isFollowable } from '@/lib/follow'

export interface CanvasPresence {
  viewport?: CanvasViewport
  pointer?: Collaborator['pointer']
  button?: 'up' | 'down'
  following?: number | null
}

/**
 * The room's follow state drives the Canvas camera; awareness carries cameras.
 * Excalidraw's native follow mode stays off: it unfollows on any pointer, scroll
 * or peer reconnect, which would make Canvas follow differ from the editors.
 */
export function useCanvasFollow({ api, provider, followClientId, onFollowToggle, presence, anonymous }: {
  api: ExcalidrawImperativeAPI | null
  provider?: HocuspocusProvider | null
  followClientId?: number | null
  onFollowToggle?: (clientId: number) => void
  presence: RefObject<CanvasPresence>
  anonymous: string
}) {
  const onFollowToggleRef = useRef(onFollowToggle)
  onFollowToggleRef.current = onFollowToggle
  const followRef = useRef(followClientId ?? null)
  followRef.current = followClientId ?? null
  const applyFollowRef = useRef(() => {})

  useEffect(() => {
    const awareness = provider?.awareness
    if (!api || !awareness) return
    let lastPresence = ''
    let lastCamera = ''
    const targetViewport = () => {
      const id = followRef.current
      const target = id == null ? undefined : awareness.getStates().get(id)
      return target?.view === 'canvas' && isFollowable(target) ? (target.canvas as CanvasPresence | undefined)?.viewport : undefined
    }
    // Move only when the presenter's camera or this window changes, so the
    // follower can look around until the presenter moves again, as in the editors.
    const applyFollow = () => {
      const app = api.getAppState()
      const viewport = targetViewport()
      const camera = viewport ? JSON.stringify([followRef.current, viewport, app.width, app.height]) : ''
      if (camera === lastCamera) return
      lastCamera = camera
      const fit = viewport && containViewport(viewport, app.width, app.height)
      if (fit && (Math.abs(app.zoom.value - fit.zoom) > 0.00001 || Math.abs(app.scrollX - fit.scrollX) > 0.01 || Math.abs(app.scrollY - fit.scrollY) > 0.01)) {
        api.updateScene({ appState: { scrollX: fit.scrollX, scrollY: fit.scrollY, zoom: { value: fit.zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER })
      }
    }
    applyFollowRef.current = applyFollow
    const refresh = () => {
      const collaborators = new Map<SocketId, Collaborator>()
      const followedBy = new Set<SocketId>()
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID || !state.user) return
        const socketId = String(id) as SocketId
        const p = state.view === 'canvas' ? state.canvas as CanvasPresence | undefined : undefined
        // Keep editor participants in the native list too, so every avatar can
        // be followed. Use the session/socket id, not account id, to distinguish browser tabs.
        collaborators.set(socketId, { socketId, pointer: p?.pointer, button: p?.button,
          username: state.user.name ?? state.user.username ?? anonymous,
          color: state.user.color ? { background: state.user.color, stroke: state.user.color } : undefined })
        if (p?.following === awareness.clientID) followedBy.add(socketId)
      })
      api.updateScene({ collaborators, appState: { followedBy }, captureUpdate: CaptureUpdateAction.NEVER })
      applyFollow()
    }
    const publish = () => {
      const app = api.getAppState()
      // Forward the presenter's original viewport to avoid repeated letterboxing
      // when somebody follows a follower with a different screen aspect ratio.
      const next: CanvasPresence = { ...presence.current, following: followRef.current, viewport: targetViewport() ?? {
        x: -app.scrollX, y: -app.scrollY, width: app.width / app.zoom.value, height: app.height / app.zoom.value,
      } }
      const signature = JSON.stringify(next)
      if (signature !== lastPresence) { lastPresence = signature; awareness.setLocalStateField('canvas', next) }
      applyFollow() // Recompute containment on follower resize as well.
    }
    // Avatar clicks are the only way native follow turns on: hand them to the
    // room's follow toggle and switch native follow straight back off.
    const unsubscribe = api.onUserFollow(() => {
      const clicked = api.getAppState().userToFollow
      if (!clicked) return
      api.updateScene({ appState: { userToFollow: null }, captureUpdate: CaptureUpdateAction.NEVER })
      onFollowToggleRef.current?.(Number(clicked.socketId))
    })
    awareness.on('change', refresh)
    refresh()
    publish()
    const timer = setInterval(publish, CANVAS_INTERVAL)
    return () => {
      unsubscribe()
      clearInterval(timer)
      awareness.off('change', refresh)
      awareness.setLocalStateField('canvas', null)
      applyFollowRef.current = () => {}
    }
  }, [api, provider, presence, anonymous])

  // Starting, stopping, pausing or resuming from the room moves the camera at once.
  useEffect(() => { applyFollowRef.current() }, [followClientId])
}
