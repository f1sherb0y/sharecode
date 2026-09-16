//! Each room has one independent durable writer. Live updates are broadcast
//! immediately; acknowledgements and barriers follow a committed log prefix.
use super::{
    protocol::{encode_message, encode_stateless_message, MSG_SYNC_STATUS},
    state::{ConnectionId, DocumentState, WsError},
    transport::Outbound,
};
use axum::extract::ws::Message;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, QueryBuilder};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use uuid::Uuid;
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

pub(crate) const MAX_PENDING_UPDATES: usize = 2048;
pub(crate) const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
const BATCH_WINDOW: Duration = Duration::from_millis(20);
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(5);

pub(crate) struct PendingUpdate {
    id: String,
    update: Option<Vec<u8>>,
    actor: Option<String>,
    connection: ConnectionId,
    timestamp: DateTime<Utc>,
    outgoing: Outbound,
    barrier: Option<String>,
}
impl PendingUpdate {
    pub fn edit(
        update: Vec<u8>,
        actor: Option<String>,
        connection: ConnectionId,
        outgoing: Outbound,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            update: Some(update),
            actor,
            connection,
            timestamp: Utc::now(),
            outgoing,
            barrier: None,
        }
    }
    pub fn barrier(id: String, connection: ConnectionId, outgoing: Outbound) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            update: None,
            actor: None,
            connection,
            timestamp: Utc::now(),
            outgoing,
            barrier: Some(id),
        }
    }
}

pub(crate) fn spawn_writer(
    db: PgPool,
    name: String,
    live: Arc<DocumentState>,
    durable: Doc,
    mut seq: i64,
    mut rx: mpsc::Receiver<PendingUpdate>,
) {
    tokio::spawn(async move {
        let mut last_snapshot = Instant::now();
        let mut dirty = false;
        loop {
            let first = match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Some(first)) => first,
                Ok(None) => return,
                Err(_) => {
                    if dirty && last_snapshot.elapsed() >= SNAPSHOT_INTERVAL {
                        if save_snapshot(&db, &name, &durable, seq).await.is_ok() {
                            dirty = false;
                        }
                        last_snapshot = Instant::now();
                    }
                    // There are no accepted updates in flight when the queue is
                    // empty. A failed snapshot is safe: the committed log remains.
                    if live.retire_if_idle(&live).await {
                        return;
                    }
                    continue;
                }
            };
            let mut batch = vec![first];
            let deadline = tokio::time::Instant::now() + BATCH_WINDOW;
            let mut bytes = batch[0].update.as_ref().map_or(0, Vec::len);
            while batch.len() < 128 && bytes < 256 * 1024 {
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(Some(entry)) => {
                        bytes += entry.update.as_ref().map_or(0, Vec::len);
                        batch.push(entry);
                    }
                    _ => break,
                }
            }
            let started = Instant::now();
            let mut retry = Duration::from_millis(100);
            let committed_seq = loop {
                match commit_batch(&db, &name, &batch).await {
                    Ok(committed) => break committed,
                    Err(error) => {
                        tracing::error!(room_id = %name, %error, pending_bytes = live.pending_bytes.load(Ordering::Acquire), "room log commit failed; retrying retained batch");
                        live.storage_failed.store(true, Ordering::Release);
                        live.send_persistence_status(&name, true).await;
                        tokio::time::sleep(retry).await;
                        retry = (retry * 2).min(Duration::from_secs(3));
                    }
                }
            };
            seq = seq.max(committed_seq);
            for entry in &batch {
                if let Some(update) = &entry.update {
                    // Already validated by the live document. Only the durable
                    // clone is used for checkpoints, never the live dirty state.
                    if let Err(error) =
                        Update::decode_v1(update)
                            .map_err(WsError::Decode)
                            .and_then(|u| {
                                durable
                                    .transact_mut()
                                    .apply_update(u)
                                    .map_err(WsError::Apply)
                            })
                    {
                        tracing::error!(room_id = %name, %error, "durable reconstruction failed");
                        live.storage_failed.store(true, Ordering::Release);
                        return; // no acknowledgements; log and client outbox survive
                    }
                    dirty = true;
                }
            }
            live.pending_bytes.fetch_sub(bytes, Ordering::AcqRel);
            live.pending_count.fetch_sub(batch.len(), Ordering::AcqRel);
            live.durable_seq.store(seq as u64, Ordering::Release);
            live.storage_failed.store(false, Ordering::Release);
            for entry in &batch {
                if !live.has_connection(entry.connection).await {
                    continue;
                }
                let message = if let Some(id) = &entry.barrier {
                    encode_stateless_message(
                        &name,
                        &serde_json::json!({"type":"durability-ack", "id":id, "durableSeq":seq})
                            .to_string(),
                    )
                } else {
                    encode_message(&name, MSG_SYNC_STATUS, &[1])
                };
                let _ = entry.outgoing.send(Message::Binary(message.into()));
            }
            live.send_persistence_status(&name, false).await;
            tracing::debug!(room_id = %name, updates = batch.len(), bytes, elapsed_ms = started.elapsed().as_millis(), seq, "room log committed");
            if dirty && last_snapshot.elapsed() >= SNAPSHOT_INTERVAL {
                if let Err(error) = save_snapshot(&db, &name, &durable, seq).await {
                    tracing::warn!(room_id = %name, %error, "checkpoint failed; retaining log");
                } else {
                    dirty = false;
                }
                last_snapshot = Instant::now();
            }
        }
    });
}

