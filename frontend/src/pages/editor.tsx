import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Users, Wifi, WifiOff, RefreshCw, Check, StopCircle, Minus, Plus, Type, Share2, LogOut } from 'lucide-react'
import {
  Button,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Input,
  Label,
} from '@/components/ui'
import { api, fetchShareInfo, joinShare } from '@/api'
import { useAuthStore, useThemeStore, useFontStore, useGuestStore } from '@/stores'
import { useYjsProvider, type StatelessMessage } from '@/hooks'
import { loadMonaco } from '@/lib/monaco-loader'
import { MonacoBinding } from '@/lib/monaco-binding'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import { generateUserColor, cn } from '@/lib/utils'
import type { Room, Language, RemoteUser, ShareLinkInfo, ShareRoomSummary } from '@/types'
import type * as Monaco from 'monaco-editor'
import * as Y from 'yjs'

import 'monaco-editor/min/vs/editor/editor.main.css'

type MonacoModule = typeof Monaco
type MonacoEditorInstance = Monaco.editor.IStandaloneCodeEditor
type MonacoModel = Monaco.editor.ITextModel

const LANGUAGES: Language[] = ['javascript', 'typescript', 'python', 'java', 'cpp', 'rust', 'go', 'php']

const monacoLanguageIds: Record<Language, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  java: 'java',
  cpp: 'cpp',
  rust: 'rust',
  go: 'go',
  php: 'php',
}

