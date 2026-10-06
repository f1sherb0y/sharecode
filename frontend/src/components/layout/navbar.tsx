import { Link } from 'react-router-dom'
import { ArrowLeft, Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
            <Link to="/rooms" aria-label={title ?? 'ShareCode'} className="flex shrink-0 items-center gap-1.5 font-semibold leading-none">
              <Code2 className="h-7 w-7 shrink-0 text-foreground" aria-hidden="true" />
              {title !== null && <span className="hidden text-[1.125rem] sm:inline">{title ?? 'ShareCode'}</span>}
            </Link>
          )}
        </div>

        {/* Center section */}
        {centerContent && <div className="ui-page-title flex min-w-0 flex-1 justify-center [&>*]:truncate">{centerContent}</div>}

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

/** Back action for `leftContent`. On phones the label would crowd the page title,
 *  so it collapses to the arrow (as in the editor header) and stays the accessible name. */
export function NavbarBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" className="max-sm:size-control max-sm:p-0" onClick={onClick}>
      <ArrowLeft className="h-4 w-4 sm:mr-1.5" />
      <span className="max-sm:sr-only">{label}</span>
    </Button>
  )
}
