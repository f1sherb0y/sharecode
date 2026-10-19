use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use bcrypt::hash;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::work_tables::{merge_placeholder, random_token, LINK_CHARS, PASSWORD_CHARS};
use crate::{
    auth::StaffUser,
    core::audit::{self, ClientInfo},
    db::{db_error, user_creation_error, username_holder},
    error::ApiError,
    permissions::is_staff,
    state::AppState,
    utils::colors::random_user_color,
};

// The work tables' two lists: the techs whose tables are shown and the 管理 who
// book. Every name stands for an account; someone without one gets a placeholder
// ("linkOnly") nobody signs in as, later linked to their account by merging it.
// Staff keep both lists.
const MAX_NAME_CHARS: usize = 32;

#[derive(sqlx::FromRow)]
struct EntryRow {
    kind: String,
    user_id: String,
    name: String,
    username: String,
    color: String,
    role: String,
    link_only: bool,
}

fn entry_json(row: &EntryRow) -> Value {
    json!({
        "userId": row.user_id, "name": row.name, "username": row.username,
        "color": row.color, "role": row.role, "linkOnly": row.link_only,
    })
}

async fn load_entries(db: &sqlx::PgPool) -> Result<Vec<EntryRow>, ApiError> {
    sqlx::query_as::<_, EntryRow>(
        r#"SELECT e.kind, e."userId" as user_id, e.name, u.username, u.color, u.role, u."linkOnly" as link_only
        FROM "RosterEntry" e JOIN "User" u ON u.id = e."userId" AND NOT u."isDeleted"
        ORDER BY e.position, e."createdAt""#,
    )
    .fetch_all(db)
    .await
    .map_err(|err| db_error(err, "Failed to load the lists"))
}

pub async fn list_roster(State(state): State<AppState>, _staff: StaffUser) -> Result<Json<Value>, ApiError> {
    let rows = load_entries(&state.db).await?;
    let of = |kind: &str| rows.iter().filter(|row| row.kind == kind).map(entry_json).collect::<Vec<_>>();
    Ok(Json(json!({ "techs": of("tech"), "managers": of("manager") })))
}

fn check_kind(kind: &str) -> Result<(), ApiError> {
    match kind {
        "tech" | "manager" => Ok(()),
        _ => Err(ApiError::not_found("Not found")),
    }
}

fn clean_name(name: Option<&str>) -> Result<String, ApiError> {
    let name = name.unwrap_or_default().trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request("A name of up to 32 characters is required"));
    }
    Ok(name.to_string())
}

/// An account a list entry may stand for: active, real, and staff for the 管理 list.
async fn check_account(tx: &mut sqlx::PgConnection, kind: &str, account: &str) -> Result<(), ApiError> {
    let role: Option<String> = sqlx::query_scalar(
        r#"SELECT role FROM "User" WHERE id = $1 AND NOT "isDeleted" AND NOT "linkOnly""#,
    )
    .bind(account)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load the account"))?;
    match role {
        Some(role) if kind == "tech" || is_staff(&role) => Ok(()),
        _ => Err(ApiError::bad_request("Choose an account")),
    }
}

