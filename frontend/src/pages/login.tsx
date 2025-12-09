import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { useAuthStore } from '@/stores'
import { isTauriApp } from '@/lib/tauri'

const ALLOW_REGISTRATION = import.meta.env.VITE_ALLOW_REGISTRATION !== 'false'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuthStore()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const [joinLink, setJoinLink] = useState('')
  const [joinLinkError, setJoinLinkError] = useState('')
  const [isJoining, setIsJoining] = useState(false)

  const isTauri = isTauriApp()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      await login(username, password)
      navigate('/rooms')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setIsLoading(false)
    }
  }

  const parseShareLink = (link: string): { documentId: string; token: string } | null => {
    try {
      const url = new URL(link)

      // Hash-based route format (Tauri): #/room/{documentId}?share={token}
      if (url.hash) {
        const hashMatch = url.hash.match(/#\/room\/([^?]+)\?share=([^&]+)/)
        if (hashMatch) {
          return { documentId: hashMatch[1]!, token: hashMatch[2]! }
        }
      }

      // Path-based route format (Web): /room/{documentId}?share={token}
      const pathMatch = url.pathname.match(/\/room\/([^/?]+)/)
      if (pathMatch) {
        const searchParams = new URLSearchParams(url.search)
        const shareToken = searchParams.get('share')
        if (shareToken) {
          return { documentId: pathMatch[1]!, token: shareToken }
        }
      }

      return null
    } catch {
      return null
    }
  }

  const handleJoinLink = async (e: React.FormEvent) => {
    e.preventDefault()
    setJoinLinkError('')

    if (!joinLink.trim()) return

    setIsJoining(true)

    try {
      const parsed = parseShareLink(joinLink)
      if (!parsed) {
        setJoinLinkError(t('auth.login.joinLink.invalid'))
        return
      }
      navigate(`/room/${parsed.documentId}?share=${parsed.token}`)
    } catch (err) {
      setJoinLinkError(err instanceof Error ? err.message : 'Failed to parse link')
    } finally {
      setIsJoining(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-2xl">{t('auth.login.title')}</CardTitle>
            <div className="flex items-center gap-1">
              {isTauri && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigate('/settings')}
                  aria-label="Settings"
                >
                  <Settings className="h-5 w-5" />
                </Button>
              )}
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('auth.login.username')}</Label>
              <Input
                id="username"
                type="text"
                placeholder={t('auth.login.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.login.password')}</Label>
              <Input
                id="password"
                type="password"
                placeholder={t('auth.login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('auth.login.loggingIn') : t('auth.login.button')}
            </Button>
          </form>

          {ALLOW_REGISTRATION && (
            <p className="text-center text-sm text-muted-foreground mt-4">
              {t('auth.login.noAccount')}{' '}
              <Link to="/register" className="text-primary hover:underline">
                {t('auth.login.registerLink')}
              </Link>
            </p>
          )}

          {isTauri && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">
                    {t('auth.login.joinLink.title')}
                  </span>
                </div>
              </div>

              <form onSubmit={handleJoinLink} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="joinLink">{t('auth.login.joinLink.label')}</Label>
                  <Input
                    id="joinLink"
                    type="text"
                    placeholder={t('auth.login.joinLink.placeholder')}
                    value={joinLink}
                    onChange={(e) => {
                      setJoinLink(e.target.value)
                      setJoinLinkError('')
                    }}
                  />
                </div>
                {joinLinkError && <p className="text-sm text-destructive">{joinLinkError}</p>}
                <Button type="submit" variant="secondary" className="w-full" disabled={isJoining || !joinLink.trim()}>
                  {isJoining ? t('auth.login.joinLink.joining') : t('auth.login.joinLink.button')}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
