import { useEffect, useState, useRef } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:1234'

export function useYjsProvider(documentName: string, token: string) {
    const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
    const [ydoc] = useState(() => new Y.Doc())
    const [ytext] = useState(() => ydoc.getText('codemirror'))
    const [isConnected, setIsConnected] = useState(false)
    const [isSynced, setIsSynced] = useState(false)
    const providerRef = useRef<HocuspocusProvider | null>(null)

    useEffect(() => {
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
