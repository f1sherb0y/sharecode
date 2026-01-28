use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{Duration, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::db_error,
    error::ApiError,
    models::{RoomParticipantWithUserRow, RoomWithOwnerRow, UserSimpleRow},
    permissions::{has_global_delete, has_global_read, has_global_write},
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
    ws,
};

const SUPPORTED_LANGUAGES: [&str; 8] = [
    "javascript",
    "typescript",
    "python",
    "java",
    "cpp",
    "rust",
    "go",
    "php",
];

#[derive(Debug, sqlx::FromRow)]
struct RoomOwnerRow {
    owner_id: String,
}

#[derive(Debug, sqlx::FromRow)]
struct RoomEndedRow {
    is_ended: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateRoomPayload {
    pub name: Option<String>,
    pub language: Option<String>,
    #[serde(rename = "scheduledTime")]
    pub scheduled_time: Option<String>,
    pub duration: Option<i32>,
    #[serde(default, rename = "allowedUsers")]
    pub allowed_users: Vec<AllowedUserPayload>,
}

#[derive(Debug, Deserialize)]
pub struct AllowedUserPayload {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "canEdit")]
    pub can_edit: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRoomPayload {
    pub name: Option<String>,
    pub language: Option<String>,
}

pub async fn get_all_users_for_room_creation(
    State(state): State<AppState>,
    _auth_user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let users = sqlx::query_as::<_, UserSimpleRow>(
        r#"
        SELECT id, username, color, role
        FROM "User"
        WHERE "isDeleted" = false
        ORDER BY username ASC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load users"))?;

    let response = users
        .into_iter()
        .map(|user| {
            json!({
                "id": user.id,
                "username": user.username,
                "color": user.color,
                "role": user.role,
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({ "users": response })))
}

pub async fn create_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(payload): Json<CreateRoomPayload>,
) -> Result<impl IntoResponse, ApiError> {
    let name = payload.name.unwrap_or_default();
    let language = payload.language.unwrap_or_else(|| "javascript".to_string());

    if name.is_empty() {
        return Err(ApiError::bad_request("Room name is required"));
    }

    if !SUPPORTED_LANGUAGES.contains(&language.as_str()) {
        return Err(ApiError::bad_request("Unsupported language"));
    }

    let scheduled_time = match payload.scheduled_time {
        Some(value) if !value.is_empty() => Some(parse_scheduled_time(&value)?),
        _ => None,
    };

    let duration = payload.duration.filter(|value| *value != 0);

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|err| db_error(err, "Failed to begin room transaction"))?;

    let room_id = Uuid::new_v4().to_string();
    let room = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        INSERT INTO "Room" (id, name, language, "ownerId", "scheduledTime", duration, "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING
            id,
            name,
            language,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isDeleted" as is_deleted,
            "scheduledTime" as scheduled_time,
            duration,
            "isEnded" as is_ended,
            "endedAt" as ended_at,
            "createdAt" as created_at,
            "updatedAt" as updated_at,
            (SELECT username FROM "User" WHERE id = "ownerId") as owner_username,
            (SELECT color FROM "User" WHERE id = "ownerId") as owner_color
        "#,
    )
    .bind(&room_id)
    .bind(&name)
    .bind(&language)
    .bind(&auth_user.id)
    .bind(scheduled_time)
    .bind(duration)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create room"))?;

    sqlx::query(
        r#"
        INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit")
        VALUES ($1, $2, $3, true)
        "#
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&room.id)
    .bind(&auth_user.id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to add owner as participant"))?;

    if !payload.allowed_users.is_empty() {
        for allowed in payload.allowed_users {
            if allowed.user_id == auth_user.id {
                continue;
            }
            let can_edit = allowed.can_edit.unwrap_or(true);
            sqlx::query(
                r#"
                INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit")
                VALUES ($1, $2, $3, $4)
                ON CONFLICT ("roomId", "userId") DO NOTHING
                "#
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&room.id)
            .bind(&allowed.user_id)
            .bind(can_edit)
            .execute(&mut *tx)
            .await
            .map_err(|err| db_error(err, "Failed to add participant"))?;
        }
    }

    tx.commit()
        .await
        .map_err(|err| db_error(err, "Failed to commit room transaction"))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "room": room_to_json_owner(&room) })),
    ))
}

