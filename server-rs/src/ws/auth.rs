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
        TokenPayload::User(user_payload) => {
            authenticate_user(state, document_name, &user_payload).await
        }
        TokenPayload::Guest(guest_payload) => {
            authenticate_guest(state, document_name, &guest_payload).await
        }
    }
}

async fn authenticate_user(
    state: &AppState,
    document_name: &str,
    payload: &crate::auth::UserTokenPayload,
) -> Result<AuthOutcome, String> {
    let result = sqlx::query_as::<_, WsAuthCombinedRow>(
        r#"
        SELECT
            u.id as user_id,
            u.role,
            u."canReadAllRooms" as can_read_all_rooms,
            u."canWriteAllRooms" as can_write_all_rooms,
            u."canDeleteAllRooms" as can_delete_all_rooms,
            u."isDeleted" as user_is_deleted,
            r.id as room_id,
            r."ownerId" as owner_id,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as is_ended,
            p."canEdit" as participant_can_edit
        FROM "User" u
        CROSS JOIN "Room" r
        LEFT JOIN "RoomParticipant" p ON p."roomId" = r.id AND p."userId" = u.id
        WHERE u.id = $1 AND r.id = $2
        "#,
    )
    .bind(&payload.user_id)
    .bind(document_name)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| {
        format!(
            "Authentication failed: {}",
            db_error(err, "Failed to load auth data")
        )
    })?;

    let row = match result {
        Some(row) if !row.user_is_deleted => row,
        _ => return Err("Authentication failed: User or Room not found".to_string()),
    };

    if row.room_is_deleted {
        return Err("Authentication failed: Access denied".to_string());
    }

    let is_owner = row.owner_id == row.user_id;
    let can_read_globally =
        row.can_read_all_rooms || row.can_write_all_rooms || row.can_delete_all_rooms;
    let can_write_globally = row.can_write_all_rooms || row.can_delete_all_rooms;
    let is_privileged = row.role == "admin" || row.role == "superuser" || can_read_globally;

    if row.is_ended && !is_owner && !is_privileged {
        return Err("Authentication failed: Access denied".to_string());
    }

    let has_access = can_read_globally || is_owner || row.participant_can_edit.is_some();
    if !has_access {
        return Err("Authentication failed: Access denied".to_string());
    }

    let participant_can_edit = row.participant_can_edit.unwrap_or(false);
    let can_edit = if row.is_ended {
        false
    } else {
        can_write_globally || is_owner || participant_can_edit
    };

    let db = state.db.clone();
    let user_id = row.user_id.clone();
    let room_id = row.room_id.clone();
    let is_ended = row.is_ended;
    let needs_participant = !is_ended && !is_owner && row.participant_can_edit.is_none();

    tokio::spawn(async move {
        if needs_participant {
            let _ = sqlx::query(
                r#"
                INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit")
                VALUES ($1, $2, $3, $4)
                ON CONFLICT ("roomId", "userId") DO NOTHING
                "#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&room_id)
            .bind(&user_id)
            .bind(can_write_globally)
            .execute(&db)
            .await;
        }

        let _ = sqlx::query(
            r#"
            UPDATE "User"
            SET "lastSeen" = NOW()
            WHERE id = $1
            "#,
        )
        .bind(&user_id)
        .execute(&db)
        .await;
    });

    Ok(AuthOutcome {
        read_only: !can_edit,
        actor_id: Some(row.user_id),
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
    .map_err(|err| {
        format!(
            "Authentication failed: {}",
            db_error(err, "Failed to load guest session")
        )
    })?;

    let guest = match guest {
        Some(guest) => guest,
        None => return Err("Authentication failed: Guest session not found".to_string()),
    };

    if guest.token != payload.session_token {
        return Err("Authentication failed: Guest session token mismatch".to_string());
    }

    if guest.room_id != document_name {
        return Err(
            "Authentication failed: Guest session does not match this document".to_string(),
        );
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
    .bind(Utc::now())
    .bind(effective_can_edit)
    .execute(&state.db)
    .await
    .map_err(|err| {
        format!(
            "Authentication failed: {}",
            db_error(err, "Failed to update guest session")
        )
    })?;

    Ok(AuthOutcome {
        read_only: !effective_can_edit,
        actor_id: Some(guest.id),
    })
}

#[derive(sqlx::FromRow)]
struct WsAuthCombinedRow {
    user_id: String,
    role: String,
    can_read_all_rooms: bool,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
    user_is_deleted: bool,
    room_id: String,
    owner_id: String,
    room_is_deleted: bool,
    is_ended: bool,
    participant_can_edit: Option<bool>,
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
