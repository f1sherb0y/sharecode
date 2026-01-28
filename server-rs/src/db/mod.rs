pub mod models;

use crate::error::ApiError;

pub fn db_error(err: sqlx::Error, context: &str) -> ApiError {
    tracing::error!(error = %err, "{context}");
    ApiError::internal("Internal server error")
}
