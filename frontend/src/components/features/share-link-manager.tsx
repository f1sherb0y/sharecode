import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Trash2, X } from 'lucide-react'
import { Button, Badge, Spinner } from '@/components/ui'
import { api } from '@/api'
import { isTauriApp } from '@/lib/tauri'
import type { ShareLink } from '@/types'

interface ShareLinkManagerProps {
  roomId: string
  onClose: () => void
}

export function ShareLinkManager({ roomId, onClose }: ShareLinkManagerProps) {
  const { t } = useTranslation()
  const [links, setLinks] = useState<ShareLink[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const loadLinks = useCallback(async () => {
    try {
      setIsLoading(true)
      const { shareLinks } = await api.listShareLinks(roomId)
      setLinks(shareLinks)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load share links')
    } finally {
      setIsLoading(false)
    }
  }, [roomId])

  useEffect(() => {
    loadLinks()
  }, [loadLinks])

  const createLink = async (canEdit: boolean) => {
    try {
      setIsCreating(true)
      setError('')
      setInfo('')
      const { shareLink } = await api.createShareLink(roomId, canEdit)
      setLinks((prev) => [shareLink, ...prev])
      setInfo(t('share.manager.created'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create share link')
    } finally {
      setIsCreating(false)
    }
  }

  const deleteLink = async (shareLink: ShareLink) => {
    if (!confirm(t('share.manager.deleteConfirm'))) return

    try {
      await api.deleteShareLink(roomId, shareLink.id)
      setLinks((prev) => prev.filter((link) => link.id !== shareLink.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete share link')
    }
  }

  const copyLink = async (shareLink: ShareLink) => {
    const shareUrl = resolveShareUrl(shareLink.token, roomId, shareLink.shareUrl)
    try {
      await navigator.clipboard.writeText(shareUrl)
      setInfo(t('share.manager.copied'))
    } catch {
      setError(t('share.manager.copyFailed'))
    }
  }

  const resolvedLinks = useMemo(
    () =>
      links.map((link) => ({
        ...link,
        shareUrl: resolveShareUrl(link.token, roomId, link.shareUrl),
      })),
    [links, roomId]
  )

  return (
    <div className="w-80 p-4 bg-popover border rounded-lg shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">{t('share.manager.title')}</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">{t('share.manager.description')}</p>

      <div className="flex gap-2 mb-3">
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => createLink(false)} disabled={isCreating}>
          {t('share.manager.createView')}
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => createLink(true)} disabled={isCreating}>
          {t('share.manager.createEdit')}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive mb-2">{error}</p>}
      {info && <p className="text-xs text-success mb-2">{info}</p>}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : resolvedLinks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('share.manager.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
          {resolvedLinks.map((link) => (
            <div key={link.id} className="p-2 border rounded-md bg-muted/50">
              <div className="flex items-center justify-between mb-1">
                <Badge variant={link.canEdit ? 'default' : 'secondary'} className="text-xs px-1.5 py-0">
                  {link.canEdit ? t('share.manager.editLabel') : t('share.manager.viewLabel')}
                </Badge>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyLink(link)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteLink(link)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground break-all font-mono">{link.shareUrl}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('share.manager.guests', { count: link.guestCount })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function resolveShareUrl(token: string, roomId: string, preferred?: string | null) {
  if (preferred) return preferred

  const useHashRoutes = isTauriApp() || (typeof window !== 'undefined' && window.location.hash.startsWith('#/'))

  if (typeof window !== 'undefined') {
    const origin = window.location.origin.replace(/\/$/, '')
    return useHashRoutes ? `${origin}/#/room/${roomId}?share=${token}` : `${origin}/room/${roomId}?share=${token}`
  }

  return token
}
