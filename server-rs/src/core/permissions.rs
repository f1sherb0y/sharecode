use crate::auth::{AuthActor, AuthUser};
use crate::{db::db_error, error::ApiError};

// The role alone decides room access. These rules are enforced identically on
// the REST and WebSocket paths, together with room_is_visible() in SQL (see
// the roles migration) — do not duplicate this logic elsewhere; call these helpers.
/// 管理员: everything, including deleting rooms and creating private rooms.
pub const ROLE_ADMIN: &str = "admin";
/// 中介: sees, edits, shares, pins and ends every standard room.
pub const ROLE_AGENT: &str = "agent";
/// 技术: own rooms, live pinned rooms (read-only) and rooms joined by share link.
pub const ROLE_TECH: &str = "tech";
pub const VALID_ROLES: [&str; 3] = [ROLE_ADMIN, ROLE_AGENT, ROLE_TECH];

pub fn is_admin(role: &str) -> bool {
    role == ROLE_ADMIN
}

/// Agents and admins can read and write every room they can see.
pub fn is_staff(role: &str) -> bool {
    role == ROLE_ADMIN || role == ROLE_AGENT
}

pub fn has_global_read(user: &AuthUser) -> bool {
    is_staff(&user.role)
}

// SQL lists use r (room), o (owner), and bind viewer ID/role/global-read first.
pub const ROOM_VISIBILITY_SQL: &str = r#"room_is_visible(
    $1, $2, $3, r."ownerId", o.role, r."isPrivate", r."isPinned", r."isEnded", r."isDeleted",
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1),
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay")
)"#;

pub const ROOM_PLAYBACK_SQL: &str = r#"(r."ownerId" = $1 OR $3
    OR (r."isPrivate" AND room_role_rank($2) > room_role_rank(o.role))
    OR (NOT r."isPrivate" AND EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay")))"#;

#[derive(sqlx::FromRow)]
pub struct RoomAccess {
    pub owner_id: String,
    pub is_ended: bool,
    pub can_view: bool,
    pub can_view_playback: bool,
    #[sqlx(default)]
    pub can_edit: bool,
    participant_can_edit: Option<bool>,
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
        p."canEdit" as participant_can_edit
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
        is_staff(&user.role),
        access.participant_can_edit,
    );
    Ok(access)
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
        is_staff(&user.role),
        participant.map(|p| p.can_edit),
    )
}

// Document editing and note mutations must use exactly the same write rule.
// A link membership's canEdit is the permission of the link last joined through.
pub fn can_edit_room_content(
    is_ended: bool,
    is_owner: bool,
    staff: bool,
    participant_can_edit: Option<bool>,
) -> bool {
    !is_ended && (is_owner || staff || participant_can_edit.unwrap_or(false))
}

/// Share links and the room name belong to the owner and staff; members and share guests
/// who joined through a link edit content and, when that link lets them edit, the language.
pub fn can_manage_room(user: &AuthUser, room_owner_id: &str) -> bool {
    user.id == room_owner_id || is_staff(&user.role)
}

pub fn can_end_room(user: &AuthUser, room_owner_id: &str) -> bool {
    can_manage_room(user, room_owner_id)
}

/// Only admins delete rooms, including their own.
pub fn can_delete_room(user: &AuthUser) -> bool {
    is_admin(&user.role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_rank_admin_over_agent_over_tech() {
        assert!(is_admin(ROLE_ADMIN) && !is_admin(ROLE_AGENT) && !is_admin(ROLE_TECH));
        assert!(is_staff(ROLE_ADMIN) && is_staff(ROLE_AGENT) && !is_staff(ROLE_TECH));
        // Retired role names grant nothing if an old value ever reappears.
        for retired in ["superuser", "user", ""] {
            assert!(!is_staff(retired) && !is_admin(retired));
        }
    }

    #[test]
    fn content_edits_follow_ownership_staff_or_link_permission() {
        // Ended rooms are read-only for everyone.
        assert!(!can_edit_room_content(true, true, true, Some(true)));
        assert!(can_edit_room_content(false, true, false, None));
        assert!(can_edit_room_content(false, false, true, Some(false)));
        // A tech's membership edits only if the last link joined through allows it.
        assert!(can_edit_room_content(false, false, false, Some(true)));
        assert!(!can_edit_room_content(false, false, false, Some(false)));
        // Pinned rooms grant visibility only.
        assert!(!can_edit_room_content(false, false, false, None));
    }
}
