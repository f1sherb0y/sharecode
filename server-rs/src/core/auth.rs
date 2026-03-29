use axum::{
    extract::{FromRequestParts, State},
    http::{header, request::Parts},
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::{
    config::Config, db::db_error, error::ApiError, models::UserRow,
    share_links::GUEST_SHARE_TTL_HOURS, state::AppState,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTokenPayload {
    pub user_id: String,
    pub email: Option<String>,
    pub username: String,
    pub role: String,
    pub can_read_all_rooms: bool,
    pub can_write_all_rooms: bool,
    pub can_delete_all_rooms: bool,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestTokenPayload {
    pub guest_id: String,
    pub room_id: String,
    pub share_link_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub color: String,
    pub can_edit: bool,
    pub session_token: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TokenPayload {
    User(UserTokenPayload),
    Guest(GuestTokenPayload),
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub role: String,
    pub can_read_all_rooms: bool,
    pub can_write_all_rooms: bool,
    pub can_delete_all_rooms: bool,
}

#[derive(Debug, Clone)]
pub struct AdminUser(pub AuthUser);

pub fn generate_user_token(config: &Config, payload: UserTokenPayload) -> Result<String, ApiError> {
    let key = EncodingKey::from_secret(config.jwt_secret.as_bytes());
    encode(&Header::default(), &TokenPayload::User(payload), &key)
        .map_err(|err| ApiError::internal(format!("Failed to sign token: {err}")))
}

pub fn generate_guest_token(
    config: &Config,
    payload: GuestTokenPayload,
) -> Result<String, ApiError> {
    let key = EncodingKey::from_secret(config.jwt_secret.as_bytes());
    encode(&Header::default(), &TokenPayload::Guest(payload), &key)
        .map_err(|err| ApiError::internal(format!("Failed to sign token: {err}")))
}

pub fn build_user_claims(user: &UserRow, now: chrono::DateTime<Utc>) -> UserTokenPayload {
    let iat = now.timestamp();
    let exp = (now + Duration::days(7)).timestamp();

    UserTokenPayload {
        user_id: user.id.clone(),
        email: user.email.clone(),
        username: user.username.clone(),
        role: user.role.clone(),
        can_read_all_rooms: user.can_read_all_rooms,
        can_write_all_rooms: user.can_write_all_rooms,
        can_delete_all_rooms: user.can_delete_all_rooms,
        exp,
        iat,
    }
}

pub fn build_guest_claims(
    guest_id: String,
    room_id: String,
    share_link_id: String,
    display_name: String,
    email: Option<String>,
    color: String,
    can_edit: bool,
    session_token: String,
    now: chrono::DateTime<Utc>,
) -> GuestTokenPayload {
    let iat = now.timestamp();
    let exp = (now + Duration::hours(GUEST_SHARE_TTL_HOURS)).timestamp();

    GuestTokenPayload {
        guest_id,
        room_id,
        share_link_id,
        display_name,
        email,
        color,
        can_edit,
        session_token,
        exp,
        iat,
    }
}

pub fn verify_token(config: &Config, token: &str) -> Result<TokenPayload, ApiError> {
    let key = DecodingKey::from_secret(config.jwt_secret.as_bytes());
    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<TokenPayload>(token, &key, &validation)
        .map_err(|_| ApiError::unauthorized("Invalid token"))?;
    Ok(data.claims)
}

fn extract_bearer_token(parts: &Parts) -> Result<String, ApiError> {
    let header_value = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("No token provided"))?;

    if !header_value.starts_with("Bearer ") {
        return Err(ApiError::unauthorized("No token provided"));
    }

    Ok(header_value.trim_start_matches("Bearer ").to_string())
}

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    AppState: axum::extract::FromRef<S>,
{
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let State(app_state) = State::<AppState>::from_request_parts(parts, state)
                .await
                .map_err(|_| ApiError::internal("Failed to extract app state"))?;

            let token = extract_bearer_token(parts)?;
            let payload = verify_token(&app_state.config, &token)?;

            let user_payload = match payload {
                TokenPayload::User(payload) => payload,
                _ => return Err(ApiError::unauthorized("Invalid token")),
            };

            let user = sqlx::query_as::<_, UserRow>(
                r#"
                SELECT
                    id,
                    email,
                    username,
                    password,
                    color,
                    role,
                    "canReadAllRooms" as can_read_all_rooms,
                    "canWriteAllRooms" as can_write_all_rooms,
                    "canDeleteAllRooms" as can_delete_all_rooms,
                    "isDeleted" as is_deleted,
                    "createdAt" as created_at,
                    "lastSeen" as last_seen
                FROM "User"
                WHERE id = $1
                "#,
            )
            .bind(&user_payload.user_id)
            .fetch_optional(&app_state.db)
            .await
            .map_err(|err| db_error(err, "Failed to load user"))?;

            let user = match user {
                Some(user) => user,
                None => return Err(ApiError::unauthorized("Invalid token")),
            };

            if user.is_deleted {
                return Err(ApiError::unauthorized("Invalid token"));
            }

            Ok(AuthUser {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                can_read_all_rooms: user.can_read_all_rooms,
                can_write_all_rooms: user.can_write_all_rooms,
                can_delete_all_rooms: user.can_delete_all_rooms,
            })
        }
    }
}

impl<S> FromRequestParts<S> for AdminUser
where
    S: Send + Sync,
    AppState: axum::extract::FromRef<S>,
{
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let user = AuthUser::from_request_parts(parts, state).await?;
            if user.role != "admin" && user.role != "superuser" {
                return Err(ApiError::not_found("Not found"));
            }
            Ok(AdminUser(user))
        }
    }
}
