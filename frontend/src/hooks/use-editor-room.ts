import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '@/api'
import { canEndRoom as canEndRoomByMatrix, canManageRoomShares, canChangeRoomLanguage } from '@/lib/room-permissions'
import { useAuthStore } from '@/stores'
import type * as Y from 'yjs'
import type { Room, Language, User, ShareGuest } from '@/types'

export interface EditorRoomState {
  roomId: string | undefined
  room: Room | null
  effectiveRoom: Room | null
  currentUser: (User | { id: string; username: string; color: string }) | null
  isLoading: boolean
  error: string
  isGuestMode: boolean
  canEdit: boolean
  canChangeLanguage: boolean
  isOwner: boolean
  canManageRoom: boolean
  canEndRoom: boolean
  isPrivileged: boolean
  canViewPlayback: boolean
  roomEnded: boolean
  roomEndedAt: string | null
  handleGuestLeave: () => void
  handleEndRoom: () => Promise<void>
  handleLanguageChange: (language: Language, ymeta: unknown) => Promise<void>
  isEnding: boolean
  setRoom: React.Dispatch<React.SetStateAction<Room | null>>
  setRoomEnded: React.Dispatch<React.SetStateAction<boolean>>
  setRoomEndedAt: React.Dispatch<React.SetStateAction<string | null>>
}

function guestToUser(guest: ShareGuest): { id: string; username: string; color: string } {
  return { id: guest.id, username: guest.displayName, color: guest.color }
}

