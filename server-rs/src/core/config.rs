use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub frontend_url: Option<String>,
    pub app_url: Option<String>,
    pub frontend_hash_router: bool,
    pub allow_registration: bool,
    pub log_level: String,
    pub piston_url: String,
    pub admin_username: String,
    pub admin_password: String,
    pub admin_email: String,
    pub admin_update_password: bool,
}

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
        let frontend_hash_router = env_bool("FRONTEND_HASH_ROUTER", false);
        let allow_registration = env_bool("ALLOW_REGISTRATION", true);

        let log_level = env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        let piston_url =
            env::var("PISTON_URL").unwrap_or_else(|_| "http://localhost:2000".to_string());

        let admin_username = env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
        let admin_password = env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin123".to_string());
        let admin_email =
            env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@sharecode.local".to_string());
        let admin_update_password = env_bool("ADMIN_UPDATE_PASSWORD", false);

        Self {
            port,
            database_url,
            jwt_secret,
            frontend_url,
            app_url,
            frontend_hash_router,
            allow_registration,
            log_level,
            piston_url,
            admin_username,
            admin_password,
            admin_email,
            admin_update_password,
        }
    }
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
