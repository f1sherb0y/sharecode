export type Role = 'user' | 'admin' | 'superuser'

export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'cpp'
  | 'rust'
  | 'go'
  | 'php'

export type RoomActiveness = 'all' | 'active' | 'ended'

export interface User {
  id: string
  email: string | null
  username: string
  color: string
  role: Role
  canReadAllRooms: boolean
  canWriteAllRooms: boolean
  canDeleteAllRooms: boolean
  createdAt?: string
  lastSeen?: string
}

export interface Room {
  id: string
  name: string
  language: Language
  company?: string | null
  position?: string | null
  ownerId: string
  allowEdit: boolean
  isPinned?: boolean
  isDeleted?: boolean
  scheduledTime?: string | null
  duration?: number | null
  isEnded?: boolean
  endedAt?: string | null
  createdAt: string
  updatedAt: string
  owner: {
    id: string
    username: string
    color: string
  }
  participants?: RoomParticipant[]
  isMember?: boolean
  isOwner?: boolean
  canEdit?: boolean
  isExpired?: boolean
}

export interface PaginationMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface RoomParticipant {
  id: string
  roomId: string
  userId: string
  canEdit: boolean
  joinedAt: string
  user: {
    id: string
    username: string
    color: string
  }
}

export interface ShareLink {
  id: string
  token: string
  canEdit: boolean
  createdAt: string
  guestCount: number
  shareUrl?: string | null
}

export interface ShareLinkInfo {
  token: string
  canEdit: boolean
  effectiveCanEdit: boolean
  createdAt: string
  shareUrl?: string | null
}

export interface ShareGuest {
  id: string
  displayName: string
  email: string | null
  color: string
  canEdit: boolean
}

export interface ShareRoomSummary {
  id: string
  name: string
  language: Language
  isEnded?: boolean
  endedAt?: string | null
}

export interface ShareRoomDetails extends ShareRoomSummary {
  documentId: string
  allowEdit: boolean
}

export interface ShareSession {
  shareToken: string
  authToken: string
  guest: ShareGuest
  room: ShareRoomDetails
}

export interface AuthResponse {
  user: User
  token: string
}

export interface RemoteUser {
  clientId: number
  id?: string
  username: string
  color: string
  colorLight: string
  cursor?: {
    anchor: unknown
    head: unknown
  }
}

export interface PlaybackUpdate {
  id: string
  timestamp: string
  update: string
  userId: string | null
}

export interface PlaybackData {
  updates: PlaybackUpdate[]
  startTime: string | null
  endTime: string | null
  duration: number
}

export interface DbStorageSize {
  bytes: number
  pretty: string
}

export interface RoomPlaybackSize {
  id: string
  name: string
  isEnded: boolean
  endedAt?: string | null
  updateCount: number
  bytes: number
}

export interface PlaybackCompressionResult {
  roomId: string
  originalUpdates: number
  compressedUpdates: number
  originalBytes: number
  compressedBytes: number
  savedBytes: number
}

export interface CodeExecutionResult {
  output: string
  error: string
  status: string
  statusId: number
  isSuccess: boolean
  time?: string
  memory?: number
}
