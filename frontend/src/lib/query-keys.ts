import type { RoomActiveness } from '@/types'

export const queryKeys = {
  roomCreationUsers: ['room-creation-users'] as const,
  rooms: (params: { page: number; pageSize: number; ownerId?: string; activeness: RoomActiveness }) =>
    ['rooms', params] as const,
  shareLinks: (roomId: string) => ['share-links', roomId] as const,
  invites: ['invites'] as const,
  appointments: (params: { from: string; to: string; unassigned?: boolean }) => ['appointments', params] as const,
  appointment: (appointmentId: string) => ['appointment', appointmentId] as const,
  customers: (params: { q: string; page: number; pageSize: number }) => ['customers', params] as const,
  customer: (customerId: string) => ['customer', customerId] as const,
  notes: (roomId: string) => ['notes', roomId] as const,
  notifications: ['notifications'] as const,
  unreadNotifications: ['unread-notifications'] as const,
  adminUsers: ['admin-users'] as const,
  adminRooms: ['admin-rooms'] as const,
  adminDbSize: ['admin-db-size'] as const,
  adminPlaybackSizes: ['admin-playback-sizes'] as const,
}
