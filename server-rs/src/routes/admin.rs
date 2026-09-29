use axum::{
    extract::Path, extract::Query, extract::State, http::StatusCode, response::IntoResponse, Json,
};
use bcrypt::hash;
use chrono::{DateTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::QueryBuilder;
use uuid::Uuid;
use yrs::merge_updates_v1;

use crate::core::audit::{self, ClientInfo};

use crate::{
    auth::AdminUser,
    db::db_error,
    error::ApiError,
    models::{RoomAdminRow, UserPublicRow, UserRow},
    permissions::{
        can_manage_room_lifecycle, has_global_read, require_room_access, RoomLifecycleAction,
        ROOM_PLAYBACK_SQL, ROOM_VISIBILITY_SQL, SHARE_READ_ONLY_SQL,
    },
    state::AppState,
    utils::colors::random_user_color,
    utils::passwords::validate_password,
    utils::time::{to_iso_string, to_iso_string_opt},
};

const VALID_ROLES: [&str; 3] = ["user", "admin", "superuser"];

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminListQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    q: Option<String>,
    role: Option<String>,
    status: Option<String>,
    language: Option<String>,
    owner: Option<String>,
}

impl AdminListQuery {
    fn pagination(&self, total: i64) -> (i64, i64, Value) {
        let size = self.page_size.unwrap_or(25).clamp(1, 100) as i64;
        let pages = (total + size - 1) / size;
        let page = (self.page.unwrap_or(1).max(1) as i64).min(pages.max(1));
        (
            size,
            (page - 1) * size,
            json!({
                "page": page, "pageSize": size, "total": total, "totalPages": pages,
                "hasNext": page < pages, "hasPrev": page > 1,
            }),
        )
    }
}