pub async fn get_rooms(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rooms = if has_global_read(&auth_user) {
        sqlx::query_as::<_, RoomWithOwnerRow>(
            r#"
            SELECT
                r.id,
                r.name,
                r.language,
                r."ownerId" as owner_id,
                r."allowEdit" as allow_edit,
                r."isDeleted" as is_deleted,
                r."scheduledTime" as scheduled_time,
                r.duration,
                r."isEnded" as is_ended,
                r."endedAt" as ended_at,
                r."createdAt" as created_at,
                r."updatedAt" as updated_at,
                o.username as owner_username,
                o.color as owner_color
            FROM "Room" r
            JOIN "User" o ON o.id = r."ownerId"
            WHERE r."isDeleted" = false
            ORDER BY r."updatedAt" DESC
            "#,
        )
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms"))?
    } else {
        sqlx::query_as::<_, RoomWithOwnerRow>(
            r#"
            SELECT DISTINCT
                r.id,
                r.name,
                r.language,
                r."ownerId" as owner_id,
                r."allowEdit" as allow_edit,
                r."isDeleted" as is_deleted,
                r."scheduledTime" as scheduled_time,
                r.duration,
                r."isEnded" as is_ended,
                r."endedAt" as ended_at,
                r."createdAt" as created_at,
                r."updatedAt" as updated_at,
                o.username as owner_username,
                o.color as owner_color
            FROM "Room" r
            JOIN "User" o ON o.id = r."ownerId"
            LEFT JOIN "RoomParticipant" rp ON rp."roomId" = r.id
            WHERE r."isDeleted" = false
              AND (r."ownerId" = $1 OR (rp."userId" = $1 AND r."isEnded" = false))
            ORDER BY r."updatedAt" DESC
            "#,
        )
        .bind(&auth_user.id)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms"))?
    };

    let mut response = Vec::with_capacity(rooms.len());
    let now = Utc::now().naive_utc();

    for room in rooms {
        let participants = fetch_participants(&state, &room.id).await?;
        let user_participant = participants.iter().find(|p| p.user_id == auth_user.id);
        let is_owner = room.owner_id == auth_user.id;
        let is_member = is_owner || user_participant.is_some();
        let can_edit = is_owner
            || has_global_write(&auth_user)
            || user_participant.map(|p| p.can_edit).unwrap_or(false);

        let is_expired = room
            .scheduled_time
            .and_then(|scheduled| room.duration.map(|dur| scheduled + Duration::minutes(dur as i64)))
            .map(|end_time| end_time < now)
            .unwrap_or(false);

        response.push(room_to_json_with_flags(
            &room,
            participants,
            is_member,
            is_owner,
            can_edit,
            is_expired,
        ));
    }

    Ok(Json(json!({ "rooms": response })))
}

pub async fn get_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        SELECT
            r.id,
            r.name,
            r.language,
            r."ownerId" as owner_id,
            r."allowEdit" as allow_edit,
            r."isDeleted" as is_deleted,
            r."scheduledTime" as scheduled_time,
            r.duration,
            r."isEnded" as is_ended,
            r."endedAt" as ended_at,
            r."createdAt" as created_at,
            r."updatedAt" as updated_at,
            o.username as owner_username,
            o.color as owner_color
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        WHERE r.id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    let participants = fetch_participants(&state, &room.id).await?;
    let is_owner = room.owner_id == auth_user.id;
    let is_participant = participants.iter().any(|p| p.user_id == auth_user.id);
    let is_admin = auth_user.role == "admin"
        || auth_user.role == "superuser"
        || has_global_read(&auth_user);

    if !is_admin && !is_owner && !is_participant {
        return Err(ApiError::forbidden("Access denied"));
    }

    if room.is_ended && !is_owner && !is_admin {
        return Err(ApiError::forbidden(
            "Room has ended and is no longer accessible",
        ));
    }

    let user_participant = participants.iter().find(|p| p.user_id == auth_user.id);
    let can_edit = has_global_write(&auth_user)
        || is_owner
        || user_participant.map(|p| p.can_edit).unwrap_or(false);

    let mut room_value = room_to_json(&room, participants);
    if let Some(obj) = room_value.as_object_mut() {
        obj.insert("isMember".to_string(), json!(is_owner || is_participant));
        obj.insert("isOwner".to_string(), json!(is_owner));
        obj.insert("canEdit".to_string(), json!(can_edit));
    }

    Ok(Json(json!({ "room": room_value })))
}