export function useEditorRoom(): EditorRoomState {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()

  const { user, actorType, guestProfile, clearGuestSession } = useAuthStore()
  const isGuestMode = actorType === 'guest'

  const [room, setRoom] = useState<Room | null>(null)
  const [guestRoom, setGuestRoom] = useState(isGuestMode ? (guestProfile?.room ?? null) : null)
  const [isLoading, setIsLoading] = useState(!isGuestMode)

  // Re-sync guestRoom whenever the guest session changes (joining a new room
  // swaps guestProfile). Without this, useState's initializer only runs once
  // and guestRoom stays frozen on the first room the guest ever joined —
  // EditorPage doesn't remount across /room/A → /room/B since the route
  // pattern is the same.
  useEffect(() => {
    setGuestRoom(isGuestMode ? (guestProfile?.room ?? null) : null)
  }, [isGuestMode, guestProfile])
  const [error, setError] = useState('')
  const [roomEnded, setRoomEnded] = useState(false)
  const [roomEndedAt, setRoomEndedAt] = useState<string | null>(null)
  const [isEnding, setIsEnding] = useState(false)

  const currentUser = useMemo(() => {
    if (isGuestMode && guestProfile) return guestToUser(guestProfile.guest)
    return user
  }, [isGuestMode, guestProfile, user])

  const roomMismatch = isGuestMode && guestProfile?.room.id !== roomId
  const effectiveRoom = useMemo((): Room | null => {
    if (roomMismatch) return null
    if (isGuestMode && guestRoom && guestProfile && guestRoom.id === roomId) {
      return {
        id: guestRoom.id,
        name: guestRoom.name,
        language: guestRoom.language,
        isEnded: guestRoom.isEnded || roomEnded,
        endedAt: guestRoom.endedAt ?? null,
        canEdit: guestProfile.guest.canEdit,
        allowEdit: guestRoom.allowEdit,
        isOwner: false,
        ownerId: '',
        createdAt: '',
        updatedAt: '',
        owner: { id: '', username: '', color: '' },
      } as Room
    }
    return room?.id === roomId ? room : null
  }, [isGuestMode, guestRoom, guestProfile, roomEnded, room, roomId, roomMismatch])

  // Load room for authenticated users
  useEffect(() => {
    if (isGuestMode || !roomId || !user) return
    const abort = new AbortController()
    const loadRoom = async () => {
      try {
        setIsLoading(true)
        const { room: loaded } = await api.getRoom(roomId, abort.signal)
        if (abort.signal.aborted) return
        if (loaded.id !== roomId) throw new Error("Room identity mismatch")
        setRoom(loaded)
        if (loaded.isEnded) {
          setRoomEnded(true)
          setRoomEndedAt(loaded.endedAt ?? null)
        }
      } catch (err) {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load room')
      } finally {
        if (!abort.signal.aborted) setIsLoading(false)
      }
    }
    void loadRoom()
    return () => abort.abort()
  }, [roomId, user, isGuestMode])

  // Sync initial ended state from guest profile
  useEffect(() => {
    if (isGuestMode && guestProfile?.room.isEnded) {
      setRoomEnded(true)
      setRoomEndedAt(guestProfile.room.endedAt ?? null)
    }
  }, [isGuestMode, guestProfile])

  const isOwner = !isGuestMode && (effectiveRoom?.isOwner ?? effectiveRoom?.ownerId === user?.id)
  const canChangeLanguage = !isGuestMode && canChangeRoomLanguage(user, effectiveRoom?.ownerId)
  const hasWriteAllPermission = !isGuestMode && (user?.canWriteAllRooms ?? false)
  const canEdit = isGuestMode
    ? (guestProfile?.guest.canEdit ?? false)
    : hasWriteAllPermission || isOwner || effectiveRoom?.canEdit === true
  const canManageRoom =
    !isGuestMode && canManageRoomShares(user, effectiveRoom?.ownerId)
  const canEndRoom = !isGuestMode && canEndRoomByMatrix(user, effectiveRoom?.ownerId)
  const hasGlobalReadPermission =
    !isGuestMode &&
    !!user &&
    (user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms)
  const isPrivileged =
    !isGuestMode &&
    !!user &&
    (user.role === 'superuser' || hasGlobalReadPermission)
  const canViewPlayback = !isGuestMode && (isOwner || isPrivileged)

  // Redirect to playback when room ends (privileged users)
  useEffect(() => {
    if (!roomId) return
    if ((effectiveRoom?.isEnded || roomEnded) && canViewPlayback) {
      navigate(`/playback/${roomId}`, { replace: true })
    }
  }, [roomId, effectiveRoom?.isEnded, roomEnded, canViewPlayback, navigate])

  const handleGuestLeave = useCallback(() => {
    clearGuestSession()
    navigate('/')
  }, [clearGuestSession, navigate])

  const handleEndRoom = useCallback(async () => {
    if (!roomId || !canEndRoom) return
    setIsEnding(true)
    try {
      await api.endRoom(roomId)
      navigate('/rooms')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end room')
    } finally {
      setIsEnding(false)
    }
  }, [roomId, canEndRoom, navigate])

  const handleLanguageChange = useCallback(
    async (language: Language, ymeta: unknown) => {
      if (!roomId || !canChangeLanguage) return
      try {
        const meta = ymeta && typeof (ymeta as { set?: unknown }).set === 'function'
          ? ymeta as Y.Map<unknown> : null
        // Prepare the inactive Markdown document BEFORE the request: the server
        // broadcasts its language change over WebSocket before HTTP resolves.
        // Clearing it afterwards erases the just-mounted editor's seeded content.
        // Keep language unchanged until success; the code source remains intact
        // even if the request fails, ready for the next conversion attempt.
        if (language === 'markdown' && effectiveRoom?.language !== 'markdown') {
          meta?.doc?.transact(() => {
            const fragment = meta.doc!.getXmlFragment('prosemirror')
            fragment.delete(0, fragment.length)
            meta.delete('markdownInitialized')
            meta.set('markdownSeeder', meta.doc!.clientID)
          })
        }
        const { room: updated } = await api.updateRoom(roomId, { language })
        setRoom(prev => prev ? { ...prev, ...updated } : updated)
        meta?.set('language', language)
      } catch (err) {
        throw err
      }
    },
    [roomId, canChangeLanguage, effectiveRoom?.language]
  )

  // setRoom wrapper: for guest mode updates (e.g. language from Yjs), update guestRoom state
  const setRoomWithGuestUpdate: React.Dispatch<React.SetStateAction<Room | null>> = useCallback(
    (value) => {
      if (isGuestMode) {
        setGuestRoom((prev) => {
          if (!prev) return prev
          const next = typeof value === 'function' ? value(effectiveRoom) : value
          if (!next) return prev
          return { ...prev, language: next.language, name: next.name, isEnded: next.isEnded, endedAt: next.endedAt }
        })
      } else {
        setRoom(value)
      }
    },
    [isGuestMode, effectiveRoom]
  )

  return {
    roomId,
    room,
    effectiveRoom,
    currentUser,
    isLoading,
    error: roomMismatch ? "Room access denied: this tab is authorized for another room. Open the correct invitation in a new tab." : error,
    isGuestMode,
    canEdit,
    canChangeLanguage,
    isOwner,
    canManageRoom,
    canEndRoom,
    isPrivileged,
    canViewPlayback,
    roomEnded,
    roomEndedAt,
    handleGuestLeave,
    handleEndRoom,
    handleLanguageChange,
    isEnding,
    setRoom: setRoomWithGuestUpdate,
    setRoomEnded,
    setRoomEndedAt,
  }
}
