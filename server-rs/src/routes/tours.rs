use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};

use crate::{auth::AuthUser, db::db_error, error::ApiError, state::AppState};

// Guided tours the client knows. An account sees each one once: finishing or
// skipping it marks it seen for every device.
const TOURS: &[&str] = &["schedule"];

pub async fn list_seen_tours(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let seen: Vec<String> = sqlx::query_scalar(r#"SELECT "seenTours" FROM "User" WHERE id = $1"#)
        .bind(&auth_user.id)
        .fetch_one(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to load tours"))?;
    Ok(Json(json!({ "seen": seen })))
}

pub async fn mark_tour_seen(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(tour): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !TOURS.contains(&tour.as_str()) {
        return Err(ApiError::not_found("Tour not found"));
    }
    let seen: Vec<String> = sqlx::query_scalar(
        r#"UPDATE "User" SET "seenTours" = CASE WHEN $2 = ANY("seenTours") THEN "seenTours"
            ELSE array_append("seenTours", $2) END
        WHERE id = $1 RETURNING "seenTours""#,
    )
    .bind(&auth_user.id)
    .bind(&tour)
    .fetch_one(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to save tour"))?;
    Ok(Json(json!({ "seen": seen })))
}
