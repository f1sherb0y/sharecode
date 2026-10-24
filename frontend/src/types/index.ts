/** 超级管理员 admin, 管理 agent (shown as Super admin and Manager), 技术 tech; customers are share-link guests without accounts. */
export type Role = 'admin' | 'agent' | 'tech'
export type NotificationSeverity = 'normal' | 'emergency'

export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'c'
  | 'cpp'
  | 'rust'
  | 'go'
  | 'php'
  | 'markdown'
  | 'verilog'

export const LANGUAGES: Language[] = ['javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'rust', 'go', 'php', 'markdown', 'verilog']

export type RoomActiveness = 'all' | 'active' | 'ended'

export interface User {
  id: string
  username: string
  color: string
  role: Role
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
  isPrivate?: boolean
  canViewPlayback?: boolean
  canManageNotes?: boolean
  canReadNotes?: boolean
  canWriteNotes?: boolean
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
  shareUrl?: string | null
  token: string
  canEdit: boolean
  createdAt: string
  expiresAt: string
  consumedAt?: string | null
  guestCount: number
  isConsumed: boolean
  isExpired: boolean
}

/** A single-use registration code an agent or admin gives to a tech. */
export interface RegistrationInvite {
  id: string
  code: string
  note: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  createdBy: { id: string; username: string }
  usedBy: { id: string; username: string } | null
  isUsed: boolean
  isExpired: boolean
  inviteUrl: string | null
}

export interface ShareGuest {
  id: string
  displayName: string
  color: string
  canEdit: boolean
}

export interface ShareRoomDetails {
  id: string
  name: string
  language: Language
  documentId: string
  allowEdit: boolean
  isEnded?: boolean
  endedAt?: string | null
}

export interface AuthResponse {
  user: User
  token: string
  browserSessionId: string
}

export interface RemoteUser {
  clientId: number
  id?: string
  username: string
  color: string
  colorLight: string
  colorSlot?: number
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

export interface Note {
  id: string
  roomId: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface NotificationItem {
  id: string
  title: string
  content: string
  severity: NotificationSeverity
  /** Set on personal notices (e.g. 'schedule.assigned'); announcements have none. */
  kind?: string | null
  data?: Record<string, unknown> | null
  createdAt: string
  isRead: boolean
  readAt?: string | null
  createdBy: {
    id: string
    username: string
  }
}

export type AppointmentStatus = 'scheduled' | 'completed'

/** A 排班 customer profile in the list agents and admins share; it belongs to the agent who created it. */
export interface Customer {
  id: string
  name: string
  contact: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  createdBy: { id: string; username: string }
  sessionCount: number
  upcomingCount: number
  nextSessionAt: string | null
  lastSessionAt: string | null
}

/** A session (场次) an agent planned for a tech. */
export interface Appointment {
  id: string
  startsAt: string
  endsAt: string
  durationMinutes: number
  company: string | null
  position: string | null
  notes: string | null
  /** Completed once its room has ended. */
  status: AppointmentStatus
  /** Busy time a tech marked on their own table: no customer, no room. */
  isBlock: boolean
  /** Optional. Techs get the name only; contact and notes are for agents and admins. */
  customer: { id: string; name: string; contact?: string | null; notes?: string | null; isDeleted: boolean; owner: { id: string; username: string; color: string } } | null
  /** `name` is the name on the techs' list, else the username. */
  tech: { id: string; username: string; name?: string; color: string; role: Role; isDeleted: boolean } | null
  room: { id: string; name: string; language: Language; isEnded: boolean; endedAt: string | null } | null
  hasConflict: boolean
  /** The 管理 it belongs to: the one chosen, else its customer's agent, else its planner. None for busy time. */
  manager: { id: string; username: string; color: string; name?: string } | null
  createdBy: { id: string; username: string; color: string }
  createdAt: string
  updatedAt: string
}

export interface AppointmentInput {
  customerId?: string | null
  managerId?: string | null
  isBlock?: boolean
  techId?: string | null
  startsAt?: string
  durationMinutes?: number
  company?: string | null
  position?: string | null
  notes?: string | null
  allowConflicts?: boolean
}

/** Another session of the same tech at an overlapping time. */
export interface ScheduleConflict {
  id: string
  startsAt: string
  endsAt: string
  durationMinutes: number
  customer: { name: string } | null
  manager: { username: string }
  createdBy: { username: string }
  isBlock: boolean
}

/** A tech's work table (工作表): their sessions and busy time. */
export interface WorkTable {
  id: string
  username: string
  /** The name on the techs' list, else the username. */
  name: string
  color: string
  role: Role
  /** Pinned above the table by its tech. */
  note: string | null
  /** Sessions still to come. */
  upcoming: number
  /** A placeholder for a tech without an account, reached through its link only. */
  linkOnly: boolean
  /** The token of the link that opens the table without signing in (staff only). */
  link: string | null
}

/** A name on one of the work tables' lists: an account, or a placeholder for someone without one. */
export interface RosterEntry {
  userId: string
  name: string
  username: string
  color: string
  role: Role
  linkOnly: boolean
}

export type RosterKind = 'tech' | 'manager'

/** Desktop client platforms, Tauri's `{target}-{arch}` names. */
export const CLIENT_PLATFORMS = [
  'windows-x86_64',
  'windows-aarch64',
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-x86_64',
  'linux-aarch64',
] as const
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number]
/** What the download page offers, or what the in-app updater installs (macOS .app.tar.gz). */
export type ClientAssetKind = 'installer' | 'update'

export interface ClientReleaseAsset {
  id: string
  platform: ClientPlatform
  kind: ClientAssetKind
  fileName: string
  size: number
  sha256: string
  /** Has its updater signature: the in-app updater can install it. */
  signed: boolean
  createdAt: string
  downloadUrl: string
}

/** A desktop client version; drafts are only seen by admins. */
export interface ClientRelease {
  id: string
  version: string
  notes: string
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  assets: ClientReleaseAsset[]
}

/** A platform's newest published installer. */
export interface ClientDownload {
  platform: ClientPlatform
  version: string
  publishedAt: string | null
  fileName: string
  size: number
  sha256: string
  url: string
}
