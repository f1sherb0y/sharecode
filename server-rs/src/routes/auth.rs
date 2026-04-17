use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use bcrypt::hash;
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::{build_user_claims, generate_user_token, verify_token, TokenPayload},
    db::db_error,
    error::ApiError,
    models::{UserPublicRow, UserRow},
    state::AppState,
    utils::colors::random_user_color,
    utils::time::{to_iso_string, to_iso_string_opt},
};

#[derive(Debug, Deserialize)]
pub struct RegisterPayload {
    pub username: Option<String>,
    pub password: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginPayload {
    pub username: Option<String>,
    pub password: Option<String>,
}

pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterPayload>,
) -> Result<impl IntoResponse, ApiError> {
    if !state.config.allow_registration {
        return Err(ApiError::not_found("Not found"));
    }

    let username = payload.username.unwrap_or_default();
    let password = payload.password.unwrap_or_default();
    let email = payload.email;

    if username.is_empty() || password.is_empty() {
        return Err(ApiError::bad_request("Username and password are required"));
    }

    let existing_user =
        sqlx::query_scalar::<_, i64>(r#"SELECT 1 FROM "User" WHERE username = $1 LIMIT 1"#)
            .bind(&username)
            .fetch_optional(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to check existing username"))?;

    if existing_user.is_some() {
        return Err(ApiError::bad_request("Username already taken"));
    }

    if let Some(ref email_value) = email {
        let existing_email =
            sqlx::query_scalar::<_, i64>(r#"SELECT 1 FROM "User" WHERE email = $1 LIMIT 1"#)
                .bind(email_value)
                .fetch_optional(&state.db)
                .await
                .map_err(|err| db_error(err, "Failed to check existing email"))?;

        if existing_email.is_some() {
            return Err(ApiError::bad_request("Email already in use"));
        }
    }

    let hashed_password = hash(password, 12)
        .map_err(|err| ApiError::internal(format!("Failed to hash password: {err}")))?;
    let color = random_user_color();

    let user = sqlx::query_as::<_, UserRow>(
        r#"
        INSERT INTO "User" (id, email, username, password, color)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            email,
            username,
            password,
            color,
            role,
            "canReadAllRooms" as can_read_all_rooms,
            "canWriteAllRooms" as can_write_all_rooms,
            "canDeleteAllRooms" as can_delete_all_rooms,
            "isDeleted" as is_deleted,
            "createdAt" as created_at,
            "lastSeen" as last_seen
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(email)
    .bind(&username)
    .bind(&hashed_password)
    .bind(&color)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create user"))?;

    let claims = build_user_claims(&user, Utc::now());
    let token = generate_user_token(&state.config, claims)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "user": {
                "id": user.id,
                "email": user.email,
                "username": user.username,
                "color": user.color,
                "role": user.role,
                "canReadAllRooms": user.can_read_all_rooms,
                "canWriteAllRooms": user.can_write_all_rooms,
                "canDeleteAllRooms": user.can_delete_all_rooms,
            },
            "token": token,
        })),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let username = payload.username.unwrap_or_default();
    let password = payload.password.unwrap_or_default();

    if username.is_empty() || password.is_empty() {
        return Err(ApiError::bad_request("Username and password are required"));
    }

    let user = sqlx::query_as::<_, UserRow>(
        r#"
        SELECT
            id,
            email,
            username,
            password,
            color,
            role,
            "canReadAllRooms" as can_read_all_rooms,
            "canWriteAllRooms" as can_write_all_rooms,
            "canDeleteAllRooms" as can_delete_all_rooms,
            "isDeleted" as is_deleted,
            "createdAt" as created_at,
            "lastSeen" as last_seen
        FROM "User"
        WHERE username = $1
        "#,
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load user"))?;

    let user = match user {
        Some(user) => user,
        None => return Err(ApiError::unauthorized("Invalid credentials")),
    };

    if user.is_deleted {
        return Err(ApiError::unauthorized("Invalid credentials"));
    }

    let valid_password = bcrypt::verify(password, &user.password)
        .map_err(|err| ApiError::internal(format!("Failed to verify password: {err}")))?;

    if !valid_password {
        return Err(ApiError::unauthorized("Invalid credentials"));
    }

    let claims = build_user_claims(&user, Utc::now());
    let token = generate_user_token(&state.config, claims)?;

    Ok(Json(json!({
        "user": {
            "id": user.id,
            "email": user.email,
            "username": user.username,
            "color": user.color,
            "role": user.role,
            "canReadAllRooms": user.can_read_all_rooms,
            "canWriteAllRooms": user.can_write_all_rooms,
            "canDeleteAllRooms": user.can_delete_all_rooms,
        },
        "token": token,
    })))
}

pub async fn get_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("No token provided"))?
        .to_string();

    let payload = verify_token(&state.config, &token)?;

    match payload {
        TokenPayload::User(user_payload) => {
            let user = sqlx::query_as::<_, UserPublicRow>(
                r#"
                SELECT
                    id,
                    email,
                    username,
                    color,
                    role,
                    "canReadAllRooms" as can_read_all_rooms,
                    "canWriteAllRooms" as can_write_all_rooms,
                    "canDeleteAllRooms" as can_delete_all_rooms,
                    "createdAt" as created_at,
                    "lastSeen" as last_seen
                FROM "User"
                WHERE id = $1
                "#,
            )
            .bind(&user_payload.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to load profile"))?;

            let user = match user {
                Some(user) => user,
                None => return Err(ApiError::not_found("User not found")),
            };

            Ok(Json(json!({
                "actorType": "user",
                "user": {
                    "id": user.id,
                    "email": user.email,
                    "username": user.username,
                    "color": user.color,
                    "role": user.role,
                    "canReadAllRooms": user.can_read_all_rooms,
                    "canWriteAllRooms": user.can_write_all_rooms,
                    "canDeleteAllRooms": user.can_delete_all_rooms,
                    "createdAt": to_iso_string(user.created_at),
                }
            })))
        }
        TokenPayload::Guest(guest_payload) => {
            let guest = sqlx::query_as::<_, GuestProfileRow>(
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
            .map_err(|err| db_error(err, "Failed to load guest profile"))?;

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

            let effective_can_edit =
                guest.can_edit && guest.room_allow_edit && guest.share_can_edit && !guest.room_is_ended;

            sqlx::query(
                r#"
                UPDATE "GuestSession"
                SET "lastActive" = $2, "canEdit" = $3
                WHERE id = $1
                "#,
            )
            .bind(&guest.id)
            .bind(chrono::Utc::now())
            .bind(effective_can_edit)
            .execute(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to update guest session"))?;

            Ok(Json(json!({
                "actorType": "guest",
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
    }
}

pub async fn get_registration_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(json!({
        "allowRegistration": state.config.allow_registration,
    })))
}

#[derive(sqlx::FromRow)]
struct GuestProfileRow {
    id: String,
    share_link_id: String,
    room_id: String,
    token: String,
    display_name: String,
    email: Option<String>,
    color: String,
    can_edit: bool,
    room_name: String,
    room_language: String,
    room_allow_edit: bool,
    room_is_deleted: bool,
    room_is_ended: bool,
    room_ended_at: Option<chrono::DateTime<chrono::Utc>>,
    share_token: String,
    share_can_edit: bool,
}