fn search_pattern(value: Option<&str>) -> String {
    // Treat search text literally, including PostgreSQL LIKE metacharacters.
    format!(
        "%{}%",
        value
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect::<String>()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSizesQuery {
    room_ids: Option<String>,
}

#[derive(sqlx::FromRow)]
struct DbSizeRow {
    bytes: i64,
    pretty: String,
}

#[derive(sqlx::FromRow)]
struct PlaybackSizeRow {
    id: String,
    name: String,
    is_ended: bool,
    ended_at: Option<DateTime<Utc>>,
    update_count: i64,
    bytes: i64,
}

#[derive(sqlx::FromRow)]
struct PlaybackUpdateRow {
    update: Vec<u8>,
    timestamp: DateTime<Utc>,
    user_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct RoomOwnerRow {
    owner_id: String,
}

struct CompressedBucket {
    timestamp: DateTime<Utc>,
    update: Vec<u8>,
    user_id: Option<String>,
}

#[derive(Clone, Copy)]
struct PermissionFlags {
    can_read_all_rooms: bool,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
}

fn normalize_boolean(value: Option<&Value>) -> Option<bool> {
    let value = value?;
    if let Some(bool_value) = value.as_bool() {
        return Some(bool_value);
    }
    if let Some(text) = value.as_str() {
        let normalized = text.trim().to_lowercase();
        if normalized == "true" {
            return Some(true);
        }
        if normalized == "false" {
            return Some(false);
        }
        return Some(!text.is_empty());
    }
    if value.is_null() {
        return None;
    }
    if let Some(num) = value.as_i64() {
        return Some(num != 0);
    }
    if let Some(num) = value.as_u64() {
        return Some(num != 0);
    }
    if let Some(num) = value.as_f64() {
        return Some(num != 0.0 && !num.is_nan());
    }
    Some(true)
}

fn extract_permission_input(body: &Value) -> PermissionFlagsUpdate {
    let source = if let Some(obj) = body.get("permissions").and_then(|value| value.as_object()) {
        obj
    } else if let Some(obj) = body.as_object() {
        obj
    } else {
        return PermissionFlagsUpdate::default();
    };

    PermissionFlagsUpdate {
        can_read_all_rooms: normalize_boolean(source.get("canReadAllRooms")),
        can_write_all_rooms: normalize_boolean(source.get("canWriteAllRooms")),
        can_delete_all_rooms: normalize_boolean(source.get("canDeleteAllRooms")),
    }
}

#[derive(Default)]
struct PermissionFlagsUpdate {
    can_read_all_rooms: Option<bool>,
    can_write_all_rooms: Option<bool>,
    can_delete_all_rooms: Option<bool>,
}

fn merge_permissions(current: PermissionFlags, updates: PermissionFlagsUpdate) -> PermissionFlags {
    PermissionFlags {
        can_read_all_rooms: updates
            .can_read_all_rooms
            .unwrap_or(current.can_read_all_rooms),
        can_write_all_rooms: updates
            .can_write_all_rooms
            .unwrap_or(current.can_write_all_rooms),
        can_delete_all_rooms: updates
            .can_delete_all_rooms
            .unwrap_or(current.can_delete_all_rooms),
    }
}

fn apply_permission_hierarchy(perms: PermissionFlags) -> PermissionFlags {
    let mut result = perms;
    if result.can_delete_all_rooms {
        result.can_write_all_rooms = true;
        result.can_read_all_rooms = true;
    } else if result.can_write_all_rooms {
        result.can_read_all_rooms = true;
    }
    result
}

fn normalize_permissions_for_role(role: &str, permissions: PermissionFlags) -> PermissionFlags {
    if role == "superuser" {
        return PermissionFlags {
            can_read_all_rooms: true,
            can_write_all_rooms: true,
            can_delete_all_rooms: true,
        };
    }

    apply_permission_hierarchy(permissions)
}

fn default_permissions_for_role(role: &str, requested: PermissionFlagsUpdate) -> PermissionFlags {
    let base = if role == "admin" {
        PermissionFlags {
            can_read_all_rooms: true,
            can_write_all_rooms: true,
            can_delete_all_rooms: false,
        }
    } else {
        PermissionFlags {
            can_read_all_rooms: false,
            can_write_all_rooms: false,
            can_delete_all_rooms: false,
        }
    };

    let merged = merge_permissions(base, requested);
    normalize_permissions_for_role(role, merged)
}

fn validate_delegation(
    actor: &crate::auth::AuthUser,
    permissions: PermissionFlags,
) -> Result<(), ApiError> {
    if actor.role != "superuser"
        && ((permissions.can_read_all_rooms && !crate::permissions::has_global_read(actor))
            || (permissions.can_write_all_rooms && !crate::permissions::has_global_write(actor))
            || (permissions.can_delete_all_rooms && !crate::permissions::has_global_delete(actor)))
    {
        return Err(ApiError::not_found("Not found"));
    }
    Ok(())
}

fn has_permission_changes(update: &PermissionFlagsUpdate) -> bool {
    update.can_read_all_rooms.is_some()
        || update.can_write_all_rooms.is_some()
        || update.can_delete_all_rooms.is_some()
}

pub async fn create_user(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(auth_user): AdminUser,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    let username = payload
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let password = payload
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let email = payload
        .get("email")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let requested_role = payload
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user");

    if username.is_empty() || password.is_empty() {
        return Err(ApiError::bad_request("Username and password are required"));
    }

    validate_password(password).map_err(ApiError::bad_request)?;

    if !VALID_ROLES.contains(&requested_role) {
        return Err(ApiError::bad_request("Invalid role"));
    }

    if auth_user.role == "admin" && requested_role != "user" {
        return Err(ApiError::not_found("Not found"));
    }

    if auth_user.role != "superuser" && requested_role == "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    if auth_user.role != "superuser" && requested_role == "admin" {
        return Err(ApiError::not_found("Not found"));
    }

    let existing_user = sqlx::query_scalar::<_, bool>(
        r#"SELECT "isDeleted" FROM "User" WHERE username = $1 LIMIT 1"#,
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check username"))?;

    if let Some(deleted) = existing_user {
        return Err(ApiError::bad_request(if deleted {
            "This username belongs to a deleted account and is still reserved. Restore that account or choose another username."
        } else {
            "Username already taken"
        }));
    }

    if let Some(ref email_value) = email {
        let existing_email = sqlx::query_scalar::<_, bool>(
            r#"SELECT "isDeleted" FROM "User" WHERE email = $1 LIMIT 1"#,
        )
        .bind(email_value)
        .fetch_optional(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to check email"))?;

        if let Some(deleted) = existing_email {
            return Err(ApiError::bad_request(if deleted {
                "This email belongs to a deleted account and is still reserved. Restore that account or use another email."
            } else {
                "Email already in use"
            }));
        }
    }

    let hashed_password = hash(password, 12)
        .map_err(|err| ApiError::internal(format!("Failed to hash password: {err}")))?;

    let requested_permissions = extract_permission_input(&payload);
    let permissions = default_permissions_for_role(requested_role, requested_permissions);
    validate_delegation(&auth_user, permissions)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let user = sqlx::query_as::<_, UserPublicRow>(
        r#"
        INSERT INTO "User" (id, email, username, password, color, role,
                            "canReadAllRooms", "canWriteAllRooms", "canDeleteAllRooms")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
            id,
            email,
            username,
            color,
            role,
            "canReadAllRooms" as can_read_all_rooms,
            "canWriteAllRooms" as can_write_all_rooms,
            "canDeleteAllRooms" as can_delete_all_rooms,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(email)
    .bind(username)
    .bind(hashed_password)
    .bind(random_user_color())
    .bind(requested_role)
    .bind(permissions.can_read_all_rooms)
    .bind(permissions.can_write_all_rooms)
    .bind(permissions.can_delete_all_rooms)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| crate::db::user_creation_error(err))?;

    audit::record_details(&mut *tx, &client, "user.created", Some(&auth_user.id), Some(&auth_user.username), Some(&user.id), true, None, None, json!({"role":user.role,"canReadAllRooms":user.can_read_all_rooms,"canWriteAllRooms":user.can_write_all_rooms,"canDeleteAllRooms":user.can_delete_all_rooms})).await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    tracing::info!(
        actor_id = %auth_user.id,
        actor_role = %auth_user.role,
        user_id = %user.id,
        username = %user.username,
        role = %user.role,
        can_read_all_rooms = user.can_read_all_rooms,
        can_write_all_rooms = user.can_write_all_rooms,
        can_delete_all_rooms = user.can_delete_all_rooms,
        "user created"
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({ "user": user_to_json(&user) })),
    ))
}

pub async fn get_all_users(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<AdminListQuery>,
) -> Result<Json<Value>, ApiError> {
    let pattern = search_pattern(query.q.as_deref());
    let role = query.role.as_deref().filter(|value| *value != "all");
    if role.is_some_and(|value| !VALID_ROLES.contains(&value)) {
        return Err(ApiError::bad_request("Invalid role"));
    }
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM "User"
        WHERE "isDeleted" = false AND (username ILIKE $1 OR COALESCE(email, '') ILIKE $1)
        AND ($2::text IS NULL OR role = $2)"#,
    )
    .bind(&pattern)
    .bind(role)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to count users"))?;
    let (limit, offset, pagination) = query.pagination(total);
    let users = sqlx::query_as::<_, UserPublicRow>(
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
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE "isDeleted" = false
        AND (username ILIKE $1 OR COALESCE(email, '') ILIKE $1)
        AND ($2::text IS NULL OR role = $2)
        ORDER BY "createdAt" DESC, id DESC LIMIT $3 OFFSET $4
        "#,
    )
    .bind(&pattern)
    .bind(role)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load users"))?;

    Ok(Json(json!({
        "pagination": pagination,
        "users": users.into_iter().map(|u| user_to_json(&u)).collect::<Vec<_>>()
    })))
}

pub async fn update_user(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    client: ClientInfo,
    Path(user_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _access = state.ws.access.write().await;
    let requested_role = payload.get("role").and_then(|v| v.as_str());
    let permission_updates = extract_permission_input(&payload);
    let has_permission_changes = has_permission_changes(&permission_updates);

    let target_user = sqlx::query_as::<_, UserRow>(
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
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE id = $1
        "#,
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load user"))?;

    let target_user = match target_user {
        Some(user) if !user.is_deleted => user,
        _ => return Err(ApiError::not_found("User not found")),
    };

    if target_user.id == auth_user.id
        && requested_role.is_some()
        && requested_role != Some("superuser")
    {
        return Err(ApiError::not_found("Not found"));
    }

    if auth_user.role == "admin" && target_user.role != "user" {
        return Err(ApiError::not_found("Not found"));
    }

    if let Some(role) = requested_role {
        if !VALID_ROLES.contains(&role) {
            return Err(ApiError::bad_request("Invalid role"));
        }

        if auth_user.role != "superuser" {
            return Err(ApiError::not_found("Not found"));
        }
    }

    if requested_role == Some("superuser") && auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    if has_permission_changes && auth_user.role != "superuser" && target_user.role != "user" {
        return Err(ApiError::not_found("Not found"));
    }

    if target_user.role == "superuser"
        && requested_role.is_some()
        && requested_role != Some("superuser")
    {
        let superuser_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "User" WHERE role = 'superuser' AND "isDeleted" = false"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count superusers"))?;

        if superuser_count <= 1 {
            return Err(ApiError::not_found("Not found"));
        }
    }

    let current_permissions = PermissionFlags {
        can_read_all_rooms: target_user.can_read_all_rooms,
        can_write_all_rooms: target_user.can_write_all_rooms,
        can_delete_all_rooms: target_user.can_delete_all_rooms,
    };

    let mut permissions = current_permissions;
    if has_permission_changes {
        permissions = merge_permissions(current_permissions, permission_updates);
    }

    let final_role = requested_role.unwrap_or(&target_user.role);
    permissions = normalize_permissions_for_role(final_role, permissions);
    validate_delegation(&auth_user, permissions)?;

    let affected_private_rooms = if final_role != target_user.role {
        sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "Room" WHERE "ownerId" = $1 AND "isPrivate" AND NOT "isDeleted""#,
        )
        .bind(&user_id)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms affected by role change"))?
    } else {
        Vec::new()
    };

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start user update"))?;
    let updated = sqlx::query_as::<_, UserPublicRow>(
        r#"
        UPDATE "User"
        SET role = $2,
            "canReadAllRooms" = $3,
            "canWriteAllRooms" = $4,
            "canDeleteAllRooms" = $5
        WHERE id = $1
        RETURNING
            id,
            email,
            username,
            color,
            role,
            "canReadAllRooms" as can_read_all_rooms,
            "canWriteAllRooms" as can_write_all_rooms,
            "canDeleteAllRooms" as can_delete_all_rooms,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        "#,
    )
    .bind(&user_id)
    .bind(final_role)
    .bind(permissions.can_read_all_rooms)
    .bind(permissions.can_write_all_rooms)
    .bind(permissions.can_delete_all_rooms)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to update user"))?;

    audit::record_details(&mut *tx, &client, "user.permissions_changed", Some(&auth_user.id), Some(&auth_user.username), Some(&user_id), true, None, None, json!({"before":{"role":target_user.role,"canReadAllRooms":target_user.can_read_all_rooms,"canWriteAllRooms":target_user.can_write_all_rooms,"canDeleteAllRooms":target_user.can_delete_all_rooms},"after":{"role":updated.role,"canReadAllRooms":updated.can_read_all_rooms,"canWriteAllRooms":updated.can_write_all_rooms,"canDeleteAllRooms":updated.can_delete_all_rooms}})).await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit user update"))?;
    state.ws.revoke_actor(&user_id).await;

    for room_id in affected_private_rooms {
        state.ws.revoke_inaccessible_room(&state.db, &room_id).await;
    }

    Ok(Json(json!({ "user": user_to_json(&updated) })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    client: ClientInfo,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let _access = state.ws.access.write().await;
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
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE id = $1
        "#,
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load user"))?;

    let user = match user {
        Some(user) if !user.is_deleted => user,
        _ => return Err(ApiError::not_found("User not found")),
    };

    if user.id == auth_user.id {
        return Err(ApiError::not_found("Not found"));
    }

    if auth_user.role == "admin" && user.role != "user" {
        return Err(ApiError::not_found("Not found"));
    }

    if user.role == "superuser" {
        if auth_user.role != "superuser" {
            return Err(ApiError::not_found("Not found"));
        }

        let superuser_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "User" WHERE role = 'superuser' AND "isDeleted" = false"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count superusers"))?;

        if superuser_count <= 1 {
            return Err(ApiError::not_found("Not found"));
        }
    }

    if user.role == "admin" && auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start user update"))?;
    sqlx::query(
        r#"
        UPDATE "User"
        SET "isDeleted" = true, "tokenVersion" = "tokenVersion" + 1
        WHERE id = $1
        "#,
    )
    .bind(&user_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to delete user"))?;

    tracing::info!(
        actor_id = %auth_user.id,
        actor_role = %auth_user.role,
        user_id = %user.id,
        username = %user.username,
        target_role = %user.role,
        deletion_mode = "soft",
        "user deleted"
    );

    audit::record(
        &mut *tx,
        &client,
        "user.deleted",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&user_id),
        true,
        None,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit user update"))?;
    state.ws.revoke_actor(&user_id).await;

    Ok(Json(json!({ "message": "User deleted successfully" })))
}

pub async fn get_all_rooms(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Query(query): Query<AdminListQuery>,
) -> Result<Json<Value>, ApiError> {
    let pattern = search_pattern(query.q.as_deref());
    let owner = search_pattern(query.owner.as_deref());
    let language = query.language.as_deref().filter(|value| *value != "all");
    let ended = match query.status.as_deref() {
        None | Some("all") => None,
        Some("active") => Some(false),
        Some("ended") => Some(true),
        _ => return Err(ApiError::bad_request("Invalid room status")),
    };
    let filter = format!(
        r#"FROM "Room" r JOIN "User" o ON o.id = r."ownerId"
        WHERE {ROOM_VISIBILITY_SQL} AND r.name ILIKE $4 AND o.username ILIKE $5
        AND ($6::text IS NULL OR r.language = $6) AND ($7::boolean IS NULL OR r."isEnded" = $7)"#
    );
    let count_sql = format!("SELECT COUNT(*) {filter}");
    let total = sqlx::query_scalar::<_, i64>(&count_sql)
        .bind(&auth_user.id)
        .bind(&auth_user.role)
        .bind(has_global_read(&auth_user))
        .bind(&pattern)
        .bind(&owner)
        .bind(language)
        .bind(ended)
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count rooms"))?;
    let (limit, offset, pagination) = query.pagination(total);
    let sql = format!(
        r#"SELECT r.id, r.name, r.language, r.company, r.position,
        r."ownerId" as owner_id, r."isPrivate" as is_private, r."allowEdit" as allow_edit,
        r."isPinned" as is_pinned, r."isDeleted" as is_deleted,
        r."scheduledTime" as scheduled_time, r.duration, r."isEnded" as is_ended,
        r."endedAt" as ended_at, r."createdAt" as created_at, r."updatedAt" as updated_at,
        o.username as owner_username, o.email as owner_email,
        {ROOM_PLAYBACK_SQL} as can_view_playback, {SHARE_READ_ONLY_SQL} as share_read_only
        {filter} ORDER BY r."createdAt" DESC, r.id DESC LIMIT $8 OFFSET $9"#
    );
    let rooms = sqlx::query_as::<_, RoomAdminRow>(&sql)
        .bind(&auth_user.id)
        .bind(&auth_user.role)
        .bind(has_global_read(&auth_user))
        .bind(&pattern)
        .bind(&owner)
        .bind(language)
        .bind(ended)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load rooms"))?;

    let mut response = Vec::with_capacity(rooms.len());
    for room in rooms {
        response.push(json!({
            "id": room.id,
            "name": room.name,
            "language": room.language,
            "company": room.company,
            "position": room.position,
            "ownerId": room.owner_id,
            "allowEdit": room.allow_edit,
            "isPrivate": room.is_private,
            "canViewPlayback": room.can_view_playback,
            "shareReadOnly": room.share_read_only,
            "isPinned": room.is_pinned,
            "isDeleted": room.is_deleted,
            "scheduledTime": crate::utils::time::to_iso_string_opt(room.scheduled_time),
            "duration": room.duration,
            "isEnded": room.is_ended,
            "endedAt": crate::utils::time::to_iso_string_opt(room.ended_at),
            "createdAt": to_iso_string(room.created_at),
            "updatedAt": to_iso_string(room.updated_at),
            "owner": {
                "id": room.owner_id,
                "username": room.owner_username,
                "email": room.owner_email,
            },
        }));
    }

    Ok(Json(json!({ "rooms": response, "pagination": pagination })))
}

pub async fn get_db_storage_size(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
) -> Result<Json<Value>, ApiError> {
    if auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    let size = sqlx::query_as::<_, DbSizeRow>(
        r#"
        SELECT
            pg_database_size(current_database())::bigint as bytes,
            pg_size_pretty(pg_database_size(current_database())) as pretty
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load database size"))?;

    Ok(Json(json!({
        "bytes": size.bytes,
        "pretty": size.pretty,
    })))
}

pub async fn get_room_playback_sizes(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Query(query): Query<PlaybackSizesQuery>,
) -> Result<Json<Value>, ApiError> {
    if auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    let ids: Vec<String> = query
        .room_ids
        .unwrap_or_default()
        .split(',')
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if ids.len() > 100 || ids.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err(ApiError::bad_request("Provide at most 100 valid room IDs"));
    }
    if ids.is_empty() {
        return Ok(Json(json!({"rooms": []})));
    }
    let sql = format!(
        r#"
        SELECT
            r.id,
            r.name,
            r."isEnded" as is_ended,
            r."endedAt" as ended_at,
            COUNT(du.id) as update_count,
            COALESCE(SUM(octet_length(du.update)), 0) as bytes
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        LEFT JOIN "DocumentUpdate" du ON du."documentId" = r.id
        WHERE {ROOM_VISIBILITY_SQL} AND r.id = ANY($4)
        GROUP BY r.id, r.name, r."isEnded", r."endedAt"
        ORDER BY bytes DESC
        "#
    );
    let rows = sqlx::query_as::<_, PlaybackSizeRow>(&sql)
        .bind(&auth_user.id)
        .bind(&auth_user.role)
        .bind(has_global_read(&auth_user))
        .bind(&ids)
        .fetch_all(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load playback storage sizes"))?;

    let response = rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "name": row.name,
                "isEnded": row.is_ended,
                "endedAt": to_iso_string_opt(row.ended_at),
                "updateCount": row.update_count,
                "bytes": row.bytes,
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({ "rooms": response })))
}

