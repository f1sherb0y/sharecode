import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings, Code2, Users, Zap } from 'lucide-react'
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

  const parseShareLink = (link: string): { shareToken: string } | null => {
    try {
      const url = new URL(link)

      // Hash-based route format (Tauri): #/s/{shareToken}
      if (url.hash) {
        const hashMatch = url.hash.match(/#\/s\/([^/?]+)/)
        if (hashMatch) return { shareToken: hashMatch[1]! }
      }

      // Path-based route format (Web): /s/{shareToken}
      const pathMatch = url.pathname.match(/\/s\/([^/?]+)/)
      if (pathMatch) return { shareToken: pathMatch[1]! }

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
      navigate(`/s/${parsed.shareToken}`)
    } catch (err) {
      setJoinLinkError(err instanceof Error ? err.message : 'Failed to parse link')
    } finally {
      setIsJoining(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left side - Branding (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 bg-primary/5 dark:bg-primary/10 flex-col justify-center items-center p-12 relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-20 left-20 w-72 h-72 bg-primary/20 rounded-full blur-3xl" />
          <div className="absolute bottom-20 right-20 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        </div>

        <div className="relative z-10 max-w-md text-center">
          <div className="flex items-center justify-center gap-3 mb-6">
            <Code2 className="h-12 w-12 text-primary" />
            <h1 className="text-4xl font-bold">ShareCode</h1>
          </div>
          <p className="text-lg text-muted-foreground mb-8">
            Real-time collaborative code editing with live cursors, syntax highlighting, and session playback.
          </p>

          <div className="grid grid-cols-2 gap-4 text-left">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <Users className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <div className="font-medium text-sm">Collaborate</div>
                <div className="text-xs text-muted-foreground">Code together in real-time</div>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <Zap className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <div className="font-medium text-sm">Instant</div>
                <div className="text-xs text-muted-foreground">No setup required</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right side - Login form */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          {/* Mobile branding */}
          <div className="lg:hidden flex items-center justify-center gap-2 pt-6 pb-2">
            <Code2 className="h-8 w-8 text-primary" />
            <span className="text-2xl font-bold">ShareCode</span>
          </div>

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
    </div>
  )
}
