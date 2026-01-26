import { useState, useEffect } from 'react'
import type { RemoteUser } from '@/types'
import * as Y from 'yjs'

interface UseEditorAwarenessProps {
  provider: any // HocuspocusProvider
  ydoc: Y.Doc | null
  monacoRef: React.MutableRefObject<any>
  monacoEditorRef: React.MutableRefObject<any>
  monacoModelRef: React.MutableRefObject<any>
}

export function useEditorAwareness({
  provider,
  ydoc,
  monacoRef,
  monacoEditorRef,
  monacoModelRef
}: UseEditorAwarenessProps) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  
  // Follow target
  const [followingUserId, setFollowingUserId] = useState<string | null>(null)
  const [followingClientId, setFollowingClientId] = useState<number | null>(null)
  const isConnected = provider?.connected ?? false

  // Update remote users from awareness
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

  // Follow user feature - scroll to their cursor position
  useEffect(() => {
    if ((followingUserId == null && followingClientId == null) || !provider?.awareness || !ydoc) return
    if (!monacoRef.current || !monacoEditorRef.current || !monacoModelRef.current) return

    const scrollToUser = () => {
      if (!provider.awareness) return
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
        // Convert RelativePosition to absolute position
        const headRelative = state.cursor.head as Y.RelativePosition
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRelative, ydoc)
        if (!headAbs) return

        const position = monacoModelRef.current!.getPositionAt(headAbs.index)
        monacoEditorRef.current!.revealPositionInCenter(
          position,
          monacoRef.current!.editor.ScrollType.Smooth
        )
      } catch (err) {
        console.error('Error following user:', err)
      }
    }

    scrollToUser()
    provider.awareness.on('change', scrollToUser)

    return () => {
      provider.awareness?.off('change', scrollToUser)
    }
  }, [followingUserId, followingClientId, provider, ydoc, monacoRef, monacoEditorRef, monacoModelRef])

  // Stop following if user disconnects
  useEffect(() => {
    // Only auto-clear clientId-based follow when we are connected.
    // Stable userId follow is kept so it can resume after transient disconnects.
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
