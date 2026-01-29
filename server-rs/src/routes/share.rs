use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use rand::TryRngCore;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::{build_guest_claims, verify_token, AuthUser, TokenPayload},
    db::db_error,
    error::ApiError,
    models::{GuestSessionWithRoomRow, ShareLinkSummaryRow, ShareLinkWithRoomRow},
    state::AppState,
    utils::colors::random_user_color,
    utils::time::{to_iso_string, to_iso_string_opt},
};

#[derive(Debug, sqlx::FromRow)]
struct RoomOwnerRow {
    id: String,
    owner_id: String,
    is_deleted: bool,
    is_ended: bool,
    allow_edit: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct RoomOwnerOnlyRow {
    id: String,
    owner_id: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ShareLinkOwnerRow {
    room_id: String,
    owner_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateShareLinkPayload {
    #[serde(rename = "canEdit")]
    pub can_edit: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct JoinSharePayload {
    pub username: Option<String>,
    pub email: Option<String>,
}

pub async fn create_share_link(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
    Json(payload): Json<CreateShareLinkPayload>,
) -> Result<impl IntoResponse, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT id, "ownerId" as owner_id, "isDeleted" as is_deleted,
               "isEnded" as is_ended, "allowEdit" as allow_edit
        FROM "Room"
        WHERE id = $1
        "#
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) if !room.is_deleted => room,
        _ => return Err(ApiError::not_found("Room not found")),
    };

    if room.owner_id != auth_user.id {
        return Err(ApiError::not_found("Room not found"));
    }

    if room.is_ended {
        return Err(ApiError::bad_request(
            "Cannot create share links for ended rooms",
        ));
    }

    let token = random_token_hex(24);
    let can_edit = payload.can_edit.unwrap_or(false) && room.allow_edit;

    let share_link = sqlx::query_as::<_, ShareLinkSummaryRow>(
        r#"
        INSERT INTO "RoomShareLink" (id, "roomId", token, "canEdit", "createdBy")
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            token,
            "canEdit" as can_edit,
            "createdAt" as created_at,
            "roomId" as room_id,
            0::bigint as guest_count
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&room.id)
    .bind(&token)
    .bind(can_edit)
    .bind(&auth_user.id)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create share link"))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "shareLink": format_share_link(&state, &share_link)
        })),
    ))
}

