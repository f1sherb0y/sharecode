use super::{
    persistence::{PendingUpdate, MAX_PENDING_BYTES},
    transport::Outbound,
};
use axum::extract::ws::{Message, WebSocket};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use yrs::{
    sync::{awareness::AwarenessUpdate, protocol::SyncMessage},
    updates::decoder::{Decode, DecoderV1},
    updates::encoder::Encode,
    ReadTxn, StateVector, Transact, Update,
};

use crate::{state::AppState, utils::time::to_iso_string};

use super::{
    auth::authenticate,
    protocol::{
        decode_auth, decode_frame, decode_var_bytes, encode_auth_message, encode_message,
        encode_stateless_message, encode_sync_message, encode_sync_update, encode_var_bytes,
        AUTH_AUTHENTICATED, AUTH_PERMISSION_DENIED, AUTH_TOKEN, MSG_AUTH, MSG_AWARENESS, MSG_CLOSE,
        MSG_QUERY_AWARENESS, MSG_STATELESS, MSG_SYNC, MSG_SYNC_STATUS,
    },
    state::{ConnectionId, DocumentState, SessionState, WsError},
};

pub(crate) async fn handle_socket(socket: WebSocket, state: AppState) {
    let connection_id = state.ws.next_connection_id();
    tracing::info!(connection_id, "ws connection opened");
    let (sender, mut receiver) = socket.split();
    let (outgoing_tx, mut outgoing_rx, mut close_rx) = Outbound::channel();
    let mut write_task = tokio::spawn(async move {
        let mut sender = sender;
        loop {
            tokio::select! {
                biased;
                _ = close_rx.changed() => {
                    let reason = (*close_rx.borrow()).unwrap_or("Connection closed");
                    let close = axum::extract::ws::CloseFrame { code: 4403, reason: reason.into() };
                    let _ = tokio::time::timeout(Duration::from_secs(1), sender.send(Message::Close(Some(close)))).await;
                    break;
                }
                frame = outgoing_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    let closing = matches!(frame.message, Message::Close(_));
                    let sent = tokio::select! {
                        biased;
                        _ = close_rx.changed() => false,
                        result = tokio::time::timeout(Duration::from_secs(5), sender.send(frame.message.clone())) =>
                            result.is_ok_and(|result| result.is_ok()),
                    };
                    if !sent || closing { break; }
                }
            }
        }
    });

    let mut sessions: std::collections::HashMap<String, SessionState> =
        std::collections::HashMap::new();

    let mut last_pong = std::time::Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    loop {
        let result = tokio::select! {
            result = receiver.next() => match result { Some(result) => result, None => break },
            _ = &mut write_task => break,
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) { break; }
                let _ = outgoing_tx.send(Message::Ping(Vec::new().into()));
                if sessions.values().any(|s| s.authenticated && s.expires_at <= Utc::now().timestamp()) {
                    break;
                }
                // Browser JS cannot observe WebSocket ping/pong. Send an
                // application frame so the provider's watchdog sees activity.
                for (name, session) in &sessions {
                    if let Some(doc) = &session.document { doc.send_presence(name, &outgoing_tx).await; }
                    let message = encode_stateless_message(name, r#"{"type":"heartbeat"}"#);
                    let _ = outgoing_tx.send(Message::Binary(message.into()));
                }
                continue;
            }
        };
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
            Message::Pong(_) => {
                last_pong = std::time::Instant::now();
            }
            Message::Text(_) => {}
        }
    }

    cleanup_connection(&state, connection_id, sessions).await;
    tracing::info!(connection_id, "ws connection closed");
    drop(outgoing_tx);
    write_task.abort();
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
    outgoing: &Outbound,
    sessions: &mut std::collections::HashMap<String, SessionState>,
    data: &[u8],
) -> Result<(), WsError> {
    let (document_name, message_type, payload) = match decode_frame(data) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                connection_id,
                data_len = data.len(),
                error = %err,
                "ws frame decode failed"
            );
            return Err(err);
        }
    };
    let _access = state.ws.access.read().await;
    if !sessions.contains_key(&document_name) && sessions.len() >= 8 {
        return Err(WsError::Backpressure);
    }
    let session = sessions
        .entry(document_name.clone())
        .or_insert_with(SessionState::new);

    if message_type != MSG_AUTH && session.authenticated {
        if session.expires_at <= Utc::now().timestamp()
            || !match session.document.as_ref() {
                Some(doc) => doc.has_connection(connection_id).await,
                None => false,
            }
        {
            session.authenticated = false;
            send_auth_denied(outgoing, &document_name, "Access revoked or expired");
            let _ = outgoing.send(Message::Close(None));
            return Ok(());
        }
    }

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
    outgoing: &Outbound,
    session: &mut SessionState,
    document_name: &str,
    payload: &[u8],
) -> Result<(), WsError> {
    let (auth_type, token) = decode_auth(payload)?;
    // One authentication per document/connection. Rejected reauthentication
    // must not keep a connection registered under a different identity.
    if session.document.is_some() {
        session.authenticated = false;
        send_auth_denied(outgoing, document_name, "Reconnect to authenticate again");
        let _ = outgoing.send(Message::Close(None));
        return Ok(());
    }
    session.authenticated = false;
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

            session.expires_at = outcome.expires_at;
            let (doc_state, session_color) = state
                .ws
                .attach_document(
                    &state.db,
                    document_name,
                    connection_id,
                    outgoing.clone(),
                    outcome.actor_id,
                    outcome.share_link_id,
                    outcome.username,
                )
                .await?;
            tracing::info!(connection_id, document_name, actor_id = ?session.actor_id, read_only = session.read_only, "ws authenticated");
            session.document = Some(std::sync::Arc::clone(&doc_state));
            session.session_color = Some(session_color.clone());

            let scope = if outcome.read_only {
                "readonly"
            } else {
                "read-write"
            };
            let auth_reply = encode_auth_message(document_name, AUTH_AUTHENTICATED, Some(scope));
            let _ = outgoing.send(Message::Binary(auth_reply.into()));
            send_session_color(outgoing, document_name, &session_color);

            if let Some(pending_sv) = session.pending_sync_step1.take() {
                send_sync_step2(outgoing, &doc_state, document_name, pending_sv).await;
            }

            send_sync_step1(outgoing, &doc_state, document_name).await;
            send_awareness_snapshot(outgoing, &doc_state, document_name)?;
            doc_state
                .send_persistence_status(document_name, false)
                .await;
            doc_state.broadcast_presence(document_name).await;
            // Refresh the setting after reconnect, even for read-only clients.
            let language: Option<String> = sqlx::query_scalar(r#"SELECT language FROM "Room" WHERE id = $1"#)
                .bind(document_name).fetch_optional(&state.db).await?;
            if let Some(language) = language {
                let message = super::protocol::encode_stateless_message(document_name,
                    &serde_json::json!({"type":"room-language", "language":language}).to_string());
                let _ = outgoing.send(Message::Binary(message.into()));
            }
        }
        Err(reason) => {
            send_auth_denied(outgoing, document_name, &reason);
            let _ = outgoing.send(Message::Close(None));
        }
    }

    Ok(())
}

