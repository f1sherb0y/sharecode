import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import type { RemoteUser } from '@/types'
import * as Y from 'yjs'
import type * as Monaco from 'monaco-editor'
import type { HocuspocusProvider } from '@hocuspocus/provider'

interface UseEditorAwarenessProps {
  provider: HocuspocusProvider | null
  ydoc: Y.Doc | null
  ytext: Y.Text | null
  isConnected: boolean
  monacoRef: MutableRefObject<typeof Monaco | null>
  editorInstanceRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  modelRef: MutableRefObject<Monaco.editor.ITextModel | null>
}

export function useEditorAwareness({
  provider,
  ydoc,
  ytext,
  isConnected,
  monacoRef,
  editorInstanceRef,
  modelRef,
}: UseEditorAwarenessProps) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  const [followingUserId, setFollowingUserId] = useState<string | null>(null)
  const [followingClientId, setFollowingClientId] = useState<number | null>(null)
  const lastFollowIndexRef = useRef<number | null>(null)
  const lastRemoteUsersSignatureRef = useRef('')

  useEffect(() => {
    if (!provider?.awareness) return

    const updateRemoteUsers = () => {
      const states = provider.awareness!.getStates()
      const localClientId = provider.awareness!.clientID
      const users: RemoteUser[] = []

      states.forEach((state, clientId) => {
        if (clientId === localClientId) return
        if (!state.user) return

        const userData = state.user as Omit<RemoteUser, 'clientId'> & { name?: string }
        users.push({
          clientId,
          ...userData,
          username: userData.username ?? userData.name ?? '',
        })
      })

      users.sort((left, right) => left.clientId - right.clientId)
      const signature = users
        .map((user) =>
          [
            user.clientId,
            user.id ?? '',
            user.username ?? '',
            user.color ?? '',
            user.colorLight ?? '',
          ].join(':')
        )
        .join('|')

      if (signature === lastRemoteUsersSignatureRef.current) return
      lastRemoteUsersSignatureRef.current = signature
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
      lastFollowIndexRef.current = null
      return
    }

    lastFollowIndexRef.current = null

    const scrollToUser = () => {
      if (!provider.awareness || !editorInstanceRef.current || !modelRef.current || !monacoRef.current) {
        return
      }

      let targetClientId: number | null = null
      const localClientId = provider.awareness.clientID

      if (followingUserId != null) {
        provider.awareness.getStates().forEach((state, clientId) => {
          if (targetClientId != null) return
          if (clientId === localClientId) return
          const user = (state as { user?: { id?: string } }).user
          if (user?.id === followingUserId) {
            targetClientId = clientId
          }
        })
      } else if (followingClientId != null) {
        targetClientId = followingClientId
      }

      if (targetClientId == null) return

      const state = provider.awareness.getStates().get(targetClientId) as
        | { cursor?: { head?: unknown } }
        | undefined
      if (!state?.cursor?.head) return

      try {
        const headRelative = Y.createRelativePositionFromJSON(state.cursor.head as object)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRelative, ydoc)
        if (!headAbs || headAbs.type !== ytext) return

        if (lastFollowIndexRef.current === headAbs.index) return
        lastFollowIndexRef.current = headAbs.index

        const position = modelRef.current.getPositionAt(headAbs.index)
        editorInstanceRef.current.revealPositionInCenter(
          position,
          monacoRef.current.editor.ScrollType.Smooth,
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
