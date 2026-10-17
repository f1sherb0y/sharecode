use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::core::audit::{self, ClientInfo};

use super::customers::{clean_text, double_option, MAX_NOTES_CHARS};
use super::notifications::notify;
use super::rooms::{insert_room, room_to_json_owner, NewRoom, SUPPORTED_LANGUAGES};
use crate::{
    auth::{AuthUser, StaffUser},
    db::db_error,
    error::ApiError,
    permissions::is_staff,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

// 排班 sessions (场次). Agents and admins plan every tech's sessions openly;
// techs see only their own, read-only, and are notified of changes instead of
// confirming them. A session can open a room owned by its tech, where the
// customer joins through a share link.
const MIN_DURATION_MINUTES: i32 = 5;
const MAX_DURATION_MINUTES: i32 = 1440;
const MAX_RANGE_DAYS: i64 = 100;
const MAX_FIELD_CHARS: usize = 100;
const MAX_ROOM_NAME_CHARS: usize = 120;
const STATUS_SCHEDULED: &str = "scheduled";
const STATUS_CANCELLED: &str = "cancelled";
const STATUSES: [&str; 3] = [STATUS_SCHEDULED, "completed", STATUS_CANCELLED];

// a is the session. A scheduled session reads as completed once its room ended.
pub(super) const APPOINTMENT_SELECT: &str = r#"SELECT a.id, a."startsAt" as starts_at,
    a."durationMinutes" as duration_minutes, a.company, a.position, a.notes,
    CASE WHEN a.status = 'scheduled' AND r."isEnded" THEN 'completed' ELSE a.status END as status,
    a."createdAt" as created_at, a."updatedAt" as updated_at,
    c.id as customer_id, c.name as customer_name, c.contact as customer_contact,
    c.notes as customer_notes, c."isDeleted" as customer_is_deleted,
    t.id as tech_id, t.username as tech_username, t.color as tech_color, t.role as tech_role,
    t."isDeleted" as tech_is_deleted,
    g.id as agent_id, g.username as agent_username, g.color as agent_color,
    cb.id as created_by_id, cb.username as created_by_username,
    r.id as room_id, r.name as room_name, r.language as room_language, r."isEnded" as room_is_ended,
    r."endedAt" as room_ended_at,
    (a."techId" IS NOT NULL AND a.status <> 'cancelled' AND EXISTS (
        SELECT 1 FROM "Appointment" b
        WHERE b.id <> a.id AND b."techId" = a."techId" AND b.status <> 'cancelled'
          AND b."startsAt" < a."startsAt" + a."durationMinutes" * INTERVAL '1 minute'
          AND a."startsAt" < b."startsAt" + b."durationMinutes" * INTERVAL '1 minute'
    )) as has_conflict
    FROM "Appointment" a
    JOIN "Customer" c ON c.id = a."customerId"
    JOIN "User" cb ON cb.id = a."createdBy"
    LEFT JOIN "User" t ON t.id = a."techId"
    LEFT JOIN "User" g ON g.id = a."agentId"
    LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted""#;

#[derive(sqlx::FromRow)]
pub(super) struct AppointmentRow {
    id: String,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    company: Option<String>,
    position: Option<String>,
    notes: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    customer_id: String,
    customer_name: String,
    customer_contact: Option<String>,
    customer_notes: Option<String>,
    customer_is_deleted: bool,
    tech_id: Option<String>,
    tech_username: Option<String>,
    tech_color: Option<String>,
    tech_role: Option<String>,
    tech_is_deleted: Option<bool>,
    agent_id: Option<String>,
    agent_username: Option<String>,
    agent_color: Option<String>,
    created_by_id: String,
    created_by_username: String,
    room_id: Option<String>,
    room_name: Option<String>,
    room_language: Option<String>,
    room_is_ended: Option<bool>,
    room_ended_at: Option<DateTime<Utc>>,
    has_conflict: bool,
}

/// The stored session, locked for a change.
#[derive(sqlx::FromRow)]
struct StoredAppointment {
    customer_id: String,
    customer_name: String,
    tech_id: Option<String>,
    agent_id: Option<String>,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    company: Option<String>,
    position: Option<String>,
    notes: Option<String>,
    status: String,
    room_id: Option<String>,
    room_owner_id: Option<String>,
    room_is_live: Option<bool>,
}

#[derive(sqlx::FromRow)]
struct ConflictRow {
    id: String,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    customer_name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListAppointmentsQuery {
    from: Option<String>,
    to: Option<String>,
    tech_id: Option<String>,
    customer_id: Option<String>,
    unassigned: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppointmentPayload {
    customer_id: Option<String>,
    #[serde(deserialize_with = "double_option")]
    tech_id: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    agent_id: Option<Option<String>>,
    starts_at: Option<String>,
    duration_minutes: Option<i32>,
    #[serde(deserialize_with = "double_option")]
    company: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    position: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    notes: Option<Option<String>>,
    status: Option<String>,
    /// Save even if the tech already has a session at that time.
    allow_conflicts: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppointmentRoomPayload {
    language: Option<String>,
    /// Start a new room when the linked one has ended.
    replace: bool,
}

/// Sessions overlapping [from, to). Techs only ever get their own.
pub async fn list_appointments(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<ListAppointmentsQuery>,
) -> Result<Json<Value>, ApiError> {
    let from = parse_time(query.from.as_deref(), "A valid range start is required")?;
    let to = parse_time(query.to.as_deref(), "A valid range end is required")?;
    if to <= from || to - from > Duration::days(MAX_RANGE_DAYS) {
        return Err(ApiError::bad_request("The range must be between 1 minute and 100 days"));
    }
    let staff = is_staff(&auth_user.role);
    let tech_id = if staff {
        query.tech_id.filter(|id| !id.is_empty())
    } else {
        Some(auth_user.id.clone())
    };
    let rows = sqlx::query_as::<_, AppointmentRow>(&format!(
        r#"{APPOINTMENT_SELECT}
        WHERE a."startsAt" < $2 AND a."startsAt" > $1 - INTERVAL '1 day'
          AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $1
          AND ($3::text IS NULL OR a."techId" = $3)
          AND ($4::text IS NULL OR a."customerId" = $4)
          AND (NOT $5 OR a."techId" IS NULL)
        ORDER BY a."startsAt", a.id LIMIT 2000"#
    ))
    .bind(from)
    .bind(to)
    .bind(tech_id)
    .bind(query.customer_id.filter(|id| !id.is_empty()))
    .bind(staff && query.unassigned)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load sessions"))?;

    Ok(Json(json!({
        "appointments": rows.iter().map(|row| appointment_json(row, staff)).collect::<Vec<_>>()
    })))
}

pub async fn get_appointment(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(appointment_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = load_appointment(&state.db, &appointment_id).await?;
    let staff = is_staff(&auth_user.role);
    if !staff && row.tech_id.as_deref() != Some(auth_user.id.as_str()) {
        return Err(ApiError::not_found("Appointment not found"));
    }
    Ok(Json(json!({ "appointment": appointment_json(&row, staff) })))
}

pub async fn create_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Json(payload): Json<AppointmentPayload>,
) -> Result<Response, ApiError> {
    let customer_id = payload
        .customer_id
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ApiError::bad_request("Customer is required"))?;
    let tech_id = payload.tech_id.flatten();
    // The agent in charge defaults to whoever plans the session.
    let agent_id = payload.agent_id.unwrap_or_else(|| Some(auth_user.id.clone()));
    let starts_at = parse_start(payload.starts_at.as_deref())?;
    let duration = check_duration(payload.duration_minutes.unwrap_or(60))?;
    let company = clean_field(payload.company.flatten(), "Company is too long")?;
    let position = clean_field(payload.position.flatten(), "Position is too long")?;
    let notes = clean_text(payload.notes.flatten(), MAX_NOTES_CHARS, "Notes are too long")?;
    let status = check_status(payload.status.as_deref().unwrap_or(STATUS_SCHEDULED))?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let customer_name = active_customer(&mut tx, &customer_id).await?;
    if let Some(tech) = &tech_id {
        check_assignee(&mut tx, tech).await?;
    }
    if let Some(agent) = &agent_id {
        check_agent(&mut tx, agent).await?;
    }
    if let Some(tech) = tech_id.as_deref().filter(|_| status != STATUS_CANCELLED) {
        lock_tech_schedule(&mut tx, tech).await?;
        if !payload.allow_conflicts {
            let conflicts = find_conflicts(&mut tx, tech, starts_at, duration, None).await?;
            if !conflicts.is_empty() {
                return Ok(conflict_response(&conflicts));
            }
        }
    }

    let appointment_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Appointment" (id, "customerId", "techId", "agentId", "startsAt", "durationMinutes",
            company, position, notes, status, "createdBy")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)"#,
    )
    .bind(&appointment_id)
    .bind(&customer_id)
    .bind(&tech_id)
    .bind(&agent_id)
    .bind(starts_at)
    .bind(duration)
    .bind(&company)
    .bind(&position)
    .bind(&notes)
    .bind(status)
    .bind(&auth_user.id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create session"))?;

    let session = Notice {
        appointment_id: &appointment_id,
        customer_name: &customer_name,
        starts_at,
        duration,
        company: company.as_deref(),
        position: position.as_deref(),
    };
    if let Some(tech) = tech_id.as_deref() {
        if status == STATUS_SCHEDULED && session.is_ahead() && tech != auth_user.id {
            session.send(&mut tx, tech, &auth_user.id, NoticeKind::Assigned, None).await?;
        }
    }
    // Customer details are personal data: the audit log keeps IDs and times only.
    audit::record_details(
        &mut *tx,
        &client,
        "appointment.created",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&appointment_id),
        true,
        None,
        None,
        json!({
            "customerId": customer_id, "techId": tech_id, "agentId": agent_id,
            "startsAt": to_iso_string(starts_at), "durationMinutes": duration, "status": status,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    let row = load_appointment(&state.db, &appointment_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "appointment": appointment_json(&row, true) })),
    )
        .into_response())
}

