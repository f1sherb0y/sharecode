import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Users,
  Wifi,
  WifiOff,
  RefreshCw,
  Check,
  StopCircle,
  Minus,
  Plus,
  Type,
  Share2,
  LogOut,
  Play,
  Loader2,
  MoreVertical,
  Sparkles,
  FileCode,
  Brush,
} from 'lucide-react'
import * as Y from 'yjs'
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
  DropdownMenuSeparator,
  DropdownMenuLabel,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { useAuthStore, useFontStore, useGuestStore, useThemeStore } from '@/stores'
import { useEditorRoom, useCodeMirrorEditor, useEditorAwareness, useYjsProvider, useTldrawStore, type StatelessMessage } from '@/hooks'
import { CanvasView } from '@/components/features/canvas-view'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import { CodeRunnerPanel, type CodeRunnerPanelRef } from '@/components/features/code-runner-panel'
import { ThemeToggle } from '@/components/layout'
import { generateUserColor, cn, getTimezone } from '@/lib/utils'
import type { Language } from '@/types'

const LANGUAGES: Language[] = ['javascript', 'typescript', 'python', 'java', 'cpp', 'rust', 'go', 'php', 'markdown', 'verilog']
const DOC_VIEWS = ['code', 'canvas'] as const
const RUNNER_POSITIONS = ['bottom', 'right'] as const

function parseDocView(value: string | null): 'code' | 'canvas' {
  return DOC_VIEWS.includes((value ?? '') as (typeof DOC_VIEWS)[number]) ? (value as 'code' | 'canvas') : 'code'
}

function parseRunnerPosition(value: string | null): 'bottom' | 'right' {
  return RUNNER_POSITIONS.includes((value ?? '') as (typeof RUNNER_POSITIONS)[number])
    ? (value as 'bottom' | 'right')
    : 'right'
}

