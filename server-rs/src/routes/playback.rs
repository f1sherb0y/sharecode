use axum::extract::{Path, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::{write::GzEncoder, Compression};
use serde_json::json;
use std::io::Write;

use crate::{
    auth::AuthUser,
    db::db_error,
    error::ApiError,
    models::DocumentUpdateRow,
    permissions::require_room_access,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

pub async fn get_playback_updates(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let room = require_room_access(&state.db, &auth_user, &room_id).await?;
    if !room.can_view_playback {
        return Err(ApiError::not_found("Room not found"));
    }
    if !room.is_ended {
        return Err(ApiError::bad_request("Room has not ended yet"));
    }

    state.ws.wait_for_saved(&room_id).await?;
    let updates = sqlx::query_as::<_, DocumentUpdateRow>(
        r#"
        SELECT
            id,
            "documentId" as document_id,
            update,
            timestamp,
            "userId" as user_id
        FROM "DocumentUpdate"
        WHERE "documentId" = $1
        ORDER BY timestamp ASC, seq ASC
        "#,
    )
    .bind(&room_id)
    .fetch_all(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to load playback updates"))?;

    if updates.is_empty() {
        return Ok(Json(json!({
            "updates": [],
            "startTime": null,
            "endTime": null,
            "duration": 0,
        })));
    }

    let start_time = updates.first().map(|u| u.timestamp).unwrap();
    let end_time = updates.last().map(|u| u.timestamp).unwrap();
    let duration = (end_time - start_time).num_milliseconds() as f64 / 1000.0;

    let mut compressed_updates = Vec::with_capacity(updates.len());
    for update in updates {
        let compressed = gzip_bytes(&update.update)
            .map_err(|err| ApiError::internal(format!("Failed to compress update: {err}")))?;
        let encoded = BASE64_STANDARD.encode(compressed);
        compressed_updates.push(json!({
            "id": update.id,
            "timestamp": to_iso_string(update.timestamp),
            "update": encoded,
            "userId": update.user_id,
        }));
    }

    Ok(Json(json!({
        "updates": compressed_updates,
        "startTime": to_iso_string_opt(Some(start_time)),
        "endTime": to_iso_string_opt(Some(end_time)),
        "duration": duration,
    })))
}

fn gzip_bytes(input: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(input)?;
    encoder.finish()
}
