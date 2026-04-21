use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
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

#[derive(Debug, sqlx::FromRow)]
struct NotificationWithReadRow {
    id: String,
    title: String,
    content: String,
    severity: String,
    created_by: String,
    created_at: DateTime<Utc>,
    created_by_username: String,
    read_at: Option<DateTime<Utc>>,
}

pub async fn create_notification(
    State(state): State<AppState>,
    AdminUser(auth_user): AdminUser,
    Json(payload): Json<CreateNotificationPayload>,
) -> Result<impl IntoResponse, ApiError> {
    if auth_user.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }

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

    let row = sqlx::query_as::<_, NotificationWithReadRow>(
        r#"
        INSERT INTO "Notification" (id, title, content, severity, "createdBy")
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            title,
            content,
            severity,
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
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create notification"))?;

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
    let notifications = sqlx::query_as::<_, NotificationWithReadRow>(
        r#"
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            nr."readAt" as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        "#,
    )
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
    let notifications = sqlx::query_as::<_, NotificationWithReadRow>(
        r#"
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            NULL::TIMESTAMPTZ as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        "#,
    )
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
    let unread_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT n.id
        FROM "Notification" n
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL
        "#,
    )
    .bind(&auth_user.id)
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
        "createdAt": to_iso_string(row.created_at),
        "isRead": row.read_at.is_some(),
        "readAt": to_iso_string_opt(row.read_at),
        "createdBy": {
            "id": row.created_by,
            "username": row.created_by_username,
        }
    })
}
