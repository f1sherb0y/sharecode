import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import type { TLStore } from 'tldraw'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { TLInstancePresence } from '@tldraw/tlschema'
import { Spinner } from '@/components/ui'
import 'tldraw/tldraw.css'

interface CanvasViewProps {
  store: TLStore | null
  ready: boolean
  canEdit: boolean
  theme: 'light' | 'dark'
  provider: HocuspocusProvider | null
  followUserId: string | null
  followClientId: number | null
  followEnabled: boolean
}

export function CanvasView({
  store,
  ready,
  canEdit,
  theme,
  provider,
  followUserId,
  followClientId,
  followEnabled,
}: CanvasViewProps) {
  const editorRef = useRef<Editor | null>(null)
  const [mountVersion, setMountVersion] = useState(0)
  const lastFollowBoundsRef = useRef<string | null>(null)

  const applyFollow = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !followEnabled || (!followUserId && followClientId == null)) {
      lastFollowBoundsRef.current = null
      return
    }
    if (!provider?.awareness) return

    const awareness = provider.awareness
    let targetClientId: number | null = null
    const localClientId = awareness.clientID

    if (followUserId != null) {
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localClientId || targetClientId != null) return
        const user = (state as { user?: { id?: string } }).user
        if (user?.id === followUserId) targetClientId = clientId
      })
    } else if (followClientId != null) {
      targetClientId = followClientId
    }

    if (targetClientId == null) return

    const targetState = awareness.getStates().get(targetClientId) as { presence?: TLInstancePresence } | undefined
    const presence = targetState?.presence
    const targetBounds = getPresenceViewportBounds(presence)
    if (!presence || !targetBounds) return
    if (presence.currentPageId !== editor.getCurrentPageId()) return

    const signature = serializeBounds(targetBounds)
    if (signature === lastFollowBoundsRef.current) return

    const currentBounds = editor.getViewportPageBounds()
    if (boundsAreNearlyEqual(currentBounds, targetBounds)) {
      lastFollowBoundsRef.current = signature
      return
    }

    lastFollowBoundsRef.current = signature
    editor.zoomToBounds(targetBounds, {
      inset: 0,
      animation: { duration: 150 },
    })
  }, [provider, followUserId, followClientId, followEnabled])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    editor.updateInstanceState({ isReadonly: !canEdit })
    editor.user.updateUserPreferences({ colorScheme: theme })
    setMountVersion((value) => value + 1)
    applyFollow()
  }, [canEdit, theme, applyFollow])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateInstanceState({ isReadonly: !canEdit })
    }
  }, [canEdit])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.user.updateUserPreferences({ colorScheme: theme })
    }
  }, [theme])

  useEffect(() => {
    if (!editorRef.current) return
    applyFollow()
    const awareness = provider?.awareness
    if (!awareness) return

    awareness.on('change', applyFollow)

    return () => {
      awareness.off('change', applyFollow)
    }
  }, [provider, applyFollow, mountVersion])

  if (!store || !ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <Tldraw store={store} onMount={handleMount} />
    </div>
  )
}

function getPresenceViewportBounds(presence: TLInstancePresence | undefined) {
  const camera = presence?.camera
  const screenBounds = presence?.screenBounds
  if (!camera || !screenBounds || camera.z <= 0) return null

  return {
    x: -camera.x,
    y: -camera.y,
    w: screenBounds.w / camera.z,
    h: screenBounds.h / camera.z,
  }
}

function serializeBounds(bounds: { x: number; y: number; w: number; h: number }) {
  return [bounds.x, bounds.y, bounds.w, bounds.h]
    .map((value) => value.toFixed(2))
    .join(':')
}

function boundsAreNearlyEqual(
  currentBounds: { x: number; y: number; w: number; h: number },
  nextBounds: { x: number; y: number; w: number; h: number }
) {
  return (
    Math.abs(currentBounds.x - nextBounds.x) < 0.5 &&
    Math.abs(currentBounds.y - nextBounds.y) < 0.5 &&
    Math.abs(currentBounds.w - nextBounds.w) < 0.5 &&
    Math.abs(currentBounds.h - nextBounds.h) < 0.5
  )
}
