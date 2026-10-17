use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use rand::TryRngCore;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::core::audit::{self, ClientInfo};

use crate::{
    auth::StaffUser,
    db::db_error,
    error::ApiError,
    permissions::is_admin,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

// Registration is invite-only: admins and agents issue single-use codes that
// expire after 7 days, and a tech registers with one. An unused invite also
// stops working once its issuer is removed or is no longer an agent or admin.
/// No 0/O or 1/I. 32 symbols, so every random byte maps without bias.
const CODE_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH: usize = 12;
const MAX_NOTE_CHARS: usize = 100;
// i is the invite, c its issuer.
const INVITE_EXPIRED_SQL: &str =
    r#"(i."expiresAt" <= NOW() OR c."isDeleted" OR room_role_rank(c.role) = 0)"#;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CreateInvitePayload {
    pub note: Option<String>,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: String,
    code: String,
    note: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    used_at: Option<DateTime<Utc>>,
    created_by_id: String,
    created_by_username: String,
    used_by_id: Option<String>,
    used_by_username: Option<String>,
    is_expired: bool,
}

fn invite_select(source: &str) -> String {
    format!(
        r#"SELECT i.id, i.code, i.note, i."createdAt" as created_at, i."expiresAt" as expires_at,
        i."usedAt" as used_at, c.id as created_by_id, c.username as created_by_username,
        u.id as used_by_id, u.username as used_by_username, {INVITE_EXPIRED_SQL} as is_expired
        FROM {source} i JOIN "User" c ON c.id = i."createdBy" LEFT JOIN "User" u ON u.id = i."usedBy""#
    )
}