pub async fn update_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(appointment_id): Path<String>,
    Json(payload): Json<AppointmentPayload>,
) -> Result<Response, ApiError> {
    // A new tech also takes over the session's live room; order that with
    // WebSocket access checks like other room permission changes.
    let _access = match payload.tech_id {
        Some(_) => Some(state.ws.access.write().await),
        None => None,
    };
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let current = sqlx::query_as::<_, StoredAppointment>(
        r#"SELECT a."customerId" as customer_id, c.name as customer_name, a."techId" as tech_id,
            a."agentId" as agent_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, a.status, r.id as room_id, r."ownerId" as room_owner_id,
            NOT r."isEnded" as room_is_live
        FROM "Appointment" a JOIN "Customer" c ON c.id = a."customerId"
        LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"
        WHERE a.id = $1 FOR UPDATE OF a"#,
    )
    .bind(&appointment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load session"))?
    .ok_or_else(|| ApiError::not_found("Appointment not found"))?;

    let customer_id = payload
        .customer_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| current.customer_id.clone());
    let tech_id = payload.tech_id.unwrap_or_else(|| current.tech_id.clone());
    let agent_id = payload.agent_id.unwrap_or_else(|| current.agent_id.clone());
    let starts_at = match payload.starts_at.as_deref() {
        Some(value) => parse_start(Some(value))?,
        None => current.starts_at,
    };
    let duration = check_duration(payload.duration_minutes.unwrap_or(current.duration_minutes))?;
    let company = match payload.company {
        Some(value) => clean_field(value, "Company is too long")?,
        None => current.company.clone(),
    };
    let position = match payload.position {
        Some(value) => clean_field(value, "Position is too long")?,
        None => current.position.clone(),
    };
    let notes = match payload.notes {
        Some(value) => clean_text(value, MAX_NOTES_CHARS, "Notes are too long")?,
        None => current.notes.clone(),
    };
    let status = check_status(payload.status.as_deref().unwrap_or(&current.status))?;

    let customer_name = if customer_id == current.customer_id {
        current.customer_name.clone()
    } else {
        active_customer(&mut tx, &customer_id).await?
    };
    let tech_changed = tech_id != current.tech_id;
    if let Some(tech) = tech_id.as_deref().filter(|_| tech_changed) {
        check_assignee(&mut tx, tech).await?;
    }
    if let Some(agent) = agent_id.as_deref().filter(|_| agent_id != current.agent_id) {
        check_agent(&mut tx, agent).await?;
    }
    let time_changed = starts_at != current.starts_at || duration != current.duration_minutes;
    let changes: Vec<&str> = [
        ("customer", customer_id != current.customer_id),
        ("tech", tech_changed),
        ("agent", agent_id != current.agent_id),
        ("time", starts_at != current.starts_at),
        ("duration", duration != current.duration_minutes),
        ("company", company != current.company),
        ("position", position != current.position),
        ("notes", notes != current.notes),
        ("status", status != current.status),
    ]
    .into_iter()
    .filter_map(|(field, changed)| changed.then_some(field))
    .collect();
    if changes.is_empty() {
        // Saving an unchanged form writes, notifies and records nothing.
        drop(tx);
        let row = load_appointment(&state.db, &appointment_id).await?;
        return Ok(Json(json!({ "appointment": appointment_json(&row, true) })).into_response());
    }
    // Edits that cannot create an overlap, like notes, never trip a conflict saved on purpose.
    let may_overlap = tech_changed || time_changed || current.status == STATUS_CANCELLED;
    if let Some(tech) = tech_id.as_deref().filter(|_| status != STATUS_CANCELLED && may_overlap) {
        lock_tech_schedule(&mut tx, tech).await?;
        if !payload.allow_conflicts {
            let conflicts =
                find_conflicts(&mut tx, tech, starts_at, duration, Some(&appointment_id)).await?;
            if !conflicts.is_empty() {
                return Ok(conflict_response(&conflicts));
            }
        }
    }

    sqlx::query(
        r#"UPDATE "Appointment" SET "customerId" = $2, "techId" = $3, "agentId" = $4, "startsAt" = $5,
            "durationMinutes" = $6, company = $7, position = $8, notes = $9, status = $10, "updatedAt" = NOW()
        WHERE id = $1"#,
    )
    .bind(&appointment_id)
    .bind(&customer_id)
    .bind(&tech_id)
    .bind(&agent_id)
    .bind(starts_at)
    .bind(duration)
    .bind(&company)
    .bind(&position)
    .bind(&notes)
    .bind(status)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to update session"))?;

    // A live room follows its session: the time and role, and its new tech as owner.
    let mut room_owner_changed = None;
    if let (Some(room_id), Some(true)) = (current.room_id.as_deref(), current.room_is_live) {
        if time_changed || company != current.company || position != current.position {
            sqlx::query(
                r#"UPDATE "Room" SET "scheduledTime" = $2, duration = $3, company = $4, position = $5,
                    "updatedAt" = NOW()
                WHERE id = $1"#,
            )
            .bind(room_id)
            .bind(starts_at)
            .bind(duration)
            .bind(&company)
            .bind(&position)
            .execute(&mut *tx)
            .await
            .map_err(|err| db_error(err, "Failed to update the session's room"))?;
        }
        if let Some(new_owner) = tech_id.as_deref().filter(|_| tech_changed) {
            if current.room_owner_id.as_deref() != Some(new_owner) {
                transfer_room(&mut tx, room_id, current.room_owner_id.as_deref(), new_owner).await?;
                audit::record_details(
                    &mut *tx,
                    &client,
                    "room.updated",
                    Some(&auth_user.id),
                    Some(&auth_user.username),
                    Some(room_id),
                    true,
                    None,
                    Some(room_id),
                    json!({
                        "ownerChanged": { "before": current.room_owner_id, "after": new_owner },
                        "appointmentId": appointment_id,
                    }),
                )
                .await?;
                room_owner_changed = Some(room_id.to_string());
            }
        }
    }

    let before = Notice {
        appointment_id: &appointment_id,
        customer_name: &current.customer_name,
        starts_at: current.starts_at,
        duration: current.duration_minutes,
        company: current.company.as_deref(),
        position: current.position.as_deref(),
    };
    let after = Notice {
        appointment_id: &appointment_id,
        customer_name: &customer_name,
        starts_at,
        duration,
        company: company.as_deref(),
        position: position.as_deref(),
    };
    let was_scheduled = current.status == STATUS_SCHEDULED;
    let is_scheduled = status == STATUS_SCHEDULED;
    let mine = |tech: &str| tech == auth_user.id;
    if tech_changed {
        if let Some(old) = current.tech_id.as_deref().filter(|t| !mine(t)) {
            if was_scheduled && before.is_ahead() {
                before.send(&mut tx, old, &auth_user.id, NoticeKind::Unassigned, None).await?;
            }
        }
        if let Some(new) = tech_id.as_deref().filter(|t| !mine(t)) {
            if is_scheduled && after.is_ahead() {
                after.send(&mut tx, new, &auth_user.id, NoticeKind::Assigned, None).await?;
            }
        }
    } else if let Some(tech) = tech_id.as_deref().filter(|t| !mine(t)) {
        let details: Vec<&str> = changes
            .iter()
            .copied()
            .filter(|field| !matches!(*field, "agent" | "status"))
            .collect();
        if was_scheduled && status == STATUS_CANCELLED {
            if before.is_ahead() {
                before.send(&mut tx, tech, &auth_user.id, NoticeKind::Cancelled, None).await?;
            }
        } else if !was_scheduled && is_scheduled {
            if after.is_ahead() {
                after.send(&mut tx, tech, &auth_user.id, NoticeKind::Assigned, None).await?;
            }
        } else if is_scheduled && !details.is_empty() && (after.is_ahead() || before.is_ahead()) {
            let previous = json!({
                "previousStartsAt": to_iso_string(current.starts_at),
                "previousDurationMinutes": current.duration_minutes,
                "changes": details,
            });
            after.send(&mut tx, tech, &auth_user.id, NoticeKind::Updated, Some(previous)).await?;
        }
    }

    audit::record_details(
        &mut *tx,
        &client,
        "appointment.updated",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&appointment_id),
        true,
        None,
        None,
        json!({
            "changes": changes,
            "techId": { "before": current.tech_id, "after": tech_id },
            "status": { "before": current.status, "after": status },
            "startsAt": to_iso_string(starts_at), "durationMinutes": duration,
            "allowConflicts": payload.allow_conflicts,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    if let Some(room_id) = room_owner_changed {
        // The previous tech no longer owns the room or belongs to it.
        state.ws.revoke_inaccessible_room(&state.db, &room_id).await;
    }

    let row = load_appointment(&state.db, &appointment_id).await?;
    Ok(Json(json!({ "appointment": appointment_json(&row, true) })).into_response())
}

/// Deletes a session planned by mistake; its room, if any, stays as it is.
/// Cancelling keeps the session on the calendar instead.
pub async fn delete_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    StaffUser(auth_user): StaffUser,
    Path(appointment_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let current = sqlx::query_as::<_, StoredAppointment>(
        r#"DELETE FROM "Appointment" a USING "Customer" c
        WHERE a.id = $1 AND c.id = a."customerId"
        RETURNING a."customerId" as customer_id, c.name as customer_name, a."techId" as tech_id,
            a."agentId" as agent_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, a.status, a."roomId" as room_id,
            NULL::text as room_owner_id, NULL::boolean as room_is_live"#,
    )
    .bind(&appointment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to delete session"))?
    .ok_or_else(|| ApiError::not_found("Appointment not found"))?;

    let session = Notice {
        appointment_id: &appointment_id,
        customer_name: &current.customer_name,
        starts_at: current.starts_at,
        duration: current.duration_minutes,
        company: current.company.as_deref(),
        position: current.position.as_deref(),
    };
    if let Some(tech) = current.tech_id.as_deref().filter(|t| *t != auth_user.id) {
        if current.status == STATUS_SCHEDULED && session.is_ahead() {
            session.send(&mut tx, tech, &auth_user.id, NoticeKind::Cancelled, None).await?;
        }
    }
    audit::record_details(
        &mut *tx,
        &client,
        "appointment.deleted",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&appointment_id),
        true,
        None,
        current.room_id.as_deref(),
        json!({
            "customerId": current.customer_id, "techId": current.tech_id,
            "startsAt": to_iso_string(current.starts_at), "status": current.status,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    Ok(Json(json!({ "message": "Session deleted" })))
}

/// Opens the session's room, creating it on first use with the tech as owner and
/// the session's time, company and position. The assigned tech and staff may call
/// this; an unassigned session's room belongs to the staff member who opens it.
pub async fn open_appointment_room(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_user: AuthUser,
    Path(appointment_id): Path<String>,
    Json(payload): Json<AppointmentRoomPayload>,
) -> Result<Response, ApiError> {
    let staff = is_staff(&auth_user.role);
    let language = payload.language.unwrap_or_else(|| "javascript".to_string());
    if !SUPPORTED_LANGUAGES.contains(&language.as_str()) {
        return Err(ApiError::bad_request("Unsupported language"));
    }
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let current = sqlx::query_as::<_, StoredAppointment>(
        r#"SELECT a."customerId" as customer_id, c.name as customer_name, a."techId" as tech_id,
            a."agentId" as agent_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, a.status, r.id as room_id, r."ownerId" as room_owner_id,
            NOT r."isEnded" as room_is_live
        FROM "Appointment" a JOIN "Customer" c ON c.id = a."customerId"
        LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"
        WHERE a.id = $1 FOR UPDATE OF a"#,
    )
    .bind(&appointment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load session"))?
    .filter(|row| staff || row.tech_id.as_deref() == Some(auth_user.id.as_str()))
    .ok_or_else(|| ApiError::not_found("Appointment not found"))?;

    if let Some(room_id) = current.room_id.as_deref() {
        if current.room_is_live == Some(true) || !payload.replace {
            drop(tx);
            let row = load_appointment(&state.db, &appointment_id).await?;
            return Ok(Json(json!({
                "room": { "id": room_id },
                "appointment": appointment_json(&row, staff),
                "created": false,
            }))
            .into_response());
        }
    }
    if current.status == STATUS_CANCELLED {
        return Err(ApiError::bad_request("Cancelled sessions have no room"));
    }
    let tech_is_active = match current.tech_id.as_deref() {
        Some(tech) => is_active_user(&mut tx, tech).await?,
        None => false,
    };
    let owner_id = match current.tech_id.as_deref() {
        Some(tech) if tech_is_active => tech.to_string(),
        _ if staff => auth_user.id.clone(),
        _ => return Err(ApiError::not_found("Appointment not found")),
    };
    let name = room_name(
        &current.customer_name,
        current.company.as_deref(),
        current.position.as_deref(),
    );
    let room = insert_room(
        &mut tx,
        NewRoom {
            name: &name,
            language: &language,
            company: current.company.as_deref(),
            position: current.position.as_deref(),
            owner_id: &owner_id,
            scheduled_time: Some(current.starts_at),
            duration: Some(current.duration_minutes),
            is_private: false,
        },
    )
    .await?;
    // A new room reopens a session marked completed, e.g. after its room was ended early.
    sqlx::query(
        r#"UPDATE "Appointment" SET "roomId" = $2, "updatedAt" = NOW(),
            status = CASE WHEN status = 'completed' THEN 'scheduled' ELSE status END
        WHERE id = $1"#,
    )
        .bind(&appointment_id)
        .bind(&room.id)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to link the room"))?;
    audit::record_details(
        &mut *tx,
        &client,
        "room.created",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&room.id),
        true,
        None,
        Some(&room.id),
        json!({
            "isPrivate": false, "language": language, "appointmentId": appointment_id,
            "ownerId": owner_id, "replaces": current.room_id,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    tracing::info!(
        actor_id = %auth_user.id,
        room_id = %room.id,
        appointment_id = %appointment_id,
        owner_id = %owner_id,
        "session room created"
    );

    let row = load_appointment(&state.db, &appointment_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "room": room_to_json_owner(&room),
            "appointment": appointment_json(&row, staff),
            "created": true,
        })),
    )
        .into_response())
}

pub(super) fn appointment_json(row: &AppointmentRow, staff: bool) -> Value {
    let mut customer = json!({
        "id": row.customer_id,
        "name": row.customer_name,
        "isDeleted": row.customer_is_deleted,
    });
    // The profile stays with agents: techs meet customers through the session's
    // room, and the session's own notes are the ones written for its tech.
    if staff {
        customer["contact"] = json!(row.customer_contact);
        customer["notes"] = json!(row.customer_notes);
    }
    json!({
        "id": row.id,
        "startsAt": to_iso_string(row.starts_at),
        "endsAt": to_iso_string(ends_at(row.starts_at, row.duration_minutes)),
        "durationMinutes": row.duration_minutes,
        "company": row.company,
        "position": row.position,
        "notes": row.notes,
        "status": row.status,
        "customer": customer,
        "tech": row.tech_id.as_ref().map(|id| json!({
            "id": id,
            "username": row.tech_username,
            "color": row.tech_color,
            "role": row.tech_role,
            "isDeleted": row.tech_is_deleted.unwrap_or(false),
        })),
        "agent": row.agent_id.as_ref().map(|id| json!({
            "id": id, "username": row.agent_username, "color": row.agent_color,
        })),
        "room": row.room_id.as_ref().map(|id| json!({
            "id": id,
            "name": row.room_name,
            "language": row.room_language,
            "isEnded": row.room_is_ended.unwrap_or(false),
            "endedAt": to_iso_string_opt(row.room_ended_at),
        })),
        "hasConflict": row.has_conflict,
        "createdBy": { "id": row.created_by_id, "username": row.created_by_username },
        "createdAt": to_iso_string(row.created_at),
        "updatedAt": to_iso_string(row.updated_at),
    })
}

async fn load_appointment(db: &sqlx::PgPool, appointment_id: &str) -> Result<AppointmentRow, ApiError> {
    sqlx::query_as::<_, AppointmentRow>(&format!("{APPOINTMENT_SELECT} WHERE a.id = $1"))
        .bind(appointment_id)
        .fetch_optional(db)
        .await
        .map_err(|err| db_error(err, "Failed to load session"))?
        .ok_or_else(|| ApiError::not_found("Appointment not found"))
}

async fn active_customer(tx: &mut sqlx::PgConnection, customer_id: &str) -> Result<String, ApiError> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT name FROM "Customer" WHERE id = $1 AND NOT "isDeleted""#,
    )
    .bind(customer_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load customer"))?
    .ok_or_else(|| ApiError::bad_request("Customer not found"))
}

async fn is_active_user(tx: &mut sqlx::PgConnection, user_id: &str) -> Result<bool, ApiError> {
    Ok(account_role(tx, user_id).await?.is_some())
}

async fn account_role(tx: &mut sqlx::PgConnection, user_id: &str) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar::<_, String>(r#"SELECT role FROM "User" WHERE id = $1 AND NOT "isDeleted""#)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to load account"))
}

/// Sessions usually go to techs, but any active account can take one.
async fn check_assignee(tx: &mut sqlx::PgConnection, user_id: &str) -> Result<(), ApiError> {
    match account_role(tx, user_id).await? {
        Some(_) => Ok(()),
        None => Err(ApiError::bad_request("Invalid tech")),
    }
}

async fn check_agent(tx: &mut sqlx::PgConnection, user_id: &str) -> Result<(), ApiError> {
    match account_role(tx, user_id).await? {
        Some(role) if is_staff(&role) => Ok(()),
        _ => Err(ApiError::bad_request("Invalid agent")),
    }
}

/// Serializes changes to one tech's sessions so two planners cannot double-book them.
async fn lock_tech_schedule(tx: &mut sqlx::PgConnection, tech_id: &str) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("schedule:{tech_id}"))
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to lock the schedule"))?;
    Ok(())
}

async fn find_conflicts(
    tx: &mut sqlx::PgConnection,
    tech_id: &str,
    starts_at: DateTime<Utc>,
    duration: i32,
    except: Option<&str>,
) -> Result<Vec<ConflictRow>, ApiError> {
    sqlx::query_as::<_, ConflictRow>(
        r#"SELECT a.id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            c.name as customer_name
        FROM "Appointment" a JOIN "Customer" c ON c.id = a."customerId"
        WHERE a."techId" = $1 AND a.status <> 'cancelled' AND ($4::text IS NULL OR a.id <> $4)
          AND a."startsAt" < $3 AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $2
        ORDER BY a."startsAt", a.id LIMIT 20"#,
    )
    .bind(tech_id)
    .bind(starts_at)
    .bind(ends_at(starts_at, duration))
    .bind(except)
    .fetch_all(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to check the schedule"))
}

fn conflict_response(conflicts: &[ConflictRow]) -> Response {
    let conflicts = conflicts
        .iter()
        .map(|conflict| {
            json!({
                "id": conflict.id,
                "startsAt": to_iso_string(conflict.starts_at),
                "endsAt": to_iso_string(ends_at(conflict.starts_at, conflict.duration_minutes)),
                "durationMinutes": conflict.duration_minutes,
                "customer": { "name": conflict.customer_name },
            })
        })
        .collect::<Vec<_>>();
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "Schedule conflict", "conflicts": conflicts })),
    )
        .into_response()
}