export function EditorPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()
  const { token: authToken } = useAuthStore()
  const { session: guestSession } = useGuestStore()
  const { font, fontSize, increaseFontSize, decreaseFontSize, setFont } = useFontStore()
  const { theme } = useThemeStore()
  const [showShareManager, setShowShareManager] = useState(false)
  const [isCodeRunning, setIsCodeRunning] = useState(false)
  const [isRunnerExpanded, setIsRunnerExpanded] = useState(false)
  const activeDoc = parseDocView(searchParams.get('view'))
  const codeRunnerPosition = parseRunnerPosition(searchParams.get('runner'))
  
  // State for End Room Dialog
  const [isEndRoomDialogOpen, setIsEndRoomDialogOpen] = useState(false)

  const updateEditorParams = useCallback((updates: { view?: 'code' | 'canvas'; runner?: 'bottom' | 'right' }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('view', updates.view ?? activeDoc)
      next.set('runner', updates.runner ?? codeRunnerPosition)
      return next
    })
  }, [setSearchParams, activeDoc, codeRunnerPosition])

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (normalized.get('view') !== activeDoc) {
      normalized.set('view', activeDoc)
      changed = true
    }
    if (normalized.get('runner') !== codeRunnerPosition) {
      normalized.set('runner', codeRunnerPosition)
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, activeDoc, codeRunnerPosition, setSearchParams])

  // 1. Room & Auth Hook
  const {
    roomId,
    effectiveRoom,
    currentUser,
    isLoading,
    error: roomError,
    isGuestMode,
    canEdit,
    isOwner,
    canManageRoom,
    canEndRoom,
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
    handleLanguageChange: updateRoomLanguage,
    isEnding,
    setRoom,
    setRoomEnded,
    setRoomEndedAt,
  } = useEditorRoom()

  const [localError, setLocalError] = useState('')
  const displayError = roomError || localError

  const handleStatelessMessage = useCallback((message: StatelessMessage) => {
    if (message.type === 'room-status' && message.status === 'ended') {
      setRoomEnded(true)
      setRoomEndedAt(message.endedAt ?? null)
    }
  }, [setRoomEnded, setRoomEndedAt])

  const wsToken = isGuestMode ? (guestSession?.authToken ?? '') : (authToken ?? '')
  const wsDocumentId = roomId ?? ''
  const shouldConnectWs = !!wsToken && !!wsDocumentId && !roomEnded && !(effectiveRoom?.isEnded)

  const { provider, ydoc, ytext, ymeta, isConnected, isSynced } = useYjsProvider(
    shouldConnectWs ? wsDocumentId : '',
    shouldConnectWs ? wsToken : '',
    handleStatelessMessage
  )

  const { store: tldrawStore, ready: tldrawReady } = useTldrawStore({
    ydoc,
    provider,
    isSynced,
    user: currentUser,
  })

  // 3. CodeMirror Hook
  const {
    editorRef,
    viewRef,
    updateLanguage
  } = useCodeMirrorEditor({
    effectiveRoom,
    ytext,
    provider,
    canEdit,
    currentUser,
    roomEnded,
    showGuestJoinForm,
    setError: setLocalError
  })

  // 4. Awareness Hook
  const {
    remoteUsers,
    followingUserId,
    setFollowingUserId,
    followingClientId,
    setFollowingClientId
  } = useEditorAwareness({
    provider,
    ydoc,
    viewRef
  })

  // Code Runner Ref
  const codeRunnerRef = useRef<CodeRunnerPanelRef>(null)

  // Listen for language changes from ymeta
  useEffect(() => {
    if (!ymeta) return

    const handleMetaChange = () => {
      const newLanguage = ymeta.get('language') as Language | undefined
      if (newLanguage && newLanguage !== effectiveRoom?.language) {
        // Update local room state
        setRoom((prev) => prev ? { ...prev, language: newLanguage } : prev)
        // Update Editor Language
        updateLanguage(newLanguage)
      }
    }

    // Call updateLanguage immediately if we are already out of sync
    if (effectiveRoom?.language) {
       const metaLang = ymeta.get('language') as Language | undefined
       if (metaLang && metaLang !== effectiveRoom.language) {
          updateLanguage(metaLang)
       }
    }

    ymeta.observe(handleMetaChange)
    return () => {
      ymeta.unobserve(handleMetaChange)
    }
  }, [ymeta, effectiveRoom?.language, setRoom, updateLanguage])

  // Wrapper for language change to update both API and Yjs
  const onLanguageChange = async (lang: Language) => {
    await updateRoomLanguage(lang, ymeta)
    updateLanguage(lang)
  }

  // Back Navigation
  const handleBack = () => {
    if (isGuestMode) {
      navigate('/')
    } else {
      navigate('/rooms')
    }
  }

  // Code Runner
  const getCode = useCallback(() => {
    return viewRef.current?.state.doc.toString() ?? ''
  }, [viewRef])

  const handleRunCode = useCallback(async () => {
    if (!codeRunnerRef.current || !canEdit) return
    setIsCodeRunning(true)
    try {
      await codeRunnerRef.current.run()
    } finally {
      setIsCodeRunning(false)
    }
  }, [canEdit])

  const handleBlink = useCallback(() => {
    if (!provider?.awareness || !viewRef.current) return

    const selection = viewRef.current.state.selection.main

    provider.awareness.setLocalStateField('blink', {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
      ts: Date.now(),
    })
  }, [provider, viewRef, ytext])

  const canBlink =
    activeDoc === 'code' &&
    !!provider?.awareness &&
    !!viewRef.current

  useEffect(() => {
    if (activeDoc === 'code') {
      viewRef.current?.requestMeasure()
    }
  }, [activeDoc, viewRef])

  // Loading View
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  // Error View
  if (displayError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-destructive">{displayError}</p>
        <Button onClick={handleBack}>{t('common.back')}</Button>
      </div>
    )
  }

  // Guest Join Form
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

  // Room Ended View
  if (effectiveRoom?.isEnded || roomEnded) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-4 text-center">
        <h2 className="text-2xl font-semibold">{t('editor.ended.title')}</h2>
        <p className="text-muted-foreground">{t('editor.ended.subtitle')}</p>
        <p className="text-sm text-muted-foreground max-w-md">{t('editor.ended.description')}</p>
        {roomEndedAt && (
          <p className="text-xs text-muted-foreground">
            {t('editor.ended.endedAt', { time: new Date(roomEndedAt).toLocaleString(undefined, { timeZone: getTimezone() }) })}
          </p>
        )}
        <Button onClick={handleBack}>{t('editor.ended.back')}</Button>
      </div>
    )
  }

  if (!effectiveRoom) return null

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen overflow-clip safe-x" style={{ height: '100dvh' }}>
        {/* Toolbar */}
        <header className="flex items-center justify-between h-14 px-2 sm:px-4 border-b bg-background shrink-0 gap-2 overflow-hidden">
          {/* Left: Back + Title + Language */}
          <div className="flex items-center gap-2 min-w-0 shrink">
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="font-medium truncate max-w-[100px] sm:max-w-[200px] mr-2">{effectiveRoom.name}</span>

            {isOwner ? (
              <Select value={effectiveRoom.language} onValueChange={(v) => onLanguageChange(v as Language)}>
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

            <div className="hidden sm:flex items-center rounded-md border bg-muted/40 p-0.5 ml-1">
              <Button
                variant={activeDoc === 'code' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2"
                onClick={() => updateEditorParams({ view: 'code' })}
              >
                <FileCode className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden md:inline">{t('editor.toolbar.code')}</span>
              </Button>
              <Button
                variant={activeDoc === 'canvas' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2"
                onClick={() => updateEditorParams({ view: 'canvas' })}
              >
                <Brush className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden md:inline">{t('editor.toolbar.canvas')}</span>
              </Button>
            </div>

             {isGuestMode && (
              <Badge variant="outline" className="hidden sm:inline-flex shrink-0 rounded-sm text-xs px-1.5 py-0">
                {canEdit ? t('share.editor.permissionEdit') : t('share.editor.permissionView')}
              </Badge>
            )}
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            
            {/* Desktop: Font Controls */}
            <div className="hidden md:flex items-center gap-1 border rounded-md mr-2">
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

            {/* Desktop: Font Family */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="hidden md:inline-flex h-8 w-8 mr-2">
                  <Type className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setFont('JetBrains Mono')}>
                  JetBrains Mono {font === 'JetBrains Mono' && <Check className="h-4 w-4 ml-2" />}
                </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setFont('JuliaMono')}>                  Julia Mono {font === 'Julia Mono' && <Check className="h-4 w-4 ml-2" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Users Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 h-8">
                  <Users className="h-4 w-4" />
                  <span>{remoteUsers.length + 1}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t('editor.toolbar.users')}
                </DropdownMenuLabel>
                
                {/* Current User */}
                <div className="px-2 py-1.5 flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: currentUser?.color || generateUserColor(currentUser?.id).color }}
                  />
                  <span className="text-sm truncate flex-1">{currentUser?.username} ({t('share.editor.you')})</span>
                </div>
                
                <DropdownMenuSeparator />
                
                {/* Remote Users */}
                {remoteUsers.length === 0 && (
                   <div className="px-2 py-2 text-xs text-muted-foreground text-center">
                     No other users connected
                   </div>
                )}
                
                {remoteUsers.map((u) => {
                  const isFollowing =
                    (followingUserId != null && u.id != null && followingUserId === u.id) ||
                    (followingUserId == null && followingClientId != null && followingClientId === u.clientId)
                  const toggleFollow = () => {
                    if (isFollowing) {
                      setFollowingUserId(null)
                      setFollowingClientId(null)
                    } else {
                      if (u.id) setFollowingUserId(u.id)
                      else setFollowingClientId(u.clientId)
                    }
                  }
                  return (
                    <DropdownMenuItem
                      key={u.clientId}
                      className="gap-2 cursor-pointer"
                      onClick={toggleFollow}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: u.color }} />
                      <span className="truncate flex-1">{u.username || 'Anonymous'}</span>
                      <Button
                        variant={isFollowing ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          toggleFollow()
                        }}
                      >
                        {isFollowing ? t('editor.toolbar.following') : t('editor.toolbar.follow')}
                      </Button>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <ThemeToggle className="h-8 w-8" />

            {/* Blink Selection */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleBlink}
                  disabled={!canBlink}
                >
                  <Sparkles className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('editor.toolbar.blink')}</TooltipContent>
            </Tooltip>

            {/* Run Code (Visible on all sizes if editable) */}
            {canEdit && (
              <Button
                variant="default"
                size="sm"
                className="h-8 px-2 sm:px-3"
                onClick={handleRunCode}
                disabled={isCodeRunning}
              >
                {isCodeRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin sm:mr-1" />
                ) : (
                  <Play className="h-4 w-4 sm:mr-1" />
                )}
                <span className="hidden sm:inline">{t('codeRunner.run')}</span>
              </Button>
            )}

            {/* Desktop: Share & End Room Buttons */}
            {(canManageRoom || canEndRoom) && (
              <div className="hidden md:flex items-center gap-2">
                {canManageRoom && (
                  <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3" onClick={() => setShowShareManager(true)}>
                    <Share2 className="h-4 w-4 sm:mr-1" />
                    <span className="hidden xl:inline">{t('editor.toolbar.share')}</span>
                  </Button>
                )}
                {canEndRoom && (
                  <Button variant="destructive" size="sm" className="h-8 px-2 sm:px-3" onClick={() => setIsEndRoomDialogOpen(true)}>
                    <StopCircle className="h-4 w-4 sm:mr-1" />
                    <span className="hidden xl:inline">{t('editor.toolbar.endRoom')}</span>
                  </Button>
                )}
              </div>
            )}

            {/* Desktop: Leave Room (Guest) */}
            {isGuestMode && (
              <Button variant="outline" size="sm" className="hidden md:flex h-8 px-2 sm:px-3" onClick={handleGuestLeave}>
                <LogOut className="h-4 w-4 sm:mr-1" />
                <span className="hidden xl:inline">{t('share.editor.leaveButton')}</span>
              </Button>
            )}

            {/* Mobile: More Menu (Dropdown) */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Font Controls Group */}
                  <DropdownMenuLabel>Font Size</DropdownMenuLabel>
                  <div className="flex items-center justify-between px-2 py-1">
                     <Button variant="outline" size="icon" className="h-6 w-6" onClick={decreaseFontSize}>
                        <Minus className="h-3 w-3" />
                     </Button>
                     <span className="text-xs">{fontSize}</span>
                     <Button variant="outline" size="icon" className="h-6 w-6" onClick={increaseFontSize}>
                        <Plus className="h-3 w-3" />
                     </Button>
                  </div>
                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={() => updateEditorParams({ view: 'code' })}>
                    <FileCode className="h-4 w-4 mr-2" />
                    {t('editor.toolbar.code')}
                    {activeDoc === 'code' && <Check className="h-3 w-3 ml-auto" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => updateEditorParams({ view: 'canvas' })}>
                    <Brush className="h-4 w-4 mr-2" />
                    {t('editor.toolbar.canvas')}
                    {activeDoc === 'canvas' && <Check className="h-3 w-3 ml-auto" />}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={handleBlink} disabled={!canBlink}>
                    <Sparkles className="h-4 w-4 mr-2" />
                    {t('editor.toolbar.blink')}
                  </DropdownMenuItem>

                  {(canManageRoom || canEndRoom) && (
                    <>
                      {canManageRoom && (
                        <DropdownMenuItem onClick={() => setShowShareManager(true)}>
                          <Share2 className="h-4 w-4 mr-2" />
                          {t('editor.toolbar.share')}
                        </DropdownMenuItem>
                      )}
                      {canEndRoom && (
                        <DropdownMenuItem 
                          onClick={() => setIsEndRoomDialogOpen(true)}
                          className="text-destructive focus:text-destructive"
                        >
                          <StopCircle className="h-4 w-4 mr-2" />
                          {t('editor.toolbar.endRoom')}
                        </DropdownMenuItem>
                      )}
                    </>
                  )}

                  {isGuestMode && (
                    <DropdownMenuItem onClick={handleGuestLeave}>
                      <LogOut className="h-4 w-4 mr-2" />
                      {t('share.editor.leaveButton')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* End Room Confirmation Dialog */}
        <Dialog open={isEndRoomDialogOpen} onOpenChange={setIsEndRoomDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('editor.toolbar.endRoom')}</DialogTitle>
              <DialogDescription>
                Are you sure you want to end this session? All participants will be disconnected.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsEndRoomDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => {
                  handleEndRoom()
                  setIsEndRoomDialogOpen(false)
                }}
                disabled={isEnding}
              >
                {isEnding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'End Session'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* Share Manager Dialog */}
        <Dialog open={showShareManager} onOpenChange={setShowShareManager}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('editor.toolbar.share')}</DialogTitle>
            </DialogHeader>
            <div className="py-2">
              <ShareLinkManager roomId={roomId!} />
            </div>
          </DialogContent>
        </Dialog>


        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden min-w-0">
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <div className="flex-1 overflow-hidden">
              <div className={cn('h-full w-full', activeDoc === 'code' ? '' : 'hidden')}>
                <div ref={editorRef} className="h-full w-full" />
              </div>
              {activeDoc === 'canvas' && (
                <CanvasView
                  store={tldrawStore}
                  ready={tldrawReady}
                  canEdit={canEdit}
                  theme={theme}
                  provider={provider}
                  followUserId={followingUserId}
                  followClientId={followingClientId}
                  followEnabled={activeDoc === 'canvas'}
                />
              )}
            </div>

            {activeDoc === 'code' && codeRunnerPosition === 'bottom' && (
              <CodeRunnerPanel
                ref={codeRunnerRef}
                language={effectiveRoom.language}
                getCode={getCode}
                canEdit={canEdit}
                ymeta={ymeta}
                position="bottom"
                onPositionChange={(position) => updateEditorParams({ runner: position })}
                roomId={roomId}
                isOwner={isOwner}
                expanded={isRunnerExpanded}
                onExpandedChange={setIsRunnerExpanded}
              />
            )}
          </div>

          {activeDoc === 'code' && codeRunnerPosition === 'right' && (
             <CodeRunnerPanel
              ref={codeRunnerRef}
              language={effectiveRoom.language}
              getCode={getCode}
              canEdit={canEdit}
              ymeta={ymeta}
              position="right"
              onPositionChange={(position) => updateEditorParams({ runner: position })}
              roomId={roomId}
              isOwner={isOwner}
              expanded={isRunnerExpanded}
              onExpandedChange={setIsRunnerExpanded}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between h-8 px-4 border-t bg-muted/50 text-xs text-muted-foreground shrink-0 overflow-hidden">
          <div className="flex items-center gap-4 min-w-0 overflow-hidden">
            <div className={cn('flex items-center gap-1', isConnected ? 'text-success' : 'text-destructive')}>
              {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span className="hidden sm:inline">{isConnected ? t('editor.status.connected') : t('editor.status.disconnected')}</span>
            </div>
            <div className="flex items-center gap-1">
              {isSynced ? <Check className="h-3 w-3" /> : <RefreshCw className="h-3 w-3 animate-spin" />}
              <span className="hidden sm:inline">{isSynced ? t('editor.status.synced') : t('editor.status.syncing')}</span>
            </div>
            {isGuestMode && guestSession && (
              <span className="text-muted-foreground truncate max-w-[150px]">
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
