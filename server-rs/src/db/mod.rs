pub mod models;

use crate::error::ApiError;

pub fn db_error(err: sqlx::Error, context: &str) -> ApiError {
    tracing::error!(error = %err, "{context}");
    ApiError::internal("Internal server error")
}

/// Usernames are unique whatever their case or surrounding spaces; deleted accounts keep
/// theirs. Returns whether the holder (other than `except`) is deleted.
pub async fn username_holder<'e, E: sqlx::PgExecutor<'e>>(
    db: E,
    username: &str,
    except: Option<&str>,
) -> Result<Option<bool>, ApiError> {
    sqlx::query_scalar::<_, bool>(
        r#"SELECT "isDeleted" FROM "User"
        WHERE lower(btrim(username)) = lower(btrim($1)) AND ($2::text IS NULL OR id <> $2)
        ORDER BY "isDeleted" LIMIT 1"#,
    )
    .bind(username)
    .bind(except)
    .fetch_optional(db)
    .await
    .map_err(|err| db_error(err, "Failed to check username"))
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
