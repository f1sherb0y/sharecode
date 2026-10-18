import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Download, DoorOpen, Link2, Play, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import { api } from '@/api'
import { translateError } from '@/i18n/errors'
import type { Appointment } from '@/types'

interface SessionRoomActionsProps {
  appointment: Appointment
  /** Icon-only buttons for dense rows. */
  compact?: boolean
  /** Called once a room was created, so lists can refresh. */
  onChanged?: (appointment: Appointment) => void
}

/** A session that is over and never had a room has nothing left to open. */
export function hasRoomActions(appointment: Appointment): boolean {
  return !!appointment.room || Date.parse(appointment.endsAt) > Date.now()
}

/**
 * A session's room: the tech owns it and the customer joins through a share link
 * that already carries their name. The first "Open room" creates it.
 */
export function SessionRoomActions({ appointment, compact = false, onChanged }: SessionRoomActionsProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<'open' | 'link' | 'replace' | 'download' | null>(null)
  const [linkRoomId, setLinkRoomId] = useState<string | null>(null)
  const room = appointment.room

  const ensureRoom = async (replace = false) => {
    const result = await api.openAppointmentRoom(appointment.id, { replace })
    if (result.created) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['appointments'] }),
        queryClient.invalidateQueries({ queryKey: ['rooms'] }),
      ])
      onChanged?.(result.appointment)
    }
    return result.room.id
  }

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    try { await action() }
    catch (error) { toast.error(translateError(error instanceof Error ? error.message : t('schedule.room.failed'))) }
    finally { setBusy(null) }
  }

  const open = () => run('open', async () => {
    const roomId = room && !room.isEnded ? room.id : await ensureRoom()
    navigate(`/room/${roomId}`)
  })
  const share = () => run('link', async () => setLinkRoomId(room && !room.isEnded ? room.id : await ensureRoom()))
  const replace = () => run('replace', async () => navigate(`/room/${await ensureRoom(true)}`))
  const download = () => run('download', async () => {
    if (!room) return
    const { downloadSession, ExportImageError } = await import('@/export/download')
    try { await downloadSession({ id: room.id, language: room.language }) }
    catch (error) { throw new Error(error instanceof ExportImageError ? t('playback.exportImageFailed') : t('playback.exportFailed')) }
  })

  const size = compact ? 'icon-sm' : 'sm'
  const label = (text: string) => (compact ? <span className="sr-only">{text}</span> : text)
  if (!hasRoomActions(appointment)) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {room?.isEnded ? (
          <>
            <Button type="button" size={size} variant="outline" title={t('schedule.room.replay')} onClick={() => navigate(`/playback/${room.id}`)}>
              <Play />{label(t('schedule.room.replay'))}
            </Button>
            {!compact && (
              <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={download}>
                <Download />{t('schedule.room.download')}
              </Button>
            )}
            {!compact && (
              <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={replace}>
                <RotateCcw />{t('schedule.room.replace')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button type="button" size={size} variant={compact ? 'outline' : 'default'} disabled={!!busy} title={room ? t('schedule.room.open') : t('schedule.room.create')} onClick={open}>
              <DoorOpen />{label(busy === 'open' ? t('schedule.room.opening') : room ? t('schedule.room.open') : t('schedule.room.create'))}
            </Button>
            <Button type="button" size={size} variant="outline" disabled={!!busy} title={t('schedule.room.customerLink')} onClick={share}>
              <Link2 />{label(t('schedule.room.customerLink'))}
            </Button>
          </>
        )}
      </div>

      <Dialog open={!!linkRoomId} onOpenChange={(next) => !next && setLinkRoomId(null)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('schedule.room.customerLinkTitle', { customer: appointment.customer.name })}</DialogTitle>
          </DialogHeader>
          {linkRoomId && <ShareLinkManager roomId={linkRoomId} guestName={appointment.customer.name} showDescription={false} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
