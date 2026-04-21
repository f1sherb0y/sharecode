import type {
  User,
  Room,
  AuthResponse,
  Role,
  ShareLink,
  ShareGuest,
  ShareRoomDetails,
  PlaybackData,
  DbStorageSize,
  RoomPlaybackSize,
  PlaybackCompressionResult,
  Language,
  RoomActiveness,
  PaginationMeta,
  CodeExecutionResult,
  Note,
} from '@/types'
import { isTauriApp } from '@/lib/tauri'
import { useAuthStore } from '@/stores'

function getSettings(): { serverUrl?: string; wsUrl?: string } {
  if (typeof window === 'undefined') return {}
  const saved = localStorage.getItem('sharecode_settings')
  if (!saved) return {}
  try {
    return JSON.parse(saved)
  } catch {
    return {}
  }
}

export function getApiBaseUrl(): string {
  // Tauri app: use settings or env var
  if (isTauriApp()) {
    const settings = getSettings()
    if (settings.serverUrl) return settings.serverUrl
    const envUrl = import.meta.env.VITE_API_URL as string | undefined
    if (envUrl) return envUrl
    return 'http://localhost:3000'
  }

  // Web: use relative URL
  return ''
}

export function getWebSocketUrl(): string {
  // Tauri app: use settings or env var
  if (isTauriApp()) {
    const settings = getSettings()
    if (settings.wsUrl) return settings.wsUrl
    const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined
    if (envWsUrl) return envWsUrl
    return 'ws://localhost:3000'
  }

  // Web: derive from current location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

class ApiClient {
  private getAuthHeader(): HeadersInit {
    const token = useAuthStore.getState().token
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const baseUrl = getApiBaseUrl()
    const response = await fetch(`${baseUrl}${endpoint}`, {
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

  // Auth
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

  async getRegistrationStatus(): Promise<{ allowRegistration: boolean }> {
    return this.request<{ allowRegistration: boolean }>('/api/config/registration')
  }

  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<{ message: string }> {
    return this.request<{ message: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    })
  }

  // Users
  async getAllUsersForRoomCreation(): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>('/api/users')
  }

  // Rooms
  async createRoom(
    name: string,
    language: Language,
    scheduledTime?: string,
    duration?: number,
    allowedUsers?: Array<{ userId: string; canEdit: boolean }>,
    company?: string,
    position?: string,
    timezone?: string
  ): Promise<{ room: Room }> {
    return this.request<{ room: Room }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, language, scheduledTime, duration, allowedUsers, company, position, timezone }),
    })
  }

  async getRooms(params?: {
    page?: number
    pageSize?: number
    ownerId?: string
    activeness?: RoomActiveness
  }): Promise<{ rooms: Room[]; pagination: PaginationMeta }> {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.pageSize) query.set('pageSize', String(params.pageSize))
    if (params?.ownerId) query.set('ownerId', params.ownerId)
    if (params?.activeness) query.set('activeness', params.activeness)

    const endpoint = query.toString() ? `/api/rooms?${query.toString()}` : '/api/rooms'
    return this.request<{ rooms: Room[]; pagination: PaginationMeta }>(endpoint)
  }

  async getRoom(roomId: string): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/${roomId}`)
  }

  async getRoomByDocumentId(documentId: string): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/by-document/${documentId}`)
  }

  async updateRoom(roomId: string, data: { name?: string; language?: string }): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/${roomId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async setRoomPin(roomId: string, isPinned: boolean): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/${roomId}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ isPinned }),
    })
  }

  async deleteRoom(roomId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/rooms/${roomId}`, {
      method: 'DELETE',
    })
  }

  async endRoom(roomId: string): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/${roomId}/end`, {
      method: 'POST',
    })
  }

  // Share Links
  async createShareLink(roomId: string, canEdit: boolean): Promise<{ shareLink: ShareLink }> {
    return this.request<{ shareLink: ShareLink }>(`/api/rooms/${roomId}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ canEdit }),
    })
  }

  async listShareLinks(roomId: string): Promise<{ shareLinks: ShareLink[] }> {
    return this.request<{ shareLinks: ShareLink[] }>(`/api/rooms/${roomId}/share-links`)
  }

  async deleteShareLink(roomId: string, shareLinkId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/rooms/${roomId}/share-links/${shareLinkId}`, {
      method: 'DELETE',
    })
  }

  // Admin
  async createUser(payload: {
    username: string
    password: string
    email?: string
    role?: Role
    canReadAllRooms?: boolean
    canWriteAllRooms?: boolean
    canDeleteAllRooms?: boolean
  }): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getAllUsers(): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>('/api/admin/users')
  }

  async updateUser(
    userId: string,
    data: {
      role?: Role
      canReadAllRooms?: boolean
      canWriteAllRooms?: boolean
      canDeleteAllRooms?: boolean
    }
  ): Promise<{ user: User }> {
    return this.request<{ user: User }>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
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

  async getDbStorageSize(): Promise<DbStorageSize> {
    return this.request<DbStorageSize>('/api/admin/storage/db-size')
  }

  async getRoomPlaybackSizes(): Promise<{ rooms: RoomPlaybackSize[] }> {
    return this.request<{ rooms: RoomPlaybackSize[] }>('/api/admin/storage/playback')
  }

  async compressRoomPlayback(roomId: string): Promise<PlaybackCompressionResult> {
    return this.request<PlaybackCompressionResult>(`/api/admin/rooms/${roomId}/playback/compress`, {
      method: 'POST',
    })
  }

  // Playback
  async getPlaybackUpdates(roomId: string): Promise<PlaybackData> {
    return this.request<PlaybackData>(`/api/rooms/${roomId}/playback/updates`)
  }

  // Notes
  async getNotes(roomId: string): Promise<{ notes: Note[] }> {
    return this.request<{ notes: Note[] }>(`/api/rooms/${roomId}/notes`)
  }

  async createNote(roomId: string, text: string): Promise<{ note: Note }> {
    return this.request<{ note: Note }>(`/api/rooms/${roomId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  }

  async updateNote(roomId: string, noteId: string, text: string): Promise<{ note: Note }> {
    return this.request<{ note: Note }>(`/api/rooms/${roomId}/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ text }),
    })
  }

  async deleteNote(roomId: string, noteId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/rooms/${roomId}/notes/${noteId}`, {
      method: 'DELETE',
    })
  }

  // Code Execution
  async executeCode(
    sourceCode: string,
    languageId: string,
    stdin?: string
  ): Promise<CodeExecutionResult> {
    return this.request<CodeExecutionResult>('/api/code/execute', {
      method: 'POST',
      body: JSON.stringify({
        source_code: sourceCode,
        language_id: languageId,
        stdin: stdin || '',
      }),
    })
  }

  async getCodeLanguages(): Promise<{ languages: Array<{ name: string; id: string }> }> {
    return this.request<{ languages: Array<{ name: string; id: string }> }>('/api/code/languages')
  }
}

export const api = new ApiClient()

// Share API (unauthenticated endpoints)
export async function joinShare(
  shareToken: string,
  payload: { username: string; email?: string }
): Promise<{ token: string; redirectUrl: string | null; guest: ShareGuest; room: ShareRoomDetails }> {
  const baseUrl = getApiBaseUrl()
  const response = await fetch(`${baseUrl}/api/share/${shareToken}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || 'Request failed')
  }

  return response.json()
}

export async function getSessionProfile(authToken: string): Promise<
  | { actorType: 'user'; user: User }
  | {
      actorType: 'guest'
      guest: ShareGuest
      room: ShareRoomDetails
      share: { id: string; token: string; canEdit: boolean }
    }
> {
  const baseUrl = getApiBaseUrl()
  const response = await fetch(`${baseUrl}/api/auth/profile`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || 'Request failed')
  }

  return response.json()
}
