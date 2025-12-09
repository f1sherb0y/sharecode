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
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className={cn('flex h-14 items-center gap-4 px-4', !fullWidth && 'container')}>
        {/* Left section */}
        <div className="flex items-center gap-4">
          {leftContent ?? (
            <Link to="/rooms" className="flex items-center gap-2 font-semibold">
              <Code2 className="h-6 w-6 text-primary" />
              {title !== null && <span className="hidden sm:inline">{title ?? 'ShareCode'}</span>}
            </Link>
          )}
        </div>

        {/* Center section */}
        {centerContent && <div className="flex-1 flex justify-center">{centerContent}</div>}

        {/* Spacer when no center content */}
        {!centerContent && <div className="flex-1" />}

        {/* Right section */}
        <div className="flex items-center gap-2">
          {rightContent}
          <LanguageSwitcher />
          <ThemeToggle />
          {showUser && user && <UserMenu />}
        </div>
      </div>
    </header>
  )
}
