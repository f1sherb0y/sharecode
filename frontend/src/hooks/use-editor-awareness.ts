import { useState, useEffect, useRef } from 'react'
import type { RemoteUser } from '@/types'
import * as Y from 'yjs'
import { EditorView } from '@codemirror/view'

interface UseEditorAwarenessProps {
  provider: any // HocuspocusProvider
  ydoc: Y.Doc | null
  viewRef: React.MutableRefObject<EditorView | null>
}

export function useEditorAwareness({
  provider,
  ydoc,
  viewRef,
}: UseEditorAwarenessProps) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  
  // Follow target
  const [followingUserId, setFollowingUserId] = useState<string | null>(null)
  const [followingClientId, setFollowingClientId] = useState<number | null>(null)
  const lastFollowedPosRef = useRef<number | null>(null)
  const pendingFollowPosRef = useRef<number | null>(null)
  const followMeasureQueuedRef = useRef(false)
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
    if ((followingUserId == null && followingClientId == null) || !provider?.awareness || !ydoc) {
      lastFollowedPosRef.current = null
      pendingFollowPosRef.current = null
      followMeasureQueuedRef.current = false
      return
    }
    if (!viewRef.current) return

    const scheduleFollowScroll = (headIndex: number) => {
      const view = viewRef.current
      if (!view) return

      pendingFollowPosRef.current = headIndex
      if (followMeasureQueuedRef.current) return

      followMeasureQueuedRef.current = true
      view.requestMeasure({
        read: (measuringView) => {
          const targetHead = pendingFollowPosRef.current
          if (targetHead == null) return null

          const scroller = measuringView.scrollDOM
          const block = measuringView.lineBlockAt(targetHead)
          const blockBottom = block.top + block.height
          
          const scrollTop = scroller.scrollTop
          const clientHeight = scroller.clientHeight
          const scrollBottom = scrollTop + clientHeight
          
          // Check if the line is fully visible in the actual scroll viewport
          // (CodeMirror's visibleRanges includes off-screen rendered margins, which causes broken tracking)
          const isVisible = block.top >= scrollTop && blockBottom <= scrollBottom

          console.debug('[follow-debug:target]', {
            headIndex: targetHead,
            currentHead: measuringView.state.selection.main.head,
            isVisible,
            lastFollowedPos: lastFollowedPosRef.current,
            followingUserId,
            followingClientId,
            blockTop: block.top,
            blockBottom,
            scrollTop,
            scrollBottom,
          })

          if (isVisible) {
            return {
              targetHead,
              isVisible,
            }
          }

          const targetCenter = (block.top + blockBottom) / 2
          const desiredScrollTop = Math.max(
            0,
            Math.min(
              targetCenter - clientHeight / 2,
              scroller.scrollHeight - clientHeight
            )
          )

          return {
            targetHead,
            isVisible,
            blockTop: block.top,
            blockHeight: block.height,
            targetCenter,
            currentScrollTop: scrollTop,
            desiredScrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight,
          }
        },
        write: (measure) => {
          followMeasureQueuedRef.current = false
          const activeView = viewRef.current
          const targetHead = pendingFollowPosRef.current
          pendingFollowPosRef.current = null

          if (!activeView || !measure || targetHead == null) return
          if (measure.targetHead !== targetHead) {
            scheduleFollowScroll(targetHead)
            return
          }

          if (measure.isVisible) {
            lastFollowedPosRef.current = targetHead
            return
          }

          console.debug('[follow-debug:scroll]', measure)

          setTimeout(() => {
            if (!viewRef.current) return
            viewRef.current.dispatch({
              effects: EditorView.scrollIntoView(targetHead, { y: 'center' })
            })
          }, 0)

          lastFollowedPosRef.current = targetHead
        },
      })
    }

    const scrollToUser = () => {
      if (!provider.awareness || !viewRef.current) return
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
        const headRelative = Y.createRelativePositionFromJSON(state.cursor.head)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRelative, ydoc)
        if (!headAbs) return

        scheduleFollowScroll(headAbs.index)
      } catch (err) {
        console.error('Error following user:', err)
      }
    }

    scrollToUser()
    provider.awareness.on('change', scrollToUser)

    return () => {
      provider.awareness?.off('change', scrollToUser)
      followMeasureQueuedRef.current = false
    }
  }, [followingUserId, followingClientId, provider, ydoc, viewRef])

  // Debug follow-mode viewport changes in the browser console.
  useEffect(() => {
    if (!viewRef.current) return

    const view = viewRef.current
    const scroller = view.scrollDOM

    const logViewPosition = (reason: string) => {
      const selection = view.state.selection.main
      console.debug('[follow-debug:view]', {
        reason,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        viewport: view.viewport,
        visibleRanges: view.visibleRanges,
        selection: {
          anchor: selection.anchor,
          head: selection.head,
          empty: selection.empty,
        },
        followingUserId,
        followingClientId,
        activeElement:
          document.activeElement instanceof HTMLElement
            ? {
                tagName: document.activeElement.tagName,
                className: document.activeElement.className,
              }
            : null,
      })
    }

    const onScroll = () => logViewPosition('scroll')

    scroller.addEventListener('scroll', onScroll, { passive: true })
    logViewPosition('attach')

    return () => {
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [viewRef, followingUserId, followingClientId])

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
