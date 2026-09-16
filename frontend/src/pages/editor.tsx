import { LANGUAGES } from '@/types'
import { translateError } from '@/i18n/errors'
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useViewportHeight } from '@/hooks/use-viewport-height'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Users,
  Wifi,
  WifiOff,
  RefreshCw,
  Check,
  StopCircle,
  Share2,
  LogOut,
  Play,
  Loader2,
  MoreVertical,
  Sparkles,
  Maximize,
  Minimize2,
  Sun,
  Moon,
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
  DropdownMenuLabel,
  Spinner,
  TooltipProvider,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { useAuthStore, useThemeStore } from '@/stores'
import {
  useEditorRoom,
  useMonacoEditor,
  useEditorAwareness,
  useYjsProvider,
  useCompactViewport,
  useFullscreen,
  type StatelessMessage
} from '@/hooks'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import { CodeRunnerPanel, type CodeRunnerPanelRef } from '@/components/features/code-runner-panel'
import { RoomViewSwitch } from '@/components/features/room-view-switch'
import { FontControls } from '@/components/features/font-controls'
import { generateUserColor, cn, formatDateTime } from '@/lib/utils'
import type { Language } from '@/types'
import type { MarkdownEditorHandle } from '@/components/features/markdown-editor'

const CanvasView = lazy(() => import('@/components/features/canvas-view').then(m => ({ default: m.CanvasView })))

const MarkdownEditor = lazy(() =>
  import('@/components/features/markdown-editor').then((m) => ({ default: m.MarkdownEditor }))
)


const RUNNER_POSITIONS = ['bottom', 'right'] as const

function parseRunnerPosition(value: string | null): 'bottom' | 'right' {
  return RUNNER_POSITIONS.includes((value ?? '') as (typeof RUNNER_POSITIONS)[number])
    ? (value as 'bottom' | 'right')
    : 'right'
}

