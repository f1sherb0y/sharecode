use chrono::NaiveDateTime;
use sqlx::FromRow;

#[derive(Debug, FromRow)]
pub struct UserRow {
    pub id: String,
    pub email: Option<String>,
    pub username: String,
    pub password: String,
    pub color: String,
    pub role: String,
    pub can_read_all_rooms: bool,
    pub can_write_all_rooms: bool,
    pub can_delete_all_rooms: bool,
    pub is_deleted: bool,
    pub created_at: NaiveDateTime,
    pub last_seen: NaiveDateTime,
}

#[derive(Debug, FromRow)]
pub struct UserPublicRow {
    pub id: String,
    pub email: Option<String>,
    pub username: String,
    pub color: String,
    pub role: String,
    pub can_read_all_rooms: bool,
    pub can_write_all_rooms: bool,
    pub can_delete_all_rooms: bool,
    pub created_at: NaiveDateTime,
    pub last_seen: NaiveDateTime,
}

#[derive(Debug, FromRow)]
pub struct UserSimpleRow {
    pub id: String,
    pub username: String,
    pub color: String,
    pub role: String,
}

#[derive(Debug, FromRow)]
pub struct RoomWithOwnerRow {
    pub id: String,
    pub name: String,
    pub language: String,
    pub company: Option<String>,
    pub position: Option<String>,
    pub owner_id: String,
    pub allow_edit: bool,
    pub is_pinned: bool,
    pub is_deleted: bool,
    pub scheduled_time: Option<NaiveDateTime>,
    pub duration: Option<i32>,
    pub is_ended: bool,
    pub ended_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub owner_username: String,
    pub owner_color: String,
}

#[derive(Debug, FromRow)]
pub struct RoomAdminRow {
    pub id: String,
    pub name: String,
    pub language: String,
    pub company: Option<String>,
    pub position: Option<String>,
    pub owner_id: String,
    pub allow_edit: bool,
    pub is_pinned: bool,
    pub is_deleted: bool,
    pub scheduled_time: Option<NaiveDateTime>,
    pub duration: Option<i32>,
    pub is_ended: bool,
    pub ended_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub owner_username: String,
    pub owner_email: Option<String>,
}

#[derive(Debug, FromRow)]
pub struct RoomParticipantRow {
    pub id: String,
    pub room_id: String,
    pub user_id: String,
    pub can_edit: bool,
    pub joined_at: NaiveDateTime,
}

#[derive(Debug, FromRow)]
pub struct RoomParticipantWithUserRow {
    pub id: String,
    pub room_id: String,
    pub user_id: String,
    pub can_edit: bool,
    pub joined_at: NaiveDateTime,
    pub user_username: String,
    pub user_color: String,
}

#[derive(Debug, FromRow)]
pub struct RoomShareLinkRow {
    pub id: String,
    pub room_id: String,
    pub token: String,
    pub can_edit: bool,
    pub created_by: String,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, FromRow)]
pub struct ShareLinkWithRoomRow {
    pub id: String,
    pub token: String,
    pub can_edit: bool,
    pub created_at: NaiveDateTime,
    pub room_id: String,
    pub room_name: String,
    pub room_language: String,
    pub room_allow_edit: bool,
    pub room_is_deleted: bool,
    pub room_is_ended: bool,
    pub room_ended_at: Option<NaiveDateTime>,
}

#[derive(Debug, FromRow)]
pub struct ShareLinkSummaryRow {
    pub id: String,
    pub token: String,
    pub can_edit: bool,
    pub created_at: NaiveDateTime,
    pub room_id: String,
    pub guest_count: i64,
}

#[derive(Debug, FromRow)]
pub struct GuestSessionRow {
    pub id: String,
    pub share_link_id: String,
    pub room_id: String,
    pub token: String,
    pub display_name: String,
    pub email: Option<String>,
    pub color: String,
    pub can_edit: bool,
    pub created_at: NaiveDateTime,
    pub last_active: NaiveDateTime,
}

#[derive(Debug, FromRow)]
pub struct GuestSessionWithRoomRow {
    pub id: String,
    pub share_link_id: String,
    pub room_id: String,
    pub token: String,
    pub display_name: String,
    pub email: Option<String>,
    pub color: String,
    pub can_edit: bool,
    pub created_at: NaiveDateTime,
    pub last_active: NaiveDateTime,
    pub room_name: String,
    pub room_language: String,
    pub room_allow_edit: bool,
    pub room_is_deleted: bool,
    pub room_is_ended: bool,
    pub room_ended_at: Option<NaiveDateTime>,
    pub share_token: String,
    pub share_can_edit: bool,
}

#[derive(Debug, FromRow)]
pub struct DocumentUpdateRow {
    pub id: String,
    pub document_id: String,
    pub update: Vec<u8>,
    pub timestamp: NaiveDateTime,
    pub user_id: Option<String>,
}
