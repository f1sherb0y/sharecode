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

/** Native Excalidraw owns Canvas follow interactions; awareness carries cameras. */
export function useCanvasFollow({ api, provider, followClientId, onFollowChange, presence, anonymous }: {
  api: ExcalidrawImperativeAPI | null
  provider?: HocuspocusProvider | null
  followClientId?: number | null
  onFollowChange?: (clientId: number | null) => void
  presence: RefObject<CanvasPresence>
  anonymous: string
}) {
  const onFollowChangeRef = useRef(onFollowChange)
  onFollowChangeRef.current = onFollowChange

  useEffect(() => {
    const awareness = provider?.awareness
    if (!api || !awareness) return
    let lastPresence = ''
    const targetClientId = () => {
      const socketId = api.getAppState().userToFollow?.socketId
      return socketId == null ? null : Number(socketId)
    }
    const targetViewport = () => {
      const id = targetClientId()
      const target = id == null ? undefined : awareness.getStates().get(id)
      return target?.view === 'canvas' && isFollowable(target) ? (target.canvas as CanvasPresence | undefined)?.viewport : undefined
    }
    const applyFollow = () => {
      const app = api.getAppState()
      const viewport = targetViewport()
      if (!viewport) return
      const fit = containViewport(viewport, app.width, app.height)
      if (fit && (Math.abs(app.zoom.value - fit.zoom) > 0.00001 || Math.abs(app.scrollX - fit.scrollX) > 0.01 || Math.abs(app.scrollY - fit.scrollY) > 0.01)) {
        api.updateScene({ appState: { scrollX: fit.scrollX, scrollY: fit.scrollY, zoom: { value: fit.zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER })
      }
    }
    const refresh = () => {
      const collaborators = new Map<SocketId, Collaborator>()
      const followedBy = new Set<SocketId>()
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID || !state.user) return
        const socketId = String(id) as SocketId
        const p = state.view === 'canvas' ? state.canvas as CanvasPresence | undefined : undefined
        // Keep editor participants in the native list too: switching views must
        // not look like a disconnect and prematurely cancel cross-view follow.
        // Use the session/socket id, not account id, to distinguish browser tabs.
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
      const next: CanvasPresence = { ...presence.current, following: targetClientId(), viewport: targetViewport() ?? {
        x: -app.scrollX, y: -app.scrollY, width: app.width / app.zoom.value, height: app.height / app.zoom.value,
      } }
      const signature = JSON.stringify(next)
      if (signature !== lastPresence) { lastPresence = signature; awareness.setLocalStateField('canvas', next) }
      applyFollow() // Recompute containment on follower resize as well.
    }
    const unsubscribe = api.onUserFollow(() => {
      // Changing A -> B emits UNFOLLOW(A), FOLLOW(B) in one update. Read the
      // final native state so we never briefly clear the website's follow target.
      onFollowChangeRef.current?.(targetClientId())
      applyFollow()
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
    }
  }, [api, provider, presence, anonymous])

  // The website's user menu enters/exits the same native mode as avatar clicks.
  useEffect(() => {
    const awareness = provider?.awareness
    if (!api || !awareness) return
    const syncTarget = () => {
      const state = followClientId == null ? undefined : awareness.getStates().get(followClientId)
      // The room presence list can arrive before the peer's awareness payload.
      if (followClientId != null && followClientId !== awareness.clientID && !state?.user) return
      const target = followClientId != null && followClientId !== awareness.clientID && state?.user
        ? { socketId: String(followClientId) as SocketId, username: state.user.name ?? state.user.username ?? anonymous }
        : null
      const current = api.getAppState().userToFollow
      awareness.off('change', syncTarget)
      if (current?.socketId === target?.socketId && current?.username === target?.username) return
      api.updateScene({ appState: { userToFollow: target }, captureUpdate: CaptureUpdateAction.NEVER })
    }
    awareness.on('change', syncTarget)
    syncTarget()
    return () => awareness.off('change', syncTarget)
  }, [api, provider, followClientId, anonymous])
}
