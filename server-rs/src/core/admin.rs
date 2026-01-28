use bcrypt::hash;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db::db_error, state::AppState, utils::colors::random_user_color};

#[derive(Debug, sqlx::FromRow)]
struct SuperuserRow {
    id: String,
    username: String,
    can_read_all_rooms: bool,
    can_write_all_rooms: bool,
    can_delete_all_rooms: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct AdminRow {
    id: String,
    username: String,
}

pub async fn initialize_admin(state: &AppState) -> Result<(), crate::error::ApiError> {
    let config = &state.config;

    let existing_superuser = sqlx::query_as::<_, SuperuserRow>(
        r#"
        SELECT id, username, "canReadAllRooms" as can_read_all_rooms,
               "canWriteAllRooms" as can_write_all_rooms,
               "canDeleteAllRooms" as can_delete_all_rooms
        FROM "User"
        WHERE role = 'superuser' AND "isDeleted" = false
        LIMIT 1
        "#
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check for superuser"))?;

    if let Some(superuser) = existing_superuser {
        info!("Superuser already exists: {}", superuser.username);

        if !superuser.can_read_all_rooms || !superuser.can_write_all_rooms || !superuser.can_delete_all_rooms {
            sqlx::query(
                r#"
                UPDATE "User"
                SET "canReadAllRooms" = true,
                    "canWriteAllRooms" = true,
                    "canDeleteAllRooms" = true
                WHERE id = $1
                "#
            )
            .bind(&superuser.id)
            .execute(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to update superuser permissions"))?;
            info!("   Superuser permissions updated");
        }

        if config.admin_update_password {
            let hashed = hash(&config.admin_password, 10)
                .map_err(|err| crate::error::ApiError::internal(format!("Failed to hash admin password: {err}")))?;
            sqlx::query(
                r#"
                UPDATE "User"
                SET password = $1
                WHERE id = $2
                "#
            )
            .bind(&hashed)
            .bind(&superuser.id)
            .execute(&state.db)
            .await
            .map_err(|err| db_error(err, "Failed to update superuser password"))?;
            info!("   Superuser password updated");
        }

        return Ok(());
    }

    let existing_admin = sqlx::query_as::<_, AdminRow>(
        r#"
        SELECT id, username
        FROM "User"
        WHERE username = $1
        LIMIT 1
        "#
    )
    .bind(&config.admin_username)
    .fetch_optional(&state.db)
    .await
    .map_err(|err| db_error(err, "Failed to check admin username"))?;

    if let Some(user) = existing_admin {
        sqlx::query(
            r#"
            UPDATE "User"
            SET role = 'superuser',
                "canReadAllRooms" = true,
                "canWriteAllRooms" = true,
                "canDeleteAllRooms" = true
            WHERE id = $1
            "#
        )
        .bind(&user.id)
        .execute(&state.db)
        .await
        .map_err(|err| db_error(err, "Failed to promote user to superuser"))?;
        info!("Promoted existing user to superuser: {}", user.username);
        return Ok(());
    }

    let hashed_password = hash(&config.admin_password, 10)
        .map_err(|err| crate::error::ApiError::internal(format!("Failed to hash admin password: {err}")))?;

    let mut tx = state.db.begin().await.map_err(|err| db_error(err, "Failed to begin admin transaction"))?;
    let color = random_user_color();
    sqlx::query(
        r#"
        INSERT INTO "User" (id, email, username, password, color, role,
                            "canReadAllRooms", "canWriteAllRooms", "canDeleteAllRooms")
        VALUES ($1, $2, $3, $4, $5, 'superuser', true, true, true)
        "#
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&config.admin_email)
    .bind(&config.admin_username)
    .bind(&hashed_password)
    .bind(&color)
    .execute(&mut *tx)
    .await
    .map_err(|err| db_error(err, "Failed to create superuser"))?;

    tx.commit()
        .await
        .map_err(|err| db_error(err, "Failed to commit admin transaction"))?;

    info!("Superuser created: {}", config.admin_username);
    info!("   Email: {}", config.admin_email);
    warn!("   [WARNING] Please change the default password in production!");

    Ok(())
}
