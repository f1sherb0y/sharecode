use axum::{extract::State, http::{header, HeaderMap}, response::IntoResponse, Json};
use chrono::Utc;
use serde_json::json;

use crate::{auth::{build_user_claims, generate_user_token, verify_refresh_identity, verify_token, TokenPayload},
    core::{audit::{self, ClientInfo}, sessions}, db::db_error, error::ApiError, state::AppState};

#[derive(sqlx::FromRow)]
struct SessionRow { id: String, user_id: String, token_version: i64 }

pub async fn refresh(State(state): State<AppState>, client: ClientInfo, headers: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    sessions::check_cookie_request(&state.config, &headers)?;
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let identity = match bearer.map(|token| verify_refresh_identity(&state.config, token)).transpose()? {
        Some(TokenPayload::User(user)) => Some(user),
        Some(_) => return Err(ApiError::unauthorized("Invalid user session")),
        None => None,
    };
    let mut tx = state.db.begin().await.map_err(|e| db_error(e,"Failed to start session renewal"))?;
    let (user, session_id, secret) = if let Some(secret) = sessions::cookie_secret(&state.config, &headers) {
        let row = sqlx::query_as::<_, SessionRow>(r#"SELECT id,"userId" AS user_id,"tokenVersion" AS token_version
            FROM "BrowserSession" WHERE "secretHash"=$1 AND "expiresAt">NOW() FOR UPDATE"#)
            .bind(sessions::secret_hash(&secret)).fetch_optional(&mut *tx).await
            .map_err(|e| db_error(e,"Failed to load browser session"))?
            .ok_or_else(||ApiError::unauthorized("Session expired"))?;
        if identity.as_ref().is_some_and(|u| u.user_id != row.user_id || u.token_version != row.token_version || u.session_id.as_ref().is_some_and(|sid| sid != &row.id)) {
            return Err(ApiError::unauthorized("Browser account changed; sign in again"));
        }
        // Non-secret tab hints prevent a stale tab from adopting another login.
        for (header, expected) in [("x-session-user", &row.user_id), ("x-session-id", &row.id)] {
            if headers.get(header).is_some_and(|v| v.to_str().ok() != Some(expected.as_str())) {
                return Err(ApiError::unauthorized("Browser account changed; sign in again"));
            }
        }
        let user = sessions::load_user(&mut tx, &row.user_id).await?;
        if user.token_version != row.token_version { return Err(ApiError::unauthorized("Session expired")); }
        sqlx::query(r#"UPDATE "BrowserSession" SET "lastSeen"=NOW(),"expiresAt"=NOW()+INTERVAL '30 days' WHERE id=$1"#)
            .bind(&row.id).execute(&mut *tx).await.map_err(|e| db_error(e,"Failed to renew browser session"))?;
        (user, row.id, secret)
    } else {
        // One-time upgrade for already signed-in clients from before cookies.
        // Session-bound or expired JWTs cannot replace a missing/revoked cookie.
        let token = bearer.ok_or_else(||ApiError::unauthorized("No browser session"))?;
        let payload = match verify_token(&state.config, token)? {
            TokenPayload::User(u) if u.session_id.is_none() => u,
            _ => return Err(ApiError::unauthorized("No browser session")),
        };
        let user = sessions::load_user(&mut tx, &payload.user_id).await?;
        if user.token_version != payload.token_version { return Err(ApiError::unauthorized("Session expired")); }
        let (id, secret) = sessions::create(&mut tx, &user, client.device_id).await?;
        (user, id, secret)
    };
    let mut claims = build_user_claims(&user, Utc::now());
    claims.session_id = Some(session_id.clone());
    let token = generate_user_token(&state.config, claims)?;
    tx.commit().await.map_err(|e| db_error(e,"Failed to commit session renewal"))?;
    Ok(([(header::SET_COOKIE, sessions::cookie_header(&state.config, &secret)), (header::CACHE_CONTROL,"no-store".parse().unwrap())],
        Json(json!({"token":token,"browserSessionId":session_id,"user":{
            "id":user.id,"username":user.username,"email":user.email,"color":user.color,"role":user.role,
            "canReadAllRooms":user.can_read_all_rooms,"canWriteAllRooms":user.can_write_all_rooms,"canDeleteAllRooms":user.can_delete_all_rooms
        }}))))
}

pub async fn logout(State(state): State<AppState>, client: ClientInfo, headers: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    sessions::check_cookie_request(&state.config, &headers)?;
    let _access = state.ws.access.write().await;
    if let Some(secret) = sessions::cookie_secret(&state.config, &headers) {
        let mut tx = state.db.begin().await.map_err(|e| db_error(e,"Failed to start logout"))?;
        let row = sqlx::query_as::<_, SessionRow>(r#"SELECT id,"userId" AS user_id,"tokenVersion" AS token_version
            FROM "BrowserSession" WHERE "secretHash"=$1 FOR UPDATE"#)
            .bind(sessions::secret_hash(&secret)).fetch_optional(&mut *tx).await.map_err(|e| db_error(e,"Failed to load logout session"))?;
        if let Some(row) = row {
            if headers.get("x-session-id").is_some_and(|v| v.to_str().ok() != Some(row.id.as_str())) {
                return Err(ApiError::unauthorized("Browser account changed; sign in again"));
            }
            sqlx::query(r#"DELETE FROM "BrowserSession" WHERE id=$1"#).bind(&row.id).execute(&mut *tx).await.map_err(|e| db_error(e,"Failed to revoke browser session"))?;
            audit::record(&mut *tx,&client,"session.logout",Some(&row.user_id),None,Some(&row.id),true,None).await?;
            tx.commit().await.map_err(|e| db_error(e,"Failed to commit logout"))?;
            state.ws.revoke_session(&row.id).await;
        }
    }
    Ok(([(header::SET_COOKIE,sessions::cookie_header(&state.config,"")), (header::CACHE_CONTROL,"no-store".parse().unwrap())],Json(json!({"message":"Logged out"}))))
}
