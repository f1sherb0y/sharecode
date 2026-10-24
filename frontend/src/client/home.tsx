import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Link as LinkIcon } from 'lucide-react'
import { ShareCodeLogo } from '@/components/share-code-logo'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui'
import { parseShareToken } from '@/lib/share'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from './connection'
import { SERVER_NODES, nodeHost } from './nodes'

export type HomeNotice = 'expired' | 'unreachable' | null

/** Session links made for a customer carry their name (`?name=`), which the share page pre-fills. */
function invitedName(input: string): string | null {
  try {
    const url = new URL(input.trim())
    const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?')) : ''
    return url.searchParams.get('name') ?? new URLSearchParams(hashQuery).get('name')
  } catch {
    return null
  }
}

export function ClientHome({ notice }: { notice: HomeNotice }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { connect, isConnecting, probes, server } = useConnectionStore()
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  // Stays on until the share page replaces this screen.
  const [isJoining, setIsJoining] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    const token = parseShareToken(input)
    if (!token) {
      setError(t('join.invalid'))
      return
    }

    setIsJoining(true)
    try {
      await connect()
    } catch {
      setError(t('client.unreachable'))
      setIsJoining(false)
      return
    }

    // The share page waits for the session check; it runs against the node chosen above.
    void useAuthStore.getState().initialize()
    const name = invitedName(input)
    navigate(`/s/${encodeURIComponent(token)}${name ? `?${new URLSearchParams({ name })}` : ''}`)
  }

  const shownNotice = error || (notice === 'expired' ? t('client.sessionExpired') : notice === 'unreachable' ? t('client.unreachable') : '')
  const hasProbes = Object.keys(probes).length > 0

  return (
    <div className="flex flex-1 items-center justify-center p-2">
      <Card className="w-full max-w-sm border-0 bg-transparent shadow-none">
        <div className="flex items-center gap-1 px-2 pb-3">
          <ShareCodeLogo className="h-5 w-5" />
          <span className="text-base font-semibold">ShareCode</span>
        </div>

        <CardHeader>
          <CardTitle className="text-lg">{t('join.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="shareInput">{t('join.label')}</Label>
              <div className="relative">
                <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="shareInput"
                  type="text"
                  className="pl-9"
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value)
                    setError('')
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </div>

            {shownNotice && <p role="alert" className="text-sm text-destructive">{shownNotice}</p>}

            <Button type="submit" className="w-full" disabled={isJoining || isConnecting || !input.trim()}>
              {isConnecting ? t('client.connecting') : isJoining ? t('join.joining') : t('join.button')}
            </Button>
          </form>

          {hasProbes && (
            <ul className="mt-3 space-y-1 text-xs" aria-label={t('client.servers')}>
              {SERVER_NODES.map((node) => {
                const probe = probes[node]
                const isChosen = !isConnecting && server?.node === node
                return (
                  <li key={node} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          probe?.status === 'ok' && 'bg-success',
                          probe?.status === 'testing' && 'animate-pulse bg-muted-foreground',
                          probe?.status === 'unreachable' && 'bg-destructive'
                        )}
                      />
                      <span className={cn('truncate', isChosen && 'font-medium text-foreground')}>{nodeHost(node)}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {probe?.status === 'testing' && t('client.nodeTesting')}
                      {probe?.status === 'unreachable' && t('client.nodeUnreachable')}
                      {probe?.status === 'ok' &&
                        (isChosen
                          ? t('client.nodeChosen', { ms: probe.latencyMs })
                          : t('client.nodeLatency', { ms: probe.latencyMs }))}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
