use axum::extract::ws::Message;
use sqlx::PgPool;
use std::time::Instant;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{mpsc, Mutex, RwLock};
use yrs::updates::decoder::Decode;
use yrs::{sync::Awareness, Doc, Transact, Update};

pub(crate) type ConnectionId = u64;

pub struct WsState {
    documents: RwLock<HashMap<String, Arc<DocumentState>>>,
    next_connection_id: AtomicU64,
}

impl WsState {
    pub fn new() -> Self {
        Self {
            documents: RwLock::new(HashMap::new()),
            next_connection_id: AtomicU64::new(1),
        }
    }

    pub(crate) fn next_connection_id(&self) -> ConnectionId {
        self.next_connection_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) async fn get_document(&self, name: &str) -> Option<Arc<DocumentState>> {
        let docs = self.documents.read().await;
        docs.get(name).cloned()
    }

    pub(crate) async fn get_or_create_document(
        &self,
        db: &PgPool,
        name: &str,
    ) -> Result<Arc<DocumentState>, WsError> {
        if let Some(doc) = self.get_document(name).await {
            return Ok(doc);
        }

        let doc_state = Arc::new(DocumentState::load(db, name).await?);
        let mut docs = self.documents.write().await;
        let entry = docs
            .entry(name.to_string())
            .or_insert_with(|| Arc::clone(&doc_state));
        Ok(Arc::clone(entry))
    }

    pub(crate) async fn remove_document(&self, name: &str) {
        let mut docs = self.documents.write().await;
        docs.remove(name);
    }
}

pub(crate) struct DocumentState {
    pub(crate) awareness: Awareness,
    connections: RwLock<HashMap<ConnectionId, mpsc::UnboundedSender<Message>>>,
    pub(crate) snapshot: Arc<Mutex<SnapshotDebounce>>,
    pub(crate) update_batch: Arc<Mutex<UpdateBatch>>,
}

impl DocumentState {
    pub(crate) async fn load(db: &PgPool, name: &str) -> Result<Self, WsError> {
        let row = sqlx::query_as::<_, DocumentSnapshotRow>(
            r#"
            SELECT data
            FROM "Document"
            WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_optional(db)
        .await
        .map_err(WsError::Db)?;

        let doc = Doc::new();
        if let Some(row) = row {
            if let Some(data) = row.data {
                let update = Update::decode_v1(&data).map_err(WsError::Decode)?;
                let mut txn = doc.transact_mut();
                txn.apply_update(update).map_err(WsError::Apply)?;
            }
        }

        Ok(Self {
            awareness: Awareness::new(doc),
            connections: RwLock::new(HashMap::new()),
            snapshot: Arc::new(Mutex::new(SnapshotDebounce::new())),
            update_batch: Arc::new(Mutex::new(UpdateBatch::new())),
        })
    }

    pub(crate) async fn add_connection(
        &self,
        id: ConnectionId,
        sender: mpsc::UnboundedSender<Message>,
    ) {
        let mut connections = self.connections.write().await;
        connections.insert(id, sender);
    }

    pub(crate) async fn remove_connection(&self, id: ConnectionId) -> bool {
        let mut connections = self.connections.write().await;
        connections.remove(&id);
        connections.is_empty()
    }

    pub(crate) async fn broadcast(&self, message: Vec<u8>, exclude: Option<ConnectionId>) {
        let connections = self.connections.read().await;
        for (id, tx) in connections.iter() {
            if let Some(exclude_id) = exclude {
                if exclude_id == *id {
                    continue;
                }
            }
            let _ = tx.send(Message::Binary(message.clone().into()));
        }
    }
}

pub(crate) struct SnapshotDebounce {
    pub(crate) last_update: Instant,
    pub(crate) running: bool,
}

impl SnapshotDebounce {
    pub(crate) fn new() -> Self {
        Self {
            last_update: Instant::now(),
            running: false,
        }
    }
}

pub(crate) struct UpdateBatch {
    pub(crate) pending: Vec<PendingUpdate>,
    pub(crate) last_update: Instant,
    pub(crate) running: bool,
}

impl UpdateBatch {
    pub(crate) fn new() -> Self {
        Self {
            pending: Vec::new(),
            last_update: Instant::now(),
            running: false,
        }
    }
}

#[derive(Debug)]
pub(crate) struct PendingUpdate {
    pub(crate) update: Vec<u8>,
    pub(crate) actor_id: Option<String>,
}

pub(crate) struct SessionState {
    pub(crate) authenticated: bool,
    pub(crate) read_only: bool,
    pub(crate) actor_id: Option<String>,
    pub(crate) document: Option<Arc<DocumentState>>,
    pub(crate) pending_sync_step1: Option<yrs::StateVector>,
    pub(crate) awareness_clients: std::collections::HashSet<yrs::block::ClientID>,
}

impl SessionState {
    pub(crate) fn new() -> Self {
        Self {
            authenticated: false,
            read_only: true,
            actor_id: None,
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
}

#[derive(sqlx::FromRow)]
struct DocumentSnapshotRow {
    data: Option<Vec<u8>>,
}
