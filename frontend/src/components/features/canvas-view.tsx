import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import type { TLStore } from 'tldraw'
import { Spinner } from '@/components/ui'
import 'tldraw/tldraw.css'

interface CanvasViewProps {
  store: TLStore | null
  ready: boolean
  canEdit: boolean
  theme: 'light' | 'dark'
  provider: any | null
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

  const applyFollow = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !followEnabled || (!followUserId && followClientId == null)) return
    if (!provider?.awareness) return

    const awareness = provider.awareness
    let targetClientId: number | null = null
    const localClientId = awareness.clientID

    if (followUserId != null) {
      awareness.getStates().forEach((state: any, clientId: number) => {
        if (clientId === localClientId || targetClientId != null) return
        if (state?.user?.id === followUserId) targetClientId = clientId
      })
    } else if (followClientId != null) {
      targetClientId = followClientId
    }

    if (targetClientId == null) return

    const targetState = (awareness.getStates() as Map<number, any>).get(targetClientId)
    const cursor = targetState?.presence?.cursor
    if (!cursor) return

    const point = { x: cursor.x, y: cursor.y }
    if (!editor.getViewportPageBounds().containsPoint(point)) {
      editor.centerOnPoint(point, { animation: { duration: 150 } })
    }
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
    if (!provider?.awareness) return

    provider.awareness.on('change', applyFollow)

    return () => {
      provider.awareness.off('change', applyFollow)
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
