import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { joinShare } from '@/api'
import { useAuthStore } from '@/stores'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from '@/components/ui'

export function SharePage() {
  const { shareToken } = useParams<{ shareToken: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { actorType, guestProfile, isInitialized, setGuestSession } = useAuthStore()
  const isSameGuestShareLink =
    actorType === 'guest' && !!guestProfile && guestProfile.shareToken === shareToken

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [isJoining, setIsJoining] = useState(false)
  const [joinError, setJoinError] = useState('')

  useEffect(() => {
    if (!isInitialized) return

    // Authenticated user — no need for a guest session
    if (actorType === 'user') {
      navigate('/rooms', { replace: true })
      return
    }

    // Existing valid guest session — go straight to the room
    if (isSameGuestShareLink && guestProfile) {
      navigate(`/room/${guestProfile.room.id}`, { replace: true })
    }
  }, [isInitialized, actorType, guestProfile, isSameGuestShareLink, navigate])

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!shareToken || !name.trim()) return

    setJoinError('')
    setIsJoining(true)
    try {
      const result = await joinShare(shareToken, {
        username: name.trim(),
        email: email.trim() || undefined,
      })
      setGuestSession(result.token, result.guest, result.room, shareToken)
      navigate(`/room/${result.room.id}`, { replace: true })
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : t('share.join.joinFailed'))
    } finally {
      setIsJoining(false)
    }
  }

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  // Still rendering while redirect is in-flight
  if (actorType === 'user' || isSameGuestShareLink) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('share.join.title')}</CardTitle>
          <CardDescription>{t('share.join.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleJoin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('share.join.nameLabel')}</Label>
              <Input
                id="displayName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('share.join.namePlaceholder')}
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{t('share.join.emailLabel')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('share.join.emailPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">{t('share.join.emailHint')}</p>
            </div>

            {joinError && <p className="text-sm text-destructive">{joinError}</p>}

            <Button type="submit" className="w-full" disabled={isJoining || !name.trim()}>
              {isJoining ? t('share.join.joining') : t('share.join.joinButton')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
