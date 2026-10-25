import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CheckCircle2, ArrowUpRight, Grip, Keyboard } from 'lucide-react'
import { ShareCodeLogo } from '@/components/share-code-logo'
import { useThemeStore } from '@/stores/theme'
import { useMacHotkey, watchMacHotkey } from './hotkey'
import { isMacOSClient } from './window'

const SHOWN_KEY = 'sharecode-input-monitoring-guide-shown'

export function useInputMonitoringSetup() {
  const phase = useMacHotkey((state) => state.phase)
  const busy = useMacHotkey((state) => state.busy)
  const attempted = useRef(false)
  useEffect(() => {
    if (!isMacOSClient || phase !== 'permissionRequired' || busy || attempted.current) return
    attempted.current = true
    try { if (localStorage.getItem(SHOWN_KEY)) return } catch { /* still offer this launch */ }
    void useMacHotkey.getState().run('open_client_hotkey_setup').then(() => {
      if (useMacHotkey.getState().commandError) return
      try { localStorage.setItem(SHOWN_KEY, '1') } catch { /* no persistent storage */ }
    })
  }, [phase, busy])
}

interface Application { name: string; path: string | null; canDrag: boolean }

/** A dedicated native window: no room restoration, opacity, stealth or updater side effects. */
export function InputMonitoringSetup() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const hotkey = useMacHotkey()
  const [application, setApplication] = useState<Application | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
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

  return (
    <main className="input-monitoring-setup" aria-labelledby="setup-title">
      <header>
        <span className="input-monitoring-symbol"><Keyboard size={22} /></span>
        <h1 id="setup-title">{t('client.inputMonitoring.title')}</h1>
        <p>{t('client.inputMonitoring.description')}</p>
      </header>
      <ol className="input-monitoring-steps">
        <li><span>1</span><div>{t('client.inputMonitoring.openStep')}
          <button type="button" onClick={() => void hotkey.run('open_client_hotkey_settings')} disabled={hotkey.busy}>
            {t('client.inputMonitoring.openSettings')} <ArrowUpRight size={14} />
          </button>
        </div></li>
        <li><span>2</span><div>{t('client.inputMonitoring.dragStep')}</div></li>
      </ol>
      <button type="button" className="input-monitoring-app" data-testid="setup-drag-app"
        aria-label={t('client.inputMonitoring.dragApp', { name: application?.name ?? 'ShareCode Client' })}
        disabled={!application?.canDrag || dragging}
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
        <ShareCodeLogo className="h-14 w-14" />
        <span><strong>{application?.name ?? 'ShareCode Client'}</strong><small>{t('client.inputMonitoring.dragHint')}</small></span>
        <Grip size={18} />
      </button>
      {application && !application.canDrag && <p role="alert">{t('client.inputMonitoring.installFirst')}</p>}
      <p className="input-monitoring-fallback">{t('client.inputMonitoring.fallback', { name: application?.name ?? 'ShareCode Client' })}</p>
      <ol className="input-monitoring-steps" start={3}>
        <li><span>3</span><div>{t('client.inputMonitoring.enableStep')}</div></li>
      </ol>
      <div className="input-monitoring-status" role="status" data-testid="setup-status">
        {hotkey.ready && <CheckCircle2 size={16} />}
        {t(`client.hotkey.${hotkey.phase === 'listening' && !hotkey.ready ? 'recovering' : hotkey.phase}`)}
      </div>
      {(hotkey.testing || hotkey.lastAction) && <p role="status" className="input-monitoring-result">
        {t(`client.hotkey.${hotkey.testing ? 'testing' : hotkey.lastAction}`)}
      </p>}
      {(error || hotkey.commandError || hotkey.error) && <p role="alert">{error || hotkey.commandError || hotkey.error}</p>}
      <footer>
        <button type="button" onClick={() => void action(() => getCurrentWindow().close())}>{t(hotkey.ready ? 'client.inputMonitoring.done' : 'client.inputMonitoring.later')}</button>
        <button type="button" className="input-monitoring-primary" disabled={!hotkey.ready || hotkey.busy || hotkey.testing}
          onClick={() => void hotkey.run('test_client_hotkey')}>{t('client.hotkey.test')}</button>
      </footer>
    </main>
  )
}
