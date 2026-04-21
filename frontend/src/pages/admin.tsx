import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  Checkbox,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { canDeleteRoom } from '@/lib/room-permissions'
import { validatePasswordPolicy } from '@/lib/password-policy'
import { queryKeys } from '@/lib/query-keys'
import { useAuthStore } from '@/stores'
import { formatDate, formatDateTime } from '@/lib/utils'
import type { Role, RoomPlaybackSize } from '@/types'

type PermissionState = {
  canReadAllRooms: boolean
  canWriteAllRooms: boolean
  canDeleteAllRooms: boolean
}

const ROLES: Role[] = ['user', 'admin', 'superuser']
const ADMIN_SECTIONS = ['all', 'users', 'rooms'] as const
const ROOM_STATUS_FILTERS = ['all', 'active', 'ended'] as const

type AdminSection = (typeof ADMIN_SECTIONS)[number]
type RoomStatusFilter = (typeof ROOM_STATUS_FILTERS)[number]
type UserRoleFilter = Role | 'all'

function parseAdminSection(value: string | null): AdminSection {
  return ADMIN_SECTIONS.includes((value ?? '') as AdminSection) ? (value as AdminSection) : 'all'
}

function parseUserRoleFilter(value: string | null): UserRoleFilter {
  if (value === 'all') return 'all'
  return ROLES.includes((value ?? '') as Role) ? (value as Role) : 'all'
}