/// The new tech owns the room and edits it; the previous owner's own membership goes.
async fn transfer_room(
    tx: &mut sqlx::PgConnection,
    room_id: &str,
    previous_owner: Option<&str>,
    new_owner: &str,
) -> Result<(), ApiError> {
    sqlx::query(r#"UPDATE "Room" SET "ownerId" = $2, "updatedAt" = NOW() WHERE id = $1"#)
        .bind(room_id)
        .bind(new_owner)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to transfer the room"))?;
    if let Some(previous) = previous_owner {
        sqlx::query(
            r#"DELETE FROM "RoomParticipant" WHERE "roomId" = $1 AND "userId" = $2 AND "shareLinkId" IS NULL"#,
        )
        .bind(room_id)
        .bind(previous)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to transfer the room"))?;
    }
    sqlx::query(
        r#"INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit") VALUES ($1, $2, $3, true)
        ON CONFLICT ("roomId", "userId") DO UPDATE SET "canEdit" = true"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(room_id)
    .bind(new_owner)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to transfer the room"))?;
    Ok(())
}

#[derive(Clone, Copy)]
enum NoticeKind {
    Assigned,
    Updated,
    Unassigned,
    Cancelled,
}

impl NoticeKind {
    fn kind(self) -> &'static str {
        match self {
            Self::Assigned => "schedule.assigned",
            Self::Updated => "schedule.updated",
            Self::Unassigned => "schedule.unassigned",
            Self::Cancelled => "schedule.cancelled",
        }
    }

    // Clients render notices from kind and data; this text is for older clients.
    fn title(self) -> &'static str {
        match self {
            Self::Assigned => "New session assigned",
            Self::Updated => "Session changed",
            Self::Unassigned => "Session reassigned",
            Self::Cancelled => "Session cancelled",
        }
    }
}

