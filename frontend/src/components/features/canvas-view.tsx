import { useCallback, useEffect, useRef } from 'react'
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
  const lastFollowRef = useRef<string | null>(null)

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    editor.updateInstanceState({ isReadonly: !canEdit })
    editor.user.updateUserPreferences({ colorScheme: theme })
  }, [canEdit, theme])

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
    const editor = editorRef.current
    if (!editor) return
    if (!followEnabled || (!followUserId && followClientId == null)) {
      if (lastFollowRef.current) {
        editor.stopFollowingUser()
        lastFollowRef.current = null
      }
      return
    }
    if (!provider?.awareness) return

    const updateFollow = () => {
      const awareness = provider.awareness
      let targetClientId: number | null = null
      const localClientId = awareness.clientID

      if (followUserId != null) {
        awareness.getStates().forEach((state: any, clientId: number) => {
          if (clientId === localClientId || targetClientId != null) return
          if (state?.user?.id === followUserId) {
            targetClientId = clientId
          }
        })
      } else if (followClientId != null) {
        targetClientId = followClientId
      }

      const target = targetClientId != null ? targetClientId.toString() : null
      if (target === lastFollowRef.current) return

      if (target) {
        editor.startFollowingUser(target)
      } else if (lastFollowRef.current) {
        editor.stopFollowingUser()
      }
      lastFollowRef.current = target
    }

    updateFollow()
    provider.awareness.on('change', updateFollow)

    return () => {
      provider.awareness.off('change', updateFollow)
    }
  }, [provider, followUserId, followClientId, followEnabled])

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