async fn handle_sync(
    state: &AppState,
    connection_id: ConnectionId,
    outgoing: &Outbound,
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
            send_sync_step2(outgoing, &doc_state, document_name, state_vector).await;
            send_sync_step1(outgoing, &doc_state, document_name).await;
        }
        SyncMessage::SyncStep2(update) => {
            if session.read_only {
                let _ = outgoing.send(Message::Binary(
                    encode_message(document_name, MSG_SYNC_STATUS, &[1]).into(),
                ));
                return Ok(());
            }
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
    _state: &AppState,
    connection_id: ConnectionId,
    _outgoing: &Outbound,
    session: &SessionState,
    document_name: &str,
    doc_state: Arc<DocumentState>,
    update: Vec<u8>,
) -> Result<(), WsError> {
    let _update_guard = doc_state.update_lock.lock().await;
    let parsed = Update::decode_v1(&update)?;
    if !parsed.is_empty() && (session.read_only || doc_state.is_ended()) {
        send_auth_denied(_outgoing, document_name, "Document is read-only");
        return Ok(());
    }
    // Reserve capacity before applying anything. Never silently discard an
    // accepted edit, and never wait for database I/O under the room gate.
    if doc_state.pending_bytes.load(Ordering::Acquire) + update.len() > MAX_PENDING_BYTES {
        return Err(WsError::Backpressure);
    }
    let permit = doc_state
        .persistence
        .try_reserve()
        .map_err(|_| WsError::Backpressure)?;
    doc_state
        .awareness
        .doc()
        .transact_mut()
        .apply_update(parsed)?;
    doc_state
        .pending_bytes
        .fetch_add(update.len(), Ordering::AcqRel);
    doc_state.pending_count.fetch_add(1, Ordering::AcqRel);
    permit.send(PendingUpdate::edit(
        update.clone(),
        session.actor_id.clone(),
        connection_id,
        _outgoing.clone(),
    ));
    doc_state
        .broadcast(
            encode_sync_update(document_name, &update),
            Some(connection_id),
        )
        .await;
    doc_state
        .send_persistence_status(document_name, false)
        .await;
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
    outgoing: &Outbound,
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
    outgoing: &Outbound,
    doc_state: &Arc<DocumentState>,
    document_name: &str,
) -> Result<(), WsError> {
    let awareness_update = doc_state.awareness.update().map_err(WsError::Awareness)?;
    let payload = encode_var_bytes(&awareness_update.encode_v1());
    let message = encode_message(document_name, MSG_AWARENESS, &payload);
    let _ = outgoing.send(Message::Binary(message.into()));
    Ok(())
}