async fn commit_batch(
    db: &PgPool,
    name: &str,
    batch: &[PendingUpdate],
) -> Result<i64, sqlx::Error> {
    let edits: Vec<_> = batch
        .iter()
        .filter(|entry| entry.update.is_some())
        .collect();
    if edits.is_empty() {
        return Ok(0);
    }
    let mut tx = db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    // A saved acknowledgement means WAL is durable even if a database default
    // was changed. This is not a claim of surviving loss of the whole host.
    sqlx::query("SET LOCAL synchronous_commit = on")
        .execute(&mut *tx)
        .await?;
    let mut query: QueryBuilder<Postgres> = QueryBuilder::new(
        r#"INSERT INTO "DocumentUpdate" (id,"documentId",update,"userId",timestamp,"connectionId") "#,
    );
    query.push_values(&edits, |mut row, entry| {
        row.push_bind(&entry.id)
            .push_bind(name)
            .push_bind(entry.update.as_ref().unwrap())
            .push_bind(&entry.actor)
            .push_bind(entry.timestamp)
            .push_bind(entry.connection.to_string());
    });
    // Reusing event IDs makes a retry safe when the COMMIT response was lost.
    query
        .push(" ON CONFLICT (id) DO NOTHING")
        .build()
        .execute(&mut *tx)
        .await?;
    let ids: Vec<_> = edits.iter().map(|e| e.id.clone()).collect();
    let seq: i64 =
        sqlx::query_scalar(r#"SELECT MAX(seq) FROM "DocumentUpdate" WHERE id = ANY($1)"#)
            .bind(ids)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        r#"UPDATE "Room" SET "updatedAt"=NOW() WHERE id=$1 AND NOT "isEnded" AND NOT "isDeleted""#,
    )
    .bind(name)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(seq)
}

async fn save_snapshot(db: &PgPool, name: &str, doc: &Doc, seq: i64) -> Result<(), sqlx::Error> {
    let state = {
        let txn = doc.transact();
        // Missing dependencies must stay in the replay tail, not get skipped by
        // a checkpoint that cannot represent them.
        if txn.has_missing_updates() {
            return Ok(());
        }
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    let mut tx = db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"INSERT INTO "Document" (id,name,data,"checkpointSeq","updatedAt") VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data, "checkpointSeq"=EXCLUDED."checkpointSeq", "updatedAt"=NOW()
        WHERE "Document"."checkpointSeq" <= EXCLUDED."checkpointSeq""#)
        .bind(Uuid::new_v4().to_string()).bind(name).bind(state).bind(seq).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
