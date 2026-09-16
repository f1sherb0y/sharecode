import { translateError } from '@/i18n/errors'
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings, Code2 } from 'lucide-react'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { useAuthStore } from '@/stores'
import { isTauriApp } from '@/lib/tauri'
import { parseShareToken } from '@/lib/share'

const ALLOW_REGISTRATION = import.meta.env.VITE_ALLOW_REGISTRATION !== 'false'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuthStore()

  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const [joinLink, setJoinLink] = useState('')
  const [joinLinkError, setJoinLinkError] = useState('')
  const [isJoining, setIsJoining] = useState(false)

  const isTauri = isTauriApp()

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    // Read DOM values: password managers can autofill without React change events.
    const fields = new FormData(e.currentTarget)
    const username = String(fields.get('username') ?? '')
    const password = String(fields.get('password') ?? '')
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
    const token = parseShareToken(link)
    return token ? { shareToken: token } : null
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
    <div className="min-h-screen flex bg-muted/30">
      {/* Right side - Login form */}
      <div className="flex-1 flex items-center justify-center p-2">
        <Card className="w-full max-w-sm border-0 bg-transparent shadow-none">
          {/* Mobile branding */}
          <div className="flex items-center gap-1 px-2 pb-3">
            <Code2 className="h-5 w-5 text-foreground" />
            <span className="text-base font-semibold">ShareCode</span>
          </div>

          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{t('auth.login.title')}</CardTitle>
              <div className="flex items-center gap-1">
                {isTauri && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate('/settings')}
                    aria-label={t('common.settings')}
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
            <form id="login-form" method="post" autoComplete="on" onSubmit={handleSubmit} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="username">{t('auth.login.username')}</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  type="text"
                  placeholder={t('auth.login.usernamePlaceholder')}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password">{t('auth.login.password')}</Label>
                <Input
                  id="password"
                  name="password"
                  autoComplete="current-password"
                  type="password"
                  placeholder={t('auth.login.passwordPlaceholder')}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{translateError(error)}</p>}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? t('auth.login.loggingIn') : t('auth.login.button')}
              </Button>
            </form>

            {ALLOW_REGISTRATION && (
              <p className="text-center text-sm text-muted-foreground mt-2">
                {t('auth.login.noAccount')}{' '}
                <Link to="/register" className="text-primary hover:underline">
                  {t('auth.login.registerLink')}
                </Link>
              </p>
            )}

            <p className="text-center text-sm text-muted-foreground mt-2">
              {t('auth.login.joinPrompt')}{' '}
              <Link to="/join" className="text-primary hover:underline">
                {t('auth.login.joinLinkLabel')}
              </Link>
            </p>

            {isTauri && (
              <>
                <div className="relative my-3">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-1.5 text-muted-foreground">
                      {t('auth.login.joinLink.title')}
                    </span>
                  </div>
                </div>

                <form onSubmit={handleJoinLink} className="space-y-2">
                  <div className="space-y-1">
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
                  {joinLinkError && <p className="text-sm text-destructive">{translateError(joinLinkError)}</p>}
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
