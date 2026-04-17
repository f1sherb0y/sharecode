import { useEffect, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getWebSocketUrl } from '@/api'

export interface StatelessMessage {
  type: string
  status?: string
  endedAt?: string
  [key: string]: unknown
}

export function useYjsProvider(
  documentName: string,
  token: string,
  onStatelessMessage?: (message: StatelessMessage) => void
) {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
  // ydoc/ytext/ymeta are created INSIDE the effect — one fresh Y.Doc per
  // (documentName, token) pair. Previously we held a single Y.Doc across the
  // hook's lifetime, which meant navigating /room/A → /room/B reused the doc
  // that already held room A's CRDT state; room B's server state merged into
  // it and Monaco/tldraw kept showing room A's content.
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null)
  const [ytext, setYtext] = useState<Y.Text | null>(null)
  const [ymeta, setYmeta] = useState<Y.Map<unknown> | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isSynced, setIsSynced] = useState(false)
  const onStatelessRef = useRef(onStatelessMessage)

  useEffect(() => {
    onStatelessRef.current = onStatelessMessage
  }, [onStatelessMessage])

  useEffect(() => {
    if (!documentName || !token) return

    const doc = new Y.Doc()
    const text = doc.getText('codemirror')
    const meta = doc.getMap('meta')
    setYdoc(doc)
    setYtext(text)
    setYmeta(meta)

    const wsBaseUrl = getWebSocketUrl()
    const wsUrl = wsBaseUrl.endsWith('/api/ws')
      ? wsBaseUrl
      : `${wsBaseUrl.replace(/\/$/, '')}/api/ws`

    const hocuspocusProvider = new HocuspocusProvider({
      url: wsUrl,
      name: documentName,
      document: doc,
      token,
      onStatus: ({ status }) => {
        setIsConnected(status === 'connected')
      },
      onSynced: ({ state }) => {
        setIsSynced(state)
      },
      onAuthenticationFailed: ({ reason }) => {
        console.error('Authentication failed:', reason)
      },
      onStateless: ({ payload }) => {
        try {
          const message = JSON.parse(payload) as StatelessMessage
          onStatelessRef.current?.(message)
        } catch (err) {
          console.error('Failed to parse stateless message:', err)
        }
      },
    })

    setProvider(hocuspocusProvider)

    return () => {
      setProvider(null)
      setYdoc(null)
      setYtext(null)
      setYmeta(null)
      setIsConnected(false)
      setIsSynced(false)
      hocuspocusProvider.destroy()
      doc.destroy()
    }
  }, [documentName, token])

  return {
    provider,
    ydoc,
    ytext,
    ymeta,
    isConnected,
    isSynced,
  }
}
