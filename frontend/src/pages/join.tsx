import { translateError } from '@/i18n/errors'
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Code2, Link as LinkIcon } from 'lucide-react'
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
    <div className="min-h-screen flex bg-muted/30">
      {/* Right side - Join form */}
      <div className="flex-1 flex items-center justify-center p-2">
        <Card className="w-full max-w-sm border-0 bg-transparent shadow-none">
          {/* Mobile branding */}
          <div className="flex items-center gap-1 px-2 pb-3">
            <Code2 className="h-5 w-5 text-foreground" />
            <span className="text-base font-semibold">ShareCode</span>
          </div>

          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{t('join.title')}</CardTitle>
              <div className="flex items-center gap-1">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="shareInput" className="block pb-1.5">{t('join.label')}</Label>
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

              {error && <p className="text-sm text-destructive">{translateError(error)}</p>}

              <Button type="submit" className="w-full" disabled={isJoining || !input.trim()}>
                {isJoining ? t('join.joining') : t('join.button')}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-2">
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
