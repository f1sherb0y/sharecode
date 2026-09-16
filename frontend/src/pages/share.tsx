import { translateError } from '@/i18n/errors'
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, joinShare } from '@/api'
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
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])

  useEffect(() => {
    if (!isInitialized) return

    // Authenticated user — no need for a guest session
    if (actorType === 'user') {
      if (!shareToken) return
      const abort = new AbortController()
      api.acceptShareLink(shareToken, abort.signal).then(({ roomId }) => {
        if (!abort.signal.aborted) navigate(`/room/${roomId}`, { replace: true })
      }).catch((error) => {
        if (!abort.signal.aborted) setJoinError(error instanceof Error ? error.message : t('share.join.joinFailed'))
      })
      return () => abort.abort()
    }

    // Existing valid guest session — go straight to the room
    if (isSameGuestShareLink && guestProfile) {
      navigate(`/room/${guestProfile.room.id}`, { replace: true })
    }
  }, [isInitialized, actorType, guestProfile, isSameGuestShareLink, shareToken, navigate, t])

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
      if (!active.current) return
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

  if (joinError && actorType === 'user') {
    return <div className="flex flex-col items-center justify-center min-h-screen gap-2">
      <p role="alert">{translateError(joinError)}</p>
      <Button onClick={() => navigate('/rooms')}>{t('common.back')}</Button>
    </div>
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
    <div className="flex items-center justify-center min-h-screen p-2">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('share.join.title')}</CardTitle>
          <CardDescription>{t('share.join.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleJoin} className="space-y-2">
            <div className="space-y-1">
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

            <div className="space-y-1">
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

            {joinError && <p className="text-sm text-destructive">{translateError(joinError)}</p>}

            <Button type="submit" className="w-full" disabled={isJoining || !name.trim()}>
              {isJoining ? t('share.join.joining') : t('share.join.joinButton')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
