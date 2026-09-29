import type { Role, Room, User } from '@/types'

export function canViewRoomPlayback(user: User | null | undefined, room: Room | null | undefined): boolean {
  if (!user || !room) return false
  // The server accounts for privacy, membership and relative owner rank.
  return room.canViewPlayback ?? (room.ownerId === user.id || user.role === 'superuser' ||
    user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms)
}

export type RoomLifecycleAction = 'delete' | 'end'

type RoomLifecyclePermissions = {
  delete: boolean
  end: boolean
}

type RoomLifecyclePermissionMatrix = {
  owned: RoomLifecyclePermissions
  others: RoomLifecyclePermissions
}

const ROOM_LIFECYCLE_PERMISSION_MATRIX: Record<Role, RoomLifecyclePermissionMatrix> = {
  user: {
    owned: {
      delete: false,
      end: true,
    },
    others: {
      delete: false,
      end: false,
    },
  },
  admin: {
    owned: {
      delete: false,
      end: true,
    },
    others: {
      delete: false,
      end: false,
    },
  },
  superuser: {
    owned: {
      delete: true,
      end: true,
    },
    others: {
      delete: true,
      end: true,
    },
  },
}

export function canPerformRoomLifecycleAction(
  user: Pick<User, 'id' | 'role'> | null | undefined,
  roomOwnerId: string | null | undefined,
  action: RoomLifecycleAction
): boolean {
  if (!user || !roomOwnerId) {
    return false
  }

  const matrix = ROOM_LIFECYCLE_PERMISSION_MATRIX[user.role]
  const permissions = user.id === roomOwnerId ? matrix.owned : matrix.others
  return permissions[action]
}

export function canDeleteRoom(
  user: Pick<User, 'id' | 'role'> | null | undefined,
  roomOwnerId: string | null | undefined
): boolean {
  return canPerformRoomLifecycleAction(user, roomOwnerId, 'delete')
}

export function canEndRoom(
  user: Pick<User, 'id' | 'role'> | null | undefined,
  roomOwnerId: string | null | undefined
): boolean {
  return canPerformRoomLifecycleAction(user, roomOwnerId, 'end')
}

export function hasGlobalDeletePermission(
  user: Pick<User, 'role' | 'canDeleteAllRooms'> | null | undefined
): boolean {
  if (!user) return false
  return user.role === 'superuser' || user.canDeleteAllRooms
}

export function canManageRoomShares(
  user: Pick<User, 'id' | 'role' | 'canDeleteAllRooms'> | null | undefined,
  roomOwnerId: string | null | undefined
): boolean {
  if (!user || !roomOwnerId) {
    return false
  }

  return user.id === roomOwnerId || user.role === 'superuser' || hasGlobalDeletePermission(user)
}

// Language is a room setting, independent of global document-write flags.
export function canChangeRoomLanguage(
  user: Pick<User, 'id' | 'role'> | null | undefined,
  roomOwnerId: string | null | undefined
): boolean {
  return !!user && !!roomOwnerId &&
    (user.id === roomOwnerId || user.role === 'admin' || user.role === 'superuser')
}
