import { useState, useEffect, type MutableRefObject } from 'react'
import type { RemoteUser } from '@/types'
import * as Y from 'yjs'
import type * as Monaco from 'monaco-editor'

interface UseEditorAwarenessProps {
  provider: any // HocuspocusProvider
  ydoc: Y.Doc | null
  ytext: any // Y.Text
  monacoRef: MutableRefObject<typeof Monaco | null>
  editorInstanceRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  modelRef: MutableRefObject<Monaco.editor.ITextModel | null>
}

export function useEditorAwareness({
  provider,
  ydoc,
  ytext,
  monacoRef,
  editorInstanceRef,
  modelRef,
}: UseEditorAwarenessProps) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  const [followingUserId, setFollowingUserId] = useState<string | null>(null)
  const [followingClientId, setFollowingClientId] = useState<number | null>(null)
  const isConnected = provider?.connected ?? false

  useEffect(() => {
    if (!provider?.awareness) return

    const updateRemoteUsers = () => {
      const states = provider.awareness!.getStates()
      const localClientId = provider.awareness!.clientID
      const users: RemoteUser[] = []

      states.forEach((state: any, clientId: number) => {
        if (clientId === localClientId) return
        if (!state.user) return

        const userData = state.user as Omit<RemoteUser, 'clientId'>
        users.push({
          clientId,
          ...userData,
        })
      })

      setRemoteUsers(users)
    }

    provider.awareness.on('change', updateRemoteUsers)
    updateRemoteUsers()

    return () => {
      provider.awareness?.off('change', updateRemoteUsers)
    }
  }, [provider])

  useEffect(() => {
    if ((followingUserId == null && followingClientId == null) || !provider?.awareness || !ydoc) {
      return
    }

    const scrollToUser = () => {
      if (!provider.awareness || !editorInstanceRef.current || !modelRef.current || !monacoRef.current) {
        return
      }

      let targetClientId: number | null = null
      const localClientId = provider.awareness.clientID

      if (followingUserId != null) {
        provider.awareness.getStates().forEach((state: any, clientId: number) => {
          if (targetClientId != null) return
          if (clientId === localClientId) return
          const user = state.user as { id?: string } | undefined
          if (user?.id === followingUserId) {
            targetClientId = clientId
          }
        })
      } else if (followingClientId != null) {
        targetClientId = followingClientId
      }

      if (targetClientId == null) return

      const state = provider.awareness.getStates().get(targetClientId)
      if (!state?.cursor?.head) return

      try {
        const headRelative = Y.createRelativePositionFromJSON(state.cursor.head)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRelative, ydoc)
        if (!headAbs || headAbs.type !== ytext) return

        const position = modelRef.current.getPositionAt(headAbs.index)
        editorInstanceRef.current.revealPositionInCenter(
          position,
          monacoRef.current.editor.ScrollType.Smooth,
        )
        editorInstanceRef.current.setPosition(position)
      } catch (err) {
        console.error('Error following user:', err)
      }
    }

    scrollToUser()
    provider.awareness.on('change', scrollToUser)

    return () => {
      provider.awareness?.off('change', scrollToUser)
    }
  }, [followingUserId, followingClientId, provider, ydoc, ytext, monacoRef, editorInstanceRef, modelRef])

  useEffect(() => {
    if (!isConnected) return
    if (followingClientId != null && !remoteUsers.some((u) => u.clientId === followingClientId)) {
      setFollowingClientId(null)
    }
  }, [remoteUsers, followingClientId, isConnected])

  return {
    remoteUsers,
    followingUserId,
    setFollowingUserId,
    followingClientId,
    setFollowingClientId
  }
}