export function EditorPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()
  const viewportHeight = useViewportHeight()
  const { token: authToken } = useAuthStore()
  const { theme, toggleTheme } = useThemeStore()
  const isCompactViewport = useCompactViewport()
  const isNarrowViewport = useCompactViewport('(max-width: 767px)')
  const { isFullscreen, isSupported: isFullscreenSupported, toggleFullscreen } = useFullscreen()
  const [showShareManager, setShowShareManager] = useState(false)
  const [isCodeRunning, setIsCodeRunning] = useState(false)
  const [isRunnerExpanded, setIsRunnerExpanded] = useState(false)
  const [sessionAwarenessColor, setSessionAwarenessColor] = useState<{
    slot: number
    color: string
    colorLight: string
  } | null>(null)
  const view = searchParams.get('view') === 'canvas' ? 'canvas' : 'editor'
  const isCanvas = view === 'canvas'
  const [canvasPending, setCanvasPending] = useState(false)
  const codeRunnerPosition = parseRunnerPosition(searchParams.get('runner'))
  const visibleRunnerPosition = isNarrowViewport ? 'bottom' : codeRunnerPosition
  const shellRef = useRef<HTMLDivElement>(null)

  // State for End Room Dialog
  const [isEndRoomDialogOpen, setIsEndRoomDialogOpen] = useState(false)
  const [endSaveError, setEndSaveError] = useState('')
  const [isSavingBeforeEnd, setIsSavingBeforeEnd] = useState(false)

  const updateEditorParams = useCallback((updates: { runner?: 'bottom' | 'right' }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('runner', updates.runner ?? codeRunnerPosition)
      return next
    })
  }, [setSearchParams, codeRunnerPosition])

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (normalized.get('runner') !== codeRunnerPosition) {
      normalized.set('runner', codeRunnerPosition)
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, codeRunnerPosition, setSearchParams])

  // 1. Room & Auth Hook
  const {
    roomId,
    effectiveRoom,
    currentUser,
    isLoading,
    error: roomError,
    isGuestMode,
    canEdit,
    canChangeLanguage,
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

  const isMarkdown = effectiveRoom?.language === 'markdown'
  const markdownSourceRef = useRef<MarkdownEditorHandle | null>(null)

  const [localError, setLocalError] = useState('')
  const displayError = roomError || localError

  const handleStatelessMessage = useCallback((message: StatelessMessage) => {
    if (message.type === 'room-language' && LANGUAGES.includes(message.language as Language)) {
      setRoom(prev => prev ? { ...prev, language: message.language as Language } : prev)
      return
    }
    if (message.type === 'room-status' && message.status === 'ended') {
      setRoomEnded(true)
      setRoomEndedAt(message.endedAt ?? null)
      return
    }

    if (
      message.type === 'session-color' &&
      typeof message.slot === 'number' &&
      typeof message.color === 'string' &&
      typeof message.colorLight === 'string'
    ) {
      setSessionAwarenessColor({
        slot: message.slot,
        color: message.color,
        colorLight: message.colorLight,
      })
    }
  }, [setRoom, setRoomEnded, setRoomEndedAt])

  const wsToken = authToken ?? ''
  const wsDocumentId = roomId ?? ''
  const shouldConnectWs = !!wsToken && !!wsDocumentId && effectiveRoom?.id === wsDocumentId && !isLoading && !roomError && !roomEnded && !(effectiveRoom?.isEnded)

  useEffect(() => {
    setSessionAwarenessColor(null)
  }, [wsDocumentId, wsToken])

  const { provider, ydoc, ytext, ymeta, isConnected, isSynced, canWrite, isSaved: documentSaved, waitForSaved, syncError, storageFailed, onlineUsers } = useYjsProvider(
    shouldConnectWs ? wsDocumentId : '',
    shouldConnectWs ? wsToken : '',
    handleStatelessMessage
  )

  const isSaved = documentSaved && !canvasPending

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
    canEdit: canEdit && canWrite,
    currentUser,
    sessionAwarenessColor,
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
    followingUserId,
    setFollowingUserId,
    followingClientId,
    setFollowingClientId
  } = useEditorAwareness({
    provider,
    ydoc,
    ytext,
    isConnected,
    monacoRef,
    editorInstanceRef,
    modelRef,
  })

  const handleCanvasFollowChange = useCallback((clientId: number | null) => {
    const user = clientId == null ? null : provider?.awareness?.getStates().get(clientId)?.user
    setFollowingClientId(clientId)
    setFollowingUserId(user?.id ?? null)
  }, [provider, setFollowingClientId, setFollowingUserId])

  const changeView = useCallback((nextView: 'editor' | 'canvas') => {
    if (!window.dispatchEvent(new Event('sharecode:flush', { cancelable: true }))) return
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('view', nextView); return next }, { replace: true })
  }, [setSearchParams])

  useEffect(() => { provider?.awareness?.setLocalStateField('view', view) }, [provider, view])
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness || followingClientId == null) return
    const followView = () => {
      const next = awareness.getStates().get(followingClientId)?.view
      if ((next === 'canvas' || next === 'editor') && next !== view) changeView(next)
    }
    followView()
    awareness.on('change', followView)
    return () => awareness.off('change', followView)
  }, [provider, followingClientId, view, changeView])

  const remoteUsers = onlineUsers.filter(user => user.clientId !== provider?.awareness?.clientID)
  const localClientId = provider?.awareness?.clientID ?? -1
  const localFallbackColor = generateUserColor(`${currentUser?.id ?? 'anonymous'}:${localClientId}`)
  const connectedUsers = [
    {
      clientId: localClientId,
      id: currentUser?.id,
      username: currentUser?.username ?? 'Anonymous',
      color: sessionAwarenessColor?.color ?? localFallbackColor.color,
      colorLight: sessionAwarenessColor?.colorLight ?? localFallbackColor.colorLight,
      colorSlot: sessionAwarenessColor?.slot,
      isLocal: true,
    },
    ...remoteUsers.map((user) => ({
      ...user,
      isLocal: false,
    })),
  ].sort((left, right) => {
    const leftSlot = left.colorSlot ?? Number.MAX_SAFE_INTEGER
    const rightSlot = right.colorSlot ?? Number.MAX_SAFE_INTEGER
    if (leftSlot !== rightSlot) return leftSlot - rightSlot
    return left.clientId - right.clientId
  })

  // Code Runner Ref
  const codeRunnerRef = useRef<CodeRunnerPanelRef>(null)

  // Listen for language changes from ymeta
  useEffect(() => {
    if (!ymeta) return

    const handleMetaChange = (event: { keysChanged: Set<string> }) => {
      if (!event.keysChanged.has('language')) return
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

    // Persisted room language is authoritative on load/reconnect; legacy Yjs
    // metadata may predate a language change made by a read-only admin.
    ymeta.observe(handleMetaChange)
    return () => {
      ymeta.unobserve(handleMetaChange)
    }
  }, [ymeta, effectiveRoom, isGuestMode, setRoom, updateLanguage])

  // Wrapper for language change to update both API and Yjs
  const onLanguageChange = async (lang: Language) => {
    if (!canChangeLanguage) return
    try {
      if (canWrite && isMarkdown && lang !== 'markdown' && ytext && ymeta?.get('markdownInitialized')) {
        const markdown = markdownSourceRef.current?.getMarkdown()
        if (markdown != null) {
          ytext.doc?.transact(() => {
            ytext.delete(0, ytext.length)
            ytext.insert(0, markdown)
          })
        }
      }
      await updateRoomLanguage(lang, canWrite ? ymeta : null)
      updateLanguage(lang)
      setLocalError('')
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update room')
    }
  }

  // Back Navigation
  const handleBack = () => {
    if (!window.dispatchEvent(new Event('sharecode:flush', { cancelable: true }))) return
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
    if (!provider?.awareness || !editorInstanceRef.current || !modelRef.current || !ytext) return

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
    !!provider?.awareness && isEditorReady

  // Loading View
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  // Error View
  if (displayError || syncError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-2">
        <p className="text-destructive">{translateError(displayError || t(`editor.errors.${syncError}`, { defaultValue: syncError }))}</p>
        <Button onClick={handleBack}>{t('common.back')}</Button>
      </div>
    )
  }

  // Room Ended View
  if (effectiveRoom?.isEnded || roomEnded) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-2 p-2 text-center">
        <h2 className="text-2xl font-semibold">{t('editor.ended.title')}</h2>
        <p className="text-muted-foreground">{t('editor.ended.subtitle')}</p>
        <p className="text-sm text-muted-foreground max-w-md">{t('editor.ended.description')}</p>
        {roomEndedAt && (
          <p className="text-xs text-muted-foreground">
            {t('editor.ended.endedAt', { time: formatDateTime(roomEndedAt) })}
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
        className="editor-shell isolate flex flex-col h-screen overflow-clip"
        style={{ height: viewportHeight }}
      >
        {/* Toolbar */}
        <header
          className={cn(
            'relative z-30 flex items-center justify-between border-b bg-background shrink-0 overflow-hidden safe-x',
            'h-9 px-1.5 gap-1'
          )}
        >
          {/* Document navigation */}
          <div className="flex items-center gap-1 min-w-0 shrink">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={handleBack}
              aria-label={t('common.back')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span
              title={effectiveRoom.name}
              className={cn(
                'font-medium truncate text-sm',
                isCompactViewport ? 'max-w-[180px]' : 'max-w-[35vw] sm:max-w-[480px]'
              )}
            >
              {effectiveRoom.name}
            </span>
          </div>

          <RoomViewSwitch value={view} onChange={next => { setFollowingUserId(null); setFollowingClientId(null); changeView(next) }} />

          {/* Right: Actions */}
          <div className="flex items-center gap-1 sm:gap-1 shrink-0">
            {/* Run Code (Visible on all sizes if editable) */}
            {canEdit && !isMarkdown && !isCanvas && (
              <Button
                variant={isCompactViewport ? 'ghost' : 'default'}
                size={isCompactViewport ? 'icon' : 'default'}
                aria-label={t('codeRunner.run')}
                onClick={handleRunCode}
                disabled={isCodeRunning || !canWrite}
              >
                {isCodeRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin sm:mr-1" />
                ) : (
                  <Play className="h-4 w-4 sm:mr-1" />
                )}
                {!isCompactViewport && <span className="hidden sm:inline">{t('codeRunner.run')}</span>}
              </Button>
            )}

            {/* Primary room action; session management lives in the menu. */}
            {!isCompactViewport && canManageRoom && (
              <div className="hidden md:flex items-center gap-1">
                <Button variant="outline" size="sm" className="sm:px-2" aria-label={t('editor.toolbar.share')} onClick={() => setShowShareManager(true)}>
                  <Share2 className="h-4 w-4" />
                  <span className="hidden xl:inline">{t('editor.toolbar.share')}</span>
                </Button>
              </div>
            )}

            {/* Secondary actions */}
            <div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('editor.toolbar.more')} >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={toggleTheme}>
                    {theme === 'light' ? <Moon className="mr-1.5 h-4 w-4" /> : <Sun className="mr-1.5 h-4 w-4" />}
                    {t('common.toggleTheme')}
                  </DropdownMenuItem>
                  {isFullscreenSupported && (
                    <DropdownMenuItem onClick={() => { void toggleFullscreen(shellRef.current) }}>
                      {isFullscreen ? <Minimize2 className="mr-1.5 h-4 w-4" /> : <Maximize className="mr-1.5 h-4 w-4" />}
                      {isFullscreen ? t('common.exitFullscreen') : t('common.enterFullscreen')}
                    </DropdownMenuItem>
                  )}
                  {!isMarkdown && !isCanvas && (
                    <DropdownMenuItem onClick={handleBlink} disabled={!canBlink}>
                      <Sparkles className="h-4 w-4 mr-1.5" />
                      {t('editor.toolbar.blink')}
                    </DropdownMenuItem>
                  )}

                  {(canManageRoom || canEndRoom) && (
                    <>
                      {canManageRoom && (
                        <DropdownMenuItem aria-label={t('editor.toolbar.share')} onClick={() => setShowShareManager(true)}>
                          <Share2 className="h-4 w-4 mr-1.5" />
                          {t('editor.toolbar.share')}
                        </DropdownMenuItem>
                      )}
                      {canEndRoom && (
                        <DropdownMenuItem
                          onClick={() => setIsEndRoomDialogOpen(true)}
                          className="text-destructive focus:text-destructive"
                        >
                          <StopCircle className="h-4 w-4 mr-1.5" />
                          {t('editor.toolbar.endRoom')}
                        </DropdownMenuItem>
                      )}
                    </>
                  )}

                  {isGuestMode && (
                    <DropdownMenuItem onClick={() => { if (window.dispatchEvent(new Event('sharecode:flush', { cancelable: true }))) handleGuestLeave() }}>
                      <LogOut className="h-4 w-4 mr-1.5" />
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
                {t('editor.toolbar.endConfirm')}
              </DialogDescription>
            </DialogHeader>
            {endSaveError && <p role="alert" className="text-xs text-destructive">{endSaveError}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsEndRoomDialogOpen(false)}>
                {t('rooms.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  try {
                    setIsSavingBeforeEnd(true)
                    setEndSaveError('')
                    if (!window.dispatchEvent(new Event('sharecode:flush', { cancelable: true }))) throw new Error('Canvas pending')
                    await waitForSaved()
                    await handleEndRoom()
                    setIsEndRoomDialogOpen(false)
                  } catch { setEndSaveError(t('canvas.waitForSave')) } finally { setIsSavingBeforeEnd(false) }
                }}
                disabled={isEnding || isSavingBeforeEnd}
              >
                {isEnding || isSavingBeforeEnd ? <Loader2 className="h-4 w-4 animate-spin" /> : t('editor.toolbar.endRoom')}
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
            <div className="py-1.5">
              <ShareLinkManager roomId={roomId!} />
            </div>
          </DialogContent>
        </Dialog>

        {/* Main Content */}
        <div className="relative z-0 flex flex-1 overflow-hidden min-w-0">
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <div className="relative z-0 flex-1 overflow-hidden">
              <div className={isCanvas ? 'hidden' : 'h-full w-full'}>
              {isMarkdown ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center">
                      <Spinner size="lg" />
                    </div>
                  }
                >
                  <MarkdownEditor
                    key={ydoc?.guid}
                    sourceRef={markdownSourceRef}
                    ytext={ytext}
                    canEdit={canEdit && canWrite}
                    provider={provider}
                    ydoc={ydoc}
                    isSynced={isSynced}
                    followingUserId={followingUserId}
                    followingClientId={followingClientId}
                  />
                </Suspense>
              ) : (
                <div ref={editorRef} translate="no" className="notranslate h-full w-full" />
              )}
              </div>
              {isCanvas && ydoc && isSynced && <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <CanvasView key={ydoc.guid} doc={ydoc} canEdit={canEdit && canWrite} theme={theme} provider={provider} followClientId={followingClientId} onFollowChange={handleCanvasFollowChange} onPending={setCanvasPending} />
              </Suspense>}
            </div>

            {visibleRunnerPosition === 'bottom' && !isMarkdown && !isCanvas && (
              <CodeRunnerPanel
                ref={codeRunnerRef}
                language={effectiveRoom.language}
                getCode={getCode}
                canEdit={canEdit && canWrite}
                ymeta={ymeta ?? undefined}
                position="bottom"
                onPositionChange={isNarrowViewport ? undefined : (position) => updateEditorParams({ runner: position })}
                roomId={roomId}
                isOwner={isOwner}
                expanded={isRunnerExpanded}
                onExpandedChange={setIsRunnerExpanded}
              />
            )}
          </div>

          {visibleRunnerPosition === 'right' && !isMarkdown && !isCanvas && (
            <CodeRunnerPanel
              ref={codeRunnerRef}
              language={effectiveRoom.language}
              getCode={getCode}
              canEdit={canEdit && canWrite}
              ymeta={ymeta ?? undefined}
              position="right"
              onPositionChange={isNarrowViewport ? undefined : (position) => updateEditorParams({ runner: position })}
              roomId={roomId}
              isOwner={isOwner}
              expanded={isRunnerExpanded}
              onExpandedChange={setIsRunnerExpanded}
            />
          )}
        </div>

        <footer className="editor-statusbar relative z-30 shrink-0 border-t bg-background px-1.5 text-[11px] text-muted-foreground safe-bottom">
          <div className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite" aria-atomic="true">
            <span className={cn('flex items-center gap-1', !isConnected && 'text-destructive')}>
              {isConnected ? <Wifi className="h-3 w-3 text-success" /> : <WifiOff className="h-3 w-3" />}
              <span>{isConnected ? t('editor.status.connected') : t('editor.status.disconnected')}</span>
            </span>
            <span className={cn('flex items-center gap-1', storageFailed && 'text-destructive')}>
              {storageFailed ? <WifiOff className="h-3 w-3" /> : isSaved ? <Check className="h-3 w-3" /> : isConnected ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
              <span>{storageFailed ? t('editor.status.saveFailed') : isSaved ? t('editor.status.saved') : isConnected ? t('editor.status.saving') : t('editor.status.pending')}</span>
            </span>
            <span className="hidden lg:inline">{canEdit ? t('share.editor.permissionEdit') : t('share.editor.permissionView')}</span>
          </div>
          <div className="editor-statusbar-controls flex min-w-0 items-center justify-end gap-0 min-[401px]:gap-1">
            {canChangeLanguage ? (
              <Select disabled={!isConnected} value={effectiveRoom.language} onValueChange={(v) => onLanguageChange(v as Language)}>
                <SelectTrigger
                  aria-label={t('rooms.create.language')}
                  className="h-control-sm w-[84px] min-[401px]:w-[105px] shrink-0 border-transparent bg-transparent px-1.5 text-xs"
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
                  isCompactViewport ? 'px-1 py-0 leading-5' : 'px-1 py-0'
                )}
              >
                {effectiveRoom.language}
              </Badge>
            )}

            {/* Users Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('editor.toolbar.users')}
                  className="gap-1"
                >
                  <Users className="h-4 w-4" />
                  <span>{connectedUsers.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t('editor.toolbar.users')}
                </DropdownMenuLabel>

                {/* Remote Users */}
                {remoteUsers.length === 0 && (
                  <div className="px-1.5 py-1.5 text-xs text-muted-foreground text-center">
                    {t('editor.toolbar.noOtherUsers')}
                  </div>
                )}

                {connectedUsers.map((u) => {
                  const isFollowing = !u.isLocal && followingClientId === u.clientId
                  const toggleFollow = () => {
                    if (u.isLocal) return
                    setFollowingUserId(isFollowing ? null : u.id ?? null)
                    setFollowingClientId(isFollowing ? null : u.clientId)
                  }
                  return (
                    <DropdownMenuItem
                      key={u.clientId}
                      className="gap-1 cursor-pointer"
                      onClick={toggleFollow}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: u.color }} />
                      <span className="truncate flex-1">
                        {u.username || 'Anonymous'}
                        {u.isLocal ? ` (${t('share.editor.you')})` : ''}
                      </span>
                      {!u.isLocal && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {isFollowing ? t('editor.toolbar.following') : t('editor.toolbar.follow')}
                        </span>
                      )}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="mx-1 hidden h-3 border-l min-[401px]:block" />
            {!isCanvas && <FontControls />}
          </div>
        </footer>
      </div>
    </TooltipProvider>
  )
}
