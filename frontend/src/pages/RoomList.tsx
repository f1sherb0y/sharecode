import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import type { Room, Language, User } from '../types'
import { ShareLinkManager } from '../components/share/ShareLinkManager'
import { Play, Trash2, Share2, Calendar, Clock, User as UserIconSmall } from 'lucide-react'
import { Navbar } from '../components/layout/Navbar'

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
    const [shareModalRoom, setShareModalRoom] = useState<{ id: string; name: string } | null>(null)
    const { user } = useAuth()
    const navigate = useNavigate()

    const formatUserRole = (role?: string) => {
        if (role === 'superuser') return t('common.superuser')
        if (role === 'admin') return t('common.admin')
        return null
    }

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

            // Smart sorting: ended/expired last, others by scheduledTime (earliest first)
            // Use [...rooms] to create a shallow copy before sorting to avoid mutating original array
            const sortedRooms = [...rooms].sort((a: any, b: any) => {
                // 1. Ended or Expired rooms go to the end
                const aInactive = a.isEnded || a.isExpired
                const bInactive = b.isEnded || b.isExpired

                if (aInactive && !bInactive) return 1
                if (!aInactive && bInactive) return -1

                // 2. Both inactive or both active
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

            navigate(`/room/${room.id}`)
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
        if (isUserModalOpen || shareModalRoom) {
            document.body.style.overflow = 'hidden'
            return () => {
                document.body.style.overflow = previousOverflow
            }
        }
        document.body.style.overflow = previousOverflow
    }, [isUserModalOpen, shareModalRoom])

    const handleJoinRoom = (roomId: string) => {
        navigate(`/room/${roomId}`)
    }

    return (
        <div className="room-page">
            <Navbar />

            <div className="container room-content">
                {error && <div className="error-message mt-4">{error}</div>}

                <div className="mb-6">
                    <button onClick={() => setShowCreate(!showCreate)}>
                        {showCreate ? t('rooms.cancel') : '+ ' + t('rooms.createButton')}
                    </button>
                </div>

                {showCreate && (
                    <div className="card mb-6">
                        <h3>{t('rooms.create.title')}</h3>
                        <form className="auth-form mt-4" onSubmit={handleCreateRoom}>
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
                                <small className="text-sm text-secondary">
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
                                    <small className="text-sm text-secondary block mb-2">
                                        {t('rooms.create.allowedUsersHint')}
                                    </small>
                                    <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                                        {selectedUsers.map(selection => {
                                            const userInfo = availableUsers.find(u => u.id === selection.userId)
                                            return (
                                                <div key={selection.userId} className="user-tag">
                                                    <span className="font-semibold">{userInfo?.username ?? t('rooms.create.unknownUser')}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleUserEditPermission(selection.userId)}
                                                        className={`user-tag-btn ${selection.canEdit ? 'active' : ''}`}
                                                    >
                                                        {selection.canEdit ? t('rooms.create.canEdit') : t('rooms.create.canView')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleUserSelection(selection.userId)}
                                                        className="user-tag-remove"
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
                                        <small className="text-sm text-secondary block mt-2">
                                            {t('rooms.create.noAllowedUsers')}
                                        </small>
                                    )}
                                    {selectedUsers.length > 0 && (
                                        <small className="text-sm text-secondary block mt-2">
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
                        <div className="flex justify-between items-center mb-4">
                            <h2 style={{ margin: 0 }}>{t('rooms.title')}</h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" style={{ gridAutoRows: '1fr' }}>
                            {rooms.map((room: any) => (
                                <div
                                    key={room.id}
                                    className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 shadow-sm hover:shadow-md hover:border-[var(--accent)] transition-all relative group"
                                    onClick={() => !room.isEnded && handleJoinRoom(room.id)}
                                    style={{
                                        opacity: (room.isExpired || room.isEnded) ? 0.7 : 1,
                                        cursor: room.isEnded ? 'default' : 'pointer',
                                        display: 'grid',
                                        gridTemplateRows: '3fr 2fr 6fr 4fr',
                                        gap: '0.25rem',
                                        height: '100%',
                                    }}
                                >
                                    {/* Header with title and action buttons */}
                                    <div className="flex justify-between items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <h3 className="text-base font-bold m-0 truncate text-[var(--text-primary)] leading-tight" title={room.name}>
                                                {room.name}
                                            </h3>
                                        </div>
                                        <div className="flex gap-1 flex-shrink-0">
                                            {room.isOwner && !room.isEnded && (
                                                <button
                                                    className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] border-0 cursor-pointer transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setShareModalRoom({ id: room.id, name: room.name })
                                                    }}
                                                    title={t('share.manager.openPanel')}
                                                >
                                                    <Share2 size={14} />
                                                </button>
                                            )}
                                            {(room.isOwner || user?.canDeleteAllRooms) && !room.isEnded && (
                                                <button
                                                    className="p-1 rounded hover:bg-[var(--danger)] hover:text-white text-[var(--text-secondary)] border-0 cursor-pointer transition-colors"
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
                                                    title={t('rooms.list.delete')}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Badges */}
                                    <div className="flex flex-wrap gap-2">
                                        <span className="language-badge text-[10px] px-1.5 py-0.5 uppercase tracking-wide font-semibold">{room.language}</span>
                                        {room.isOwner && <span className="text-xs px-1.5 items-center inline-flex py-0.5 rounded bg-[var(--bg-hover)] text-[var(--accent)] font-medium">{t('rooms.list.owned')}</span>}
                                    </div>

                                    {/* Metadata */}
                                    <div className="text-xs text-[var(--text-secondary)] space-y-1.5 flex flex-col justify-start">
                                        <div className="flex items-center gap-2">
                                            <UserIconSmall size={12} className="flex-shrink-0" />
                                            <span className="truncate">{room.owner.username}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Calendar size={12} className="flex-shrink-0" />
                                            <span>{new Date(room.createdAt).toLocaleDateString()}</span>
                                        </div>
                                        {room.scheduledTime && (
                                            <div className="flex items-center gap-2">
                                                <Clock size={12} className="flex-shrink-0" />
                                                <span className="truncate">{new Date(room.scheduledTime).toLocaleString()}</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Footer */}
                                    <div className="pt-3 border-t border-[var(--border)] flex justify-between items-center">
                                        <div className="text-xs font-medium">
                                            {room.isEnded ? (
                                                <span className="text-[var(--text-secondary)]">{t('rooms.list.ended')}</span>
                                            ) : (
                                                <span className="text-[var(--success)] flex items-center gap-1.5">
                                                    <span className="relative flex h-2 w-2 flex-shrink-0">
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--success)] opacity-75"></span>
                                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--success)]"></span>
                                                    </span>
                                                    <span>Live</span>
                                                    {room.participants && room.participants.length > 0 && (
                                                        <span className="text-[var(--text-secondary)] font-normal">
                                                            ({room.participants.length + 1})
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                        </div>

                                        {room.isEnded && (
                                            <button
                                                className="flex items-center gap-1.5 text-xs bg-[var(--bg-hover)] hover:bg-[var(--border)] px-2.5 py-1.5 rounded transition-colors border-0 cursor-pointer text-[var(--text-primary)] font-medium"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    navigate(`/playback/${room.id}`)
                                                }}
                                            >
                                                <Play size={12} />
                                                <span>{t('rooms.list.viewPlayback')}</span>
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
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            closeUserSelectionModal()
                        }
                    }}
                >
                    <div className="modal-content">
                        <div className="modal-header">
                            <h4>{t('rooms.create.selectUsersTitle')}</h4>
                            <p>{t('rooms.create.selectUsersDescription')}</p>
                        </div>
                        <div className="modal-body gap-2">
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
                                                    {formatUserRole(u.role) && (
                                                        <span style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)' }}>
                                                            ({formatUserRole(u.role)})
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
                    </div>
                    <div className="modal-footer">
                        <button
                            type="button"
                            onClick={closeUserSelectionModal}
                            className="btn-secondary"
                        >
                            {t('rooms.create.modalCancel')}
                        </button>
                        <button
                            type="button"
                            onClick={confirmPendingSelection}
                        >
                            {t('rooms.create.modalConfirm')}
                        </button>
                    </div>
                </div>,
                document.body
            )}

            {shareModalRoom && typeof document !== 'undefined' && createPortal(
                <div
                    className="modal-overlay"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setShareModalRoom(null)
                        }
                    }}
                >
                    <div
                        className="modal-content large"
                        style={{ padding: '1.5rem', overflowY: 'auto' }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <ShareLinkManager
                            roomId={shareModalRoom.id}
                            onClose={() => setShareModalRoom(null)}
                        />
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}
