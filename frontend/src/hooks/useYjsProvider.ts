import { useEffect, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { getWebSocketUrl } from '../lib/api'

export function useYjsProvider(documentName: string, token: string) {
    const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
    const [ydoc] = useState(() => new Y.Doc())
    const [ytext] = useState(() => ydoc.getText('codemirror'))
    const [isConnected, setIsConnected] = useState(false)
    const [isSynced, setIsSynced] = useState(false)
    const providerRef = useRef<HocuspocusProvider | null>(null)

    useEffect(() => {
        // Don't connect if we don't have a valid documentName or token yet
        if (!documentName || !token) {
            return
        }

        // Get WebSocket URL with /api/ws path appended
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
            },
            onAuthenticationFailed: ({ reason }) => {
                console.error('Authentication failed:', reason)
            },
        })

        providerRef.current = hocuspocusProvider
        setProvider(hocuspocusProvider)

        return () => {
            hocuspocusProvider.destroy()
        }
    }, [documentName, token, ydoc])

    return {
        provider,
        ydoc,
        ytext,
        isConnected,
        isSynced,
    }
}
