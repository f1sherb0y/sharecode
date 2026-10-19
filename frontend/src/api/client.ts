import { ensureFreshSession } from '@/lib/session-renewal'
import { deviceHeaders } from '@/lib/device-identity'
import type { AuditFilters, AuditResponse, DevicesResponse } from '@/types/audit'
import type {
  User,
  Room,
  AuthResponse,
  Role,
  ShareLink,
  RegistrationInvite,
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
  NotificationItem,
  Customer,
  Appointment,
  AppointmentInput,
  WorkTable,
  RosterEntry,
  RosterKind,
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
    if (endpoint !== '/api/auth/login' && endpoint !== '/api/auth/register') await ensureFreshSession()
    const baseUrl = getApiBaseUrl()
    const response = await fetch(`${baseUrl}${endpoint}`, {
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Sharecode-Client': 'web',
        ...await deviceHeaders(options.method !== undefined && options.method !== 'GET'),
        ...this.getAuthHeader(),
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }))
      // Callers that need more than the message (e.g. schedule conflicts) read status and data.
      throw Object.assign(new Error(error.error || 'Request failed'), { status: response.status, data: error })
    }

    return response.json()
  }

  // Auth
  async register(username: string, password: string, inviteCode: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, inviteCode }),
    })
  }

  async login(username: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async logout(browserSessionId: string | null): Promise<void> {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { 'X-Sharecode-Client': 'web', ...(browserSessionId ? { 'X-Session-Id': browserSessionId } : {}) },
    })
    if (!response.ok) throw new Error('Could not log out')
  }

  async getProfile(): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/auth/profile')
  }

  /** The work tables' lists: techs whose tables show, 管理 who book. */
  async getRoster(): Promise<{ techs: RosterEntry[]; managers: RosterEntry[] }> {
    return this.request('/api/roster')
  }

  async addRosterEntry(kind: RosterKind, name: string, accountId?: string | null): Promise<{ entry: RosterEntry }> {
    return this.request('/api/roster', { method: 'POST', body: JSON.stringify({ kind, name, accountId: accountId || null }) })
  }

  async updateRosterEntry(kind: RosterKind, userId: string, change: { name?: string; accountId?: string }): Promise<{ entry: RosterEntry }> {
    return this.request(`/api/roster/${kind}/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify(change) })
  }

  async removeRosterEntry(kind: RosterKind, userId: string): Promise<{ removed: boolean }> {
    return this.request(`/api/roster/${kind}/${encodeURIComponent(userId)}`, { method: 'DELETE' })
  }

  /** When the account may next rename itself; null when it may now. */
  async getUsernameChange(): Promise<{ nextChangeAt: string | null }> {
    return this.request('/api/auth/username')
  }

  async changeUsername(username: string): Promise<{ username: string; nextChangeAt: string }> {
    return this.request('/api/auth/username', { method: 'PUT', body: JSON.stringify({ username }) })
  }

  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<{ message: string }> {
    const result = await this.request<{ message: string; token: string; browserSessionId: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    })
    useAuthStore.getState().replaceToken(result.token, result.browserSessionId)
    return result
  }

  async getNotifications(): Promise<{ notifications: NotificationItem[] }> {
    return this.request<{ notifications: NotificationItem[] }>('/api/notifications')
  }

  async getUnreadNotifications(): Promise<{ notifications: NotificationItem[] }> {
    return this.request<{ notifications: NotificationItem[] }>('/api/notifications/unread')
  }

  async markAllNotificationsRead(): Promise<{ markedCount: number }> {
    return this.request<{ markedCount: number }>('/api/notifications/read-all', {
      method: 'POST',
    })
  }

  async markNotificationsRead(ids: string[]): Promise<{ markedCount: number }> {
    return this.request<{ markedCount: number }>('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    })
  }

  async getSeenTours(): Promise<{ seen: string[] }> {
    return this.request<{ seen: string[] }>('/api/tours')
  }

  async markTourSeen(tour: string): Promise<{ seen: string[] }> {
    return this.request<{ seen: string[] }>(`/api/tours/${tour}`, { method: 'PUT' })
  }

  async createNotification(payload: {
    title: string
    content: string
    severity: 'normal' | 'emergency'
  }): Promise<{ notification: NotificationItem }> {
    return this.request<{ notification: NotificationItem }>('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getAuditEvents(filters: AuditFilters): Promise<AuditResponse> {
    const query = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)) })
    return this.request(`/api/admin/audit?${query}`)
  }

  async getUserDevices(id: string, page = 1): Promise<DevicesResponse> {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/devices?page=${page}`)
  }

  // Accounts that may own rooms, for the agents' and admins' owner filter.
  async getRoomOwners(): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>('/api/users')
  }

  // Rooms
  async createRoom(
    name: string,
    language: Language,
    scheduledTime?: string,
    duration?: number,
    company?: string,
    position?: string,
    timezone?: string,
    isPrivate = false
  ): Promise<{ room: Room }> {
    return this.request<{ room: Room }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, language, scheduledTime, duration, company, position, timezone, isPrivate }),
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

  async getRoom(roomId: string, signal?: AbortSignal): Promise<{ room: Room }> {
    return this.request<{ room: Room }>(`/api/rooms/${roomId}`, { signal })
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

  async acceptShareLink(token: string, signal?: AbortSignal): Promise<{ roomId: string }> {
    return this.request(`/api/share/${encodeURIComponent(token)}/accept`, { method: 'POST', signal })
  }

  // Share Links
  async createShareLink(roomId: string, canEdit: boolean): Promise<{ shareLink: ShareLink }> {
    return this.request<{ shareLink: ShareLink }>(`/api/rooms/${roomId}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ canEdit }),
    })
  }

  // Registration invites (agents and admins)
  // Scheduling (排班)
  async listCustomers(params: { q?: string; page?: number; pageSize?: number; mine?: boolean }, signal?: AbortSignal): Promise<{ customers: Customer[]; pagination: PaginationMeta }> {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.mine) search.set('mine', 'true')
    if (params.page) search.set('page', String(params.page))
    if (params.pageSize) search.set('pageSize', String(params.pageSize))
    return this.request<{ customers: Customer[]; pagination: PaginationMeta }>(`/api/customers?${search}`, { signal })
  }

  async getCustomer(customerId: string): Promise<{ customer: Customer; appointments: Appointment[] }> {
    return this.request<{ customer: Customer; appointments: Appointment[] }>(`/api/customers/${customerId}`)
  }

  async createCustomer(data: { name: string; contact?: string | null; notes?: string | null }): Promise<{ customer: Customer }> {
    return this.request<{ customer: Customer }>('/api/customers', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateCustomer(customerId: string, data: { name?: string; contact?: string | null; notes?: string | null }): Promise<{ customer: Customer }> {
    return this.request<{ customer: Customer }>(`/api/customers/${customerId}`, { method: 'PUT', body: JSON.stringify(data) })
  }

  async deleteCustomer(customerId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/customers/${customerId}`, { method: 'DELETE' })
  }

  /** `mine`: an agent's own, i.e. sessions of customers they created or that they planned. */
  async listAppointments(params: { from: string; to: string; techId?: string; customerId?: string; unassigned?: boolean; mine?: boolean }, signal?: AbortSignal): Promise<{ appointments: Appointment[] }> {
    const search = new URLSearchParams({ from: params.from, to: params.to })
    if (params.techId) search.set('techId', params.techId)
    if (params.customerId) search.set('customerId', params.customerId)
    if (params.unassigned) search.set('unassigned', 'true')
    if (params.mine) search.set('mine', 'true')
    return this.request<{ appointments: Appointment[] }>(`/api/appointments?${search}`, { signal })
  }

  async getAppointment(appointmentId: string): Promise<{ appointment: Appointment }> {
    return this.request<{ appointment: Appointment }>(`/api/appointments/${appointmentId}`)
  }

  async createAppointment(data: AppointmentInput): Promise<{ appointment: Appointment }> {
    return this.request<{ appointment: Appointment }>('/api/appointments', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateAppointment(appointmentId: string, data: AppointmentInput): Promise<{ appointment: Appointment }> {
    return this.request<{ appointment: Appointment }>(`/api/appointments/${appointmentId}`, { method: 'PUT', body: JSON.stringify(data) })
  }

  async deleteAppointment(appointmentId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/appointments/${appointmentId}`, { method: 'DELETE' })
  }

  /** Every tech's table for staff; a tech gets their own. */
  async listWorkTables(): Promise<{ tables: WorkTable[]; unassigned: number }> {
    return this.request<{ tables: WorkTable[]; unassigned: number }>('/api/work-tables')
  }

  /** The note pinned above the caller's own table; empty removes it. */
  async updateWorkTableNote(note: string | null): Promise<{ note: string | null }> {
    return this.request<{ note: string | null }>('/api/work-tables/note', { method: 'PUT', body: JSON.stringify({ note }) })
  }

  /** A table for a tech without an account, with its link. */
  async createWorkTable(name: string): Promise<{ table: { id: string; username: string; link: string } }> {
    return this.request('/api/work-tables', { method: 'POST', body: JSON.stringify({ name }) })
  }

  /** A new link for a table; the old one stops working. */
  async resetWorkTableLink(tableId: string): Promise<{ link: string }> {
    return this.request(`/api/work-tables/${tableId}/link`, { method: 'POST' })
  }

  /** Moves a placeholder's table into a real account. */
  async mergeWorkTable(tableId: string, into: string): Promise<{ merged: number }> {
    return this.request(`/api/work-tables/${tableId}/merge`, { method: 'POST', body: JSON.stringify({ into }) })
  }

  /** A table opened through its link, without signing in. */
  async openTableLink(token: string, range: { from: string; to: string }, signal?: AbortSignal): Promise<{ table: Pick<WorkTable, 'id' | 'username' | 'name' | 'color' | 'note'>; appointments: Appointment[] }> {
    return this.request(`/api/table-links/${encodeURIComponent(token)}?${new URLSearchParams(range)}`, { signal })
  }

  async updateTableLinkNote(token: string, note: string | null): Promise<{ note: string | null }> {
    return this.request(`/api/table-links/${encodeURIComponent(token)}/note`, { method: 'PUT', body: JSON.stringify({ note }) })
  }

  async createTableLinkBusy(token: string, data: AppointmentInput): Promise<{ appointment: Appointment }> {
    return this.request(`/api/table-links/${encodeURIComponent(token)}/busy`, { method: 'POST', body: JSON.stringify(data) })
  }

  async updateTableLinkBusy(token: string, appointmentId: string, data: AppointmentInput): Promise<{ appointment: Appointment }> {
    return this.request(`/api/table-links/${encodeURIComponent(token)}/busy/${appointmentId}`, { method: 'PUT', body: JSON.stringify(data) })
  }

  async deleteTableLinkBusy(token: string, appointmentId: string): Promise<{ message: string }> {
    return this.request(`/api/table-links/${encodeURIComponent(token)}/busy/${appointmentId}`, { method: 'DELETE' })
  }

  /** Opens the session's room, creating it for the tech on first use. */
  async openAppointmentRoom(appointmentId: string, options: { language?: Language; replace?: boolean } = {}): Promise<{ room: Pick<Room, 'id'> & Partial<Room>; appointment: Appointment; created: boolean }> {
    return this.request<{ room: Pick<Room, 'id'> & Partial<Room>; appointment: Appointment; created: boolean }>(`/api/appointments/${appointmentId}/room`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  async listInvites(): Promise<{ invites: RegistrationInvite[] }> {
    return this.request<{ invites: RegistrationInvite[] }>('/api/invites')
  }

  async createInvite(note?: string): Promise<{ invite: RegistrationInvite }> {
    return this.request<{ invite: RegistrationInvite }>('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ note }),
    })
  }

  async deleteInvite(inviteId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/invites/${inviteId}`, { method: 'DELETE' })
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
    role?: Role
  }): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getAdminUsers(params: { page: number; pageSize: number; q?: string; role?: string }, signal?: AbortSignal): Promise<{ users: User[]; pagination: PaginationMeta }> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
    return this.request(`/api/admin/users?${query}`, { signal })
  }

  async updateUser(userId: string, data: { role: Role }): Promise<{ user: User }> {
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

  async getAdminRooms(params: { page: number; pageSize: number; q?: string; status?: string; language?: string; owner?: string }, signal?: AbortSignal): Promise<{ rooms: Room[]; pagination: PaginationMeta }> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
    return this.request(`/api/admin/rooms?${query}`, { signal })
  }

  async deleteRoomAdmin(roomId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/admin/rooms/${roomId}`, {
      method: 'DELETE',
    })
  }

  async getDbStorageSize(): Promise<DbStorageSize> {
    return this.request<DbStorageSize>('/api/admin/storage/db-size')
  }

  async getRoomPlaybackSizes(roomIds: string[], signal?: AbortSignal): Promise<{ rooms: RoomPlaybackSize[] }> {
    const query = new URLSearchParams({ roomIds: roomIds.join(',') })
    return this.request(`/api/admin/storage/playback?${query}`, { signal })
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
  payload: { username: string }
): Promise<{ token: string; redirectUrl: string | null; guest: ShareGuest; room: ShareRoomDetails }> {
  const baseUrl = getApiBaseUrl()
  const response = await fetch(`${baseUrl}/api/share/${shareToken}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await deviceHeaders(true) },
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
    throw Object.assign(new Error(error.error || 'Request failed'), { status: response.status })
  }

  return response.json()
}
