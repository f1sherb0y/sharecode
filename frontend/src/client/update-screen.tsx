import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, RotateCw, X } from 'lucide-react'
import { checkForUpdate, installUpdate, useUpdateStore } from './updater'
import { appWindow } from './window'

/** Replaces the whole client, including its toolbar and portaled room controls. */
export function UpdateScreen() {
  const { t } = useTranslation()
  const { phase, version, received, total, failure, checking } = useUpdateStore()
  const ready = phase === 'ready' || phase === 'installing'
  const percent = ready ? 100 : total ? Math.min(100, Math.floor(received / total * 100)) : null
  const downloading = phase === 'downloading'
  const title = version ? t('client.updater.needed') : t('client.updater.checking')

  return (
    <div className="client-update-screen">
      <div className="client-update-drag" data-tauri-drag-region>
        <button type="button" className="client-title-button client-title-close"
          onClick={() => void appWindow.close()} aria-label={t('client.titleBar.close')}>
          <X size={16} />
        </button>
      </div>
      <main className="client-update-content" aria-labelledby="client-update-heading" aria-busy={phase === 'checking' || downloading || phase === 'installing'}>
        <ArrowDownToLine className="client-update-icon" size={28} aria-hidden="true" />
        <h1 id="client-update-heading">{title}</h1>
        {version && <p className="client-update-version">{t('client.updater.version', { version })}</p>}
        {(downloading || ready) && (
          <div className="client-update-progress">
            <div className="client-update-track" role="progressbar"
              aria-label={t('client.updater.downloading')} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={percent ?? undefined}>
              <span data-indeterminate={percent === null ? 'true' : undefined}
                style={{ width: percent === null ? '35%' : `${percent}%` }} />
            </div>
            <p aria-live="polite">{ready ? t('client.updater.downloaded') : t('client.updater.downloading')}
              {percent !== null && <span>{percent}%</span>}
            </p>
          </div>
        )}
        {failure && <p className="client-update-error" role="alert">{t(`client.updater.${failure}Failed`)}</p>}
        {phase === 'error' && (
          <button type="button" className="client-update-action" onClick={() => void checkForUpdate()}>
            <RotateCw size={16} aria-hidden="true" />{t('client.updater.retry')}
          </button>
        )}
        {ready && (
          <button type="button" className="client-update-action" disabled={phase === 'installing' || checking}
            onClick={() => void installUpdate()}>
            <RotateCw size={16} aria-hidden="true" />
            {phase === 'installing' ? t('client.updater.installing') : t('client.updater.restart')}
          </button>
        )}
      </main>
    </div>
  )
}
