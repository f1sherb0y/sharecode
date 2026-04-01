import { useEffect, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getWebSocketUrl } from '@/api'
import {
  LINE_ENDING_NORMALIZATION_ORIGIN,
  normalizeYTextLineEndings,
} from '@/lib/line-endings'

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
  const [ydoc] = useState(() => new Y.Doc())
  const [ytext] = useState(() => ydoc.getText('codemirror'))
  const [ymeta] = useState(() => ydoc.getMap('meta'))
  const [isConnected, setIsConnected] = useState(false)
  const [isSynced, setIsSynced] = useState(false)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const onStatelessRef = useRef(onStatelessMessage)

  // Keep the callback ref updated
  useEffect(() => {
    onStatelessRef.current = onStatelessMessage
  }, [onStatelessMessage])

  useEffect(() => {
    if (!documentName || !token) return

    const wsBaseUrl = getWebSocketUrl()
    const wsUrl = wsBaseUrl.endsWith('/api/ws')
      ? wsBaseUrl
      : `${wsBaseUrl.replace(/\/$/, '')}/api/ws`

    const hocuspocusProvider = new HocuspocusProvider({
      url: wsUrl,
      name: documentName,
      document: ydoc,
      token,
      onStatus: ({ status }) => {
        setIsConnected(status === 'connected')
      },
      onSynced: ({ state }) => {
        setIsSynced(state)
        if (state) {
          normalizeYTextLineEndings(ytext)
        }
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

    providerRef.current = hocuspocusProvider
    setProvider(hocuspocusProvider)

    return () => {
      hocuspocusProvider.destroy()
    }
  }, [documentName, token, ydoc])

  useEffect(() => {
    const handleTextChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === LINE_ENDING_NORMALIZATION_ORIGIN) {
        return
      }

      normalizeYTextLineEndings(ytext)
    }

    normalizeYTextLineEndings(ytext)
    ytext.observe(handleTextChange)

    return () => {
      ytext.unobserve(handleTextChange)
    }
  }, [ytext])

  return {
    provider,
    ydoc,
    ytext,
    ymeta,
    isConnected,
    isSynced,
  }
}