fn listed_error(err: sqlx::Error) -> ApiError {
    match &err {
        sqlx::Error::Database(database) if database.is_unique_violation() => ApiError::bad_request("Already on the list"),
        _ => db_error(err, "Failed to save the list"),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryPayload {
    kind: Option<String>,
    name: Option<String>,
    account_id: Option<String>,
}

/// Adds a name to a list: an account, or a placeholder made for it.
pub async fn add_roster_entry(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Json(payload): Json<EntryPayload>,
) -> Result<Response, ApiError> {
    let kind = payload.kind.unwrap_or_default();
    check_kind(&kind).map_err(|_| ApiError::bad_request("Invalid list"))?;
    let name = clean_name(payload.name.as_deref())?;
    let account = payload.account_id.filter(|id| !id.is_empty());
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    // One list change at a time keeps positions in order.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('roster', 0))")
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to lock the lists"))?;
    let user_id = match account {
        Some(account) => {
            check_account(&mut tx, &kind, &account).await?;
            account
        }
        None => {
            if username_holder(&mut *tx, &name, None).await?.is_some() {
                return Err(ApiError::bad_request("Username already taken"));
            }
            let id = Uuid::new_v4().to_string();
            let password = hash(random_token(PASSWORD_CHARS), 10)
                .map_err(|err| ApiError::internal(format!("Failed to hash password: {err}")))?;
            let token = (kind == "tech").then(|| random_token(LINK_CHARS));
            sqlx::query(
                r#"INSERT INTO "User" (id, username, password, color, role, "linkOnly", "tableToken")
                VALUES ($1, $2, $3, $4, $5, true, $6)"#,
            )
            .bind(&id)
            .bind(&name)
            .bind(password)
            .bind(random_user_color())
            .bind(if kind == "tech" { "tech" } else { "agent" })
            .bind(&token)
            .execute(&mut *tx)
            .await
            .map_err(user_creation_error)?;
            id
        }
    };
    sqlx::query(
        r#"INSERT INTO "RosterEntry" (kind, "userId", name, position)
        VALUES ($1, $2, $3, (SELECT COALESCE(max(position), 0) + 1 FROM "RosterEntry" WHERE kind = $1))"#,
    )
    .bind(&kind)
    .bind(&user_id)
    .bind(&name)
    .execute(&mut *tx)
    .await
    .map_err(listed_error)?;
    audit::record_details(
        &mut *tx, &client, "roster.added", Some(&auth_user.id), Some(&auth_user.username),
        Some(&user_id), true, None, None, json!({ "kind": kind }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    let row = load_entries(&state.db).await?.into_iter().find(|row| row.kind == kind && row.user_id == user_id);
    Ok((StatusCode::CREATED, Json(json!({ "entry": row.as_ref().map(entry_json) }))).into_response())
}

/// Renames an entry, or links it to an account: a placeholder's sessions move there.
pub async fn update_roster_entry(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path((kind, user_id)): Path<(String, String)>,
    Json(payload): Json<EntryPayload>,
) -> Result<Json<Value>, ApiError> {
    check_kind(&kind)?;
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('roster', 0))")
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to lock the lists"))?;
    let link_only: Option<bool> = sqlx::query_scalar(
        r#"SELECT u."linkOnly" FROM "RosterEntry" e JOIN "User" u ON u.id = e."userId"
        WHERE e.kind = $1 AND e."userId" = $2 FOR UPDATE OF e"#,
    )
    .bind(&kind)
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load the list"))?;
    let link_only = link_only.ok_or_else(|| ApiError::not_found("Not found"))?;
    if payload.name.is_some() {
        let name = clean_name(payload.name.as_deref())?;
        sqlx::query(r#"UPDATE "RosterEntry" SET name = $3 WHERE kind = $1 AND "userId" = $2"#)
            .bind(&kind)
            .bind(&user_id)
            .bind(&name)
            .execute(&mut *tx)
            .await
            .map_err(listed_error)?;
    }
    let mut current = user_id.clone();
    if let Some(account) = payload.account_id.filter(|id| !id.is_empty() && *id != user_id) {
        check_account(&mut tx, &kind, &account).await?;
        let taken: bool = sqlx::query_scalar(r#"SELECT EXISTS (SELECT 1 FROM "RosterEntry" WHERE kind = $1 AND "userId" = $2)"#)
            .bind(&kind)
            .bind(&account)
            .fetch_one(&mut *tx)
            .await
            .map_err(|err| db_error(err, "Failed to load the list"))?;
        if taken {
            return Err(ApiError::bad_request("Already on the list"));
        }
        if link_only {
            // Everything the placeholder held goes to the account, list entries included.
            merge_placeholder(&mut tx, &user_id, &account).await?;
        } else {
            sqlx::query(r#"UPDATE "RosterEntry" SET "userId" = $3 WHERE kind = $1 AND "userId" = $2"#)
                .bind(&kind)
                .bind(&user_id)
                .bind(&account)
                .execute(&mut *tx)
                .await
                .map_err(listed_error)?;
        }
        current = account;
    }
    audit::record_details(
        &mut *tx, &client, "roster.changed", Some(&auth_user.id), Some(&auth_user.username),
        Some(&current), true, None, None, json!({ "kind": kind, "before": user_id }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    let row = load_entries(&state.db).await?.into_iter().find(|row| row.kind == kind && row.user_id == current);
    Ok(Json(json!({ "entry": row.as_ref().map(entry_json) })))
}

/// Takes a name off a list; the account or placeholder and its sessions stay.
pub async fn remove_roster_entry(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path((kind, user_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    check_kind(&kind)?;
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let removed = sqlx::query(r#"DELETE FROM "RosterEntry" WHERE kind = $1 AND "userId" = $2"#)
        .bind(&kind)
        .bind(&user_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to save the list"))?
        .rows_affected();
    if removed == 0 {
        return Err(ApiError::not_found("Not found"));
    }
    audit::record_details(
        &mut *tx, &client, "roster.removed", Some(&auth_user.id), Some(&auth_user.username),
        Some(&user_id), true, None, None, json!({ "kind": kind }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "removed": true })))
}