fn send_session_color(
    outgoing: &Outbound,
    document_name: &str,
    session_color: &crate::utils::colors::SessionColor,
) {
    let payload = serde_json::json!({
        "type": "session-color",
        "slot": session_color.slot,
        "color": session_color.color,
        "colorLight": session_color.color_light,
    })
    .to_string();
    let message = encode_stateless_message(document_name, &payload);
    let _ = outgoing.send(Message::Binary(message.into()));
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

    use yrs::encoding::read::{Cursor, Read};
    let mut cursor = Cursor::new(payload);
    let text = cursor.read_string()?;
    let Ok(message) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(());
    };
    if message.get("type").and_then(|v| v.as_str()) == Some("presence") {
        if let Some(client) = message
            .get("clientId")
            .and_then(|v| v.as_u64())
            .filter(|id| *id <= u32::MAX as u64)
        {
            doc_state
                .register_presence(document_name, connection_id, client)
                .await;
        }
    }
    if message.get("type").and_then(|v| v.as_str()) == Some("durability-barrier") {
        let Some(id) = message
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|id| id.len() <= 100)
        else {
            return Ok(());
        };
        let _guard = doc_state.update_lock.lock().await;
        let permit = doc_state
            .persistence
            .try_reserve()
            .map_err(|_| WsError::Backpressure)?;
        if let Some(outgoing) = doc_state.connection_sender(connection_id).await {
            doc_state.pending_count.fetch_add(1, Ordering::AcqRel);
            permit.send(PendingUpdate::barrier(
                id.to_string(),
                connection_id,
                outgoing,
            ));
        }
    }

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

        state
            .ws
            .detach_document(&document_name, connection_id, &doc_state)
            .await;
    }
}

fn send_auth_denied(outgoing: &Outbound, document_name: &str, reason: &str) {
    let message = encode_auth_message(document_name, AUTH_PERMISSION_DENIED, Some(reason));
    let _ = outgoing.send(Message::Binary(message.into()));
}

async fn send_sync_step1(outgoing: &Outbound, doc_state: &DocumentState, document_name: &str) {
    let _guard = doc_state.update_lock.lock().await;
    let state_vector = doc_state.awareness.doc().transact().state_vector();
    let message = encode_sync_message(document_name, SyncMessage::SyncStep1(state_vector));
    let _ = outgoing.send(Message::Binary(message.into()));
}

async fn send_sync_step2(
    outgoing: &Outbound,
    doc_state: &DocumentState,
    document_name: &str,
    state_vector: StateVector,
) {
    let _guard = doc_state.update_lock.lock().await;
    let update = doc_state
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&state_vector);
    let message = encode_sync_message(document_name, SyncMessage::SyncStep2(update));
    let _ = outgoing.send(Message::Binary(message.into()));
}
