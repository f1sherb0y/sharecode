import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { getClientDownloads } from '@/api'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui'
import { archLabel, detectPlatform, installCommand, osLabel, pickDownload, platformLabel, sortByPlatform } from '@/lib/client-releases'
import { queryKeys } from '@/lib/query-keys'
import { isTauriApp } from '@/lib/tauri'
import { cn, copyTextToClipboard, formatBytes } from '@/lib/utils'
import type { ClientDownload, ClientPlatform } from '@/types'

function PlatformMenu({ downloads, trigger }: { downloads: ClientDownload[]; trigger: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {downloads.map((download) => (
          <DropdownMenuItem key={download.platform} asChild>
            <a href={download.url} download={download.fileName}>
              {t('download.menuItem', { platform: platformLabel(t, download.platform), version: download.version })}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const textButton =
  'inline-flex items-center gap-0.5 rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** The one-line install command. On macOS it is the way to install: a browser download of
 * the self-signed app is quarantined and Gatekeeper refuses to open it. */
function InstallCommand({ platform, className }: { platform: ClientPlatform; className?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const command = installCommand(platform, window.location.origin)
  if (!command) return null
  const copy = async () => {
    try {
      await copyTextToClipboard(command)
      setCopied(true)
      toast.success(t('download.command.copied'))
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('download.command.copyFailed'))
    }
  }
  return (
    <div className={cn('flex items-center rounded-md border bg-muted/50 pl-2 text-left', className)}>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1.5 font-mono text-xs">{command}</code>
      <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t('download.command.copy')} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

/** The desktop client's download: the newest installer for the visitor's system, the others
 * in a menu. Hidden on phones and tablets, inside the desktop apps and while nothing is published. */
export function DownloadApp() {
  const { t } = useTranslation()
  const inApp = isTauriApp()
  const [platform, setPlatform] = useState<ClientPlatform | 'mobile' | null>()
  const [showCommand, setShowCommand] = useState(false)
  const { data } = useQuery({
    queryKey: queryKeys.clientDownloads,
    queryFn: getClientDownloads,
    staleTime: 5 * 60_000,
    retry: false,
    enabled: !inApp,
  })

  useEffect(() => {
    let current = true
    void detectPlatform().then((detected) => {
      if (current) setPlatform(detected)
    })
    return () => {
      current = false
    }
  }, [])

  const downloads = sortByPlatform(data?.downloads ?? [])
  if (inApp || platform === undefined || platform === 'mobile' || downloads.length === 0) return null
  const primary = pickDownload(downloads, platform)
  const others = downloads.filter((download) => download !== primary)
  const hasCommand = !!primary && installCommand(primary.platform, window.location.origin) !== null
  // On macOS the command leads and the installer is only a link; on Windows the installer
  // works as downloaded and the command waits behind a toggle.
  const commandFirst = hasCommand && primary.platform.startsWith('darwin-')

  return (
    <section aria-label={t('download.title')} className="mt-3 border-t pt-3">
      {primary ? (
        <>
          {commandFirst ? (
            <InstallCommand platform={primary.platform} />
          ) : (
            <Button asChild variant="outline" className="w-full">
              <a href={primary.url} download={primary.fileName}>
                <Download />
                {t('download.button', { os: osLabel(t, primary.platform) })}
              </a>
            </Button>
          )}
          <p className="mt-1 flex flex-wrap items-center justify-center gap-x-1 text-xs text-muted-foreground">
            <span>
              {t('download.details', { arch: archLabel(t, primary.platform), version: primary.version, size: formatBytes(primary.size) })}
            </span>
            {commandFirst && <span aria-hidden="true">·</span>}
            {commandFirst && (
              <a href={primary.url} download={primary.fileName} className={textButton}>
                {t('download.installer')}
              </a>
            )}
            {hasCommand && !commandFirst && <span aria-hidden="true">·</span>}
            {hasCommand && !commandFirst && (
              <button type="button" aria-expanded={showCommand} onClick={() => setShowCommand((shown) => !shown)} className={textButton}>
                {t('download.command.show')}
                <ChevronDown className={cn('h-3 w-3 transition-transform', showCommand && 'rotate-180')} />
              </button>
            )}
            {others.length > 0 && <span aria-hidden="true">·</span>}
            {others.length > 0 && (
              <PlatformMenu
                downloads={others}
                trigger={
                  <button type="button" className={textButton}>
                    {t('download.otherPlatforms')}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                }
              />
            )}
          </p>
          {hasCommand && !commandFirst && showCommand && <InstallCommand platform={primary.platform} className="mt-2" />}
        </>
      ) : (
        <PlatformMenu
          downloads={downloads}
          trigger={
            <Button variant="outline" className="w-full">
              <Download />
              {t('download.choose')}
              <ChevronDown />
            </Button>
          }
        />
      )}
    </section>
  )
}
