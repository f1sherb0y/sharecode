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
    auth::AuthUser,
    db::db_error,
    error::ApiError,
    permissions::is_staff,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

// 排班 sessions (场次). Agents and admins plan every tech's sessions openly;
// techs see only their own, read-only, and are notified of changes instead of
// confirming them. A session can open a room owned by its tech, where the
// customer joins through a share link. A session planned by mistake or called
// off is deleted; none is cancelled or completed by hand. A customer is optional.
// Techs mark time they are busy as blocks: theirs alone, without a customer or a
// room, kept out of other sessions' way like any session.
const MIN_DURATION_MINUTES: i32 = 5;
const MAX_DURATION_MINUTES: i32 = 1440;
const MAX_RANGE_DAYS: i64 = 100;
const MAX_FIELD_CHARS: usize = 100;
const MAX_ROOM_NAME_CHARS: usize = 120;
/// The name of a session room without a company or position.
const UNNAMED_ROOM: &str = "场次";

// a is the session. It reads as completed once its room has ended.
pub(super) const APPOINTMENT_SELECT: &str = r#"SELECT a.id, a."startsAt" as starts_at,
    a."durationMinutes" as duration_minutes, a.company, a.position, a.notes, a."isBlock" as is_block,
    CASE WHEN r."isEnded" THEN 'completed' ELSE 'scheduled' END as status,
    a."createdAt" as created_at, a."updatedAt" as updated_at,
    c.id as customer_id, c.name as customer_name, c.contact as customer_contact,
    c.notes as customer_notes, c."isDeleted" as customer_is_deleted,
    ow.id as owner_id, ow.username as owner_username, ow.color as owner_color,
    t.id as tech_id, t.username as tech_username, t.color as tech_color, t.role as tech_role,
    t."isDeleted" as tech_is_deleted,
    cb.id as created_by_id, cb.username as created_by_username, cb.color as created_by_color,
    mg.id as manager_id, mg.username as manager_username, mg.color as manager_color,
    -- Names on the work tables' lists, where the person is on one.
    COALESCE((SELECT re.name FROM "RosterEntry" re WHERE re.kind = 'manager' AND re."userId" = mg.id), mg.username) as manager_name,
    (SELECT re.name FROM "RosterEntry" re WHERE re.kind = 'tech' AND re."userId" = t.id) as tech_name,
    r.id as room_id, r.name as room_name, r.language as room_language, r."isEnded" as room_is_ended,
    r."endedAt" as room_ended_at,
    (a."techId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Appointment" b
        WHERE b.id <> a.id AND b."techId" = a."techId"
          AND b."startsAt" < a."startsAt" + a."durationMinutes" * INTERVAL '1 minute'
          AND a."startsAt" < b."startsAt" + b."durationMinutes" * INTERVAL '1 minute'
    )) as has_conflict
    FROM "Appointment" a
    LEFT JOIN "Customer" c ON c.id = a."customerId"
    LEFT JOIN "User" ow ON ow.id = c."createdBy"
    JOIN "User" cb ON cb.id = a."createdBy"
    -- The 管理 a session belongs to: the one chosen, else its customer's agent, else its planner.
    JOIN "User" mg ON mg.id = COALESCE(a."managerId", c."createdBy", a."createdBy")
    LEFT JOIN "User" t ON t.id = a."techId"
    LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted""#;

#[derive(sqlx::FromRow)]
pub(super) struct AppointmentRow {
    id: String,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    company: Option<String>,
    position: Option<String>,
    notes: Option<String>,
    is_block: bool,
    status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    customer_id: Option<String>,
    customer_name: Option<String>,
    customer_contact: Option<String>,
    customer_notes: Option<String>,
    customer_is_deleted: Option<bool>,
    owner_id: Option<String>,
    owner_username: Option<String>,
    owner_color: Option<String>,
    tech_id: Option<String>,
    tech_username: Option<String>,
    tech_color: Option<String>,
    tech_role: Option<String>,
    tech_is_deleted: Option<bool>,
    created_by_id: String,
    created_by_username: String,
    created_by_color: String,
    manager_id: String,
    manager_username: String,
    manager_color: String,
    manager_name: String,
    tech_name: Option<String>,
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
    customer_id: Option<String>,
    manager_id: Option<String>,
    customer_name: Option<String>,
    is_block: bool,
    tech_id: Option<String>,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    company: Option<String>,
    position: Option<String>,
    notes: Option<String>,
    room_id: Option<String>,
    room_owner_id: Option<String>,
    room_is_live: Option<bool>,
}

