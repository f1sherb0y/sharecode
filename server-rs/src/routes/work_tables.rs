use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use bcrypt::hash;
use rand::TryRngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::appointments::{create_appointment, delete_appointment, table_link_sessions, update_appointment};
use super::customers::clean_text;
use crate::{
    auth::{AuthUser, StaffUser},
    core::audit::{self, ClientInfo},
    db::{db_error, user_creation_error},
    error::ApiError,
    permissions::is_staff,
    state::AppState,
    utils::colors::random_user_color,
};

// Work tables (工作表): one per tech, holding their sessions and busy time.
// Staff see every tech's table (and anyone else holding sessions still to
// come); a tech sees only their own. A tech pins a short note above it, such
// as when they cannot take sessions.
//
// Staff can give any table a link: whoever opens it sees that table without
// signing in, writes its note and marks busy time, nothing else. A table for
// someone without an account belongs to a placeholder tech ("linkOnly") that
// nobody can sign in as, merged into their real account once they have one.
const MAX_NOTE_CHARS: usize = 200;
/// Links are short to share yet too many to guess: 62^10 is about 2^59.
const LINK_CHARS: usize = 10;
const PASSWORD_CHARS: usize = 32;

#[derive(sqlx::FromRow)]
struct TableRow {
    id: String,
    username: String,
    color: String,
    role: String,
    note: Option<String>,
    link_only: bool,
    token: Option<String>,
    upcoming: i64,
}