pub async fn list_share_links(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerOnlyRow>(
        r#"
        SELECT id, "ownerId" as owner_id
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

    if room.owner_id != auth_user.id {
        return Err(ApiError::not_found("Room not found"));
    }

    let share_links = sqlx::query_as::<_, ShareLinkSummaryRow>(
        r#"
        SELECT
            l.id,
            l.token,
            l."canEdit" as can_edit,
            l."createdAt" as created_at,
            l."roomId" as room_id,
            COUNT(g.id) as guest_count
        FROM "RoomShareLink" l
        LEFT JOIN "GuestSession" g ON g."shareLinkId" = l.id
        WHERE l."roomId" = $1
        GROUP BY l.id
        ORDER BY l."createdAt" DESC
        "#,
    )
    .bind(room.id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load share links"))?;

    Ok(Json(json!({
        "shareLinks": share_links.into_iter().map(|link| format_share_link(&state, &link)).collect::<Vec<_>>()
    })))
}

pub async fn delete_share_link(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((room_id, share_link_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let share_link = sqlx::query_as::<_, ShareLinkOwnerRow>(
        r#"
        SELECT l."roomId" as room_id, r."ownerId" as owner_id
        FROM "RoomShareLink" l
        JOIN "Room" r ON r.id = l."roomId"
        WHERE l.id = $1
        "#
    )
    .bind(&share_link_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load share link"))?;

    let share_link = match share_link {
        Some(link) if link.room_id == room_id => link,
        _ => return Err(ApiError::not_found("Share link not found")),
    };

    if share_link.owner_id != auth_user.id {
        return Err(ApiError::not_found("Share link not found"));
    }

    sqlx::query(r#"DELETE FROM "RoomShareLink" WHERE id = $1"#)
        .bind(&share_link_id)
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to delete share link"))?;

    Ok(Json(json!({ "message": "Share link deleted" })))
}

pub async fn get_share_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let share_link = sqlx::query_as::<_, ShareLinkWithRoomRow>(
        r#"
        SELECT
            l.id,
            l.token,
            l."canEdit" as can_edit,
            l."createdAt" as created_at,
            r.id as room_id,
            r.name as room_name,
            r.language as room_language,
            r."allowEdit" as room_allow_edit,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as room_is_ended,
            r."endedAt" as room_ended_at
        FROM "RoomShareLink" l
        JOIN "Room" r ON r.id = l."roomId"
        WHERE l.token = $1
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load share info"))?;

    let share_link = match share_link {
        Some(link) if !link.room_is_deleted => link,
        _ => return Err(ApiError::not_found("Share link not found")),
    };

    let effective_can_edit = share_link.can_edit && share_link.room_allow_edit && !share_link.room_is_ended;

    Ok(Json(json!({
        "share": {
            "token": share_link.token,
            "canEdit": share_link.can_edit,
            "effectiveCanEdit": effective_can_edit,
            "createdAt": to_iso_string(share_link.created_at),
            "shareUrl": build_share_url(&state, &share_link.token, &share_link.room_id),
        },
        "room": {
            "id": share_link.room_id,
            "name": share_link.room_name,
            "language": share_link.room_language,
            "isEnded": share_link.room_is_ended,
            "endedAt": to_iso_string_opt(share_link.room_ended_at),
        }
    })))
}

pub async fn join_share_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(payload): Json<JoinSharePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let username = payload.username.unwrap_or_default().trim().to_string();
    let email = payload
        .email
        .unwrap_or_default()
        .trim()
        .to_string();

    let normalized_email = if email.is_empty() { None } else { Some(email) };

    if username.is_empty() {
        return Err(ApiError::bad_request("Username is required"));
    }

    let share_link = sqlx::query_as::<_, ShareLinkWithRoomRow>(
        r#"
        SELECT
            l.id,
            l.token,
            l."canEdit" as can_edit,
            l."createdAt" as created_at,
            r.id as room_id,
            r.name as room_name,
            r.language as room_language,
            r."allowEdit" as room_allow_edit,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as room_is_ended,
            r."endedAt" as room_ended_at
        FROM "RoomShareLink" l
        JOIN "Room" r ON r.id = l."roomId"
        WHERE l.token = $1
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load share link"))?;

    let share_link = match share_link {
        Some(link) if !link.room_is_deleted => link,
        _ => return Err(ApiError::not_found("Share link not found")),
    };

    if share_link.room_is_ended {
        return Err(ApiError::bad_request("This room has already ended"));
    }

    let session_token = random_token_hex(24);
    let guest_color = random_user_color();
    let can_edit = share_link.can_edit && share_link.room_allow_edit;

    let guest_id = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "GuestSession" (id, "shareLinkId", "roomId", token, "displayName", email, color, "canEdit")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&share_link.id)
    .bind(&share_link.room_id)
    .bind(&session_token)
    .bind(&username)
    .bind(&normalized_email)
    .bind(&guest_color)
    .bind(can_edit)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create guest session"))?;

    let claims = build_guest_claims(
        guest_id.clone(),
        share_link.room_id.clone(),
        share_link.id.clone(),
        username.clone(),
        normalized_email.clone(),
        guest_color.clone(),
        can_edit,
        session_token.clone(),
        chrono::Utc::now(),
    );

    let jwt_token = crate::auth::generate_guest_token(&state.config, claims)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "token": jwt_token,
            "guest": {
                "id": guest_id,
                "displayName": username,
                "email": normalized_email,
                "color": guest_color,
                "canEdit": can_edit,
            },
            "room": {
                "id": share_link.room_id,
                "name": share_link.room_name,
                "language": share_link.room_language,
                "documentId": share_link.room_id,
                "allowEdit": share_link.room_allow_edit,
                "isEnded": share_link.room_is_ended,
                "endedAt": to_iso_string_opt(share_link.room_ended_at),
            }
        })),
    ))
}