function parseRoomStatusFilter(value: string | null): RoomStatusFilter {
  return ROOM_STATUS_FILTERS.includes((value ?? '') as RoomStatusFilter)
    ? (value as RoomStatusFilter)
    : 'all'
}

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
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuthStore()
  const section = parseAdminSection(searchParams.get('section'))
  const userRoleFilter = parseUserRoleFilter(searchParams.get('userRole'))
  const roomStatusFilter = parseRoomStatusFilter(searchParams.get('roomStatus'))

  const [error, setError] = useState('')
  const [storageNotice, setStorageNotice] = useState('')

  // Create user form
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('user')
  const [newPermissions, setNewPermissions] = useState<PermissionState>(getInitialPermissionsForRole('user'))
  const isNewPasswordValid = validatePasswordPolicy(newPassword)

  // Delete states
  const [userToDelete, setUserToDelete] = useState<{ id: string; username: string } | null>(null)
  const [roomToDelete, setRoomToDelete] = useState<{ id: string; name: string } | null>(null)
  const [roomToCompress, setRoomToCompress] = useState<RoomPlaybackSize | null>(null)

  // Edit tracking
  const [editedUsers, setEditedUsers] = useState<Map<string, { role: Role } & PermissionState>>(new Map())
  const [savingUserId, setSavingUserId] = useState<string | null>(null)
  const [compressingRoomId, setCompressingRoomId] = useState<string | null>(null)

  const isSuperuser = user?.role === 'superuser'
  const isAdmin = user?.role === 'admin'
  const showUsersSection = section === 'all' || section === 'users'
  const showRoomsSection = section === 'all' || section === 'rooms'
  const canAccessAdmin = !!user && (user.role === 'admin' || user.role === 'superuser')

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: async () => {
      const { users } = await api.getAllUsers()
      return users
    },
    enabled: canAccessAdmin,
  })

  const roomsQuery = useQuery({
    queryKey: queryKeys.adminRooms,
    queryFn: async () => {
      const { rooms } = await api.getAllRoomsAdmin()
      return rooms
    },
    enabled: canAccessAdmin,
  })

  const dbSizeQuery = useQuery({
    queryKey: queryKeys.adminDbSize,
    queryFn: () => api.getDbStorageSize(),
    enabled: !!user && user.role === 'superuser',
  })

  const playbackSizesQuery = useQuery({
    queryKey: queryKeys.adminPlaybackSizes,
    queryFn: async () => {
      const { rooms } = await api.getRoomPlaybackSizes()
      return rooms
    },
    enabled: !!user && user.role === 'superuser',
  })

  const createUserMutation = useMutation({
    mutationFn: (payload: {
      username: string
      password: string
      email?: string
      role?: Role
      canReadAllRooms?: boolean
      canWriteAllRooms?: boolean
      canDeleteAllRooms?: boolean
    }) => api.createUser(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
      setIsCreateOpen(false)
      setNewUsername('')
      setNewPassword('')
      setNewEmail('')
      setNewRole('user')
      setNewPermissions(getInitialPermissionsForRole('user'))
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: Partial<{ role: Role } & PermissionState> }) =>
      api.updateUser(userId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: (userId: string) => api.deleteUser(userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
      setUserToDelete(null)
    },
  })

  const deleteRoomMutation = useMutation({
    mutationFn: (roomId: string) => api.deleteRoomAdmin(roomId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.adminRooms }),
        queryClient.invalidateQueries({ queryKey: ['rooms'] }),
      ])
      setRoomToDelete(null)
    },
  })

  const compressPlaybackMutation = useMutation({
    mutationFn: (roomId: string) => api.compressRoomPlayback(roomId),
  })

  const users = usersQuery.data ?? []
  const rooms = roomsQuery.data ?? []
  const dbSize = dbSizeQuery.data ?? null
  const playbackSizes = playbackSizesQuery.data ?? []
  const isLoadingUsers = usersQuery.isLoading
  const isLoadingRooms = roomsQuery.isLoading
  const isLoadingStorage = isSuperuser ? dbSizeQuery.isLoading : false
  const isLoadingPlaybackSizes = isSuperuser ? playbackSizesQuery.isLoading : false

  const updateAdminParams = useCallback((updates: {
    section?: AdminSection
    userRole?: UserRoleFilter
    roomStatus?: RoomStatusFilter
  }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('section', updates.section ?? section)
      next.set('userRole', updates.userRole ?? userRoleFilter)
      next.set('roomStatus', updates.roomStatus ?? roomStatusFilter)
      return next
    })
  }, [setSearchParams, section, userRoleFilter, roomStatusFilter])

  useEffect(() => {
    const normalized = new URLSearchParams(searchParams)
    let changed = false

    if (normalized.get('section') !== section) {
      normalized.set('section', section)
      changed = true
    }
    if (normalized.get('userRole') !== userRoleFilter) {
      normalized.set('userRole', userRoleFilter)
      changed = true
    }
    if (normalized.get('roomStatus') !== roomStatusFilter) {
      normalized.set('roomStatus', roomStatusFilter)
      changed = true
    }

    if (changed) {
      setSearchParams(normalized, { replace: true })
    }
  }, [searchParams, section, userRoleFilter, roomStatusFilter, setSearchParams])

  useEffect(() => {
    if (!canAccessAdmin) {
      navigate('/rooms')
    }
  }, [canAccessAdmin, navigate])

  useEffect(() => {
    if (users.length === 0) {
      setEditedUsers(new Map())
      return
    }

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
  }, [users])

  useEffect(() => {
    const queryError =
      usersQuery.error ?? roomsQuery.error ?? dbSizeQuery.error ?? playbackSizesQuery.error
    if (queryError instanceof Error) {
      setError(queryError.message)
    }
  }, [usersQuery.error, roomsQuery.error, dbSizeQuery.error, playbackSizesQuery.error])

  const refreshStorage = async () => {
    setStorageNotice('')
    const tasks = [
      queryClient.invalidateQueries({ queryKey: queryKeys.adminRooms }),
    ]
    if (isSuperuser) {
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.adminDbSize }))
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.adminPlaybackSizes }))
    }
    await Promise.all(tasks)
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isNewPasswordValid) {
      setError(t('common.passwordPolicyError'))
      return
    }

    try {
      await createUserMutation.mutateAsync({
        username: newUsername,
        password: newPassword,
        email: newEmail || undefined,
        role: newRole,
        ...newPermissions,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
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
      setError('')
      await updateUserMutation.mutateAsync({ userId, payload })
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
      setError('')
      await deleteUserMutation.mutateAsync(userToDelete.id)
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
      setError('')
      await deleteRoomMutation.mutateAsync(roomToDelete.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
    }
  }

  const confirmCompressRoom = async () => {
    if (!roomToCompress) return
    setCompressingRoomId(roomToCompress.id)
    setStorageNotice('')
    try {
      const result = await compressPlaybackMutation.mutateAsync(roomToCompress.id)
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.adminDbSize }),
        queryClient.invalidateQueries({ queryKey: queryKeys.adminPlaybackSizes }),
      ])
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

  const filteredUsers = useMemo(() => {
    if (userRoleFilter === 'all') return users
    return users.filter((u) => u.role === userRoleFilter)
  }, [users, userRoleFilter])

  const filteredRooms = useMemo(() => {
    if (roomStatusFilter === 'all') return rooms
    const ended = roomStatusFilter === 'ended'
    return rooms.filter((room) => !!room.isEnded === ended)
  }, [rooms, roomStatusFilter])

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
              <Button variant="destructive" onClick={confirmDeleteRoom} disabled={deleteRoomMutation.isPending}>
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

        <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:max-w-3xl">
          <div className="space-y-1">
            <Label>View</Label>
            <Select
              value={section}
              onValueChange={(value) => updateAdminParams({ section: value as AdminSection })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="users">{t('admin.users.title')}</SelectItem>
                <SelectItem value="rooms">{t('admin.rooms.title')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('admin.users.table.role')}</Label>
            <Select
              value={userRoleFilter}
              onValueChange={(value) => updateAdminParams({ userRole: value as UserRoleFilter })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {roleDisplay(role)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('admin.rooms.table.status')}</Label>
            <Select
              value={roomStatusFilter}
              onValueChange={(value) => updateAdminParams({ roomStatus: value as RoomStatusFilter })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="active">{t('admin.rooms.table.statusActive')}</SelectItem>
                <SelectItem value="ended">{t('admin.rooms.table.statusEnded')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Users Section */}
        {showUsersSection && (
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
                          minLength={10}
                          required
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('common.passwordPolicyHint')}
                        </p>
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
                      <Button type="submit" disabled={createUserMutation.isPending}>
                        {createUserMutation.isPending ? t('admin.users.createForm.creating') : t('admin.users.createForm.createButton')}
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
                      <th className="px-2 py-1.5 font-medium text-center w-12">{t('admin.users.table.read')}</th>
                      <th className="px-2 py-1.5 font-medium text-center w-12">{t('admin.users.table.write')}</th>
                      <th className="px-2 py-1.5 font-medium text-center w-12">{t('admin.users.table.delete')}</th>
                      <th className="px-2 py-1.5 font-medium hidden md:table-cell">{t('admin.users.table.created')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('admin.users.table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
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
                          <td className="px-2 py-1.5 text-center">
                            <Checkbox
                              checked={edits?.canReadAllRooms ?? u.canReadAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canReadAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <Checkbox
                              checked={edits?.canWriteAllRooms ?? u.canWriteAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canWriteAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <Checkbox
                              checked={edits?.canDeleteAllRooms ?? u.canDeleteAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canDeleteAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
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
                    {filteredUsers.length === 0 && (
                      <tr>
                        <td className="px-2 py-3 text-center text-muted-foreground" colSpan={8}>
                          {t('rooms.list.empty')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* Rooms + Storage Section */}
        {showRoomsSection && (isSuperuser || isAdmin) ? (
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
                  {isSuperuser && (
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
                  )}

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
                        {filteredRooms.map((room) => {
                          const playback = playbackByRoomId.get(room.id)
                          const updates = playback?.updateCount ?? 0
                          const sizeBytes = playback?.bytes ?? 0
                          const endedAt = playback?.endedAt ?? room.endedAt ?? null
                          const isEnded = playback?.isEnded ?? room.isEnded ?? false
                          const canCompress = isEnded && updates > 0
                          const canDeleteCurrentRoom = canDeleteRoom(user, room.owner.id)

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
                                  {canDeleteCurrentRoom && (
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-7 px-2"
                                      onClick={() => handleDeleteRoom(room.id, room.name)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        {filteredRooms.length === 0 && (
                          <tr>
                            <td className="px-2 py-3 text-center text-muted-foreground" colSpan={9}>
                              {t('rooms.list.empty')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : showRoomsSection ? (
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-base">{t('admin.rooms.title')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 px-2 sm:px-6">
              <p className="text-sm text-muted-foreground">{t('admin.rooms.superuserOnly')}</p>
            </CardContent>
          </Card>
        ) : null}
      </PageContainer>
    </div>
  )
}
