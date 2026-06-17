import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Code2, Users, Zap, Link as LinkIcon } from 'lucide-react'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { ThemeToggle, LanguageSwitcher } from '@/components/layout'
import { parseShareToken } from '@/lib/share'

export function JoinPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [isJoining, setIsJoining] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!input.trim()) return

    setIsJoining(true)
    try {
      const token = parseShareToken(input)
      if (!token) {
        setError(t('join.invalid'))
        return
      }
      // Reuse the existing share-page join flow (name/email entry happens there).
      navigate(`/s/${token}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('join.invalid'))
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
            {t('join.tagline')}
          </p>

          <div className="grid grid-cols-2 gap-4 text-left">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <Users className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <div className="font-medium text-sm">{t('join.featureCollaborateTitle')}</div>
                <div className="text-xs text-muted-foreground">{t('join.featureCollaborateDesc')}</div>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <Zap className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <div className="font-medium text-sm">{t('join.featureInstantTitle')}</div>
                <div className="text-xs text-muted-foreground">{t('join.featureInstantDesc')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right side - Join form */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          {/* Mobile branding */}
          <div className="lg:hidden flex items-center justify-center gap-2 pt-6 pb-2">
            <Code2 className="h-8 w-8 text-primary" />
            <span className="text-2xl font-bold">ShareCode</span>
          </div>

          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-2xl">{t('join.title')}</CardTitle>
              <div className="flex items-center gap-1">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="shareInput" className="block pb-2">{t('join.label')}</Label>
                <div className="relative">
                  <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="shareInput"
                    type="text"
                    className="pl-9"
                    placeholder={t('join.placeholder')}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value)
                      setError('')
                    }}
                    autoFocus
                  />
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" className="w-full" disabled={isJoining || !input.trim()}>
                {isJoining ? t('join.joining') : t('join.button')}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-4">
              {t('join.haveAccount')}{' '}
              <Link to="/login" className="text-primary hover:underline">
                {t('join.loginLink')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
