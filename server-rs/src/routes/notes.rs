use crate::core::audit::{self, ClientInfo};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::AuthActor, db::db_error, error::ApiError, models::RoomNoteRow,
    permissions::require_content_access, state::AppState, utils::time::to_iso_string,
};

#[derive(Debug, Deserialize)]
pub struct CreateNotePayload {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateNotePayload {
    pub text: String,
}

pub async fn list_notes(
    State(state): State<AppState>,
    auth_actor: AuthActor,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _access = state.ws.access.read().await;
    require_content_access(&state.db, &auth_actor, &room_id).await?;

    let notes = sqlx::query_as::<_, RoomNoteRow>(
        r#"
        SELECT
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        FROM "RoomNote"
        WHERE "roomId" = $1
        ORDER BY "createdAt" ASC
        "#,
    )
    .bind(&room_id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load notes"))?;

    let response: Vec<serde_json::Value> = notes.into_iter().map(|n| note_to_json(&n)).collect();

    Ok(Json(json!({ "notes": response })))
}

pub async fn create_note(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_actor: AuthActor,
    Path(room_id): Path<String>,
    Json(payload): Json<CreateNotePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let _access = state.ws.access.read().await;
    let can_write = require_content_access(&state.db, &auth_actor, &room_id).await?;

    if !can_write {
        return Err(ApiError::not_found("Room not found"));
    }

    let text = payload.text.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::bad_request("Note text is required"));
    }

    let note_id = Uuid::new_v4().to_string();
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let note = sqlx::query_as::<_, RoomNoteRow>(
        r#"
        INSERT INTO "RoomNote" (id, "roomId", text)
        VALUES ($1, $2, $3)
        RETURNING
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        "#,
    )
    .bind(&note_id)
    .bind(&room_id)
    .bind(&text)
    .fetch_one(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create note"))?;

    audit::record_details(
        &mut *tx,
        &client,
        "note.created",
        Some(auth_actor.id()),
        Some(auth_actor.username()),
        Some(&note_id),
        true,
        None,
        Some(&room_id),
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "note": note_to_json(&note) })),
    ))
}

pub async fn update_note(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_actor: AuthActor,
    Path((room_id, note_id)): Path<(String, String)>,
    Json(payload): Json<UpdateNotePayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _access = state.ws.access.read().await;
    let can_write = require_content_access(&state.db, &auth_actor, &room_id).await?;

    if !can_write {
        return Err(ApiError::not_found("Room not found"));
    }

    let text = payload.text.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::bad_request("Note text is required"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let note = sqlx::query_as::<_, RoomNoteRow>(
        r#"
        UPDATE "RoomNote"
        SET text = $3, "updatedAt" = NOW()
        WHERE id = $2 AND "roomId" = $1
        RETURNING
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        "#,
    )
    .bind(&room_id)
    .bind(&note_id)
    .bind(&text)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to update note"))?;

    let note = match note {
        Some(note) => note,
        None => return Err(ApiError::not_found("Note not found")),
    };

    audit::record_details(
        &mut *tx,
        &client,
        "note.updated",
        Some(auth_actor.id()),
        Some(auth_actor.username()),
        Some(&note_id),
        true,
        None,
        Some(&room_id),
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "note": note_to_json(&note) })))
}

pub async fn delete_note(
    State(state): State<AppState>,
    client: ClientInfo,
    auth_actor: AuthActor,
    Path((room_id, note_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _access = state.ws.access.read().await;
    let can_write = require_content_access(&state.db, &auth_actor, &room_id).await?;

    if !can_write {
        return Err(ApiError::not_found("Room not found"));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let result = sqlx::query(r#"DELETE FROM "RoomNote" WHERE id = $1 AND "roomId" = $2"#)
        .bind(&note_id)
        .bind(&room_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| db_error(err, "Failed to delete note"))?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("Note not found"));
    }

    audit::record_details(
        &mut *tx,
        &client,
        "note.deleted",
        Some(auth_actor.id()),
        Some(auth_actor.username()),
        Some(&note_id),
        true,
        None,
        Some(&room_id),
        json!({}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "message": "Note deleted" })))
}

fn note_to_json(note: &RoomNoteRow) -> serde_json::Value {
    json!({
        "id": note.id,
        "roomId": note.room_id,
        "text": note.text,
        "createdAt": to_iso_string(note.created_at),
        "updatedAt": to_iso_string(note.updated_at),
    })
}
