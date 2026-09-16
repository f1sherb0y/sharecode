import { translateError } from '@/i18n/errors'
import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Code2 } from 'lucide-react'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { useAuthStore } from '@/stores'
import { api } from '@/api'
import { validatePasswordPolicy } from '@/lib/password-policy'

export function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { register } = useAuthStore()

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    // Read DOM values: password managers can autofill without React change events.
    const fields = new FormData(e.currentTarget)
    const username = String(fields.get('username') ?? '')
    const password = String(fields.get('password') ?? '')
    const email = String(fields.get('email') ?? '')
    setError('')

    if (!validatePasswordPolicy(password)) {
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
    <div className="min-h-screen flex bg-muted/30">
      {/* Right side - Register form */}
      <div className="flex-1 flex items-center justify-center p-2">
        <Card className="w-full max-w-sm border-0 bg-transparent shadow-none">
          {/* Mobile branding */}
          <div className="flex items-center gap-1 px-2 pb-3">
            <Code2 className="h-5 w-5 text-foreground" />
            <span className="text-base font-semibold">ShareCode</span>
          </div>

          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{t('auth.register.title')}</CardTitle>
              <div className="flex items-center gap-1">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!registrationAllowed ? (
              <div className="text-center">
                <p className="text-muted-foreground mb-2">{t('auth.register.disabled')}</p>
                <Link to="/login">
                  <Button variant="outline">{t('auth.register.loginLink')}</Button>
                </Link>
              </div>
            ) : (
              <>
                <form id="register-form" method="post" autoComplete="on" onSubmit={handleSubmit} className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="username">{t('auth.register.username')}</Label>
                    <Input
                      id="username"
                      name="username"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      type="text"
                      placeholder={t('auth.register.usernamePlaceholder')}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="email">{t('auth.register.email')}</Label>
                    <Input
                      id="email"
                      name="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      type="email"
                      placeholder={t('auth.register.emailPlaceholder')}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="password">{t('auth.register.password')}</Label>
                    <Input
                      id="password"
                      name="password"
                      autoComplete="new-password"
                      type="password"
                      placeholder={t('auth.register.passwordPlaceholder')}
                      minLength={10}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('common.passwordPolicyHint')}
                    </p>
                  </div>
                  {error && <p className="text-sm text-destructive">{translateError(error)}</p>}
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? t('auth.register.registering') : t('auth.register.button')}
                  </Button>
                </form>
                <p className="text-center text-sm text-muted-foreground mt-2">
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