#[derive(sqlx::FromRow)]
struct ConflictRow {
    id: String,
    starts_at: DateTime<Utc>,
    duration_minutes: i32,
    customer_name: Option<String>,
    manager_username: String,
    is_block: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListAppointmentsQuery {
    from: Option<String>,
    to: Option<String>,
    tech_id: Option<String>,
    customer_id: Option<String>,
    unassigned: bool,
    /// Staff only: their customers' sessions and the ones they planned.
    mine: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppointmentPayload {
    #[serde(deserialize_with = "double_option")]
    customer_id: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    tech_id: Option<Option<String>>,
    /// The 管理 the session belongs to (staff only); none falls back to the customer's agent.
    #[serde(deserialize_with = "double_option")]
    manager_id: Option<Option<String>>,
    starts_at: Option<String>,
    duration_minutes: Option<i32>,
    #[serde(deserialize_with = "double_option")]
    company: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    position: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    notes: Option<Option<String>>,
    /// Save even if the tech already has a session at that time (staff only).
    allow_conflicts: bool,
    /// Busy time on a tech's table rather than a session (on create).
    is_block: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppointmentRoomPayload {
    language: Option<String>,
    /// Start a new room when the linked one has ended.
    replace: bool,
}

/// Sessions overlapping [from, to). Techs only ever get their own; `mine` keeps
/// a planner's own: their customers' sessions and the ones they planned.
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
          AND (NOT $6 OR COALESCE(a."managerId", c."createdBy") = $7 OR a."createdBy" = $7)
        ORDER BY a."startsAt", a.id LIMIT 2000"#
    ))
    .bind(from)
    .bind(to)
    .bind(tech_id)
    .bind(query.customer_id.filter(|id| !id.is_empty()))
    .bind(staff && query.unassigned)
    .bind(staff && query.mine)
    .bind(&auth_user.id)
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

/// Staff plan sessions for anyone; a tech may only mark busy time on their own table.
pub async fn create_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_user: AuthUser,
    Json(payload): Json<AppointmentPayload>,
) -> Result<Response, ApiError> {
    let staff = is_staff(&auth_user.role);
    let is_block = payload.is_block || !staff;
    if !staff && !payload.is_block {
        // Like every staff-only route, planning does not exist for techs.
        return Err(ApiError::not_found("Not found"));
    }
    let customer_id = payload.customer_id.flatten().filter(|id| !id.is_empty());
    let tech_id = if staff { payload.tech_id.flatten() } else { Some(auth_user.id.clone()) };
    let manager_id = payload.manager_id.flatten().filter(|id| !id.is_empty() && !is_block);
    if is_block && (tech_id.is_none() || customer_id.is_some()) {
        return Err(ApiError::bad_request("Busy time belongs to a tech and has no customer"));
    }
    let starts_at = parse_start(payload.starts_at.as_deref())?;
    let duration = check_duration(payload.duration_minutes.unwrap_or(60))?;
    let (company, position) = if is_block {
        (None, None)
    } else {
        (
            clean_field(payload.company.flatten(), "Company is too long")?,
            clean_field(payload.position.flatten(), "Position is too long")?,
        )
    };
    let notes = clean_text(payload.notes.flatten(), MAX_NOTES_CHARS, "Notes are too long")?;
    // Busy time may cover sessions already planned: both show as clashing until someone sorts it out.
    let allow_conflicts = is_block || (staff && payload.allow_conflicts);

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let customer_name = match customer_id.as_deref() {
        Some(id) => Some(active_customer(&mut tx, id).await?),
        None => None,
    };
    if let Some(manager) = manager_id.as_deref() {
        check_manager(&mut tx, manager).await?;
    }
    if let Some(tech) = tech_id.as_deref() {
        check_assignee(&mut tx, tech).await?;
        lock_tech_schedule(&mut tx, tech).await?;
        if !allow_conflicts {
            let conflicts = find_conflicts(&mut tx, tech, starts_at, duration, None).await?;
            if !conflicts.is_empty() {
                return Ok(conflict_response(&conflicts));
            }
        }
    }

    let appointment_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Appointment" (id, "customerId", "techId", "startsAt", "durationMinutes",
            company, position, notes, "createdBy", "isBlock", "managerId")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)"#,
    )
    .bind(&appointment_id)
    .bind(&customer_id)
    .bind(&tech_id)
    .bind(starts_at)
    .bind(duration)
    .bind(&company)
    .bind(&position)
    .bind(&notes)
    .bind(&auth_user.id)
    .bind(is_block)
    .bind(&manager_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create session"))?;

    let session = Notice {
        appointment_id: &appointment_id,
        customer_name: customer_name.as_deref(),
        starts_at,
        duration,
        company: company.as_deref(),
        position: position.as_deref(),
    };
    if let Some(tech) = tech_id.as_deref().filter(|tech| *tech != auth_user.id && !is_block) {
        if session.is_ahead() {
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
            "customerId": customer_id, "techId": tech_id, "managerId": manager_id, "isBlock": is_block,
            "startsAt": to_iso_string(starts_at), "durationMinutes": duration,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    let row = load_appointment(&state.db, &appointment_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "appointment": appointment_json(&row, staff) })),
    )
        .into_response())
}

