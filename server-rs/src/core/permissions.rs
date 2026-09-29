use crate::auth::{AuthActor, AuthUser};
use crate::{db::db_error, error::ApiError};

// SQL lists use r (room), o (owner), and bind viewer ID/role/global-read first.
pub const ROOM_VISIBILITY_SQL: &str = r#"room_is_visible(
    $1, $2, $3, r."ownerId", o.role, r."isPrivate", r."isEnded", r."isDeleted",
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1),
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay" AND p."shareLinkId" IS NOT NULL)
)"#;

pub const ROOM_PLAYBACK_SQL: &str = r#"(r."ownerId" = $1 OR $3
    OR (r."isPrivate" AND room_role_rank($2) > room_role_rank(o.role))
    OR (NOT r."isPrivate" AND EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay" AND p."shareLinkId" IS NOT NULL)))"#;

pub const SHARE_READ_ONLY_SQL: &str = r#"(NOT r."isPrivate" AND EXISTS(
    SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1
    AND p."canReplay" AND p."shareLinkId" IS NOT NULL AND NOT p."canEdit"))"#;

#[derive(sqlx::FromRow)]
pub struct RoomAccess {
    pub owner_id: String,
    pub is_ended: bool,
    pub can_view: bool,
    pub can_view_playback: bool,
    #[sqlx(default)]
    pub can_edit: bool,
    pub share_read_only: bool,
    participant_can_edit: Option<bool>,
    share_controls_edit: bool,
}

pub async fn require_room_access(
    db: &sqlx::PgPool,
    user: &AuthUser,
    room_id: &str,
) -> Result<RoomAccess, ApiError> {
    let sql = format!(
        r#"SELECT r."ownerId" as owner_id, r."isEnded" as is_ended,
        {ROOM_VISIBILITY_SQL} as can_view,
        {ROOM_PLAYBACK_SQL} as can_view_playback,
        {SHARE_READ_ONLY_SQL} as share_read_only,
        p."canEdit" as participant_can_edit,
        (NOT r."isPrivate" AND COALESCE(p."canReplay", false) AND p."shareLinkId" IS NOT NULL) as share_controls_edit
        FROM "Room" r JOIN "User" o ON o.id = r."ownerId"
        LEFT JOIN "RoomParticipant" p ON p."roomId" = r.id AND p."userId" = $1
        WHERE r.id = $4"#
    );
    let access = sqlx::query_as::<_, RoomAccess>(&sql)
        .bind(&user.id)
        .bind(&user.role)
        .bind(has_global_read(user))
        .bind(room_id)
        .fetch_optional(db)
        .await
        .map_err(|err| db_error(err, "Failed to check room access"))?;
    let mut access = access
        .filter(|room| room.can_view)
        .ok_or_else(|| ApiError::not_found("Room not found"))?;
    access.can_edit = can_edit_room_content(
        access.is_ended,
        access.owner_id == user.id,
        has_global_write(user),
        access.participant_can_edit,
        access.share_controls_edit,
    );
    Ok(access)
}

pub fn is_share_read_only(
    room: &crate::models::RoomWithOwnerRow,
    participant: Option<&crate::models::RoomParticipantWithUserRow>,
) -> bool {
    !room.is_private
        && participant.is_some_and(|p| p.can_replay && p.share_link_id.is_some() && !p.can_edit)
}

// A successful result authorizes reading content; its value authorizes writing.
pub async fn require_content_access(
    db: &sqlx::PgPool,
    actor: &AuthActor,
    room_id: &str,
) -> Result<bool, ApiError> {
    match actor {
        AuthActor::User(user) => Ok(require_room_access(db, user, room_id).await?.can_edit),
        AuthActor::Guest(guest) => {
            if guest.room_id != room_id {
                return Err(ApiError::not_found("Room not found"));
            }
            sqlx::query_scalar::<_, bool>(
                r#"SELECT g."canEdit" AND r."allowEdit" AND l."canEdit"
                FROM "GuestSession" g JOIN "Room" r ON r.id = g."roomId"
                JOIN "RoomShareLink" l ON l.id = g."shareLinkId" AND l."roomId" = r.id
                WHERE g.id = $1 AND g."shareLinkId" = $2 AND g.token = $3 AND r.id = $4
                  AND NOT r."isDeleted" AND NOT r."isEnded""#,
            )
            .bind(&guest.guest_id)
            .bind(&guest.share_link_id)
            .bind(&guest.session_token)
            .bind(room_id)
            .fetch_optional(db)
            .await
            .map_err(|e| db_error(e, "Failed to check guest room access"))?
            .ok_or_else(|| ApiError::not_found("Room not found"))
        }
    }
}

pub fn can_edit_room(
    user: &AuthUser,
    room: &crate::models::RoomWithOwnerRow,
    participant: Option<&crate::models::RoomParticipantWithUserRow>,
) -> bool {
    can_edit_room_content(
        room.is_ended,
        room.owner_id == user.id,
        has_global_write(user),
        participant.map(|p| p.can_edit),
        !room.is_private && participant.is_some_and(|p| p.can_replay && p.share_link_id.is_some()),
    )
}

// Document editing and note mutations must use exactly the same write rule.
pub fn can_edit_room_content(
    is_ended: bool,
    is_owner: bool,
    global_write: bool,
    participant_can_edit: Option<bool>,
    share_controls_edit: bool,
) -> bool {
    if is_ended {
        return false;
    }
    if share_controls_edit {
        return participant_can_edit.unwrap_or(false);
    }
    is_owner || global_write || participant_can_edit.unwrap_or(false)
}

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

// Only superusers have implicit global capabilities; admin flags are authoritative.
// Previously admin implied write access even after its checkbox was cleared.
// Superusers have all three global-room capabilities,
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
    role == "superuser" || can_read_all_rooms || can_write_all_rooms || can_delete_all_rooms
}

pub fn role_has_global_write(
    role: &str,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
) -> bool {
    role == "superuser" || can_write_all_rooms || can_delete_all_rooms
}

pub fn role_has_global_delete(role: &str, can_delete_all_rooms: bool) -> bool {
    role == "superuser" || can_delete_all_rooms
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
