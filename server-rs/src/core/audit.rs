use crate::{auth::AdminUser, error::ApiError, state::AppState};
use axum::{
    extract::{ConnectInfo, FromRef, FromRequestParts, Query, State},
    http::{request::Parts, HeaderMap},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{Executor, Postgres};
use std::net::{IpAddr, SocketAddr};

#[derive(Clone, Debug)]
pub struct ClientInfo {
    pub ip: IpAddr,
    pub peer: IpAddr,
    pub source: &'static str,
    pub user_agent: String,
    pub request_id: String,
}
impl<S> FromRequestParts<S> for ClientInfo
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let app = AppState::from_ref(state);
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .ok_or_else(|| ApiError::internal("Missing peer address"))?
            .0
            .ip();
        let (ip, source) = client_ip(peer, &parts.headers, &app.config.trusted_proxy_cidrs);
        Ok(Self {
            ip,
            peer,
            source,
            user_agent: parts
                .headers
                .get("user-agent")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .chars()
                .take(512)
                .collect(),
            request_id: uuid::Uuid::new_v4().to_string(),
        })
    }
}

fn in_network(ip: IpAddr, cidr: &str) -> bool {
    let (network, prefix) = cidr
        .split_once('/')
        .unwrap_or((cidr, if cidr.contains(':') { "128" } else { "32" }));
    match (ip, network.parse::<IpAddr>(), prefix.parse::<u32>()) {
        (IpAddr::V4(ip), Ok(IpAddr::V4(net)), Ok(n)) if n <= 32 => {
            n == 0 || (u32::from(ip) >> (32 - n)) == (u32::from(net) >> (32 - n))
        }
        (IpAddr::V6(ip), Ok(IpAddr::V6(net)), Ok(n)) if n <= 128 => {
            n == 0 || (u128::from(ip) >> (128 - n)) == (u128::from(net) >> (128 - n))
        }
        _ => false,
    }
}
fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[String]) -> (IpAddr, &'static str) {
    let is_trusted = |ip| trusted.iter().any(|cidr| in_network(ip, cidr));
    if !is_trusted(peer) {
        return (peer, "socket");
    }
    let mut hops = Vec::new();
    for header in headers.get_all("x-forwarded-for") {
        let Ok(raw) = header.to_str() else {
            return (peer, "socket-invalid-forwarded");
        };
        for hop in raw.split(',') {
            let Ok(ip) = hop.trim().parse::<IpAddr>() else {
                return (peer, "socket-invalid-forwarded");
            };
            hops.push(ip);
            if hops.len() > 32 {
                return (peer, "socket-invalid-forwarded");
            }
        }
    }
    if hops.is_empty() {
        return (peer, "socket");
    }
    let mut current = peer;
    for hop in hops.into_iter().rev() {
        if !is_trusted(current) {
            break;
        }
        current = hop;
    }
    (current, "trusted-proxy")
}

// Call inside the mutation transaction where applicable. No password, token,
// authorization header, email, or request body is ever captured.
pub async fn record<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    client: &ClientInfo,
    action: &str,
    actor: Option<&str>,
    username: Option<&str>,
    target: Option<&str>,
    success: bool,
    reason: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query(r#"INSERT INTO "AuditEvent" (action,"actorId",username,"targetId",success,"clientIp","peerIp","ipSource","userAgent","requestId",reason)
        VALUES ($1,$2,$3,$4,$5,$6::inet,$7::inet,$8,$9,$10,$11)"#)
        .bind(action).bind(actor).bind(username.map(|s|s.chars().take(128).collect::<String>()))
        .bind(target).bind(success).bind(client.ip.to_string()).bind(client.peer.to_string())
        .bind(client.source).bind(&client.user_agent).bind(&client.request_id).bind(reason)
        .execute(executor).await.map_err(|e|{tracing::error!(%e, action, "audit write failed");ApiError::service_unavailable("Audit storage unavailable; retry later")})?;
    Ok(())
}

#[derive(Deserialize)]
pub struct AuditQuery {
    pub before: Option<i64>,
    pub action: Option<String>,
    pub username: Option<String>,
}
#[derive(sqlx::FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRow {
    id: i64,
    created_at: chrono::DateTime<chrono::Utc>,
    action: String,
    actor_id: Option<String>,
    username: Option<String>,
    target_id: Option<String>,
    success: bool,
    client_ip: String,
    peer_ip: String,
    ip_source: String,
    user_agent: String,
    request_id: String,
    reason: Option<String>,
}
pub async fn list_events(
    State(state): State<AppState>,
    AdminUser(_user): AdminUser,
    Query(query): Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows=sqlx::query_as::<_,AuditRow>(r#"SELECT id,"createdAt" as created_at,action,"actorId" as actor_id,username,"targetId" as target_id,
        success,host("clientIp") as client_ip,host("peerIp") as peer_ip,"ipSource" as ip_source,"userAgent" as user_agent,"requestId" as request_id,reason
        FROM "AuditEvent" WHERE ($1::bigint IS NULL OR id < $1) AND ($2::text IS NULL OR action=$2)
        AND ($3::text IS NULL OR username=$3) ORDER BY id DESC LIMIT 51"#)
        .bind(query.before).bind(query.action.filter(|s|!s.is_empty())).bind(query.username.filter(|s|!s.is_empty()))
        .fetch_all(&state.db).await.map_err(|_|ApiError::internal("Failed to load audit events"))?;
    let has_more = rows.len() > 50;
    let rows: Vec<_> = rows.into_iter().take(50).collect();
    let next = if has_more {
        rows.last().map(|r| r.id)
    } else {
        None
    };
    Ok(Json(json!({"events":rows,"nextCursor":next})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_forged_forwarding_from_untrusted_peers() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        assert_eq!(
            client_ip("203.0.113.4".parse().unwrap(), &h, &[]).0,
            "203.0.113.4".parse::<IpAddr>().unwrap()
        );
    }
    #[test]
    fn walks_only_trusted_suffix_handles_ipv6_and_invalid_headers() {
        let trusted = vec!["127.0.0.1/32".into(), "10.0.0.0/24".into()];
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "1.2.3.4, 2001:db8::7, 10.0.0.8".parse().unwrap(),
        );
        assert_eq!(
            client_ip("127.0.0.1".parse().unwrap(), &h, &trusted).0,
            "2001:db8::7".parse::<IpAddr>().unwrap()
        );
        h.insert("x-forwarded-for", "invalid".parse().unwrap());
        assert_eq!(
            client_ip("127.0.0.1".parse().unwrap(), &h, &trusted).1,
            "socket-invalid-forwarded"
        );
    }
}
