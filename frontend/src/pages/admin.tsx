import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { useAuthStore } from '@/stores'
import { formatDate } from '@/lib/utils'
import type { User, Room, Role } from '@/types'

type PermissionState = {
  canReadAllRooms: boolean
  canWriteAllRooms: boolean
  canDeleteAllRooms: boolean
}

const ROLES: Role[] = ['user', 'admin', 'superuser']

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

  // Create user form
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<Role>('user')
  const [newPermissions, setNewPermissions] = useState<PermissionState>(getInitialPermissionsForRole('user'))
  const [isCreating, setIsCreating] = useState(false)

  // Edit tracking
  const [editedUsers, setEditedUsers] = useState<Map<string, { role: Role } & PermissionState>>(new Map())
  const [savingUserId, setSavingUserId] = useState<string | null>(null)

  const isSuperuser = user?.role === 'superuser'

  useEffect(() => {
    if (!user || (user.role !== 'admin' && user.role !== 'superuser')) {
      navigate('/rooms')
      return
    }
    loadUsers()
    loadRooms()
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

  const handleDeleteUser = async (userId: string, username: string) => {
    if (!confirm(t('admin.users.deleteConfirm', { username }))) return

    try {
      await api.deleteUser(userId)
      loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user')
    }
  }

  const handleDeleteRoom = async (roomId: string, roomName: string) => {
    if (!confirm(t('admin.rooms.deleteConfirm', { name: roomName }))) return

    try {
      await api.deleteRoomAdmin(roomId)
      loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
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
        {error && (
          <div className="mb-4 p-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>
        )}

        {/* Users Section */}
        <Card className="mb-8">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t('admin.users.title')}</CardTitle>
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
          <CardContent>
            {isLoadingUsers ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2 font-medium">{t('admin.users.table.username')}</th>
                      <th className="p-2 font-medium">{t('admin.users.table.email')}</th>
                      <th className="p-2 font-medium">{t('admin.users.table.role')}</th>
                      <th className="p-2 font-medium">{t('admin.users.table.created')}</th>
                      <th className="p-2 font-medium">{t('admin.users.table.actions')}</th>
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
                          <td className="p-2">{u.username}</td>
                          <td className="p-2 text-muted-foreground">{u.email ?? '-'}</td>
                          <td className="p-2">
                            {isSuperuser && u.id !== user?.id ? (
                              <Select
                                value={edits?.role ?? u.role}
                                onValueChange={(v) => updateEditedUser(u.id, { role: v as Role })}
                              >
                                <SelectTrigger className="w-32 h-8">
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
                              <Badge variant="secondary">{roleDisplay(u.role)}</Badge>
                            )}
                          </td>
                          <td className="p-2 text-muted-foreground">{formatDate(u.createdAt ?? '')}</td>
                          <td className="p-2">
                            <div className="flex items-center gap-2">
                              {hasChanges(u.id) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleUpdateUser(u.id)}
                                  disabled={savingUserId === u.id}
                                >
                                  <Save className="h-3 w-3 mr-1" />
                                  {savingUserId === u.id ? t('admin.users.table.updating') : t('admin.users.table.update')}
                                </Button>
                              )}
                              {canDelete && (
                                <Button
                                  size="sm"
                                  variant="destructive"
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

        {/* Rooms Section */}
        <Card>
          <CardHeader>
            <CardTitle>{t('admin.rooms.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingRooms ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2 font-medium">{t('admin.rooms.table.name')}</th>
                      <th className="p-2 font-medium">{t('admin.rooms.table.owner')}</th>
                      <th className="p-2 font-medium">{t('admin.rooms.table.language')}</th>
                      <th className="p-2 font-medium">{t('admin.rooms.table.status')}</th>
                      <th className="p-2 font-medium">{t('admin.rooms.table.created')}</th>
                      <th className="p-2 font-medium">{t('admin.rooms.table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((room) => (
                      <tr key={room.id} className="border-b">
                        <td className="p-2">{room.name}</td>
                        <td className="p-2 text-muted-foreground">{room.owner.username}</td>
                        <td className="p-2">
                          <Badge variant="secondary">{room.language}</Badge>
                        </td>
                        <td className="p-2">
                          <Badge variant={room.isEnded ? 'destructive' : 'success'}>
                            {room.isEnded ? t('admin.rooms.table.statusEnded') : t('admin.rooms.table.statusActive')}
                          </Badge>
                        </td>
                        <td className="p-2 text-muted-foreground">{formatDate(room.createdAt)}</td>
                        <td className="p-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDeleteRoom(room.id, room.name)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </PageContainer>
    </div>
  )
}