pub async fn get_room_by_document_id(
    state: State<AppState>,
    auth_user: AuthUser,
    Path(document_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if document_id.is_empty() {
        return Err(ApiError::bad_request("Document ID is required"));
    }
    get_room(state, auth_user, Path(document_id)).await
}

pub async fn update_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
    Json(payload): Json<UpdateRoomPayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        SELECT
            r.id,
            r.name,
            r.language,
            r."ownerId" as owner_id,
            r."allowEdit" as allow_edit,
            r."isDeleted" as is_deleted,
            r."scheduledTime" as scheduled_time,
            r.duration,
            r."isEnded" as is_ended,
            r."endedAt" as ended_at,
            r."createdAt" as created_at,
            r."updatedAt" as updated_at,
            o.username as owner_username,
            o.color as owner_color
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        WHERE r.id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    let participants = fetch_participants(&state, &room.id).await?;
    let is_owner = room.owner_id == auth_user.id;
    let participant = participants.iter().find(|p| p.user_id == auth_user.id);
    let can_edit = has_global_write(&auth_user) || is_owner || participant.map(|p| p.can_edit).unwrap_or(false);

    if !can_edit {
        return Err(ApiError::forbidden("Not authorized to modify this room"));
    }

    let name = payload.name.filter(|value| !value.is_empty());
    let language = payload
        .language
        .filter(|value| !value.is_empty())
        .filter(|value| SUPPORTED_LANGUAGES.contains(&value.as_str()));

    let updated = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        UPDATE "Room"
        SET name = COALESCE($2, name),
            language = COALESCE($3, language),
            "updatedAt" = NOW()
        WHERE id = $1
        RETURNING
            id,
            name,
            language,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isDeleted" as is_deleted,
            "scheduledTime" as scheduled_time,
            duration,
            "isEnded" as is_ended,
            "endedAt" as ended_at,
            "createdAt" as created_at,
            "updatedAt" as updated_at,
            (SELECT username FROM "User" WHERE id = "ownerId") as owner_username,
            (SELECT color FROM "User" WHERE id = "ownerId") as owner_color
        "#,
    )
    .bind(&room_id)
    .bind(name)
    .bind(language)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update room"))?;

    Ok(Json(json!({ "room": room_to_json_owner(&updated) })))
}

pub async fn delete_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if room.owner_id != auth_user.id && !has_global_delete(&auth_user) {
        return Err(ApiError::forbidden("Not authorized to delete this room"));
    }

    sqlx::query(r#"DELETE FROM "Room" WHERE id = $1"#)
        .bind(&room_id)
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to delete room"))?;

    Ok(Json(json!({ "message": "Room deleted" })))
}

