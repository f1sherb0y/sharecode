import { LANGUAGES } from '@/types'
import { translateError } from '@/i18n/errors'
import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Users, Trash2, Play, Share2, Pencil, Pin, PinOff, MoreHorizontal, Download, LockKeyhole, CalendarDays } from 'lucide-react'
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Spinner,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { canDeleteRoom, canManageRoom, canManageRoomShares, canViewRoomPlayback, isAdmin, isStaff } from '@/lib/room-permissions'
import { queryKeys } from '@/lib/query-keys'
import { TimeFields } from '@/components/schedule/time-fields'
import { dateKeyOf, timeInputValue } from '@/lib/zoned-time'
import { useAuthStore, useSettingsStore } from '@/stores'
import { cn, formatDateMinutes } from '@/lib/utils'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import { TodaySessions } from '@/components/schedule/today-sessions'
import type { Room, Language, User, PaginationMeta, RoomActiveness } from '@/types'


const DEFAULT_PAGE_SIZE = 50
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const VALID_ACTIVENESS: RoomActiveness[] = ['all', 'active', 'ended']
const ELLIPSIS_LEFT = 'ellipsis-left'
const ELLIPSIS_RIGHT = 'ellipsis-right'
type PageButtonItem = number | typeof ELLIPSIS_LEFT | typeof ELLIPSIS_RIGHT
const EMPTY_PAGINATION: PaginationMeta = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 0,
  hasNext: false,
  hasPrev: false,
}

function buildPageButtons(currentPage: number, totalPages: number): PageButtonItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1)
  }

  const buttons: PageButtonItem[] = [1]
  const start = Math.max(2, currentPage - 1)
  const end = Math.min(totalPages - 1, currentPage + 1)

  if (start > 2) {
    buttons.push(ELLIPSIS_LEFT)
  }

  for (let page = start; page <= end; page += 1) {
    buttons.push(page)
  }

  if (end < totalPages - 1) {
    buttons.push(ELLIPSIS_RIGHT)
  }

  buttons.push(totalPages)
  return buttons
}

/** The next half hour, as date and time fields in the given zone. */
function nextHalfHour(timeZone: string): { date: string; time: string } {
  const step = 30 * 60_000
  const next = (Math.floor(Date.now() / step) + 1) * step
  return { date: dateKeyOf(next, timeZone), time: timeInputValue(next, timeZone) }
}

