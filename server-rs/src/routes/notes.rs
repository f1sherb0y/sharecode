use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::AuthUser, db::db_error, error::ApiError, models::RoomNoteRow,
    permissions::has_global_read, state::AppState, utils::time::to_iso_string,
};

#[derive(Debug, sqlx::FromRow)]
struct RoomOwnerRow {
    owner_id: String,
}

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
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if !can_manage_notes(&auth_user, &room.owner_id) {
        return Err(ApiError::not_found("Room not found"));
    }

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
    auth_user: AuthUser,
    Path(room_id): Path<String>,
    Json(payload): Json<CreateNotePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if !can_manage_notes(&auth_user, &room.owner_id) {
        return Err(ApiError::not_found("Room not found"));
    }

    let text = payload.text.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::bad_request("Note text is required"));
    }

    let note_id = Uuid::new_v4().to_string();
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
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to create note"))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "note": note_to_json(&note) })),
    ))
}

pub async fn update_note(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((room_id, note_id)): Path<(String, String)>,
    Json(payload): Json<UpdateNotePayload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if !can_manage_notes(&auth_user, &room.owner_id) {
        return Err(ApiError::not_found("Room not found"));
    }

    let text = payload.text.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::bad_request("Note text is required"));
    }

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
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to update note"))?;

    let note = match note {
        Some(note) => note,
        None => return Err(ApiError::not_found("Note not found")),
    };

    Ok(Json(json!({ "note": note_to_json(&note) })))
}

pub async fn delete_note(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((room_id, note_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = sqlx::query_as::<_, RoomOwnerRow>(
        r#"
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        "#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load room"))?;

    let room = match room {
        Some(room) => room,
        None => return Err(ApiError::not_found("Room not found")),
    };

    if !can_manage_notes(&auth_user, &room.owner_id) {
        return Err(ApiError::not_found("Room not found"));
    }

    let result = sqlx::query(r#"DELETE FROM "RoomNote" WHERE id = $1 AND "roomId" = $2"#)
        .bind(&note_id)
        .bind(&room_id)
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to delete note"))?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("Note not found"));
    }

    Ok(Json(json!({ "message": "Note deleted" })))
}

fn can_manage_notes(auth_user: &AuthUser, owner_id: &str) -> bool {
    auth_user.id == owner_id
        || auth_user.role == "admin"
        || auth_user.role == "superuser"
        || has_global_read(auth_user)
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
