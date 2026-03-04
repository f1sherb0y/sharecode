import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Loader2, Clock, HardDrive, AlertCircle, CheckCircle2, Terminal, PanelBottom, PanelRight, StickyNote } from 'lucide-react'
import { Button, Textarea } from '@/components/ui'
import { NotesView } from '@/components/features/notes-view'
import { useAuthStore } from '@/stores'
import { api } from '@/api'
import { cn } from '@/lib/utils'
import type * as Y from 'yjs'
import type { Language } from '@/types'

// Language name mapping for Piston API
const LANGUAGE_ID_MAP: Record<string, string> = {
  'c': 'c',
  'cpp': 'cpp',
  'csharp': 'csharp',
  'go': 'go',
  'java': 'java',
  'javascript': 'javascript',
  'typescript': 'typescript',
  'python': 'python',
  'rust': 'rust',
  'ruby': 'ruby',
  'php': 'php',
  'swift': 'swift',
  'kotlin': 'kotlin',
  'scala': 'scala',
  'r': 'r',
  'perl': 'perl',
  'lua': 'lua',
  'haskell': 'haskell',
  'bash': 'bash',
  'sql': 'sql',
}

const MIN_PANEL_SIZE = 120
const MAX_PANEL_SIZE = 500
const DEFAULT_PANEL_SIZE = 200

type PanelPosition = 'bottom' | 'right'
type PanelTab = 'runner' | 'notes'

interface CodeRunnerPanelProps {
  language: Language
  getCode: () => string
  canEdit: boolean
  ymeta?: Y.Map<unknown>
  className?: string
  position?: PanelPosition
  onPositionChange?: (position: PanelPosition) => void
  roomId?: string
  isOwner?: boolean
}

export interface CodeRunnerPanelRef {
  run: () => Promise<void>
  expand: () => void
  isRunning: () => boolean
}

type ExecutionStatus = 'idle' | 'running' | 'success' | 'error'

interface ExecutionState {
  status: ExecutionStatus
  stdin: string
  stdout: string
  stderr: string
  time?: string
  memory?: number
}

