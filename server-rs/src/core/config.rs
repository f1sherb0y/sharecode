use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub bind_address: std::net::IpAddr,
    pub trusted_proxy_cidrs: Vec<String>,
    pub database_url: String,
    pub jwt_secret: String,
    pub frontend_url: Option<String>,
    pub app_url: Option<String>,
    /// Extra exact origins (other domains, the public IP) that serve the same app.
    pub allowed_origins: Vec<String>,
    pub frontend_hash_router: bool,
    pub log_level: String,
    pub piston_url: String,
    pub admin_username: String,
    pub admin_password: String,
    pub admin_email: String,
    pub admin_update_password: bool,
    /// Where uploaded desktop client installers and update bundles are kept.
    pub client_releases_dir: std::path::PathBuf,
    /// The desktop client's update signing public key (`plugins.updater.pubkey` in its
    /// tauri.conf.json). Uploaded signatures are checked against it, as the client does.
    pub client_updater_pubkey: String,
    /// SHA-256 of the token the release workflow (CI) presents to open drafts and upload their
    /// files (`CLIENT_RELEASES_CI_TOKEN_SHA256`, hex). Unset: no CI uploads.
    pub client_releases_ci_token_sha256: Option<[u8; 32]>,
}

/// The public key the desktop client trusts; keep in sync with
/// frontend/src-tauri-client/tauri.conf.json (a test checks this).
pub const CLIENT_UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZFQzk4NDk1Mzg3RTQ1MUYKUldRZlJYNDRsWVRKL3JtQXFGMlc2YWZSL2M3eUpQQ0dCTm8vdDg4S1A0dGw5am9wN1U3NzNjNzEK";

impl Config {
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(3001);

        let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgresql://sharecode:sharecode@localhost:5432/sharecode".to_string()
        });

        let jwt_secret = env::var("JWT_SECRET")
            .unwrap_or_else(|_| "dev-jwt-secret-change-this-in-production-please".to_string());

        let frontend_url = env::var("FRONTEND_URL").ok();
        let app_url = env::var("APP_URL").ok();
        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let frontend_hash_router = env_bool("FRONTEND_HASH_ROUTER", false);

        let log_level = env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        let piston_url =
            env::var("PISTON_URL").unwrap_or_else(|_| "http://localhost:2000".to_string());

        let admin_username = env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
        let admin_password =
            env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "ChangeMe123!".to_string());
        let admin_email =
            env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@sharecode.local".to_string());
        let admin_update_password = env_bool("ADMIN_UPDATE_PASSWORD", false);
        let client_releases_dir = env::var("CLIENT_RELEASES_DIR")
            .unwrap_or_else(|_| "data/client-releases".to_string())
            .into();
        let client_updater_pubkey = env::var("CLIENT_UPDATER_PUBKEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| CLIENT_UPDATER_PUBKEY.to_string());
        let client_releases_ci_token_sha256 = env::var("CLIENT_RELEASES_CI_TOKEN_SHA256")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .and_then(|value| parse_sha256_hex(&value));

        Self {
            port,
            bind_address: env::var("BIND_ADDRESS")
                .unwrap_or_else(|_| "0.0.0.0".into())
                .parse()
                .expect("Invalid BIND_ADDRESS"),
            trusted_proxy_cidrs: env::var("TRUSTED_PROXY_CIDRS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            database_url,
            jwt_secret,
            frontend_url,
            app_url,
            allowed_origins,
            frontend_hash_router,
            log_level,
            piston_url,
            admin_username,
            admin_password,
            admin_email,
            admin_update_password,
            client_releases_dir,
            client_updater_pubkey,
            client_releases_ci_token_sha256,
        }
    }
}

/// A SHA-256 digest written as 64 hex digits.
pub fn parse_sha256_hex(value: &str) -> Option<[u8; 32]> {
    hex::decode(value.trim()).ok()?.try_into().ok()
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(value) => parse_bool(&value),
        Err(_) => default,
    }
}

fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}
