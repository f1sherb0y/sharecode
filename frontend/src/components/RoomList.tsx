import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { LanguageSwitcher } from './LanguageSwitcher'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import type { Room, Language, User } from '../types'

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
    const { t } = useTranslation()
    const [rooms, setRooms] = useState<Room[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState('')
    const [showCreate, setShowCreate] = useState(false)
    const [newRoomName, setNewRoomName] = useState('')
    const [newRoomLanguage, setNewRoomLanguage] = useState<Language>('javascript')
    const [scheduledTime, setScheduledTime] = useState('')
    const [duration, setDuration] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const [availableUsers, setAvailableUsers] = useState<User[]>([])
    const [selectedUsers, setSelectedUsers] = useState<{ userId: string; canEdit: boolean }[]>([])
    const [isUserModalOpen, setIsUserModalOpen] = useState(false)
    const [pendingUserSelection, setPendingUserSelection] = useState<{ userId: string; canEdit: boolean }[]>([])
    const [userSearchTerm, setUserSearchTerm] = useState('')
    const { user, logout } = useAuth()
    const navigate = useNavigate()

    // Check if running in Tauri desktop environment
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

    useEffect(() => {
        loadRooms()
        loadUsers()
    }, [])

    const loadUsers = async () => {
        try {
            const { users } = await api.getAllUsersForRoomCreation()
            // Filter out current user
            setAvailableUsers(users.filter(u => u.id !== user?.id))
        } catch (err) {
            console.error('Failed to load users:', err)
        }
    }

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
            // Convert datetime-local to ISO 8601 format for the API
            const formattedScheduledTime = scheduledTime ? new Date(scheduledTime).toISOString() : undefined

            const { room } = await api.createRoom(
                newRoomName,
                newRoomLanguage,
                formattedScheduledTime,
                duration ? parseInt(duration) : undefined,
                selectedUsers.length > 0 ? selectedUsers : undefined
            )

            // Reset form
            setNewRoomName('')
            setNewRoomLanguage('javascript')
            setScheduledTime('')
            setDuration('')
            setSelectedUsers([])
            setShowCreate(false)

            navigate(`/editor/${room.id}`)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create room')
        } finally {
            setIsCreating(false)
        }
    }

    const toggleUserSelection = (userId: string) => {
        setSelectedUsers(prev => {
            const existing = prev.find(u => u.userId === userId)
            if (existing) {
                return prev.filter(u => u.userId !== userId)
            }
            return [...prev, { userId, canEdit: true }]
        })
    }

    const toggleUserEditPermission = (userId: string) => {
        setSelectedUsers(prev =>
            prev.map(u => u.userId === userId ? { ...u, canEdit: !u.canEdit } : u)
        )
    }

    const openUserSelectionModal = () => {
        setPendingUserSelection(selectedUsers.map(userSelection => ({ ...userSelection })))
        setUserSearchTerm('')
        setIsUserModalOpen(true)
    }

    const closeUserSelectionModal = () => {
        setUserSearchTerm('')
        setIsUserModalOpen(false)
    }

    const togglePendingUserSelection = (userId: string) => {
        setPendingUserSelection(prev => {
            const existing = prev.find(u => u.userId === userId)
            if (existing) {
                return prev.filter(u => u.userId !== userId)
            }
            return [...prev, { userId, canEdit: true }]
        })
    }

    const togglePendingUserEditPermission = (userId: string) => {
        setPendingUserSelection(prev =>
            prev.map(u => u.userId === userId ? { ...u, canEdit: !u.canEdit } : u)
        )
    }

    const confirmPendingSelection = () => {
        setSelectedUsers(pendingUserSelection)
        setIsUserModalOpen(false)
    }

    const normalizedSearch = userSearchTerm.trim().toLowerCase()
    const filteredUsers = normalizedSearch
        ? availableUsers.filter(u => u.username.toLowerCase().includes(normalizedSearch))
        : []

    useEffect(() => {
        if (typeof document === 'undefined') return
        const previousOverflow = document.body.style.overflow
        if (isUserModalOpen) {
            document.body.style.overflow = 'hidden'
            return () => {
                document.body.style.overflow = previousOverflow
            }
        }
        document.body.style.overflow = previousOverflow
    }, [isUserModalOpen])

    const handleJoinRoom = (roomId: string) => {
        navigate(`/editor/${roomId}`)
    }

    return (
        <div className="room-page">
            <div className="room-topbar">
                <div className="room-topbar-inner">
                    <h1 className="room-topbar-title">ShareCode</h1>
                    <div className="room-topbar-actions">
                        <span style={{ color: 'var(--text-secondary)' }}>{t('rooms.welcome')}, {user?.username}</span>
                        {user?.role === 'admin' && (
                            <button className="toolbar-button" onClick={() => navigate('/admin')}>
                                {t('common.admin')}
                            </button>
                        )}
                        {isTauri && (
                            <button className="toolbar-button" onClick={() => navigate('/settings')}>
                                {t('common.settings')}
                            </button>
                        )}
                        <button className="toolbar-button" onClick={logout}>
                            {t('common.logout')}
                        </button>
                        <LanguageSwitcher />
                        <ThemeToggle />
                    </div>
                </div>
            </div>

            <div className="container room-content">
                {error && <div className="error-message" style={{ marginTop: '1rem' }}>{error}</div>}

                <div style={{ marginBottom: '1.5rem' }}>
                    <button onClick={() => setShowCreate(!showCreate)}>
                        {showCreate ? t('rooms.cancel') : '+ ' + t('rooms.createButton')}
                    </button>
                </div>

                {showCreate && (
                    <div className="card" style={{ marginBottom: '2rem' }}>
                        <h3>{t('rooms.create.title')}</h3>
                        <form className="auth-form" onSubmit={handleCreateRoom} style={{ marginTop: '1rem' }}>
                            <div className="form-group">
                                <label className="form-label">{t('rooms.create.name')}</label>
                                <input
                                    type="text"
                                    placeholder={t('rooms.create.namePlaceholder')}
                                    value={newRoomName}
                                    onChange={(e) => setNewRoomName(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">{t('rooms.create.language')}</label>
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
                                <label className="form-label">{t('rooms.create.scheduledTime')}</label>
                                <input
                                    type="datetime-local"
                                    value={scheduledTime}
                                    onChange={(e) => setScheduledTime(e.target.value)}
                                    min={new Date().toISOString().slice(0, 16)}
                                />
                                <small style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                    {t('rooms.create.scheduledTimeHint')}
                                </small>
                            </div>
                            <div className="form-group">
                                <label className="form-label">{t('rooms.create.duration')}</label>
                                <input
                                    type="number"
                                    min="1"
                                    placeholder={t('rooms.create.durationPlaceholder')}
                                    value={duration}
                                    onChange={(e) => setDuration(e.target.value)}
                                />
                            </div>

                            {availableUsers.length > 0 && (
                                <div className="form-group">
                                    <label className="form-label">{t('rooms.create.allowedUsers')}</label>
                                    <small style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', display: 'block', marginBottom: '0.5rem' }}>
                                        {t('rooms.create.allowedUsersHint')}
                                    </small>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                        {selectedUsers.map(selection => {
                                            const userInfo = availableUsers.find(u => u.id === selection.userId)
                                            return (
                                                <div
                                                    key={selection.userId}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.375rem',
                                                        padding: '0.375rem 0.5rem',
                                                        border: '1px solid var(--border)',
                                                        borderRadius: '6px',
                                                        backgroundColor: 'var(--bg-secondary)',
                                                        fontSize: '0.875rem'
                                                    }}
                                                >
                                                    <span style={{ fontWeight: 600 }}>{userInfo?.username ?? t('rooms.create.unknownUser')}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleUserEditPermission(selection.userId)}
                                                        style={{
                                                            border: `1px solid ${selection.canEdit ? 'var(--accent)' : 'var(--border)'}`,
                                                            background: selection.canEdit ? 'var(--accent-muted)' : 'var(--bg-hover)',
                                                            color: selection.canEdit ? 'var(--accent-text)' : 'var(--text-secondary)',
                                                            padding: '0.1875rem 0.5rem',
                                                            borderRadius: '6px',
                                                            cursor: 'pointer',
                                                            fontSize: '0.75rem',
                                                            lineHeight: 1.1,
                                                        }}
                                                    >
                                                        {selection.canEdit ? t('rooms.create.canEdit') : t('rooms.create.canView')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleUserSelection(selection.userId)}
                                                        style={{
                                                            border: 'none',
                                                            background: 'transparent',
                                                            color: 'var(--text-secondary)',
                                                            cursor: 'pointer',
                                                            fontSize: '1rem',
                                                            lineHeight: 1,
                                                        }}
                                                        aria-label={t('rooms.create.removeUser')}
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            )
                                        })}
                                        <button
                                            type="button"
                                            onClick={openUserSelectionModal}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.25rem',
                                                padding: '0.5rem 0.75rem',
                                                borderRadius: '6px',
                                                border: '1px dashed var(--border)',
                                                background: 'transparent',
                                                cursor: 'pointer',
                                                color: 'var(--text-secondary)',
                                                fontSize: '0.875rem'
                                            }}
                                        >
                                            + {t('rooms.create.addUser')}
                                        </button>
                                    </div>
                                    {selectedUsers.length === 0 && (
                                        <small style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.5rem', display: 'block' }}>
                                            {t('rooms.create.noAllowedUsers')}
                                        </small>
                                    )}
                                    {selectedUsers.length > 0 && (
                                        <small style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.5rem', display: 'block' }}>
                                            {t('rooms.create.selectedUsers', { count: selectedUsers.length })}
                                        </small>
                                    )}
                                </div>
                            )}

                            <button type="submit" disabled={isCreating}>
                                {isCreating ? t('rooms.create.creating') : t('rooms.create.button')}
                            </button>
                        </form>
                    </div>
                )}

                {isLoading ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                        {t('rooms.list.loading')}
                    </div>
                ) : rooms.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                        {t('rooms.list.empty')}
                    </div>
                ) : (
                    <div>
                        <h2>{t('rooms.title')}</h2>
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
                                                {room.isOwner && <span style={{ color: 'var(--accent)' }}>{t('rooms.list.owned')}</span>}
                                                {room.isEnded && <span style={{ color: 'var(--error)' }}> {t('rooms.list.ended')}</span>}
                                                {room.isExpired && !room.isEnded && <span style={{ color: 'var(--text-secondary)' }}> {t('rooms.list.expired')}</span>}
                                            </h3>
                                            <div className="language-badge">{room.language}</div>
                                        </div>
                                        {room.isOwner && !room.isEnded && (
                                            <button
                                                className="btn-danger"
                                                onClick={async (e) => {
                                                    e.stopPropagation()
                                                    if (confirm(t('rooms.list.deleteConfirm', { name: room.name }))) {
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
                                                {t('rooms.list.delete')}
                                            </button>
                                        )}
                                    </div>
                                    <div className="room-meta">
                                        <div>{t('rooms.list.owner')}: {room.owner.username}</div>
                                        <div>{t('rooms.list.created')}: {new Date(room.createdAt).toLocaleDateString()}</div>
                                        {room.scheduledTime && (
                                            <div>{t('rooms.list.scheduled')}: {new Date(room.scheduledTime).toLocaleString()}</div>
                                        )}
                                        {room.duration && <div>{t('rooms.list.duration')}: {room.duration} {t('rooms.list.durationUnit')}</div>}
                                        {room.participants && room.participants.length > 0 && (
                                            <div>{room.participants.length + 1} {t('rooms.list.participants')}</div>
                                        )}
                                        {room.isEnded && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    navigate(`/playback/${room.id}`)
                                                }}
                                                style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}
                                            >
                                                {t('rooms.list.viewPlayback')}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {isUserModalOpen && typeof document !== 'undefined' && createPortal(
                <div
                    className="modal-overlay"
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.75)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        padding: '1rem',
                    }}
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            closeUserSelectionModal()
                        }
                    }}
                >
                    <div
                        className="modal-content"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            borderRadius: '6px',
                            width: '100%',
                            maxWidth: '480px',
                            maxHeight: '80vh',
                            display: 'flex',
                            flexDirection: 'column',
                            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
                            border: '1px solid var(--border)',
                            position: 'relative',
                            zIndex: 10001,
                        }}
                    >
                        <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
                            <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>{t('rooms.create.selectUsersTitle')}</h4>
                            <p style={{ marginTop: '0.375rem', marginBottom: 0, color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                                {t('rooms.create.selectUsersDescription')}
                            </p>
                        </div>
                        <div style={{ padding: '0.75rem 1rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.625rem', flex: 1 }}>
                            <input
                                type="text"
                                value={userSearchTerm}
                                onChange={(e) => setUserSearchTerm(e.target.value)}
                                placeholder={t('rooms.create.searchPlaceholder')}
                                autoFocus
                                style={{
                                    width: '100%',
                                    padding: '0.5rem 0.625rem',
                                    borderRadius: '4px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.8125rem',
                                }}
                            />
                            {normalizedSearch === '' ? (
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', padding: '0.25rem 0' }}>
                                    {t('rooms.create.searchIntro')}
                                </div>
                            ) : filteredUsers.length === 0 ? (
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', padding: '0.25rem 0' }}>
                                    {t('rooms.create.searchNoResults', { query: userSearchTerm })}
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                                    {filteredUsers.map(u => {
                                        const isSelected = pendingUserSelection.some(su => su.userId === u.id)
                                        const userPerm = pendingUserSelection.find(su => su.userId === u.id)

                                        return (
                                            <div
                                                key={u.id}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '0.5rem',
                                                    padding: '0.5rem 0.625rem',
                                                    background: isSelected ? 'var(--bg-hover)' : 'transparent',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '4px',
                                                    minHeight: '40px',
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => togglePendingUserSelection(u.id)}
                                                    style={{
                                                        cursor: 'pointer',
                                                        minWidth: '16px',
                                                        minHeight: '16px',
                                                        margin: 0,
                                                        flexShrink: 0,
                                                    }}
                                                />
                                                <div style={{ flex: 1, minWidth: 0, fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                    <span style={{ fontWeight: 500 }}>{u.username}</span>
                                                    {u.role === 'observer' && (
                                                        <span style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)' }}>
                                                            ({t('common.observer')})
                                                        </span>
                                                    )}
                                                </div>
                                                {isSelected && (
                                                    <select
                                                        value={userPerm?.canEdit ? 'editor' : 'viewer'}
                                                        onChange={(e) => {
                                                            const newCanEdit = e.target.value === 'editor'
                                                            setPendingUserSelection(prev =>
                                                                prev.map(user =>
                                                                    user.userId === u.id
                                                                        ? { ...user, canEdit: newCanEdit }
                                                                        : user
                                                                )
                                                            )
                                                        }}
                                                        style={{
                                                            padding: '0.25rem 0.375rem',
                                                            fontSize: '0.75rem',
                                                            borderRadius: '4px',
                                                            border: '1px solid var(--border)',
                                                            background: 'var(--bg-card)',
                                                            color: 'var(--text-primary)',
                                                            cursor: 'pointer',
                                                            minWidth: '75px',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        <option value="viewer">{t('rooms.create.canView')}</option>
                                                        <option value="editor">{t('rooms.create.canEdit')}</option>
                                                    </select>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '0.625rem' }}>
                            <button
                                type="button"
                                onClick={closeUserSelectionModal}
                                style={{
                                    border: '1px solid var(--border)',
                                    background: 'transparent',
                                    color: 'var(--text-secondary)',
                                    padding: '0.5rem 0.875rem',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '0.8125rem',
                                    minHeight: '36px',
                                }}
                            >
                                {t('rooms.create.modalCancel')}
                            </button>
                            <button
                                type="button"
                                onClick={confirmPendingSelection}
                                style={{
                                    padding: '0.5rem 0.875rem',
                                    fontSize: '0.8125rem',
                                    minHeight: '36px',
                                }}
                            >
                                {t('rooms.create.modalConfirm')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}
