import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, fetchShareInfo, joinShare } from '@/api'
import { useAuthStore, useGuestStore } from '@/stores'
import type { Room, Language, User, ShareLinkInfo, ShareRoomSummary } from '@/types'

export interface EditorRoomState {
  roomId: string | undefined
  shareToken: string | null
  room: Room | null
  effectiveRoom: Room | null
  currentUser: (User | { id: string; username: string; color: string }) | null
  isLoading: boolean
  error: string
  isGuestMode: boolean
  canEdit: boolean
  isOwner: boolean
  isPrivileged: boolean
  canViewPlayback: boolean
  roomEnded: boolean
  roomEndedAt: string | null
  
  // Guest Join Form State
  shareInfo: { share: ShareLinkInfo; room: ShareRoomSummary } | null
  showGuestJoinForm: boolean
  guestDisplayName: string
  setGuestDisplayName: (name: string) => void
  guestEmail: string
  setGuestEmail: (email: string) => void
  isJoiningAsGuest: boolean
  guestJoinError: string
  
  // Actions
  handleGuestJoin: (e: React.FormEvent) => Promise<void>
  handleGuestLeave: () => void
  handleEndRoom: () => Promise<void>
  handleLanguageChange: (language: Language, ymeta: any) => Promise<void>
  isEnding: boolean
  
  // Setters for local state updates (e.g. from Yjs)
  setRoom: React.Dispatch<React.SetStateAction<Room | null>>
  setRoomEnded: React.Dispatch<React.SetStateAction<boolean>>
  setRoomEndedAt: React.Dispatch<React.SetStateAction<string | null>>
}

