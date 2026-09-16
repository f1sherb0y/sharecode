import { Link } from 'react-router-dom'
import { Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from './theme-toggle'
import { LanguageSwitcher } from './language-switcher'
import { UserMenu } from './user-menu'
import { useAuthStore } from '@/stores'

interface NavbarProps {
  title?: string | null
  leftContent?: React.ReactNode
  centerContent?: React.ReactNode
  rightContent?: React.ReactNode
  fullWidth?: boolean
  showUser?: boolean
}

export function Navbar({
  title,
  leftContent,
  centerContent,
  rightContent,
  fullWidth = false,
  showUser = true,
}: NavbarProps) {
  const { user } = useAuthStore()

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background">
      <div className={cn('app-navbar flex h-9 items-center gap-1.5', fullWidth ? 'px-2' : 'app-container')}>
        {/* Left section */}
        <div className="flex items-center gap-2">
          {leftContent ?? (
            <Link to="/rooms" className="flex items-center gap-1 font-semibold">
              <Code2 className="h-5 w-5 text-foreground" />
              {title !== null && <span className="hidden sm:inline">{title ?? 'ShareCode'}</span>}
            </Link>
          )}
        </div>

        {/* Center section */}
        {centerContent && <div className="flex-1 flex justify-center">{centerContent}</div>}

        {/* Spacer when no center content */}
        {!centerContent && <div className="flex-1" />}

        {/* Right section */}
        <div className="flex items-center gap-1">
          {rightContent}
          <LanguageSwitcher />
          <ThemeToggle />
          {showUser && user && <UserMenu />}
        </div>
      </div>
    </header>
  )
}
