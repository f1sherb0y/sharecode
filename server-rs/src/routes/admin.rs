use axum::{
    extract::Path,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use bcrypt::hash;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::AdminUser,
    db::db_error,
    error::ApiError,
    models::{RoomAdminRow, RoomParticipantWithUserRow, UserPublicRow, UserRow},
    state::AppState,
    utils::colors::random_user_color,
    utils::time::to_iso_string,
};

const VALID_ROLES: [&str; 3] = ["user", "admin", "superuser"];

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
        can_read_all_rooms: updates.can_read_all_rooms.unwrap_or(current.can_read_all_rooms),
        can_write_all_rooms: updates.can_write_all_rooms.unwrap_or(current.can_write_all_rooms),
        can_delete_all_rooms: updates.can_delete_all_rooms.unwrap_or(current.can_delete_all_rooms),
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

    let mut normalized = apply_permission_hierarchy(permissions);
    if role == "admin" {
        normalized.can_read_all_rooms = true;
        normalized.can_write_all_rooms = true;
        normalized = apply_permission_hierarchy(normalized);
    }

    normalized
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

fn has_permission_changes(update: &PermissionFlagsUpdate) -> bool {
    update.can_read_all_rooms.is_some()
        || update.can_write_all_rooms.is_some()
        || update.can_delete_all_rooms.is_some()
}

pub async fn create_user(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = payload.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let email = payload.get("email").and_then(|v| v.as_str()).map(|v| v.to_string());
    let requested_role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("user");

    if username.is_empty() || password.is_empty() {
        return Err(ApiError::bad_request("Username and password are required"));
    }

    if !VALID_ROLES.contains(&requested_role) {
        return Err(ApiError::bad_request("Invalid role"));
    }

    if auth_user.role == "admin" && requested_role != "user" {
        return Err(ApiError::forbidden("Admins can only create normal users"));
    }

    if auth_user.role != "superuser" && requested_role == "superuser" {
        return Err(ApiError::forbidden("Only superusers can create other superusers"));
    }

    if auth_user.role != "superuser" && requested_role == "admin" {
        return Err(ApiError::forbidden("Only superusers can create admins"));
    }

    let existing_user = sqlx::query_scalar::<_, i64>(
        r#"SELECT 1 FROM "User" WHERE username = $1 LIMIT 1"#,
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check username"))?;

    if existing_user.is_some() {
        return Err(ApiError::bad_request("Username already taken"));
    }

    if let Some(ref email_value) = email {
        let existing_email = sqlx::query_scalar::<_, i64>(
            r#"SELECT 1 FROM "User" WHERE email = $1 LIMIT 1"#,
        )
        .bind(email_value)
        .fetch_optional(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to check email"))?;

        if existing_email.is_some() {
            return Err(ApiError::bad_request("Email already in use"));
        }
    }

    let hashed_password =
        hash(password, 10).map_err(|err| ApiError::internal(format!("Failed to hash password: {err}")))?;

    let requested_permissions = extract_permission_input(&payload);
    let permissions = default_permissions_for_role(requested_role, requested_permissions);

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
            "lastSeen" as last_seen
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
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create user"))?;

    Ok((StatusCode::CREATED, Json(json!({ "user": user_to_json(&user) }))))
}

pub async fn get_all_users(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
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
            "lastSeen" as last_seen
        FROM "User"
        WHERE "isDeleted" = false
        ORDER BY "createdAt" DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load users"))?;

    Ok(Json(json!({
        "users": users.into_iter().map(|u| user_to_json(&u)).collect::<Vec<_>>()
    })))
}

pub async fn update_user(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Path(user_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
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
            "lastSeen" as last_seen
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

    if target_user.id == auth_user.id && requested_role.is_some() && requested_role != Some("superuser") {
        return Err(ApiError::forbidden(
            "Cannot change your own role to a non-superuser role",
        ));
    }

    if auth_user.role == "admin" && target_user.role != "user" {
        return Err(ApiError::forbidden("Admins can manage normal users only"));
    }

    if let Some(role) = requested_role {
        if !VALID_ROLES.contains(&role) {
            return Err(ApiError::bad_request("Invalid role"));
        }

        if auth_user.role != "superuser" {
            return Err(ApiError::forbidden("Only superusers can change roles"));
        }
    }

    if requested_role == Some("superuser") && auth_user.role != "superuser" {
        return Err(ApiError::forbidden("Only superusers can promote to superuser"));
    }

    if has_permission_changes && auth_user.role != "superuser" && target_user.role != "user" {
        return Err(ApiError::forbidden(
            "Admins can only update permissions for normal users",
        ));
    }

    if target_user.role == "superuser" && requested_role.is_some() && requested_role != Some("superuser") {
        let superuser_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "User" WHERE role = 'superuser' AND "isDeleted" = false"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count superusers"))?;

        if superuser_count <= 1 {
            return Err(ApiError::forbidden("Cannot remove the last superuser"));
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
            "lastSeen" as last_seen
        "#,
    )
    .bind(&user_id)
    .bind(final_role)
    .bind(permissions.can_read_all_rooms)
    .bind(permissions.can_write_all_rooms)
    .bind(permissions.can_delete_all_rooms)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update user"))?;

    Ok(Json(json!({ "user": user_to_json(&updated) })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
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
        return Err(ApiError::forbidden("Cannot delete your own account"));
    }

    if auth_user.role == "admin" && user.role != "user" {
        return Err(ApiError::forbidden("Admins can only delete normal users"));
    }

    if user.role == "superuser" {
        if auth_user.role != "superuser" {
            return Err(ApiError::forbidden("Only superusers can delete another superuser"));
        }

        let superuser_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "User" WHERE role = 'superuser' AND "isDeleted" = false"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count superusers"))?;

        if superuser_count <= 1 {
            return Err(ApiError::forbidden("Cannot delete the last superuser"));
        }
    }

    if user.role == "admin" && auth_user.role != "superuser" {
        return Err(ApiError::forbidden("Only superusers can delete admins"));
    }

    if user.role == "admin" {
        let admin_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "User" WHERE role = 'admin' AND "isDeleted" = false"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to count admins"))?;

        if admin_count <= 1 {
            return Err(ApiError::forbidden("Cannot delete the last admin user"));
        }
    }

    sqlx::query(
        r#"
        UPDATE "User"
        SET "isDeleted" = true
        WHERE id = $1
        "#
    )
    .bind(&user_id)
    .execute(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to delete user"))?;

    Ok(Json(json!({ "message": "User deleted successfully" })))
}