/// A session as its tech is told about it.
struct Notice<'a> {
    appointment_id: &'a str,
    customer_name: &'a str,
    starts_at: DateTime<Utc>,
    duration: i32,
    company: Option<&'a str>,
    position: Option<&'a str>,
}

impl Notice<'_> {
    /// Techs hear about sessions that have not finished yet, not past ones.
    fn is_ahead(&self) -> bool {
        ends_at(self.starts_at, self.duration) > Utc::now()
    }

    async fn send(
        &self,
        tx: &mut sqlx::PgConnection,
        recipient: &str,
        actor: &str,
        kind: NoticeKind,
        extra: Option<Value>,
    ) -> Result<(), ApiError> {
        let mut data = json!({
            "appointmentId": self.appointment_id,
            "customerName": self.customer_name,
            "startsAt": to_iso_string(self.starts_at),
            "durationMinutes": self.duration,
            "company": self.company,
            "position": self.position,
        });
        if let (Some(target), Some(Value::Object(extra))) = (data.as_object_mut(), extra) {
            target.extend(extra);
        }
        let content = format!(
            "{} · {} · {} min",
            self.customer_name,
            self.starts_at.format("%Y-%m-%d %H:%M UTC"),
            self.duration
        );
        notify(tx, recipient, actor, kind.kind(), kind.title(), &content, data).await
    }
}