pub async fn list_work_tables(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let staff = is_staff(&auth_user.role);
    let rows = sqlx::query_as::<_, TableRow>(
        r#"SELECT u.id, u.username, u.color, u.role, u."scheduleNote" as note,
            u."linkOnly" as link_only, u."tableToken" as token,
            (SELECT count(*) FROM "Appointment" a
             WHERE a."techId" = u.id AND NOT a."isBlock"
               AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW()) as upcoming
        FROM "User" u
        WHERE NOT u."isDeleted"
          AND ($1 OR u.id = $2)
          AND (u.role = 'tech' OR u.id = $2 OR EXISTS (
            SELECT 1 FROM "Appointment" a WHERE a."techId" = u.id AND NOT a."isBlock"
              AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW()))
        ORDER BY lower(u.username), u.id"#,
    )
    .bind(staff)
    .bind(&auth_user.id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load work tables"))?;
    // Sessions still waiting for a tech, which staff may still have to place.
    let unassigned: i64 = if staff {
        sqlx::query_scalar(
            r#"SELECT count(*) FROM "Appointment"
            WHERE "techId" IS NULL AND "startsAt" + "durationMinutes" * INTERVAL '1 minute' > NOW()"#,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load work tables"))?
    } else {
        0
    };
    let tables = rows
        .iter()
        .filter(|row| row.role == "tech" || row.upcoming > 0 || (!staff && row.id == auth_user.id))
        .map(|row| {
            json!({
                "id": row.id, "username": row.username, "color": row.color, "role": row.role,
                "note": row.note, "upcoming": row.upcoming, "linkOnly": row.link_only,
                // The link opens the table without signing in: staff hand it out.
                "link": if staff { row.token.clone() } else { None },
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "tables": tables, "unassigned": unassigned })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NotePayload {
    note: Option<String>,
}

/// The note pinned above the caller's own table; an empty one removes it.
pub async fn update_work_table_note(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(payload): Json<NotePayload>,
) -> Result<Json<Value>, ApiError> {
    save_note(&state, &auth_user.id, payload.note).await
}

async fn save_note(state: &AppState, user_id: &str, note: Option<String>) -> Result<Json<Value>, ApiError> {
    let note = clean_text(note, MAX_NOTE_CHARS, "The note is too long")?;
    sqlx::query(r#"UPDATE "User" SET "scheduleNote" = $2 WHERE id = $1"#)
        .bind(user_id)
        .bind(&note)
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to save the note"))?;
    Ok(Json(json!({ "note": note })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NewTablePayload {
    name: Option<String>,
}

/// A table for a tech without an account: a placeholder tech and its link.
pub async fn create_work_table(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Json(payload): Json<NewTablePayload>,
) -> Result<Response, ApiError> {
    // A table's name is its placeholder's username.
    let name = crate::utils::usernames::normalize_username(payload.name.as_deref().unwrap_or_default())
        .map_err(ApiError::bad_request)?;
    if crate::db::username_holder(&state.db, &name, None).await?.is_some() {
        return Err(ApiError::bad_request("Username already taken"));
    }
    // A password nobody knows: the placeholder is reached through its link only.
    let password = hash(random_token(PASSWORD_CHARS), 10)
        .map_err(|err| ApiError::internal(format!("Failed to hash password: {err}")))?;
    let id = Uuid::new_v4().to_string();
    let token = random_token(LINK_CHARS);
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query(
        r#"INSERT INTO "User" (id, username, password, color, role, "linkOnly", "tableToken")
        VALUES ($1, $2, $3, $4, 'tech', true, $5)"#,
    )
    .bind(&id)
    .bind(&name)
    .bind(password)
    .bind(random_user_color())
    .bind(&token)
    .execute(&mut *tx)
    .await
    .map_err(user_creation_error)?;
    audit::record_details(
        &mut *tx, &client, "work_table.created", Some(&auth_user.id), Some(&auth_user.username),
        Some(&id), true, None, None, json!({ "linkOnly": true }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok((StatusCode::CREATED, Json(json!({ "table": { "id": id, "username": name, "link": token } }))).into_response())
}

/// Gives a table a new link; the old one stops working.
pub async fn reset_work_table_link(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let token = random_token(LINK_CHARS);
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let updated = sqlx::query(r#"UPDATE "User" SET "tableToken" = $2 WHERE id = $1 AND NOT "isDeleted""#)
        .bind(&user_id)
        .bind(&token)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to save the link"))?
        .rows_affected();
    if updated == 0 {
        return Err(ApiError::not_found("Work table not found"));
    }
    audit::record_details(
        &mut *tx, &client, "work_table.link_reset", Some(&auth_user.id), Some(&auth_user.username),
        Some(&user_id), true, None, None, json!({}),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "link": token })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MergePayload {
    into: Option<String>,
}

/// Moves a placeholder's table into a real account: its sessions, busy time,
/// rooms, note and link. The placeholder is removed.
pub async fn merge_work_table(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(source): Path<String>,
    Json(payload): Json<MergePayload>,
) -> Result<Json<Value>, ApiError> {
    let target = payload.into.filter(|id| !id.is_empty()).ok_or_else(|| ApiError::bad_request("Choose an account"))?;
    if target == source {
        return Err(ApiError::bad_request("Choose another account"));
    }
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let placeholder: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT "scheduleNote", "tableToken" FROM "User" WHERE id = $1 AND "linkOnly" AND NOT "isDeleted" FOR UPDATE"#,
    )
    .bind(&source)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load the work table"))?;
    let (note, token) = placeholder.ok_or_else(|| ApiError::not_found("Work table not found"))?;
    let account: Option<String> = sqlx::query_scalar(
        r#"SELECT id FROM "User" WHERE id = $1 AND NOT "linkOnly" AND NOT "isDeleted" FOR UPDATE"#,
    )
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load the account"))?;
    if account.is_none() {
        return Err(ApiError::bad_request("Choose an account"));
    }
    for key in [&source, &target] {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("schedule:{key}"))
            .execute(&mut *tx)
            .await
            .map_err(|err| db_error(err, "Failed to lock the schedule"))?;
    }
    let moved = sqlx::query(r#"UPDATE "Appointment" SET "techId" = $2, "updatedAt" = NOW() WHERE "techId" = $1"#)
        .bind(&source)
        .bind(&target)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to move sessions"))?
        .rows_affected();
    sqlx::query(r#"UPDATE "Room" SET "ownerId" = $2, "updatedAt" = NOW() WHERE "ownerId" = $1"#)
        .bind(&source)
        .bind(&target)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to move rooms"))?;
    // The placeholder goes; its link and note carry over unless the account has its own.
    sqlx::query(
        r#"UPDATE "User" SET "isDeleted" = true, "tableToken" = NULL, "tokenVersion" = "tokenVersion" + 1 WHERE id = $1"#,
    )
    .bind(&source)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to remove the work table"))?;
    sqlx::query(
        r#"UPDATE "User" SET "scheduleNote" = COALESCE("scheduleNote", $2), "tableToken" = COALESCE("tableToken", $3) WHERE id = $1"#,
    )
    .bind(&target)
    .bind(&note)
    .bind(&token)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to merge the work table"))?;
    audit::record_details(
        &mut *tx, &client, "work_table.merged", Some(&auth_user.id), Some(&auth_user.username),
        Some(&source), true, None, None, json!({ "into": target, "sessions": moved }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "merged": moved })))
}

#[derive(sqlx::FromRow)]
struct LinkedTech {
    id: String,
    username: String,
    color: String,
    note: Option<String>,
    token_version: i64,
}

/// The tech whose table a link opens.
async fn linked_tech(state: &AppState, token: &str) -> Result<LinkedTech, ApiError> {
    sqlx::query_as::<_, LinkedTech>(
        r#"SELECT id, username, color, "scheduleNote" as note, "tokenVersion" as token_version
        FROM "User" WHERE "tableToken" = $1 AND NOT "isDeleted""#,
    )
    .bind(token)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load the work table"))?
    .ok_or_else(|| ApiError::not_found("Work table not found"))
}

/// Acting through a link is acting as the table's tech, who may only touch
/// their own busy time and note.
fn as_tech(tech: &LinkedTech) -> AuthUser {
    AuthUser {
        session_id: None,
        id: tech.id.clone(),
        token_version: tech.token_version,
        username: tech.username.clone(),
        email: None,
        role: "tech".to_string(),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
}

pub async fn open_table_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(range): Query<RangeQuery>,
) -> Result<Json<Value>, ApiError> {
    let tech = linked_tech(&state, &token).await?;
    let appointments = table_link_sessions(&state.db, &tech.id, range.from.as_deref(), range.to.as_deref()).await?;
    Ok(Json(json!({
        "table": { "id": tech.id, "username": tech.username, "color": tech.color, "note": tech.note },
        "appointments": appointments,
    })))
}

pub async fn update_table_link_note(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(payload): Json<NotePayload>,
) -> Result<Json<Value>, ApiError> {
    let tech = linked_tech(&state, &token).await?;
    save_note(&state, &tech.id, payload.note).await
}

/// Busy time through a link: always a block on the linked tech's table.
fn as_block(mut payload: Value) -> Result<super::appointments::AppointmentPayload, ApiError> {
    if let Some(fields) = payload.as_object_mut() {
        fields.insert("isBlock".to_string(), json!(true));
        fields.remove("techId");
        fields.remove("customerId");
    }
    serde_json::from_value(payload).map_err(|_| ApiError::bad_request("Invalid busy time"))
}

pub async fn create_table_link_busy(
    State(state): State<AppState>,
    client: ClientInfo,
    Path(token): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Response, ApiError> {
    let tech = linked_tech(&state, &token).await?;
    create_appointment(State(state), client, as_tech(&tech), Json(as_block(payload)?)).await
}

pub async fn update_table_link_busy(
    State(state): State<AppState>,
    client: ClientInfo,
    Path((token, appointment_id)): Path<(String, String)>,
    Json(payload): Json<Value>,
) -> Result<Response, ApiError> {
    let tech = linked_tech(&state, &token).await?;
    update_appointment(State(state), client, as_tech(&tech), Path(appointment_id), Json(as_block(payload)?)).await
}

pub async fn delete_table_link_busy(
    State(state): State<AppState>,
    client: ClientInfo,
    Path((token, appointment_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let tech = linked_tech(&state, &token).await?;
    delete_appointment(State(state), client, as_tech(&tech), Path(appointment_id)).await
}

fn random_token(len: usize) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    // Bytes past the last whole multiple of 62 are dropped so every character is as likely.
    let limit = (256 / CHARSET.len() * CHARSET.len()) as u8;
    let mut token = String::with_capacity(len);
    let mut bytes = [0u8; 32];
    while token.len() < len {
        rand::rngs::OsRng.try_fill_bytes(&mut bytes).unwrap();
        for &byte in bytes.iter().filter(|&&byte| byte < limit) {
            if token.len() == len {
                break;
            }
            token.push(CHARSET[byte as usize % CHARSET.len()] as char);
        }
    }
    token
}
