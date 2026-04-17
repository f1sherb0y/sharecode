import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { 
  Button, 
  Badge, 
  Spinner,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle, 
} from '@/components/ui'
import { api } from '@/api'
import { isTauriApp } from '@/lib/tauri'
import { copyTextToClipboard } from '@/lib/utils'
import type { ShareLink } from '@/types'

interface ShareLinkManagerProps {
  roomId: string
}

export function ShareLinkManager({ roomId }: ShareLinkManagerProps) {
  const { t } = useTranslation()
  const [links, setLinks] = useState<ShareLink[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const [linkToDelete, setLinkToDelete] = useState<ShareLink | null>(null)

  const loadLinks = useCallback(async () => {
    try {
      setIsLoading(true)
      const { shareLinks } = await api.listShareLinks(roomId)
      setLinks(shareLinks)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('share.manager.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [roomId, t])

  useEffect(() => {
    loadLinks()
  }, [loadLinks])

  const createLink = async (canEdit: boolean) => {
    try {
      setIsCreating(true)
      setError('')
      const { shareLink } = await api.createShareLink(roomId, canEdit)
      setLinks((prev) => [shareLink, ...prev])
      toast.success(t('share.manager.created'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('share.manager.createFailed')
      setError(msg)
      toast.error(msg)
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteClick = (shareLink: ShareLink) => {
    setLinkToDelete(shareLink)
  }

  const confirmDeleteLink = async () => {
    if (!linkToDelete) return

    try {
      await api.deleteShareLink(roomId, linkToDelete.id)
      setLinks((prev) => prev.filter((link) => link.id !== linkToDelete.id))
      setLinkToDelete(null)
      toast.success(t('share.manager.deleted'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('share.manager.deleteFailed')
      setError(msg)
      toast.error(msg)
    }
  }

  const copyLink = async (shareLink: ShareLink) => {
    const shareUrl = resolveShareUrl(shareLink.token)
    try {
      await copyTextToClipboard(shareUrl)
      toast.success(t('share.manager.copied'))
    } catch {
      toast.error(t('share.manager.copyFailed'))
    }
  }

  const resolvedLinks = useMemo(
    () =>
      links.map((link) => ({
        ...link,
        shareUrl: resolveShareUrl(link.token),
      })),
    [links]
  )

  return (
    <div className="w-full">
      <p className="text-sm text-muted-foreground mb-4">{t('share.manager.description')}</p>

      <div className="flex gap-2 mb-4">
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => createLink(false)} disabled={isCreating}>
          {t('share.manager.createView')}
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => createLink(true)} disabled={isCreating}>
          {t('share.manager.createEdit')}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive mb-2">{error}</p>}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : resolvedLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2 text-center">{t('share.manager.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
          {resolvedLinks.map((link) => (
            <div key={link.id} className="p-3 border rounded-md bg-muted/50">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Badge variant={link.canEdit ? 'default' : 'secondary'} className="text-xs px-1.5 py-0">
                    {link.canEdit ? t('share.manager.editLabel') : t('share.manager.viewLabel')}
                  </Badge>
                  <Badge
                    variant={link.isConsumed ? 'secondary' : link.isExpired ? 'destructive' : 'success'}
                    className="text-xs px-1.5 py-0"
                  >
                    {link.isConsumed
                      ? t('share.manager.statusUsed')
                      : link.isExpired
                        ? t('share.manager.statusExpired')
                        : t('share.manager.statusActive')}
                  </Badge>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => copyLink(link)}
                    disabled={link.isConsumed || link.isExpired}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => handleDeleteClick(link)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground break-all font-mono">{link.shareUrl}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {link.isConsumed
                  ? t('share.manager.usedAt', { time: formatLocalDateTime(link.consumedAt) })
                  : t('share.manager.expiresAt', { time: formatLocalDateTime(link.expiresAt) })}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('share.manager.guests', { count: link.guestCount })}
              </p>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!linkToDelete} onOpenChange={(open) => !open && setLinkToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('share.manager.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('share.manager.deleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkToDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteLink}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function resolveShareUrl(token: string) {
  const useHashRoutes = isTauriApp() || (typeof window !== 'undefined' && window.location.hash.startsWith('#/'))

  if (typeof window !== 'undefined') {
    const origin = window.location.origin.replace(/\/$/, '')
    return useHashRoutes ? `${origin}/#/s/${token}` : `${origin}/s/${token}`
  }

  return token
}

function formatLocalDateTime(value?: string | null) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString()
}
