import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
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
        <div style={{ padding: '20px' }}>
            <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>ShareCode - Rooms</h1>
                <div>
                    <span>Welcome, {user?.username}</span>
                    <button onClick={logout} style={{ marginLeft: '10px' }}>Logout</button>
                </div>
            </div>

            {error && <div style={{ color: 'red', marginBottom: '10px' }}>{error}</div>}

            <div style={{ marginBottom: '20px' }}>
                <button onClick={() => setShowCreate(!showCreate)}>
                    {showCreate ? 'Cancel' : 'Create New Room'}
                </button>
            </div>

            {showCreate && (
                <form onSubmit={handleCreateRoom} style={{ marginBottom: '20px', border: '1px solid #ccc', padding: '10px' }}>
                    <h3>Create New Room</h3>
                    <div>
                        <input
                            type="text"
                            placeholder="Room Name"
                            value={newRoomName}
                            onChange={(e) => setNewRoomName(e.target.value)}
                            required
                            style={{ marginRight: '10px' }}
                        />
                        <select
                            value={newRoomLanguage}
                            onChange={(e) => setNewRoomLanguage(e.target.value as Language)}
                            style={{ marginRight: '10px' }}
                        >
                            {LANGUAGES.map((lang) => (
                                <option key={lang} value={lang}>
                                    {lang}
                                </option>
                            ))}
                        </select>
                        <button type="submit" disabled={isCreating}>
                            {isCreating ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </form>
            )}

            {isLoading ? (
                <div>Loading rooms...</div>
            ) : rooms.length === 0 ? (
                <div>No rooms yet. Create one to get started!</div>
            ) : (
                <div>
                    <h2>Your Rooms</h2>
                    {rooms.map((room: any) => (
                        <div
                            key={room.id}
                            style={{
                                border: '1px solid #ccc',
                                padding: '10px',
                                marginBottom: '10px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                cursor: 'pointer',
                            }}
                        >
                            <div
                                style={{ flex: 1 }}
                                onClick={() => handleJoinRoom(room.id)}
                            >
                                <h3>
                                    {room.name} {room.isOwner && '(Your Room)'}
                                </h3>
                                <div>Language: {room.language}</div>
                                <div>Owner: {room.owner.username}</div>
                                <div>Created: {new Date(room.createdAt).toLocaleDateString()}</div>
                                {room.participants && room.participants.length > 0 && (
                                    <div>Participants: {room.participants.length + 1}</div>
                                )}
                            </div>
                            {room.isOwner && (
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation()
                                        if (confirm(`Delete room "${room.name}"?`)) {
                                            try {
                                                await api.deleteRoom(room.id)
                                                loadRooms() // Refresh the list
                                            } catch (err) {
                                                setError(err instanceof Error ? err.message : 'Failed to delete room')
                                            }
                                        }
                                    }}
                                    style={{ padding: '5px 10px', backgroundColor: '#ff4444', color: 'white', border: 'none' }}
                                >
                                    Delete
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
