use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tokio::time::{interval, MissedTickBehavior};

use crate::{state::AppState, ws};

pub const ROOM_INACTIVITY_TIMEOUT_HOURS: i32 = 6;
const INACTIVE_ROOM_CLEANUP_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug, sqlx::FromRow)]
struct AutoEndedRoomRow {
    id: String,
    ended_at: DateTime<Utc>,
}

pub fn spawn_inactive_room_cleanup(state: AppState) {
    tokio::spawn(async move {
        if let Err(err) = auto_end_inactive_rooms(&state).await {
            tracing::error!(error = %err, "failed to auto-end inactive rooms on startup");
        }

        let mut ticker = interval(INACTIVE_ROOM_CLEANUP_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        ticker.tick().await;

        loop {
            ticker.tick().await;

            match auto_end_inactive_rooms(&state).await {
                Ok(0) => {}
                Ok(count) => {
                    tracing::info!(ended = count, "auto-ended inactive unpinned rooms")
                }
                Err(err) => tracing::error!(error = %err, "failed to auto-end inactive rooms"),
            }
        }
    });
}

pub async fn auto_end_inactive_rooms(state: &AppState) -> Result<u64, sqlx::Error> {
    let ended_rooms = sqlx::query_as::<_, AutoEndedRoomRow>(
        r#"
        UPDATE "Room"
        SET "isEnded" = true,
            "endedAt" = NOW(),
            "updatedAt" = NOW()
        WHERE "isDeleted" = false
          AND "isEnded" = false
          AND "isPinned" = false
          AND "updatedAt" <= NOW() - ($1 * INTERVAL '1 hour')
        RETURNING id, "endedAt" as ended_at
        "#,
    )
    .bind(ROOM_INACTIVITY_TIMEOUT_HOURS)
    .fetch_all(&state.db)
    .await?;

    for room in &ended_rooms {
        ws::broadcast_room_ended(state, &room.id, room.ended_at).await;
    }

    Ok(ended_rooms.len() as u64)
}

pub async fn touch_room_activity(db: &PgPool, room_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE "Room"
        SET "updatedAt" = NOW()
        WHERE id = $1
          AND "isDeleted" = false
          AND "isEnded" = false
        "#,
    )
    .bind(room_id)
    .execute(db)
    .await?;

    Ok(())
}
