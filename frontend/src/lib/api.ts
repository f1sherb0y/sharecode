import type { User, Room, AuthResponse } from '../types'

const resolveApiUrl = (): string => {
    const envUrl = import.meta.env.VITE_API_URL as string | undefined
    if (envUrl) {
        return envUrl
    }

    if (typeof window !== 'undefined') {
        return window.location.origin
    }

    return 'http://localhost:3001'
}

const API_URL = resolveApiUrl()

class ApiClient {
    private getAuthHeader(): HeadersInit {
        const token = localStorage.getItem('token')
        return token ? { Authorization: `Bearer ${token}` } : {}
    }

    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<T> {
        const response = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...this.getAuthHeader(),
                ...options.headers,
            },
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }))
            throw new Error(error.error || 'Request failed')
        }

        return response.json()
    }

    // Auth endpoints
    async register(username: string, password: string, email?: string): Promise<AuthResponse> {
        return this.request<AuthResponse>('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password, email }),
        })
    }

    async login(username: string, password: string): Promise<AuthResponse> {
        return this.request<AuthResponse>('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        })
    }

    async getProfile(): Promise<{ user: User }> {
        return this.request<{ user: User }>('/api/auth/profile')
    }

    // Room endpoints
    async createRoom(
        name: string,
        language: string,
        scheduledTime?: string,
        duration?: number
    ): Promise<{ room: Room }> {
        return this.request<{ room: Room }>('/api/rooms', {
            method: 'POST',
            body: JSON.stringify({ name, language, scheduledTime, duration }),
        })
    }

    async getRooms(): Promise<{ rooms: Room[] }> {
        return this.request<{ rooms: Room[] }>('/api/rooms')
    }

    async getRoom(roomId: string): Promise<{ room: Room }> {
        return this.request<{ room: Room }>(`/api/rooms/${roomId}`)
    }

    async updateRoom(
        roomId: string,
        data: { name?: string; language?: string }
    ): Promise<{ room: Room }> {
        return this.request<{ room: Room }>(`/api/rooms/${roomId}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        })
    }

    async deleteRoom(roomId: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/api/rooms/${roomId}`, {
            method: 'DELETE',
        })
    }

    async joinRoom(roomId: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/api/rooms/${roomId}/join`, {
            method: 'POST',
        })
    }

    async leaveRoom(roomId: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/api/rooms/${roomId}/leave`, {
            method: 'POST',
        })
    }

    async endRoom(roomId: string): Promise<{ room: Room }> {
        return this.request<{ room: Room }>(`/api/rooms/${roomId}/end`, {
            method: 'POST',
        })
    }

    // Admin endpoints
    async getAllUsers(): Promise<{ users: User[] }> {
        return this.request<{ users: User[] }>('/api/admin/users')
    }

    async deleteUser(userId: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/api/admin/users/${userId}`, {
            method: 'DELETE',
        })
    }

    async getAllRoomsAdmin(): Promise<{ rooms: Room[] }> {
        return this.request<{ rooms: Room[] }>('/api/admin/rooms')
    }

    async deleteRoomAdmin(roomId: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/api/admin/rooms/${roomId}`, {
            method: 'DELETE',
        })
    }

    // Playback endpoints
    async getPlaybackUpdates(roomId: string): Promise<{
        updates: Array<{
            id: string
            timestamp: string
            update: string
            userId: string | null
        }>
        startTime: string | null
        endTime: string | null
        duration: number
    }> {
        return this.request(`/api/rooms/${roomId}/playback/updates`)
    }
}

export const api = new ApiClient()
