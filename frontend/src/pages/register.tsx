import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Code2, Users, Zap } from 'lucide-react'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { useAuthStore } from '@/stores'
import { api } from '@/api'
import { validatePasswordPolicy } from '@/lib/password-policy'

export function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { register } = useAuthStore()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [registrationAllowed, setRegistrationAllowed] = useState(true)
  const [isCheckingStatus, setIsCheckingStatus] = useState(true)
  const isPasswordValid = validatePasswordPolicy(password)

  useEffect(() => {
    const checkRegistrationStatus = async () => {
      try {
        const { allowRegistration } = await api.getRegistrationStatus()
        setRegistrationAllowed(allowRegistration)
      } catch {
        setRegistrationAllowed(true)
      } finally {
        setIsCheckingStatus(false)
      }
    }
    checkRegistrationStatus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isPasswordValid) {
      setError(t('common.passwordPolicyError'))
      return
    }

    setIsLoading(true)

    try {
      await register(username, password, email || undefined)
      navigate('/rooms')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setIsLoading(false)
    }
  }

  if (isCheckingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
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

      {/* Right side - Register form */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          {/* Mobile branding */}
          <div className="lg:hidden flex items-center justify-center gap-2 pt-6 pb-2">
            <Code2 className="h-8 w-8 text-primary" />
            <span className="text-2xl font-bold">ShareCode</span>
          </div>

          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-2xl">{t('auth.register.title')}</CardTitle>
              <div className="flex items-center gap-1">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!registrationAllowed ? (
              <div className="text-center">
                <p className="text-muted-foreground mb-4">{t('auth.register.disabled')}</p>
                <Link to="/login">
                  <Button variant="outline">{t('auth.register.loginLink')}</Button>
                </Link>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username">{t('auth.register.username')}</Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder={t('auth.register.usernamePlaceholder')}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('auth.register.email')}</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('auth.register.emailPlaceholder')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">{t('auth.register.password')}</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder={t('auth.register.passwordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={10}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('common.passwordPolicyHint')}
                    </p>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? t('auth.register.registering') : t('auth.register.button')}
                  </Button>
                </form>
                <p className="text-center text-sm text-muted-foreground mt-4">
                  {t('auth.register.hasAccount')}{' '}
                  <Link to="/login" className="text-primary hover:underline">
                    {t('auth.register.loginLink')}
                  </Link>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
