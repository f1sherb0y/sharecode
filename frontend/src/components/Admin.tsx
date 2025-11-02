import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from './ThemeToggle'
import { api } from '../lib/api'
import type { User, Room } from '../types'

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
    const [newRole, setNewRole] = useState<'user' | 'admin' | 'observer' | 'support'>('user')
    const [isCreating, setIsCreating] = useState(false)
    const { user, logout } = useAuth()
    const navigate = useNavigate()

    useEffect(() => {
        if (user?.role !== 'admin') {
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
            await api.createUser(newUsername, newPassword, newEmail || undefined, newRole)
            setNewUsername('')
            setNewPassword('')
            setNewEmail('')
            setNewRole('user')
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
                        <button onClick={() => setShowCreateUser(!showCreateUser)}>
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
                                        onChange={(e) => setNewRole(e.target.value as 'user' | 'admin' | 'observer' | 'support')}
                                    >
                                        <option value="user">{t('admin.users.createForm.roleUser')}</option>
                                        <option value="admin">{t('admin.users.createForm.roleAdmin')}</option>
                                        <option value="observer">{t('admin.users.createForm.roleObserver')}</option>
                                        <option value="support">{t('admin.users.createForm.roleSupport')}</option>
                                    </select>
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
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.created')}</th>
                                        <th style={{ padding: '0.75rem' }}>{t('admin.users.table.actions')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map((u) => (
                                        <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '0.75rem' }}>{u.username}</td>
                                            <td style={{ padding: '0.75rem' }}>{u.email}</td>
                                            <td style={{ padding: '0.75rem' }}>
                                                <span style={{ color: u.role === 'admin' ? 'var(--accent)' : 'inherit' }}>
                                                    {u.role}
                                                </span>
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {new Date((u as any).createdAt).toLocaleDateString()}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {u.role !== 'admin' && (
                                                    <button
                                                        className="btn-danger"
                                                        onClick={() => handleDeleteUser(u.id, u.username)}
                                                        style={{ fontSize: '0.875rem', padding: '0.25rem 0.5rem' }}
                                                    >
                                                        {t('admin.users.table.delete')}
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
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
