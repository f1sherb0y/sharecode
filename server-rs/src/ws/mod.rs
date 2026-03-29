mod auth;
mod handlers;
mod protocol;
mod state;

pub use state::WsState;

use axum::{
    extract::{ws::WebSocketUpgrade, State},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};

use crate::state::AppState;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handlers::handle_socket(socket, state))
}

pub async fn broadcast_room_ended(state: &AppState, room_id: &str, ended_at: DateTime<Utc>) {
    handlers::broadcast_room_ended(state, room_id, ended_at).await;
}