export function EditorPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const [searchParams] = useSearchParams()
  const shareToken = searchParams.get('share')
  const navigate = useNavigate()
  const { t } = useTranslation()

  // Stores
  const { user, token: authToken } = useAuthStore()
  const { session: guestSession, setSession: setGuestSession, clearSession: clearGuestSession, initialize: initializeGuestSession } = useGuestStore()
  const { theme } = useThemeStore()
  const { font, fontSize, increaseFontSize, decreaseFontSize, setFont } = useFontStore()

  // Determine session type
  const isGuestMode = !!shareToken

  // State
  const [room, setRoom] = useState<Room | null>(null)
  const [shareInfo, setShareInfo] = useState<{ share: ShareLinkInfo; room: ShareRoomSummary } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])
  const [isEnding, setIsEnding] = useState(false)
  const [followingUser, setFollowingUser] = useState<number | null>(null)
  const [showShareManager, setShowShareManager] = useState(false)
  const [roomEnded, setRoomEnded] = useState(false)
  const [roomEndedAt, setRoomEndedAt] = useState<string | null>(null)

  // Guest join form state
  const [showGuestJoinForm, setShowGuestJoinForm] = useState(false)
  const [guestDisplayName, setGuestDisplayName] = useState('')
  const [guestEmail, setGuestEmail] = useState('')
  const [isJoiningAsGuest, setIsJoiningAsGuest] = useState(false)
  const [guestJoinError, setGuestJoinError] = useState('')

  // Current user info (authenticated or guest)
  const currentUser = isGuestMode && guestSession
    ? { id: guestSession.guest.id, username: guestSession.guest.displayName, color: guestSession.guest.color }
    : user

  // Room info (from API or guest session)
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

  // Permission checks
  const isOwner = !isGuestMode && (effectiveRoom?.isOwner ?? effectiveRoom?.ownerId === user?.id)
  const hasWriteAllPermission = !isGuestMode && (user?.canWriteAllRooms ?? false)
  const canEdit = isGuestMode
    ? guestSession?.guest.canEdit ?? false
    : hasWriteAllPermission || isOwner || effectiveRoom?.canEdit === true

  // Token for WebSocket connection
  const wsToken = isGuestMode ? (guestSession?.authToken ?? '') : (authToken ?? '')
  const wsDocumentId = roomId ?? ''

  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const monacoEditorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoModelRef = useRef<MonacoModel | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)

  // Handle stateless messages (room ended, etc.)
  const handleStatelessMessage = useCallback((message: StatelessMessage) => {
    if (message.type === 'room-status' && message.status === 'ended') {
      setRoomEnded(true)
      setRoomEndedAt(message.endedAt ?? null)
    }
  }, [])

  const shouldConnectWs = !!wsToken && !!wsDocumentId && !roomEnded && !(effectiveRoom?.isEnded)
  const { provider, ydoc, ytext, ymeta, isConnected, isSynced } = useYjsProvider(
    shouldConnectWs ? wsDocumentId : '',
    shouldConnectWs ? wsToken : '',
    handleStatelessMessage
  )

  // Initialize guest session if we have a share token
  useEffect(() => {
    if (!shareToken || !roomId) return

    const init = async () => {
      setIsLoading(true)
      try {
        // Try to restore existing session
        const hasSession = await initializeGuestSession(shareToken)
        if (hasSession) {
          setIsLoading(false)
          return
        }

        // No valid session, fetch share info and show join form
        const info = await fetchShareInfo(shareToken)
        setShareInfo(info)

        if (info.room.isEnded) {
          setRoomEnded(true)
          setRoomEndedAt(info.room.endedAt ?? null)
        } else {
          setShowGuestJoinForm(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load share information')
      } finally {
        setIsLoading(false)
      }
    }

    init()
  }, [shareToken, roomId, initializeGuestSession])

  // Load room data for authenticated users
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

  // Handle guest join
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
      setGuestJoinError(err instanceof Error ? err.message : 'Failed to join room')
    } finally {
      setIsJoiningAsGuest(false)
    }
  }

  // Handle guest leave
  const handleGuestLeave = () => {
    clearGuestSession()
    navigate('/')
  }

  // Initialize Monaco editor and bind Yjs
  useEffect(() => {
    if (!effectiveRoom || !editorRef.current || !provider || monacoEditorRef.current) return
    if (effectiveRoom.isEnded || roomEnded) return
    if (showGuestJoinForm) return

    let isCancelled = false

    loadMonaco()
      .then((monaco) => {
        if (isCancelled || !editorRef.current) return
        monacoRef.current = monaco

        const languageId = monacoLanguageIds[effectiveRoom.language] ?? 'javascript'
        const model = monaco.editor.createModel(ytext.toString(), languageId)
        model.setEOL(monaco.editor.EndOfLineSequence.LF)
        monacoModelRef.current = model

        const editor = monaco.editor.create(editorRef.current, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          wordWrap: 'on',
          readOnly: !canEdit,
          scrollBeyondLastLine: false,
          fontFamily: font,
          fontSize,
          theme: theme === 'dark' ? 'vs-dark' : 'vs',
          padding: { top: 16, bottom: 16 },
        })
        monacoEditorRef.current = editor

        // Create binding immediately after editor
        bindingRef.current = new MonacoBinding(
          editor,
          model,
          ytext,
          provider.awareness!,
          monaco
        )

        // Set local user in awareness
        const userColor = currentUser?.color || generateUserColor(currentUser?.id).color
        const userColorLight = generateUserColor(currentUser?.id).colorLight
        provider.awareness!.setLocalStateField('user', {
          id: currentUser?.id,
          username: currentUser?.username ?? 'Anonymous',
          color: userColor,
          colorLight: userColorLight,
        })

        editor.focus()
      })
      .catch((err) => {
        console.error('Failed to load Monaco:', err)
        setError('Failed to initialize editor')
      })

    return () => {
      isCancelled = true
    }
  }, [effectiveRoom, provider, ytext, currentUser, theme, font, fontSize, showGuestJoinForm, roomEnded, canEdit])

  // Update remote users from awareness
  useEffect(() => {
    if (!provider?.awareness) return

    const updateRemoteUsers = () => {
      const states = provider.awareness!.getStates()
      const localClientId = provider.awareness!.clientID
      const users: RemoteUser[] = []

      states.forEach((state, clientId) => {
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

  // Update Monaco theme when theme changes
  useEffect(() => {
    if (!monacoRef.current) return
    monacoRef.current.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  }, [theme])

  // Update Monaco font settings
  useEffect(() => {
    if (!monacoEditorRef.current) return
    monacoEditorRef.current.updateOptions({ fontFamily: font, fontSize })
  }, [font, fontSize])

  // Update readOnly when canEdit changes
  useEffect(() => {
    if (!monacoEditorRef.current) return
    monacoEditorRef.current.updateOptions({ readOnly: !canEdit })
  }, [canEdit])

  // Follow user feature - scroll to their cursor position
  useEffect(() => {
    if (!followingUser || !provider?.awareness || !ydoc) return
    if (!monacoRef.current || !monacoEditorRef.current || !monacoModelRef.current) return

    const scrollToUser = () => {
      if (!provider.awareness) return
      const state = provider.awareness.getStates().get(followingUser)
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
  }, [followingUser, provider, ydoc])

  // Stop following if user disconnects
  useEffect(() => {
    if (followingUser && !remoteUsers.some((u) => u.clientId === followingUser)) {
      setFollowingUser(null)
    }
  }, [remoteUsers, followingUser])

  // Listen for language changes from ymeta (synced via Yjs)
  useEffect(() => {
    if (!ymeta) return

    const handleMetaChange = () => {
      const newLanguage = ymeta.get('language') as Language | undefined
      if (newLanguage && newLanguage !== effectiveRoom?.language) {
        // Update local room state
        if (room) {
          setRoom((prev) => prev ? { ...prev, language: newLanguage } : prev)
        }
        if (guestSession) {
          setGuestSession({
            ...guestSession,
            room: { ...guestSession.room, language: newLanguage }
          })
        }
        // Update Monaco editor language
        if (monacoRef.current && monacoModelRef.current) {
          monacoRef.current.editor.setModelLanguage(
            monacoModelRef.current,
            monacoLanguageIds[newLanguage] ?? 'javascript'
          )
        }
      }
    }

    ymeta.observe(handleMetaChange)
    return () => {
      ymeta.unobserve(handleMetaChange)
    }
  }, [ymeta, effectiveRoom?.language, room, guestSession, setGuestSession])

  // Update language (owner only)
  const handleLanguageChange = useCallback(
    async (language: Language) => {
      if (!roomId || !isOwner) return

      try {
        const { room: updatedRoom } = await api.updateRoom(roomId, { language })
        setRoom(updatedRoom)

        // Sync language via Yjs shared state
        if (ymeta) {
          ymeta.set('language', language)
        }

        if (monacoRef.current && monacoModelRef.current) {
          monacoRef.current.editor.setModelLanguage(
            monacoModelRef.current,
            monacoLanguageIds[language] ?? 'javascript'
          )
        }
      } catch (err) {
        console.error('Failed to update language:', err)
      }
    },
    [roomId, isOwner, ymeta]
  )

  // End room (owner only)
  const handleEndRoom = useCallback(async () => {
    if (!roomId || !isOwner) return
    if (!confirm('Are you sure you want to end this room?')) return

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

  // Handle back navigation
  const handleBack = () => {
    if (isGuestMode) {
      navigate('/')
    } else {
      navigate('/rooms')
    }
  }

  // Cleanup
  useEffect(() => {
    return () => {
      bindingRef.current?.destroy()
      monacoEditorRef.current?.dispose()
      monacoModelRef.current?.dispose()
    }
  }, [])

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={handleBack}>{t('common.back')}</Button>
      </div>
    )
  }

  // Guest join form
  if (showGuestJoinForm && shareInfo) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{shareInfo.room.name}</CardTitle>
              <Badge variant={shareInfo.share.effectiveCanEdit ? 'default' : 'secondary'}>
                {shareInfo.share.effectiveCanEdit ? t('share.editor.permissionEdit') : t('share.editor.permissionView')}
              </Badge>
            </div>
            <CardDescription>
              {shareInfo.share.effectiveCanEdit
                ? t('share.join.descriptionEdit')
                : t('share.join.descriptionView')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleGuestJoin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">{t('share.join.nameLabel')}</Label>
                <Input
                  id="displayName"
                  value={guestDisplayName}
                  onChange={(e) => setGuestDisplayName(e.target.value)}
                  placeholder={t('share.join.namePlaceholder')}
                  required
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('share.join.emailLabel')}</Label>
                <Input
                  id="email"
                  type="email"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  placeholder={t('share.join.emailPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('share.join.emailHint')}</p>
              </div>

              {guestJoinError && <p className="text-sm text-destructive">{guestJoinError}</p>}

              <Button type="submit" className="w-full" disabled={isJoiningAsGuest || !guestDisplayName.trim()}>
                {isJoiningAsGuest ? t('share.join.joining') : t('share.join.joinButton')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Room ended state
  if (effectiveRoom?.isEnded || roomEnded) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-4 text-center">
        <h2 className="text-2xl font-semibold">{t('editor.ended.title')}</h2>
        <p className="text-muted-foreground">{t('editor.ended.subtitle')}</p>
        <p className="text-sm text-muted-foreground max-w-md">{t('editor.ended.description')}</p>
        {roomEndedAt && (
          <p className="text-xs text-muted-foreground">
            {t('editor.ended.endedAt', { time: new Date(roomEndedAt).toLocaleString() })}
          </p>
        )}
        <Button onClick={handleBack}>{t('editor.ended.back')}</Button>
      </div>
    )
  }

  // No room loaded
  if (!effectiveRoom) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen">
        {/* Toolbar */}
        <header className="flex items-center justify-between h-12 px-2 sm:px-4 border-b bg-background shrink-0 gap-2 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0 shrink">
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="font-medium truncate max-w-[100px] sm:max-w-[200px] mr-3">{effectiveRoom.name}</span>

            {isOwner ? (
              <Select value={effectiveRoom.language} onValueChange={(v) => handleLanguageChange(v as Language)}>
                <SelectTrigger className="w-24 sm:w-32 h-8 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((lang) => (
                    <SelectItem key={lang} value={lang}>
                      {lang}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="secondary" className="shrink-0 rounded-sm text-xs px-1.5 py-0">{effectiveRoom.language}</Badge>
            )}

            {/* Guest mode indicator - hidden on small screens */}
            {isGuestMode && (
              <Badge variant="outline" className="hidden sm:inline-flex shrink-0 rounded-sm text-xs px-1.5 py-0">
                {canEdit ? t('share.editor.permissionEdit') : t('share.editor.permissionView')}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {/* Font controls */}
            <div className="hidden sm:flex items-center gap-1 border rounded-md">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={decreaseFontSize}>
                    <Minus className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('editor.font.decreaseSize')}</TooltipContent>
              </Tooltip>
              <span className="text-xs w-6 text-center">{fontSize}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={increaseFontSize}>
                    <Plus className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('editor.font.increaseSize')}</TooltipContent>
              </Tooltip>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="hidden sm:inline-flex h-8 w-8">
                  <Type className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setFont('JetBrains Mono')}>
                  JetBrains Mono {font === 'JetBrains Mono' && <Check className="h-4 w-4 ml-2" />}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFont('Julia Mono')}>
                  Julia Mono {font === 'Julia Mono' && <Check className="h-4 w-4 ml-2" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Remote users */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 h-8">
                  <Users className="h-4 w-4" />
                  <span>{remoteUsers.length + 1}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="px-2 py-1.5 text-sm font-medium">{t('editor.toolbar.users')}</div>
                <div className="px-2 py-1.5 flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: currentUser?.color || generateUserColor(currentUser?.id).color }}
                  />
                  <span className="text-sm truncate">{currentUser?.username} ({t('share.editor.you')})</span>
                </div>
                {remoteUsers.map((u) => {
                  const isFollowing = followingUser === u.clientId
                  return (
                    <div
                      key={u.clientId}
                      className="px-2 py-1.5 flex items-center justify-between gap-2 hover:bg-accent rounded-sm cursor-pointer"
                      onClick={() => setFollowingUser(isFollowing ? null : u.clientId)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: u.color }} />
                        <span className="text-sm truncate">{u.username}</span>
                      </div>
                      <span
                        className={cn(
                          'text-xs shrink-0',
                          isFollowing ? 'text-primary font-medium' : 'text-muted-foreground'
                        )}
                      >
                        {isFollowing ? t('editor.toolbar.following') : t('editor.toolbar.follow')}
                      </span>
                    </div>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Share button (owner only) */}
            {isOwner && (
              <Popover open={showShareManager} onOpenChange={setShowShareManager}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3">
                    <Share2 className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">{t('editor.toolbar.share')}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end">
                  <ShareLinkManager roomId={roomId!} onClose={() => setShowShareManager(false)} />
                </PopoverContent>
              </Popover>
            )}

            {/* End room button (owner only) */}
            {isOwner && (
              <Button variant="destructive" size="sm" className="h-8 px-2 sm:px-3" onClick={handleEndRoom} disabled={isEnding}>
                <StopCircle className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">{t('editor.toolbar.endRoom')}</span>
              </Button>
            )}

            {/* Leave button (guest only) */}
            {isGuestMode && (
              <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3" onClick={handleGuestLeave}>
                <LogOut className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">{t('share.editor.leaveButton')}</span>
              </Button>
            )}
          </div>
        </header>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          <div ref={editorRef} className="h-full w-full" />
        </div>

        {/* Status bar */}
        <footer className="flex items-center justify-between h-8 px-4 border-t bg-muted/50 text-xs text-muted-foreground shrink-0">
          <div className="flex items-center gap-4">
            <div className={cn('flex items-center gap-1', isConnected ? 'text-success' : 'text-destructive')}>
              {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span>{isConnected ? t('editor.status.connected') : t('editor.status.disconnected')}</span>
            </div>
            <div className="flex items-center gap-1">
              {isSynced ? <Check className="h-3 w-3" /> : <RefreshCw className="h-3 w-3 animate-spin" />}
              <span>{isSynced ? t('editor.status.synced') : t('editor.status.syncing')}</span>
            </div>
            {isGuestMode && guestSession && (
              <span className="text-muted-foreground">
                {t('share.editor.connectedAs', { name: guestSession.guest.displayName })}
              </span>
            )}
          </div>
          <div>{effectiveRoom.language}</div>
        </footer>
      </div>
    </TooltipProvider>
  )
}