export const CodeRunnerPanel = forwardRef<CodeRunnerPanelRef, CodeRunnerPanelProps>(function CodeRunnerPanel({
  language,
  getCode,
  canEdit,
  ymeta,
  className,
  position = 'bottom',
  onPositionChange,
  roomId,
  isOwner = false,
}, ref) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [panelSize, setPanelSize] = useState(DEFAULT_PANEL_SIZE)
  const [activeTab, setActiveTab] = useState<PanelTab>('runner')
  const [stdin, setStdin] = useState('')
  const [stdout, setStdout] = useState('')
  const [stderr, setStderr] = useState('')
  const [status, setStatus] = useState<ExecutionStatus>('idle')
  const [execTime, setExecTime] = useState<string | undefined>()
  const [execMemory, setExecMemory] = useState<number | undefined>()
  const lastSyncRef = useRef<string>('')
  const panelRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const startPosRef = useRef(0)
  const startSizeRef = useRef(0)

  const isBottom = position === 'bottom'
  const isRight = position === 'right'

  // Drag resize handlers
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    if ('touches' in e) {
      startPosRef.current = isBottom ? e.touches[0]!.clientY : e.touches[0]!.clientX
    } else {
      startPosRef.current = isBottom ? e.clientY : e.clientX
    }
    startSizeRef.current = panelSize
    document.body.style.cursor = isBottom ? 'ns-resize' : 'ew-resize'
    document.body.style.userSelect = 'none'
  }, [panelSize, isBottom])

  useEffect(() => {
    const handleDragMove = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return
      let currentPos: number
      if ('touches' in e) {
        currentPos = isBottom ? e.touches[0]!.clientY : e.touches[0]!.clientX
      } else {
        currentPos = isBottom ? e.clientY : e.clientX
      }
      // For bottom panel, dragging up increases size; for right panel, dragging left increases size
      const delta = startPosRef.current - currentPos
      const newSize = Math.min(MAX_PANEL_SIZE, Math.max(MIN_PANEL_SIZE, startSizeRef.current + delta))
      setPanelSize(newSize)
    }

    const handleDragEnd = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
    document.addEventListener('touchmove', handleDragMove)
    document.addEventListener('touchend', handleDragEnd)

    return () => {
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
      document.removeEventListener('touchmove', handleDragMove)
      document.removeEventListener('touchend', handleDragEnd)
    }
  }, [isBottom])

  // Sync state from ymeta (shared Yjs state)
  useEffect(() => {
    if (!ymeta) return

    const handleMetaChange = () => {
      const codeRunner = ymeta.get('codeRunner') as ExecutionState | undefined
      if (!codeRunner) return

      // Avoid syncing our own updates
      const stateKey = JSON.stringify(codeRunner)
      if (stateKey === lastSyncRef.current) return
      lastSyncRef.current = stateKey

      setStdin(codeRunner.stdin || '')
      setStdout(codeRunner.stdout || '')
      setStderr(codeRunner.stderr || '')
      setStatus(codeRunner.status || 'idle')
      setExecTime(codeRunner.time)
      setExecMemory(codeRunner.memory)
    }

    ymeta.observe(handleMetaChange)
    // Initial load
    handleMetaChange()

    return () => {
      ymeta.unobserve(handleMetaChange)
    }
  }, [ymeta])

  // Sync state to ymeta
  const syncState = useCallback((state: Partial<ExecutionState>) => {
    if (!ymeta) return

    const current = (ymeta.get('codeRunner') as ExecutionState) || {
      status: 'idle',
      stdin: '',
      stdout: '',
      stderr: '',
    }

    const newState = { ...current, ...state }
    lastSyncRef.current = JSON.stringify(newState)
    ymeta.set('codeRunner', newState)
  }, [ymeta])

  // Handle stdin change
  const handleStdinChange = useCallback((value: string) => {
    setStdin(value)
    syncState({ stdin: value })
  }, [syncState])

  // Run code
  const handleRun = useCallback(async () => {
    if (!canEdit) return

    const languageId = LANGUAGE_ID_MAP[language]
    if (!languageId) {
      setStderr(t('codeRunner.unsupportedLanguage', { language }))
      setStatus('error')
      syncState({
        status: 'error',
        stderr: t('codeRunner.unsupportedLanguage', { language }),
        stdout: '',
      })
      return
    }

    const code = getCode()
    if (!code.trim()) {
      setStderr(t('codeRunner.emptyCode'))
      setStatus('error')
      syncState({
        status: 'error',
        stderr: t('codeRunner.emptyCode'),
        stdout: '',
      })
      return
    }

    setStatus('running')
    setStdout('')
    setStderr('')
    setExecTime(undefined)
    setExecMemory(undefined)
    syncState({
      status: 'running',
      stdout: '',
      stderr: '',
      time: undefined,
      memory: undefined,
    })
    setIsExpanded(true)

    try {
      const result = await api.executeCode(code, languageId, stdin)

      setStdout(result.output || '')
      setStderr(result.error || '')
      setExecTime(result.time)
      setExecMemory(result.memory)
      setStatus(result.isSuccess ? 'success' : 'error')

      syncState({
        status: result.isSuccess ? 'success' : 'error',
        stdout: result.output || '',
        stderr: result.error || '',
        time: result.time,
        memory: result.memory,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('codeRunner.executionFailed')
      setStderr(errorMsg)
      setStatus('error')
      syncState({
        status: 'error',
        stderr: errorMsg,
        stdout: '',
      })
    }
  }, [canEdit, language, getCode, stdin, syncState, t])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    run: handleRun,
    expand: () => setIsExpanded(true),
    isRunning: () => status === 'running',
  }), [handleRun, status])

  // Status icon - smaller for collapsed state
  const StatusIcon = ({ size = 'normal' }: { size?: 'small' | 'normal' }) => {
    const iconClass = size === 'small' ? 'h-3 w-3' : 'h-4 w-4'
    switch (status) {
      case 'running':
        return <Loader2 className={cn(iconClass, 'animate-spin text-primary')} />
      case 'success':
        return <CheckCircle2 className={cn(iconClass, 'text-success')} />
      case 'error':
        return <AlertCircle className={cn(iconClass, 'text-destructive')} />
      default:
        return <Terminal className={cn(iconClass, 'text-muted-foreground')} />
    }
  }

  // Collapse/expand icons based on position
  const CollapseIcon = isExpanded
    ? (isBottom ? ChevronDown : ChevronRight)
    : (isBottom ? ChevronUp : ChevronLeft)

  // Position toggle handler
  const handlePositionToggle = (newPosition: PanelPosition) => {
    onPositionChange?.(newPosition)
  }

  const { user } = useAuthStore()
  const isPrivileged = user?.role === 'admin' || user?.role === 'superuser'

  const showTabs = (isOwner || isPrivileged) && !!roomId

  // Header label for current tab
  const headerLabel = activeTab === 'notes' ? t('codeRunner.tabNotes') : t('codeRunner.title')

  // Tab bar component (rendered inside expanded content)
  const TabBar = showTabs ? (
    <div className="flex items-center gap-0.5 shrink-0 border-b pb-1 mb-1">
      <button
        type="button"
        className={cn(
          'px-2 py-0.5 rounded-sm text-xs font-medium transition-colors',
          activeTab === 'runner'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
        onClick={() => setActiveTab('runner')}
      >
        {t('codeRunner.tabIO')}
      </button>
      <button
        type="button"
        className={cn(
          'px-2 py-0.5 rounded-sm text-xs font-medium transition-colors',
          activeTab === 'notes'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
        onClick={() => setActiveTab('notes')}
      >
        {t('codeRunner.tabNotes')}
      </button>
    </div>
  ) : null

  return (
    <div
      ref={panelRef}
      className={cn(
        'bg-background flex',
        isBottom ? 'flex-col border-t' : 'flex-row border-l',
        className
      )}
    >
      {/* Resize handle - thin line */}
      {isExpanded && (
        <div
          className={cn(
            'transition-colors group',
            isBottom
              ? 'h-1 cursor-ns-resize hover:bg-primary/30'
              : 'w-1 cursor-ew-resize hover:bg-primary/30'
          )}
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
        />
      )}

      {/* Header - consistent size */}
      <div
        className={cn(
          'flex items-center justify-between cursor-pointer hover:bg-muted/50 transition-colors shrink-0',
          isBottom ? 'px-2 h-7' : 'py-2 w-7 flex-col-reverse'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className={cn(
          'flex items-center gap-1.5',
          isRight && 'flex-col'
        )}>
          {activeTab === 'notes' ? (
            <StickyNote className="h-3 w-3 text-muted-foreground" />
          ) : (
            <StatusIcon size="small" />
          )}
          <span
            className="font-medium whitespace-nowrap text-xs"
            style={isRight ? { writingMode: 'vertical-rl' } : undefined}
          >
            {headerLabel}
          </span>
          {activeTab === 'runner' && status === 'running' && isBottom && (
            <span className="text-xs text-muted-foreground">{t('codeRunner.running')}</span>
          )}
          {activeTab === 'runner' && !isExpanded && status === 'success' && execTime && isBottom && (
            <span className="text-xs text-muted-foreground flex items-center gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              {execTime}s
            </span>
          )}
        </div>
        <div className={cn(
          'flex items-center gap-1',
          isRight && 'flex-col'
        )}>
          {/* Position toggle buttons */}
          {onPositionChange && (
            <div className={cn(
              'flex gap-0.5',
              isRight && 'flex-col'
            )}>
              <Button
                size="sm"
                variant={isBottom ? 'secondary' : 'ghost'}
                className="h-5 w-5 p-0"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  handlePositionToggle('bottom')
                }}
                title={t('codeRunner.attachBottom')}
              >
                <PanelBottom className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant={isRight ? 'secondary' : 'ghost'}
                className="h-5 w-5 p-0"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  handlePositionToggle('right')
                }}
                title={t('codeRunner.attachRight')}
              >
                <PanelRight className="h-3 w-3" />
              </Button>
            </div>
          )}
          <CollapseIcon className="h-3 w-3 text-muted-foreground" />
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div
          className={cn(
            'flex flex-col overflow-hidden',
            isBottom ? 'px-2 pb-2' : 'py-2 pr-2'
          )}
          style={isBottom ? { height: panelSize } : { width: panelSize }}
        >
          {TabBar}

          {activeTab === 'runner' ? (
            <div className={cn(
              'flex gap-2 flex-1 min-h-0 overflow-hidden',
              isBottom ? 'flex-row' : 'flex-col'
            )}>
              {/* Input */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <label className="text-xs text-muted-foreground mb-1 font-medium shrink-0">
                  {t('codeRunner.input')}
                </label>
                <Textarea
                  value={stdin}
                  onChange={(e) => handleStdinChange(e.target.value)}
                  placeholder={t('codeRunner.inputPlaceholder')}
                  className="flex-1 font-mono text-sm resize-none min-h-0"
                  readOnly={!canEdit}
                />
              </div>

              {/* Output */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <div className="flex items-center justify-between mb-1 shrink-0">
                  <label className="text-xs text-muted-foreground font-medium">
                    {t('codeRunner.output')}
                  </label>
                  {status === 'success' && (execTime || execMemory) && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {execTime && (
                        <span className="flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {execTime}s
                        </span>
                      )}
                      {execMemory && (
                        <span className="flex items-center gap-0.5">
                          <HardDrive className="h-2.5 w-2.5" />
                          {(execMemory / 1024).toFixed(1)}MB
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex-1 font-mono text-sm bg-muted/50 rounded-md p-2 overflow-auto min-h-0 whitespace-pre-wrap">
                  {status === 'running' ? (
                    <span className="text-muted-foreground">{t('codeRunner.executing')}</span>
                  ) : stdout ? (
                    <span className="text-foreground">{stdout}</span>
                  ) : stderr ? (
                    <span className="text-destructive">{stderr}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('codeRunner.noOutput')}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            roomId && <NotesView roomId={roomId} />
          )}
        </div>
      )}
    </div>
  )
}
)