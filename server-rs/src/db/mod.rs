pub mod models;

use crate::error::ApiError;

pub fn db_error(err: sqlx::Error, context: &str) -> ApiError {
    tracing::error!(error = %err, "{context}");
    ApiError::internal("Internal server error")
}

/// A concurrent registration can win after the availability check. Return a
/// client error for known unique constraints instead of leaking a generic 500.
pub fn user_creation_error(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(ref database) = err {
        if database.is_unique_violation() {
            match database.constraint() {
                Some("User_username_key") => {
                    return ApiError::bad_request("Username already taken")
                }
                Some("User_email_key") => return ApiError::bad_request("Email already in use"),
                _ => {}
            }
        }
    }
    db_error(err, "Failed to create user")
}
