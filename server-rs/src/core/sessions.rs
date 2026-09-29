use axum::http::{header, HeaderMap, HeaderValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cookie::{Cookie, SameSite};
use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{config::Config, db::db_error, error::ApiError, models::UserRow};

pub const SESSION_DAYS: i64 = 30;

pub fn allowed_origin(config: &Config, origin: &str) -> bool {
    // Exact origins, never suffix checks or reflection of an arbitrary caller.
    config.frontend_url.iter().chain(config.app_url.iter()).chain(config.allowed_origins.iter()).any(|value| {
        value.split(',').any(|url| url::Url::parse(url.trim()).is_ok_and(|u| u.origin().ascii_serialization() == origin))
    }) || matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
}

pub fn check_origin(config: &Config, headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin.to_str().is_ok_and(|value| allowed_origin(config, value)) {
            return Err(ApiError::forbidden("Untrusted request origin"));
        }
    }
    Ok(())
}

pub fn check_cookie_request(config: &Config, headers: &HeaderMap) -> Result<(), ApiError> {
    check_origin(config, headers)?;
    // A custom header requires CORS preflight and cannot be sent by HTML forms.
    if headers.get("x-sharecode-client").and_then(|v| v.to_str().ok()) != Some("web") {
        return Err(ApiError::forbidden("Missing session request header"));
    }
    Ok(())
}

fn secure(config: &Config) -> bool {
    // Only explicit HTTP loopback development may use an insecure cookie.
    !config.app_url.as_ref().or(config.frontend_url.as_ref()).is_some_and(|value| {
        url::Url::parse(value).is_ok_and(|url| url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    })
}

fn cookie_name(config: &Config) -> &'static str {
    if secure(config) { "__Host-sharecode-session" } else { "sharecode-session" }
}

pub fn cookie_header(config: &Config, secret: &str) -> HeaderValue {
    let value = Cookie::build((cookie_name(config), secret))
        .http_only(true).secure(secure(config)).same_site(SameSite::Lax).path("/")
        .max_age(cookie::time::Duration::days(if secret.is_empty() { 0 } else { SESSION_DAYS }))
        .build().to_string();
    HeaderValue::from_str(&value).expect("Generated cookie contains only URL-safe characters")
}

pub fn cookie_secret(config: &Config, headers: &HeaderMap) -> Option<String> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        for cookie in Cookie::split_parse(header.to_str().ok()?) {
            let cookie = cookie.ok()?;
            if cookie.name() == cookie_name(config) {
                let value = cookie.value();
                if found.is_some() || value.len() != 43 || !value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { return None; }
                found = Some(value.to_owned());
            }
        }
    }
    found
}

pub fn secret_hash(secret: &str) -> Vec<u8> { Sha256::digest(secret.as_bytes()).to_vec() }

pub async fn create(tx: &mut Transaction<'_, Postgres>, user: &UserRow, device_id: Option<Uuid>) -> Result<(String, String), ApiError> {
    let secret = URL_SAFE_NO_PAD.encode(rand::rng().random::<[u8; 32]>());
    let id = Uuid::new_v4().to_string();
    sqlx::query(r#"INSERT INTO "BrowserSession" (id,"userId","secretHash","tokenVersion","deviceId","expiresAt")
        VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '30 days')"#)
        .bind(&id).bind(&user.id).bind(secret_hash(&secret)).bind(user.token_version).bind(device_id)
        .execute(&mut **tx).await.map_err(|e| db_error(e, "Failed to create browser session"))?;
    // Expired rows have no authentication value; the expiry index bounds cleanup.
    sqlx::query(r#"DELETE FROM "BrowserSession" WHERE "expiresAt" <= NOW()"#)
        .execute(&mut **tx).await.map_err(|e| db_error(e, "Failed to remove expired browser sessions"))?;
    Ok((id, secret))
}

pub async fn load_user(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<UserRow, ApiError> {
    sqlx::query_as::<_, UserRow>(r#"SELECT id,email,username,password,color,role,
        "canReadAllRooms" AS can_read_all_rooms,"canWriteAllRooms" AS can_write_all_rooms,
        "canDeleteAllRooms" AS can_delete_all_rooms,"isDeleted" AS is_deleted,
        "createdAt" AS created_at,"tokenVersion" AS token_version,"lastSeen" AS last_seen
        FROM "User" WHERE id=$1 AND NOT "isDeleted" FOR SHARE"#)
        .bind(id).fetch_optional(&mut **tx).await.map_err(|e| db_error(e,"Failed to load session user"))?
        .ok_or_else(|| ApiError::unauthorized("Session expired"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_cookie_is_http_only_secure_host_scoped_and_expiring() {
        let mut config = Config::from_env();
        config.app_url = Some("https://collabcode.cc".into());
        let cookie = cookie_header(&config, "test-secret");
        let cookie = Cookie::parse(cookie.to_str().unwrap()).unwrap();
        assert_eq!(cookie.name(), "__Host-sharecode-session");
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.domain(), None);
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.max_age().unwrap().whole_days(), 30);
        assert!(cookie_header(&config, "").to_str().unwrap().contains("Max-Age=0"));
    }

    #[test]
    fn cookie_csrf_requires_exact_trusted_origin_and_non_simple_header() {
        let mut config = Config::from_env();
        config.app_url = Some("https://collabcode.cc".into());
        let mut headers = HeaderMap::new();
        assert!(check_cookie_request(&config, &headers).is_err());
        headers.insert("x-sharecode-client", "web".parse().unwrap());
        headers.insert(header::ORIGIN, "https://collabcode.cc".parse().unwrap());
        assert!(check_cookie_request(&config, &headers).is_ok());
        for origin in ["null", "https://collabcode.cc.evil.invalid", "https://evil.invalid", "http://collabcode.cc"] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(check_cookie_request(&config, &headers).is_err());
        }
        config.allowed_origins = vec!["https://kode666.com".into(), "https://64.186.229.171/".into()];
        for origin in ["https://kode666.com", "https://64.186.229.171", "https://collabcode.cc"] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(check_cookie_request(&config, &headers).is_ok(), "{origin}");
        }
        for origin in ["http://kode666.com", "https://www.kode666.com", "https://64.186.229.171:8443", "https://kode666.com.evil.invalid"] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(check_cookie_request(&config, &headers).is_err(), "{origin}");
        }
        config.app_url = Some("http://127.0.0.1:5173".into());
        assert!(!secure(&config));
        config.app_url = Some("http://example.com".into());
        assert!(secure(&config));
    }
}
