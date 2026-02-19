use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::state::AppState;
use crate::ws;

mod admin;
mod auth;
mod code;
mod health;
mod playback;
mod rooms;
mod share;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        // Auth
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/profile", get(auth::get_profile))
        .route(
            "/api/config/registration",
            get(auth::get_registration_status),
        )
        // Rooms
        .route("/api/users", get(rooms::get_all_users_for_room_creation))
        .route("/api/rooms", post(rooms::create_room))
        .route("/api/rooms", get(rooms::get_rooms))
        .route(
            "/api/rooms/by-document/{documentId}",
            get(rooms::get_room_by_document_id),
        )
        .route("/api/rooms/{roomId}", get(rooms::get_room))
        .route("/api/rooms/{roomId}", put(rooms::update_room))
        .route("/api/rooms/{roomId}/pin", put(rooms::set_room_pin))
        .route("/api/rooms/{roomId}", delete(rooms::delete_room))
        .route("/api/rooms/{roomId}/join", post(rooms::join_room))
        .route("/api/rooms/{roomId}/leave", post(rooms::leave_room))
        .route("/api/rooms/{roomId}/end", post(rooms::end_room))
        .route(
            "/api/rooms/{roomId}/share-links",
            post(share::create_share_link),
        )
        .route(
            "/api/rooms/{roomId}/share-links",
            get(share::list_share_links),
        )
        .route(
            "/api/rooms/{roomId}/share-links/{shareLinkId}",
            delete(share::delete_share_link),
        )
        // Admin
        .route("/api/admin/users", post(admin::create_user))
        .route("/api/admin/users", get(admin::get_all_users))
        .route("/api/admin/users/{id}", patch(admin::update_user))
        .route("/api/admin/users/{id}", delete(admin::delete_user))
        .route("/api/admin/rooms", get(admin::get_all_rooms))
        .route("/api/admin/rooms/{id}", delete(admin::delete_room))
        .route(
            "/api/admin/storage/db-size",
            get(admin::get_db_storage_size),
        )
        .route(
            "/api/admin/storage/playback",
            get(admin::get_room_playback_sizes),
        )
        .route(
            "/api/admin/rooms/{id}/playback/compress",
            post(admin::compress_room_playback),
        )
        // Playback
        .route(
            "/api/rooms/{roomId}/playback/updates",
            get(playback::get_playback_updates),
        )
        // Share
        .route("/api/share/session", get(share::get_guest_session))
        .route("/api/share/{token}", get(share::get_share_info))
        .route("/api/share/{token}/join", post(share::join_share_link))
        // Code execution
        .route("/api/code/execute", post(code::execute_code))
        .route("/api/code/languages", get(code::get_languages))
        .route("/api/code/health", get(code::check_piston_health))
        // WebSocket
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
}
