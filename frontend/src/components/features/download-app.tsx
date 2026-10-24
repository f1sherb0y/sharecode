import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Download } from 'lucide-react'
import { getClientDownloads } from '@/api'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui'
import { archLabel, detectPlatform, osLabel, pickDownload, platformLabel, sortByPlatform } from '@/lib/client-releases'
import { queryKeys } from '@/lib/query-keys'
import { isTauriApp } from '@/lib/tauri'
import { formatBytes } from '@/lib/utils'
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

/** The desktop client's download: the newest installer for the visitor's system, the others
 * in a menu. Hidden on phones and tablets, inside the desktop apps and while nothing is published. */
export function DownloadApp() {
  const { t } = useTranslation()
  const inApp = isTauriApp()
  const [platform, setPlatform] = useState<ClientPlatform | 'mobile' | null>()
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

  return (
    <section aria-label={t('download.title')} className="mt-3 border-t pt-3">
      {primary ? (
        <>
          <Button asChild variant="outline" className="w-full">
            <a href={primary.url} download={primary.fileName}>
              <Download />
              {t('download.button', { os: osLabel(t, primary.platform) })}
            </a>
          </Button>
          <p className="mt-1 flex flex-wrap items-center justify-center gap-x-1 text-xs text-muted-foreground">
            <span>
              {t('download.details', { arch: archLabel(t, primary.platform), version: primary.version, size: formatBytes(primary.size) })}
            </span>
            {others.length > 0 && <span aria-hidden="true">·</span>}
            {others.length > 0 && (
              <PlatformMenu
                downloads={others}
                trigger={
                  <button type="button" className="inline-flex items-center gap-0.5 rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    {t('download.otherPlatforms')}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                }
              />
            )}
          </p>
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
