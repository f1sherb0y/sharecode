import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Users, Clock, Trash2, Play, Calendar, Share2, Pencil, Pin, PinOff } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Badge,
  Spinner,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { cn, formatDate } from '@/lib/utils'
import { ShareLinkManager } from '@/components/features/share-link-manager'
import type { Room, Language, User, PaginationMeta, RoomActiveness } from '@/types'

const LANGUAGES: Language[] = ['javascript', 'typescript', 'python', 'java', 'cpp', 'rust', 'go', 'php']
const DEFAULT_PAGE_SIZE = 20
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

function getNextHalfHourBoundaryLocal(): string {
  const next = new Date()
  next.setSeconds(0, 0)
  const minutes = next.getMinutes()
  const addMinutes = minutes % 30 === 0 ? 30 : 30 - (minutes % 30)
  next.setMinutes(minutes + addMinutes)

  const year = next.getFullYear()
  const month = String(next.getMonth() + 1).padStart(2, '0')
  const day = String(next.getDate()).padStart(2, '0')
  const hours = String(next.getHours()).padStart(2, '0')
  const mins = String(next.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${mins}`
}

export function RoomsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuthStore()

  const [rooms, setRooms] = useState<Room[]>([])
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
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
  const [newRoomLanguage, setNewRoomLanguage] = useState<Language>('javascript')
  const [newRoomCompany, setNewRoomCompany] = useState('')
  const [newRoomPosition, setNewRoomPosition] = useState('')
  const [scheduledTime, setScheduledTime] = useState(getNextHalfHourBoundaryLocal())
  const [duration, setDuration] = useState('60')
  const [isCreating, setIsCreating] = useState(false)

  // Delete dialog state
  const [roomToDelete, setRoomToDelete] = useState<{ id: string; name: string } | null>(null)
  
  // Share dialog state
  const [roomToShare, setRoomToShare] = useState<{ id: string; name: string } | null>(null)
  
  // Rename dialog state
  const [roomToRename, setRoomToRename] = useState<{ id: string; name: string } | null>(null)
  const [renameRoomName, setRenameRoomName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  // User selection for room access
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [selectedUsers, setSelectedUsers] = useState<Array<{ userId: string; canEdit: boolean }>>([])

  useEffect(() => {
    loadUsers()
  }, [])

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

  useEffect(() => {
    loadRooms()
  }, [page, pageSize, ownerFilter, activenessFilter])

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

  const loadRooms = async () => {
    try {
      setIsLoading(true)
      const { rooms, pagination } = await api.getRooms({
        page,
        pageSize,
        ownerId: ownerFilter === 'all' ? undefined : ownerFilter,
        activeness: activenessFilter,
      })
      setRooms(rooms)
      setPagination(pagination ?? EMPTY_PAGINATION)

      if (pagination && rooms.length === 0 && pagination.totalPages > 0 && page > pagination.totalPages) {
        updateListParams({ page: pagination.totalPages })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms')
    } finally {
      setIsLoading(false)
    }
  }

  const loadUsers = async () => {
    try {
      const { users } = await api.getAllUsersForRoomCreation()
      setAllUsers(users)
    } catch {
      // Non-critical error
    }
  }

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsCreating(true)

    try {
      const { room } = await api.createRoom(
        newRoomName,
        newRoomLanguage,
        scheduledTime || undefined,
        duration ? parseInt(duration, 10) : undefined,
        selectedUsers.length > 0 ? selectedUsers : undefined,
        newRoomCompany || undefined,
        newRoomPosition || undefined
      )
      setIsCreateOpen(false)
      resetForm()
      navigate(`/room/${room.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
    } finally {
      setIsCreating(false)
    }
  }

  const resetForm = () => {
    setNewRoomName('')
    setNewRoomLanguage('javascript')
    setNewRoomCompany('')
    setNewRoomPosition('')
    setScheduledTime(getNextHalfHourBoundaryLocal())
    setDuration('60')
    setSelectedUsers([])
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
      await api.deleteRoom(roomToDelete.id)
      setRoomToDelete(null)
      loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
    }
  }

  const confirmRenameRoom = async () => {
    if (!roomToRename) return
    const trimmedName = renameRoomName.trim()
    if (!trimmedName) return

    try {
      setIsRenaming(true)
      await api.updateRoom(roomToRename.id, { name: trimmedName })
      setRoomToRename(null)
      setRenameRoomName('')
      loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename room')
    } finally {
      setIsRenaming(false)
    }
  }

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers((prev) => {
      const existing = prev.find((u) => u.userId === userId)
      if (existing) {
        return prev.filter((u) => u.userId !== userId)
      }
      return [...prev, { userId, canEdit: true }]
    })
  }

  const toggleUserCanEdit = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.map((u) => (u.userId === userId ? { ...u, canEdit: !u.canEdit } : u))
    )
  }

  const availableUsers = allUsers.filter((u) => u.id !== user?.id)
  const pageButtons = useMemo(
    () => buildPageButtons(pagination.page, pagination.totalPages),
    [pagination.page, pagination.totalPages]
  )

  const handleCreateOpenChange = (open: boolean) => {
    setIsCreateOpen(open)
    if (open) {
      setScheduledTime(getNextHalfHourBoundaryLocal())
      setDuration('60')
    }
  }

  const handleTogglePin = async (room: Room) => {
    if (!user || (user.role !== 'admin' && user.role !== 'superuser')) return

    try {
      setPinUpdatingRoomId(room.id)
      await api.setRoomPin(room.id, !room.isPinned)
      await loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update room pin status')
    } finally {
      setPinUpdatingRoomId(null)
    }
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar
        title="ShareCode"
        rightContent={
          <Dialog open={isCreateOpen} onOpenChange={handleCreateOpenChange}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">{t('rooms.createButton')}</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleCreateRoom}>
                <DialogHeader>
                  <DialogTitle>{t('rooms.create.title')}</DialogTitle>
                  <DialogDescription>{t('rooms.create.allowedUsersHint')}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="roomName" className="text-xs">{t('rooms.create.name')}</Label>
                    <Input
                      id="roomName"
                      className="h-9 text-xs"
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      placeholder={t('rooms.create.namePlaceholder')}
                      required
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('rooms.create.language')}</Label>
                      <Select value={newRoomLanguage} onValueChange={(v) => setNewRoomLanguage(v as Language)}>
                        <SelectTrigger className="h-9 text-xs">
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
                    <div className="space-y-1.5">
                      <Label htmlFor="roomCompany" className="text-xs">{t('rooms.create.company')}</Label>
                      <Input
                        id="roomCompany"
                        className="h-9 text-xs"
                        value={newRoomCompany}
                        onChange={(e) => setNewRoomCompany(e.target.value)}
                        placeholder={t('rooms.create.companyPlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="roomPosition" className="text-xs">{t('rooms.create.position')}</Label>
                      <Input
                        id="roomPosition"
                        className="h-9 text-xs"
                        value={newRoomPosition}
                        onChange={(e) => setNewRoomPosition(e.target.value)}
                        placeholder={t('rooms.create.positionPlaceholder')}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="duration" className="text-xs">{t('rooms.create.duration')}</Label>
                      <Input
                        id="duration"
                        className="h-9 text-xs"
                        type="number"
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        placeholder={t('rooms.create.durationPlaceholder')}
                        min="1"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="scheduledTime" className="text-xs">{t('rooms.create.scheduledTime')}</Label>
                    <Input
                      id="scheduledTime"
                      className="h-9 text-xs"
                      type="datetime-local"
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                    />
                  </div>
                  {availableUsers.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('rooms.create.allowedUsers')}</Label>
                      <div className="border rounded-md max-h-32 overflow-y-auto">
                        {availableUsers.map((u) => {
                          const selected = selectedUsers.find((s) => s.userId === u.id)
                          return (
                            <div
                              key={u.id}
                              className={cn(
                                'flex items-center justify-between px-2.5 py-1.5 hover:bg-accent cursor-pointer',
                                selected && 'bg-accent/50'
                              )}
                              onClick={() => toggleUserSelection(u.id)}
                            >
                              <span className="text-xs">{u.username}</span>
                              {selected && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleUserCanEdit(u.id)
                                  }}
                                >
                                  {selected.canEdit ? t('rooms.create.canEdit') : t('rooms.create.canView')}
                                </Button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      {selectedUsers.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t('rooms.create.selectedUsers', { count: selectedUsers.length })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                    {t('rooms.cancel')}
                  </Button>
                  <Button type="submit" disabled={isCreating}>
                    {isCreating ? t('rooms.create.creating') : t('rooms.create.button')}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
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
            <Button variant="destructive" onClick={confirmDeleteRoom}>
              {t('rooms.delete')}
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
          <div className="space-y-2">
            <Label htmlFor="renameRoomName">{t('rooms.create.name')}</Label>
            <Input
              id="renameRoomName"
              value={renameRoomName}
              onChange={(e) => setRenameRoomName(e.target.value)}
              placeholder={t('rooms.list.renamePlaceholder')}
              maxLength={120}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoomToRename(null)}>
              {t('rooms.cancel')}
            </Button>
            <Button onClick={confirmRenameRoom} disabled={isRenaming || !renameRoomName.trim()}>
              {isRenaming ? t('rooms.list.renaming') : t('rooms.list.rename')}
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
             <div className="py-2">
               <ShareLinkManager roomId={roomToShare.id} />
             </div>
          )}
        </DialogContent>
      </Dialog>

      <PageContainer>
        {error && (
          <div className="mb-4 p-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
        )}

        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
            <div className="space-y-1">
              <Label>{t('rooms.filters.owner')}</Label>
              <Select
                value={ownerFilter}
                onValueChange={(value) => {
                  updateListParams({
                    ownerId: value,
                    page: 1,
                  })
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('rooms.filters.allOwners')}</SelectItem>
                  {allUsers.map((roomUser) => (
                    <SelectItem key={roomUser.id} value={roomUser.id}>
                      {roomUser.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('rooms.filters.activeness')}</Label>
              <Select
                value={activenessFilter}
                onValueChange={(value) => {
                  updateListParams({
                    activeness: value as RoomActiveness,
                    page: 1,
                  })
                }}
              >
                <SelectTrigger className="h-9">
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
              <Label>{t('rooms.pagination.pageSize')}</Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  updateListParams({
                    pageSize: Number(value),
                    page: 1,
                  })
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-muted-foreground lg:pb-1 lg:text-right">
              {t('rooms.pagination.total', { count: pagination.total })}
            </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center items-center py-12">
            <Spinner size="lg" />
          </div>
        ) : rooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">{t('rooms.list.empty')}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                currentUser={user ?? undefined}
                onDelete={() => handleDeleteRoom(room.id, room.name)}
                onRename={() => handleRenameRoom(room.id, room.name)}
                onShare={() => handleShareRoom(room.id, room.name)}
                onTogglePin={() => handleTogglePin(room)}
                isPinUpdating={pinUpdatingRoomId === room.id}
                onPlayback={() => navigate(`/playback/${room.id}`)}
                onClick={() => navigate(`/room/${room.id}`)}
              />
            ))}
          </div>
        )}

        {!isLoading && pagination.totalPages > 0 && (
          <div className="mt-4 flex items-center justify-center gap-2">
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
          </div>
        )}
      </PageContainer>
    </div>
  )
}

