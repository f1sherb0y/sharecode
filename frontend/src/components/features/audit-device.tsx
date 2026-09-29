import { useTranslation } from 'react-i18next'
// UA is displayed as a hint; the full original value remains available in details.
export function browserLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return [browser, os].filter(Boolean).join(' · ') || ua || '—'
}
export function AuditDevice({ deviceId, userAgent, newDevice }: { deviceId: string | null; fingerprint: string | null; userAgent: string; newDevice?: boolean }) {
  const { t } = useTranslation()
  return <div className="text-xs">
    <div>{browserLabel(userAgent)}</div>
    <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
      <code title={deviceId ?? undefined}>{deviceId ? deviceId.slice(0,8) : t('audit.unknownDevice')}</code>
      {newDevice && <span className="rounded-sm bg-accent px-1 text-accent-foreground font-medium">{t('audit.newDevice')}</span>}
    </div>
  </div>
}