pub async fn join_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if room_id.is_empty() {
        return Err(ApiError::bad_request("Room ID is required"));
    }

    let room = sqlx::query_as::<_, RoomEndedRow>(
        r#"
        SELECT "isEnded" as is_ended
        FROM "Room"
        WHERE id = $1
        "#
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if room.is_ended {
        return Err(ApiError::forbidden("Cannot join an ended room"));
    }

    let existing = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT 1
        FROM "RoomParticipant"
        WHERE "roomId" = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(&room_id)
    .bind(&auth_user.id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check participant"))?;

    if existing.is_some() {
        return Err(ApiError::bad_request("Already a participant"));
    }

    sqlx::query(
        r#"
        INSERT INTO "RoomParticipant" (id, "roomId", "userId")
        VALUES ($1, $2, $3)
        "#
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&room_id)
    .bind(&auth_user.id)
    .execute(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to join room"))?;

    Ok(Json(json!({ "message": "Joined room successfully" })))
}

pub async fn leave_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let owner_room = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT 1
        FROM "Room"
        WHERE id = $1 AND "ownerId" = $2
        LIMIT 1
        "#,
    )
    .bind(&room_id)
    .bind(&auth_user.id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room owner"))?;

    if owner_room.is_some() {
        return Err(ApiError::bad_request("Owner cannot leave room"));
    }

    sqlx::query(
        r#"
        DELETE FROM "RoomParticipant"
        WHERE "roomId" = $1 AND "userId" = $2
        "#
    )
    .bind(&room_id)
    .bind(&auth_user.id)
    .execute(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to leave room"))?;

    Ok(Json(json!({ "message": "Left room successfully" })))
}

pub async fn end_room(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if room_id.is_empty() {
        return Err(ApiError::bad_request("Room ID is required"));
    }

    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if room.owner_id != auth_user.id && !has_global_delete(&auth_user) {
        return Err(ApiError::forbidden("Not authorized to end this room"));
    }

    let updated = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        UPDATE "Room"
        SET "isEnded" = true,
            "endedAt" = $2,
            "updatedAt" = NOW()
        WHERE id = $1
        RETURNING
            id,
            name,
            language,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isDeleted" as is_deleted,
            "scheduledTime" as scheduled_time,
            duration,
            "isEnded" as is_ended,
            "endedAt" as ended_at,
            "createdAt" as created_at,
            "updatedAt" as updated_at,
            (SELECT username FROM "User" WHERE id = "ownerId") as owner_username,
            (SELECT color FROM "User" WHERE id = "ownerId") as owner_color
        "#,
    )
    .bind(&room_id)
    .bind(Utc::now().naive_utc())
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to end room"))?;

    if let Some(ended_at) = updated.ended_at {
        ws::broadcast_room_ended(&state, &room_id, ended_at).await;
    }

    Ok(Json(json!({ "room": room_to_json_basic(&updated) })))
}

async fn fetch_participants(
    state: &AppState,
    room_id: &str,
) -> Result<Vec<RoomParticipantWithUserRow>, ApiError> {
    sqlx::query_as::<_, RoomParticipantWithUserRow>(
        r#"
        SELECT
            rp.id,
            rp."roomId" as room_id,
            u.id as user_id,
            rp."canEdit" as can_edit,
            rp."joinedAt" as joined_at,
            u.username as user_username,
            u.color as user_color
        FROM "RoomParticipant" rp
        JOIN "User" u ON u.id = rp."userId"
        WHERE rp."roomId" = $1
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load participants"))
}

fn room_to_json_basic(room: &RoomWithOwnerRow) -> serde_json::Value {
    json!({
        "id": room.id,
        "name": room.name,
        "language": room.language,
        "ownerId": room.owner_id,
        "allowEdit": room.allow_edit,
        "isDeleted": room.is_deleted,
        "scheduledTime": to_iso_string_opt(room.scheduled_time),
        "duration": room.duration,
        "isEnded": room.is_ended,
        "endedAt": to_iso_string_opt(room.ended_at),
        "createdAt": to_iso_string(room.created_at),
        "updatedAt": to_iso_string(room.updated_at),
    })
}

fn room_to_json_owner(room: &RoomWithOwnerRow) -> serde_json::Value {
    let mut value = room_to_json_basic(room);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "owner".to_string(),
            json!({
                "id": room.owner_id,
                "username": room.owner_username,
                "color": room.owner_color,
            }),
        );
    }
    value
}

fn room_to_json(room: &RoomWithOwnerRow, participants: Vec<RoomParticipantWithUserRow>) -> serde_json::Value {
    let mut value = room_to_json_owner(room);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "participants".to_string(),
            json!(participants
                .into_iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "roomId": p.room_id,
                        "userId": p.user_id,
                        "canEdit": p.can_edit,
                        "joinedAt": to_iso_string(p.joined_at),
                        "user": {
                            "id": p.user_id,
                            "username": p.user_username,
                            "color": p.user_color,
                        }
                    })
                })
                .collect::<Vec<_>>()),
        );
    }
    value
}

fn room_to_json_with_flags(
    room: &RoomWithOwnerRow,
    participants: Vec<RoomParticipantWithUserRow>,
    is_member: bool,
    is_owner: bool,
    can_edit: bool,
    is_expired: bool,
) -> serde_json::Value {
    let mut value = room_to_json(room, participants);
    if let Some(obj) = value.as_object_mut() {
        obj.insert("isMember".to_string(), json!(is_member));
        obj.insert("isOwner".to_string(), json!(is_owner));
        obj.insert("canEdit".to_string(), json!(can_edit));
        obj.insert("isExpired".to_string(), json!(is_expired));
    }
    value
}

fn parse_scheduled_time(value: &str) -> Result<NaiveDateTime, ApiError> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.naive_utc());
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        return Ok(local_to_utc(parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M") {
        return Ok(local_to_utc(parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Ok(local_to_utc(parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M") {
        return Ok(local_to_utc(parsed));
    }

    Err(ApiError::internal("Internal server error"))
}

fn local_to_utc(value: NaiveDateTime) -> NaiveDateTime {
    match Local.from_local_datetime(&value) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc).naive_utc(),
        LocalResult::Ambiguous(dt, _) => dt.with_timezone(&Utc).naive_utc(),
        LocalResult::None => value,
    }
}
