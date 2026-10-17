import { useState, useEffect, useRef, useCallback, type MutableRefObject } from 'react'
import type { RemoteUser } from '@/types'
import * as Y from 'yjs'
import { toModelOffset } from '@/lib/monaco-binding'
import { isFollowable, type FollowStatus } from '@/lib/follow'
import type * as Monaco from 'monaco-editor'
import type { HocuspocusProvider } from '@hocuspocus/provider'

// Per tab, like the session itself: a reload keeps following the same person.
const savedFollowKey = (roomId: string) => `sharecode-follow:${roomId}`
function readSavedFollow(roomId: string | undefined): { userId: string; name: string } | null {
  if (!roomId) return null
  try {
    const saved = JSON.parse(sessionStorage.getItem(savedFollowKey(roomId)) ?? 'null')
    return typeof saved?.userId === 'string' ? { userId: saved.userId, name: typeof saved.name === 'string' ? saved.name : '' } : null
  } catch {
    return null
  }
}

interface UseEditorAwarenessProps {
  roomId: string | undefined
  provider: HocuspocusProvider | null
  ydoc: Y.Doc | null
  ytext: Y.Text | null
  isConnected: boolean
  monacoRef: MutableRefObject<typeof Monaco | null>
  editorInstanceRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  modelRef: MutableRefObject<Monaco.editor.ITextModel | null>
  /** Monaco is mounted and visible, so following may scroll it. */
  editorVisible: boolean
}

export function useEditorAwareness({
  roomId,
  provider,
  ydoc,
  ytext,
  monacoRef,
  editorInstanceRef,
  modelRef,
  editorVisible,
}: UseEditorAwarenessProps) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  const [savedFollow] = useState(() => readSavedFollow(roomId))
  const [followingUserId, setFollowingUserId] = useState<string | null>(savedFollow?.userId ?? null)
  const [followingClientId, setFollowingClientId] = useState<number | null>(null)
  const [followTarget, setFollowTarget] = useState<{ status: FollowStatus; name: string } | null>(null)
  const lastFollowIndexRef = useRef<number | null>(null)
  const lastRemoteUsersSignatureRef = useRef('')

  // Opening another room in the same page restores that room's follow instead.
  // Declared before the effect that saves the follow, so it reads first.
  const followRoomRef = useRef(roomId)
  useEffect(() => {
    if (followRoomRef.current === roomId) return
    followRoomRef.current = roomId
    setFollowingClientId(null)
    setFollowingUserId(readSavedFollow(roomId)?.userId ?? null)
  }, [roomId])

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

      users.sort((left, right) => {
        const leftSlot = left.colorSlot ?? Number.MAX_SAFE_INTEGER
        const rightSlot = right.colorSlot ?? Number.MAX_SAFE_INTEGER
        if (leftSlot !== rightSlot) return leftSlot - rightSlot
        return left.clientId - right.clientId
      })
      const signature = users
        .map((user) =>
          [
            user.clientId,
            user.id ?? '',
            user.username ?? '',
            user.colorSlot ?? '',
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

  // A reloaded presenter (or a reloaded follower restoring its follow) has a new
  // awareness client id: keep following the same account or guest by its id.
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness || followingUserId == null) return
    const resolve = () => {
      const states = awareness.getStates()
      if (followingClientId != null && states.get(followingClientId)?.user) return
      for (const [clientId, state] of states) {
        if (clientId !== awareness.clientID && (state.user as { id?: string } | undefined)?.id === followingUserId) {
          setFollowingClientId(clientId)
          return
        }
      }
    }
    resolve()
    awareness.on('change', resolve)
    return () => awareness.off('change', resolve)
  }, [provider, followingUserId, followingClientId])

  // A follow outlives the presenter opting out, reloading or dropping offline:
  // it pauses and resumes by itself. Only the follower ends it.
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness || (followingClientId == null && followingUserId == null)) {
      setFollowTarget(null)
      return
    }
    const update = () => {
      const state = followingClientId == null ? undefined : awareness.getStates().get(followingClientId)
      const user = state?.user as { name?: string; username?: string } | undefined
      const status: FollowStatus = !state ? 'away' : isFollowable(state) ? 'active' : 'blocked'
      setFollowTarget(prev => {
        const name = user?.name ?? user?.username ?? prev?.name ?? (savedFollow?.userId === followingUserId ? savedFollow?.name : undefined) ?? ''
        return prev?.status === status && prev.name === name ? prev : { status, name }
      })
    }
    update()
    awareness.on('change', update)
    return () => awareness.off('change', update)
  }, [provider, followingClientId, followingUserId, savedFollow])

  const followName = followTarget?.name ?? ''
  useEffect(() => {
    if (!roomId) return
    try {
      if (followingUserId == null) sessionStorage.removeItem(savedFollowKey(roomId))
      else sessionStorage.setItem(savedFollowKey(roomId), JSON.stringify({ userId: followingUserId, name: followName }))
    } catch { /* Following still works for this page without web storage. */ }
  }, [roomId, followingUserId, followName])

  // A hidden editor cannot scroll; resuming re-centres on the presenter's cursor.
  const scrollActive = editorVisible && followTarget?.status === 'active'
  useEffect(() => {
    lastFollowIndexRef.current = null
    const awareness = provider?.awareness
    if (followingClientId == null || !scrollActive || !awareness || !ydoc) return

    const scrollToUser = () => {
      const editor = editorInstanceRef.current
      const model = modelRef.current
      const monaco = monacoRef.current
      if (!editor || !model || !monaco) return

      const state = awareness.getStates().get(followingClientId) as
        | { view?: unknown; cursor?: { head?: unknown } }
        | undefined
      if (state?.view === 'canvas' || !isFollowable(state) || !state?.cursor?.head) return

      try {
        const headRelative = Y.createRelativePositionFromJSON(state.cursor.head as object)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRelative, ydoc)
        if (!headAbs || headAbs.type !== ytext) return

        if (lastFollowIndexRef.current === headAbs.index) return
        lastFollowIndexRef.current = headAbs.index

        // Monaco keeps a zero-height layout while hidden until its resize observer runs.
        if (editor.getLayoutInfo().height === 0) editor.layout()
        const position = model.getPositionAt(toModelOffset(ytext?.toString() ?? '', headAbs.index))
        editor.revealPositionInCenter(position, monaco.editor.ScrollType.Smooth)
      } catch (err) {
        console.error('Error following user:', err)
      }
    }

    scrollToUser()
    awareness.on('change', scrollToUser)

    return () => {
      awareness.off('change', scrollToUser)
    }
  }, [followingClientId, scrollActive, provider, ydoc, ytext, monacoRef, editorInstanceRef, modelRef])

  const follow = useCallback((clientId: number, userId: string | null) => {
    setFollowingClientId(clientId)
    setFollowingUserId(userId)
  }, [])
  const unfollow = useCallback(() => {
    setFollowingClientId(null)
    setFollowingUserId(null)
  }, [])

  return {
    remoteUsers,
    followingClientId,
    followingUserId,
    followTarget,
    follow,
    unfollow,
  }
}
