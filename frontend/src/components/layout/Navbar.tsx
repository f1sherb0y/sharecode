import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserMenu } from './UserMenu'
import { ThemeToggle } from '../common/ThemeToggle'
import { LanguageSwitcher } from '../common/LanguageSwitcher'

interface NavbarProps {
    title?: ReactNode
    leftContent?: ReactNode
    centerContent?: ReactNode
    rightContent?: ReactNode
    hideUserMenu?: boolean
    fullWidth?: boolean
    onTitleClick?: () => void
}

export function Navbar({
    title = "ShareCode",
    leftContent,
    centerContent,
    rightContent,
    hideUserMenu = false,
    fullWidth = false,
    onTitleClick
}: NavbarProps) {
    const navigate = useNavigate()

    const handleTitleClick = () => {
        if (onTitleClick) {
            onTitleClick()
        } else {
            navigate('/')
        }
    }

    return (
        <div className="room-topbar">
            <div className="room-topbar-inner" style={fullWidth ? { maxWidth: '100%' } : undefined}>
                <div className="flex items-center gap-4">
                    <div
                        className="room-topbar-title cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={handleTitleClick}
                    >
                        {typeof title === 'string' ? (
                            <span className="text-xl font-bold m-0 leading-none logo-text">
                                {title}
                            </span>
                        ) : (
                            title
                        )}
                    </div>
                    {leftContent}
                </div>

                {centerContent ? (
                    <div className="flex-1 flex items-center justify-center px-4 min-w-0">
                        {centerContent}
                    </div>
                ) : (
                    <div className="flex-1" />
                )}

                <div className="room-topbar-actions">
                    {rightContent}
                    <LanguageSwitcher />
                    <ThemeToggle />
                    {!hideUserMenu && (
                        <>
                            <div className="w-px h-4 bg-[var(--border)] mx-1" />
                            <UserMenu />
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
