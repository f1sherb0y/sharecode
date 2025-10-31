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
            setRooms(rooms)
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
            const { room } = await api.createRoom(newRoomName, newRoomLanguage)
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
                                <div key={room.id} className="room-card" onClick={() => handleJoinRoom(room.id)}>
                                    <div className="room-header">
                                        <div>
                                            <h3 className="room-title">
                                                {room.name}{' '}
                                                {room.isOwner && <span style={{ color: 'var(--accent)' }}>(Owned)</span>}
                                            </h3>
                                            <div className="language-badge">{room.language}</div>
                                        </div>
                                        {room.isOwner && (
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
                                        {room.participants && room.participants.length > 0 && (
                                            <div>{room.participants.length + 1} participants</div>
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
