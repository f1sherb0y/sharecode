import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { CheckCircle2, ArrowUpRight, Grip, Keyboard, ScreenShare } from 'lucide-react'
import { ShareCodeLogo } from '@/components/share-code-logo'
import { useThemeStore } from '@/stores/theme'
import { useMacHotkey, watchMacHotkey } from './hotkey'
import { isMacOSClient } from './window'

const SHOWN_KEY = 'sharecode-input-monitoring-guide-shown'
const PROGRESS_KEY = 'sharecode-macos-permission-setup-v1'
interface RecordingPermission { supported: boolean; permission: boolean }

function rememberStep(step: 'input' | 'recording' | 'done') {
  try { localStorage.setItem(PROGRESS_KEY, step) } catch { /* continue without persistence */ }
}
export function useInputMonitoringSetup() {
  const { i18n } = useTranslation()
  const phase = useMacHotkey((state) => state.phase)
  const busy = useMacHotkey((state) => state.busy)
  const ready = useMacHotkey((state) => state.ready)
  const attempted = useRef(false)
  useEffect(() => {
    if (!isMacOSClient || phase === 'starting' || (phase === 'listening' && !ready) || busy || attempted.current) return
    attempted.current = true
    void (async () => {
      try {
        // The main window stays hidden until both native permissions are ready. Reopen the
        // guide whenever the listener is unavailable so dismissing it cannot bypass the gate.
        if (phase !== 'listening') {
          await useMacHotkey.getState().run('open_client_hotkey_setup')
          if (useMacHotkey.getState().commandError) return
          rememberStep('input')
          try { localStorage.setItem(SHOWN_KEY, '1') } catch { /* no persistent storage */ }
          return
        }
        const recording = await invoke<RecordingPermission>('client_screen_share', { action: 'status', language: i18n.language })
        if (recording.supported && !recording.permission) {
          await invoke('open_client_recording_setup', { language: i18n.language })
          rememberStep('recording')
        } else {
          await invoke('show_client_main')
          rememberStep('done')
        }
      } catch (error) { console.error('Permission setup unavailable:', error) }
    })()
  }, [phase, busy, ready, i18n.language])
}

interface Application { name: string; path: string | null; canDrag: boolean }

