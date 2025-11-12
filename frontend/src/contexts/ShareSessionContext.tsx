import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getGuestSession } from '../lib/shareApi'
import type { ShareSession, ShareGuest, ShareRoomDetails } from '../types'
import { ShareJoin } from '../components/ShareJoin'

interface ShareSessionContextValue {
    shareToken: string
    roomId?: string
    session: ShareSession | null
    isLoading: boolean
    setSession: (session: ShareSession) => void
    clearSession: () => void
    refreshSession: () => Promise<void>
}

const ShareSessionContext = createContext<ShareSessionContextValue | undefined>(undefined)

function getStorageKey(shareToken: string) {
    return `share_session_${shareToken}`
}

function loadSessionFromStorage(shareToken: string): ShareSession | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(getStorageKey(shareToken))
        if (!raw) return null
        return JSON.parse(raw) as ShareSession
    } catch (error) {
        console.error('Failed to parse share session from storage', error)
        return null
    }
}

function persistSession(shareToken: string, session: ShareSession | null) {
    if (typeof window === 'undefined') return
    const key = getStorageKey(shareToken)
    if (session) {
        window.localStorage.setItem(key, JSON.stringify(session))
    } else {
        window.localStorage.removeItem(key)
    }
}

export function ShareSessionProvider({
    shareToken,
    roomId,
    children,
}: {
    shareToken: string
    roomId?: string
    children: ReactNode
}) {
    const storageKey = useMemo(() => getStorageKey(shareToken), [shareToken])
    const [session, setSessionState] = useState<ShareSession | null>(() =>
        loadSessionFromStorage(shareToken)
    )
    const [isLoading, setIsLoading] = useState(true)
    const [showJoinForm, setShowJoinForm] = useState(false)

    useEffect(() => {
        const loadedSession = loadSessionFromStorage(shareToken)
        setSessionState(loadedSession)

        // If roomId is provided and we don't have a session, show join form
        if (roomId && !loadedSession) {
            setShowJoinForm(true)
        }

        setIsLoading(false)
    }, [storageKey, shareToken, roomId])

    const setSession = (nextSession: ShareSession) => {
        setSessionState(nextSession)
        persistSession(shareToken, nextSession)
    }

    const clearSession = () => {
        setSessionState(null)
        persistSession(shareToken, null)
    }

    const refreshSession = useCallback(async () => {
        if (!session) return

        try {
            setIsLoading(true)
            const data = await getGuestSession(session.authToken)

            const updatedSession: ShareSession = {
                shareToken,
                authToken: session.authToken,
                guest: mapGuest(data.guest),
                room: mapRoomDetails(data.room),
            }

            setSessionState(updatedSession)
            persistSession(shareToken, updatedSession)
        } catch (error) {
            console.error('Failed to refresh share session', error)
            setSessionState(null)
            persistSession(shareToken, null)
            throw error
        } finally {
            setIsLoading(false)
        }
    }, [session, shareToken])

    const value: ShareSessionContextValue = {
        shareToken,
        roomId,
        session,
        isLoading,
        setSession,
        clearSession,
        refreshSession,
    }

    // If we need to show join form, render it before the children
    if (showJoinForm && !session) {
        return (
            <ShareSessionContext.Provider value={value}>
                <ShareJoin onJoined={() => setShowJoinForm(false)} />
            </ShareSessionContext.Provider>
        )
    }

    return <ShareSessionContext.Provider value={value}>{children}</ShareSessionContext.Provider>
}

function mapGuest(guest: ShareGuest): ShareGuest {
    return {
        id: guest.id,
        displayName: guest.displayName,
        email: guest.email ?? null,
        color: guest.color,
        canEdit: guest.canEdit,
    }
}

function mapRoomDetails(room: ShareRoomDetails): ShareRoomDetails {
    return {
        ...room,
    }
}

export function useShareSession() {
    const context = useContext(ShareSessionContext)
    if (!context) {
        throw new Error('useShareSession must be used within a ShareSessionProvider')
    }
    return context
}
