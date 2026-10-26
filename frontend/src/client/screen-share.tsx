import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Monitor, RefreshCw, ScreenShare, ShieldCheck, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Phase = 'idle' | 'loading' | 'permissionRequired' | 'starting' | 'sharing' | 'stopped' | 'error' | 'unsupported'
interface CaptureState {
  virtualDisplaySupported?: boolean
  outputDisplay?: number
  outputWidth?: number
  outputHeight?: number
  supported: boolean
  permission: boolean
  phase: Phase
  running: boolean
  displays: { id: number; width: number; height: number }[]
  selectedDisplay?: number
  error?: string
}
type Action = 'status' | 'refresh' | 'start' | 'stop' | 'settings'

/** Same in-app popover as the Ghost menu. Closing it never stops an active capture. */
export function ScreenShareMenu() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<CaptureState | null>(null)
  const [display, setDisplay] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const actionPending = useRef(false)
  const revision = useRef(0)
  const alive = useRef(true)
  const language = i18n.resolvedLanguage ?? i18n.language

  useEffect(() => {
    alive.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let first = true
    const poll = async () => {
      if (pending.current || actionPending.current) { timer = setTimeout(poll, 500); return }
      pending.current = true
      const ticket = revision.current
      try {
        let result = await invoke<CaptureState>('client_screen_share', { action: 'status', language })
        // Enumerate automatically only when permission is already granted. Never prompt on open.
        if (first && ticket === revision.current && result.supported && result.permission && !result.running) {
          result = await invoke<CaptureState>('client_screen_share', { action: 'refresh', language })
        }
        first = false
        if (!cancelled && ticket === revision.current) setState(result)
      } catch (reason) {
        if (!cancelled && ticket === revision.current) setError(String(reason))
      } finally {
        pending.current = false
        if (!cancelled) timer = setTimeout(poll, 700)
      }
    }
    void poll()
    return () => { cancelled = true; alive.current = false; clearTimeout(timer) }
  }, [language])

  useEffect(() => {
    const first = state?.displays[0]
    if (!state || !first) { setDisplay(''); return }
    if (!state.displays.some((item) => String(item.id) === display)) {
      setDisplay(String(state.selectedDisplay ?? first.id))
    }
  }, [state?.displays, display])

  const action = async (action: Action) => {
    if (actionPending.current) return
    actionPending.current = true
    revision.current += 1
    setBusy(true)
    setError(null)
    try {
      if (action === 'settings') {
        await invoke('open_client_recording_setup', { language })
        return
      }
      const result = await invoke<CaptureState>('client_screen_share', {
        action, language, displayId: display ? Number(display) : null,
      })
      if (alive.current) setState(result)
    } catch (reason) { if (alive.current) setError(String(reason)) }
    finally { actionPending.current = false; if (alive.current) setBusy(false) }
  }
  const running = state?.running ?? false
  const loading = !state || state.phase === 'loading'
  const unsupported = state?.supported === false
  const virtualUnavailable = state?.virtualDisplaySupported === false

  return (
    <section className="screen-share-menu" aria-labelledby="screen-share-title">
      <header>
        <h2 id="screen-share-title">{t('client.screenShare.title')}</h2>
        <p>{t('client.screenShare.instructions')}</p>
      </header>
      <section className="client-stealth-row screen-share-exclusions">
        <span className="client-stealth-icon"><ShieldCheck size={15} aria-hidden="true" /></span>
        <div><strong>{t('client.screenShare.excluded')}</strong><p>{t('client.screenShare.apps')}</p></div>
      </section>
      <div className="screen-share-display">
        <label htmlFor="capture-display"><Monitor size={16} />{t('client.screenShare.display')}</label>
        <div>
          <Select value={display} onValueChange={setDisplay}
            disabled={busy || running || loading || unsupported || !state?.displays.length}>
            <SelectTrigger id="capture-display" className="h-control-sm flex-1 min-w-0 text-xs">
              <SelectValue placeholder={t('client.screenShare.noDisplays')} />
            </SelectTrigger>
            <SelectContent className="screen-share-display-options">
              {state?.displays.map((item, index) => (
                <SelectItem key={item.id} value={String(item.id)} className="text-xs">
                  {t('client.screenShare.displayOption', { number: index + 1, width: item.width, height: item.height })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="icon-sm" variant="outline" disabled={busy || running || loading || unsupported}
            aria-label={t('client.screenShare.refresh')} title={t('client.screenShare.refresh')}
            onClick={() => void action('refresh')}><RefreshCw size={15} /></Button>
        </div>
      </div>
      <p className="screen-share-detail">{state?.outputWidth && state?.outputHeight
        ? t('client.screenShare.formatLive', { width: state.outputWidth, height: state.outputHeight })
        : t('client.screenShare.format')}</p>
      <p className="screen-share-detail">{t('client.screenShare.background')}</p>
      <div role="status" className="screen-share-status" data-live={state?.phase === 'sharing'}>
        <span aria-hidden="true" />{t(`client.screenShare.phase.${state?.phase ?? 'loading'}`)}
      </div>
      {virtualUnavailable && !unsupported && <p role="alert">{t('client.screenShare.virtualUnavailable')}</p>}
      {(error || state?.error) && <p role="alert">{error ?? state?.error}</p>}
      {state && !state.permission && !unsupported && <p className="screen-share-detail">{t('client.screenShare.permissionHint')}</p>}
      <footer>
        <Button size="sm" variant="outline" disabled={busy || unsupported} onClick={() => void action('settings')}>
          {t('client.screenShare.settings')}
        </Button>
        <Button size="sm" disabled={busy || loading || unsupported || (!running && virtualUnavailable)} onClick={() => void action(running ? 'stop' : 'start')}>
          {running ? <Square size={15} /> : <ScreenShare size={15} />}
          {t(running ? 'client.screenShare.stop' : 'client.screenShare.start')}
        </Button>
      </footer>
    </section>
  )
}
