use axum::extract::ws::Message;
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Weak,
    },
};
use tokio::sync::{mpsc, Mutex, RwLock};
use yrs::updates::decoder::Decode;
use yrs::{sync::Awareness, Doc, OffsetKind, Options, Transact, Update};

pub(crate) fn new_document() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}
use super::{
    persistence::{PendingUpdate, MAX_PENDING_UPDATES},
    transport::Outbound,
};
type DocumentSlot = Mutex<Option<Arc<DocumentState>>>;

use crate::utils::colors::{next_available_color_slot, session_color_for_slot, SessionColor};

pub(crate) type ConnectionId = u64;

pub struct WsState {
    documents: RwLock<HashMap<String, Arc<DocumentSlot>>>,
    next_connection_id: AtomicU64,
    // Serializes authorization changes with authentication and incoming frames.
    pub access: RwLock<()>,
}

impl WsState {
    pub fn new() -> Self {
        Self {
            documents: RwLock::new(HashMap::new()),
            next_connection_id: AtomicU64::new(1),
            access: RwLock::new(()),
        }
    }

    pub(crate) fn next_connection_id(&self) -> ConnectionId {
        self.next_connection_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) async fn get_document(&self, name: &str) -> Option<Arc<DocumentState>> {
        let slot = self.documents.read().await.get(name).cloned()?;
        let doc = slot.lock().await.clone();
        doc
    }

