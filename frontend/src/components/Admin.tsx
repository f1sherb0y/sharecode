import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from './ThemeToggle'
import { api } from '../lib/api'
import type { User, Room, Role } from '../types'

type PermissionState = {
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

type EditableUserState = PermissionState & {
    role: Role
}

const INITIAL_PERMISSION_STATE: PermissionState = {
    canReadAllRooms: false,
    canWriteAllRooms: false,
    canDeleteAllRooms: false,
}

function enforcePermissionImplications(state: PermissionState): PermissionState {
    const next = { ...state }

    if (next.canDeleteAllRooms) {
        next.canWriteAllRooms = true
        next.canReadAllRooms = true
    } else if (next.canWriteAllRooms) {
        next.canReadAllRooms = true
    }

    return next
}

function getInitialPermissionsForRole(role: Role): PermissionState {
    if (role === 'superuser') {
        return {
            canReadAllRooms: true,
            canWriteAllRooms: true,
            canDeleteAllRooms: true,
        }
    }

    if (role === 'admin') {
        return {
            canReadAllRooms: true,
            canWriteAllRooms: true,
            canDeleteAllRooms: false,
        }
    }

    return { ...INITIAL_PERMISSION_STATE }
}

function alignPermissionsWithRole(role: Role, state: PermissionState): PermissionState {
    if (role === 'superuser') {
        return {
            canReadAllRooms: true,
            canWriteAllRooms: true,
            canDeleteAllRooms: true,
        }
    }

    if (role === 'admin') {
        return enforcePermissionImplications({
            ...state,
            canReadAllRooms: true,
            canWriteAllRooms: true,
        })
    }

    return enforcePermissionImplications(state)
}

function updatePermissionState(
    state: PermissionState,
    key: keyof PermissionState,
    value: boolean
): PermissionState {
    let next: PermissionState = { ...state, [key]: value }

    if (key === 'canReadAllRooms') {
        if (!value && (state.canWriteAllRooms || state.canDeleteAllRooms)) {
            return state
        }
    }

    if (key === 'canWriteAllRooms') {
        if (value) {
            next.canReadAllRooms = true
        } else if (state.canDeleteAllRooms) {
            next.canDeleteAllRooms = false
        }
    }

    if (key === 'canDeleteAllRooms' && value) {
        next.canWriteAllRooms = true
        next.canReadAllRooms = true
    }

    return enforcePermissionImplications(next)
}

function toEditableState(user: User): EditableUserState {
    const role = (user.role as Role) ?? 'user'
    const base: PermissionState = {
        canReadAllRooms: Boolean(user.canReadAllRooms),
        canWriteAllRooms: Boolean(user.canWriteAllRooms),
        canDeleteAllRooms: Boolean(user.canDeleteAllRooms),
    }
    const aligned = alignPermissionsWithRole(role, base)
    return {
        role,
        ...aligned,
    }
}

export function Admin() {
    const { t } = useTranslation()
    const [users, setUsers] = useState<User[]>([])
    const [rooms, setRooms] = useState<Room[]>([])
    const [isLoadingUsers, setIsLoadingUsers] = useState(true)
    const [isLoadingRooms, setIsLoadingRooms] = useState(true)
    const [error, setError] = useState('')
    const [showCreateUser, setShowCreateUser] = useState(false)
    const [newUsername, setNewUsername] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [newEmail, setNewEmail] = useState('')
    const [newRole, setNewRole] = useState<Role>('user')
    const [newPermissions, setNewPermissions] = useState<PermissionState>(getInitialPermissionsForRole('user'))
    const [isCreating, setIsCreating] = useState(false)
    const [editedUsers, setEditedUsers] = useState<Record<string, EditableUserState>>({})
    const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const isSuperuser = user?.role === 'superuser'
    const roleOptions: Role[] = ['user', 'admin', 'superuser']
    const createRoleOptions: Role[] = isSuperuser ? roleOptions : ['user']

    const roleDisplay = (role: Role | undefined) => {
        switch (role) {
            case 'superuser':
                return t('common.superuser')
            case 'admin':
                return t('common.admin')
            default:
                return t('admin.users.createForm.roleUser')
        }
    }

    const readDisabledForNewUser = newRole !== 'user' || newPermissions.canWriteAllRooms || newPermissions.canDeleteAllRooms
    const writeDisabledForNewUser = newRole === 'admin' || newRole === 'superuser' || newPermissions.canDeleteAllRooms
    const deleteDisabledForNewUser = newRole === 'superuser'

    useEffect(() => {
        if (!user) {
            return
        }

        if (user.role !== 'admin' && user.role !== 'superuser') {
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
            const mapped = users.reduce<Record<string, EditableUserState>>((acc, item) => {
                acc[item.id] = toEditableState(item)
                return acc
            }, {})
            setEditedUsers(mapped)
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

    const resetCreateForm = () => {
        setNewUsername('')
        setNewPassword('')
        setNewEmail('')
        setNewRole('user')
        setNewPermissions(getInitialPermissionsForRole('user'))
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
            resetCreateForm()
            setShowCreateUser(false)
            loadUsers()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create user')
        } finally {
            setIsCreating(false)
        }
    }

    const handleDeleteUser = async (userId: string, username: string) => {
        if (!confirm(`Delete user "${username}"?`)) return

        try {
            await api.deleteUser(userId)
            loadUsers()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete user')
        }
    }

    const handleDeleteRoom = async (roomId: string, roomName: string) => {
        if (!confirm(`Delete room "${roomName}"?`)) return

        try {
            await api.deleteRoomAdmin(roomId)
            loadRooms()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete room')
        }
    }

    const handleNewRoleChange = (role: Role) => {
        setNewRole(role)
        setNewPermissions(getInitialPermissionsForRole(role))
    }

    const handleNewPermissionToggle = (key: keyof PermissionState, value: boolean) => {
        setNewPermissions(prev => alignPermissionsWithRole(newRole, updatePermissionState(prev, key, value)))
    }

    const handleEditedPermissionToggle = (userId: string, key: keyof PermissionState, value: boolean) => {
        setEditedUsers(prev => {
            const current = prev[userId]
            if (!current) return prev

            const { role, ...permissionState } = current
            const updatedPermissions = alignPermissionsWithRole(
                role,
                updatePermissionState(permissionState, key, value)
            )

            return {
                ...prev,
                [userId]: {
                    role,
                    ...updatedPermissions,
                },
            }
        })
    }

    const handleEditedRoleChange = (userId: string, role: Role) => {
        setEditedUsers(prev => {
            const current = prev[userId]
            if (!current) return prev

            const { role: _oldRole, ...permissionState } = current
            const updatedPermissions = alignPermissionsWithRole(role, permissionState)

            return {
                ...prev,
                [userId]: {
                    role,
                    ...updatedPermissions,
                },
            }
        })
    }

    const handleUpdateUser = async (target: User) => {
        const edits = editedUsers[target.id]
        if (!edits) return

        const original = toEditableState(target)

        const payload: {
            role?: Role
            canReadAllRooms?: boolean
            canWriteAllRooms?: boolean
            canDeleteAllRooms?: boolean
        } = {}

        if (edits.role !== original.role) {
            payload.role = edits.role
        }
        if (edits.canReadAllRooms !== original.canReadAllRooms) {
            payload.canReadAllRooms = edits.canReadAllRooms
        }
        if (edits.canWriteAllRooms !== original.canWriteAllRooms) {
            payload.canWriteAllRooms = edits.canWriteAllRooms
        }
        if (edits.canDeleteAllRooms !== original.canDeleteAllRooms) {
            payload.canDeleteAllRooms = edits.canDeleteAllRooms
        }

        if (Object.keys(payload).length === 0) {
            return
        }

        try {
            setUpdatingUserId(target.id)
            await api.updateUser(target.id, payload)
            await loadUsers()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update user')
        } finally {
            setUpdatingUserId(null)
        }
    }

    return (
        <div className="room-page">
            <div className="room-topbar">
                <div className="room-topbar-inner">
                    <h1 className="room-topbar-title">{t('admin.title')}</h1>
                    <div className="room-topbar-actions">
                        <button className="toolbar-button" onClick={() => navigate('/rooms')}>
                            {t('admin.backToRooms')}
                        </button>
                        <button className="toolbar-button" onClick={logout}>
                            {t('common.logout')}
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </div>

            <div className="container room-content">
                {error && <div className="error-message" style={{ marginTop: '1rem' }}>{error}</div>}

                {/* Users Section */}
                <div style={{ marginBottom: '3rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h2 style={{ margin: 0 }}>{t('admin.users.title')}</h2>
                        <button
                            onClick={() => {
                                if (showCreateUser) {
                                    resetCreateForm()
                                }
                                setShowCreateUser(!showCreateUser)
                            }}
                        >
                            {showCreateUser ? t('admin.users.cancelButton') : '+ ' + t('admin.users.createButton')}
                        </button>
                    </div>

                    {showCreateUser && (
                        <div className="card" style={{ marginBottom: '2rem' }}>
                            <h3>{t('admin.users.createForm.title')}</h3>
                            <form className="auth-form" onSubmit={handleCreateUser} style={{ marginTop: '1rem' }}>
                                <div className="form-group">
                                    <label className="form-label">{t('admin.users.createForm.username')} *</label>
                                    <input
                                        type="text"
                                        placeholder={t('admin.users.createForm.usernamePlaceholder')}
                                        value={newUsername}
                                        onChange={(e) => setNewUsername(e.target.value)}
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">{t('admin.users.createForm.password')} *</label>
                                    <input
                                        type="password"
                                        placeholder={t('admin.users.createForm.passwordPlaceholder')}
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">{t('admin.users.createForm.email')}</label>
                                    <input
                                        type="email"
                                        placeholder={t('admin.users.createForm.emailPlaceholder')}
                                        value={newEmail}
                                        onChange={(e) => setNewEmail(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">{t('admin.users.createForm.role')}</label>
                                    <select
                                        value={newRole}
                                        onChange={(e) => handleNewRoleChange(e.target.value as Role)}
                                    >
                                        {createRoleOptions.map((option) => (
                                            <option key={option} value={option}>
                                                {roleDisplay(option)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">{t('admin.users.createForm.permissions')}</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                            <input
                                                type="checkbox"
                                                checked={newPermissions.canReadAllRooms}
                                                disabled={readDisabledForNewUser}
                                                onChange={(e) => handleNewPermissionToggle('canReadAllRooms', e.target.checked)}
                                            />
                                            {t('admin.users.permissions.readAll')}
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                            <input
                                                type="checkbox"
                                                checked={newPermissions.canWriteAllRooms}
                                                disabled={writeDisabledForNewUser}
                                                onChange={(e) => handleNewPermissionToggle('canWriteAllRooms', e.target.checked)}
                                            />
                                            {t('admin.users.permissions.writeAll')}
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                            <input
                                                type="checkbox"
                                                checked={newPermissions.canDeleteAllRooms}
                                                disabled={deleteDisabledForNewUser}
                                                onChange={(e) => handleNewPermissionToggle('canDeleteAllRooms', e.target.checked)}
                                            />
                                            {t('admin.users.permissions.deleteAll')}
                                        </label>
                                    </div>
                                    <small style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', display: 'block', marginTop: '0.5rem' }}>
                                        {t('admin.users.permissions.hint')}
                                    </small>
                                </div>
                                <button type="submit" disabled={isCreating}>
                                    {isCreating ? t('admin.users.createForm.creating') : t('admin.users.createForm.createButton')}
                                </button>
                            </form>
                        </div>
                    )}

                    {isLoadingUsers ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                            {t('admin.users.table.loading')}
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.username')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.email')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.role')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.permissions')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.created')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.actions')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map((u) => {
                                        const originalState = toEditableState(u)
                                        const editState = editedUsers[u.id] ?? originalState
                                        const canModifyRole = isSuperuser && u.id !== user?.id
                                        const canModifyPermissions = isSuperuser || editState.role === 'user'
                                        const readDisabled = !canModifyPermissions || editState.role !== 'user' || editState.canWriteAllRooms || editState.canDeleteAllRooms
                                        const writeDisabled = !canModifyPermissions || editState.role !== 'user' || editState.canDeleteAllRooms
                                        const deleteDisabled = !canModifyPermissions || editState.role === 'superuser'
                                        const canDelete = isSuperuser ? (u.id !== user?.id && editState.role !== 'superuser') : editState.role === 'user'
                                        const hasChanges =
                                            editState.role !== originalState.role ||
                                            editState.canReadAllRooms !== originalState.canReadAllRooms ||
                                            editState.canWriteAllRooms !== originalState.canWriteAllRooms ||
                                            editState.canDeleteAllRooms !== originalState.canDeleteAllRooms

                                        return (
                                            <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '0.75rem' }}>{u.username}</td>
                                                <td style={{ padding: '0.75rem' }}>{u.email}</td>
                                                <td style={{ padding: '0.75rem' }}>
                                                    {isSuperuser ? (
                                                        <select
                                                            value={editState.role}
                                                            onChange={(e) => handleEditedRoleChange(u.id, e.target.value as Role)}
                                                            disabled={!canModifyRole}
                                                        >
                                                            {roleOptions.map((option) => (
                                                                <option key={option} value={option}>
                                                                    {roleDisplay(option)}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    ) : (
                                                        <span>{roleDisplay(editState.role)}</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '0.75rem' }}>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={editState.canReadAllRooms}
                                                                disabled={readDisabled}
                                                                onChange={(e) => handleEditedPermissionToggle(u.id, 'canReadAllRooms', e.target.checked)}
                                                            />
                                                            {t('admin.users.permissions.readAll')}
                                                        </label>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={editState.canWriteAllRooms}
                                                                disabled={writeDisabled}
                                                                onChange={(e) => handleEditedPermissionToggle(u.id, 'canWriteAllRooms', e.target.checked)}
                                                            />
                                                            {t('admin.users.permissions.writeAll')}
                                                        </label>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={editState.canDeleteAllRooms}
                                                                disabled={deleteDisabled}
                                                                onChange={(e) => handleEditedPermissionToggle(u.id, 'canDeleteAllRooms', e.target.checked)}
                                                            />
                                                            {t('admin.users.permissions.deleteAll')}
                                                        </label>
                                                    </div>
                                                </td>
                                                <td style={{ padding: '0.75rem' }}>
                                                    {new Date((u as any).createdAt).toLocaleDateString()}
                                                </td>
                                                <td style={{ padding: '0.75rem' }}>
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                                        {(isSuperuser || editState.role === 'user') && (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleUpdateUser(u)}
                                                                disabled={!hasChanges || updatingUserId === u.id}
                                                                style={{ fontSize: '0.875rem', padding: '0.25rem 0.5rem' }}
                                                            >
                                                                {updatingUserId === u.id
                                                                    ? t('admin.users.table.updating')
                                                                    : t('admin.users.table.update')}
                                                            </button>
                                                        )}
                                                        {canDelete && (
                                                            <button
                                                                type="button"
                                                                className="btn-danger"
                                                                onClick={() => handleDeleteUser(u.id, u.username)}
                                                                disabled={updatingUserId === u.id}
                                                                style={{ fontSize: '0.875rem', padding: '0.25rem 0.5rem' }}
                                                            >
                                                                {t('admin.users.table.delete')}
                                                            </button>
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
                </div>

                {/* Rooms Section */}
                <div>
                    <h2>{t('admin.rooms.title')}</h2>
                    {isLoadingRooms ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                            {t('admin.rooms.table.loading')}
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.name')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.owner')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.language')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.participants')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.status')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.created')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.rooms.table.actions')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rooms.map((room) => (
                                        <tr key={room.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '0.75rem' }}>{room.name}</td>
                                            <td style={{ padding: '0.75rem' }}>{room.owner.username}</td>
                                            <td style={{ padding: '0.75rem' }}>
                                                <div className="language-badge" style={{ display: 'inline-block' }}>
                                                    {room.language}
                                                </div>
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {room.participants ? room.participants.length + 1 : 1}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {room.isEnded ? (
                                                    <span style={{ color: 'var(--error)' }}>{t('admin.rooms.table.statusEnded')}</span>
                                                ) : (
                                                    <span style={{ color: 'var(--success)' }}>{t('admin.rooms.table.statusActive')}</span>
                                                )}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {new Date(room.createdAt).toLocaleDateString()}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                <button
                                                    className="btn-danger"
                                                    onClick={() => handleDeleteRoom(room.id, room.name)}
                                                    style={{ fontSize: '0.875rem', padding: '0.25rem 0.5rem' }}
                                                >
                                                    {t('admin.rooms.table.delete')}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