interface RoomCardProps {
  room: Room
  currentUser?: User
  onDelete: () => void
  onRename: () => void
  onShare: () => void
  onTogglePin: () => void
  isPinUpdating: boolean
  onPlayback: () => void
  onClick: () => void
}

function RoomCard({
  room,
  currentUser,
  onDelete,
  onRename,
  onShare,
  onTogglePin,
  isPinUpdating,
  onPlayback,
  onClick,
}: RoomCardProps) {
  const { t } = useTranslation()

  const isOwner = room.ownerId === currentUser?.id
  const isPrivileged = currentUser?.role === 'admin' || currentUser?.role === 'superuser' ||
    currentUser?.canReadAllRooms || currentUser?.canWriteAllRooms || currentUser?.canDeleteAllRooms
  const canManageRoom = isOwner || currentUser?.role === 'superuser' || currentUser?.canDeleteAllRooms
  const canRenameRoom = isOwner || currentUser?.role === 'superuser'
  const canPinRoom = currentUser?.role === 'admin' || currentUser?.role === 'superuser'
  const participantCount = (room.participants?.length ?? 0) + 1
  const canViewPlayback = room.isEnded && (isOwner || isPrivileged)

  const handleOpen = () => {
    if (canViewPlayback) {
      onPlayback()
    } else {
      onClick()
    }
  }

  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors hover:border-primary/50 flex flex-col',
        room.isEnded && 'opacity-60'
      )}
      onClick={handleOpen}
    >
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium line-clamp-1">{room.name}</CardTitle>
          <Badge variant={room.isEnded ? 'secondary' : 'default'} className="shrink-0 text-xs px-1.5 py-0 rounded-sm">
            {room.language}
          </Badge>
        </div>
        <CardDescription className="flex items-center gap-1 text-xs">
          <span>{room.owner.username}</span>
          {room.isPinned && (
            <Badge variant="secondary" className="ml-1 text-xs px-1 py-0">
              {t('rooms.list.pinned')}
            </Badge>
          )}
          {canManageRoom && (
            <Badge variant="outline" className="ml-1 text-xs px-1 py-0">
              {isOwner ? t('rooms.list.owned') : t('rooms.list.manage')}
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 pt-0 flex flex-col flex-1">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground flex-1">
          {(room.company || room.position) && (
            <div className="truncate">
              {[room.company, room.position].filter(Boolean).join(' • ')}
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              <span>{participantCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{formatDate(room.createdAt)}</span>
            </div>
          </div>

          {room.scheduledTime && (
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              <span>{formatDate(room.scheduledTime)}</span>
              {room.duration && <span>• {room.duration} {t('rooms.list.durationUnit')}</span>}
            </div>
          )}

          {room.isEnded && (
            <Badge variant="destructive" className="w-fit text-xs px-1.5 py-0 rounded-sm">
              {t('rooms.list.ended')}
            </Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 mt-2 pt-2 border-t min-h-[36px]">
          {canManageRoom && !room.isEnded && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={(e) => {
                e.stopPropagation()
                onShare()
              }}
            >
              <Share2 className="h-3 w-3" />
            </Button>
          )}

          {canRenameRoom && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={(e) => {
                e.stopPropagation()
                onRename()
              }}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}

          {canPinRoom && (
            <Button
              variant={room.isPinned ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2"
              disabled={isPinUpdating}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin()
              }}
              title={room.isPinned ? t('rooms.list.unpin') : t('rooms.list.pin')}
            >
              {room.isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
            </Button>
          )}

          {room.isEnded && (isOwner || isPrivileged) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={(e) => {
                e.stopPropagation()
                onPlayback()
              }}
            >
              <Play className="h-3 w-3 mr-1" />
              <span className="text-xs">{t('rooms.list.viewPlayback')}</span>
            </Button>
          )}

          {canManageRoom && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