pub async fn compress_room_playback(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(auth_user): AdminUser,
    Path(room_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_room_access(&state.db, &auth_user, &room_id).await?;
    if auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

    let room = sqlx::query_as::<_, RoomStatusRow>(
        r#"
        SELECT "isEnded" as is_ended, "isDeleted" as is_deleted
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

    if room.is_deleted {
        return Err(ApiError::not_found("Room not found"));
    }

    if !room.is_ended {
        return Err(ApiError::bad_request("Room has not ended yet"));
    }

    state.ws.wait_for_saved(&room_id).await?;
    let updates = sqlx::query_as::<_, PlaybackUpdateRow>(
        r#"
        SELECT update, timestamp, "userId" as user_id
        FROM "DocumentUpdate"
        WHERE "documentId" = $1
        ORDER BY timestamp ASC, seq ASC
        "#,
    )
    .bind(&room_id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load playback updates"))?;

    let original_count = updates.len() as i64;
    let original_bytes = updates.iter().map(|u| u.update.len() as i64).sum::<i64>();

    if updates.is_empty() {
        return Ok(Json(json!({
            "roomId": room_id,
            "originalUpdates": original_count,
            "compressedUpdates": 0,
            "originalBytes": original_bytes,
            "compressedBytes": 0,
            "savedBytes": 0,
        })));
    }

    let mut buckets: Vec<CompressedBucket> = Vec::new();
    let mut pending: Vec<PlaybackUpdateRow> = Vec::new();
    let mut current_bucket: Option<DateTime<Utc>> = None;

    for row in updates {
        let bucket_time = row.timestamp.with_nanosecond(0).unwrap_or(row.timestamp);
        if current_bucket.is_none() {
            current_bucket = Some(bucket_time);
        }
        if Some(bucket_time) != current_bucket {
            let bucket_time = current_bucket.unwrap();
            let merged = merge_bucket_updates(&pending)?;
            let user_id = merge_bucket_user_id(&pending);
            buckets.push(CompressedBucket {
                timestamp: bucket_time,
                update: merged,
                user_id,
            });
            pending.clear();
            current_bucket = Some(bucket_time);
        }
        pending.push(row);
    }

    if !pending.is_empty() {
        let bucket_time = current_bucket.unwrap_or_else(|| pending[0].timestamp);
        let merged = merge_bucket_updates(&pending)?;
        let user_id = merge_bucket_user_id(&pending);
        buckets.push(CompressedBucket {
            timestamp: bucket_time,
            update: merged,
            user_id,
        });
    }

    let compressed_count = buckets.len() as i64;
    let compressed_bytes = buckets.iter().map(|b| b.update.len() as i64).sum::<i64>();

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|err| db_error(err, "Failed to start compression transaction"))?;

    sqlx::query(r#"DELETE FROM "DocumentUpdate" WHERE "documentId" = $1"#)
        .bind(&room_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to clear playback updates"))?;

    if !buckets.is_empty() {
        let mut builder = QueryBuilder::new(
            r#"INSERT INTO "DocumentUpdate" (id, "documentId", update, "userId", timestamp) "#,
        );
        builder.push_values(&buckets, |mut row, bucket| {
            let id = Uuid::new_v4().to_string();
            row.push_bind(id)
                .push_bind(&room_id)
                .push_bind(&bucket.update)
                .push_bind(&bucket.user_id)
                .push_bind(bucket.timestamp);
        });
        builder
            .build()
            .execute(&mut *tx)
            .await
            .map_err(|err| db_error(err, "Failed to insert compressed updates"))?;
    }

    audit::record_details(&mut *tx, &client, "playback.compressed", Some(&auth_user.id), Some(&auth_user.username), Some(&room_id), true, None, Some(&room_id), json!({"originalUpdates":original_count,"compressedUpdates":compressed_count,"originalBytes":original_bytes,"compressedBytes":compressed_bytes})).await?;
    tx.commit()
        .await
        .map_err(|err| db_error(err, "Failed to commit compression transaction"))?;

    Ok(Json(json!({
        "roomId": room_id,
        "originalUpdates": original_count,
        "compressedUpdates": compressed_count,
        "originalBytes": original_bytes,
        "compressedBytes": compressed_bytes,
        "savedBytes": original_bytes - compressed_bytes,
    })))
}

pub async fn delete_room(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(auth_user): AdminUser,
    Path(room_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let _access = state.ws.access.write().await;
    require_room_access(&state.db, &auth_user, &room_id).await?;
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
          AND "isDeleted" = false
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

    if !can_manage_room_lifecycle(&auth_user, &room.owner_id, RoomLifecycleAction::Delete) {
        return Err(ApiError::not_found("Room not found"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query(
        r#"
        UPDATE "Room"
        SET "isDeleted" = true,
            "updatedAt" = NOW()
        WHERE id = $1
          AND "isDeleted" = false
        "#,
    )
    .bind(&room_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to delete room"))?;

    audit::record_details(
        &mut *tx,
        &client,
        "room.deleted",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&room_id),
        true,
        None,
        Some(&room_id),
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    tracing::info!(
        actor_id = %auth_user.id,
        actor_role = %auth_user.role,
        room_id = %room_id,
        owner_id = %room.owner_id,
        deletion_mode = "soft",
        route = "admin.delete_room",
        "room deleted"
    );

    state.ws.revoke_room(&room_id).await;

    Ok(Json(json!({ "message": "Room deleted successfully" })))
}

#[derive(sqlx::FromRow)]
struct RoomStatusRow {
    is_ended: bool,
    is_deleted: bool,
}

fn merge_bucket_updates(pending: &[PlaybackUpdateRow]) -> Result<Vec<u8>, ApiError> {
    if pending.len() == 1 {
        return Ok(pending[0].update.clone());
    }

    merge_updates_v1(pending.iter().map(|entry| entry.update.as_slice()))
        .map_err(|err| ApiError::internal(format!("Failed to merge updates: {err}")))
}

fn merge_bucket_user_id(pending: &[PlaybackUpdateRow]) -> Option<String> {
    let mut current: Option<&str> = None;
    for entry in pending {
        match (current, entry.user_id.as_deref()) {
            (None, None) => {}
            (None, Some(id)) => current = Some(id),
            (Some(existing), Some(id)) if existing == id => {}
            _ => return None,
        }
    }
    current.map(|id| id.to_string())
}

fn user_to_json(user: &UserPublicRow) -> Value {
    json!({
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "color": user.color,
        "role": user.role,
        "canReadAllRooms": user.can_read_all_rooms,
        "canWriteAllRooms": user.can_write_all_rooms,
        "canDeleteAllRooms": user.can_delete_all_rooms,
        "createdAt": to_iso_string(user.created_at),
        "lastSeen": to_iso_string(user.last_seen),
    })
}