pub async fn get_all_rooms(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let rooms = sqlx::query_as::<_, RoomAdminRow>(
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
            o.email as owner_email
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        WHERE r."isDeleted" = false
        ORDER BY r."createdAt" DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load rooms"))?;

    let mut response = Vec::with_capacity(rooms.len());
    for room in rooms {
        let participants = fetch_participants(&state, &room.id).await?;
        response.push(json!({
            "id": room.id,
            "name": room.name,
            "language": room.language,
            "ownerId": room.owner_id,
            "allowEdit": room.allow_edit,
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
            "participants": participants.into_iter().map(|p| {
                json!({
                    "id": p.id,
                    "roomId": p.room_id,
                    "userId": p.user_id,
                    "canEdit": p.can_edit,
                    "joinedAt": to_iso_string(p.joined_at),
                    "user": {
                        "id": p.user_id,
                        "username": p.user_username,
                    }
                })
            }).collect::<Vec<_>>(),
        }));
    }

    Ok(Json(json!({ "rooms": response })))
}

pub async fn delete_room(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Path(room_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !auth_user.can_delete_all_rooms && auth_user.role != "superuser" {
        return Err(ApiError::forbidden("Delete-all-rooms permission required"));
    }

    sqlx::query(
        r#"
        UPDATE "Room"
        SET "isDeleted" = true,
            "updatedAt" = NOW()
        WHERE id = $1
        "#
    )
    .bind(&room_id)
    .execute(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to delete room"))?;

    Ok(Json(json!({ "message": "Room deleted successfully" })))
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
