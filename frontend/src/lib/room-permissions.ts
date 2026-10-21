import type { Room, User } from '@/types'

// Mirrors server-rs/src/core/permissions.rs: the role alone decides room access.
// The server stays authoritative; these only decide which controls to show.

type Actor = Pick<User, 'id' | 'role'> | null | undefined

/** Admins only: the admin dashboard and audit log, accounts, deleting rooms, private rooms. */
export function isAdmin(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin'
}

/** Agents and admins see, edit, share, pin and end every room and invite techs. */
export function isStaff(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'agent'
}

export function canViewRoomPlayback(user: User | null | undefined, room: Room | null | undefined): boolean {
  if (!user || !room) return false
  // The server accounts for privacy, link memberships and relative owner rank.
  return room.canViewPlayback ?? (room.ownerId === user.id || isStaff(user))
}

/** Share links and the room name belong to the owner and staff. */
export function canManageRoom(user: Actor, roomOwnerId: string | null | undefined): boolean {
  return !!user && !!roomOwnerId && (user.id === roomOwnerId || isStaff(user))
}

export const canManageRoomShares = canManageRoom
/** The language: the owner and staff, and whoever else edits the live room (an editing link). */
export function canChangeRoomLanguage(user: Actor, room: Pick<Room, 'ownerId' | 'canEdit'> | null | undefined): boolean {
  return !!user && !!room && (canManageRoom(user, room.ownerId) || room.canEdit === true)
}
export const canEndRoom = canManageRoom

export function canDeleteRoom(user: Actor): boolean {
  return isAdmin(user)
}