pub async fn update_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_user: AuthUser,
    Path(appointment_id): Path<String>,
    Json(payload): Json<AppointmentPayload>,
) -> Result<Response, ApiError> {
    let staff = is_staff(&auth_user.role);
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let current = sqlx::query_as::<_, StoredAppointment>(
        r#"SELECT a."customerId" as customer_id, a."managerId" as manager_id, c.name as customer_name, a."isBlock" as is_block,
            a."techId" as tech_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, r.id as room_id, r."ownerId" as room_owner_id,
            NOT r."isEnded" as room_is_live
        FROM "Appointment" a LEFT JOIN "Customer" c ON c.id = a."customerId"
        LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"
        WHERE a.id = $1 FOR UPDATE OF a"#,
    )
    .bind(&appointment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load session"))?
    .filter(|row| staff || own_block(row, &auth_user.id))
    .ok_or_else(|| ApiError::not_found("Appointment not found"))?;

    let customer_id = match payload.customer_id {
        Some(value) => value.filter(|id| !id.is_empty()),
        None => current.customer_id.clone(),
    };
    let tech_id = if staff {
        payload.tech_id.unwrap_or_else(|| current.tech_id.clone())
    } else {
        current.tech_id.clone()
    };
    let manager_id = match payload.manager_id.filter(|_| staff && !current.is_block) {
        Some(value) => value.filter(|id| !id.is_empty()),
        None => current.manager_id.clone(),
    };
    if current.is_block && (tech_id.is_none() || customer_id.is_some()) {
        return Err(ApiError::bad_request("Busy time belongs to a tech and has no customer"));
    }
    let starts_at = match payload.starts_at.as_deref() {
        Some(value) => parse_start(Some(value))?,
        None => current.starts_at,
    };
    let duration = check_duration(payload.duration_minutes.unwrap_or(current.duration_minutes))?;
    let company = match payload.company.filter(|_| !current.is_block) {
        Some(value) => clean_field(value, "Company is too long")?,
        None => current.company.clone(),
    };
    let position = match payload.position.filter(|_| !current.is_block) {
        Some(value) => clean_field(value, "Position is too long")?,
        None => current.position.clone(),
    };
    let notes = match payload.notes {
        Some(value) => clean_text(value, MAX_NOTES_CHARS, "Notes are too long")?,
        None => current.notes.clone(),
    };

    let customer_name = match customer_id.as_deref() {
        Some(_) if customer_id == current.customer_id => current.customer_name.clone(),
        Some(id) => Some(active_customer(&mut tx, id).await?),
        None => None,
    };
    let tech_changed = tech_id != current.tech_id;
    if let Some(tech) = tech_id.as_deref().filter(|_| tech_changed) {
        check_assignee(&mut tx, tech).await?;
    }
    let manager_changed = manager_id != current.manager_id;
    if let Some(manager) = manager_id.as_deref().filter(|_| manager_changed) {
        check_manager(&mut tx, manager).await?;
    }
    let time_changed = starts_at != current.starts_at || duration != current.duration_minutes;
    let changes: Vec<&str> = [
        ("customer", customer_id != current.customer_id),
        ("tech", tech_changed),
        ("manager", manager_changed),
        ("time", starts_at != current.starts_at),
        ("duration", duration != current.duration_minutes),
        ("company", company != current.company),
        ("position", position != current.position),
        ("notes", notes != current.notes),
    ]
    .into_iter()
    .filter_map(|(field, changed)| changed.then_some(field))
    .collect();
    if changes.is_empty() {
        // Saving an unchanged form writes, notifies and records nothing.
        drop(tx);
        let row = load_appointment(&state.db, &appointment_id).await?;
        return Ok(Json(json!({ "appointment": appointment_json(&row, staff) })).into_response());
    }
    // Edits that cannot create an overlap, like notes, never trip a conflict saved on purpose.
    let may_overlap = tech_changed || time_changed;
    if let Some(tech) = tech_id.as_deref().filter(|_| may_overlap) {
        lock_tech_schedule(&mut tx, tech).await?;
        if !(current.is_block || (staff && payload.allow_conflicts)) {
            let conflicts =
                find_conflicts(&mut tx, tech, starts_at, duration, Some(&appointment_id)).await?;
            if !conflicts.is_empty() {
                return Ok(conflict_response(&conflicts));
            }
        }
    }

    sqlx::query(
        r#"UPDATE "Appointment" SET "customerId" = $2, "techId" = $3, "startsAt" = $4,
            "durationMinutes" = $5, company = $6, position = $7, notes = $8, "managerId" = $9,
            "updatedAt" = NOW()
        WHERE id = $1"#,
    )
    .bind(&appointment_id)
    .bind(&customer_id)
    .bind(&tech_id)
    .bind(starts_at)
    .bind(duration)
    .bind(&company)
    .bind(&position)
    .bind(&notes)
    .bind(&manager_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to update session"))?;

    // A live room follows its session: the time and role, the name made of them
    // unless it was renamed by hand, and its new tech as owner.
    if let (Some(room_id), Some(true)) = (current.room_id.as_deref(), current.room_is_live) {
        if time_changed || company != current.company || position != current.position {
            sqlx::query(
                r#"UPDATE "Room" SET "scheduledTime" = $2, duration = $3, company = $4, position = $5,
                    name = CASE WHEN name = $6 THEN $7 ELSE name END, "updatedAt" = NOW()
                WHERE id = $1"#,
            )
            .bind(room_id)
            .bind(starts_at)
            .bind(duration)
            .bind(&company)
            .bind(&position)
            .bind(room_name(current.company.as_deref(), current.position.as_deref()))
            .bind(room_name(company.as_deref(), position.as_deref()))
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
            }
        }
    }

    let before = Notice {
        appointment_id: &appointment_id,
        customer_name: current.customer_name.as_deref(),
        starts_at: current.starts_at,
        duration: current.duration_minutes,
        company: current.company.as_deref(),
        position: current.position.as_deref(),
    };
    let after = Notice {
        appointment_id: &appointment_id,
        customer_name: customer_name.as_deref(),
        starts_at,
        duration,
        company: company.as_deref(),
        position: position.as_deref(),
    };
    // Busy time is the tech's own business: nobody is told about it.
    let mine = |tech: &str| tech == auth_user.id || current.is_block;
    if tech_changed {
        if let Some(old) = current.tech_id.as_deref().filter(|t| !mine(t)) {
            if before.is_ahead() {
                before.send(&mut tx, old, &auth_user.id, NoticeKind::Unassigned, None).await?;
            }
        }
        if let Some(new) = tech_id.as_deref().filter(|t| !mine(t)) {
            if after.is_ahead() {
                after.send(&mut tx, new, &auth_user.id, NoticeKind::Assigned, None).await?;
            }
        }
    } else if let Some(tech) = tech_id.as_deref().filter(|t| !mine(t)) {
        // A new 管理 alone is nothing the tech needs to hear about.
        if (after.is_ahead() || before.is_ahead()) && changes.iter().any(|change| *change != "manager") {
            let previous = json!({
                "previousStartsAt": to_iso_string(current.starts_at),
                "previousDurationMinutes": current.duration_minutes,
                "changes": changes,
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
            "startsAt": to_iso_string(starts_at), "durationMinutes": duration,
            "allowConflicts": payload.allow_conflicts,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    let row = load_appointment(&state.db, &appointment_id).await?;
    Ok(Json(json!({ "appointment": appointment_json(&row, staff) })).into_response())
}

/// Busy time on the caller's own table.
fn own_block(row: &StoredAppointment, user_id: &str) -> bool {
    row.is_block && row.tech_id.as_deref() == Some(user_id)
}

/// Deletes a session planned by mistake or called off; its room, if any, stays
/// as it is. A tech losing a session still to come is told it was cancelled.
pub async fn delete_appointment(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_user: AuthUser,
    Path(appointment_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let staff = is_staff(&auth_user.role);
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    // Techs delete only their own busy time.
    let current = sqlx::query_as::<_, StoredAppointment>(
        r#"DELETE FROM "Appointment" a
        WHERE a.id = $1 AND ($2 OR (a."isBlock" AND a."techId" = $3))
        RETURNING a."customerId" as customer_id, a."managerId" as manager_id,
            (SELECT c.name FROM "Customer" c WHERE c.id = a."customerId") as customer_name,
            a."isBlock" as is_block, a."techId" as tech_id,
            a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, a."roomId" as room_id,
            NULL::text as room_owner_id, NULL::boolean as room_is_live"#,
    )
    .bind(&appointment_id)
    .bind(staff)
    .bind(&auth_user.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to delete session"))?
    .ok_or_else(|| ApiError::not_found("Appointment not found"))?;

    let session = Notice {
        appointment_id: &appointment_id,
        customer_name: current.customer_name.as_deref(),
        starts_at: current.starts_at,
        duration: current.duration_minutes,
        company: current.company.as_deref(),
        position: current.position.as_deref(),
    };
    if let Some(tech) = current.tech_id.as_deref().filter(|t| *t != auth_user.id && !current.is_block) {
        if session.is_ahead() {
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
            "startsAt": to_iso_string(current.starts_at),
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
        r#"SELECT a."customerId" as customer_id, a."managerId" as manager_id, c.name as customer_name, a."isBlock" as is_block,
            a."techId" as tech_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, r.id as room_id, r."ownerId" as room_owner_id,
            NOT r."isEnded" as room_is_live
        FROM "Appointment" a LEFT JOIN "Customer" c ON c.id = a."customerId"
        LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"
        WHERE a.id = $1 FOR UPDATE OF a"#,
    )
    .bind(&appointment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to load session"))?
    .filter(|row| !row.is_block && (staff || row.tech_id.as_deref() == Some(auth_user.id.as_str())))
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
    let tech_is_active = match current.tech_id.as_deref() {
        Some(tech) => is_active_user(&mut tx, tech).await?,
        None => false,
    };
    let owner_id = match current.tech_id.as_deref() {
        Some(tech) if tech_is_active => tech.to_string(),
        _ if staff => auth_user.id.clone(),
        _ => return Err(ApiError::not_found("Appointment not found")),
    };
    let name = room_name(current.company.as_deref(), current.position.as_deref());
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
    // A session whose room ended reads as scheduled again with the new one.
    sqlx::query(r#"UPDATE "Appointment" SET "roomId" = $2, "updatedAt" = NOW() WHERE id = $1"#)
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

/// Sessions and busy time on one tech's table, for its link: who booked (the
/// 管理), when, company, position and notes. Never the customer.
pub(super) async fn table_link_sessions(
    db: &sqlx::PgPool,
    tech_id: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Value>, ApiError> {
    let from = parse_time(from, "A valid range start is required")?;
    let to = parse_time(to, "A valid range end is required")?;
    if to <= from || to - from > Duration::days(MAX_RANGE_DAYS) {
        return Err(ApiError::bad_request("The range must be between 1 minute and 100 days"));
    }
    let rows = sqlx::query_as::<_, AppointmentRow>(&format!(
        r#"{APPOINTMENT_SELECT}
        WHERE a."techId" = $3 AND a."startsAt" < $2 AND a."startsAt" > $1 - INTERVAL '1 day'
          AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $1
        ORDER BY a."startsAt", a.id LIMIT 2000"#
    ))
    .bind(from)
    .bind(to)
    .bind(tech_id)
    .fetch_all(db)
    .await
    .map_err(|err| db_error(err, "Failed to load sessions"))?;
    Ok(rows
        .iter()
        .map(|row| {
            let agent = (!row.is_block).then(|| manager_json(row));
            json!({
                "id": row.id,
                "startsAt": to_iso_string(row.starts_at),
                "endsAt": to_iso_string(ends_at(row.starts_at, row.duration_minutes)),
                "durationMinutes": row.duration_minutes,
                "company": row.company,
                "position": row.position,
                "notes": row.notes,
                "isBlock": row.is_block,
                "status": row.status,
                "customer": null,
                "tech": row.tech_id.as_ref().map(|id| json!({
                    "id": id, "username": row.tech_username, "name": row.tech_name.as_ref().or(row.tech_username.as_ref()), "color": row.tech_color,
                    "role": row.tech_role, "isDeleted": row.tech_is_deleted.unwrap_or(false),
                })),
                "room": null,
                "hasConflict": row.has_conflict,
                "manager": agent,
                "createdBy": agent,
                "createdAt": to_iso_string(row.created_at),
                "updatedAt": to_iso_string(row.updated_at),
            })
        })
        .collect())
}

pub(super) fn appointment_json(row: &AppointmentRow, staff: bool) -> Value {
    let customer = row.customer_id.as_ref().map(|id| {
        let mut customer = json!({
            "id": id,
            "name": row.customer_name,
            "isDeleted": row.customer_is_deleted.unwrap_or(false),
            // The agent the customer belongs to.
            "owner": { "id": row.owner_id, "username": row.owner_username, "color": row.owner_color },
        });
        // The profile stays with agents: techs meet customers through the session's
        // room, and the session's own notes are the ones written for its tech.
        if staff {
            customer["contact"] = json!(row.customer_contact);
            customer["notes"] = json!(row.customer_notes);
        }
        customer
    });
    json!({
        "id": row.id,
        "startsAt": to_iso_string(row.starts_at),
        "endsAt": to_iso_string(ends_at(row.starts_at, row.duration_minutes)),
        "durationMinutes": row.duration_minutes,
        "company": row.company,
        "position": row.position,
        "notes": row.notes,
        "isBlock": row.is_block,
        "status": row.status,
        "customer": customer,
        "tech": row.tech_id.as_ref().map(|id| json!({
            "id": id,
            "username": row.tech_username,
            "name": row.tech_name.as_ref().or(row.tech_username.as_ref()),
            "color": row.tech_color,
            "role": row.tech_role,
            "isDeleted": row.tech_is_deleted.unwrap_or(false),
        })),
        "room": row.room_id.as_ref().map(|id| json!({
            "id": id,
            "name": row.room_name,
            "language": row.room_language,
            "isEnded": row.room_is_ended.unwrap_or(false),
            "endedAt": to_iso_string_opt(row.room_ended_at),
        })),
        "hasConflict": row.has_conflict,
        "manager": (!row.is_block).then(|| manager_json(row)),
        "createdBy": { "id": row.created_by_id, "username": row.created_by_username, "color": row.created_by_color },
        "createdAt": to_iso_string(row.created_at),
        "updatedAt": to_iso_string(row.updated_at),
    })
}

/// The 管理 a session belongs to: the one chosen, else its customer's agent, else its planner.
fn manager_json(row: &AppointmentRow) -> Value {
    json!({ "id": row.manager_id, "username": row.manager_username, "name": row.manager_name, "color": row.manager_color })
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

/// A session's 管理 is an agent or admin with an account.
async fn check_manager(tx: &mut sqlx::PgConnection, user_id: &str) -> Result<(), ApiError> {
    match account_role(tx, user_id).await?.as_deref() {
        Some(role) if is_staff(role) => Ok(()),
        _ => Err(ApiError::bad_request("Invalid manager")),
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
            c.name as customer_name, COALESCE(re.name, mg.username) as manager_username, a."isBlock" as is_block
        FROM "Appointment" a LEFT JOIN "Customer" c ON c.id = a."customerId"
        JOIN "User" mg ON mg.id = COALESCE(a."managerId", c."createdBy", a."createdBy")
        LEFT JOIN "RosterEntry" re ON re.kind = 'manager' AND re."userId" = mg.id
        WHERE a."techId" = $1 AND ($4::text IS NULL OR a.id <> $4)
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
                "customer": conflict.customer_name.as_ref().map(|name| json!({ "name": name })),
                "manager": { "username": conflict.manager_username },
                "createdBy": { "username": conflict.manager_username },
                "isBlock": conflict.is_block,
            })
        })
        .collect::<Vec<_>>();
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "Schedule conflict", "conflicts": conflicts })),
    )
        .into_response()
}

/// The new tech owns the room; the previous owner stays a member of it.
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
        // The previous tech keeps the room: they still edit it while it is live
        // and can replay it after it ends. No share link backs this membership,
        // so removing a link they once joined through does not take it away.
        sqlx::query(
            r#"INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit", "canReplay") VALUES ($1, $2, $3, true, true)
            ON CONFLICT ("roomId", "userId") DO UPDATE SET "canEdit" = true, "canReplay" = true, "shareLinkId" = NULL"#,
        )
        .bind(Uuid::new_v4().to_string())
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
    customer_name: Option<&'a str>,
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
        let title = match (self.customer_name, self.company, self.position) {
            (Some(name), _, _) => name.to_string(),
            (None, company, position) => room_name(company, position),
        };
        let content = format!(
            "{} · {} · {} min",
            title,
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

fn clean_field(value: Option<String>, too_long: &'static str) -> Result<Option<String>, ApiError> {
    clean_text(value, MAX_FIELD_CHARS, too_long)
}

/// "Company Position", kept within the room name limit. The customer's name
/// stays out of it.
fn room_name(company: Option<&str>, position: Option<&str>) -> String {
    let name = [company, position]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return UNNAMED_ROOM.to_string();
    }
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
    fn durations_are_bounded() {
        assert!(check_duration(4).is_err() && check_duration(1441).is_err());
        assert_eq!(check_duration(5).unwrap(), 5);
        assert_eq!(check_duration(1440).unwrap(), 1440);
    }

    #[test]
    fn room_names_are_company_and_position_without_the_customer() {
        assert_eq!(room_name(Some("字节"), Some("后端")), "字节 后端");
        assert_eq!(room_name(None, Some("后端")), "后端");
        assert_eq!(room_name(Some("字节"), None), "字节");
        assert_eq!(room_name(None, None), UNNAMED_ROOM);
        let long = "长".repeat(200);
        assert_eq!(room_name(Some(&long), None).chars().count(), MAX_ROOM_NAME_CHARS);
    }

    #[test]
    fn only_unfinished_sessions_are_announced() {
        let notice = |starts_at, duration| Notice {
            appointment_id: "a",
            customer_name: Some("c"),
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