pub async fn get_guest_session(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("No token provided"))?
        .to_string();

    let payload = match verify_token(&state.config, &token) {
        Ok(payload) => payload,
        Err(_) => return Err(ApiError::internal("Internal server error")),
    };
    let guest_payload = match payload {
        TokenPayload::Guest(payload) => payload,
        _ => return Err(ApiError::unauthorized("Invalid token")),
    };

    let guest = sqlx::query_as::<_, GuestSessionWithRoomRow>(
        r#"
        SELECT
            g.id,
            g."shareLinkId" as share_link_id,
            g."roomId" as room_id,
            g.token,
            g."displayName" as display_name,
            g.email,
            g.color,
            g."canEdit" as can_edit,
            g."createdAt" as created_at,
            g."lastActive" as last_active,
            r.name as room_name,
            r.language as room_language,
            r."allowEdit" as room_allow_edit,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as room_is_ended,
            r."endedAt" as room_ended_at,
            l.token as share_token,
            l."canEdit" as share_can_edit
        FROM "GuestSession" g
        JOIN "Room" r ON r.id = g."roomId"
        JOIN "RoomShareLink" l ON l.id = g."shareLinkId"
        WHERE g.id = $1
        "#,
    )
    .bind(&guest_payload.guest_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load guest session"))?;

    let guest = match guest {
        Some(guest) => guest,
        None => return Err(ApiError::not_found("Session not found")),
    };

    if guest.token != guest_payload.session_token {
        return Err(ApiError::unauthorized("Session token mismatch"));
    }

    if guest.room_is_deleted {
        return Err(ApiError::gone("Room no longer available"));
    }

    let effective_can_edit = guest.can_edit && guest.room_allow_edit && !guest.room_is_ended;

    sqlx::query(
        r#"
        UPDATE "GuestSession"
        SET "lastActive" = $2, "canEdit" = $3
        WHERE id = $1
        "#
    )
    .bind(&guest.id)
    .bind(chrono::Utc::now().naive_utc())
    .bind(effective_can_edit)
    .execute(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update guest session"))?;

    Ok(Json(json!({
        "guest": {
            "id": guest.id,
            "displayName": guest.display_name,
            "email": guest.email,
            "color": guest.color,
            "canEdit": effective_can_edit,
        },
        "room": {
            "id": guest.room_id,
            "name": guest.room_name,
            "language": guest.room_language,
            "documentId": guest.room_id,
            "allowEdit": guest.room_allow_edit,
            "isEnded": guest.room_is_ended,
            "endedAt": to_iso_string_opt(guest.room_ended_at),
        },
        "share": {
            "id": guest.share_link_id,
            "token": guest.share_token,
            "canEdit": guest.share_can_edit,
        }
    })))
}

fn format_share_link(state: &AppState, link: &ShareLinkSummaryRow) -> serde_json::Value {
    json!({
        "id": link.id,
        "token": link.token,
        "canEdit": link.can_edit,
        "createdAt": to_iso_string(link.created_at),
        "guestCount": link.guest_count,
        "shareUrl": build_share_url(state, &link.token, &link.room_id),
    })
}

fn build_share_url(state: &AppState, token: &str, room_id: &str) -> Option<String> {
    let base = state
        .config
        .frontend_url
        .clone()
        .or_else(|| state.config.app_url.clone())?;
    let normalized = base.trim_end_matches('/');
    let path = if state.config.frontend_hash_router {
        format!("#/room/{room_id}?share={token}")
    } else {
        format!("room/{room_id}?share={token}")
    };
    Some(format!("{normalized}/{path}"))
}

fn random_token_hex(bytes: usize) -> String {
    let mut data = vec![0u8; bytes];
    let mut rng = rand::rngs::OsRng;
    rng.try_fill_bytes(&mut data).unwrap();
    hex::encode(data)
}
