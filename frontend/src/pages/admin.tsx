import { translateError } from '@/i18n/errors'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Tabs from '@radix-ui/react-tabs'
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
  Checkbox,
} from '@/components/ui'
import { Navbar, PageContainer } from '@/components/layout'
import { api } from '@/api'
import { canDeleteRoom } from '@/lib/room-permissions'
import { validatePasswordPolicy } from '@/lib/password-policy'
import { queryKeys } from '@/lib/query-keys'
import { useAuthStore } from '@/stores'
import { formatDate, formatDateTime } from '@/lib/utils'
import { LANGUAGES } from '@/types'
import type { Language, Role, RoomPlaybackSize, PaginationMeta } from '@/types'

type PermissionState = {
  canReadAllRooms: boolean
  canWriteAllRooms: boolean
  canDeleteAllRooms: boolean
}

const ROLES: Role[] = ['user', 'admin', 'superuser']
const ADMIN_SECTIONS = ['users', 'rooms'] as const
const ROOM_STATUS_FILTERS = ['all', 'active', 'ended'] as const

type AdminSection = (typeof ADMIN_SECTIONS)[number]
type RoomStatusFilter = (typeof ROOM_STATUS_FILTERS)[number]
type UserRoleFilter = Role | 'all'

function parseAdminSection(value: string | null): AdminSection {
  return ADMIN_SECTIONS.includes((value ?? '') as AdminSection) ? (value as AdminSection) : 'users'
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

const PAGE_SIZES = [10, 25, 50, 100]
const EMPTY_PAGE: PaginationMeta = { page: 1, pageSize: 25, total: 0, totalPages: 0, hasNext: false, hasPrev: false }
function parsePage(value: string | null) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && number <= 4294967295 ? number : 1
}
function AdminPagination({ pagination, disabled, onPage }: { pagination: PaginationMeta; disabled: boolean; onPage: (page: number) => void }) {
  const { t } = useTranslation()
  return <nav aria-label={t('admin.pagination.label')} className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs">
    <span className="text-muted-foreground">{t('admin.pagination.total', { count: pagination.total })}</span>
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" disabled={disabled || !pagination.hasPrev} onClick={() => onPage(pagination.page - 1)}>{t('rooms.pagination.prev')}</Button>
      <span aria-live="polite">{t('admin.pagination.page', { page: pagination.totalPages ? pagination.page : 0, total: pagination.totalPages })}</span>
      <Button size="sm" variant="outline" disabled={disabled || !pagination.hasNext} onClick={() => onPage(pagination.page + 1)}>{t('rooms.pagination.next')}</Button>
    </div>
  </nav>
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

function CreateUserDialog({
  open,
  onOpenChange,
  isSuperuser,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  isSuperuser: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [role, setRole] = useState<Role>('user')
  const [permissions, setPermissions] = useState<PermissionState>(getInitialPermissionsForRole('user'))
  const [error, setError] = useState('')

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
      onOpenChange(false)
    },
  })

  useEffect(() => {
    if (open) return
    setRole('user')
    setPermissions(getInitialPermissionsForRole('user'))
    setError('')
  }, [open])

  const roleLabel = (r: Role) => {
    switch (r) {
      case 'superuser':
        return t('common.superuser')
      case 'admin':
        return t('common.admin')
      default:
        return t('admin.users.createForm.roleUser')
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fields = new FormData(e.currentTarget)
    const username = String(fields.get('username') ?? '')
    const password = String(fields.get('password') ?? '')
    const email = String(fields.get('email') ?? '')
    setError('')

    if (!validatePasswordPolicy(password)) {
      setError(t('common.passwordPolicyError'))
      return
    }

    try {
      await createUserMutation.mutateAsync({
        username,
        password,
        email: email || undefined,
        role,
        ...permissions,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form id="create-user-form" method="post" autoComplete="on" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('admin.users.createForm.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <div className="space-y-1">
              <Label htmlFor="create-user-username">{t('admin.users.createForm.username')}</Label>
              <Input
                id="create-user-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('admin.users.createForm.usernamePlaceholder')}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-user-password">{t('admin.users.createForm.password')}</Label>
              <Input
                type="password"
                id="create-user-password"
                name="password"
                autoComplete="new-password"
                placeholder={t('admin.users.createForm.passwordPlaceholder')}
                minLength={10}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t('common.passwordPolicyHint')}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-user-email">{t('admin.users.createForm.email')}</Label>
              <Input
                type="email"
                id="create-user-email"
                name="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('admin.users.createForm.emailPlaceholder')}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('admin.users.createForm.role')}</Label>
              <Select
                value={role}
                onValueChange={(v) => {
                  const nextRole = v as Role
                  setRole(nextRole)
                  setPermissions(getInitialPermissionsForRole(nextRole))
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(isSuperuser ? ROLES : (['user'] as Role[])).map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-destructive">{translateError(error)}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('admin.users.cancelButton')}
            </Button>
            <Button type="submit" disabled={createUserMutation.isPending}>
              {createUserMutation.isPending
                ? t('admin.users.createForm.creating')
                : t('admin.users.createForm.createButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
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
  const userPage = parsePage(searchParams.get('userPage'))
  const roomPage = parsePage(searchParams.get('roomPage'))
  const pageSize = PAGE_SIZES.includes(Number(searchParams.get('pageSize'))) ? Number(searchParams.get('pageSize')) : 25
  const roomLanguage = LANGUAGES.includes(searchParams.get('language') as Language) ? searchParams.get('language')! : 'all'
  const searchKey = section === 'users' ? 'userSearch' : 'roomSearch'
  const search = searchParams.get(searchKey) ?? ''
  const ownerSearch = searchParams.get('owner') ?? ''
  const [searchDraft, setSearchDraft] = useState(search)
  const [ownerDraft, setOwnerDraft] = useState(ownerSearch)
  useEffect(() => { setSearchDraft(search) }, [search, section])
  useEffect(() => { setOwnerDraft(ownerSearch) }, [ownerSearch])

  const [error, setError] = useState('')
  const [storageNotice, setStorageNotice] = useState('')

  const [isCreateOpen, setIsCreateOpen] = useState(false)

  // Delete states
  const [userToDelete, setUserToDelete] = useState<{ id: string; username: string } | null>(null)
  const [roomToDelete, setRoomToDelete] = useState<{ id: string; name: string } | null>(null)
  const [roomToCompress, setRoomToCompress] = useState<RoomPlaybackSize | null>(null)

  // Pending edits: per-user diff of fields the admin has touched but not yet saved.
  // Source of truth for current values is the query cache; this map holds only user intent.
  const [pendingEdits, setPendingEdits] = useState<Map<string, Partial<{ role: Role } & PermissionState>>>(new Map())
  const [savingUserId, setSavingUserId] = useState<string | null>(null)
  const [compressingRoomId, setCompressingRoomId] = useState<string | null>(null)

  const isSuperuser = user?.role === 'superuser'
  const isAdmin = user?.role === 'admin'
  const showUsersSection = section === 'users'
  const showRoomsSection = section === 'rooms'
  const canAccessAdmin = !!user && (user.role === 'admin' || user.role === 'superuser')

  const usersParams = { page: userPage, pageSize, role: userRoleFilter, q: searchParams.get('userSearch') ?? '' }
  const roomsParams = { page: roomPage, pageSize, status: roomStatusFilter, language: roomLanguage, owner: ownerSearch, q: searchParams.get('roomSearch') ?? '' }
  const usersQuery = useQuery({
    queryKey: [...queryKeys.adminUsers, usersParams],
    queryFn: ({ signal }) => api.getAdminUsers(usersParams, signal),
    enabled: canAccessAdmin && showUsersSection,
  })
  const roomsQuery = useQuery({
    queryKey: [...queryKeys.adminRooms, roomsParams],
    queryFn: ({ signal }) => api.getAdminRooms(roomsParams, signal),
    enabled: canAccessAdmin && showRoomsSection,
  })
  const visibleRoomIds = roomsQuery.data?.rooms.map(room => room.id) ?? []

  const roomLanguageMutation = useMutation({
    mutationFn: ({ roomId, language }: { roomId: string; language: Language }) => api.updateRoom(roomId, { language }),
    onSuccess: () => {
      setError('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminRooms })
      void queryClient.invalidateQueries({ queryKey: ['rooms'] })
    },
    onError: (err: Error) => setError(err.message),
  })

  const dbSizeQuery = useQuery({
    queryKey: queryKeys.adminDbSize,
    queryFn: () => api.getDbStorageSize(),
    enabled: isSuperuser && showRoomsSection,
  })

  const playbackSizesQuery = useQuery({
    queryKey: [...queryKeys.adminPlaybackSizes, visibleRoomIds],
    queryFn: async ({ signal }) => {
      const { rooms } = await api.getRoomPlaybackSizes(visibleRoomIds, signal)
      return rooms
    },
    enabled: isSuperuser && showRoomsSection && visibleRoomIds.length > 0,
  })

  const clearPendingEditFor = useCallback((userId: string) => {
    setPendingEdits((prev) => {
      if (!prev.has(userId)) return prev
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
  }, [])

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: Partial<{ role: Role } & PermissionState> }) =>
      api.updateUser(userId, payload),
    onSuccess: async (_data, { userId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
      clearPendingEditFor(userId)
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: (userId: string) => api.deleteUser(userId),
    onSuccess: async (_data, userId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers })
      clearPendingEditFor(userId)
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

  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data])
  const rooms = useMemo(() => roomsQuery.data?.rooms ?? [], [roomsQuery.data])
  const dbSize = dbSizeQuery.data ?? null
  const playbackSizes = useMemo(() => playbackSizesQuery.data ?? [], [playbackSizesQuery.data])
  const isLoadingUsers = usersQuery.isLoading
  const isLoadingRooms = roomsQuery.isLoading
  const isLoadingStorage = isSuperuser ? dbSizeQuery.isLoading : false
  const isLoadingPlaybackSizes = isSuperuser ? playbackSizesQuery.isLoading : false

  const updateAdminParams = useCallback((updates: Record<string, string | number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(updates)) next.set(key, String(value))
      if (['userRole', 'userSearch', 'pageSize'].some(key => key in updates)) next.set('userPage', '1')
      if (['roomStatus', 'roomSearch', 'language', 'owner', 'pageSize'].some(key => key in updates)) next.set('roomPage', '1')
      return next
    })
  }, [setSearchParams])

  const pagination = (showUsersSection ? usersQuery.data?.pagination : roomsQuery.data?.pagination) ?? EMPTY_PAGE
  useEffect(() => {
    const requested = showUsersSection ? userPage : roomPage
    const resolved = showUsersSection ? usersQuery.data?.pagination.page : roomsQuery.data?.pagination.page
    if (resolved && resolved !== requested) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set(showUsersSection ? 'userPage' : 'roomPage', String(resolved))
        return next
      }, { replace: true })
    }
  }, [showUsersSection, userPage, roomPage, usersQuery.data, roomsQuery.data, setSearchParams])

  useEffect(() => {
    if (!canAccessAdmin) {
      navigate('/rooms')
    }
  }, [canAccessAdmin, navigate])

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

  const handleUpdateUser = async (userId: string) => {
    const edits = pendingEdits.get(userId)
    const original = users.find((u) => u.id === userId)
    if (!edits || !original) return

    const payload: Partial<{ role: Role } & PermissionState> = {}
    if (edits.role !== undefined && edits.role !== original.role) payload.role = edits.role
    if (edits.canReadAllRooms !== undefined && edits.canReadAllRooms !== original.canReadAllRooms)
      payload.canReadAllRooms = edits.canReadAllRooms
    if (edits.canWriteAllRooms !== undefined && edits.canWriteAllRooms !== original.canWriteAllRooms)
      payload.canWriteAllRooms = edits.canWriteAllRooms
    if (edits.canDeleteAllRooms !== undefined && edits.canDeleteAllRooms !== original.canDeleteAllRooms)
      payload.canDeleteAllRooms = edits.canDeleteAllRooms

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
    setPendingEdits((prev) => {
      const next = new Map(prev)
      next.set(userId, { ...next.get(userId), ...updates })
      return next
    })
  }

  const hasChanges = (userId: string): boolean => {
    const edits = pendingEdits.get(userId)
    const original = users.find((u) => u.id === userId)
    if (!edits || !original) return false

    return (
      (edits.role !== undefined && edits.role !== original.role) ||
      (edits.canReadAllRooms !== undefined && edits.canReadAllRooms !== original.canReadAllRooms) ||
      (edits.canWriteAllRooms !== undefined && edits.canWriteAllRooms !== original.canWriteAllRooms) ||
      (edits.canDeleteAllRooms !== undefined && edits.canDeleteAllRooms !== original.canDeleteAllRooms)
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
            <ArrowLeft className="h-4 w-4 mr-1.5" />
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
          <div className="mb-2 p-2 text-sm text-destructive bg-destructive/10 rounded-md">{translateError(error)}</div>
        )}

        <Tabs.Root value={section} onValueChange={value => updateAdminParams({ section: value })}>
          <Tabs.List aria-label={t('admin.filters.view')} className="mb-2 flex gap-1 border-b">
            {ADMIN_SECTIONS.map(value => <Tabs.Trigger key={value} value={value}
              className="min-h-control px-2 text-sm border-b-2 border-transparent text-muted-foreground data-[state=active]:border-primary data-[state=active]:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {value === 'users' ? t('admin.users.title') : t('admin.rooms.title')}
            </Tabs.Trigger>)}
          </Tabs.List>
          <Tabs.Content value={section} className="outline-none">
        <form className="mb-2 flex flex-wrap items-center gap-1" onSubmit={event => {
          event.preventDefault()
          updateAdminParams({ [searchKey]: searchDraft.trim(), ...(showRoomsSection ? { owner: ownerDraft.trim() } : {}) })
        }}>
          <Input className="w-full sm:w-56" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
            aria-label={showUsersSection ? t('admin.filters.searchUsers') : t('admin.filters.searchRooms')}
            placeholder={showUsersSection ? t('admin.filters.searchUsers') : t('admin.filters.searchRooms')} />
          {showUsersSection ? (
            <Select value={userRoleFilter} onValueChange={value => updateAdminParams({ userRole: value })}>
              <SelectTrigger className="w-32" aria-label={t('admin.users.table.role')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.filters.allRoles')}</SelectItem>
                {ROLES.map(role => <SelectItem key={role} value={role}>{roleDisplay(role)}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : <>
            <Input className="w-36" value={ownerDraft} onChange={event => setOwnerDraft(event.target.value)}
              aria-label={t('admin.filters.owner')} placeholder={t('admin.filters.owner')} />
            <Select value={roomStatusFilter} onValueChange={value => updateAdminParams({ roomStatus: value })}>
              <SelectTrigger className="w-32" aria-label={t('admin.rooms.table.status')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.filters.allStatuses')}</SelectItem>
                <SelectItem value="active">{t('admin.rooms.table.statusActive')}</SelectItem>
                <SelectItem value="ended">{t('admin.rooms.table.statusEnded')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={roomLanguage} onValueChange={value => updateAdminParams({ language: value })}>
              <SelectTrigger className="w-32" aria-label={t('admin.rooms.table.language')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.filters.allLanguages')}</SelectItem>
                {LANGUAGES.map(language => <SelectItem key={language} value={language}>{language}</SelectItem>)}
              </SelectContent>
            </Select>
          </>}
          <Button type="submit" variant="outline">{t('admin.filters.search')}</Button>
          <Button type="button" variant="ghost" onClick={() => {
            setSearchDraft(''); setOwnerDraft('')
            updateAdminParams(showUsersSection ? { userSearch: '', userRole: 'all' } : { roomSearch: '', owner: '', roomStatus: 'all', language: 'all' })
          }}>{t('admin.filters.reset')}</Button>
          <Select value={String(pageSize)} onValueChange={value => updateAdminParams({ pageSize: value })}>
            <SelectTrigger className="w-32 sm:ml-auto" aria-label={t('rooms.pagination.pageSize')}><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map(size => <SelectItem key={size} value={String(size)}>{t('rooms.pagination.perPage', { count: size })}</SelectItem>)}</SelectContent>
          </Select>
        </form>

        {/* Users Section */}
        {showUsersSection && (
        <Card className="mb-3">
          <CardHeader className="py-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('admin.users.title')}</CardTitle>
              <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                {t('admin.users.createButton')}
              </Button>
              <CreateUserDialog
                open={isCreateOpen}
                onOpenChange={setIsCreateOpen}
                isSuperuser={isSuperuser}
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0 px-1.5 sm:px-3">
            {isLoadingUsers ? (
              <div className="flex justify-center py-3">
                <Spinner />
              </div>
            ) : (
              <div className="overflow-x-auto -mx-2 sm:mx-0">
                <table className="w-full text-sm [&_th]:whitespace-nowrap">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-1.5 py-1 font-medium">{t('admin.users.table.username')}</th>
                      <th className="px-1.5 py-1 font-medium hidden sm:table-cell">{t('admin.users.table.email')}</th>
                      <th className="px-1.5 py-1 font-medium">{t('admin.users.table.role')}</th>
                      <th className="px-1.5 py-1 font-medium text-center w-12">{t('admin.users.table.read')}</th>
                      <th className="px-1.5 py-1 font-medium text-center w-12">{t('admin.users.table.write')}</th>
                      <th className="px-1.5 py-1 font-medium text-center w-12">{t('admin.users.table.delete')}</th>
                      <th className="px-1.5 py-1 font-medium hidden md:table-cell">{t('admin.users.table.created')}</th>
                      <th className="px-1.5 py-1 font-medium">{t('admin.users.table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const edits = pendingEdits.get(u.id)
                      const canDelete = isSuperuser
                        ? u.id !== user?.id && u.role !== 'superuser'
                        : u.role === 'user'

                      return (
                        <tr key={u.id} className="border-b">
                          <td className="px-1.5 py-1">
                            <div>{u.username}</div>
                            <div className="text-xs text-muted-foreground sm:hidden">{u.email ?? '-'}</div>
                          </td>
                          <td className="px-1.5 py-1 text-muted-foreground hidden sm:table-cell">{u.email ?? '-'}</td>
                          <td className="px-1.5 py-1">
                            {isSuperuser && u.id !== user?.id ? (
                              <Select
                                value={edits?.role ?? u.role}
                                onValueChange={(v) => updateEditedUser(u.id, { role: v as Role })}
                              >
                                <SelectTrigger className="w-24 sm:w-28 h-control-sm text-xs">
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
                              <Badge variant="secondary" className="rounded-sm text-xs px-1 py-0">{roleDisplay(u.role)}</Badge>
                            )}
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <Checkbox
                              checked={edits?.canReadAllRooms ?? u.canReadAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canReadAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <Checkbox
                              checked={edits?.canWriteAllRooms ?? u.canWriteAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canWriteAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <Checkbox
                              checked={edits?.canDeleteAllRooms ?? u.canDeleteAllRooms}
                              onCheckedChange={(checked) =>
                                updateEditedUser(u.id, { canDeleteAllRooms: checked as boolean })
                              }
                              disabled={!isSuperuser || u.role === 'superuser'}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-muted-foreground hidden md:table-cell">{formatDate(u.createdAt ?? '')}</td>
                          <td className="px-1.5 py-1">
                            <div className="flex items-center gap-1">
                              {hasChanges(u.id) && (
                                <Button
                                  size="sm"
                                  variant="outline"
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
                    {users.length === 0 && (
                      <tr>
                        <td className="px-1.5 py-2 text-center text-muted-foreground" colSpan={8}>
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
            <CardHeader className="py-2">
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
            <CardContent className="pt-0 px-1.5 sm:px-3">
              {isLoadingRooms || isLoadingStorage || isLoadingPlaybackSizes ? (
                <div className="flex justify-center py-3">
                  <Spinner />
                </div>
              ) : (
                <>
                  {isSuperuser && (
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 mb-2">
                    <div className="rounded-md border p-2">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.dbSize')}</div>
                      <div className="text-lg font-semibold">{dbSize?.pretty ?? '--'}</div>
                      {dbSize && (
                        <div className="text-xs text-muted-foreground">{formatBytes(dbSize.bytes)}</div>
                      )}
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.pagePlayback')}</div>
                      <div className="text-lg font-semibold">
                        {formatBytes(playbackSizes.reduce((sum, room) => sum + room.bytes, 0))}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('admin.storage.roomsTracked', { count: playbackSizes.length })}
                      </div>
                    </div>
                    <div className="rounded-md border p-2">
                      <div className="text-xs text-muted-foreground">{t('admin.storage.pageEndedRooms')}</div>
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
                    <div className="mb-2 text-xs text-muted-foreground">{storageNotice}</div>
                  )}

                  <div className="overflow-x-auto -mx-2 sm:mx-0">
                    <table className="w-full text-sm [&_th]:whitespace-nowrap">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="px-1.5 py-1 font-medium">{t('admin.rooms.table.name')}</th>
                          <th className="px-1.5 py-1 font-medium hidden sm:table-cell">{t('admin.rooms.table.owner')}</th>
                          <th className="px-1.5 py-1 font-medium">{t('admin.rooms.table.language')}</th>
                          <th className="px-1.5 py-1 font-medium">{t('admin.rooms.table.status')}</th>
                          <th className="px-1.5 py-1 font-medium hidden lg:table-cell">
                            {t('admin.storage.table.endedAt')}
                          </th>
                          <th className="px-1.5 py-1 font-medium hidden md:table-cell">
                            {t('admin.rooms.table.created')}
                          </th>
                          <th className="px-1.5 py-1 font-medium">{t('admin.storage.table.updates')}</th>
                          <th className="px-1.5 py-1 font-medium">{t('admin.storage.table.size')}</th>
                          <th className="px-1.5 py-1 font-medium">{t('admin.storage.table.actions')}</th>
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
                          const canDeleteCurrentRoom = canDeleteRoom(user, room.owner.id)

                          return (
                            <tr key={room.id} className="border-b">
                              <td className="px-1.5 py-1">
                                <div>{room.name}</div>
                                <div className="text-xs text-muted-foreground sm:hidden">{room.owner.username}</div>
                              </td>
                              <td className="px-1.5 py-1 text-muted-foreground hidden sm:table-cell">
                                {room.owner.username}
                              </td>
                              <td className="px-1.5 py-1">
                                <Select value={room.language}
                                  disabled={roomLanguageMutation.isPending || room.isDeleted}
                                  onValueChange={language => roomLanguageMutation.mutate({ roomId: room.id, language: language as Language })}>
                                  <SelectTrigger className="h-control-sm w-[105px] text-xs" aria-label={`${t('admin.rooms.table.language')}: ${room.name}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {LANGUAGES.map(language => <SelectItem key={language} value={language}>{language}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="px-1.5 py-1">
                                <Badge
                                  variant={isEnded ? 'destructive' : 'success'}
                                  className="rounded-sm text-xs px-1 py-0"
                                >
                                  {isEnded ? t('admin.rooms.table.statusEnded') : t('admin.rooms.table.statusActive')}
                                </Badge>
                              </td>
                              <td className="px-1.5 py-1 text-muted-foreground hidden lg:table-cell">
                                {endedAt ? formatDateTime(endedAt) : '-'}
                              </td>
                              <td className="px-1.5 py-1 text-muted-foreground hidden md:table-cell">
                                {formatDate(room.createdAt)}
                              </td>
                              <td className="px-1.5 py-1">{playback ? updates : '—'}</td>
                              <td className="px-1.5 py-1">{playback ? formatBytes(sizeBytes) : '—'}</td>
                              <td className="px-1.5 py-1">
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="outline"
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
                        {rooms.length === 0 && (
                          <tr>
                            <td className="px-1.5 py-2 text-center text-muted-foreground" colSpan={9}>
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
            <CardHeader className="py-2">
              <CardTitle className="text-base">{t('admin.rooms.title')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 px-1.5 sm:px-3">
              <p className="text-sm text-muted-foreground">{t('admin.rooms.superuserOnly')}</p>
            </CardContent>
          </Card>
        ) : null}
        <AdminPagination pagination={pagination} disabled={showUsersSection ? usersQuery.isFetching : roomsQuery.isFetching}
          onPage={page => updateAdminParams({ [showUsersSection ? 'userPage' : 'roomPage']: page })} />
          </Tabs.Content>
        </Tabs.Root>
      </PageContainer>
    </div>
  )
}