pub async fn create_invite(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Json(payload): Json<CreateInvitePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let note = payload
        .note
        .map(|note| note.trim().to_string())
        .filter(|note| !note.is_empty());
    if note
        .as_ref()
        .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
    {
        return Err(ApiError::bad_request("Invite note is too long"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let invite = sqlx::query_as::<_, InviteRow>(&format!(
        r#"WITH created AS (
            INSERT INTO "RegistrationInvite" (id, code, note, "createdBy", "expiresAt")
            VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
            RETURNING *
        ) {}"#,
        invite_select("created")
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(generate_code())
    .bind(&note)
    .bind(&auth_user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to create invite"))?;
    // The code is a credential and the note may name a person: neither is audited.
    audit::record_details(
        &mut *tx,
        &client,
        "invite.created",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&invite.id),
        true,
        None,
        None,
        json!({"expiresAt": to_iso_string(invite.expires_at)}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "invite": invite_json(&state, &invite) })),
    ))
}

/// Agents see the invites they issued; admins see everyone's.
pub async fn list_invites(
    State(state): State<AppState>,
    StaffUser(auth_user): StaffUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let issuer = (!is_admin(&auth_user.role)).then_some(auth_user.id.as_str());
    let invites = sqlx::query_as::<_, InviteRow>(&format!(
        r#"{} WHERE $1::text IS NULL OR i."createdBy" = $1
        ORDER BY i."createdAt" DESC, i.id DESC LIMIT 100"#,
        invite_select(r#""RegistrationInvite""#)
    ))
    .bind(issuer)
    .fetch_all(&state.db)
    .await
    .map_err(|e| db_error(e, "Failed to load invites"))?;

    Ok(Json(json!({
        "invites": invites.iter().map(|invite| invite_json(&state, invite)).collect::<Vec<_>>()
    })))
}

/// The issuer or an admin can withdraw an unused invite; used ones stay as the record.
pub async fn delete_invite(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(invite_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "RegistrationInvite"
        WHERE id = $1 AND "usedAt" IS NULL AND ("createdBy" = $2 OR $3)
        RETURNING id"#,
    )
    .bind(&invite_id)
    .bind(&auth_user.id)
    .bind(is_admin(&auth_user.role))
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to delete invite"))?
    .ok_or_else(|| ApiError::not_found("Invite not found"))?;
    audit::record_details(
        &mut *tx,
        &client,
        "invite.revoked",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&invite_id),
        true,
        None,
        None,
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    Ok(Json(json!({ "message": "Invite deleted" })))
}

/// Accepts a code as displayed (XXXX-XXXX-XXXX), in any case, with or without separators.
pub(super) fn normalize_code(input: &str) -> String {
    input
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Why a registration code was refused. Refusals are audited like failed sign-ins.
pub(super) enum InviteRejection {
    Missing,
    Invalid,
    Used,
    Expired,
}

impl InviteRejection {
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::Missing => "missing_invite",
            Self::Invalid => "invalid_invite",
            Self::Used => "invite_used",
            Self::Expired => "invite_expired",
        }
    }
}

impl From<InviteRejection> for ApiError {
    fn from(rejection: InviteRejection) -> Self {
        match rejection {
            InviteRejection::Missing => ApiError::bad_request("Invite code is required"),
            InviteRejection::Invalid => ApiError::bad_request("Invalid invite code"),
            InviteRejection::Used => ApiError::gone("This invite code has already been used"),
            InviteRejection::Expired => ApiError::gone("This invite code has expired"),
        }
    }
}

/// Checks a normalized registration code before any expensive work; returns the invite ID.
pub(super) async fn find_usable(
    db: &sqlx::PgPool,
    code: &str,
) -> Result<Result<String, InviteRejection>, ApiError> {
    if code.is_empty() {
        return Ok(Err(InviteRejection::Missing));
    }
    let invite = sqlx::query_as::<_, (String, bool, bool)>(&format!(
        r#"SELECT i.id, i."usedAt" IS NOT NULL, {INVITE_EXPIRED_SQL}
        FROM "RegistrationInvite" i JOIN "User" c ON c.id = i."createdBy"
        WHERE i.code = $1"#
    ))
    .bind(code)
    .fetch_optional(db)
    .await
    .map_err(|e| db_error(e, "Failed to check invite"))?;
    Ok(match invite {
        None => Err(InviteRejection::Invalid),
        Some((_, true, _)) => Err(InviteRejection::Used),
        Some((_, _, true)) => Err(InviteRejection::Expired),
        Some((id, _, _)) => Ok(id),
    })
}

/// Consumes the invite for the account just inserted in this transaction and
/// returns its issuer. Of two registrations racing for one code, the second
/// finds it used and rolls back.
pub(super) async fn claim(
    tx: &mut sqlx::PgConnection,
    invite_id: &str,
    user_id: &str,
) -> Result<String, ApiError> {
    sqlx::query_scalar::<_, String>(&format!(
        r#"UPDATE "RegistrationInvite" i SET "usedAt" = NOW(), "usedBy" = $2
        FROM "User" c
        WHERE i.id = $1 AND c.id = i."createdBy" AND i."usedAt" IS NULL AND NOT {INVITE_EXPIRED_SQL}
        RETURNING i."createdBy""#
    ))
    .bind(invite_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to claim invite"))?
    .ok_or_else(|| ApiError::gone("This invite code has already been used"))
}

fn generate_code() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    rand::rngs::OsRng.try_fill_bytes(&mut bytes).unwrap();
    bytes
        .iter()
        .map(|byte| CODE_ALPHABET[usize::from(byte % 32)] as char)
        .collect()
}

// Web clients build the link from their own origin; desktop builds need this one.
fn invite_url(state: &AppState, code: &str) -> Option<String> {
    let base = state
        .config
        .app_url
        .as_ref()
        .or(state.config.frontend_url.as_ref())?;
    let route = if state.config.frontend_hash_router {
        "#/register"
    } else {
        "register"
    };
    Some(format!(
        "{}/{route}?invite={code}",
        base.trim_end_matches('/')
    ))
}

fn invite_json(state: &AppState, invite: &InviteRow) -> serde_json::Value {
    json!({
        "id": invite.id,
        "code": invite.code,
        "note": invite.note,
        "createdAt": to_iso_string(invite.created_at),
        "expiresAt": to_iso_string(invite.expires_at),
        "usedAt": to_iso_string_opt(invite.used_at),
        "createdBy": { "id": invite.created_by_id, "username": invite.created_by_username },
        "usedBy": invite.used_by_id.as_ref().map(|id| json!({ "id": id, "username": invite.used_by_username })),
        "isUsed": invite.used_at.is_some(),
        "isExpired": invite.used_at.is_none() && invite.is_expired,
        "inviteUrl": invite_url(state, &invite.code),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_unambiguous_and_accept_the_display_form() {
        let code = generate_code();
        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.bytes().all(|byte| CODE_ALPHABET.contains(&byte)));
        assert_ne!(generate_code(), code);
        assert_eq!(normalize_code(" abcd-efgh jk2m\n"), "ABCDEFGHJK2M");
        assert_eq!(normalize_code("--"), "");
    }
}
