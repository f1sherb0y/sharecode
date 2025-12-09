import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Users, Clock, Trash2, Play, Calendar, Share2 } from 'lucide-react'
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
import type { Room, Language, User } from '@/types'

const LANGUAGES: Language[] = ['javascript', 'typescript', 'python', 'java', 'cpp', 'rust', 'go', 'php']

export function RoomsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuthStore()

  const [rooms, setRooms] = useState<Room[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  // Create room form state
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomLanguage, setNewRoomLanguage] = useState<Language>('javascript')
  const [scheduledTime, setScheduledTime] = useState('')
  const [duration, setDuration] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // User selection for room access
  const [availableUsers, setAvailableUsers] = useState<User[]>([])
  const [selectedUsers, setSelectedUsers] = useState<Array<{ userId: string; canEdit: boolean }>>([])

  useEffect(() => {
    loadRooms()
    loadUsers()
  }, [])

  const loadRooms = async () => {
    try {
      setIsLoading(true)
      const { rooms } = await api.getRooms()
      // Sort: active rooms first, then by creation date
      const sorted = rooms.sort((a, b) => {
        if (a.isEnded !== b.isEnded) return a.isEnded ? 1 : -1
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      })
      setRooms(sorted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms')
    } finally {
      setIsLoading(false)
    }
  }

  const loadUsers = async () => {
    try {
      const { users } = await api.getAllUsersForRoomCreation()
      setAvailableUsers(users.filter((u) => u.id !== user?.id))
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
        selectedUsers.length > 0 ? selectedUsers : undefined
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
    setScheduledTime('')
    setDuration('')
    setSelectedUsers([])
  }

  const handleDeleteRoom = async (roomId: string, roomName: string) => {
    if (!confirm(t('rooms.list.deleteConfirm', { name: roomName }))) return

    try {
      await api.deleteRoom(roomId)
      loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
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

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar
        title="ShareCode"
        rightContent={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
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
                <div className="grid gap-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="roomName">{t('rooms.create.name')}</Label>
                    <Input
                      id="roomName"
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      placeholder={t('rooms.create.namePlaceholder')}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('rooms.create.language')}</Label>
                    <Select value={newRoomLanguage} onValueChange={(v) => setNewRoomLanguage(v as Language)}>
                      <SelectTrigger>
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
                  <div className="space-y-2">
                    <Label htmlFor="scheduledTime">{t('rooms.create.scheduledTime')}</Label>
                    <Input
                      id="scheduledTime"
                      type="datetime-local"
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="duration">{t('rooms.create.duration')}</Label>
                    <Input
                      id="duration"
                      type="number"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      placeholder={t('rooms.create.durationPlaceholder')}
                      min="1"
                    />
                  </div>
                  {availableUsers.length > 0 && (
                    <div className="space-y-2">
                      <Label>{t('rooms.create.allowedUsers')}</Label>
                      <div className="border rounded-md max-h-40 overflow-y-auto">
                        {availableUsers.map((u) => {
                          const selected = selectedUsers.find((s) => s.userId === u.id)
                          return (
                            <div
                              key={u.id}
                              className={cn(
                                'flex items-center justify-between px-3 py-2 hover:bg-accent cursor-pointer',
                                selected && 'bg-accent/50'
                              )}
                              onClick={() => toggleUserSelection(u.id)}
                            >
                              <span className="text-sm">{u.username}</span>
                              {selected && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
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

      <PageContainer>
        {error && (
          <div className="mb-4 p-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
        )}

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
                currentUserId={user?.id}
                onDelete={() => handleDeleteRoom(room.id, room.name)}
                onPlayback={() => navigate(`/playback/${room.id}`)}
                onClick={() => navigate(`/room/${room.id}`)}
              />
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  )
}

interface RoomCardProps {
  room: Room
  currentUserId?: string
  onDelete: () => void
  onPlayback: () => void
  onClick: () => void
}

function RoomCard({ room, currentUserId, onDelete, onPlayback, onClick }: RoomCardProps) {
  const { t } = useTranslation()

  const isOwner = room.ownerId === currentUserId
  const participantCount = (room.participants?.length ?? 0) + 1

  return (
    <Card
      className={cn(
        'cursor-pointer transition-colors hover:border-primary/50',
        room.isEnded && 'opacity-60'
      )}
      onClick={onClick}
    >
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium line-clamp-1">{room.name}</CardTitle>
          <Badge variant={room.isEnded ? 'secondary' : 'default'} className="shrink-0 text-xs px-1.5 py-0">
            {room.language}
          </Badge>
        </div>
        <CardDescription className="flex items-center gap-1 text-xs">
          <span>{room.owner.username}</span>
          {isOwner && (
            <Badge variant="outline" className="ml-1 text-xs px-1 py-0">
              {t('rooms.list.owned')}
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
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
            <Badge variant="destructive" className="w-fit text-xs px-1.5 py-0">
              {t('rooms.list.ended')}
            </Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 mt-2 pt-2 border-t">
          {isOwner && !room.isEnded && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={(e) => {
                e.stopPropagation()
              }}
            >
              <Share2 className="h-3 w-3" />
            </Button>
          )}

          {room.isEnded && isOwner && (
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

          {isOwner && (
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
