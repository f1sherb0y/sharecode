mod core;
mod db;
mod routes;
mod utils;
mod ws;

pub use core::{admin, auth, config, error, permissions, room_activity, share_links, state};
pub use db::models;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{Request, Response};
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::Span;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let config = Arc::new(Config::from_env());

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        let default_filter = format!(
            "sharecode_server={},sqlx=warn,sqlx_postgres=warn,sqlx_core=warn",
            config.log_level
        );
        EnvFilter::new(default_filter)
    });
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&strip_unsupported_params(&config.database_url))
        .await?;

    // Keep the embedded sqlx migration set in sync with the migrations directory.
    tracing::info!("Running database migrations");
    sqlx::migrate!("./migrations").run(&db).await?;
    tracing::info!("Database migrations complete");

    let ws = Arc::new(ws::WsState::new());

    let state = AppState {
        config: Arc::clone(&config),
        db,
        ws,
    };

    if let Err(err) = admin::initialize_admin(&state).await {
        tracing::error!(error = %err, "Failed to initialize admin user");
    }

    room_activity::spawn_inactive_room_cleanup(state.clone());
    share_links::spawn_expired_share_link_cleanup(state.db.clone());

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(true)
        .allow_headers(AllowHeaders::mirror_request())
        .allow_methods(AllowMethods::mirror_request());

    let trace = TraceLayer::new_for_http()
        .make_span_with(|request: &Request<_>| {
            tracing::info_span!(
                "http",
                method = %request.method(),
                path = %request.uri().path()
            )
        })
        .on_response(|response: &Response<_>, latency: Duration, span: &Span| {
            tracing::info!(
                parent: span,
                status = %response.status(),
                latency_ms = latency.as_millis(),
                "request"
            );
        });

    let app = routes::router(state).layer(cors).layer(trace);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!(%addr, "sharecode server-rs listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Strip query parameters not recognized by libpq (e.g. `schema` added by Prisma)
/// to avoid sqlx warnings at connect time.
fn strip_unsupported_params(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let cleaned: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "schema")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if cleaned.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.set_query(None);
        let mut pairs = parsed.query_pairs_mut();
        for (k, v) in &cleaned {
            pairs.append_pair(k, v);
        }
    }
    parsed.to_string()
}