export function RoomsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuthStore()
  const { timezone } = useSettingsStore()

  const [error, setError] = useState('')
  const [exportingRoomId, setExportingRoomId] = useState<string | null>(null)
  const handleExport = async (room: Room) => {
    if (exportingRoomId) return
    setExportingRoomId(room.id)
    setError('')
    try {
      const { downloadSession, ExportImageError } = await import('@/export/download')
      try { await downloadSession(room) }
      catch (error) { if (error instanceof ExportImageError) { setError(t('playback.exportImageFailed')); return }; throw error }
    } catch { setError(t('playback.exportFailed')) }
    finally { setExportingRoomId(null) }
  }
  const [pinUpdatingRoomId, setPinUpdatingRoomId] = useState<string | null>(null)
  const page = useMemo(() => {
    const raw = Number(searchParams.get('page') ?? '')
    return Number.isInteger(raw) && raw > 0 ? raw : 1
  }, [searchParams])
  const pageSize = useMemo(() => {
    const raw = Number(searchParams.get('pageSize') ?? '')
    return PAGE_SIZE_OPTIONS.includes(raw) ? raw : DEFAULT_PAGE_SIZE
  }, [searchParams])
  const ownerFilter = searchParams.get('ownerId') ?? 'all'
  const activenessFilter = useMemo<RoomActiveness>(() => {
    const raw = searchParams.get('activeness')
    if (raw && VALID_ACTIVENESS.includes(raw as RoomActiveness)) {
      return raw as RoomActiveness
    }
    return 'all'
  }, [searchParams])

  // Create room form state
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomPrivate, setNewRoomPrivate] = useState(false)
  const [newRoomLanguage, setNewRoomLanguage] = useState<Language>('javascript')
  const [newRoomCompany, setNewRoomCompany] = useState('')
  const [newRoomPosition, setNewRoomPosition] = useState('')
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [duration, setDuration] = useState(60)

  // Delete dialog state
  const [roomToDelete, setRoomToDelete] = useState<{ id: string; name: string } | null>(null)
  
  // Share dialog state
  const [roomToShare, setRoomToShare] = useState<{ id: string; name: string } | null>(null)
  
  // Rename dialog state
  const [roomToRename, setRoomToRename] = useState<{ id: string; name: string } | null>(null)
  const [renameRoomName, setRenameRoomName] = useState('')

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (searchParams.get('page') !== String(page)) {
      normalized.set('page', String(page))
      changed = true
    }
    if (searchParams.get('pageSize') !== String(pageSize)) {
      normalized.set('pageSize', String(pageSize))
      changed = true
    }
    if ((searchParams.get('ownerId') ?? 'all') !== ownerFilter) {
      normalized.set('ownerId', ownerFilter)
      changed = true
    }
    if (searchParams.get('activeness') !== activenessFilter) {
      normalized.set('activeness', activenessFilter)
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, page, pageSize, ownerFilter, activenessFilter, setSearchParams])

  const roomListParams = useMemo(
    () => ({
      page,
      pageSize,
      ownerId: ownerFilter === 'all' ? undefined : ownerFilter,
      activeness: activenessFilter,
    }),
    [page, pageSize, ownerFilter, activenessFilter]
  )

  const roomsQuery = useQuery({
    queryKey: queryKeys.rooms(roomListParams),
    queryFn: () => api.getRooms(roomListParams),
    enabled: !!user,
  })

  // Only agents and admins see other people's rooms, so only they filter by owner.
  const canFilterOwners = isStaff(user)
  const roomOwnersQuery = useQuery({
    queryKey: queryKeys.roomCreationUsers,
    queryFn: async () => {
      const { users } = await api.getRoomOwners()
      return users
    },
    enabled: canFilterOwners,
  })

  const createRoomMutation = useMutation({
    mutationFn: async () =>
      api.createRoom(
        newRoomName,
        newRoomLanguage,
        scheduledDate && scheduledTime ? `${scheduledDate}T${scheduledTime}` : undefined,
        duration,
        newRoomCompany || undefined,
        newRoomPosition || undefined,
        timezone,
        isAdmin(user) && newRoomPrivate
      ),
    onSuccess: async ({ room }) => {
      await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      setIsCreateOpen(false)
      resetForm()
      navigate(`/room/${room.id}`)
    },
  })

  const deleteRoomMutation = useMutation({
    mutationFn: async (roomId: string) => api.deleteRoom(roomId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      setRoomToDelete(null)
    },
  })

  const renameRoomMutation = useMutation({
    mutationFn: async ({ roomId, name }: { roomId: string; name: string }) =>
      api.updateRoom(roomId, { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      setRoomToRename(null)
      setRenameRoomName('')
    },
  })

  const pinRoomMutation = useMutation({
    mutationFn: async ({ roomId, isPinned }: { roomId: string; isPinned: boolean }) =>
      api.setRoomPin(roomId, isPinned),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rooms'] })
    },
    onSettled: (_data, _error, variables) => {
      if (variables) {
        setPinUpdatingRoomId((current) => (current === variables.roomId ? null : current))
      }
    },
  })

  const rooms = roomsQuery.data?.rooms ?? []
  const pagination = roomsQuery.data?.pagination ?? EMPTY_PAGINATION
  const isLoading = roomsQuery.isLoading
  const roomOwners = roomOwnersQuery.data ?? []

  useEffect(() => {
    const queryError = roomsQuery.error ?? roomOwnersQuery.error
    if (queryError instanceof Error) {
      setError(queryError.message)
    }
  }, [roomsQuery.error, roomOwnersQuery.error])

  useEffect(() => {
    if (pagination.totalPages > 0 && rooms.length === 0 && page > pagination.totalPages) {
      updateListParams({ page: pagination.totalPages })
    }
  }, [pagination.totalPages, rooms.length, page])

  const updateListParams = (updates: {
    page?: number
    pageSize?: number
    ownerId?: string
    activeness?: RoomActiveness
  }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      const nextPage = updates.page ?? page
      const nextPageSize = updates.pageSize ?? pageSize
      const nextOwnerId = updates.ownerId ?? ownerFilter
      const nextActiveness = updates.activeness ?? activenessFilter

      next.set('page', String(Math.max(1, nextPage)))
      next.set('pageSize', String(PAGE_SIZE_OPTIONS.includes(nextPageSize) ? nextPageSize : DEFAULT_PAGE_SIZE))
      next.set('ownerId', nextOwnerId)
      next.set('activeness', nextActiveness)
      return next
    })
  }

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      setError('')
      await createRoomMutation.mutateAsync()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
    }
  }

  const resetForm = () => {
    setNewRoomName('')
    setNewRoomPrivate(false)
    setNewRoomLanguage('javascript')
    setNewRoomCompany('')
    setNewRoomPosition('')
    setDuration(60)
  }

  const handleDeleteRoom = (roomId: string, roomName: string) => {
    setRoomToDelete({ id: roomId, name: roomName })
  }

  const handleShareRoom = (roomId: string, roomName: string) => {
    setRoomToShare({ id: roomId, name: roomName })
  }

  const handleRenameRoom = (roomId: string, roomName: string) => {
    setRoomToRename({ id: roomId, name: roomName })
    setRenameRoomName(roomName)
  }

  const confirmDeleteRoom = async () => {
    if (!roomToDelete) return

    try {
      setError('')
      await deleteRoomMutation.mutateAsync(roomToDelete.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
    }
  }

  const confirmRenameRoom = async () => {
    if (!roomToRename) return
    const trimmedName = renameRoomName.trim()
    if (!trimmedName) return

    try {
      setError('')
      await renameRoomMutation.mutateAsync({ roomId: roomToRename.id, name: trimmedName })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename room')
    }
  }

  const pageButtons = useMemo(
    () => buildPageButtons(pagination.page, pagination.totalPages),
    [pagination.page, pagination.totalPages]
  )

  const handleCreateOpenChange = (open: boolean) => {
    setIsCreateOpen(open)
    if (open) {
      const next = nextHalfHour(timezone)
      setScheduledDate(next.date)
      setScheduledTime(next.time)
      setDuration(60)
    }
  }

  const handleTogglePin = async (room: Room) => {
    if (!isStaff(user)) return

    try {
      setPinUpdatingRoomId(room.id)
      setError('')
      await pinRoomMutation.mutateAsync({ roomId: room.id, isPinned: !room.isPinned })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update room pin status')
    }
  }

  return (
    <div className="rooms-page flex flex-col min-h-screen">
      <Navbar
        title="ShareCode"
        rightContent={
          <>
            <Button variant="outline" asChild>
              <Link to="/schedule" aria-label={t('schedule.entry')}>
                <CalendarDays className="h-4 w-4" />
                <span className="hidden sm:inline">{t('schedule.entry')}</span>
              </Link>
            </Button>
            <Dialog open={isCreateOpen} onOpenChange={handleCreateOpenChange}>
              <DialogTrigger asChild>
                <Button aria-label={t('rooms.createButton')}>
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">{t('rooms.createButton')}</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
                <form onSubmit={handleCreateRoom}>
                  <DialogHeader>
                    <DialogTitle>{t('rooms.create.title')}</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-2 py-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="roomName">{t('rooms.create.name')}</Label>
                        <Input
                          id="roomName"
                          value={newRoomName}
                          onChange={(e) => setNewRoomName(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('rooms.create.language')}</Label>
                        <Select value={newRoomLanguage} onValueChange={(v) => setNewRoomLanguage(v as Language)}>
                          <SelectTrigger aria-label={t('rooms.create.language')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {LANGUAGES.map((lang) => (
                              <SelectItem key={lang} value={lang}>
                                {lang}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="roomCompany">{t('rooms.create.company')}</Label>
                        <Input
                          id="roomCompany"
                          value={newRoomCompany}
                          onChange={(e) => setNewRoomCompany(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="roomPosition">{t('rooms.create.position')}</Label>
                        <Input
                          id="roomPosition"
                          value={newRoomPosition}
                          onChange={(e) => setNewRoomPosition(e.target.value)}
                        />
                      </div>
                    </div>
                    <TimeFields
                      id="room"
                      date={scheduledDate}
                      time={scheduledTime}
                      duration={duration}
                      onDate={setScheduledDate}
                      onTime={setScheduledTime}
                      onDuration={setDuration}
                    />
                    {isAdmin(user) && <label className="ui-check-row flex cursor-pointer items-center gap-1.5">
                      <Checkbox id="privateRoom" checked={newRoomPrivate} onCheckedChange={value => setNewRoomPrivate(value === true)} aria-labelledby="privateRoomLabel" />
                      <span id="privateRoomLabel" className="text-sm font-medium leading-none">{t('rooms.create.private')}</span>
                    </label>}
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                      {t('rooms.cancel')}
                    </Button>
                    <Button type="submit" disabled={createRoomMutation.isPending}>
                      {createRoomMutation.isPending ? t('rooms.create.creating') : t('rooms.create.button')}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      <Dialog open={!!roomToDelete} onOpenChange={(open) => !open && setRoomToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rooms.list.deleteTitle', 'Delete Room')}</DialogTitle>
            <DialogDescription>
              {t('rooms.list.deleteConfirm', { name: roomToDelete?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoomToDelete(null)}>
              {t('rooms.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteRoom} disabled={deleteRoomMutation.isPending}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!roomToRename}
        onOpenChange={(open) => {
          if (!open) {
            setRoomToRename(null)
            setRenameRoomName('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rooms.list.renameTitle')}</DialogTitle>
            <DialogDescription>
              {t('rooms.list.renameConfirm', { name: roomToRename?.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="renameRoomName">{t('rooms.create.name')}</Label>
            <Input
              id="renameRoomName"
              value={renameRoomName}
              onChange={(e) => setRenameRoomName(e.target.value)}
              maxLength={120}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoomToRename(null)}>
              {t('rooms.cancel')}
            </Button>
            <Button onClick={confirmRenameRoom} disabled={renameRoomMutation.isPending || !renameRoomName.trim()}>
              {renameRoomMutation.isPending ? t('rooms.list.renaming') : t('rooms.list.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share Dialog */}
      <Dialog open={!!roomToShare} onOpenChange={(open) => !open && setRoomToShare(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('share.manager.title')}</DialogTitle>
          </DialogHeader>
          {roomToShare && (
             <div className="py-1.5">
               <ShareLinkManager roomId={roomToShare.id} />
             </div>
          )}
        </DialogContent>
      </Dialog>

      <PageContainer>
        <TodaySessions />
        <div className="rooms-list-toolbar flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="ui-page-title text-base font-semibold tracking-tight">{t('rooms.workspaceTitle')}</h1>
          <span className="text-xs text-muted-foreground">{t('rooms.pagination.total', { count: pagination.total })}</span>
          <div className={cn('grid w-full gap-1 sm:ml-auto sm:w-auto', canFilterOwners ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:grid-cols-[10rem_8rem_6rem]' : 'grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[8rem_6rem]')}>
            {canFilterOwners && <div className="space-y-1">
              <Label className="sr-only">{t('rooms.filters.owner')}</Label>
              <Select
                value={ownerFilter}
                onValueChange={(value) => {
                  updateListParams({
                    ownerId: value,
                    page: 1,
                  })
                }}
              >
                <SelectTrigger aria-label={t('rooms.filters.owner')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('rooms.filters.allOwners')}</SelectItem>
                  {roomOwners.map((roomUser) => (
                    <SelectItem key={roomUser.id} value={roomUser.id}>
                      {roomUser.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>}
            <div className="space-y-1">
              <Label className="sr-only">{t('rooms.filters.activeness')}</Label>
              <Select
                value={activenessFilter}
                onValueChange={(value) => {
                  updateListParams({
                    activeness: value as RoomActiveness,
                    page: 1,
                  })
                }}
              >
                <SelectTrigger aria-label={t('rooms.filters.activeness')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('rooms.filters.allActiveness')}</SelectItem>
                  <SelectItem value="active">{t('rooms.filters.active')}</SelectItem>
                  <SelectItem value="ended">{t('rooms.filters.ended')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="sr-only">{t('rooms.pagination.pageSize')}</Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  updateListParams({
                    pageSize: Number(value),
                    page: 1,
                  })
                }}
              >
                <SelectTrigger aria-label={t('rooms.pagination.pageSize')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {t('rooms.pagination.perPage', { count: size })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        {exportingRoomId && <p role="status" className="mb-2 text-sm text-muted-foreground">{t('playback.exporting')}</p>}
        {error && <p role="alert" className="mb-2 text-sm text-destructive">{translateError(error)}</p>}

        {isLoading ? (
          <div className="flex justify-center items-center py-6">
            <Spinner size="lg" />
          </div>
        ) : rooms.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-muted-foreground">{t('rooms.list.empty')}</p>
          </div>
        ) : (
          <div className="room-list">
            <div className="room-list-heading" aria-hidden="true">
              <div className="room-list-columns">
                <span>{t('rooms.columns.name')}</span>
                <span>{t('rooms.columns.language')}</span>
                <span>{t('rooms.list.owner')}</span>
                <span>{t('rooms.columns.status')}</span>
                <span className="text-right">{t('rooms.columns.people')}</span>
                <span>{t('rooms.columns.time')}</span>
                <span className="text-right">{t('rooms.list.duration')}</span>
              </div>
              <span className="room-row-actions" />
            </div>
            {rooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                currentUser={user ?? undefined}
                onDelete={() => handleDeleteRoom(room.id, room.name)}
                onRename={() => handleRenameRoom(room.id, room.name)}
                onShare={() => handleShareRoom(room.id, room.name)}
                onTogglePin={() => handleTogglePin(room)}
                isPinUpdating={pinUpdatingRoomId === room.id}
                onPlayback={() => navigate(`/playback/${room.id}`)}
                onExport={() => void handleExport(room)}
                isExporting={exportingRoomId !== null}
              />
            ))}
          </div>
        )}

        {!isLoading && pagination.totalPages > 0 && (
          <nav aria-label={t('rooms.pagination.label')} className="mt-2 flex flex-wrap items-center justify-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.hasPrev}
              onClick={() => updateListParams({ page: Math.max(1, page - 1) })}
            >
              {t('rooms.pagination.prev')}
            </Button>
            {pageButtons.map((item, index) => (
              typeof item === 'number' ? (
                <Button
                  key={`page-${item}`}
                  variant={item === pagination.page ? 'default' : 'outline'}
                  size="sm"
                  aria-label={t('rooms.pagination.goToPage', { page: item })}
                  aria-current={item === pagination.page ? 'page' : undefined}
                  onClick={() => updateListParams({ page: item })}
                >
                  {item}
                </Button>
              ) : (
                <span key={`${item}-${index}`} className="px-1 text-sm text-muted-foreground">
                  ...
                </span>
              )
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.hasNext}
              onClick={() => updateListParams({ page: page + 1 })}
            >
              {t('rooms.pagination.next')}
            </Button>
          </nav>
        )}
      </PageContainer>
    </div>
  )
}

interface RoomRowProps {
  room: Room
  currentUser?: User
  onDelete: () => void
  onRename: () => void
  onShare: () => void
  onTogglePin: () => void
  isPinUpdating: boolean
  onPlayback: () => void
  onExport: () => void
  isExporting: boolean
}

function RoomRow({
  room,
  currentUser,
  onDelete,
  onRename,
  onShare,
  onTogglePin,
  isPinUpdating,
  onPlayback,
  onExport,
  isExporting,
}: RoomRowProps) {
  const { t } = useTranslation()

  const isOwner = room.ownerId === currentUser?.id
  const canShareRoom = canManageRoomShares(currentUser, room.ownerId)
  const canDeleteCurrentRoom = canDeleteRoom(currentUser)
  const canRenameRoom = canManageRoom(currentUser, room.ownerId)
  const canPinRoom = isStaff(currentUser)
  const participantCount = (room.participants?.length ?? 0) + 1
  const canViewPlayback = room.isEnded && canViewRoomPlayback(currentUser, room)

  return (
    <article className={cn('room-row group', room.isPinned && 'room-row-pinned')}>
      <Link
        to={canViewPlayback ? `/playback/${room.id}` : `/room/${room.id}`}
        aria-label={room.name}
        className="room-row-link room-list-columns focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="room-row-name flex min-w-0 items-center gap-1.5">
          {room.isPrivate && <LockKeyhole className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('rooms.list.private')} />}
          <span title={room.name} className="min-w-0 truncate font-medium">{room.name}</span>
          {room.isPinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('rooms.list.pinned')} />}
        </div>
        <span className="room-row-language">{room.language}</span>
        <div className="room-row-owner flex min-w-0 items-center gap-1">
          <span className="truncate" title={room.owner.username}>{isOwner ? t('rooms.list.me') : room.owner.username}</span>
        </div>
        <span className={cn('room-row-status', !room.isEnded && 'room-row-status-active')}>
          <span className="room-row-status-dot" aria-hidden="true" />
          {room.isEnded ? t('rooms.list.ended') : t('rooms.filters.active')}
        </span>
        <span className="room-row-people" title={t('rooms.list.participants')}>
          <Users className="h-3 w-3" aria-hidden="true" /><span>{participantCount}</span>
          <span className="sr-only">{t('rooms.list.participants')}</span>
        </span>
        <time className="room-row-time" dateTime={room.scheduledTime || room.createdAt} title={formatDateMinutes(room.scheduledTime || room.createdAt)}>
          {formatDateMinutes(room.scheduledTime || room.createdAt)}
        </time>
        <span className="room-row-duration">
          {room.scheduledTime && room.duration ? `${room.duration} ${t('rooms.list.durationUnit')}` : '—'}
        </span>
      </Link>
      <div className="room-row-actions flex items-center justify-end">
        {(canShareRoom || canRenameRoom || canPinRoom || canViewPlayback || canDeleteCurrentRoom) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${t('editor.toolbar.more')} · ${room.name}`} title={t('editor.toolbar.more')}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canShareRoom && !room.isEnded && <DropdownMenuItem onClick={onShare}><Share2 className="mr-1.5 h-4 w-4" />{t('editor.toolbar.share')}</DropdownMenuItem>}
              {canRenameRoom && <DropdownMenuItem onClick={onRename}><Pencil className="mr-1.5 h-4 w-4" />{t('rooms.list.rename')}</DropdownMenuItem>}
              {canPinRoom && <DropdownMenuItem onClick={onTogglePin} disabled={isPinUpdating}>{room.isPinned ? <PinOff className="mr-1.5 h-4 w-4" /> : <Pin className="mr-1.5 h-4 w-4" />}{room.isPinned ? t('rooms.list.unpin') : t('rooms.list.pin')}</DropdownMenuItem>}
              {canViewPlayback && <DropdownMenuItem onClick={onPlayback}><Play className="mr-1.5 h-4 w-4" />{t('rooms.list.viewPlayback')}</DropdownMenuItem>}
              {canViewPlayback && <DropdownMenuItem disabled={isExporting} onClick={onExport}><Download className="mr-1.5 h-4 w-4" />{t('playback.export')}</DropdownMenuItem>}
              {canDeleteCurrentRoom && <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}><Trash2 className="mr-1.5 h-4 w-4" />{t('common.delete')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </article>
  )
}
