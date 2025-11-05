import { resolveApiUrl } from './api'
import type {
    ShareGuest,
    ShareLinkInfo,
    ShareRoomDetails,
    ShareRoomSummary,
} from '../types'

const API_URL = resolveApiUrl()

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    })

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(error.error || 'Request failed')
    }

    return response.json()
}

export async function fetchShareInfo(
    shareToken: string
): Promise<{ share: ShareLinkInfo; room: ShareRoomSummary }> {
    return request<{ share: ShareLinkInfo; room: ShareRoomSummary }>(`/api/share/${shareToken}`)
}

export async function joinShare(
    shareToken: string,
    payload: { username: string; email?: string }
): Promise<{ token: string; guest: ShareGuest; room: ShareRoomDetails }> {
    return request<{ token: string; guest: ShareGuest; room: ShareRoomDetails }>(
        `/api/share/${shareToken}/join`,
        {
            method: 'POST',
            body: JSON.stringify(payload),
        }
    )
}

export async function getGuestSession(
    authToken: string
): Promise<{ guest: ShareGuest; room: ShareRoomDetails; share: { id: string; token: string; canEdit: boolean } }> {
    return request<{ guest: ShareGuest; room: ShareRoomDetails; share: { id: string; token: string; canEdit: boolean } }>(
        '/api/share/session',
        {
            headers: {
                Authorization: `Bearer ${authToken}`,
            },
        }
    )
}
