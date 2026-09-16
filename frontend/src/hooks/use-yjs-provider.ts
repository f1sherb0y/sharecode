import { useEffect, useState, useRef, useCallback } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getWebSocketUrl } from '@/api'
import type { RemoteUser } from '@/types'
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
  onStatelessMessage?: (message: StatelessMessage) => void) {
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
    let barrier: { id: string; version: number } | null = null
    let supportsPersistence = false
    let dirty = false
    let roomPending = true
    const doc = new Y.Doc()
    const wsBase = getWebSocketUrl()
    const url = wsBase.endsWith('/api/ws') ? wsBase : `${wsBase.replace(/\/$/, '')}/api/ws`

    const localStorageFailure = (error: unknown) => {
      if (!active) return
      setLocalRecoveryFailed(true)
      setStorageFailed(true)
      setSyncError(error instanceof Error ? error.message : 'Local recovery storage unavailable')
    }
    const sendBarrier = async () => {
      barrierTimer = undefined
      if (!active || revoked || !supportsPersistence || !connection?.isAuthenticated || !connection.synced || !journal || barrier) return
      try {
        await journal.flush()
        if (!active || revoked || !connection.isAuthenticated) return
        barrier = { id: crypto.randomUUID(), version: journal.currentVersion }
        connection.sendStateless(JSON.stringify({ type: 'durability-barrier', id: barrier.id }))
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
      while (dirty || roomPending || !supportsPersistence) {
        if (!active || revoked || !connection?.isAuthenticated || Date.now() > deadline) throw new Error('Document not saved')
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
        journal = await PendingDocument.open(url, documentName, token)
        if (!active) { await journal.close(); return }
        dirty = journal.hasPending
        setPending(dirty)
        doc.on('update', recordUpdate)
        connection = new HocuspocusProvider({
          url, name: documentName, document: doc, token,
          onStatus: ({ status }) => {
            if (!active) return
            setConnected(status === 'connected')
            if (status !== 'connected') {
              setAuthenticated(false); setSynced(false); setProtocolReady(false); setOnlineUsers([])
              supportsPersistence = false; barrier = null; roomPending = true; setServerPending(true)
            }
          },
          onAuthenticated: ({ scope }) => {
            if (!active) return
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
              connection?.sendStateless(JSON.stringify({ type: 'presence', clientId: doc.clientID }))
              scheduleBarrier()
            }
          },
          onAuthenticationFailed: () => {
            if (!active) return
            revoked = true; setAuthenticated(false); setCanWrite(false)
            setSyncError('accessDenied')
            queueMicrotask(() => connection?.disconnect())
          },
          onClose: ({ event }) => {
            if (!active || event.code !== 4403) return
            if (event.reason === 'Access revoked') {
              revoked = true; setAuthenticated(false); setCanWrite(false); setSyncError('accessRevoked')
              queueMicrotask(() => connection?.disconnect())
            }
          },
          onStateless: ({ payload }) => {
            if (!active) return
            try {
              const message = JSON.parse(payload) as StatelessMessage
              if (message.type === 'presence-state' && Array.isArray(message.members)) {
                setOnlineUsers(message.members as RemoteUser[])
              } else if (message.type === 'access-revoked') {
                revoked = true; setAuthenticated(false); setCanWrite(false); setSyncError('accessRevoked')
                queueMicrotask(() => connection?.disconnect())
              } else if (message.type === 'persistence-status') {
                supportsPersistence = message.protocol === 1
                setProtocolReady(supportsPersistence)
                roomPending = Number(message.pending) > 0
                setServerPending(roomPending)
                setStorageFailed(message.failed === true)
                if (!roomPending && !barrier && (dirty || !supportsPersistence)) scheduleBarrier()
              } else if (message.type === 'durability-ack' && barrier && barrier.id === message.id && journal) {
                const version = barrier.version
                barrier = null
                void journal.acknowledge(version).then(() => {
                  if (!active || !journal) return
                  dirty = journal.hasPending; setPending(dirty)
                  if (dirty) scheduleBarrier()
                }).catch(localStorageFailure)
              }
              onStatelessRef.current?.(message)
            } catch (error) { console.error('Invalid collaboration control message', error) }
          },
        })
        setProvider(connection); setYdoc(doc)
      } catch (error) { localStorageFailure(error) }
    })()

    return () => {
      window.dispatchEvent(new Event('sharecode:flush'))
      active = false
      window.removeEventListener('beforeunload', beforeUnload)
      if (barrierTimer) clearTimeout(barrierTimer)
      doc.off('update', recordUpdate)
      connection?.destroy()
      doc.destroy()
      void journal?.close().catch(() => {})
      setProvider(null); setYdoc(null); setConnected(false); setSynced(false)
      setAuthenticated(false); setCanWrite(false); setProtocolReady(false)
      setSyncError(''); setStorageFailed(false); setLocalRecoveryFailed(false)
    }
  }, [documentName, token])

  const identityMatches = provider?.configuration.name === documentName && provider.configuration.token === token
  return {
    provider: identityMatches ? provider : null,
    ydoc: identityMatches ? ydoc : null,
    ytext: identityMatches ? ydoc?.getText('codemirror') ?? null : null,
    ymeta: identityMatches ? ydoc?.getMap('meta') ?? null : null,
    isConnected, isSynced, syncError, storageFailed, onlineUsers, waitForSaved,
    canWrite: !!identityMatches && isConnected && isAuthenticated && isSynced && protocolReady && canWrite && !storageFailed && !localRecoveryFailed && !syncError,
    isSaved: isConnected && isAuthenticated && isSynced && protocolReady && !hasPending && !serverPending && !storageFailed,
  }
}
