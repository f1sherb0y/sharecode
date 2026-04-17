use crate::auth::AuthUser;

#[derive(Clone, Copy)]
pub enum RoomLifecycleAction {
    Delete,
    End,
}

#[derive(Clone, Copy)]
struct RoomLifecyclePermissions {
    delete: bool,
    end: bool,
}

#[derive(Clone, Copy)]
struct RoomLifecyclePermissionMatrix {
    owned: RoomLifecyclePermissions,
    others: RoomLifecyclePermissions,
}

const USER_ROOM_LIFECYCLE_PERMISSIONS: RoomLifecyclePermissionMatrix =
    RoomLifecyclePermissionMatrix {
        owned: RoomLifecyclePermissions {
            delete: false,
            end: true,
        },
        others: RoomLifecyclePermissions {
            delete: false,
            end: false,
        },
    };

const ADMIN_ROOM_LIFECYCLE_PERMISSIONS: RoomLifecyclePermissionMatrix =
    USER_ROOM_LIFECYCLE_PERMISSIONS;

const SUPERUSER_ROOM_LIFECYCLE_PERMISSIONS: RoomLifecyclePermissionMatrix =
    RoomLifecyclePermissionMatrix {
        owned: RoomLifecyclePermissions {
            delete: true,
            end: true,
        },
        others: RoomLifecyclePermissions {
            delete: true,
            end: true,
        },
    };

fn room_lifecycle_permission_matrix(role: &str) -> RoomLifecyclePermissionMatrix {
    match role {
        "superuser" => SUPERUSER_ROOM_LIFECYCLE_PERMISSIONS,
        "admin" => ADMIN_ROOM_LIFECYCLE_PERMISSIONS,
        _ => USER_ROOM_LIFECYCLE_PERMISSIONS,
    }
}

pub fn can_manage_room_lifecycle(
    user: &AuthUser,
    room_owner_id: &str,
    action: RoomLifecycleAction,
) -> bool {
    let matrix = room_lifecycle_permission_matrix(&user.role);
    let permissions = if user.id == room_owner_id {
        matrix.owned
    } else {
        matrix.others
    };

    match action {
        RoomLifecycleAction::Delete => permissions.delete,
        RoomLifecycleAction::End => permissions.end,
    }
}

// Admin and superuser roles implicitly have all three global-room capabilities,
// regardless of whether the `canReadAllRooms` / `canWriteAllRooms` /
// `canDeleteAllRooms` flags are explicitly set on their account. The flags
// exist to grant the same room-wide access to normal users. This is enforced
// identically on the REST and WebSocket paths — do not duplicate this logic
// elsewhere; call these helpers.

pub fn role_has_global_read(
    role: &str,
    can_read_all_rooms: bool,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
) -> bool {
    role == "admin"
        || role == "superuser"
        || can_read_all_rooms
        || can_write_all_rooms
        || can_delete_all_rooms
}

pub fn role_has_global_write(
    role: &str,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
) -> bool {
    role == "admin" || role == "superuser" || can_write_all_rooms || can_delete_all_rooms
}

pub fn role_has_global_delete(role: &str, can_delete_all_rooms: bool) -> bool {
    role == "admin" || role == "superuser" || can_delete_all_rooms
}

pub fn has_global_read(user: &AuthUser) -> bool {
    role_has_global_read(
        &user.role,
        user.can_read_all_rooms,
        user.can_write_all_rooms,
        user.can_delete_all_rooms,
    )
}

pub fn has_global_write(user: &AuthUser) -> bool {
    role_has_global_write(
        &user.role,
        user.can_write_all_rooms,
        user.can_delete_all_rooms,
    )
}

pub fn has_global_delete(user: &AuthUser) -> bool {
    role_has_global_delete(&user.role, user.can_delete_all_rooms)
}
