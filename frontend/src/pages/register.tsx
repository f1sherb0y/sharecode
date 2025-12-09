import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { useAuthStore } from '@/stores'
import { api } from '@/api'

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
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
                    required
                  />
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
  )
}
