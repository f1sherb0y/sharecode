use axum::extract::ws::{Message, WebSocket};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use hex::encode as hex_encode;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;
// use yrs::encoding::write::Write as _;
use yrs::{
    merge_updates_v1,
    sync::{awareness::AwarenessUpdate, protocol::SyncMessage},
    updates::decoder::{Decode, DecoderV1},
    updates::encoder::Encode,
    ReadTxn, StateVector, Transact, Update,
};

use crate::{room_activity, state::AppState, utils::time::to_iso_string};

use super::{
    auth::authenticate,
    protocol::{
        decode_auth, decode_frame, decode_var_bytes, encode_auth_message, encode_message,
        encode_stateless_message, encode_sync_message, encode_sync_update, encode_var_bytes,
        AUTH_AUTHENTICATED, AUTH_PERMISSION_DENIED, AUTH_TOKEN, MSG_AUTH, MSG_AWARENESS, MSG_CLOSE,
        MSG_QUERY_AWARENESS, MSG_STATELESS, MSG_SYNC, MSG_SYNC_STATUS,
    },
    state::{ConnectionId, DocumentState, PendingUpdate, SessionState, WsError},
};

pub(crate) async fn handle_socket(socket: WebSocket, state: AppState) {
    let connection_id = state.ws.next_connection_id();
    tracing::info!(connection_id, "ws connection opened");
    let (sender, mut receiver) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<Message>();

    let write_task = tokio::spawn(async move {
        let mut sender = sender;
        while let Some(message) = outgoing_rx.recv().await {
            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut sessions: std::collections::HashMap<String, SessionState> =
        std::collections::HashMap::new();

    while let Some(result) = receiver.next().await {
        let message = match result {
            Ok(message) => message,
            Err(_) => break,
        };

        match message {
            Message::Binary(data) => {
                if let Err(err) =
                    handle_binary_message(&state, connection_id, &outgoing_tx, &mut sessions, &data)
                        .await
                {
                    tracing::error!(error = %err, "ws message handling failed");
                    break;
                }
            }
            Message::Ping(payload) => {
                let _ = outgoing_tx.send(Message::Pong(payload));
            }
            Message::Close(_) => break,
            Message::Text(_) | Message::Pong(_) => {}
        }
    }

    cleanup_connection(&state, connection_id, sessions).await;
    tracing::info!(connection_id, "ws connection closed");
    drop(outgoing_tx);
    let _ = write_task.await;
}

pub async fn broadcast_room_ended(state: &AppState, room_id: &str, ended_at: DateTime<Utc>) {
    let Some(doc_state) = state.ws.get_document(room_id).await else {
        return;
    };

    doc_state.mark_ended();

    let payload = serde_json::json!({
        "type": "room-status",
        "status": "ended",
        "endedAt": to_iso_string(ended_at),
    })
    .to_string();

    let message = encode_stateless_message(room_id, &payload);
    doc_state.broadcast(message, None).await;
}

async fn handle_binary_message(
    state: &AppState,
    connection_id: ConnectionId,
    outgoing: &mpsc::UnboundedSender<Message>,
    sessions: &mut std::collections::HashMap<String, SessionState>,
    data: &[u8],
) -> Result<(), WsError> {
    let (document_name, message_type, payload) = match decode_frame(data) {
        Ok(parsed) => parsed,
        Err(err) => {
            let prefix_len = data.len().min(64);
            let prefix_hex = hex_encode(&data[..prefix_len]);
            tracing::warn!(
                connection_id,
                data_len = data.len(),
                prefix_hex = %prefix_hex,
                error = %err,
                "ws frame decode failed"
            );
            return Err(err);
        }
    };
    let session = sessions
        .entry(document_name.clone())
        .or_insert_with(SessionState::new);

    match message_type {
        MSG_AUTH => {
            handle_auth(
                state,
                connection_id,
                outgoing,
                session,
                &document_name,
                payload,
            )
            .await?;
        }
        MSG_SYNC => {
            handle_sync(
                state,
                connection_id,
                outgoing,
                session,
                &document_name,
                payload,
            )
            .await?;
        }
        MSG_AWARENESS => {
            handle_awareness(connection_id, session, &document_name, payload).await?;
        }
        MSG_QUERY_AWARENESS => {
            handle_query_awareness(outgoing, session, &document_name).await?;
        }
        MSG_STATELESS => {
            handle_stateless(session, &document_name, payload, connection_id).await?;
        }
        MSG_CLOSE => {
            let _ = outgoing.send(Message::Close(None));
        }
        MSG_SYNC_STATUS => {}
        _ => {}
    }

    Ok(())
}

async fn handle_auth(
    state: &AppState,
    connection_id: ConnectionId,
    outgoing: &mpsc::UnboundedSender<Message>,
    session: &mut SessionState,
    document_name: &str,
    payload: &[u8],
) -> Result<(), WsError> {
    let (auth_type, token) = decode_auth(payload)?;
    if auth_type != AUTH_TOKEN {
        return Ok(());
    }

    let token = match token {
        Some(token) => token,
        None => {
            send_auth_denied(
                outgoing,
                document_name,
                "Authentication failed: No authentication token provided",
            );
            return Ok(());
        }
    };

    match authenticate(state, document_name, &token).await {
        Ok(outcome) => {
            session.authenticated = true;
            session.read_only = outcome.read_only;
            session.actor_id = outcome.actor_id.clone();

            let doc_state = state
                .ws
                .get_or_create_document(&state.db, document_name)
                .await?;
            doc_state
                .add_connection(connection_id, outgoing.clone())
                .await;
            session.document = Some(std::sync::Arc::clone(&doc_state));

            let scope = if outcome.read_only {
                "readonly"
            } else {
                "read-write"
            };
            let auth_reply = encode_auth_message(document_name, AUTH_AUTHENTICATED, Some(scope));
            let _ = outgoing.send(Message::Binary(auth_reply.into()));

            if let Some(pending_sv) = session.pending_sync_step1.take() {
                send_sync_step2(outgoing, &doc_state, document_name, pending_sv);
            }

            send_sync_step1(outgoing, &doc_state, document_name);
            send_awareness_snapshot(outgoing, &doc_state, document_name)?;
        }
        Err(reason) => {
            send_auth_denied(outgoing, document_name, &reason);
        }
    }

    Ok(())
}

async fn handle_sync(
    state: &AppState,
    connection_id: ConnectionId,
    outgoing: &mpsc::UnboundedSender<Message>,
    session: &mut SessionState,
    document_name: &str,
    payload: &[u8],
) -> Result<(), WsError> {
    let mut decoder = DecoderV1::from(payload);
    let sync_message = SyncMessage::decode(&mut decoder).map_err(WsError::Decode)?;

    if !session.authenticated {
        if let SyncMessage::SyncStep1(state_vector) = sync_message {
            session.pending_sync_step1 = Some(state_vector);
        }
        return Ok(());
    }

    let Some(doc_state) = session.document.as_ref() else {
        return Ok(());
    };
    let doc_state = Arc::clone(doc_state);

    match sync_message {
        SyncMessage::SyncStep1(state_vector) => {
            send_sync_step2(outgoing, &doc_state, document_name, state_vector);
            send_sync_step1(outgoing, &doc_state, document_name);
        }
        SyncMessage::SyncStep2(update) => {
            handle_update_message(
                state,
                connection_id,
                outgoing,
                session,
                document_name,
                Arc::clone(&doc_state),
                update,
            )
            .await?;
        }
        SyncMessage::Update(update) => {
            handle_update_message(
                state,
                connection_id,
                outgoing,
                session,
                document_name,
                Arc::clone(&doc_state),
                update,
            )
            .await?;
        }
    }

    Ok(())
}

async fn handle_update_message(
    state: &AppState,
    connection_id: ConnectionId,
    _outgoing: &mpsc::UnboundedSender<Message>,
    session: &SessionState,
    document_name: &str,
    doc_state: Arc<DocumentState>,
    update: Vec<u8>,
) -> Result<(), WsError> {
    let parsed = Update::decode_v1(&update).map_err(WsError::Decode)?;
    let is_empty = parsed.is_empty();

    if session.read_only || doc_state.is_ended() {
        return Ok(());
    }

    let mut txn = doc_state.awareness.doc().transact_mut();
    if txn.apply_update(parsed).is_err() {
        return Ok(());
    }
    // Drop the write transaction before any awaits to avoid blocking other doc access.
    drop(txn);

    if !is_empty {
        let update_message = encode_sync_update(document_name, &update);
        doc_state
            .broadcast(update_message, Some(connection_id))
            .await;
    }

    if !is_empty {
        let actor_id = session.actor_id.clone();
        doc_state
            .queue_update(
                state.db.clone(),
                document_name.to_string(),
                update,
                actor_id,
            )
            .await;
        doc_state
            .schedule_snapshot(state.db.clone(), document_name.to_string())
            .await;
    }

    Ok(())
}

async fn handle_awareness(
    connection_id: ConnectionId,
    session: &mut SessionState,
    document_name: &str,
    payload: &[u8],
) -> Result<(), WsError> {
    if !session.authenticated {
        return Ok(());
    }

    let Some(doc_state) = session.document.as_ref() else {
        return Ok(());
    };

    let update_bytes = decode_var_bytes(payload)?;
    let update = AwarenessUpdate::decode_v1(&update_bytes).map_err(WsError::Decode)?;
    for client_id in update.clients.keys() {
        session.awareness_clients.insert(*client_id);
    }
    doc_state
        .awareness
        .apply_update(update)
        .map_err(WsError::Awareness)?;

    let payload = encode_var_bytes(&update_bytes);
    let awareness_message = encode_message(document_name, MSG_AWARENESS, &payload);
    doc_state
        .broadcast(awareness_message, Some(connection_id))
        .await;
    Ok(())
}

async fn handle_query_awareness(
    outgoing: &mpsc::UnboundedSender<Message>,
    session: &SessionState,
    document_name: &str,
) -> Result<(), WsError> {
    if !session.authenticated {
        return Ok(());
    }

    let Some(doc_state) = session.document.as_ref() else {
        return Ok(());
    };

    send_awareness_snapshot(outgoing, doc_state, document_name)?;
    Ok(())
}

fn send_awareness_snapshot(
    outgoing: &mpsc::UnboundedSender<Message>,
    doc_state: &Arc<DocumentState>,
    document_name: &str,
) -> Result<(), WsError> {
    let awareness_update = doc_state.awareness.update().map_err(WsError::Awareness)?;
    let payload = encode_var_bytes(&awareness_update.encode_v1());
    let message = encode_message(document_name, MSG_AWARENESS, &payload);
    let _ = outgoing.send(Message::Binary(message.into()));
    Ok(())
}

async fn handle_stateless(
    session: &SessionState,
    document_name: &str,
    payload: &[u8],
    connection_id: ConnectionId,
) -> Result<(), WsError> {
    if !session.authenticated {
        return Ok(());
    }

    let Some(doc_state) = session.document.as_ref() else {
        return Ok(());
    };

    let message = encode_message(document_name, MSG_STATELESS, payload);
    doc_state.broadcast(message, Some(connection_id)).await;
    Ok(())
}

async fn cleanup_connection(
    state: &AppState,
    connection_id: ConnectionId,
    sessions: std::collections::HashMap<String, SessionState>,
) {
    for (document_name, session) in sessions {
        let Some(doc_state) = session.document else {
            continue;
        };

        let empty = doc_state.remove_connection(connection_id).await;

        if !session.awareness_clients.is_empty() {
            for client_id in session.awareness_clients.iter() {
                doc_state.awareness.remove_state(*client_id);
            }
            if let Ok(update) = doc_state
                .awareness
                .update_with_clients(session.awareness_clients.iter().copied())
            {
                let payload = encode_var_bytes(&update.encode_v1());
                let message = encode_message(&document_name, MSG_AWARENESS, &payload);
                doc_state.broadcast(message, None).await;
            }
        }

        if empty {
            state.ws.remove_document(&document_name).await;
        }
    }
}

async fn store_update(
    db: &PgPool,
    document_name: &str,
    update: &[u8],
    actor_id: Option<&str>,
) -> Result<(), WsError> {
    let update_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO "DocumentUpdate" (id, "documentId", update, "userId")
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(update_id)
    .bind(document_name)
    .bind(update)
    .bind(actor_id)
    .execute(db)
    .await
    .map_err(WsError::Db)?;

    room_activity::touch_room_activity(db, document_name)
        .await
        .map_err(WsError::Db)?;

    Ok(())
}

async fn flush_pending_updates(
    db: &PgPool,
    document_name: &str,
    pending: Vec<PendingUpdate>,
) -> Result<(), WsError> {
    if pending.is_empty() {
        return Ok(());
    }

    if pending.len() == 1 {
        let entry = pending.into_iter().next().unwrap();
        return store_update(db, document_name, &entry.update, entry.actor_id.as_deref()).await;
    }

    let mut actor_id: Option<String> = None;
    let mut mixed_actor = false;
    for entry in pending.iter() {
        match (actor_id.as_deref(), entry.actor_id.as_deref()) {
            (None, Some(id)) => actor_id = Some(id.to_string()),
            (Some(existing), Some(id)) if existing == id => {}
            (None, None) => {}
            _ => {
                mixed_actor = true;
                break;
            }
        }
    }
    if mixed_actor {
        actor_id = None;
    }

    match merge_updates_v1(pending.iter().map(|entry| entry.update.as_slice())) {
        Ok(merged) => store_update(db, document_name, &merged, actor_id.as_deref()).await,
        Err(err) => {
            tracing::error!(
                document_name = %document_name,
                error = %err,
                "ws update merge failed; falling back to individual inserts"
            );
            for entry in pending {
                store_update(db, document_name, &entry.update, entry.actor_id.as_deref()).await?;
            }
            Ok(())
        }
    }
}

async fn store_document_state(
    db: &PgPool,
    document_name: &str,
    doc_state: &DocumentState,
) -> Result<(), WsError> {
    let document_id = Uuid::new_v4().to_string();
    let state = doc_state
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    sqlx::query(
        r#"
        INSERT INTO "Document" (id, name, data, "updatedAt")
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (name)
        DO UPDATE SET data = EXCLUDED.data, "updatedAt" = NOW()
        "#,
    )
    .bind(document_id)
    .bind(document_name)
    .bind(state)
    .execute(db)
    .await
    .map_err(WsError::Db)?;

    Ok(())
}

impl DocumentState {
    pub(crate) async fn schedule_snapshot(self: &Arc<Self>, db: PgPool, document_name: String) {
        let snapshot = Arc::clone(&self.snapshot);
        let doc_state = Arc::clone(self);

        let mut guard = snapshot.lock().await;
        guard.last_update = std::time::Instant::now();
        if guard.running {
            return;
        }
        guard.running = true;
        drop(guard);

        tokio::spawn(async move {
            let debounce = Duration::from_secs(1);
            loop {
                let elapsed = snapshot.lock().await.last_update.elapsed();
                if elapsed < debounce {
                    tokio::time::sleep(debounce - elapsed).await;
                    continue;
                }

                if let Err(err) = store_document_state(&db, &document_name, &doc_state).await {
                    tracing::error!(
                        document_name = %document_name,
                        error = %err,
                        "ws document state persist failed"
                    );
                }

                let mut guard = snapshot.lock().await;
                if guard.last_update.elapsed() >= debounce {
                    guard.running = false;
                    return;
                }
            }
        });
    }

    pub(crate) async fn queue_update(
        self: &Arc<Self>,
        db: PgPool,
        document_name: String,
        update: Vec<u8>,
        actor_id: Option<String>,
    ) {
        let batch = Arc::clone(&self.update_batch);
        {
            let mut guard = batch.lock().await;
            guard.pending.push(PendingUpdate { update, actor_id });
            guard.last_update = Instant::now();
            if guard.running {
                return;
            }
            guard.running = true;
        }

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(1));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let pending = {
                    let mut guard = batch.lock().await;
                    if guard.pending.is_empty() {
                        if guard.last_update.elapsed() >= Duration::from_secs(1) {
                            guard.running = false;
                            return;
                        }
                        Vec::new()
                    } else {
                        std::mem::take(&mut guard.pending)
                    }
                };

                if pending.is_empty() {
                    continue;
                }

                if let Err(err) = flush_pending_updates(&db, &document_name, pending).await {
                    tracing::error!(
                        document_name = %document_name,
                        error = %err,
                        "ws document update batch persist failed"
                    );
                }
            }
        });
    }
}

fn send_auth_denied(outgoing: &mpsc::UnboundedSender<Message>, document_name: &str, reason: &str) {
    let message = encode_auth_message(document_name, AUTH_PERMISSION_DENIED, Some(reason));
    let _ = outgoing.send(Message::Binary(message.into()));
}

fn send_sync_step1(
    outgoing: &mpsc::UnboundedSender<Message>,
    doc_state: &DocumentState,
    document_name: &str,
) {
    let state_vector = doc_state.awareness.doc().transact().state_vector();
    let message = encode_sync_message(document_name, SyncMessage::SyncStep1(state_vector));
    let _ = outgoing.send(Message::Binary(message.into()));
}

fn send_sync_step2(
    outgoing: &mpsc::UnboundedSender<Message>,
    doc_state: &DocumentState,
    document_name: &str,
    state_vector: StateVector,
) {
    let update = doc_state
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&state_vector);
    let message = encode_sync_message(document_name, SyncMessage::SyncStep2(update));
    let _ = outgoing.send(Message::Binary(message.into()));
}
