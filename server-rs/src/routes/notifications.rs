use crate::core::audit::{self, ClientInfo};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::QueryBuilder;
use uuid::Uuid;

use crate::{
    auth::{AdminUser, AuthUser},
    db::db_error,
    error::ApiError,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNotificationPayload {
    pub title: Option<String>,
    pub content: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MarkNotificationsReadPayload {
    pub ids: Vec<String>,
}

// Announcements have no recipient and reach everyone; personal notices, such as
// a tech's new session, carry a kind and data for the client to render.
const VISIBLE_TO_USER_SQL: &str = r#"(n."recipientId" IS NULL OR n."recipientId" = $1)"#;

#[derive(Debug, sqlx::FromRow)]
struct NotificationWithReadRow {
    id: String,
    title: String,
    content: String,
    severity: String,
    kind: Option<String>,
    data: Option<Value>,
    created_by: String,
    created_at: DateTime<Utc>,
    created_by_username: String,
    read_at: Option<DateTime<Utc>>,
}

/// Records a personal notice in the caller's transaction.
pub(crate) async fn notify(
    tx: &mut sqlx::PgConnection,
    recipient_id: &str,
    actor_id: &str,
    kind: &str,
    title: &str,
    content: &str,
    data: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"INSERT INTO "Notification" (id, title, content, severity, "createdBy", "recipientId", kind, data)
        VALUES ($1, $2, $3, 'normal', $4, $5, $6, $7)"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(title)
    .bind(content)
    .bind(actor_id)
    .bind(recipient_id)
    .bind(kind)
    .bind(data)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create notification"))?;
    Ok(())
}

pub async fn create_notification(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(auth_user): AdminUser,
    Json(payload): Json<CreateNotificationPayload>,
) -> Result<impl IntoResponse, ApiError> {

    let title = payload.title.unwrap_or_default().trim().to_string();
    let content = payload.content.unwrap_or_default().trim().to_string();
    let severity = payload
        .severity
        .unwrap_or_else(|| "normal".to_string())
        .to_lowercase();

    if title.is_empty() || content.is_empty() {
        return Err(ApiError::bad_request("Title and content are required"));
    }

    if !matches!(severity.as_str(), "normal" | "emergency") {
        return Err(ApiError::bad_request("Invalid notification severity"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let row = sqlx::query_as::<_, NotificationWithReadRow>(
        r#"
        INSERT INTO "Notification" (id, title, content, severity, "createdBy")
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            title,
            content,
            severity,
            kind,
            data,
            "createdBy" as created_by,
            "createdAt" as created_at,
            (SELECT username FROM "User" WHERE id = "createdBy") as created_by_username,
            NULL::TIMESTAMPTZ as read_at
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&title)
    .bind(&content)
    .bind(&severity)
    .bind(&auth_user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create notification"))?;

    audit::record_details(
        &mut *tx,
        &client,
        "notification.created",
        Some(&auth_user.id),
        Some(&auth_user.username),
        Some(&row.id),
        true,
        None,
        None,
        json!({"severity":severity}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    tracing::info!(
        actor_id = %auth_user.id,
        actor_role = %auth_user.role,
        notification_id = %row.id,
        severity = %row.severity,
        title = %row.title,
        "notification created"
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({ "notification": notification_to_json(&row) })),
    ))
}

pub async fn list_notifications(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let notifications = sqlx::query_as::<_, NotificationWithReadRow>(&format!(
        r#"
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n.kind,
            n.data,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            nr."readAt" as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE {VISIBLE_TO_USER_SQL}
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        "#
    ))
    .bind(&auth_user.id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load notifications"))?;

    Ok(Json(json!({
        "notifications": notifications
            .iter()
            .map(notification_to_json)
            .collect::<Vec<_>>()
    })))
}

pub async fn list_unread_notifications(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let notifications = sqlx::query_as::<_, NotificationWithReadRow>(&format!(
        r#"
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n.kind,
            n.data,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            NULL::TIMESTAMPTZ as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL AND {VISIBLE_TO_USER_SQL}
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        "#
    ))
    .bind(&auth_user.id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load unread notifications"))?;

    Ok(Json(json!({
        "notifications": notifications
            .iter()
            .map(notification_to_json)
            .collect::<Vec<_>>()
    })))
}

pub async fn mark_all_notifications_read(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    mark_read(&state, &auth_user, None).await
}

/// Marks the given notices read, such as one the user acknowledged in a toast.
pub async fn mark_notifications_read(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(payload): Json<MarkNotificationsReadPayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if payload.ids.is_empty() || payload.ids.len() > 100 {
        return Err(ApiError::bad_request("Between 1 and 100 notification IDs are required"));
    }
    mark_read(&state, &auth_user, Some(&payload.ids)).await
}

async fn mark_read(
    state: &AppState,
    auth_user: &AuthUser,
    only: Option<&[String]>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let unread_ids = sqlx::query_scalar::<_, String>(&format!(
        r#"
        SELECT n.id
        FROM "Notification" n
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL AND {VISIBLE_TO_USER_SQL}
          AND ($2::text[] IS NULL OR n.id = ANY($2))
        "#
    ))
    .bind(&auth_user.id)
    .bind(only)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load unread notifications"))?;

    if unread_ids.is_empty() {
        return Ok(Json(json!({ "markedCount": 0 })));
    }

    let mut builder = QueryBuilder::new(
        r#"INSERT INTO "NotificationRead" (id, "notificationId", "userId", "readAt") "#,
    );
    builder.push_values(unread_ids.iter(), |mut row, notification_id| {
        row.push_bind(Uuid::new_v4().to_string())
            .push_bind(notification_id)
            .push_bind(&auth_user.id)
            .push_bind(Utc::now());
    });
    builder.push(r#" ON CONFLICT ("notificationId", "userId") DO NOTHING"#);

    let result = builder
        .build()
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to mark notifications as read"))?;

    let marked_count = result.rows_affected();
    tracing::info!(
        actor_id = %auth_user.id,
        username = %auth_user.username,
        marked_count,
        "notifications marked as read"
    );

    Ok(Json(json!({ "markedCount": marked_count })))
}

fn notification_to_json(row: &NotificationWithReadRow) -> serde_json::Value {
    json!({
        "id": row.id,
        "title": row.title,
        "content": row.content,
        "severity": row.severity,
        "kind": row.kind,
        "data": row.data,
        "createdAt": to_iso_string(row.created_at),
        "isRead": row.read_at.is_some(),
        "readAt": to_iso_string_opt(row.read_at),
        "createdBy": {
            "id": row.created_by,
            "username": row.created_by_username,
        }
    })
}
