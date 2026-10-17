import type { Role, Room, User } from '@/types'

// Mirrors server-rs/src/core/permissions.rs: the role alone decides room access.
// The server stays authoritative; these only decide which controls to show.

type Actor = Pick<User, 'id' | 'role'> | null | undefined

/** Admins only: deleting rooms, private rooms, storage, devices, notifications. */
export function isAdmin(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin'
}

/** Agents and admins see, edit, share, pin and end every room and manage tech accounts. */
export function isStaff(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'agent'
}

export function canViewRoomPlayback(user: User | null | undefined, room: Room | null | undefined): boolean {
  if (!user || !room) return false
  // The server accounts for privacy, link memberships and relative owner rank.
  return room.canViewPlayback ?? (room.ownerId === user.id || isStaff(user))
}

/** Share links, the room name and its language belong to the owner and staff. */
export function canManageRoom(user: Actor, roomOwnerId: string | null | undefined): boolean {
  return !!user && !!roomOwnerId && (user.id === roomOwnerId || isStaff(user))
}

export const canManageRoomShares = canManageRoom
export const canChangeRoomLanguage = canManageRoom
export const canEndRoom = canManageRoom

export function canDeleteRoom(user: Actor): boolean {
  return isAdmin(user)
}

/** Admins manage every account; agents create and remove tech accounts only. */
export function canManageAccount(actor: Pick<User, 'role'> | null | undefined, role: Role): boolean {
  return isAdmin(actor) || (isStaff(actor) && role === 'tech')
}
