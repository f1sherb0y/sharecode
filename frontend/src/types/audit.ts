import type { PaginationMeta } from './index'
export interface AuditFilters {
  page?: number; pageSize?: number; username?: string; action?: string
  start?: string; end?: string; snapshot?: number; deviceId?: string
}
export interface AuditEvent {
  id: number; createdAt: string; action: string; username: string | null
  actorId: string | null; targetId: string | null; success: boolean; clientIp: string
  peerIp: string; ipSource: string; userAgent: string; requestId: string; reason: string | null
  deviceId: string | null; fingerprint: string | null; newDevice: boolean; details: Record<string, unknown>
}
export interface AuditResponse { events: AuditEvent[]; snapshot: number; pagination: PaginationMeta }
export interface UserDevice {
  deviceId: string; fingerprint: string | null; userAgent: string; lastIp: string
  firstSeen: string; lastSeen: string; loginCount: number
}
export interface DevicesResponse { devices: UserDevice[]; pagination: PaginationMeta }
export const AUDIT_ACTIONS = ['login','password.changed', 'session.logout','user.registered','user.created','user.permissions_changed','user.updated','user.deleted','room.created','room.updated','room.pin_changed','room.ended','room.deleted','share.created','share.accept','share.revoke','guest.join','note.created','note.updated','note.deleted','playback.compressed','notification.created'] as const
