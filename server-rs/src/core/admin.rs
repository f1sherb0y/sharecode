use bcrypt::hash;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    db::db_error,
    state::AppState,
    utils::{colors::random_user_color, passwords::validate_password},
};

#[derive(Debug, sqlx::FromRow)]
struct AdminRow {
    id: String,
    username: String,
}

pub async fn initialize_admin(state: &AppState) -> Result<(), crate::error::ApiError> {
    let config = &state.config;

    let existing_admin = sqlx::query_as::<_, AdminRow>(
        r#"
        SELECT id, username
        FROM "User"
        WHERE role = 'admin' AND "isDeleted" = false
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check for admin"))?;

    if let Some(admin) = existing_admin {
        info!("Admin already exists: {}", admin.username);

        if config.admin_update_password {
            validate_password(&config.admin_password).map_err(|err| {
                crate::error::ApiError::internal(format!(
                    "ADMIN_PASSWORD does not satisfy password policy: {err}"
                ))
            })?;
            let hashed = hash(&config.admin_password, 12).map_err(|err| {
                crate::error::ApiError::internal(format!("Failed to hash admin password: {err}"))
            })?;
            sqlx::query(
                r#"
                UPDATE "User"
                SET password = $1, "tokenVersion" = "tokenVersion" + 1
                WHERE id = $2
                "#,
            )
            .bind(&hashed)
            .bind(&admin.id)
            .execute(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to update admin password"))?;
            info!("   Admin password updated");
        }

        return Ok(());
    }

    let existing_user = sqlx::query_as::<_, AdminRow>(
        r#"
        SELECT id, username
        FROM "User"
        WHERE username = $1
        LIMIT 1
        "#,
    )
    .bind(&config.admin_username)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check admin username"))?;

    if let Some(user) = existing_user {
        sqlx::query(r#"UPDATE "User" SET role = 'admin' WHERE id = $1"#)
            .bind(&user.id)
            .execute(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to promote user to admin"))?;
        info!("Promoted existing user to admin: {}", user.username);
        return Ok(());
    }

    validate_password(&config.admin_password).map_err(|err| {
        crate::error::ApiError::internal(format!(
            "ADMIN_PASSWORD does not satisfy password policy: {err}"
        ))
    })?;

    let hashed_password = hash(&config.admin_password, 12).map_err(|err| {
        crate::error::ApiError::internal(format!("Failed to hash admin password: {err}"))
    })?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|err| db_error(err, "Failed to begin admin transaction"))?;
    let color = random_user_color();
    sqlx::query(
        r#"
        INSERT INTO "User" (id, email, username, password, color, role)
        VALUES ($1, $2, $3, $4, $5, 'admin')
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&config.admin_email)
    .bind(&config.admin_username)
    .bind(&hashed_password)
    .bind(&color)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create admin"))?;

    tx.commit()
        .await
        .map_err(|err| db_error(err, "Failed to commit admin transaction"))?;

    info!("Admin created: {}", config.admin_username);
    info!("   Email: {}", config.admin_email);
    warn!("   [WARNING] Please change the default password in production!");

    Ok(())
}
