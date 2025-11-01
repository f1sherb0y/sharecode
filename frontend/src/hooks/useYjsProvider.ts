import { useEffect, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

const resolveWebSocketUrl = (): string => {
    const explicit = import.meta.env.VITE_WS_URL
    if (explicit) {
        return explicit as string
    }

    const apiUrl = import.meta.env.VITE_API_URL as string | undefined
    if (apiUrl) {
        try {
            const url = new URL(apiUrl)
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
            url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`
            return url.toString()
        } catch (err) {
            console.warn('Invalid VITE_API_URL, falling back to window location for WebSocket URL.', err)
        }
    }

    if (typeof window !== 'undefined') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${window.location.host}/api/ws`
    }

    return 'ws://localhost:3001/api/ws'
}

const WS_URL = resolveWebSocketUrl()

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

        const hocuspocusProvider = new HocuspocusProvider({
            url: WS_URL,
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
