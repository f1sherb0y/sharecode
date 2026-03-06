use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Duration, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::{AdminUser, AuthUser},
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
struct RoomJoinRow {
    owner_id: String,
    is_ended: bool,
    is_deleted: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateRoomPayload {
    pub name: Option<String>,
    pub language: Option<String>,
    pub company: Option<String>,
    pub position: Option<String>,
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
    pub company: Option<String>,
    pub position: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRoomPinPayload {
    pub is_pinned: bool,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum RoomActivenessFilter {
    All,
    Active,
    Ended,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRoomsQuery {
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub owner_id: Option<String>,
    pub activeness: Option<RoomActivenessFilter>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaginationMeta {
    page: u32,
    page_size: u32,
    total: u64,
    total_pages: u32,
    has_next: bool,
    has_prev: bool,
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
    let name = payload.name.unwrap_or_default().trim().to_string();
    let language = payload.language.unwrap_or_else(|| "javascript".to_string());
    let company = normalize_optional_text(payload.company);
    let position = normalize_optional_text(payload.position);

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
        INSERT INTO "Room" (id, name, language, company, position, "ownerId", "scheduledTime", duration, "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING
            id,
            name,
            language,
            company,
            position,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isPinned" as is_pinned,
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
    .bind(company)
    .bind(position)
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
        "#,
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
                "#,
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
    Query(query): Query<GetRoomsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100);
    let offset = ((page - 1) * page_size) as i64;
    let owner_id = query.owner_id.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let activeness = query.activeness.unwrap_or(RoomActivenessFilter::All);
    let activeness_value = match activeness {
        RoomActivenessFilter::All => "all",
        RoomActivenessFilter::Active => "active",
        RoomActivenessFilter::Ended => "ended",
    };

    let (total_count, rooms) = if has_global_read(&auth_user) {
        let total_count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)
            FROM "Room" r
            WHERE r."isDeleted" = false
              AND ($1::text IS NULL OR r."ownerId" = $1)
              AND (
                $2::text = 'all'
                OR ($2::text = 'active' AND r."isEnded" = false)
                OR ($2::text = 'ended' AND r."isEnded" = true)
              )
            "#,
        )
        .bind(owner_id.as_deref())
        .bind(activeness_value)
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count rooms"))?;

        let rooms = sqlx::query_as::<_, RoomWithOwnerRow>(
            r#"
            SELECT
                r.id,
                r.name,
                r.language,
                r.company,
                r.position,
                r."ownerId" as owner_id,
                r."allowEdit" as allow_edit,
                r."isPinned" as is_pinned,
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
              AND ($1::text IS NULL OR r."ownerId" = $1)
              AND (
                $2::text = 'all'
                OR ($2::text = 'active' AND r."isEnded" = false)
                OR ($2::text = 'ended' AND r."isEnded" = true)
              )
            ORDER BY r."isPinned" DESC, r."createdAt" DESC, r.id DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(owner_id.as_deref())
        .bind(activeness_value)
        .bind(page_size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms"))?;

        (total_count, rooms)
    } else {
        let total_count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)
            FROM "Room" r
            WHERE r."isDeleted" = false
              AND (
                r."ownerId" = $1
                OR (
                    r."isEnded" = false
                    AND EXISTS (
                        SELECT 1
                        FROM "RoomParticipant" rp
                        WHERE rp."roomId" = r.id
                          AND rp."userId" = $1
                    )
                )
              )
              AND ($2::text IS NULL OR r."ownerId" = $2)
              AND (
                $3::text = 'all'
                OR ($3::text = 'active' AND r."isEnded" = false)
                OR ($3::text = 'ended' AND r."isEnded" = true)
              )
            "#,
        )
        .bind(&auth_user.id)
        .bind(owner_id.as_deref())
        .bind(activeness_value)
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count rooms"))?;

        let rooms = sqlx::query_as::<_, RoomWithOwnerRow>(
            r#"
            SELECT
                r.id,
                r.name,
                r.language,
                r.company,
                r.position,
                r."ownerId" as owner_id,
                r."allowEdit" as allow_edit,
                r."isPinned" as is_pinned,
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
              AND (
                r."ownerId" = $1
                OR (
                    r."isEnded" = false
                    AND EXISTS (
                        SELECT 1
                        FROM "RoomParticipant" rp
                        WHERE rp."roomId" = r.id
                          AND rp."userId" = $1
                    )
                )
              )
              AND ($2::text IS NULL OR r."ownerId" = $2)
              AND (
                $3::text = 'all'
                OR ($3::text = 'active' AND r."isEnded" = false)
                OR ($3::text = 'ended' AND r."isEnded" = true)
              )
            ORDER BY r."isPinned" DESC, r."createdAt" DESC, r.id DESC
            LIMIT $4 OFFSET $5
            "#,
        )
        .bind(&auth_user.id)
        .bind(owner_id.as_deref())
        .bind(activeness_value)
        .bind(page_size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms"))?;

        (total_count, rooms)
    };

    let mut response = Vec::with_capacity(rooms.len());
    let now = Utc::now();

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
            .and_then(|scheduled| {
                room.duration
                    .map(|dur| scheduled + Duration::minutes(dur as i64))
            })
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

    let total = total_count.max(0) as u64;
    let total_pages = if total == 0 {
        0
    } else {
        ((total + page_size as u64 - 1) / page_size as u64) as u32
    };
    let pagination = PaginationMeta {
        page,
        page_size,
        total,
        total_pages,
        has_next: total_pages > 0 && page < total_pages,
        has_prev: page > 1 && total > 0,
    };

    Ok(Json(json!({
        "rooms": response,
        "pagination": pagination,
    })))
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
            r.company,
            r.position,
            r."ownerId" as owner_id,
            r."allowEdit" as allow_edit,
            r."isPinned" as is_pinned,
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
    let is_admin =
        auth_user.role == "admin" || auth_user.role == "superuser" || has_global_read(&auth_user);

    if !is_admin && !is_owner && !is_participant {
        return Err(ApiError::not_found("Room not found"));
    }

    if room.is_ended && !is_owner && !is_admin {
        return Err(ApiError::not_found("Room not found"));
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
            r.company,
            r.position,
            r."ownerId" as owner_id,
            r."allowEdit" as allow_edit,
            r."isPinned" as is_pinned,
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
    let is_superuser = auth_user.role == "superuser";
    let is_participant = participants.iter().any(|p| p.user_id == auth_user.id);
    let is_privileged = auth_user.role == "admin" || is_superuser || has_global_read(&auth_user);

    if !is_owner && !is_participant && !is_privileged {
        return Err(ApiError::not_found("Room not found"));
    }

    let participant = participants.iter().find(|p| p.user_id == auth_user.id);
    let can_edit = has_global_write(&auth_user)
        || is_owner
        || participant.map(|p| p.can_edit).unwrap_or(false);

    if !can_edit {
        return Err(ApiError::not_found("Room not found"));
    }

    let rename_requested = payload.name.is_some();
    if rename_requested && !is_owner && !is_superuser {
        return Err(ApiError::not_found("Room not found"));
    }

    let name = payload
        .name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let language = payload
        .language
        .filter(|value| !value.is_empty())
        .filter(|value| SUPPORTED_LANGUAGES.contains(&value.as_str()));
    let company = normalize_optional_text(payload.company);
    let position = normalize_optional_text(payload.position);

    let updated = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        UPDATE "Room"
        SET name = COALESCE($2, name),
            language = COALESCE($3, language),
            company = COALESCE($4, company),
            position = COALESCE($5, position),
            "updatedAt" = NOW()
        WHERE id = $1
        RETURNING
            id,
            name,
            language,
            company,
            position,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isPinned" as is_pinned,
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
    .bind(company)
    .bind(position)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update room"))?;

    Ok(Json(json!({ "room": room_to_json_owner(&updated) })))
}

pub async fn set_room_pin(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Path(room_id): Path<String>,
    Json(payload): Json<SetRoomPinPayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if room_id.is_empty() {
        return Err(ApiError::bad_request("Room ID is required"));
    }

    let room = sqlx::query_as::<_, RoomWithOwnerRow>(
        r#"
        UPDATE "Room"
        SET "isPinned" = $2,
            "updatedAt" = NOW()
        WHERE id = $1
          AND "isDeleted" = false
        RETURNING
            id,
            name,
            language,
            company,
            position,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isPinned" as is_pinned,
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
    .bind(payload.is_pinned)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update room pin status"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    let participants = fetch_participants(&state, &room.id).await?;
    let user_participant = participants.iter().find(|p| p.user_id == auth_user.id);
    let is_owner = room.owner_id == auth_user.id;
    let is_member = is_owner || user_participant.is_some();
    let can_edit = is_owner
        || has_global_write(&auth_user)
        || user_participant.map(|p| p.can_edit).unwrap_or(false);

    let now = Utc::now();
    let is_expired = room
        .scheduled_time
        .and_then(|scheduled| {
            room.duration
                .map(|dur| scheduled + Duration::minutes(dur as i64))
        })
        .map(|end_time| end_time < now)
        .unwrap_or(false);

    Ok(Json(json!({
        "room": room_to_json_with_flags(
            &room,
            participants,
            is_member,
            is_owner,
            can_edit,
            is_expired,
        ),
    })))
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

    if room.owner_id != auth_user.id && !has_global_delete(&auth_user) {
        return Err(ApiError::not_found("Room not found"));
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

    let room = sqlx::query_as::<_, RoomJoinRow>(
        r#"
        SELECT "ownerId" as owner_id, "isEnded" as is_ended, "isDeleted" as is_deleted
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) if !room.is_deleted => room,
        _ => return Err(ApiError::not_found("Room not found")),
    };

    if room.is_ended {
        return Err(ApiError::not_found("Room not found"));
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

    let is_owner = room.owner_id == auth_user.id;

    if !is_owner && existing.is_none() {
        return Err(ApiError::not_found("Room not found"));
    }

    if existing.is_some() {
        return Err(ApiError::bad_request("Already a participant"));
    }

    sqlx::query(
        r#"
        INSERT INTO "RoomParticipant" (id, "roomId", "userId")
        VALUES ($1, $2, $3)
        "#,
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

    let membership = sqlx::query_scalar::<_, i64>(
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
    .map_err(|err| db_error(err, "Failed to check room membership"))?;

    if membership.is_none() {
        return Err(ApiError::not_found("Room not found"));
    }

    sqlx::query(
        r#"
        DELETE FROM "RoomParticipant"
        WHERE "roomId" = $1 AND "userId" = $2
        "#,
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

    if room.owner_id != auth_user.id && !has_global_delete(&auth_user) {
        return Err(ApiError::not_found("Room not found"));
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
            company,
            position,
            "ownerId" as owner_id,
            "allowEdit" as allow_edit,
            "isPinned" as is_pinned,
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
    .bind(Utc::now())
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
        "company": room.company,
        "position": room.position,
        "ownerId": room.owner_id,
        "allowEdit": room.allow_edit,
        "isPinned": room.is_pinned,
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

fn room_to_json(
    room: &RoomWithOwnerRow,
    participants: Vec<RoomParticipantWithUserRow>,
) -> serde_json::Value {
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

fn parse_scheduled_time(value: &str) -> Result<DateTime<Utc>, ApiError> {
    // Prefer timezone-aware input (e.g. "2026-03-07T14:30:00+08:00")
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }

    // Also accept "YYYY-MM-DDTHH:MM:SS+HH:MM" variants that chrono::DateTime can parse
    if let Ok(parsed) = chrono::DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%:z") {
        return Ok(parsed.with_timezone(&Utc));
    }

    // Fallback: treat naive datetimes as UTC
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        return Ok(Utc.from_utc_datetime(&parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M") {
        return Ok(Utc.from_utc_datetime(&parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Ok(Utc.from_utc_datetime(&parsed));
    }

    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M") {
        return Ok(Utc.from_utc_datetime(&parsed));
    }

    Err(ApiError::internal("Internal server error"))
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}
