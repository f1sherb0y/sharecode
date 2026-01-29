import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Spinner,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { formatDate, formatDateTime } from '@/lib/utils'
import type { User, Room, Role, DbStorageSize, RoomPlaybackSize } from '@/types'

type PermissionState = {
  canReadAllRooms: boolean
  canWriteAllRooms: boolean
  canDeleteAllRooms: boolean
}

const ROLES: Role[] = ['user', 'admin', 'superuser']

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function getInitialPermissionsForRole(role: Role): PermissionState {
  if (role === 'superuser') {
    return { canReadAllRooms: true, canWriteAllRooms: true, canDeleteAllRooms: true }
  }
  if (role === 'admin') {
    return { canReadAllRooms: true, canWriteAllRooms: true, canDeleteAllRooms: false }
  }
  return { canReadAllRooms: false, canWriteAllRooms: false, canDeleteAllRooms: false }
}

export function AdminPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuthStore()

  const [users, setUsers] = useState<User[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [isLoadingUsers, setIsLoadingUsers] = useState(true)
  const [isLoadingRooms, setIsLoadingRooms] = useState(true)
  const [error, setError] = useState('')
  const [dbSize, setDbSize] = useState<DbStorageSize | null>(null)
  const [playbackSizes, setPlaybackSizes] = useState<RoomPlaybackSize[]>([])
  const [isLoadingStorage, setIsLoadingStorage] = useState(true)
  const [isLoadingPlaybackSizes, setIsLoadingPlaybackSizes] = useState(true)
  const [storageNotice, setStorageNotice] = useState('')

  // Create user form
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('user')
  const [newPermissions, setNewPermissions] = useState<PermissionState>(getInitialPermissionsForRole('user'))
  const [isCreating, setIsCreating] = useState(false)

  // Delete states
  const [userToDelete, setUserToDelete] = useState<{ id: string; username: string } | null>(null)
  const [roomToDelete, setRoomToDelete] = useState<{ id: string; name: string } | null>(null)
  const [roomToCompress, setRoomToCompress] = useState<RoomPlaybackSize | null>(null)

  // Edit tracking
  const [editedUsers, setEditedUsers] = useState<Map<string, { role: Role } & PermissionState>>(new Map())
  const [savingUserId, setSavingUserId] = useState<string | null>(null)
  const [compressingRoomId, setCompressingRoomId] = useState<string | null>(null)

  const isSuperuser = user?.role === 'superuser'

  useEffect(() => {
    if (!user || (user.role !== 'admin' && user.role !== 'superuser')) {
      navigate('/rooms')
      return
    }
    loadUsers()
    if (user.role === 'superuser') {
      loadRooms()
      loadStorage()
      loadPlaybackSizes()
    } else {
      setIsLoadingRooms(false)
      setIsLoadingStorage(false)
      setIsLoadingPlaybackSizes(false)
    }
  }, [user, navigate])

  const loadUsers = async () => {
    try {
      setIsLoadingUsers(true)
      const { users } = await api.getAllUsers()
      setUsers(users)
      // Initialize edit state
      const editMap = new Map<string, { role: Role } & PermissionState>()
      users.forEach((u) => {
        editMap.set(u.id, {
          role: u.role,
          canReadAllRooms: u.canReadAllRooms,
          canWriteAllRooms: u.canWriteAllRooms,
          canDeleteAllRooms: u.canDeleteAllRooms,
        })
      })
      setEditedUsers(editMap)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setIsLoadingUsers(false)
    }
  }

  const loadRooms = async () => {
    try {
      setIsLoadingRooms(true)
      const { rooms } = await api.getAllRoomsAdmin()
      setRooms(rooms)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms')
    } finally {
      setIsLoadingRooms(false)
    }
  }

  const loadStorage = async () => {
    try {
      setIsLoadingStorage(true)
      const size = await api.getDbStorageSize()
      setDbSize(size)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load storage size')
    } finally {
      setIsLoadingStorage(false)
    }
  }

  const loadPlaybackSizes = async () => {
    try {
      setIsLoadingPlaybackSizes(true)
      const { rooms } = await api.getRoomPlaybackSizes()
      setPlaybackSizes(rooms)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playback storage')
    } finally {
      setIsLoadingPlaybackSizes(false)
    }
  }

  const refreshStorage = async () => {
    setStorageNotice('')
    await Promise.all([loadRooms(), loadStorage(), loadPlaybackSizes()])
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsCreating(true)
    setError('')

    try {
      await api.createUser({
        username: newUsername,
        password: newPassword,
        email: newEmail || undefined,
        role: newRole,
        ...newPermissions,
      })
      setIsCreateOpen(false)
      setNewUsername('')
      setNewPassword('')
      setNewEmail('')
      setNewRole('user')
      setNewPermissions(getInitialPermissionsForRole('user'))
      loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setIsCreating(false)
    }
  }

  const handleUpdateUser = async (userId: string) => {
    const edits = editedUsers.get(userId)
    const original = users.find((u) => u.id === userId)
    if (!edits || !original) return

    const payload: Partial<{ role: Role } & PermissionState> = {}
    if (edits.role !== original.role) payload.role = edits.role
    if (edits.canReadAllRooms !== original.canReadAllRooms) payload.canReadAllRooms = edits.canReadAllRooms
    if (edits.canWriteAllRooms !== original.canWriteAllRooms) payload.canWriteAllRooms = edits.canWriteAllRooms
    if (edits.canDeleteAllRooms !== original.canDeleteAllRooms) payload.canDeleteAllRooms = edits.canDeleteAllRooms

    if (Object.keys(payload).length === 0) return

    setSavingUserId(userId)
    try {
      await api.updateUser(userId, payload)
      loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user')
    } finally {
      setSavingUserId(null)
    }
  }

  const handleDeleteUser = (userId: string, username: string) => {
    setUserToDelete({ id: userId, username })
  }

  const confirmDeleteUser = async () => {
    if (!userToDelete) return
    try {
      await api.deleteUser(userToDelete.id)
      setUserToDelete(null)
      loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user')
    }
  }

  const handleDeleteRoom = (roomId: string, roomName: string) => {
    setRoomToDelete({ id: roomId, name: roomName })
  }

  const confirmDeleteRoom = async () => {
    if (!roomToDelete) return
    try {
      await api.deleteRoomAdmin(roomToDelete.id)
      setRoomToDelete(null)
      loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
    }
  }

  const confirmCompressRoom = async () => {
    if (!roomToCompress) return
    setCompressingRoomId(roomToCompress.id)
    setStorageNotice('')
    try {
      const result = await api.compressRoomPlayback(roomToCompress.id)
      const saved = formatBytes(result.savedBytes)
      setStorageNotice(
        t('admin.storage.compressResult', {
          name: roomToCompress.name,
          saved,
          original: result.originalUpdates,
          compressed: result.compressedUpdates,
        })
      )
      setRoomToCompress(null)
      await Promise.all([loadStorage(), loadPlaybackSizes()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compress playback data')
    } finally {
      setCompressingRoomId(null)
    }
  }

  const updateEditedUser = (userId: string, updates: Partial<{ role: Role } & PermissionState>) => {
    setEditedUsers((prev) => {
      const newMap = new Map(prev)
      const current = newMap.get(userId)
      if (current) {
        newMap.set(userId, { ...current, ...updates })
      }
      return newMap
    })
  }

  const hasChanges = (userId: string): boolean => {
    const edits = editedUsers.get(userId)
    const original = users.find((u) => u.id === userId)
    if (!edits || !original) return false

    return (
      edits.role !== original.role ||
      edits.canReadAllRooms !== original.canReadAllRooms ||
      edits.canWriteAllRooms !== original.canWriteAllRooms ||
      edits.canDeleteAllRooms !== original.canDeleteAllRooms
    )
  }

  const roleDisplay = (role: Role) => {
    switch (role) {
      case 'superuser':
        return t('common.superuser')
      case 'admin':
        return t('common.admin')
      default:
        return t('admin.users.createForm.roleUser')
    }
  }

  const playbackByRoomId = useMemo(() => {
    const map = new Map<string, RoomPlaybackSize>()
    playbackSizes.forEach((room) => {
      map.set(room.id, room)
    })
    return map
  }, [playbackSizes])

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar
        leftContent={
          <Button variant="ghost" onClick={() => navigate('/rooms')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('admin.backToRooms')}
          </Button>
        }
        title={null}
        centerContent={<span className="font-semibold">{t('admin.title')}</span>}
      />

      <PageContainer>
        {/* Delete User Dialog */}
        <Dialog open={!!userToDelete} onOpenChange={(open) => !open && setUserToDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.users.deleteTitle', 'Delete User')}</DialogTitle>
              <DialogDescription>
                {t('admin.users.deleteConfirm', { username: userToDelete?.username })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUserToDelete(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" onClick={confirmDeleteUser}>
                {t('common.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Room Dialog */}
        <Dialog open={!!roomToDelete} onOpenChange={(open) => !open && setRoomToDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.rooms.deleteTitle', 'Delete Room')}</DialogTitle>
              <DialogDescription>
                {t('admin.rooms.deleteConfirm', { name: roomToDelete?.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRoomToDelete(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" onClick={confirmDeleteRoom}>
                {t('common.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Compress Playback Dialog */}
        <Dialog open={!!roomToCompress} onOpenChange={(open) => !open && setRoomToCompress(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.storage.compressTitle')}</DialogTitle>
              <DialogDescription>
                {t('admin.storage.compressConfirm', { name: roomToCompress?.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRoomToCompress(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="default"
                onClick={confirmCompressRoom}
                disabled={compressingRoomId === roomToCompress?.id}
              >
                {compressingRoomId === roomToCompress?.id
                  ? t('admin.storage.compressing')
                  : t('admin.storage.compressButton')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {error && (
          <div className="mb-4 p-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
        )}

        {/* Users Section */}
        <Card className="mb-6">
          <CardHeader className="py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('admin.users.title')}</CardTitle>
              <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-1" />
                    {t('admin.users.createButton')}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <form onSubmit={handleCreateUser}>
                    <DialogHeader>
                      <DialogTitle>{t('admin.users.createForm.title')}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="space-y-2">
                        <Label>{t('admin.users.createForm.username')}</Label>
                        <Input
                          value={newUsername}
                          onChange={(e) => setNewUsername(e.target.value)}
                          placeholder={t('admin.users.createForm.usernamePlaceholder')}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('admin.users.createForm.password')}</Label>
                        <Input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={t('admin.users.createForm.passwordPlaceholder')}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('admin.users.createForm.email')}</Label>
                        <Input
                          type="email"
                          value={newEmail}
                          onChange={(e) => setNewEmail(e.target.value)}
                          placeholder={t('admin.users.createForm.emailPlaceholder')}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('admin.users.createForm.role')}</Label>
                        <Select
                          value={newRole}
                          onValueChange={(v) => {
                            setNewRole(v as Role)
                            setNewPermissions(getInitialPermissionsForRole(v as Role))
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(isSuperuser ? ROLES : (['user'] as Role[])).map((role) => (
                              <SelectItem key={role} value={role}>
                                {roleDisplay(role)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                        {t('admin.users.cancelButton')}
                      </Button>
                      <Button type="submit" disabled={isCreating}>
                        {isCreating ? t('admin.users.createForm.creating') : t('admin.users.createForm.createButton')}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="pt-0 px-2 sm:px-6">
            {isLoadingUsers ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : (
              <div className="overflow-x-auto -mx-2 sm:mx-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-2 py-1.5 font-medium">{t('admin.users.table.username')}</th>
                      <th className="px-2 py-1.5 font-medium hidden sm:table-cell">{t('admin.users.table.email')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('admin.users.table.role')}</th>
                      <th className="px-2 py-1.5 font-medium hidden md:table-cell">{t('admin.users.table.created')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('admin.users.table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const edits = editedUsers.get(u.id)
                      const canDelete = isSuperuser
                        ? u.id !== user?.id && u.role !== 'superuser'
                        : u.role === 'user'

                      return (
                        <tr key={u.id} className="border-b">
                          <td className="px-2 py-1.5">
                            <div>{u.username}</div>
                            <div className="text-xs text-muted-foreground sm:hidden">{u.email ?? '-'}</div>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground hidden sm:table-cell">{u.email ?? '-'}</td>
                          <td className="px-2 py-1.5">
                            {isSuperuser && u.id !== user?.id ? (
                              <Select
                                value={edits?.role ?? u.role}
                                onValueChange={(v) => updateEditedUser(u.id, { role: v as Role })}
                              >
                                <SelectTrigger className="w-24 sm:w-28 h-7 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ROLES.map((role) => (
                                    <SelectItem key={role} value={role}>
                                      {roleDisplay(role)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant="secondary" className="rounded-sm text-xs px-1.5 py-0">{roleDisplay(u.role)}</Badge>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground hidden md:table-cell">{formatDate(u.createdAt ?? '')}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1">
                              {hasChanges(u.id) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => handleUpdateUser(u.id)}
                                  disabled={savingUserId === u.id}
                                >
                                  <Save className="h-3 w-3 sm:mr-1" />
                                  <span className="hidden sm:inline">{savingUserId === u.id ? t('admin.users.table.updating') : t('admin.users.table.update')}</span>
                                </Button>
                              )}
                              {canDelete && (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 px-2"
                                  onClick={() => handleDeleteUser(u.id, u.username)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Rooms + Storage Section */}
        {isSuperuser ? (
          <Card>
            <CardHeader className="py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{t('admin.rooms.title')}</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refreshStorage}
                  disabled={isLoadingRooms || isLoadingStorage || isLoadingPlaybackSizes}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {t('admin.storage.refresh')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0 px-2 sm:px-6">
              {isLoadingRooms || isLoadingStorage || isLoadingPlaybackSizes ? (
                <div className="flex justify-center py-6">
                  <Spinner />
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-4">
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.dbSize')}</div>
                      <div className="text-lg font-semibold">{dbSize?.pretty ?? '--'}</div>
                      {dbSize && (
                        <div className="text-xs text-muted-foreground">{formatBytes(dbSize.bytes)}</div>
                      )}
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.playbackTotal')}</div>
                      <div className="text-lg font-semibold">
                        {formatBytes(playbackSizes.reduce((sum, room) => sum + room.bytes, 0))}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('admin.storage.roomsTracked', { count: playbackSizes.length })}
                      </div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.endedRooms')}</div>
                      <div className="text-lg font-semibold">
                        {playbackSizes.filter((room) => room.isEnded).length}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('admin.storage.totalUpdates', {
                          count: playbackSizes.reduce((sum, room) => sum + room.updateCount, 0),
                        })}
                      </div>
                    </div>
                  </div>

                  {storageNotice && (
                    <div className="mb-3 text-xs text-muted-foreground">{storageNotice}</div>
                  )}

                  <div className="overflow-x-auto -mx-2 sm:mx-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="px-2 py-1.5 font-medium">{t('admin.rooms.table.name')}</th>
                          <th className="px-2 py-1.5 font-medium hidden sm:table-cell">{t('admin.rooms.table.owner')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('admin.rooms.table.language')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('admin.rooms.table.status')}</th>
                          <th className="px-2 py-1.5 font-medium hidden lg:table-cell">
                            {t('admin.storage.table.endedAt')}
                          </th>
                          <th className="px-2 py-1.5 font-medium hidden md:table-cell">
                            {t('admin.rooms.table.created')}
                          </th>
                          <th className="px-2 py-1.5 font-medium">{t('admin.storage.table.updates')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('admin.storage.table.size')}</th>
                          <th className="px-2 py-1.5 font-medium">{t('admin.storage.table.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rooms.map((room) => {
                          const playback = playbackByRoomId.get(room.id)
                          const updates = playback?.updateCount ?? 0
                          const sizeBytes = playback?.bytes ?? 0
                          const endedAt = playback?.endedAt ?? room.endedAt ?? null
                          const isEnded = playback?.isEnded ?? room.isEnded ?? false
                          const canCompress = isEnded && updates > 0

                          return (
                            <tr key={room.id} className="border-b">
                              <td className="px-2 py-1.5">
                                <div>{room.name}</div>
                                <div className="text-xs text-muted-foreground sm:hidden">{room.owner.username}</div>
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground hidden sm:table-cell">
                                {room.owner.username}
                              </td>
                              <td className="px-2 py-1.5">
                                <Badge variant="secondary" className="rounded-sm text-xs px-1.5 py-0">
                                  {room.language}
                                </Badge>
                              </td>
                              <td className="px-2 py-1.5">
                                <Badge
                                  variant={isEnded ? 'destructive' : 'success'}
                                  className="rounded-sm text-xs px-1.5 py-0"
                                >
                                  {isEnded ? t('admin.rooms.table.statusEnded') : t('admin.rooms.table.statusActive')}
                                </Badge>
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground hidden lg:table-cell">
                                {endedAt ? formatDateTime(endedAt) : '-'}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground hidden md:table-cell">
                                {formatDate(room.createdAt)}
                              </td>
                              <td className="px-2 py-1.5">{updates}</td>
                              <td className="px-2 py-1.5">{formatBytes(sizeBytes)}</td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2"
                                    disabled={!canCompress || compressingRoomId === room.id}
                                    onClick={() =>
                                      setRoomToCompress({
                                        id: room.id,
                                        name: room.name,
                                        isEnded,
                                        endedAt,
                                        updateCount: updates,
                                        bytes: sizeBytes,
                                      })
                                    }
                                  >
                                    {compressingRoomId === room.id
                                      ? t('admin.storage.compressing')
                                      : t('admin.storage.compressButton')}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    className="h-7 px-2"
                                    onClick={() => handleDeleteRoom(room.id, room.name)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-base">{t('admin.rooms.title')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 px-2 sm:px-6">
              <p className="text-sm text-muted-foreground">{t('admin.rooms.superuserOnly')}</p>
            </CardContent>
          </Card>
        )}
      </PageContainer>
    </div>
  )
}
