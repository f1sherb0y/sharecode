import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { api } from '../lib/api'
import type { Room, Language } from '../types'

const LANGUAGES: Language[] = [
    'javascript',
    'typescript',
    'python',
    'java',
    'cpp',
    'rust',
    'go',
    'php',
]

export function RoomList() {
    const [rooms, setRooms] = useState<Room[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState('')
    const [showCreate, setShowCreate] = useState(false)
    const [newRoomName, setNewRoomName] = useState('')
    const [newRoomLanguage, setNewRoomLanguage] = useState<Language>('javascript')
    const [scheduledTime, setScheduledTime] = useState('')
    const [duration, setDuration] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const { user, logout } = useAuth()
    const navigate = useNavigate()

    useEffect(() => {
        loadRooms()
    }, [])

    const loadRooms = async () => {
        try {
            setIsLoading(true)
            const { rooms } = await api.getRooms()

            // Smart sorting: expired last, others by scheduledTime (earliest first)
            const sortedRooms = rooms.sort((a: any, b: any) => {
                // 1. Expired rooms go to the end
                if (a.isExpired && !b.isExpired) return 1
                if (!a.isExpired && b.isExpired) return -1

                // 2. Both expired or both not expired
                // If both have scheduledTime, sort by it (earliest first)
                if (a.scheduledTime && b.scheduledTime) {
                    return new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
                }

                // 3. Rooms with scheduledTime come before rooms without
                if (a.scheduledTime && !b.scheduledTime) return -1
                if (!a.scheduledTime && b.scheduledTime) return 1

                // 4. If neither has scheduledTime, sort by createdAt (newest first)
                return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            })

            setRooms(sortedRooms)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load rooms')
        } finally {
            setIsLoading(false)
        }
    }

    const handleCreateRoom = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsCreating(true)
        setError('')

        try {
            // Convert YYYY-MM-DD HH:MM to ISO 8601 format for the API
            let formattedScheduledTime: string | undefined = undefined
            if (scheduledTime) {
                // Replace space with 'T' to create ISO 8601 format
                formattedScheduledTime = scheduledTime.replace(' ', 'T') + ':00'
            }

            const { room } = await api.createRoom(
                newRoomName,
                newRoomLanguage,
                formattedScheduledTime,
                duration ? parseInt(duration) : undefined
            )
            navigate(`/editor/${room.id}`)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create room')
        } finally {
            setIsCreating(false)
        }
    }

    const handleJoinRoom = (roomId: string) => {
        navigate(`/editor/${roomId}`)
    }

    return (
        <div className="room-page">
            <div className="room-topbar">
                <div className="room-topbar-inner">
                    <h1 className="room-topbar-title">ShareCode</h1>
                    <div className="room-topbar-actions">
                        <span style={{ color: 'var(--text-secondary)' }}>Welcome, {user?.username}</span>
                        {user?.role === 'admin' && (
                            <button className="toolbar-button" onClick={() => navigate('/admin')}>
                                Admin
                            </button>
                        )}
                        <button className="toolbar-button" onClick={logout}>
                            Logout
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </div>

            <div className="container room-content">
                {error && <div className="error-message" style={{ marginTop: '1rem' }}>{error}</div>}

                <div style={{ marginBottom: '1.5rem' }}>
                    <button onClick={() => setShowCreate(!showCreate)}>
                        {showCreate ? 'Cancel' : '+ Create New Room'}
                    </button>
                </div>

                {showCreate && (
                    <div className="card" style={{ marginBottom: '2rem' }}>
                        <h3>Create New Room</h3>
                        <form className="auth-form" onSubmit={handleCreateRoom} style={{ marginTop: '1rem' }}>
                            <div className="form-group">
                                <label className="form-label">Room Name</label>
                                <input
                                    type="text"
                                    placeholder="Enter room name"
                                    value={newRoomName}
                                    onChange={(e) => setNewRoomName(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Language</label>
                                <select
                                    value={newRoomLanguage}
                                    onChange={(e) => setNewRoomLanguage(e.target.value as Language)}
                                >
                                    {LANGUAGES.map((lang) => (
                                        <option key={lang} value={lang}>
                                            {lang}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="form-group">
                                <label className="form-label">Scheduled Time (optional)</label>
                                <input
                                    type="text"
                                    placeholder="YYYY-MM-DD HH:MM"
                                    value={scheduledTime}
                                    onChange={(e) => setScheduledTime(e.target.value)}
                                    pattern="\d{4}-\d{2}-\d{2} \d{2}:\d{2}"
                                    title="Format: YYYY-MM-DD HH:MM (24-hour)"
                                />
                                <small style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                    Format: YYYY-MM-DD HH:MM (e.g., 2024-12-31 14:30)
                                </small>
                            </div>
                            <div className="form-group">
                                <label className="form-label">Duration (minutes, optional)</label>
                                <input
                                    type="number"
                                    min="1"
                                    placeholder="e.g., 60"
                                    value={duration}
                                    onChange={(e) => setDuration(e.target.value)}
                                />
                            </div>
                            <button type="submit" disabled={isCreating}>
                                {isCreating ? 'Creating...' : 'Create Room'}
                            </button>
                        </form>
                    </div>
                )}

                {isLoading ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                        Loading rooms...
                    </div>
                ) : rooms.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                        No rooms yet. Create one to get started!
                    </div>
                ) : (
                    <div>
                        <h2>All Rooms</h2>
                        <div className="room-grid">
                            {rooms.map((room: any) => (
                                <div
                                    key={room.id}
                                    className="room-card"
                                    onClick={() => !room.isEnded && handleJoinRoom(room.id)}
                                    style={{
                                        opacity: room.isExpired ? 0.5 : 1,
                                        cursor: room.isEnded ? 'default' : 'pointer',
                                    }}
                                >
                                    <div className="room-header">
                                        <div>
                                            <h3 className="room-title">
                                                {room.name}{' '}
                                                {room.isOwner && <span style={{ color: 'var(--accent)' }}>(Owned)</span>}
                                                {room.isEnded && <span style={{ color: 'var(--error)' }}> [Ended]</span>}
                                                {room.isExpired && !room.isEnded && <span style={{ color: 'var(--text-secondary)' }}> [Expired]</span>}
                                            </h3>
                                            <div className="language-badge">{room.language}</div>
                                        </div>
                                        {room.isOwner && !room.isEnded && (
                                            <button
                                                className="btn-danger"
                                                onClick={async (e) => {
                                                    e.stopPropagation()
                                                    if (confirm(`Delete room "${room.name}"?`)) {
                                                        try {
                                                            await api.deleteRoom(room.id)
                                                            loadRooms()
                                                        } catch (err) {
                                                            setError(err instanceof Error ? err.message : 'Failed to delete room')
                                                        }
                                                    }
                                                }}
                                                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                                            >
                                                Delete
                                            </button>
                                        )}
                                    </div>
                                    <div className="room-meta">
                                        <div>Owner: {room.owner.username}</div>
                                        <div>Created: {new Date(room.createdAt).toLocaleDateString()}</div>
                                        {room.scheduledTime && (
                                            <div>Scheduled: {new Date(room.scheduledTime).toLocaleString()}</div>
                                        )}
                                        {room.duration && <div>Duration: {room.duration} min</div>}
                                        {room.participants && room.participants.length > 0 && (
                                            <div>{room.participants.length + 1} participants</div>
                                        )}
                                        {room.isEnded && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    navigate(`/playback/${room.id}`)
                                                }}
                                                style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}
                                            >
                                                View Playback
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