export function useEditorRoom(): EditorRoomState {
  const { roomId } = useParams<{ roomId: string }>()
  const [searchParams] = useSearchParams()
  const shareToken = searchParams.get('share')
  const navigate = useNavigate()
  const { t } = useTranslation()

  // Stores
  const { user } = useAuthStore()
  const { session: guestSession, setSession: setGuestSession, clearSession: clearGuestSession, initialize: initializeGuestSession } = useGuestStore()

  // State
  const [room, setRoom] = useState<Room | null>(null)
  const [shareInfo, setShareInfo] = useState<{ share: ShareLinkInfo; room: ShareRoomSummary } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [roomEnded, setRoomEnded] = useState(false)
  const [roomEndedAt, setRoomEndedAt] = useState<string | null>(null)
  const [isEnding, setIsEnding] = useState(false)

  // Guest join form state
  const [showGuestJoinForm, setShowGuestJoinForm] = useState(false)
  const [guestDisplayName, setGuestDisplayName] = useState('')
  const [guestEmail, setGuestEmail] = useState('')
  const [isJoiningAsGuest, setIsJoiningAsGuest] = useState(false)
  const [guestJoinError, setGuestJoinError] = useState('')

  const isGuestMode = !!shareToken

  // Current user info
  const currentUser = isGuestMode && guestSession
    ? { id: guestSession.guest.id, username: guestSession.guest.displayName, color: guestSession.guest.color }
    : user

  // Effective room
  const effectiveRoom = isGuestMode && guestSession?.room
    ? {
        id: guestSession.room.id,
        name: guestSession.room.name,
        language: guestSession.room.language,
        isEnded: guestSession.room.isEnded || roomEnded,
        canEdit: guestSession.guest.canEdit,
        isOwner: false,
        ownerId: '',
      } as Room
    : room

  // Permissions
  const isOwner = !isGuestMode && (effectiveRoom?.isOwner ?? effectiveRoom?.ownerId === user?.id)
  const hasWriteAllPermission = !isGuestMode && (user?.canWriteAllRooms ?? false)
  const canEdit = isGuestMode
    ? guestSession?.guest.canEdit ?? false
    : hasWriteAllPermission || isOwner || effectiveRoom?.canEdit === true

  const hasGlobalReadPermission = !isGuestMode && !!user && (
    user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms
  )
  const isPrivileged = !isGuestMode && !!user && (
    user.role === 'admin' || user.role === 'superuser' || hasGlobalReadPermission
  )
  const canViewPlayback = !isGuestMode && (isOwner || isPrivileged)

  // Initialize guest session
  useEffect(() => {
    if (!shareToken || !roomId) return

    const init = async () => {
      setIsLoading(true)
      try {
        const hasSession = await initializeGuestSession(shareToken)
        if (hasSession) {
          setIsLoading(false)
          return
        }

        const info = await fetchShareInfo(shareToken)
        setShareInfo(info)

        if (info.room.isEnded) {
          setRoomEnded(true)
          setRoomEndedAt(info.room.endedAt ?? null)
        } else {
          setShowGuestJoinForm(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('share.join.loadFailed'))
      } finally {
        setIsLoading(false)
      }
    }

    init()
  }, [shareToken, roomId, initializeGuestSession])

  // Load room for auth users
  useEffect(() => {
    if (isGuestMode || !roomId || !user) return

    const loadRoom = async () => {
      try {
        setIsLoading(true)
        const { room } = await api.getRoom(roomId)
        setRoom(room)
        if (room.isEnded) {
          setRoomEnded(true)
          setRoomEndedAt(room.endedAt ?? null)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load room')
      } finally {
        setIsLoading(false)
      }
    }

    loadRoom()
  }, [roomId, user, isGuestMode])

  // Redirect to playback if ended
  useEffect(() => {
    if (!roomId) return
    if ((effectiveRoom?.isEnded || roomEnded) && canViewPlayback) {
      navigate(`/playback/${roomId}`, { replace: true })
    }
  }, [roomId, effectiveRoom?.isEnded, roomEnded, canViewPlayback, navigate])

  const handleGuestJoin = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!shareToken || !guestDisplayName.trim()) {
      setGuestJoinError(t('share.join.validationName'))
      return
    }

    try {
      setIsJoiningAsGuest(true)
      setGuestJoinError('')

      const result = await joinShare(shareToken, {
        username: guestDisplayName.trim(),
        email: guestEmail.trim() || undefined,
      })

      setGuestSession({
        shareToken,
        authToken: result.token,
        guest: result.guest,
        room: result.room,
      })

      setShowGuestJoinForm(false)
    } catch (err) {
      setGuestJoinError(err instanceof Error ? err.message : t('share.join.joinFailed'))
    } finally {
      setIsJoiningAsGuest(false)
    }
  }

  const handleGuestLeave = () => {
    clearGuestSession()
    navigate('/')
  }

  const handleEndRoom = useCallback(async () => {
    if (!roomId || !isOwner) return
    
    // We will let the UI handle the confirmation dialog now, or keep it simple here.
    // The requirement was to use Radix UI Dialog. 
    // For now, we will expose the async function and let the UI call it.
    // The previous implementation used window.confirm. 
    // We'll keep the logic pure here.
    
    setIsEnding(true)
    try {
      await api.endRoom(roomId)
      navigate('/rooms')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end room')
    } finally {
      setIsEnding(false)
    }
  }, [roomId, isOwner, navigate])

  const handleLanguageChange = useCallback(
    async (language: Language, ymeta: any) => {
      if (!roomId || !isOwner) return

      try {
        const { room: updatedRoom } = await api.updateRoom(roomId, { language })
        setRoom(updatedRoom)

        if (ymeta) {
          ymeta.set('language', language)
        }
      } catch (err) {
        console.error('Failed to update language:', err)
      }
    },
    [roomId, isOwner]
  )

  return {
    roomId,
    shareToken,
    room,
    effectiveRoom,
    currentUser,
    isLoading,
    error,
    isGuestMode,
    canEdit,
    isOwner,
    isPrivileged,
    canViewPlayback,
    roomEnded,
    roomEndedAt,
    shareInfo,
    showGuestJoinForm,
    guestDisplayName,
    setGuestDisplayName,
    guestEmail,
    setGuestEmail,
    isJoiningAsGuest,
    guestJoinError,
    handleGuestJoin,
    handleGuestLeave,
    handleEndRoom,
    handleLanguageChange,
    isEnding,
    setRoom,
    setRoomEnded,
    setRoomEndedAt
  }
}
