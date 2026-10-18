use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::core::audit::{self, ClientInfo};

use super::admin::search_pattern;
use super::appointments::{appointment_json, AppointmentRow, APPOINTMENT_SELECT};
use crate::{
    auth::StaffUser,
    db::db_error,
    error::ApiError,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

// 排班 customer profiles: one list shared by every agent and admin, where each
// customer belongs to the agent who created it. Customers never sign in, and
// techs only see the customer of their own sessions.
const MAX_NAME_CHARS: usize = 100;
const MAX_CONTACT_CHARS: usize = 200;
pub(super) const MAX_NOTES_CHARS: usize = 2000;

/// Tells an absent field (None) from an explicit null (Some(None)) in updates.
pub(super) fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Trims optional text, treating blank as none, and rejects it past `max` characters.
pub(super) fn clean_text(
    value: Option<String>,
    max: usize,
    too_long: &'static str,
) -> Result<Option<String>, ApiError> {
    let value = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > max)
    {
        return Err(ApiError::bad_request(too_long));
    }
    Ok(value)
}

fn clean_name(value: Option<String>) -> Result<String, ApiError> {
    clean_text(value, MAX_NAME_CHARS, "Customer name is too long")?
        .ok_or_else(|| ApiError::bad_request("Customer name is required"))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomerListQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    q: Option<String>,
    /// Only the caller's own customers: the ones they created.
    mine: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CreateCustomerPayload {
    name: Option<String>,
    contact: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct UpdateCustomerPayload {
    name: Option<String>,
    #[serde(deserialize_with = "double_option")]
    contact: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    notes: Option<Option<String>>,
}

#[derive(sqlx::FromRow)]
struct CustomerRow {
    id: String,
    name: String,
    contact: Option<String>,
    notes: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    created_by_id: String,
    created_by_username: String,
    session_count: i64,
    upcoming_count: i64,
    next_session_at: Option<DateTime<Utc>>,
    last_session_at: Option<DateTime<Utc>>,
}

// c is the customer. Sessions still to come are those that have not ended yet.
const CUSTOMER_SELECT: &str = r#"SELECT c.id, c.name, c.contact, c.notes,
    c."createdAt" as created_at, c."updatedAt" as updated_at,
    cb.id as created_by_id, cb.username as created_by_username,
    s.session_count, s.upcoming_count, s.next_session_at, s.last_session_at
    FROM "Customer" c JOIN "User" cb ON cb.id = c."createdBy"
    LEFT JOIN LATERAL (
        SELECT COUNT(*) as session_count,
            COUNT(*) FILTER (WHERE a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW())
                as upcoming_count,
            MIN(a."startsAt") FILTER (WHERE a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW())
                as next_session_at,
            MAX(a."startsAt") FILTER (WHERE a."startsAt" <= NOW()) as last_session_at
        FROM "Appointment" a WHERE a."customerId" = c.id
    ) s ON true"#;

pub async fn list_customers(
    State(state): State<AppState>,
    StaffUser(auth_user): StaffUser,
    Query(query): Query<CustomerListQuery>,
) -> Result<Json<Value>, ApiError> {
    let pattern = search_pattern(query.q.as_deref());
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM "Customer" c
        WHERE NOT c."isDeleted" AND (c.name ILIKE $1 OR COALESCE(c.contact, '') ILIKE $1)
          AND (NOT $2 OR c."createdBy" = $3)"#,
    )
    .bind(&pattern)
    .bind(query.mine)
    .bind(&auth_user.id)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to count customers"))?;
    let size = i64::from(query.page_size.unwrap_or(25).clamp(1, 100));
    let pages = (total + size - 1) / size;
    let page = i64::from(query.page.unwrap_or(1).max(1)).min(pages.max(1));
    let customers = sqlx::query_as::<_, CustomerRow>(&format!(
        r#"{CUSTOMER_SELECT}
        WHERE NOT c."isDeleted" AND (c.name ILIKE $1 OR COALESCE(c.contact, '') ILIKE $1)
          AND (NOT $4 OR c."createdBy" = $5)
        ORDER BY lower(c.name), c.id LIMIT $2 OFFSET $3"#
    ))
    .bind(&pattern)
    .bind(size)
    .bind((page - 1) * size)
    .bind(query.mine)
    .bind(&auth_user.id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load customers"))?;

    Ok(Json(json!({
        "customers": customers.iter().map(customer_json).collect::<Vec<_>>(),
        "pagination": {
            "page": page, "pageSize": size, "total": total, "totalPages": pages,
            "hasNext": page < pages, "hasPrev": page > 1,
        },
    })))
}

/// A customer with their sessions, newest first.
pub async fn get_customer(
    State(state): State<AppState>,
    _staff: StaffUser,
    Path(customer_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let customer = load_customer(&state.db, &customer_id).await?;
    let appointments = sqlx::query_as::<_, AppointmentRow>(&format!(
        r#"{APPOINTMENT_SELECT} WHERE a."customerId" = $1 ORDER BY a."startsAt" DESC, a.id LIMIT 200"#
    ))
    .bind(&customer_id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load sessions"))?;

    Ok(Json(json!({
        "customer": customer_json(&customer),
        "appointments": appointments.iter().map(|row| appointment_json(row, true)).collect::<Vec<_>>(),
    })))
}

pub async fn create_customer(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Json(payload): Json<CreateCustomerPayload>,
) -> Result<impl IntoResponse, ApiError> {
    let name = clean_name(payload.name)?;
    let contact = clean_text(payload.contact, MAX_CONTACT_CHARS, "Contact is too long")?;
    let notes = clean_text(payload.notes, MAX_NOTES_CHARS, "Notes are too long")?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let customer_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Customer" (id, name, contact, notes, "createdBy") VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(&customer_id)
    .bind(&name)
    .bind(&contact)
    .bind(&notes)
    .bind(&auth_user.id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create customer"))?;
    // Names, contacts and notes are personal data: the audit log records IDs only.
    audit::record_details(
        &mut *tx,
        &client,
        "customer.created",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&customer_id),
        true,
        None,
        None,
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    let customer = load_customer(&state.db, &customer_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "customer": customer_json(&customer) })),
    ))
}

pub async fn update_customer(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(customer_id): Path<String>,
    Json(payload): Json<UpdateCustomerPayload>,
) -> Result<Json<Value>, ApiError> {
    let name = payload.name.map(|name| clean_name(Some(name))).transpose()?;
    let contact = payload
        .contact
        .map(|contact| clean_text(contact, MAX_CONTACT_CHARS, "Contact is too long"))
        .transpose()?;
    let notes = payload
        .notes
        .map(|notes| clean_text(notes, MAX_NOTES_CHARS, "Notes are too long"))
        .transpose()?;
    let changes: Vec<&str> = [
        ("name", name.is_some()),
        ("contact", contact.is_some()),
        ("notes", notes.is_some()),
    ]
    .into_iter()
    .filter_map(|(field, changed)| changed.then_some(field))
    .collect();

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query_scalar::<_, String>(
        r#"UPDATE "Customer" SET name = COALESCE($2, name),
            contact = CASE WHEN $3 THEN $4 ELSE contact END,
            notes = CASE WHEN $5 THEN $6 ELSE notes END,
            "updatedAt" = NOW()
        WHERE id = $1 AND NOT "isDeleted" RETURNING id"#,
    )
    .bind(&customer_id)
    .bind(&name)
    .bind(contact.is_some())
    .bind(contact.flatten())
    .bind(notes.is_some())
    .bind(notes.flatten())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to update customer"))?
    .ok_or_else(|| ApiError::not_found("Customer not found"))?;
    audit::record_details(
        &mut *tx,
        &client,
        "customer.updated",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&customer_id),
        true,
        None,
        None,
        json!({ "changes": changes }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    let customer = load_customer(&state.db, &customer_id).await?;
    Ok(Json(json!({ "customer": customer_json(&customer) })))
}

/// Removes a customer from the list. Past sessions keep their name; one with
/// sessions still to come must have them moved or deleted first.
pub async fn delete_customer(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(customer_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "Customer" WHERE id = $1 AND NOT "isDeleted" FOR UPDATE"#,
    )
    .bind(&customer_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load customer"))?
    .ok_or_else(|| ApiError::not_found("Customer not found"))?;
    let upcoming: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM "Appointment"
        WHERE "customerId" = $1 AND "startsAt" + "durationMinutes" * INTERVAL '1 minute' > NOW()"#,
    )
    .bind(&customer_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to check sessions"))?;
    if upcoming > 0 {
        return Err(ApiError::conflict("Customer has upcoming sessions"));
    }
    sqlx::query(r#"UPDATE "Customer" SET "isDeleted" = true, "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&customer_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to delete customer"))?;
    audit::record_details(
        &mut *tx,
        &client,
        "customer.deleted",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&customer_id),
        true,
        None,
        None,
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    Ok(Json(json!({ "message": "Customer deleted" })))
}

async fn load_customer(db: &sqlx::PgPool, customer_id: &str) -> Result<CustomerRow, ApiError> {
    sqlx::query_as::<_, CustomerRow>(&format!(
        r#"{CUSTOMER_SELECT} WHERE c.id = $1 AND NOT c."isDeleted""#
    ))
    .bind(customer_id)
    .fetch_optional(db)
    .await
    .map_err(|err| db_error(err, "Failed to load customer"))?
    .ok_or_else(|| ApiError::not_found("Customer not found"))
}

fn customer_json(customer: &CustomerRow) -> Value {
    json!({
        "id": customer.id,
        "name": customer.name,
        "contact": customer.contact,
        "notes": customer.notes,
        "createdAt": to_iso_string(customer.created_at),
        "updatedAt": to_iso_string(customer.updated_at),
        "createdBy": { "id": customer.created_by_id, "username": customer.created_by_username },
        "sessionCount": customer.session_count,
        "upcomingCount": customer.upcoming_count,
        "nextSessionAt": to_iso_string_opt(customer.next_session_at),
        "lastSessionAt": to_iso_string_opt(customer.last_session_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Patch {
        #[serde(default, deserialize_with = "double_option")]
        contact: Option<Option<String>>,
    }

    #[test]
    fn updates_tell_a_missing_field_from_a_cleared_one() {
        let parse = |body: &str| serde_json::from_str::<Patch>(body).unwrap().contact;
        assert_eq!(parse("{}"), None);
        assert_eq!(parse(r#"{"contact":null}"#), Some(None));
        assert_eq!(parse(r#"{"contact":"wx: a"}"#), Some(Some("wx: a".into())));
    }

    #[test]
    fn text_is_trimmed_blank_is_none_and_length_counts_characters() {
        assert_eq!(clean_text(Some("  a b  ".into()), 3, "x").unwrap(), Some("a b".into()));
        assert_eq!(clean_text(Some("   ".into()), 3, "x").unwrap(), None);
        assert_eq!(clean_text(Some("张三丰".into()), 3, "x").unwrap(), Some("张三丰".into()));
        assert!(clean_text(Some("张三丰丰".into()), 3, "x").is_err());
        assert!(clean_name(Some(" ".into())).is_err());
    }
}
