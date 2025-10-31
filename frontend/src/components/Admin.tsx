import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { api } from '../lib/api'
import type { User, Room } from '../types'

export function Admin() {
    const [users, setUsers] = useState<User[]>([])
    const [rooms, setRooms] = useState<Room[]>([])
    const [isLoadingUsers, setIsLoadingUsers] = useState(true)
    const [isLoadingRooms, setIsLoadingRooms] = useState(true)
    const [error, setError] = useState('')
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
                    <h1 className="room-topbar-title">Admin Dashboard</h1>
                    <div className="room-topbar-actions">
                        <button className="toolbar-button" onClick={() => navigate('/rooms')}>
                            Back to Rooms
                        </button>
                        <button className="toolbar-button" onClick={logout}>
                            Logout
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </div>

            <div className="container room-content">
                {error && <div className="error-message" style={{ marginTop: '1rem' }}>{error}</div>}

                {/* Users Section */}
                <div style={{ marginBottom: '3rem' }}>
                    <h2>Users Management</h2>
                    {isLoadingUsers ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                            Loading users...
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                                        <th style={{ padding: '0.75rem' }}>Username</th>
                                        <th style={{ padding: '0.75rem' }}>Email</th>
                                        <th style={{ padding: '0.75rem' }}>Role</th>
                                        <th style={{ padding: '0.75rem' }}>Created</th>
                                        <th style={{ padding: '0.75rem' }}>Actions</th>
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
                                                        Delete
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
                    <h2>Rooms Management</h2>
                    {isLoadingRooms ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                            Loading rooms...
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                                        <th style={{ padding: '0.75rem' }}>Name</th>
                                        <th style={{ padding: '0.75rem' }}>Owner</th>
                                        <th style={{ padding: '0.75rem' }}>Language</th>
                                        <th style={{ padding: '0.75rem' }}>Participants</th>
                                        <th style={{ padding: '0.75rem' }}>Status</th>
                                        <th style={{ padding: '0.75rem' }}>Created</th>
                                        <th style={{ padding: '0.75rem' }}>Actions</th>
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
                                                    <span style={{ color: 'var(--error)' }}>Ended</span>
                                                ) : (
                                                    <span style={{ color: 'var(--success)' }}>Active</span>
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
                                                    Delete
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
