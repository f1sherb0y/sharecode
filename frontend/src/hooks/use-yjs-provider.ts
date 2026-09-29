import { useEffect, useState, useRef, useCallback } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getWebSocketUrl } from '@/api'
import type { RemoteUser } from '@/types'
import { ensureFreshSession, tokenExpiry, tokenIdentity } from '@/lib/session-renewal'
import { PendingDocument } from '@/lib/pending-document'

export interface StatelessMessage {
  type: string
  status?: string
  endedAt?: string
  slot?: number
  color?: string
  colorLight?: string
  [key: string]: unknown
}

export function useYjsProvider(documentName: string, token: string,
  onStatelessMessage?: (message: StatelessMessage) => void, sessionId?: string | null) {
  const identity = sessionId || token
  const tokenRef = useRef(token)
  tokenRef.current = token
  const [providerIdentity, setProviderIdentity] = useState('')
  const [onlineUsers, setOnlineUsers] = useState<RemoteUser[]>([])
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null)
  const [isConnected, setConnected] = useState(false)
  const [isSynced, setSynced] = useState(false)
  const [isAuthenticated, setAuthenticated] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [hasPending, setPending] = useState(false)
  const [serverPending, setServerPending] = useState(true)
  const [storageFailed, setStorageFailed] = useState(false)
  const [protocolReady, setProtocolReady] = useState(false)
  const [localRecoveryFailed, setLocalRecoveryFailed] = useState(false)
  const [syncError, setSyncError] = useState('')
  const waitForSavedRef = useRef<() => Promise<void>>(async () => { throw new Error('Not connected') })
  const waitForSaved = useCallback(() => waitForSavedRef.current(), [])
  const onStatelessRef = useRef(onStatelessMessage)
  onStatelessRef.current = onStatelessMessage

  useEffect(() => {
    if (!documentName || !token) return
    let active = true
    let revoked = false
    let journal: PendingDocument | undefined
    let connection: HocuspocusProvider | undefined
    let barrierTimer: ReturnType<typeof setTimeout> | undefined
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined
    let barrier: { id: string; version: number; retries: number } | null = null
    let connectionEpoch = 0
    let sentToken = token
    let recoveringAuth = false
    let recoveryRunning = false
    let recoveryDelay = 1000
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined
    let supportsPersistence = false
    let dirty = false
    let roomPending = true
    const doc = new Y.Doc()
    const wsBase = getWebSocketUrl()
    const url = wsBase.endsWith('/api/ws') ? wsBase : `${wsBase.replace(/\/$/, '')}/api/ws`

    const clearBarrier = () => {
      if (barrierTimer) clearTimeout(barrierTimer)
      if (barrierTimeout) clearTimeout(barrierTimeout)
      barrierTimer = undefined; barrierTimeout = undefined; barrier = null
    }
    const stopRecovery = () => {
      recoveringAuth = false
      if (recoveryTimer) clearTimeout(recoveryTimer)
      recoveryTimer = undefined
    }
    const denyAccess = (error: string) => {
      revoked = true
      stopRecovery(); clearBarrier()
      setAuthenticated(false); setCanWrite(false); setSyncError(error)
      queueMicrotask(() => { if (active) connection?.disconnect() })
    }
    const recoverAuthentication = async () => {
      if (!active || revoked || !recoveringAuth || recoveryRunning) return
      if (recoveryTimer) clearTimeout(recoveryTimer)
      recoveryTimer = undefined
      recoveryRunning = true
      try {
        const fresh = await ensureFreshSession({ throwOnFailure: true })
        if (!active || revoked || !recoveringAuth) return
        if (fresh && (tokenExpiry(fresh) ?? 0) > Date.now() / 1000) {
          tokenRef.current = fresh
          // disconnect() initiates an asynchronous close. connect() is a no-op
          // until its status changes, so keep retrying until close has completed.
          if (connection?.configuration.websocketProvider.status === 'disconnected') {
            stopRecovery()
            void connection.connect().catch(() => {})
            return
          }
        }
      } catch (error) {
        if (!active || revoked) return
        const status = (error as { status?: number })?.status
        if (status === 401 || status === 403) { denyAccess('sessionExpired'); return }
      } finally { recoveryRunning = false }
      if (active && !revoked && recoveringAuth) {
        recoveryTimer = setTimeout(() => { void recoverAuthentication() }, recoveryDelay)
        recoveryDelay = Math.min(recoveryDelay * 2, 30_000)
      }
    }
    const resumeAuthentication = () => { void recoverAuthentication() }
    const onVisible = () => { if (document.visibilityState === 'visible') resumeAuthentication() }
    window.addEventListener('online', resumeAuthentication)
    document.addEventListener('visibilitychange', onVisible)

    const localStorageFailure = (error: unknown) => {
      if (!active) return
      setLocalRecoveryFailed(true)
      setStorageFailed(true)
      setSyncError(error instanceof Error ? error.message : 'Local recovery storage unavailable')
    }
    const transmitBarrier = (request: NonNullable<typeof barrier>) => {
      if (!active || revoked || barrier !== request || !connection?.isAuthenticated || !connection.synced) return
      connection.sendStateless(JSON.stringify({ type: 'durability-barrier', id: request.id }))
      barrierTimeout = setTimeout(() => {
        barrierTimeout = undefined
        if (!active || revoked || barrier !== request) return
        if (++request.retries < 2) transmitBarrier(request)
        else {
          // A fresh handshake resends the document before requesting durability.
          // Keep the outbox until a matching acknowledgement actually arrives.
          connection?.configuration.websocketProvider.webSocket?.close()
        }
      }, 5000)
    }
    const sendBarrier = async () => {
      barrierTimer = undefined
      if (!active || revoked || !supportsPersistence || !connection?.isAuthenticated || !connection.synced || !journal || barrier) return
      const epoch = connectionEpoch
      const request = { id: crypto.randomUUID(), version: 0, retries: 0 }
      barrier = request // Reserve before awaiting IndexedDB; only one request may be in flight.
      try {
        await journal.flush()
        if (!active || revoked || epoch !== connectionEpoch || barrier !== request || !connection.isAuthenticated || !connection.synced) return
        request.version = connection.authorizedScope === 'read-write' ? journal.currentVersion : 0
        transmitBarrier(request)
      } catch (error) { localStorageFailure(error) }
    }
    const scheduleBarrier = () => {
      if (!barrierTimer && !barrier) barrierTimer = setTimeout(() => { void sendBarrier() }, 50)
    }
    const recordUpdate = (update: Uint8Array, origin: unknown) => {
      if (!active || !journal || origin === journal || connection?.authorizedScope !== 'read-write') return
      dirty = true
      setPending(true)
      void journal.append(update).then(scheduleBarrier).catch(localStorageFailure)
    }
    waitForSavedRef.current = async () => {
      const deadline = Date.now() + 15_000
      while (dirty || roomPending || !supportsPersistence || !connection?.isAuthenticated || !connection.synced) {
        if (!active || revoked || Date.now() > deadline) throw new Error('Document not saved')
        scheduleBarrier()
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || roomPending) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)

    void (async () => {
      try {
        journal = await PendingDocument.open(url, documentName, identity)
        if (!active) { await journal.close(); return }
        dirty = journal.hasPending
        setPending(dirty)
        doc.on('update', recordUpdate)
        connection = new HocuspocusProvider({
          url, name: documentName, document: doc,
          token: async () => {
            const previous = tokenRef.current
            const fresh = await ensureFreshSession()
            if (active && fresh && tokenRef.current === previous) tokenRef.current = fresh
            sentToken = active ? tokenRef.current : ''
            return sentToken
          },
          onStatus: ({ status }) => {
            if (!active) return
            setConnected(status === 'connected')
            if (status !== 'connected') {
              connectionEpoch++
              // The provider's forced watchdog close skips its normal onClose.
              // Reset both state machines so the next SyncStep2 emits synced.
              if (connection) { connection.synced = false; connection.isAuthenticated = false }
              setAuthenticated(false); setSynced(false); setProtocolReady(false); setOnlineUsers([])
              supportsPersistence = false; clearBarrier(); roomPending = true; setServerPending(true)
            }
          },
          onAuthenticated: ({ scope }) => {
            if (!active || revoked) return
            stopRecovery(); recoveryDelay = 1000
            setSyncError(previous => previous === 'sessionExpired' ? '' : previous)
            setAuthenticated(true); setCanWrite(scope === 'read-write')
            if (scope === 'read-write') journal?.restore(doc)
            else if (journal?.hasPending) {
              // Preserve unconfirmed edits from a previous writable session;
              // never silently discard or send them with a read-only grant.
              setSyncError('pendingReadOnly')
            }
          },
          onSynced: ({ state }) => {
            if (!active) return
            setSynced(state)
            if (state) {
              connection?.sendStateless(JSON.stringify({ type: 'presence', clientId: connection.awareness?.clientID ?? doc.clientID }))
              scheduleBarrier()
            }
          },
          onAuthenticationFailed: ({ reason }) => {
            if (!active) return
            const expired = (tokenExpiry(sentToken) ?? Infinity) <= Date.now() / 1000
            if (/expired|Invalid token/i.test(reason) && expired && tokenIdentity(sentToken).type === 'user') {
              recoveringAuth = true
              // A transient renewal failure must keep the editor mounted.
              // Only a definitive denial below becomes a terminal UI error.
              setAuthenticated(false); setCanWrite(false)
              clearBarrier()
              queueMicrotask(() => {
                if (!active || revoked) return
                connection?.disconnect()
                void recoverAuthentication()
              })
            } else denyAccess(/expired|Invalid token/i.test(reason) ? 'sessionExpired' : 'accessDenied')
          },
          onClose: ({ event }) => {
            if (!active || event.code !== 4403) return
            if (event.reason === 'Access revoked') {
              denyAccess('accessRevoked')
            }
          },
          onStateless: ({ payload }) => {
            if (!active) return
            try {
              const message = JSON.parse(payload) as StatelessMessage
              if (message.type === 'presence-state' && Array.isArray(message.members)) {
                setOnlineUsers(message.members as RemoteUser[])
              } else if (message.type === 'access-revoked') {
                denyAccess('accessRevoked')
              } else if (message.type === 'heartbeat' && ((dirty && connection?.authorizedScope === 'read-write') || roomPending || !supportsPersistence)) {
                scheduleBarrier()
              } else if (message.type === 'persistence-status') {
                supportsPersistence = message.protocol === 1
                setProtocolReady(supportsPersistence)
                roomPending = Number(message.pending) > 0
                setServerPending(roomPending)
                setStorageFailed(message.failed === true)
                if (!roomPending && !barrier && ((dirty && connection?.authorizedScope === 'read-write') || !supportsPersistence)) scheduleBarrier()
              } else if (message.type === 'durability-ack' && barrier && barrier.id === message.id && journal) {
                const version = barrier.version
                clearBarrier()
                void journal.acknowledge(version).then(() => {
                  if (!active || !journal) return
                  dirty = journal.hasPending; setPending(dirty)
                  if (dirty && connection?.authorizedScope === 'read-write') scheduleBarrier()
                }).catch(localStorageFailure)
              }
              onStatelessRef.current?.(message)
            } catch (error) { console.error('Invalid collaboration control message', error) }
          },
        })
        setProviderIdentity(identity); setProvider(connection); setYdoc(doc)
      } catch (error) { localStorageFailure(error) }
    })()

    return () => {
      window.dispatchEvent(new Event('sharecode:flush'))
      active = false
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('online', resumeAuthentication)
      document.removeEventListener('visibilitychange', onVisible)
      stopRecovery(); clearBarrier()
      doc.off('update', recordUpdate)
      connection?.destroy()
      doc.destroy()
      void journal?.close().catch(() => {})
      setProvider(null); setYdoc(null); setConnected(false); setSynced(false)
      setAuthenticated(false); setCanWrite(false); setProtocolReady(false)
      setSyncError(''); setStorageFailed(false); setLocalRecoveryFailed(false)
    }
  }, [documentName, identity])

  useEffect(() => {
    if (provider && providerIdentity === identity && provider.isAuthenticated) void provider.sendToken()
  }, [token])


  const identityMatches = provider?.configuration.name === documentName && providerIdentity === identity
  return {
    provider: identityMatches ? provider : null,
    ydoc: identityMatches ? ydoc : null,
    ytext: identityMatches ? ydoc?.getText('codemirror') ?? null : null,
    ymeta: identityMatches ? ydoc?.getMap('meta') ?? null : null,
    isConnected, isSynced, syncError, storageFailed, onlineUsers, waitForSaved,
    canWrite: !!identityMatches && isConnected && isAuthenticated && isSynced && protocolReady && canWrite && !storageFailed && !localRecoveryFailed && !syncError,
    isSaved: isConnected && isAuthenticated && isSynced && protocolReady && !hasPending && !serverPending && !storageFailed && !localRecoveryFailed && !syncError,
  }
}