    pub(crate) async fn attach_document(
        &self,
        db: &PgPool,
        name: &str,
        id: ConnectionId,
        sender: Outbound,
        actor_id: Option<String>,
        share_link_id: Option<String>,
        username: String,
    ) -> Result<(Arc<DocumentState>, SessionColor), WsError> {
        let slot = {
            let mut docs = self.documents.write().await;
            docs.retain(|_, slot| {
                Arc::strong_count(slot) > 1 || slot.try_lock().map_or(true, |value| value.is_some())
            });
            docs.entry(name.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        // Only this room waits for loading. The registry lock never spans I/O.
        let mut guard = slot.lock().await;
        if guard.is_none() {
            let (tx, rx) = mpsc::channel(MAX_PENDING_UPDATES);
            let (mut loaded, durable, seq) = DocumentState::load(db, name, tx).await?;
            loaded.slot = Arc::downgrade(&slot);
            let doc = Arc::new(loaded);
            super::persistence::spawn_writer(
                db.clone(),
                name.to_string(),
                doc.clone(),
                durable,
                seq,
                rx,
            );
            *guard = Some(doc);
        }
        let doc = guard.as_ref().unwrap().clone();
        let color = doc
            .add_connection(id, sender, actor_id, share_link_id, username)
            .await;
        Ok((doc, color))
    }

    pub(crate) async fn detach_document(
        &self,
        _name: &str,
        id: ConnectionId,
        doc: &Arc<DocumentState>,
    ) {
        doc.remove_connection(id).await;
        doc.broadcast_presence(_name).await;
        // The writer retires the room after the last accepted update is durable.
        // It uses the same slot lock as registration, and a grace period.
    }

    pub async fn broadcast_room_language(&self, room: &str, language: &str) {
        if let Some(doc) = self.get_document(room).await {
            let message = super::protocol::encode_stateless_message(room,
                &serde_json::json!({"type":"room-language", "language":language}).to_string());
            doc.broadcast(message, None).await;
        }
    }

    pub async fn occupied_rooms(&self) -> Vec<String> {
        let slots: Vec<_> = self
            .documents
            .read()
            .await
            .iter()
            .map(|(n, s)| (n.clone(), s.clone()))
            .collect();
        let mut rooms = Vec::new();
        for (name, slot) in slots {
            if let Some(doc) = slot.lock().await.as_ref() {
                if !doc.connections.read().await.is_empty() {
                    rooms.push(name);
                }
            }
        }
        rooms
    }

    pub async fn wait_for_saved(&self, room: &str) -> Result<(), crate::error::ApiError> {
        let Some(doc) = self.get_document(room).await else {
            return Ok(());
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while doc.pending_count.load(Ordering::Acquire) != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            crate::error::ApiError::service_unavailable(
                "Room history is still saving; retry shortly",
            )
        })
    }

    // Caller holds access.write() until the database change and revocation finish.
    pub async fn revoke_share(&self, room: &str, share: &str) {
        if let Some(doc) = self.get_document(room).await {
            doc.revoke(room, |c| c.share_link_id.as_deref() == Some(share))
                .await;
        }
    }

    pub async fn revoke_actor(&self, actor: &str) {
        let slots: Vec<_> = self
            .documents
            .read()
            .await
            .iter()
            .map(|(n, s)| (n.clone(), s.clone()))
            .collect();
        for (name, slot) in slots {
            if let Some(doc) = slot.lock().await.as_ref() {
                doc.revoke(&name, |c| c.actor_id.as_deref() == Some(actor))
                    .await;
            }
        }
    }

    pub async fn revoke_room(&self, room: &str) {
        if let Some(doc) = self.get_document(room).await {
            doc.mark_ended();
            doc.revoke(room, |_| true).await;
        }
    }
}

pub(crate) struct DocumentState {
    pub(crate) awareness: Awareness,
    connections: RwLock<HashMap<ConnectionId, DocumentConnection>>,
    pub(crate) update_lock: Mutex<()>,
    pub(crate) persistence: mpsc::Sender<PendingUpdate>,
    pub(crate) pending_bytes: AtomicUsize,
    pub(crate) pending_count: AtomicUsize,
    pub(crate) durable_seq: AtomicU64,
    pub(crate) storage_failed: AtomicBool,
    slot: Weak<DocumentSlot>,
    is_ended: AtomicBool,
}

impl DocumentState {
    pub(crate) async fn load(
        db: &PgPool,
        name: &str,
        persistence: mpsc::Sender<PendingUpdate>,
    ) -> Result<(Self, Doc, i64), WsError> {
        let row = sqlx::query_as::<_, DocumentSnapshotRow>(
            r#"
            SELECT data, "checkpointSeq" as checkpoint_seq
            FROM "Document"
            WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_optional(db)
        .await
        .map_err(WsError::Db)?;

        let doc = new_document();
        let checkpoint = row.as_ref().map(|r| r.checkpoint_seq).unwrap_or(0);
        let mut seq = checkpoint;
        if let Some(row) = row {
            if let Some(data) = row.data {
                let update = Update::decode_v1(&data).map_err(WsError::Decode)?;
                let mut txn = doc.transact_mut();
                txn.apply_update(update).map_err(WsError::Apply)?;
            }
        }

        // Recover historical snapshot gaps and updates whose dependencies arrived
        // later. CRDT updates are idempotent; replaying snapshot-covered entries
        // is safe, including old batched/compressed histories.
        let updates = sqlx::query_as::<_, (i64, Vec<u8>)>(
            r#"SELECT seq, update FROM "DocumentUpdate" WHERE "documentId" = $1 AND seq > $2 ORDER BY seq"#,
        ).bind(name).bind(checkpoint).fetch_all(db).await?;
        // Keep an independent durable document owned by the persistence worker.
        let durable = new_document();
        use yrs::{ReadTxn, StateVector};
        durable.transact_mut().apply_update(Update::decode_v1(
            &doc.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )?)?;
        for (id, bytes) in updates {
            doc.transact_mut()
                .apply_update(Update::decode_v1(&bytes)?)?;
            durable
                .transact_mut()
                .apply_update(Update::decode_v1(&bytes)?)?;
            seq = id;
        }

        let room_is_ended =
            sqlx::query_scalar::<_, bool>(r#"SELECT "isEnded" FROM "Room" WHERE id = $1"#)
                .bind(name)
                .fetch_optional(db)
                .await
                .map_err(WsError::Db)?
                .unwrap_or(false);

        Ok((
            Self {
                awareness: Awareness::new(doc),
                connections: RwLock::new(HashMap::new()),
                update_lock: Mutex::new(()),
                persistence,
                pending_bytes: AtomicUsize::new(0),
                pending_count: AtomicUsize::new(0),
                durable_seq: AtomicU64::new(seq as u64),
                storage_failed: AtomicBool::new(false),
                slot: Weak::new(),
                is_ended: AtomicBool::new(room_is_ended),
            },
            durable,
            seq,
        ))
    }

    pub(crate) fn is_ended(&self) -> bool {
        self.is_ended.load(Ordering::Acquire)
    }

    pub(crate) fn mark_ended(&self) {
        self.is_ended.store(true, Ordering::Release);
    }

    pub(crate) async fn add_connection(
        &self,
        id: ConnectionId,
        sender: Outbound,
        actor_id: Option<String>,
        share_link_id: Option<String>,
        username: String,
    ) -> SessionColor {
        let mut connections = self.connections.write().await;
        if let Some(existing) = connections.get(&id) {
            return existing.color.clone();
        }
        let slot =
            next_available_color_slot(connections.values().map(|connection| connection.color.slot));
        let color = session_color_for_slot(slot);
        connections.insert(
            id,
            DocumentConnection {
                sender,
                color: color.clone(),
                actor_id,
                share_link_id,
                username,
                client_id: None,
            },
        );
        color
    }

    pub(crate) async fn remove_connection(&self, id: ConnectionId) -> bool {
        let mut connections = self.connections.write().await;
        connections.remove(&id);
        connections.is_empty()
    }

    pub(crate) async fn retire_if_idle(&self, me: &Arc<Self>) -> bool {
        let Some(slot) = self.slot.upgrade() else {
            return true;
        };
        let mut guard = slot.lock().await;
        if self.pending_count.load(Ordering::Acquire) == 0
            && self.connections.read().await.is_empty()
        {
            if guard.as_ref().is_some_and(|doc| Arc::ptr_eq(doc, me)) {
                *guard = None;
            }
            return true;
        }
        false
    }

    pub(crate) async fn send_persistence_status(&self, name: &str, failed: bool) {
        let message = super::protocol::encode_stateless_message(name, &serde_json::json!({
            "type": "persistence-status", "pending": self.pending_count.load(Ordering::Acquire),
            "failed": failed || self.storage_failed.load(Ordering::Acquire), "durableSeq": self.durable_seq.load(Ordering::Acquire), "protocol": 1,
        }).to_string());
        self.broadcast(message, None).await;
    }

    pub(crate) async fn register_presence(
        &self,
        name: &str,
        connection: ConnectionId,
        client_id: u64,
    ) {
        {
            let mut connections = self.connections.write().await;
            if connections
                .iter()
                .any(|(id, c)| *id != connection && c.client_id == Some(client_id))
            {
                return;
            }
            if let Some(c) = connections.get_mut(&connection) {
                c.client_id = Some(client_id);
            }
        }
        self.broadcast_presence(name).await;
    }

    async fn presence_message(&self, name: &str) -> Vec<u8> {
        let connections = self.connections.read().await;
        let members: Vec<_> = connections
            .iter()
            .map(|(id, c)| {
                serde_json::json!({
                    "connectionId":id.to_string(), "clientId":c.client_id.unwrap_or(*id),
                    "id":c.actor_id, "username":c.username, "colorSlot":c.color.slot,
                    "color":c.color.color, "colorLight":c.color.color_light,
                })
            })
            .collect();
        super::protocol::encode_stateless_message(
            name,
            &serde_json::json!({"type":"presence-state", "members":members}).to_string(),
        )
    }

    pub(crate) async fn broadcast_presence(&self, name: &str) {
        self.broadcast(self.presence_message(name).await, None)
            .await;
    }
    pub(crate) async fn send_presence(&self, name: &str, outgoing: &Outbound) {
        let _ = outgoing.send(Message::Binary(self.presence_message(name).await.into()));
    }

    pub(crate) async fn connection_sender(&self, id: ConnectionId) -> Option<Outbound> {
        self.connections
            .read()
            .await
            .get(&id)
            .map(|c| c.sender.clone())
    }
    pub(crate) async fn has_connection(&self, id: ConnectionId) -> bool {
        self.connections.read().await.contains_key(&id)
    }

    async fn revoke(&self, name: &str, matches: impl Fn(&DocumentConnection) -> bool) {
        let mut connections = self.connections.write().await;
        connections.retain(|_, connection| {
            if !matches(connection) {
                return true;
            }
            let payload = r#"{"type":"access-revoked"}"#;
            let message = super::protocol::encode_stateless_message(name, payload);
            let _ = connection.sender.send(Message::Binary(message.into()));
            connection.sender.close("Access revoked");
            false
        });
        drop(connections);
        self.broadcast_presence(name).await;
    }

    pub(crate) async fn broadcast(&self, message: Vec<u8>, exclude: Option<ConnectionId>) {
        let connections = self.connections.read().await;
        for (id, connection) in connections.iter() {
            if let Some(exclude_id) = exclude {
                if exclude_id == *id {
                    continue;
                }
            }
            let _ = connection
                .sender
                .send(Message::Binary(message.clone().into()));
        }
    }
}

struct DocumentConnection {
    sender: Outbound,
    color: SessionColor,
    actor_id: Option<String>,
    share_link_id: Option<String>,
    username: String,
    client_id: Option<u64>,
}

pub(crate) struct SessionState {
    pub(crate) authenticated: bool,
    pub(crate) expires_at: i64,
    pub(crate) read_only: bool,
    pub(crate) actor_id: Option<String>,
    pub(crate) session_color: Option<SessionColor>,
    pub(crate) document: Option<Arc<DocumentState>>,
    pub(crate) pending_sync_step1: Option<yrs::StateVector>,
    pub(crate) awareness_clients: std::collections::HashSet<yrs::block::ClientID>,
}

impl SessionState {
    pub(crate) fn new() -> Self {
        Self {
            authenticated: false,
            expires_at: 0,
            read_only: true,
            actor_id: None,
            session_color: None,
            document: None,
            pending_sync_step1: None,
            awareness_clients: std::collections::HashSet::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum WsError {
    #[error("decode error: {0}")]
    Decode(#[from] yrs::encoding::read::Error),
    #[error("db error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("apply error: {0}")]
    Apply(#[from] yrs::error::UpdateError),
    #[error("awareness error: {0}")]
    Awareness(#[from] yrs::sync::awareness::Error),
    #[error("document name too long")]
    DocumentNameTooLong,
    #[error("Persistence queue is full; edits remain unconfirmed")]
    Backpressure,
}

#[derive(sqlx::FromRow)]
struct DocumentSnapshotRow {
    data: Option<Vec<u8>>,
    checkpoint_seq: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, ReadTxn, StateVector, Text};
    #[test]
    fn unicode_offsets_match_browser_utf16_and_roundtrip() {
        let doc = new_document();
        assert_eq!(doc.offset_kind(), OffsetKind::Utf16);
        let text = doc.get_or_insert_text("codemirror");
        text.insert(&mut doc.transact_mut(), 0, "中😀e\u{301}𠮷");
        text.insert(&mut doc.transact_mut(), 3, "文");
        assert_eq!(text.get_string(&doc.transact()), "中😀文e\u{301}𠮷");
        let data = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let peer = new_document();
        peer.transact_mut()
            .apply_update(Update::decode_v1(&data).unwrap())
            .unwrap();
        assert_eq!(
            peer.get_or_insert_text("codemirror")
                .get_string(&peer.transact()),
            "中😀文e\u{301}𠮷"
        );
    }
}
