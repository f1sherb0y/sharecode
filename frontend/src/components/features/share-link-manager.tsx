import { formatDateTime } from '@/lib/utils'
import { translateError } from '@/i18n/errors'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { queryKeys } from '@/lib/query-keys'
import { isTauriApp } from '@/lib/tauri'
import { copyTextToClipboard } from '@/lib/utils'
import type { ShareLink } from '@/types'

interface ShareLinkManagerProps {
  roomId: string
  /** Fills in the guest's name on the join page, e.g. a scheduled session's customer. */
  guestName?: string
  /** Hide the generic explanation when the surrounding dialog gives its own. */
  showDescription?: boolean
}

export function ShareLinkManager({ roomId, guestName, showDescription = true }: ShareLinkManagerProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [linkToDelete, setLinkToDelete] = useState<ShareLink | null>(null)

  const { data: links = [], isLoading } = useQuery({
    queryKey: queryKeys.shareLinks(roomId),
    queryFn: async () => {
      const { shareLinks } = await api.listShareLinks(roomId)
      return shareLinks
    },
    enabled: !!roomId,
  })

  useEffect(() => {
    setError('')
  }, [roomId])

  const createLinkMutation = useMutation({
    mutationFn: async (canEdit: boolean) => {
      const { shareLink } = await api.createShareLink(roomId, canEdit)
      return shareLink
    },
    onSuccess: async (shareLink) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(roomId) })

      // Auto-copy the newly created link to the clipboard.
      try {
        const url = resolveShareUrl(shareLink, guestName)
        if (!url) throw new Error("Missing public sharing URL")
        await copyTextToClipboard(url)
        toast.success(t('share.manager.createdAndCopied'))
      } catch {
        toast.success(t('share.manager.created'))
      }
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : t('share.manager.createFailed')
      setError(msg)
      toast.error(translateError(msg))
    },
  })

  const deleteLinkMutation = useMutation({
    mutationFn: async (shareLinkId: string) => {
      await api.deleteShareLink(roomId, shareLinkId)
      return shareLinkId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(roomId) })
      setLinkToDelete(null)
      toast.success(t('share.manager.deleted'))
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : t('share.manager.deleteFailed')
      setError(msg)
      toast.error(translateError(msg))
    },
  })

  const createLink = async (canEdit: boolean) => {
    try {
      setError('')
      await createLinkMutation.mutateAsync(canEdit)
    } catch (err) {
      // handled by mutation callbacks
    }
  }

  const handleDeleteClick = (shareLink: ShareLink) => {
    setLinkToDelete(shareLink)
  }

  const confirmDeleteLink = async () => {
    if (!linkToDelete) return

    try {
      await deleteLinkMutation.mutateAsync(linkToDelete.id)
    } catch (err) {
      // handled by mutation callbacks
    }
  }

  const copyLink = async (shareLink: ShareLink) => {
    const shareUrl = resolveShareUrl(shareLink, guestName)
    try {
      if (!shareUrl) throw new Error("Configure a public APP_URL on the server")
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
        shareUrl: resolveShareUrl(link, guestName),
      })),
    [links, guestName]
  )

  return (
    <div className="w-full">
      {showDescription && <p className="text-sm text-muted-foreground mb-2">{t('share.manager.description')}</p>}

      <div className="flex gap-1 mb-2">
        <Button size="sm" variant="outline" onClick={() => createLink(false)} disabled={createLinkMutation.isPending}>
          {t('share.manager.createView')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => createLink(true)} disabled={createLinkMutation.isPending}>
          {t('share.manager.createEdit')}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive mb-1.5">{translateError(error)}</p>}

      {isLoading ? (
        <div className="flex justify-center py-2">
          <Spinner size="sm" />
        </div>
      ) : resolvedLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground py-1.5 text-center">{t('share.manager.empty')}</p>
      ) : (
        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto pr-1">
          {resolvedLinks.map((link) => (
            <div key={link.id} className="p-2 border rounded-md bg-muted/50">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1">
                  <Badge variant={link.canEdit ? 'default' : 'secondary'} className="text-xs px-1 py-0">
                    {link.canEdit ? t('share.manager.editLabel') : t('share.manager.viewLabel')}
                  </Badge>
                  {(link.isConsumed || link.isExpired) && (
                    <Badge variant="destructive" className="text-xs px-1 py-0">
                      {link.isConsumed ? t('share.manager.statusConsumed') : t('share.manager.statusExpired')}
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('share.manager.copy')}
                    onClick={() => copyLink(link)}
                    disabled={link.isExpired || link.isConsumed}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t('share.manager.delete')} className="text-destructive" onClick={() => handleDeleteClick(link)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground break-all font-mono">{link.shareUrl}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('share.manager.expiresAt', { time: formatLocalDateTime(link.expiresAt) })}
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
            <Button variant="destructive" onClick={confirmDeleteLink} disabled={deleteLinkMutation.isPending}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function resolveShareUrl(link: ShareLink, guestName?: string) {
  const base = !isTauriApp()
    ? `${window.location.origin}/s/${link.token}`
    : link.shareUrl && /^https?:\/\//.test(link.shareUrl) ? link.shareUrl : ''
  return base && guestName ? `${base}?${new URLSearchParams({ name: guestName })}` : base
}

function formatLocalDateTime(value?: string | null) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return formatDateTime(date)
}