fn ends_at(starts_at: DateTime<Utc>, duration: i32) -> DateTime<Utc> {
    starts_at + Duration::minutes(i64::from(duration))
}

fn parse_time(value: Option<&str>, message: &'static str) -> Result<DateTime<Utc>, ApiError> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value.trim()).ok())
        .map(|time| time.with_timezone(&Utc))
        .filter(|time| (2000..=2100).contains(&time.year()))
        .ok_or_else(|| ApiError::bad_request(message))
}

/// Start times carry their UTC offset and are kept to the minute.
fn parse_start(value: Option<&str>) -> Result<DateTime<Utc>, ApiError> {
    let start = parse_time(value, "A valid start time is required")?;
    Ok(start
        .with_second(0)
        .and_then(|time| time.with_nanosecond(0))
        .unwrap_or(start))
}

fn check_duration(minutes: i32) -> Result<i32, ApiError> {
    if (MIN_DURATION_MINUTES..=MAX_DURATION_MINUTES).contains(&minutes) {
        Ok(minutes)
    } else {
        Err(ApiError::bad_request("Duration must be between 5 minutes and 24 hours"))
    }
}

fn check_status(status: &str) -> Result<&'static str, ApiError> {
    STATUSES
        .into_iter()
        .find(|known| *known == status)
        .ok_or_else(|| ApiError::bad_request("Invalid session status"))
}

