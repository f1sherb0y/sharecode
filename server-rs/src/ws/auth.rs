use chrono::Utc;
use uuid::Uuid;

use crate::{
    auth::{verify_token, TokenPayload},
    db::db_error,
    state::AppState,
};

pub(crate) struct AuthOutcome {
    pub(crate) read_only: bool,
    pub(crate) actor_id: Option<String>,
}

pub(crate) async fn authenticate(
    state: &AppState,
    document_name: &str,
    token: &str,
) -> Result<AuthOutcome, String> {
    if token.is_empty() {
        return Err("Authentication failed: No authentication token provided".to_string());
    }

    let payload = verify_token(&state.config, token)
        .map_err(|err| format!("Authentication failed: {}", err))?;

    match payload {
        TokenPayload::User(user_payload) => authenticate_user(state, document_name, &user_payload).await,
        TokenPayload::Guest(guest_payload) => authenticate_guest(state, document_name, &guest_payload).await,
    }
}

async fn authenticate_user(
    state: &AppState,
    document_name: &str,
    payload: &crate::auth::UserTokenPayload,
) -> Result<AuthOutcome, String> {
    let user = sqlx::query_as::<_, WsUserRow>(
        r#"
        SELECT
            id,
            role,
            "canReadAllRooms" as can_read_all_rooms,
            "canWriteAllRooms" as can_write_all_rooms,
            "canDeleteAllRooms" as can_delete_all_rooms,
            "isDeleted" as is_deleted
        FROM "User"
        WHERE id = $1
        "#,
    )
    .bind(&payload.user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to load user")))?;

    let user = match user {
        Some(user) if !user.is_deleted => user,
        _ => return Err("Authentication failed: User not found".to_string()),
    };

    let room = sqlx::query_as::<_, WsRoomRow>(
        r#"
        SELECT
            id,
            "ownerId" as owner_id,
            "isDeleted" as is_deleted,
            "isEnded" as is_ended
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(document_name)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to load room")))?;

    let room = match room {
        Some(room) => room,
        None => return Err("Authentication failed: Access denied".to_string()),
    };

    if room.is_deleted {
        return Err("Authentication failed: Access denied".to_string());
    }

    let participant = sqlx::query_as::<_, WsParticipantRow>(
        r#"
        SELECT "canEdit" as can_edit
        FROM "RoomParticipant"
        WHERE "roomId" = $1 AND "userId" = $2
        "#,
    )
    .bind(&room.id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to load participant")))?;

    let is_owner = room.owner_id == user.id;
    let can_read_globally =
        user.can_read_all_rooms || user.can_write_all_rooms || user.can_delete_all_rooms;
    let can_write_globally = user.can_write_all_rooms || user.can_delete_all_rooms;
    let is_privileged =
        user.role == "admin" || user.role == "superuser" || can_read_globally;

    if room.is_ended && !is_owner && !is_privileged {
        return Err("Authentication failed: Access denied".to_string());
    }

    let has_access = can_read_globally || is_owner || participant.is_some();
    if !has_access {
        return Err("Authentication failed: Access denied".to_string());
    }

    let participant_can_edit = participant.as_ref().map(|p| p.can_edit).unwrap_or(false);
    let can_edit = if room.is_ended {
        false
    } else {
        can_write_globally || is_owner || participant_can_edit
    };

    if !room.is_ended && !is_owner && participant.is_none() {
        sqlx::query(
            r#"
            INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit")
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&room.id)
        .bind(&user.id)
        .bind(can_write_globally)
        .execute(&state.db)
        .await
        .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to add participant")))?;
    }

    sqlx::query(
        r#"
        UPDATE "User"
        SET "lastSeen" = $2
        WHERE id = $1
        "#,
    )
    .bind(&user.id)
    .bind(Utc::now().naive_utc())
    .execute(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to update user")))?;

    Ok(AuthOutcome {
        read_only: !can_edit,
        actor_id: Some(user.id),
    })
}

async fn authenticate_guest(
    state: &AppState,
    document_name: &str,
    payload: &crate::auth::GuestTokenPayload,
) -> Result<AuthOutcome, String> {
    let guest = sqlx::query_as::<_, WsGuestRow>(
        r#"
        SELECT
            g.id,
            g.token,
            g."canEdit" as can_edit,
            r.id as room_id,
            r."allowEdit" as room_allow_edit,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as room_is_ended,
            l."canEdit" as share_can_edit
        FROM "GuestSession" g
        JOIN "Room" r ON r.id = g."roomId"
        JOIN "RoomShareLink" l ON l.id = g."shareLinkId"
        WHERE g.id = $1
        "#,
    )
    .bind(&payload.guest_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to load guest session")))?;

    let guest = match guest {
        Some(guest) => guest,
        None => return Err("Authentication failed: Guest session not found".to_string()),
    };

    if guest.token != payload.session_token {
        return Err("Authentication failed: Guest session token mismatch".to_string());
    }

    if guest.room_id != document_name {
        return Err("Authentication failed: Guest session does not match this document".to_string());
    }

    if guest.room_is_deleted || guest.room_is_ended {
        return Err("Authentication failed: Room is no longer available".to_string());
    }

    let effective_can_edit = guest.can_edit && guest.room_allow_edit && guest.share_can_edit;

    sqlx::query(
        r#"
        UPDATE "GuestSession"
        SET "lastActive" = $2, "canEdit" = $3
        WHERE id = $1
        "#,
    )
    .bind(&guest.id)
    .bind(Utc::now().naive_utc())
    .bind(effective_can_edit)
    .execute(&state.db)
    .await
    .map_err(|err| format!("Authentication failed: {}", db_error(err, "Failed to update guest session")))?;

    Ok(AuthOutcome {
        read_only: !effective_can_edit,
        actor_id: Some(guest.id),
    })
}

#[derive(sqlx::FromRow)]
struct WsUserRow {
    id: String,
    role: String,
    can_read_all_rooms: bool,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
    is_deleted: bool,
}

#[derive(sqlx::FromRow)]
struct WsRoomRow {
    id: String,
    owner_id: String,
    is_deleted: bool,
    is_ended: bool,
}

#[derive(sqlx::FromRow)]
struct WsParticipantRow {
    can_edit: bool,
}

#[derive(sqlx::FromRow)]
struct WsGuestRow {
    id: String,
    token: String,
    can_edit: bool,
    room_id: String,
    room_allow_edit: bool,
    room_is_deleted: bool,
    room_is_ended: bool,
    share_can_edit: bool,
}
