use crate::auth::AuthUser;

pub fn has_global_read(user: &AuthUser) -> bool {
    user.can_read_all_rooms || user.can_write_all_rooms || user.can_delete_all_rooms
}

pub fn has_global_write(user: &AuthUser) -> bool {
    user.can_write_all_rooms || user.can_delete_all_rooms
}

pub fn has_global_delete(user: &AuthUser) -> bool {
    user.can_delete_all_rooms
}