fn clean_field(value: Option<String>, too_long: &'static str) -> Result<Option<String>, ApiError> {
    clean_text(value, MAX_FIELD_CHARS, too_long)
}

/// "Customer · Company Position", kept within the room name limit.
fn room_name(customer: &str, company: Option<&str>, position: Option<&str>) -> String {
    let role = [company, position]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let name = if role.is_empty() {
        customer.to_string()
    } else {
        format!("{customer} · {role}")
    };
    name.chars().take(MAX_ROOM_NAME_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_times_need_an_offset_and_drop_seconds() {
        let start = parse_start(Some("2026-10-20T14:30:45.5+08:00")).unwrap();
        assert_eq!(to_iso_string(start), "2026-10-20T06:30:00+00:00");
        for invalid in [None, Some(""), Some("2026-10-20T14:30"), Some("1999-12-31T00:00:00Z"), Some("tomorrow")] {
            assert!(parse_start(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn durations_statuses_and_room_names_are_bounded() {
        assert!(check_duration(4).is_err() && check_duration(1441).is_err());
        assert_eq!(check_duration(5).unwrap(), 5);
        assert_eq!(check_duration(1440).unwrap(), 1440);
        assert_eq!(check_status("cancelled").unwrap(), STATUS_CANCELLED);
        assert!(check_status("done").is_err());
        assert_eq!(room_name("张三", Some("字节"), Some("后端")), "张三 · 字节 后端");
        assert_eq!(room_name("张三", None, Some("后端")), "张三 · 后端");
        assert_eq!(room_name("张三", None, None), "张三");
        assert_eq!(room_name(&"长".repeat(200), None, None).chars().count(), MAX_ROOM_NAME_CHARS);
    }

    #[test]
    fn only_unfinished_sessions_are_announced() {
        let notice = |starts_at, duration| Notice {
            appointment_id: "a",
            customer_name: "c",
            starts_at,
            duration,
            company: None,
            position: None,
        };
        assert!(notice(Utc::now() + Duration::hours(1), 30).is_ahead());
        // Already started but still running.
        assert!(notice(Utc::now() - Duration::minutes(10), 30).is_ahead());
        assert!(!notice(Utc::now() - Duration::hours(2), 60).is_ahead());
    }
}
