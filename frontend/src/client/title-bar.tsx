import { useEffect, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowDownToLine, Blend, Copy, EyeOff, Ghost, Minus, MonitorOff, MousePointer2, MousePointer2Off, Pin, Square, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useConnectionStore } from './connection'
import { nodeHost } from './nodes'
import { installUpdate, useUpdateStore } from './updater'
import {
  appWindow,
  useStealthPreferences,
  useWindowPreferences,
  MIN_BACKGROUND_OPACITY,
  MIN_TEXT_OPACITY,
  OPACITY_PRESETS,
  watchStealthShortcut,
} from './window'

/** Shown once an update has downloaded; restarting installs it (the room reopens after). */
function UpdateButton() {
  const { t } = useTranslation()
  const { ready, installing, failed } = useUpdateStore()
  if (!ready) return null
  const label = installing ? t('client.titleBar.updating') : t('client.titleBar.update')
  return (
    <button
      type="button"
      className="client-update-button"
      onClick={() => void installUpdate()}
      disabled={installing}
      title={failed ? t('client.titleBar.updateFailed') : t('client.titleBar.updateReady', { version: ready.version })}
    >
      <ArrowDownToLine className="h-3 w-3" />
      <span>{label}</span>
    </button>
  )
}

function OpacitySlider({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  const { t } = useTranslation()
  const percent = Math.round(value * 100)
  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{t('client.titleBar.percent', { value: percent })}</span>
      </span>
      <input
        type="range"
        min={min * 100}
        max={100}
        step={5}
        value={percent}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="client-opacity-slider w-full"
      />
    </label>
  )
}

/** One camouflage switch: label, live state and an on/off button. */
function StealthRow({
  icon,
  label,
  description,
  enabled,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode
  label: string
  description: string
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={enabled}
      className="client-stealth-row"
      data-active={enabled}
    >
      <span className="client-stealth-icon">{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] leading-tight text-muted-foreground">{description}</span>
      </span>
      <span className="client-stealth-switch" data-active={enabled} aria-hidden="true">
        <span className="client-stealth-knob" />
      </span>
      <span className="sr-only">{enabled ? t('client.titleBar.on') : t('client.titleBar.off')}</span>
    </button>
  )
}

