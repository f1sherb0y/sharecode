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
  Maximize,
  Minimize2,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { useAuthStore, useFontStore, useThemeStore } from '@/stores'
import {
  useEditorRoom,
  useMonacoEditor,
  useEditorAwareness,
  useYjsProvider,
  useTldrawStore,
  useCompactViewport,
  useFullscreen,
  type StatelessMessage
} from '@/hooks'
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
  const { font, fontSize, increaseFontSize, decreaseFontSize, setFont } = useFontStore()
  const { theme } = useThemeStore()
  const isCompactViewport = useCompactViewport()
  const { isFullscreen, isSupported: isFullscreenSupported, toggleFullscreen } = useFullscreen()
  const [showShareManager, setShowShareManager] = useState(false)
  const [isCodeRunning, setIsCodeRunning] = useState(false)
  const [isRunnerExpanded, setIsRunnerExpanded] = useState(false)
  const activeDoc = parseDocView(searchParams.get('view'))
  const codeRunnerPosition = parseRunnerPosition(searchParams.get('runner'))
  const shellRef = useRef<HTMLDivElement>(null)

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

  const wsToken = authToken ?? ''
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

  // 3. Monaco Hook
  const {
    editorRef,
    monacoRef,
    editorInstanceRef,
    modelRef,
    isEditorReady,
    updateLanguage,
  } = useMonacoEditor({
    effectiveRoom,
    ytext,
    provider,
    canEdit,
    currentUser,
    roomEnded,
    setError: setLocalError
  })

  // Sync editor language with room language
  useEffect(() => {
    if (effectiveRoom?.language) {
      updateLanguage(effectiveRoom.language)
    }
  }, [effectiveRoom?.language, updateLanguage])

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
    ytext,
    monacoRef,
    editorInstanceRef,
    modelRef,
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
        setRoom((prev) => {
          if (!prev) return prev;
          return { ...prev, language: newLanguage };
        })
        // Update Editor Language
        updateLanguage(newLanguage)
      }
    }

    // Call updateLanguage immediately if we are already out of sync
    if (effectiveRoom?.language) {
      const metaLang = ymeta.get('language') as Language | undefined
      if (metaLang && metaLang !== effectiveRoom.language) {
        setRoom((prev) => {
          if (!prev && !isGuestMode) return prev
          return {
            ...(prev ?? effectiveRoom),
            language: metaLang,
          }
        })
        updateLanguage(metaLang)
      }
    }

    ymeta.observe(handleMetaChange)
    return () => {
      ymeta.unobserve(handleMetaChange)
    }
  }, [ymeta, effectiveRoom, isGuestMode, setRoom, updateLanguage])

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
    return modelRef.current?.getValue() ?? ''
  }, [modelRef])

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
    if (!provider?.awareness || !editorInstanceRef.current || !modelRef.current) return

    const selection = editorInstanceRef.current.getSelection()
    if (!selection) return

    const anchor = modelRef.current.getOffsetAt(selection.getStartPosition())
    const head = modelRef.current.getOffsetAt(selection.getEndPosition())

    provider.awareness.setLocalStateField('blink', {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, head),
      ts: Date.now(),
    })
  }, [provider, editorInstanceRef, modelRef, ytext])

  const canBlink =
    activeDoc === 'code' &&
    !!provider?.awareness &&
    isEditorReady

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
      <div
        ref={shellRef}
        className={cn(
          'editor-shell flex flex-col h-screen overflow-clip',
          isCompactViewport && 'compact-ui'
        )}
        style={{ height: '100dvh' }}
      >
        {/* Toolbar */}
        <header
          className={cn(
            'flex items-center justify-between border-b bg-background shrink-0 overflow-hidden safe-x',
            isCompactViewport ? 'h-10 px-1.5 gap-1' : 'h-12 px-2 sm:px-3 gap-2'
          )}
        >
          {/* Left: Back + Title + Language */}
          <div className="flex items-center gap-1.5 min-w-0 shrink">
            <Button
              variant="ghost"
              size="icon"
              className={cn('shrink-0', isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')}
              onClick={handleBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span
              className={cn(
                'font-medium truncate text-sm',
                isCompactViewport ? 'max-w-[90px]' : 'max-w-[110px] sm:max-w-[220px]'
              )}
            >
              {effectiveRoom.name}
            </span>

            {isOwner ? (
              <Select value={effectiveRoom.language} onValueChange={(v) => onLanguageChange(v as Language)}>
                <SelectTrigger
                  className={cn(
                    'shrink-0',
                    isCompactViewport ? 'h-7 w-[92px] text-xs' : 'h-8 w-24 sm:w-32'
                  )}
                >
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
              <Badge
                variant="secondary"
                className={cn(
                  'shrink-0 rounded-sm text-xs',
                  isCompactViewport ? 'px-1 py-0 leading-5' : 'px-1.5 py-0'
                )}
              >
                {effectiveRoom.language}
              </Badge>
            )}

            {!isCompactViewport && (
              <div className="hidden sm:flex items-center rounded-md border p-0.5 ml-1">
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
            )}

            {isGuestMode && !isCompactViewport && (
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
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('gap-1', isCompactViewport ? 'h-7 px-2 text-xs' : 'h-8')}
                >
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

            <ThemeToggle className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')} />

            {/* Blink Selection */}
            {!isCompactViewport && (
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
            )}

            {/* Run Code (Visible on all sizes if editable) */}
            {canEdit && (
              <Button
                variant={isCompactViewport ? 'ghost' : 'default'}
                size={isCompactViewport ? 'icon' : 'sm'}
                className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 px-2 sm:px-3')}
                onClick={handleRunCode}
                disabled={isCodeRunning}
              >
                {isCodeRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin sm:mr-1" />
                ) : (
                  <Play className="h-4 w-4 sm:mr-1" />
                )}
                {!isCompactViewport && <span className="hidden sm:inline">{t('codeRunner.run')}</span>}
              </Button>
            )}

            {/* Desktop: Share & End Room Buttons */}
            {!isCompactViewport && (canManageRoom || canEndRoom) && (
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
            {isGuestMode && !isCompactViewport && (
              <Button variant="outline" size="sm" className="hidden md:flex h-8 px-2 sm:px-3" onClick={handleGuestLeave}>
                <LogOut className="h-4 w-4 sm:mr-1" />
                <span className="hidden xl:inline">{t('share.editor.leaveButton')}</span>
              </Button>
            )}

            {/* Mobile: More Menu (Dropdown) */}
            <div className={cn(isCompactViewport ? 'block' : 'md:hidden')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn(isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')}>
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Font Controls Group */}
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
            <div className="relative flex-1 overflow-hidden">
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
              {isFullscreenSupported && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={cn(
                    'absolute right-3 bottom-3 z-20 rounded-full border bg-background/65 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/45',
                    isCompactViewport ? 'h-9 w-9' : 'h-10 w-10'
                  )}
                  onClick={() => {
                    void toggleFullscreen(shellRef.current)
                  }}
                  aria-label={isFullscreen ? t('common.exitFullscreen') : t('common.enterFullscreen')}
                  title={isFullscreen ? t('common.exitFullscreen') : t('common.enterFullscreen')}
                >
                  {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                </Button>
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

        {!isCompactViewport && (
          <footer className="safe-bottom safe-x flex items-center justify-between h-7 px-2 sm:px-3 border-t bg-background text-[11px] text-muted-foreground shrink-0 overflow-hidden">
            <div className="flex items-center gap-3 min-w-0 overflow-hidden">
              <div className={cn('flex items-center gap-1', isConnected ? 'text-success' : 'text-destructive')}>
                {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                <span className="hidden sm:inline">{isConnected ? t('editor.status.connected') : t('editor.status.disconnected')}</span>
              </div>
              <div className="flex items-center gap-1">
                {isSynced ? <Check className="h-3 w-3" /> : <RefreshCw className="h-3 w-3 animate-spin" />}
                <span className="hidden sm:inline">{isSynced ? t('editor.status.synced') : t('editor.status.syncing')}</span>
              </div>
              {isGuestMode && currentUser && (
                <span className="text-muted-foreground truncate max-w-[150px]">
                  {t('share.editor.connectedAs', { name: currentUser.username })}
                </span>
              )}
            </div>
            <div>{effectiveRoom.language}</div>
          </footer>
        )}
      </div>
    </TooltipProvider>
  )
}
