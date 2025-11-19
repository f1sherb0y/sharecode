import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings, LogOut, Shield, User as UserIcon, ChevronDown } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import type { Role } from '../../types'

export function UserMenu() {
    const { t } = useTranslation()
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const [isOpen, setIsOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    // Check if running in Tauri desktop environment
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const formatUserRole = (role?: string) => {
        if (role === 'superuser') return t('common.superuser')
        if (role === 'admin') return t('common.admin')
        return null
    }

    if (!user) return null

    return (
        <div className="dropdown-container" ref={menuRef}>
            <button
                className={`user-menu-btn ${isOpen ? 'active' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
                aria-label={t('common.userMenu')}
            >
                <div
                    className="user-avatar"
                    style={{ backgroundColor: user.color || 'var(--accent)' }}
                >
                    {user.username ? user.username.substring(0, 2).toUpperCase() : <UserIcon size={20} />}
                </div>
                <ChevronDown size={16} style={{ color: 'var(--text-primary)' }} />
            </button>

            {isOpen && (
                <div className="dropdown-menu">
                    <div className="dropdown-header">
                        <div className="dropdown-user-info">
                            <span className="dropdown-username">{user.username}</span>
                            <span className="dropdown-role">{formatUserRole(user.role as Role) || t('common.user')}</span>
                        </div>
                    </div>
                    {(user.role === 'admin' || user.role === 'superuser') && (
                        <button
                            className="dropdown-item"
                            onClick={() => {
                                setIsOpen(false)
                                navigate('/admin')
                            }}
                        >
                            <Shield size={16} />
                            {t('common.admin')}
                        </button>
                    )}
                    {isTauri && (
                        <button
                            className="dropdown-item"
                            onClick={() => {
                                setIsOpen(false)
                                navigate('/settings')
                            }}
                        >
                            <Settings size={16} />
                            {t('common.settings')}
                        </button>
                    )}
                    <div className="dropdown-divider" />
                    <button
                        className="dropdown-item danger"
                        onClick={logout}
                    >
                        <LogOut size={16} />
                        {t('common.logout')}
                    </button>
                </div>
            )}
        </div>
    )
}
