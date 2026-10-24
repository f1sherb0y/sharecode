import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, Blend, Copy, Minus, Pin, Square, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useConnectionStore } from './connection'
import { nodeHost } from './nodes'
import { installUpdate, useUpdateStore } from './updater'
import { appWindow, useWindowPreferences, MIN_BACKGROUND_OPACITY, MIN_TEXT_OPACITY, OPACITY_PRESETS } from './window'

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

export function TitleBar({ title }: { title: string }) {
  const { t } = useTranslation()
  const server = useConnectionStore((state) => state.server)
  const { pinned, setPinned, textOpacity, backgroundOpacity, setTextOpacity, setBackgroundOpacity, setOpacity } = useWindowPreferences()
  const presetLabels = {
    opaque: t('client.titleBar.presetOpaque'),
    recommended: t('client.titleBar.presetRecommended'),
  }
  const [isMaximized, setIsMaximized] = useState(false)

  // Applies the saved pin on launch as well as every change.
  useEffect(() => {
    appWindow.setAlwaysOnTop(pinned).catch((error) => console.error('Failed to pin the window:', error))
  }, [pinned])

  useEffect(() => {
    appWindow.setTitle(title).catch(() => {})
  }, [title])

  useEffect(() => {
    const sync = () => { appWindow.isMaximized().then(setIsMaximized).catch(() => {}) }
    sync()
    const unlisten = appWindow.onResized(sync)
    return () => { void unlisten.then((stop) => stop()) }
  }, [])

  return (
    <div data-tauri-drag-region className="client-title-bar">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 pl-2.5">
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

      <div className="flex h-full shrink-0 items-center">
        <UpdateButton />
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="client-title-button"
              data-active={textOpacity < 1 || backgroundOpacity < 1}
              aria-label={t('client.titleBar.opacity')}
              title={t('client.titleBar.opacity')}
            >
              <Blend className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 space-y-2.5 p-2.5">
            <p className="text-xs font-medium">{t('client.titleBar.opacity')}</p>
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
