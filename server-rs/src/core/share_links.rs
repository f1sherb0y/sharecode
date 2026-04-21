use std::time::Duration;

use sqlx::PgPool;
use tokio::time::{interval, MissedTickBehavior};

pub const GUEST_SHARE_TTL_HOURS: i64 = 6;
const EXPIRED_SHARE_LINK_CLEANUP_INTERVAL: Duration = Duration::from_secs(300);

pub fn spawn_expired_share_link_cleanup(db: PgPool) {
    tokio::spawn(async move {
        tracing::info!(
            interval_seconds = EXPIRED_SHARE_LINK_CLEANUP_INTERVAL.as_secs(),
            share_ttl_hours = GUEST_SHARE_TTL_HOURS,
            "expired share link cleanup task started"
        );

        tracing::info!(trigger = "startup", "running expired share link cleanup");
        if let Err(err) = cleanup_expired_share_links(&db).await {
            tracing::error!(error = %err, "failed to clean up expired share links on startup");
        }

        let mut ticker = interval(EXPIRED_SHARE_LINK_CLEANUP_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        ticker.tick().await;

        loop {
            ticker.tick().await;

            tracing::info!(trigger = "interval", "running expired share link cleanup");
            match cleanup_expired_share_links(&db).await {
                Ok(count) => {
                    tracing::info!(trigger = "interval", deleted = count, "expired share link cleanup completed")
                }
                Err(err) => tracing::error!(error = %err, "failed to clean up expired share links"),
            }
        }
    });
}

pub async fn cleanup_expired_share_links(db: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM "RoomShareLink"
        WHERE "consumedAt" IS NULL
          AND "expiresAt" <= NOW()
        "#,
    )
    .execute(db)
    .await?;

    let deleted = result.rows_affected();
    tracing::debug!(deleted = deleted, "expired share link cleanup database delete executed");

    Ok(deleted)
}