export function TitleBar({ title, toolbarRef }: { title: string; toolbarRef?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation()
  const server = useConnectionStore((state) => state.server)
  const { pinned, setPinned, textOpacity, backgroundOpacity, setTextOpacity, setBackgroundOpacity, setOpacity } = useWindowPreferences()
  const {
    clickThrough,
    ready,
    busy,
    error,
    screenCaptureProtection,
    hideFromTaskbar,
    setClickThrough,
    setScreenCaptureProtection,
    setHideFromTaskbar,
  } = useStealthPreferences()
  const presetLabels = {
    opaque: t('client.titleBar.presetOpaque'),
    recommended: t('client.titleBar.presetRecommended'),
  }
  const [isMaximized, setIsMaximized] = useState(false)

  // Applies the saved pin on launch as well as every change.
  useEffect(() => {
    appWindow.setAlwaysOnTop(pinned).catch((error) => console.error('Failed to pin the window:', error))
  }, [pinned])

  // The native shortcut works without UI focus; subscribe before restoring saved preferences.
  useEffect(() => watchStealthShortcut(), [])

  useEffect(() => {
    if (error) toast.error(t('client.titleBar.stealthFailed'))
  }, [error, t])

  useEffect(() => {
    appWindow.setTitle(title).catch(() => {})
  }, [title])

  useEffect(() => {
    const sync = () => { appWindow.isMaximized().then(setIsMaximized).catch(() => {}) }
    sync()
    const unlisten = appWindow.onResized(sync)
    return () => { void unlisten.then((stop) => stop()) }
  }, [])

  const hiddenCount = [screenCaptureProtection, hideFromTaskbar, clickThrough].filter(Boolean).length

  return (
    <div data-tauri-drag-region className="client-title-bar">
      <div data-tauri-drag-region className="client-title-fallback flex min-w-0 flex-1 items-center gap-2 pl-2.5">
        <svg viewBox="0 0 32 32" className="pointer-events-none h-4 w-4 shrink-0" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="#3b82f6" />
          <path d="M12 10L6 16L12 22M20 10L26 16L20 22" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <span data-tauri-drag-region className="truncate text-xs font-medium">{title}</span>
        {server && (
          <span
            data-tauri-drag-region
            className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex"
            title={t('client.titleBar.server')}
          >
            <span className="pointer-events-none h-1.5 w-1.5 rounded-full bg-success" />
            {t('client.titleBar.serverLatency', { host: nodeHost(server.node), ms: server.latencyMs })}
          </span>
        )}
      </div>

      <div ref={toolbarRef} className="client-toolbar-host" />
      <div className="client-window-controls flex h-full shrink-0 items-center">
        <UpdateButton />

        {/* Click-through lives directly on the bar: it is the switch used most, and the one whose
            state has to be visible at a glance once the window stops taking input. */}
        <button
          type="button"
          className="client-title-button"
          data-active={clickThrough}
          disabled={!ready || busy}
          aria-keyshortcuts="Control+Shift+F"
          aria-pressed={clickThrough}
          onClick={() => setClickThrough(!clickThrough)}
          aria-label={clickThrough ? t('client.titleBar.disableClickThrough') : t('client.titleBar.enableClickThrough')}
          title={`${clickThrough ? t('client.titleBar.disableClickThrough') : t('client.titleBar.enableClickThrough')} (Ctrl+Shift+F)`}
        >
          {clickThrough ? <MousePointer2Off className="h-3.5 w-3.5" /> : <MousePointer2 className="h-3.5 w-3.5" />}
        </button>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="client-title-button"
              data-active={hiddenCount > 0}
              aria-label={t('client.titleBar.windowSettings')}
              title={t('client.titleBar.windowSettings')}
            >
              <Ghost className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-1 p-2">
            <p className="px-1 pb-0.5 text-xs font-medium">{t('client.titleBar.windowSettings')}</p>
            <StealthRow
              icon={<EyeOff className="h-3.5 w-3.5" />}
              label={t('client.titleBar.screenCaptureProtection')}
              description={t('client.titleBar.screenCaptureProtectionHint')}
              disabled={!ready || busy}
              enabled={screenCaptureProtection}
              onToggle={() => setScreenCaptureProtection(!screenCaptureProtection)}
            />
            <StealthRow
              icon={<MousePointer2Off className="h-3.5 w-3.5" />}
              label={t('client.titleBar.clickThrough')}
              description={t('client.titleBar.clickThroughHint')}
              disabled={!ready || busy}
              enabled={clickThrough}
              onToggle={() => setClickThrough(!clickThrough)}
            />
            <StealthRow
              icon={<MonitorOff className="h-3.5 w-3.5" />}
              label={t('client.titleBar.hideFromTaskbar')}
              description={t('client.titleBar.hideFromTaskbarHint')}
              disabled={!ready || busy}
              enabled={hideFromTaskbar}
              onToggle={() => setHideFromTaskbar(!hideFromTaskbar)}
            />
            <p className="px-1 pt-0.5 text-[11px] leading-tight text-muted-foreground">
              {t('client.titleBar.stealthShortcut')}
            </p>
            <div className="space-y-2.5 border-t border-border px-1 pt-2">
              <p className="flex items-center gap-1 text-xs font-medium"><Blend className="h-3.5 w-3.5" />{t('client.titleBar.opacity')}</p>
              <div className="grid grid-cols-2 gap-1">
                {OPACITY_PRESETS.map((preset) => {
                  const active = preset.text === textOpacity && preset.background === backgroundOpacity
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setOpacity(preset.text, preset.background)}
                      className={cn(
                        'rounded-md border px-1 py-1 text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
                        active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'
                      )}
                    >
                      {presetLabels[preset.id]}
                    </button>
                  )
                })}
              </div>
              <OpacitySlider
                label={t('client.titleBar.textOpacity')}
                value={textOpacity}
                min={MIN_TEXT_OPACITY}
                onChange={setTextOpacity}
              />
              <OpacitySlider
                label={t('client.titleBar.backgroundOpacity')}
                value={backgroundOpacity}
                min={MIN_BACKGROUND_OPACITY}
                onChange={setBackgroundOpacity}
              />
            </div>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          className="client-title-button"
          data-active={pinned}
          aria-pressed={pinned}
          onClick={() => setPinned(!pinned)}
          aria-label={pinned ? t('client.titleBar.unpin') : t('client.titleBar.pin')}
          title={pinned ? t('client.titleBar.unpin') : t('client.titleBar.pin')}
        >
          <Pin className={cn('h-3.5 w-3.5', pinned && 'fill-current')} />
        </button>

        <span className="mx-1 h-4 w-px bg-border" />

        <button
          type="button"
          className="client-title-button"
          onClick={() => void appWindow.minimize()}
          aria-label={t('client.titleBar.minimize')}
          title={t('client.titleBar.minimize')}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="client-title-button"
          onClick={() => void appWindow.toggleMaximize()}
          aria-label={isMaximized ? t('client.titleBar.restore') : t('client.titleBar.maximize')}
          title={isMaximized ? t('client.titleBar.restore') : t('client.titleBar.maximize')}
        >
          {isMaximized ? <Copy className="h-3 w-3 -scale-x-100" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          className="client-title-button client-title-close"
          onClick={() => void appWindow.close()}
          aria-label={t('client.titleBar.close')}
          title={t('client.titleBar.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
