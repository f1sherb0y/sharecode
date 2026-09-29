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
    pub device_id: Option<uuid::Uuid>,
    pub fingerprint: Option<String>,
    pub new_device: bool,
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
            device_id: parts
                .headers
                .get("x-device-id")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| uuid::Uuid::parse_str(v).ok()),
            fingerprint: parts
                .headers
                .get("x-device-fingerprint")
                .and_then(|v| v.to_str().ok())
                .filter(|v| valid_fingerprint(v))
                .map(str::to_owned),
            new_device: false,
        })
    }
}

// Advisory, client-provided identifiers, never authorization evidence.
fn valid_fingerprint(value: &str) -> bool {
    value
        .strip_prefix("fp5:")
        .is_some_and(|hash| hash.len() == 32 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub async fn identify_login_device(
    tx: &mut sqlx::PgConnection,
    client: &mut ClientInfo,
    user_id: &str,
) -> Result<(), ApiError> {
    let Some(device_id) = client.device_id else {
        return Ok(());
    };
    let inserted = sqlx::query(
        r#"INSERT INTO "UserDevice" ("userId", "deviceId", fingerprint,"userAgent","lastIp")
        VALUES ($1,$2,$3,$4,$5::inet) ON CONFLICT DO NOTHING"#,
    )
    .bind(user_id)
    .bind(device_id)
    .bind(&client.fingerprint)
    .bind(&client.user_agent)
    .bind(client.ip.to_string())
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::db::db_error(e, "Failed to register login device"))?;
    client.new_device = inserted.rows_affected() == 1;
    if !client.new_device {
        sqlx::query(r#"UPDATE "UserDevice" SET "lastSeen"=NOW(), fingerprint=COALESCE($3, fingerprint), "userAgent"=$4,"lastIp"=$5::inet,"loginCount"="loginCount"+1
            WHERE "userId"=$1 AND "deviceId"=$2"#)
            .bind(user_id).bind(device_id).bind(&client.fingerprint).bind(&client.user_agent).bind(client.ip.to_string()).execute(tx).await
            .map_err(|e| crate::db::db_error(e, "Failed to update login device"))?;
    }
    Ok(())
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
    record_details(
        executor,
        client,
        action,
        actor,
        username,
        target,
        success,
        reason,
        None,
        json!({}),
    )
    .await
}

pub async fn record_details<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    client: &ClientInfo,
    action: &str,
    actor: Option<&str>,
    username: Option<&str>,
    target: Option<&str>,
    success: bool,
    reason: Option<&str>,
    room_id: Option<&str>,
    details: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(r#"INSERT INTO "AuditEvent" (action,"actorId",username,"targetId",success,"clientIp","peerIp","ipSource","userAgent","requestId",reason,"deviceId",fingerprint,"newDevice","roomId",details)
        VALUES ($1,$2,$3,$4,$5,$6::inet,$7::inet,$8,$9,$10,$11,$12,$13,$14,$15,$16)"#)
        .bind(action).bind(actor).bind(username.map(|s|s.chars().take(128).collect::<String>()))
        .bind(target).bind(success).bind(client.ip.to_string()).bind(client.peer.to_string())
        .bind(client.source).bind(&client.user_agent).bind(&client.request_id).bind(reason)
        .bind(client.device_id).bind(&client.fingerprint).bind(client.new_device).bind(room_id).bind(details)
        .execute(executor).await.map_err(|e|{tracing::error!(%e, action, "audit write failed");ApiError::service_unavailable("Audit storage unavailable; retry later")})?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub action: Option<String>,
    pub username: Option<String>,
    pub start: Option<chrono::DateTime<chrono::Utc>>,
    pub end: Option<chrono::DateTime<chrono::Utc>>,
    pub snapshot: Option<i64>,
    pub device_id: Option<uuid::Uuid>,
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
    device_id: Option<uuid::Uuid>,
    fingerprint: Option<String>,
    new_device: bool,
    details: serde_json::Value,
}
pub async fn list_events(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    Query(query): Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if user.role != "superuser" && query.device_id.is_some() {
        return Err(ApiError::not_found("Not found"));
    }
    if query
        .start
        .zip(query.end)
        .is_some_and(|(start, end)| start > end)
    {
        return Err(ApiError::bad_request("Start must be before end"));
    }
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| crate::db::db_error(e, "Failed to load audit"))?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(|e| crate::db::db_error(e, "Failed to load audit"))?;
    let snapshot = match query.snapshot {
        Some(id) if id >= 0 => id,
        Some(_) => return Err(ApiError::bad_request("Invalid audit snapshot")),
        None => sqlx::query_scalar::<_, i64>(r#"SELECT COALESCE(MAX(id),0) FROM "AuditEvent""#)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| crate::db::db_error(e, "Failed to load audit"))?,
    };
    let action = query.action.filter(|s| !s.is_empty());
    let username = query.username.filter(|s| !s.is_empty());
    // Audit must not become a side channel into inaccessible private rooms.
    let filter = r#"FROM "AuditEvent" a WHERE a.id <= $1
        AND ($2::text IS NULL OR a.action=$2) AND ($3::text IS NULL OR a.username=$3)
        AND ($4::timestamptz IS NULL OR a."createdAt">=$4) AND ($5::timestamptz IS NULL OR a."createdAt"<=$5)
        AND ($6::uuid IS NULL OR a."deviceId"=$6)
        AND (a."roomId" IS NULL OR EXISTS (
            SELECT 1 FROM "Room" r JOIN "User" o ON o.id=r."ownerId" WHERE r.id=a."roomId"
            AND (NOT r."isPrivate" OR room_is_visible($7,$8,$9,r."ownerId",o.role,true,r."isEnded",false,
                EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId"=r.id AND p."userId"=$7),false))
        ))"#;
    macro_rules! bindings {
        ($q:expr) => {
            $q.bind(snapshot)
                .bind(&action)
                .bind(&username)
                .bind(query.start)
                .bind(query.end)
                .bind(query.device_id)
                .bind(&user.id)
                .bind(&user.role)
                .bind(crate::permissions::has_global_read(&user))
        };
    }
    let total = bindings!(sqlx::query_scalar::<_, i64>(&format!(
        "SELECT COUNT(*) {filter}"
    )))
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| crate::db::db_error(e, "Failed to count audit events"))?;
    let size = query.page_size.unwrap_or(25).clamp(1, 100) as i64;
    let pages = (total + size - 1) / size;
    let page = (query.page.unwrap_or(1).max(1) as i64).min(pages.max(1));
    let rows = bindings!(sqlx::query_as::<_,AuditRow>(&format!(r#"SELECT a.id,a."createdAt" as created_at,a.action,a."actorId" as actor_id,a.username,a."targetId" as target_id,
        a.success,host(a."clientIp") as client_ip,host(a."peerIp") as peer_ip,a."ipSource" as ip_source,a."userAgent" as user_agent,a."requestId" as request_id,a.reason,
        CASE WHEN $8 = 'superuser' THEN a."deviceId" END as device_id,
        CASE WHEN $8 = 'superuser' THEN a.fingerprint END as fingerprint,
        ($8 = 'superuser' AND a."newDevice") as new_device,a.details
        {filter} ORDER BY a."createdAt" DESC,a.id DESC LIMIT $10 OFFSET $11"#)))
        .bind(size).bind((page-1)*size).fetch_all(&mut *tx).await.map_err(|e|crate::db::db_error(e,"Failed to load audit events"))?;
    tx.commit()
        .await
        .map_err(|e| crate::db::db_error(e, "Failed to load audit events"))?;
    Ok(Json(
        json!({"events":rows,"snapshot":snapshot,"pagination":{"page":page,"pageSize":size,"total":total,"totalPages":pages,"hasNext":page<pages,"hasPrev":page>1}}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_versioned_fingerprint_hash_only() {
        assert!(valid_fingerprint("fp5:0123456789abcdef0123456789abcdef"));
        for invalid in [
            "",
            "fp4:0123456789abcdef0123456789abcdef",
            "fp5:short",
            "fp5:0123456789abcdef0123456789abcdeg",
        ] {
            assert!(!valid_fingerprint(invalid));
        }
    }
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

#[derive(sqlx::FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRow {
    device_id: uuid::Uuid,
    fingerprint: Option<String>,
    user_agent: String,
    last_ip: String,
    first_seen: chrono::DateTime<chrono::Utc>,
    last_seen: chrono::DateTime<chrono::Utc>,
    login_count: i64,
}
pub async fn list_user_devices(
    State(state): State<AppState>,
    AdminUser(actor): AdminUser,
    axum::extract::Path(user_id): axum::extract::Path<String>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if actor.role != "superuser" {
        return Err(ApiError::not_found("Not found"));
    }
    sqlx::query_scalar::<_, i32>(r#"SELECT 1 FROM "User" WHERE id=$1 AND NOT "isDeleted""#)
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| crate::db::db_error(e, "Failed to load user"))?
        .ok_or_else(|| ApiError::not_found("User not found"))?;
    let size = query.page_size.unwrap_or(10).clamp(1, 100) as i64;
    let total =
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "UserDevice" WHERE "userId"=$1"#)
            .bind(&user_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| crate::db::db_error(e, "Failed to load devices"))?;
    let pages = (total + size - 1) / size;
    let page = (query.page.unwrap_or(1).max(1) as i64).min(pages.max(1));
    let rows = sqlx::query_as::<_,DeviceRow>(r#"SELECT "deviceId" as device_id,fingerprint,"userAgent" as user_agent,
        host("lastIp") as last_ip,"firstSeen" as first_seen,"lastSeen" as last_seen,"loginCount" as login_count
        FROM "UserDevice" WHERE "userId"=$1 ORDER BY "lastSeen" DESC,"deviceId" LIMIT $2 OFFSET $3"#)
        .bind(&user_id).bind(size).bind((page-1)*size).fetch_all(&state.db).await.map_err(|e|crate::db::db_error(e,"Failed to load devices"))?;
    Ok(Json(
        json!({"devices":rows,"pagination":{"page":page,"pageSize":size,"total":total,"totalPages":pages,"hasNext":page<pages,"hasPrev":page>1}}),
    ))
}