/** A dedicated native window: no room restoration, opacity, stealth or updater side effects. */
export function InputMonitoringSetup() {
  const { t, i18n } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const hotkey = useMacHotkey()
  const [application, setApplication] = useState<Application | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useSearchParams()
  const recording = query.get('recording') === '1'
  const setRecording = useCallback((value: boolean) => setQuery(value ? { recording: '1' } : {}, { replace: true }), [setQuery])
  const [recordingPermission, setRecordingPermission] = useState<RecordingPermission | null>(null)
  const [changingStep, setChangingStep] = useState(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!isMacOSClient) return
    const stop = watchMacHotkey()
    let cancelled = false
    void invoke<Application>('get_client_application').then((value) => {
      if (!cancelled) setApplication(value)
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true; stop() }
  }, [])

  useEffect(() => {
    rememberStep(recording ? 'recording' : 'input')
  }, [recording])

  useEffect(() => {
    let cancelled = false
    const listener = listen<boolean>('sharecode:permission-step', ({ payload }) => {
      if (!cancelled) { setRecording(payload); setError(null) }
    })
    return () => { cancelled = true; void listener.then((stop) => stop()).catch(() => {}) }
  }, [setRecording])

  useEffect(() => {
    if (!recording) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await invoke<RecordingPermission>('client_screen_share', { action: 'status', language: i18n.language })
        if (!cancelled) setRecordingPermission(result)
      } catch (reason) { if (!cancelled) setError(String(reason)) }
      if (!cancelled) timer = setTimeout(refresh, 1000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [recording, i18n.language])

  const action = async (run: () => Promise<unknown>) => {
    setError(null)
    try { await run() } catch (reason) { setError(String(reason)) }
  }
  const beginDrag = () => {
    dragStart.current = null
    if (!application?.canDrag || dragging) return
    setDragging(true)
    void action(() => invoke('drag_client_application')).finally(() => setDragging(false))
  }
  const next = async () => {
    if (changingStep) return
    setChangingStep(true)
    await action(async () => {
      const permission = await invoke<RecordingPermission>('client_screen_share', { action: 'status', language: i18n.language })
      if (!permission.supported || permission.permission) {
        if (!hotkey.ready) {
          await getCurrentWindow().close()
          return
        }
        await invoke('show_client_main')
        rememberStep('done')
        await getCurrentWindow().close()
        return
      }
      // Persist before a macOS-requested restart, then reuse the same helper window.
      rememberStep('recording')
      await invoke('open_client_recording_setup', { language: i18n.language })
      setRecording(true)
    })
    setChangingStep(false)
  }
  const finish = (showMain: boolean) => action(async () => {
    if (showMain) {
      if (!hotkey.ready) {
        await invoke('open_client_hotkey_setup', { language: i18n.language })
        setRecording(false)
        return
      }
      await invoke('show_client_main')
      rememberStep('done')
    }
    await getCurrentWindow().close()
  })
  const recordingReady = recordingPermission?.permission === true
  const recordingUnsupported = recordingPermission?.supported === false

  return (
    <main className="input-monitoring-setup" aria-labelledby="setup-title">
      <header>
        <div className="permission-setup-progress" aria-label={t('client.permissionSetup.progress')}>
          <span data-active={!recording}>{t('client.permissionSetup.inputStep')}</span>
          <span aria-hidden="true">→</span>
          <span data-active={recording}>{t('client.permissionSetup.recordingStep')}</span>
        </div>
        <div className="permission-setup-heading">
          <span className="input-monitoring-symbol">{recording ? <ScreenShare size={18} /> : <Keyboard size={18} />}</span>
          <h1 id="setup-title">{t(recording ? 'client.recordingSetup.title' : 'client.inputMonitoring.title')}</h1>
          <button type="button" className="permission-setup-open"
            aria-label={t(recording ? 'client.recordingSetup.openSettings' : 'client.inputMonitoring.openSettings')}
            onClick={() => void (recording ? action(() => invoke('open_client_recording_settings')) : hotkey.run('open_client_hotkey_settings'))} disabled={hotkey.busy}>
            {t('client.permissionSetup.settings')} <ArrowUpRight size={12} />
          </button>
        </div>
        <p className="permission-setup-path">{t(recording ? 'client.permissionSetup.recordingPath' : 'client.permissionSetup.inputPath')}</p>
      </header>
      <section className="permission-setup-drag">
        <p className="permission-setup-drag-instruction" data-testid="setup-drag-instruction">{t('client.permissionSetup.dragInstruction')}</p>
        <svg className="permission-setup-drag-arrow" viewBox="0 0 40 58" aria-hidden="true" focusable="false">
          {/* The arrowhead points away from the app card, toward the external permission list. */}
          <path d="M 21 51 C 17 45, 12 40, 9 33 C 1 17, 7 0, 29 8 M 25 3 L 34 5 L 30 14" />
        </svg>
        <button type="button" className="input-monitoring-app" data-testid="setup-drag-app"
          aria-label={t(recording ? 'client.recordingSetup.dragApp' : 'client.inputMonitoring.dragApp', { name: application?.name ?? 'ShareCode Client' })}
          disabled={!application?.canDrag || dragging || (recording && recordingUnsupported)}
          onPointerDown={(event) => {
            if (event.button === 0 && event.isPrimary) {
              dragStart.current = { x: event.clientX, y: event.clientY }
              event.currentTarget.setPointerCapture(event.pointerId)
            }
          }}
          onPointerMove={(event) => {
            const start = dragStart.current
            if (!start || !(event.buttons & 1) || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            beginDrag()
          }}
          onPointerUp={() => { dragStart.current = null }}
          onPointerCancel={() => { dragStart.current = null }}
          onDragStart={(event) => event.preventDefault()}>
          <ShareCodeLogo className="h-10 w-10 shrink-0" />
          <span><strong>{application?.name ?? 'ShareCode Client'}</strong></span>
          <Grip size={15} className="shrink-0" />
        </button>
      </section>
      {application && !application.canDrag && <p role="alert">{t('client.inputMonitoring.installFirst')}</p>}
      <p className="input-monitoring-fallback">{t('client.permissionSetup.enableHint')}</p>
      <div className="input-monitoring-status" role="status" data-testid="setup-status">
        {(recording ? recordingReady : hotkey.ready) && <CheckCircle2 size={16} />}
        {recording ? t(recordingUnsupported ? 'client.screenShare.phase.unsupported' : recordingReady ? 'client.recordingSetup.ready' : 'client.recordingSetup.required')
          : t(`client.hotkey.${hotkey.phase === 'listening' && !hotkey.ready ? 'recovering' : hotkey.phase}`)}
      </div>
      {!recording && (hotkey.testing || hotkey.lastAction) && <p role="status" className="input-monitoring-result">
        {t(`client.hotkey.${hotkey.testing ? 'testing' : hotkey.lastAction}`)}
      </p>}
      {(error || (!recording && (hotkey.commandError || hotkey.error))) && <p role="alert">{error || hotkey.commandError || hotkey.error}</p>}
      <footer>
        {recording ? <>
          <button type="button" onClick={() => void action(() => invoke('open_client_hotkey_setup', { language: i18n.language }))}>{t('client.permissionSetup.back')}</button>
          <button type="button" className="input-monitoring-primary" onClick={() => void finish(recordingReady || recordingUnsupported)}>{t(recordingReady || recordingUnsupported ? 'client.inputMonitoring.done' : 'client.inputMonitoring.later')}</button>
        </> : <>
          <button type="button" disabled={changingStep} onClick={() => void next()}>{t('client.inputMonitoring.later')}</button>
          <button type="button" disabled={!hotkey.ready || hotkey.busy || hotkey.testing}
            onClick={() => void hotkey.run('test_client_hotkey')}>{t('client.hotkey.test')}</button>
          <button type="button" className="input-monitoring-primary" disabled={!hotkey.ready || changingStep} onClick={() => void next()}>{t('client.permissionSetup.next')}</button>
        </>}
      </footer>
    </main>
  )
}
