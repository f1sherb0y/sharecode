use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::state::AppState;
use crate::ws;

mod admin;
mod appointments;
mod auth;
mod code;
mod customers;
mod health;
mod invites;
mod notes;
mod notifications;
mod playback;
mod rooms;
mod share;
mod sessions;
mod tours;
mod work_tables;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        // Auth
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/refresh", post(sessions::refresh))
        .route("/api/auth/logout", post(sessions::logout))
        .route("/api/auth/profile", get(auth::get_profile))
        .route("/api/auth/change-password", post(auth::change_password))
        .route("/api/notifications", get(notifications::list_notifications))
        .route(
            "/api/notifications/unread",
            get(notifications::list_unread_notifications),
        )
        .route(
            "/api/notifications/read-all",
            post(notifications::mark_all_notifications_read),
        )
        .route(
            "/api/notifications/read",
            post(notifications::mark_notifications_read),
        )
        .route("/api/tours", get(tours::list_seen_tours))
        .route("/api/tours/{id}", put(tours::mark_tour_seen))
        .route("/api/work-tables", get(work_tables::list_work_tables))
        .route("/api/work-tables/note", put(work_tables::update_work_table_note))
        .route("/api/work-tables", post(work_tables::create_work_table))
        .route("/api/work-tables/{id}/link", post(work_tables::reset_work_table_link))
        .route("/api/work-tables/{id}/merge", post(work_tables::merge_work_table))
        .route("/api/table-links/{token}", get(work_tables::open_table_link))
        .route("/api/table-links/{token}/note", put(work_tables::update_table_link_note))
        .route("/api/table-links/{token}/busy", post(work_tables::create_table_link_busy))
        .route("/api/table-links/{token}/busy/{id}", put(work_tables::update_table_link_busy))
        .route("/api/table-links/{token}/busy/{id}", delete(work_tables::delete_table_link_busy))
        .route(
            "/api/config/registration",
            get(auth::get_registration_status),
        )
        // Registration invites (agents and admins)
        .route("/api/invites", post(invites::create_invite))
        .route("/api/invites", get(invites::list_invites))
        .route("/api/invites/{id}", delete(invites::delete_invite))
        // Scheduling: customers (agents and admins) and sessions
        .route("/api/customers", get(customers::list_customers))
        .route("/api/customers", post(customers::create_customer))
        .route("/api/customers/{id}", get(customers::get_customer))
        .route("/api/customers/{id}", put(customers::update_customer))
        .route("/api/customers/{id}", delete(customers::delete_customer))
        .route("/api/appointments", get(appointments::list_appointments))
        .route("/api/appointments", post(appointments::create_appointment))
        .route("/api/appointments/{id}", get(appointments::get_appointment))
        .route("/api/appointments/{id}", put(appointments::update_appointment))
        .route("/api/appointments/{id}", delete(appointments::delete_appointment))
        .route(
            "/api/appointments/{id}/room",
            post(appointments::open_appointment_room),
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
        .route("/api/admin/audit", get(crate::core::audit::list_events))
        .route("/api/admin/users", post(admin::create_user))
        .route("/api/admin/users", get(admin::get_all_users))
        .route(
            "/api/admin/notifications",
            post(notifications::create_notification),
        )
        .route(
            "/api/admin/users/{id}/devices",
            get(crate::core::audit::list_user_devices),
        )
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
        // Notes
        .route("/api/rooms/{roomId}/notes", get(notes::list_notes))
        .route("/api/rooms/{roomId}/notes", post(notes::create_note))
        .route(
            "/api/rooms/{roomId}/notes/{noteId}",
            put(notes::update_note),
        )
        .route(
            "/api/rooms/{roomId}/notes/{noteId}",
            delete(notes::delete_note),
        )
        // Share
        .route("/api/share/{token}/join", post(share::join_share_link))
        .route("/api/share/{token}/accept", post(share::accept_share_link))
        // Code execution
        .route("/api/code/execute", post(code::execute_code))
        .route("/api/code/languages", get(code::get_languages))
        .route("/api/code/health", get(code::check_piston_health))
        // WebSocket
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state)
}
