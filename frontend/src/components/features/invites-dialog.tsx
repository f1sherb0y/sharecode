import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
} from '@/components/ui'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import { formatInviteCode, inviteLink } from '@/lib/invites'
import { queryKeys } from '@/lib/query-keys'
import { copyTextToClipboard, formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores'
import type { RegistrationInvite } from '@/types'

interface InvitesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Agents and admins issue single-use registration codes for techs. */
export function InvitesDialog({ open, onOpenChange }: InvitesDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const viewer = useAuthStore(state => state.user)
  const [note, setNote] = useState('')
  const [inviteToWithdraw, setInviteToWithdraw] = useState<RegistrationInvite | null>(null)

  const { data: invites = [], isLoading, error } = useQuery({
    queryKey: queryKeys.invites,
    queryFn: async () => (await api.listInvites()).invites,
    enabled: open,
  })

  const createMutation = useMutation({
    mutationFn: async () => (await api.createInvite(note.trim() || undefined)).invite,
    onSuccess: async (invite) => {
      setNote('')
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites })
      // Like share links, a new invite link goes straight to the clipboard.
      toast.success(await copy(inviteLink(invite)) ? t('invites.createdAndCopied') : t('invites.created'))
    },
    onError: (err) => toast.error(translateError(err instanceof Error ? err.message : 'Failed to create invite')),
  })

  const withdrawMutation = useMutation({
    mutationFn: (invite: RegistrationInvite) => api.deleteInvite(invite.id),
    onSuccess: async () => {
      setInviteToWithdraw(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites })
      toast.success(t('invites.deleted'))
    },
    onError: (err) => toast.error(translateError(err instanceof Error ? err.message : 'Failed to delete invite')),
  })

  const copyWithToast = async (value: string, message: string) => {
    if (await copy(value)) toast.success(message)
    else toast.error(t('invites.copyFailed'))
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('invites.title')}</DialogTitle>
          </DialogHeader>

          <form
            className="flex items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              createMutation.mutate()
            }}
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor="invite-note">{t('invites.noteLabel')}</Label>
              <Input
                id="invite-note"
                value={note}
                maxLength={100}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? t('invites.creating') : t('invites.create')}
            </Button>
          </form>

          {error && <p className="text-xs text-destructive">{translateError(error.message)}</p>}

          {isLoading ? (
            <div className="flex justify-center py-2">
              <Spinner size="sm" />
            </div>
          ) : invites.length === 0 ? (
            <p className="text-sm text-muted-foreground py-1.5 text-center">{t('invites.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1" aria-label={t('invites.title')}>
              {invites.map((invite) => {
                const status = invite.isUsed ? 'used' : invite.isExpired ? 'expired' : 'active'
                const code = formatInviteCode(invite.code)
                return (
                  <li key={invite.id} className="p-2 border rounded-md bg-muted/50">
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex min-w-0 items-center gap-1">
                        <code className="font-mono text-sm">{code}</code>
                        <Badge
                          variant={status === 'active' ? 'success' : status === 'used' ? 'secondary' : 'destructive'}
                          className="text-xs px-1 py-0"
                        >
                          {t(`invites.status.${status}`)}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        {status === 'active' && (
                          <>
                            <Button variant="ghost" size="icon-sm" aria-label={t('invites.copyCode')} onClick={() => copyWithToast(code, t('invites.codeCopied'))}>
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" aria-label={t('invites.copyLink')} onClick={() => copyWithToast(inviteLink(invite), t('invites.linkCopied'))}>
                              <Link2 className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                        {!invite.isUsed && (
                          <Button variant="ghost" size="icon-sm" aria-label={t('invites.delete')} className="text-destructive" onClick={() => setInviteToWithdraw(invite)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {invite.note && <p className="text-sm mt-1 break-words">{invite.note}</p>}
                    <p className="text-xs text-muted-foreground mt-1">
                      {invite.usedBy && invite.usedAt
                        ? t('invites.usedBy', { username: invite.usedBy.username, time: formatDateTime(invite.usedAt) })
                        : t('invites.expiresAt', { time: formatDateTime(invite.expiresAt) })}
                      {invite.createdBy.id !== viewer?.id && <> · {t('invites.createdBy', { username: invite.createdBy.username })}</>}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!inviteToWithdraw} onOpenChange={(open) => !open && setInviteToWithdraw(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('invites.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('invites.deleteConfirm', { code: formatInviteCode(inviteToWithdraw?.code ?? '') })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteToWithdraw(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => inviteToWithdraw && withdrawMutation.mutate(inviteToWithdraw)}
              disabled={withdrawMutation.isPending}
            >
              {t('invites.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

async function copy(value: string): Promise<boolean> {
  if (!value) return false
  try {
    await copyTextToClipboard(value)
    return true
  } catch {
    return false
  }
}
