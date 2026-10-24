use std::io::Read;
use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Multipart, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Utc};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

use crate::core::audit::{self, ClientInfo};
use crate::{
    auth::{AdminUser, AuthUser},
    config::Config,
    db::db_error,
    error::ApiError,
    state::AppState,
    utils::time::{to_iso_string, to_iso_string_opt},
};

// Desktop client releases, like GitHub releases: an admin creates a draft for a version,
// uploads its files per platform and publishes it. Published releases are frozen (unpublish to
// change one). The download page offers each platform's newest installer, and the client's
// updater (tauri-plugin-updater) asks the update endpoint, a Tauri "dynamic update server",
// for the newest signed update. Files are kept on disk under CLIENT_RELEASES_DIR, named by
// asset ID; the database keeps their names, sizes, SHA-256 and update signatures.

/// Tauri's `{target}-{arch}` platform names.
pub const PLATFORMS: &[&str] = &[
    "windows-x86_64",
    "windows-aarch64",
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "linux-aarch64",
];
const KINDS: &[&str] = &["installer", "update"];
/// What the Tauri bundler makes: Windows NSIS/MSI, macOS dmg and .app.tar.gz, Linux
/// AppImage/deb/rpm, and the zipped/tarred updater bundles of older Tauri versions.
const FILE_EXTENSIONS: &[&str] = &[".exe", ".msi", ".dmg", ".tar.gz", ".zip", ".appimage", ".deb", ".rpm"];
/// A Linux AppImage is around 100 MB; leave room for growth.
pub const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
/// The upload request: the file plus the other form fields.
pub const MAX_UPLOAD_BYTES: usize = MAX_ASSET_BYTES as usize + 1024 * 1024;
const MAX_NOTES_CHARS: usize = 10_000;
const MAX_SIGNATURE_CHARS: usize = 4096;
const MAX_FILE_NAME_CHARS: usize = 200;

#[derive(Debug, sqlx::FromRow)]
struct ReleaseRow {
    id: String,
    version: String,
    notes: String,
    published_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    created_by: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AssetRow {
    id: String,
    release_id: String,
    platform: String,
    kind: String,
    file_name: String,
    size: i64,
    sha256: String,
    signature: Option<String>,
    created_at: DateTime<Utc>,
}

const RELEASE_COLUMNS: &str = r#"r.id, r.version, r.notes, r."publishedAt" as published_at,
    r."createdAt" as created_at, r."updatedAt" as updated_at, u.username as created_by"#;
const ASSET_COLUMNS: &str = r#"a.id, a."releaseId" as release_id, a.platform, a.kind, a."fileName" as file_name,
    a.size, a.sha256, a.signature, a."createdAt" as created_at"#;

fn parse_version(value: &str) -> Result<Version, ApiError> {
    Version::parse(value.trim())
        .map_err(|_| ApiError::bad_request("Version must be a semantic version such as 1.2.3"))
}

fn release_version(release: &ReleaseRow) -> Version {
    // Stored versions were validated on creation.
    Version::parse(&release.version).unwrap_or_else(|_| Version::new(0, 0, 0))
}

/// The last path component of an uploaded file name, without control characters.
fn sanitize_file_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_FILE_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty() && cleaned != "." && cleaned != "..").then_some(cleaned)
}

fn has_release_extension(file_name: &str) -> bool {
    let name = file_name.to_ascii_lowercase();
    FILE_EXTENSIONS.iter().any(|extension| name.ends_with(extension))
}

fn decode_base64_text(value: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(value.trim()).ok()?;
    String::from_utf8(bytes).ok()
}

/// A Tauri `.sig` file: a base64-encoded minisign signature.
fn parse_signature(value: &str) -> Result<(String, Signature), ApiError> {
    let invalid = || ApiError::bad_request("The signature must be the content of the .sig file");
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SIGNATURE_CHARS {
        return Err(invalid());
    }
    let signature = decode_base64_text(value)
        .and_then(|text| Signature::decode(&text).ok())
        .ok_or_else(invalid)?;
    Ok((value.to_string(), signature))
}

fn updater_public_key(config: &Config) -> Result<PublicKey, ApiError> {
    decode_base64_text(&config.client_updater_pubkey)
        .and_then(|text| PublicKey::decode(&text).ok())
        .ok_or_else(|| {
            tracing::error!("CLIENT_UPDATER_PUBKEY is not a Tauri updater public key");
            ApiError::internal("The update signing key is misconfigured")
        })
}

/// The check tauri-plugin-updater makes before installing an update, so a release only offers
/// updates the client accepts. Streams the file: Tauri signs a BLAKE2b prehash.
fn verify_signature(public_key: &PublicKey, signature: &Signature, path: &FsPath) -> Result<(), ApiError> {
    let mismatch = || {
        ApiError::bad_request("The signature does not match this file or was not made with the client's signing key")
    };
    let mut verifier = public_key.verify_stream(signature).map_err(|_| mismatch())?;
    let mut file = std::fs::File::open(path).map_err(storage_error)?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(storage_error)?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize().map_err(|_| mismatch())
}

fn asset_path(config: &Config, asset_id: &str) -> PathBuf {
    config.client_releases_dir.join(asset_id)
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// The file's public URL path. Ending in the file name keeps it for browsers and download
/// managers that name files after the URL.
fn download_path(asset: &AssetRow) -> String {
    format!("/api/client/downloads/{}/{}", asset.id, encode_path_segment(&asset.file_name))
}

/// The configured origin (APP_URL, FRONTEND_URL, ALLOWED_ORIGINS) the request came in on, so
/// a client updates through the node it reached; otherwise the main one.
fn public_origin(config: &Config, headers: &HeaderMap) -> Option<String> {
    let origins: Vec<url::Url> = config
        .app_url
        .iter()
        .chain(config.frontend_url.iter())
        .chain(config.allowed_origins.iter())
        .flat_map(|value| value.split(','))
        .filter_map(|value| url::Url::parse(value.trim()).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        .collect();
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok());
    let authority = |url: &url::Url| match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    origins
        .iter()
        .find(|url| host.is_some_and(|host| authority(url).eq_ignore_ascii_case(host)))
        .or(origins.first())
        .map(|url| url.origin().ascii_serialization())
}

fn asset_json(asset: &AssetRow) -> Value {
    json!({
        "id": asset.id,
        "platform": asset.platform,
        "kind": asset.kind,
        "fileName": asset.file_name,
        "size": asset.size,
        "sha256": asset.sha256,
        "signed": asset.signature.is_some(),
        "createdAt": to_iso_string(asset.created_at),
        "downloadUrl": download_path(asset),
    })
}

fn release_json(release: &ReleaseRow, assets: &[AssetRow]) -> Value {
    json!({
        "id": release.id,
        "version": release.version,
        "notes": release.notes,
        "publishedAt": to_iso_string_opt(release.published_at),
        "createdAt": to_iso_string(release.created_at),
        "updatedAt": to_iso_string(release.updated_at),
        "createdBy": release.created_by,
        "assets": assets.iter().filter(|a| a.release_id == release.id).map(asset_json).collect::<Vec<_>>(),
    })
}

/// Releases, newest version first, with their files.
async fn load_releases(state: &AppState, published_only: bool) -> Result<(Vec<ReleaseRow>, Vec<AssetRow>), ApiError> {
    let filter = if published_only { r#"WHERE r."publishedAt" IS NOT NULL"# } else { "" };
    let mut releases = sqlx::query_as::<_, ReleaseRow>(&format!(
        r#"SELECT {RELEASE_COLUMNS} FROM "ClientRelease" r LEFT JOIN "User" u ON u.id = r."createdBy" {filter}"#
    ))
    .fetch_all(&state.db)
    .await
    .map_err(|e| db_error(e, "Failed to load client releases"))?;
    releases.sort_by(|a, b| release_version(b).cmp(&release_version(a)));
    let assets = sqlx::query_as::<_, AssetRow>(&format!(
        r#"SELECT {ASSET_COLUMNS} FROM "ClientReleaseAsset" a JOIN "ClientRelease" r ON r.id = a."releaseId" {filter}
        ORDER BY a.platform, a.kind"#
    ))
    .fetch_all(&state.db)
    .await
    .map_err(|e| db_error(e, "Failed to load client release files"))?;
    Ok((releases, assets))
}

async fn load_release(executor: impl sqlx::PgExecutor<'_>, id: &str, lock: bool) -> Result<ReleaseRow, ApiError> {
    let lock = if lock { "FOR UPDATE OF r" } else { "" };
    sqlx::query_as::<_, ReleaseRow>(&format!(
        r#"SELECT {RELEASE_COLUMNS} FROM "ClientRelease" r LEFT JOIN "User" u ON u.id = r."createdBy"
        WHERE r.id = $1 {lock}"#
    ))
    .bind(id)
    .fetch_optional(executor)
    .await
    .map_err(|e| db_error(e, "Failed to load client release"))?
    .ok_or_else(|| ApiError::not_found("Release not found"))
}

async fn release_assets(executor: impl sqlx::PgExecutor<'_>, id: &str) -> Result<Vec<AssetRow>, ApiError> {
    sqlx::query_as::<_, AssetRow>(&format!(
        r#"SELECT {ASSET_COLUMNS} FROM "ClientReleaseAsset" a WHERE a."releaseId" = $1 ORDER BY a.platform, a.kind"#
    ))
    .bind(id)
    .fetch_all(executor)
    .await
    .map_err(|e| db_error(e, "Failed to load client release files"))
}

fn require_draft(release: &ReleaseRow) -> Result<(), ApiError> {
    if release.published_at.is_some() {
        return Err(ApiError::conflict("Published releases cannot be changed; unpublish it first"));
    }
    Ok(())
}

async fn remove_file(config: &Config, asset_id: &str) {
    if let Err(err) = tokio::fs::remove_file(asset_path(config, asset_id)).await {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %err, asset_id, "failed to remove client release file");
        }
    }
}

fn storage_error(err: std::io::Error) -> ApiError {
    tracing::error!(error = %err, "client release storage failed");
    ApiError::internal("Release storage is not available")
}

// ----- Admin -----

pub async fn list_releases(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
) -> Result<Json<Value>, ApiError> {
    let (releases, assets) = load_releases(&state, false).await?;
    Ok(Json(json!({
        "releases": releases.iter().map(|r| release_json(r, &assets)).collect::<Vec<_>>(),
    })))
}

#[derive(Debug, Deserialize)]
pub struct CreateReleasePayload {
    pub version: String,
    #[serde(default)]
    pub notes: String,
}

fn validate_notes(notes: &str) -> Result<String, ApiError> {
    let notes = notes.trim().to_string();
    if notes.chars().count() > MAX_NOTES_CHARS {
        return Err(ApiError::bad_request("Release notes are too long"));
    }
    Ok(notes)
}

pub async fn create_release(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(admin): AdminUser,
    Json(payload): Json<CreateReleasePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let version = parse_version(&payload.version)?.to_string();
    let notes = validate_notes(&payload.notes)?;
    let id = Uuid::new_v4().to_string();

    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let inserted = sqlx::query(
        r#"INSERT INTO "ClientRelease" (id, version, notes, "createdBy") VALUES ($1, $2, $3, $4)
        ON CONFLICT (version) DO NOTHING"#,
    )
    .bind(&id)
    .bind(&version)
    .bind(&notes)
    .bind(&admin.id)
    .execute(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to create client release"))?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::conflict("This version already exists"));
    }
    audit::record_details(
        &mut *tx, &client, "client_release.created", Some(&admin.id), Some(&admin.username),
        Some(&id), true, None, None, json!({ "version": version }),
    )
    .await?;
    let release = load_release(&mut *tx, &id, false).await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;

    Ok((StatusCode::CREATED, Json(json!({ "release": release_json(&release, &[]) }))))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct UpdateReleasePayload {
    pub notes: Option<String>,
    pub published: Option<bool>,
}

pub async fn update_release(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(admin): AdminUser,
    Path(id): Path<String>,
    Json(payload): Json<UpdateReleasePayload>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let release = load_release(&mut *tx, &id, true).await?;
    let assets = release_assets(&mut *tx, &id).await?;

    // Notes stay editable after publishing (wording fixes); files and the version do not.
    if let Some(notes) = payload.notes.as_deref() {
        let notes = validate_notes(notes)?;
        if notes != release.notes {
            sqlx::query(r#"UPDATE "ClientRelease" SET notes = $2, "updatedAt" = NOW() WHERE id = $1"#)
                .bind(&id)
                .bind(&notes)
                .execute(&mut *tx)
                .await
                .map_err(|e| db_error(e, "Failed to update client release"))?;
            audit::record_details(
                &mut *tx, &client, "client_release.notes_updated", Some(&admin.id), Some(&admin.username),
                Some(&id), true, None, None, json!({ "version": release.version }),
            )
            .await?;
        }
    }

    match payload.published {
        Some(true) if release.published_at.is_none() => {
            if !assets.iter().any(|a| a.kind == "installer") {
                return Err(ApiError::bad_request("Upload at least one installer before publishing"));
            }
            sqlx::query(r#"UPDATE "ClientRelease" SET "publishedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|e| db_error(e, "Failed to publish client release"))?;
            let files: Vec<String> = assets
                .iter()
                .map(|a| format!("{}:{}{}", a.platform, a.kind, if a.signature.is_some() { ":signed" } else { "" }))
                .collect();
            audit::record_details(
                &mut *tx, &client, "client_release.published", Some(&admin.id), Some(&admin.username),
                Some(&id), true, None, None, json!({ "version": release.version, "files": files }),
            )
            .await?;
        }
        Some(false) if release.published_at.is_some() => {
            sqlx::query(r#"UPDATE "ClientRelease" SET "publishedAt" = NULL, "updatedAt" = NOW() WHERE id = $1"#)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|e| db_error(e, "Failed to unpublish client release"))?;
            audit::record_details(
                &mut *tx, &client, "client_release.unpublished", Some(&admin.id), Some(&admin.username),
                Some(&id), true, None, None, json!({ "version": release.version }),
            )
            .await?;
        }
        _ => {}
    }

    let release = load_release(&mut *tx, &id, false).await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    Ok(Json(json!({ "release": release_json(&release, &assets) })))
}

pub async fn delete_release(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(admin): AdminUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let release = load_release(&mut *tx, &id, true).await?;
    require_draft(&release)?;
    let assets = release_assets(&mut *tx, &id).await?;
    sqlx::query(r#"DELETE FROM "ClientRelease" WHERE id = $1"#)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| db_error(e, "Failed to delete client release"))?;
    audit::record_details(
        &mut *tx, &client, "client_release.deleted", Some(&admin.id), Some(&admin.username),
        Some(&id), true, None, None, json!({ "version": release.version }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    for asset in &assets {
        remove_file(&state.config, &asset.id).await;
    }
    Ok(Json(json!({ "message": "Release deleted" })))
}

#[derive(Default)]
struct AssetFields {
    platform: Option<String>,
    kind: Option<String>,
    signature: Option<String>,
}

struct ReceivedFile {
    name: String,
    size: u64,
    sha256: String,
}

/// Multipart fields: `platform`, `kind`, `signature` (the .sig file's content; required for
/// update bundles) and `file`. Replaces the release's earlier file of that platform and kind.
pub async fn upload_asset(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(admin): AdminUser,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, ApiError> {
    // Refuse before receiving the file.
    require_draft(&load_release(&state.db, &id, false).await?)?;

    let asset_id = Uuid::new_v4().to_string();
    let dir = state.config.client_releases_dir.clone();
    tokio::fs::create_dir_all(&dir).await.map_err(storage_error)?;
    let partial = dir.join(format!(".{asset_id}.part"));

    let result = match receive_asset(&mut multipart, &partial).await {
        Ok((fields, file)) => store_asset(&state, &client, &admin, &id, &asset_id, &partial, fields, file).await,
        Err(err) => Err(err),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        let _ = tokio::fs::remove_file(asset_path(&state.config, &asset_id)).await;
    }
    result
}

async fn receive_asset(multipart: &mut Multipart, partial: &FsPath) -> Result<(AssetFields, ReceivedFile), ApiError> {
    let invalid = |_| ApiError::bad_request("Invalid upload");
    let mut fields = AssetFields::default();
    let mut file = None;
    while let Some(mut field) = multipart.next_field().await.map_err(invalid)? {
        match field.name().unwrap_or_default() {
            "platform" => fields.platform = Some(field.text().await.map_err(invalid)?.trim().to_string()),
            "kind" => fields.kind = Some(field.text().await.map_err(invalid)?.trim().to_string()),
            "signature" => {
                let text = field.text().await.map_err(invalid)?;
                fields.signature = (!text.trim().is_empty()).then_some(text);
            }
            "file" if file.is_none() => {
                let name = field
                    .file_name()
                    .and_then(sanitize_file_name)
                    .ok_or_else(|| ApiError::bad_request("The file needs a name"))?;
                if !has_release_extension(&name) {
                    return Err(ApiError::bad_request(
                        "Upload an installer or update bundle (.exe, .msi, .dmg, .app.tar.gz, .AppImage, .deb, .rpm)",
                    ));
                }
                let mut out = tokio::fs::File::create(partial).await.map_err(storage_error)?;
                let mut hasher = Sha256::new();
                let mut size: u64 = 0;
                while let Some(chunk) = field.chunk().await.map_err(invalid)? {
                    size += chunk.len() as u64;
                    if size > MAX_ASSET_BYTES {
                        return Err(ApiError::bad_request("The file is too large"));
                    }
                    hasher.update(&chunk);
                    out.write_all(&chunk).await.map_err(storage_error)?;
                }
                out.sync_all().await.map_err(storage_error)?;
                if size == 0 {
                    return Err(ApiError::bad_request("The file is empty"));
                }
                file = Some(ReceivedFile { name, size, sha256: hex::encode(hasher.finalize()) });
            }
            _ => {}
        }
    }
    let file = file.ok_or_else(|| ApiError::bad_request("Choose a file to upload"))?;
    Ok((fields, file))
}

#[allow(clippy::too_many_arguments)]
async fn store_asset(
    state: &AppState,
    client: &ClientInfo,
    admin: &AuthUser,
    release_id: &str,
    asset_id: &str,
    partial: &FsPath,
    fields: AssetFields,
    file: ReceivedFile,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let platform = fields
        .platform
        .filter(|p| PLATFORMS.contains(&p.as_str()))
        .ok_or_else(|| ApiError::bad_request("Unknown platform"))?;
    let kind = fields
        .kind
        .filter(|k| KINDS.contains(&k.as_str()))
        .ok_or_else(|| ApiError::bad_request("Unknown file kind"))?;
    let signature = match fields.signature.as_deref() {
        Some(value) => {
            let (text, signature) = parse_signature(value)?;
            let public_key = updater_public_key(&state.config)?;
            let path = partial.to_path_buf();
            tokio::task::spawn_blocking(move || verify_signature(&public_key, &signature, &path))
                .await
                .map_err(|_| ApiError::internal("Failed to check the signature"))??;
            Some(text)
        }
        None if kind == "update" => return Err(ApiError::bad_request("Update bundles need their signature (.sig)")),
        None => None,
    };

    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let release = load_release(&mut *tx, release_id, true).await?;
    require_draft(&release)?;
    let replaced = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "ClientReleaseAsset" WHERE "releaseId" = $1 AND platform = $2 AND kind = $3 RETURNING id"#,
    )
    .bind(release_id)
    .bind(&platform)
    .bind(&kind)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to replace client release file"))?;
    let asset = sqlx::query_as::<_, AssetRow>(&format!(
        r#"WITH a AS (
            INSERT INTO "ClientReleaseAsset" (id, "releaseId", platform, kind, "fileName", size, sha256, signature)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        ) SELECT {ASSET_COLUMNS} FROM a"#
    ))
    .bind(asset_id)
    .bind(release_id)
    .bind(&platform)
    .bind(&kind)
    .bind(&file.name)
    .bind(file.size as i64)
    .bind(&file.sha256)
    .bind(&signature)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to save client release file"))?;
    sqlx::query(r#"UPDATE "ClientRelease" SET "updatedAt" = NOW() WHERE id = $1"#)
        .bind(release_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| db_error(e, "Failed to update client release"))?;
    audit::record_details(
        &mut *tx, client, "client_release.asset_uploaded", Some(&admin.id), Some(&admin.username),
        Some(release_id), true, None, None,
        json!({
            "version": release.version, "platform": platform, "kind": kind, "fileName": file.name,
            "size": file.size, "sha256": file.sha256, "signed": signature.is_some(),
        }),
    )
    .await?;
    // In place before the commit, so a committed row always has its file.
    tokio::fs::rename(partial, asset_path(&state.config, asset_id)).await.map_err(storage_error)?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    if let Some(old) = replaced {
        remove_file(&state.config, &old).await;
    }
    Ok((StatusCode::CREATED, Json(json!({ "asset": asset_json(&asset) }))))
}

pub async fn delete_asset(
    State(state): State<AppState>,
    client: ClientInfo,
    AdminUser(admin): AdminUser,
    Path((id, asset_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state.db.begin().await.map_err(|e| db_error(e, "Failed to start audited operation"))?;
    let release = load_release(&mut *tx, &id, true).await?;
    require_draft(&release)?;
    let (platform, kind) = sqlx::query_as::<_, (String, String)>(
        r#"DELETE FROM "ClientReleaseAsset" WHERE id = $1 AND "releaseId" = $2 RETURNING platform, kind"#,
    )
    .bind(&asset_id)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| db_error(e, "Failed to delete client release file"))?
    .ok_or_else(|| ApiError::not_found("File not found"))?;
    sqlx::query(r#"UPDATE "ClientRelease" SET "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| db_error(e, "Failed to update client release"))?;
    audit::record_details(
        &mut *tx, &client, "client_release.asset_deleted", Some(&admin.id), Some(&admin.username),
        Some(&id), true, None, None, json!({ "version": release.version, "platform": platform, "kind": kind }),
    )
    .await?;
    tx.commit().await.map_err(|e| db_error(e, "Failed to commit audited operation"))?;
    remove_file(&state.config, &asset_id).await;
    Ok(Json(json!({ "message": "File deleted" })))
}

// ----- Public -----

/// Each platform's newest published installer, for the download button.
pub async fn latest_downloads(State(state): State<AppState>) -> Result<Response, ApiError> {
    let (releases, assets) = load_releases(&state, true).await?;
    let downloads: Vec<Value> = PLATFORMS
        .iter()
        .filter_map(|platform| {
            releases.iter().find_map(|release| {
                assets
                    .iter()
                    .find(|a| a.release_id == release.id && a.platform == *platform && a.kind == "installer")
                    .map(|asset| {
                        json!({
                            "platform": platform,
                            "version": release.version,
                            "publishedAt": to_iso_string_opt(release.published_at),
                            "fileName": asset.file_name,
                            "size": asset.size,
                            "sha256": asset.sha256,
                            "url": download_path(asset),
                        })
                    })
            })
        })
        .collect();
    Ok(([(header::CACHE_CONTROL, "no-cache")], Json(json!({ "downloads": downloads }))).into_response())
}

/// A platform's update: the newest published release with a signed update bundle, or on
/// Windows and Linux a signed installer, which is what their updates install (NSIS/MSI,
/// AppImage). macOS updates replace the .app from its .app.tar.gz, never from the .dmg.
fn pick_update<'a>(releases: &'a [ReleaseRow], assets: &'a [AssetRow], platform: &str) -> Option<(&'a ReleaseRow, &'a AssetRow)> {
    let installer_updates = !platform.starts_with("darwin-");
    releases.iter().find_map(|release| {
        let signed = |kind: &str| {
            assets.iter().find(|a| {
                a.release_id == release.id && a.platform == platform && a.kind == kind && a.signature.is_some()
            })
        };
        signed("update")
            .or_else(|| installer_updates.then(|| signed("installer")).flatten())
            .map(|asset| (release, asset))
    })
}

/// The Tauri updater's dynamic update server: 204 when the client is up to date, otherwise
/// the newest signed update for its platform.
pub async fn update_check(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let up_to_date = || (StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, "no-store")]).into_response();
    let platform = format!("{target}-{arch}");
    let Ok(current) = Version::parse(&current_version) else { return Ok(up_to_date()) };
    if !PLATFORMS.contains(&platform.as_str()) {
        return Ok(up_to_date());
    }
    let (releases, assets) = load_releases(&state, true).await?;
    let Some((release, asset)) = pick_update(&releases, &assets, &platform) else { return Ok(up_to_date()) };
    if release_version(release) <= current {
        return Ok(up_to_date());
    }
    let origin = public_origin(&state.config, &headers).ok_or_else(|| {
        tracing::error!("APP_URL is required to serve client updates");
        ApiError::service_unavailable("Updates are not available")
    })?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "version": release.version,
            "notes": release.notes,
            "pub_date": to_iso_string_opt(release.published_at),
            "url": format!("{origin}{}", download_path(asset)),
            "signature": asset.signature,
        })),
    )
        .into_response())
}

fn content_disposition(file_name: &str) -> HeaderValue {
    let fallback: String = file_name
        .chars()
        .map(|c| if (c.is_ascii_graphic() || c == ' ') && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    let value = format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", encode_path_segment(file_name));
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// Files of published releases. Asset IDs are never reused, so responses can be cached for
/// good; ServeFile answers range and conditional requests (resumable downloads) and HEAD.
pub async fn download_asset(
    State(state): State<AppState>,
    Path((asset_id, file_name)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let asset = sqlx::query_as::<_, AssetRow>(&format!(
        r#"SELECT {ASSET_COLUMNS} FROM "ClientReleaseAsset" a JOIN "ClientRelease" r ON r.id = a."releaseId"
        WHERE a.id = $1 AND r."publishedAt" IS NOT NULL"#
    ))
    .bind(&asset_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| db_error(e, "Failed to load client release file"))?
    .filter(|asset| asset.file_name == file_name)
    .ok_or_else(|| ApiError::not_found("File not found"))?;

    let path = asset_path(&state.config, &asset.id);
    if tokio::fs::metadata(&path).await.is_err() {
        tracing::error!(asset_id = %asset.id, "client release file is missing from storage");
        return Err(ApiError::not_found("File not found"));
    }
    let mut response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|_| ApiError::internal("Failed to read file"))?
        .map(Body::new);
    if response.status().is_success() {
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        headers.insert(header::CONTENT_DISPOSITION, content_disposition(&asset.file_name));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway `tauri signer` key (discarded) and its signature of TEST_PAYLOAD.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI4NEZDMzdBMzFFRjY0MkMKUldRc1pPOHhlc05QdUpFSVpoQ0R3NmVvbXNnRDZYWHBNUVJ5MjdFVTFza1BrbXRaNHV1aDQxdTYK";
    const TEST_PAYLOAD: &str = "hello update";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1pPOHhlc05QdUhoaWZ3K1JtM2N2VUxJUDNJYkNRN2M3NllnMkVoQ1o1N2w0VDJsaDFQRUJEOGxkVVdERzJUQUVreEE1bkdFQ3NCanRzM2NWaGg1aGYxTzF0R3RubGdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODM5ODY2CWZpbGU6dW5pdC5iaW4KdXRhK090dDFvVTN4dGZBV3RNSHdWbkp6NndBc053NHNNcG1MYVEvVG1WdTJWVk55Yk9mVXpkbmg4RnAydzhSVjBVTmFNSHIvYklTTTF5ZENPRnJTQXc9PQo=";

    fn release(id: &str, version: &str) -> ReleaseRow {
        ReleaseRow {
            id: id.into(),
            version: version.into(),
            notes: String::new(),
            published_at: Some(Utc::now()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            created_by: None,
        }
    }

    fn asset(release_id: &str, platform: &str, kind: &str, signed: bool) -> AssetRow {
        AssetRow {
            id: format!("{release_id}-{platform}-{kind}"),
            release_id: release_id.into(),
            platform: platform.into(),
            kind: kind.into(),
            file_name: "file".into(),
            size: 1,
            sha256: String::new(),
            signature: signed.then(|| "sig".into()),
            created_at: Utc::now(),
        }
    }

    fn config() -> Config {
        let mut config = Config::from_env();
        config.client_updater_pubkey = TEST_PUBKEY.into();
        config.app_url = Some("https://collabcode.cc".into());
        config.frontend_url = None;
        config.allowed_origins = vec!["https://kode666.com".into(), "http://127.0.0.1:55461".into()];
        config
    }

    #[test]
    fn versions_are_semantic() {
        assert_eq!(parse_version(" 1.2.3 ").unwrap().to_string(), "1.2.3");
        assert!(parse_version("0.2.0-beta.1").is_ok());
        assert!(parse_version("v1.2.3").is_err());
        assert!(parse_version("1.2").is_err());
    }

    #[test]
    fn file_names_keep_only_the_last_component() {
        assert_eq!(
            sanitize_file_name(r"C:\fakepath\ShareCode Client_0.2.0_x64-setup.exe").as_deref(),
            Some("ShareCode Client_0.2.0_x64-setup.exe")
        );
        assert_eq!(sanitize_file_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(sanitize_file_name("a\u{0}b\n.dmg").as_deref(), Some("ab.dmg"));
        assert_eq!(sanitize_file_name(".."), None);
        assert_eq!(sanitize_file_name("dir/"), None);
        assert!(has_release_extension("ShareCode Client_0.2.0_aarch64.app.tar.gz"));
        assert!(has_release_extension("ShareCode Client_0.2.0_amd64.AppImage"));
        assert!(!has_release_extension("ShareCode Client_0.2.0_x64-setup.exe.sig"));
    }

    #[test]
    fn signatures_are_checked_like_the_updater_does() {
        let config = config();
        let key = updater_public_key(&config).unwrap();
        let dir = std::env::temp_dir().join(format!("sharecode-signature-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let signed = dir.join("signed");
        let tampered = dir.join("tampered");
        std::fs::write(&signed, TEST_PAYLOAD).unwrap();
        std::fs::write(&tampered, format!("{TEST_PAYLOAD}!")).unwrap();

        let (text, signature) = parse_signature(&format!(" {TEST_SIGNATURE}\n")).unwrap();
        assert_eq!(text, TEST_SIGNATURE);
        assert!(verify_signature(&key, &signature, &signed).is_ok());
        assert!(verify_signature(&key, &signature, &tampered).is_err());

        // Well-formed signatures made with another key (here: checked against the real one).
        let mut production = config.clone();
        production.client_updater_pubkey = crate::config::CLIENT_UPDATER_PUBKEY.into();
        assert!(verify_signature(&updater_public_key(&production).unwrap(), &signature, &signed).is_err());

        assert!(parse_signature("not base64!").is_err());
        assert!(parse_signature(&base64::engine::general_purpose::STANDARD.encode("hello")).is_err());
        assert!(parse_signature("").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_server_trusts_the_clients_update_key() {
        let tauri_config: Value =
            serde_json::from_str(include_str!("../../../frontend/src-tauri-client/tauri.conf.json")).unwrap();
        assert_eq!(tauri_config["plugins"]["updater"]["pubkey"], crate::config::CLIENT_UPDATER_PUBKEY);
    }

    #[test]
    fn updates_come_from_the_newest_signed_release_per_platform() {
        let releases = vec![release("r3", "0.3.0"), release("r2", "0.2.0"), release("r1", "0.1.0")];
        let assets = vec![
            // 0.3.0's Windows installer is unsigned, so it is no update.
            asset("r3", "windows-x86_64", "installer", false),
            asset("r2", "windows-x86_64", "installer", true),
            // macOS updates use the update bundle only, never the .dmg installer.
            asset("r3", "darwin-aarch64", "installer", true),
            asset("r2", "darwin-aarch64", "update", true),
            asset("r1", "linux-x86_64", "installer", true),
        ];
        let pick = |platform| pick_update(&releases, &assets, platform).map(|(r, a)| (r.version.clone(), a.kind.clone()));
        assert_eq!(pick("windows-x86_64"), Some(("0.2.0".into(), "installer".into())));
        assert_eq!(pick("darwin-aarch64"), Some(("0.2.0".into(), "update".into())));
        assert_eq!(pick("linux-x86_64"), Some(("0.1.0".into(), "installer".into())));
        assert_eq!(pick("darwin-x86_64"), None);
    }

    #[test]
    fn update_urls_use_the_node_the_client_reached() {
        let config = config();
        let headers = |host: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            headers
        };
        assert_eq!(public_origin(&config, &headers("kode666.com")).as_deref(), Some("https://kode666.com"));
        assert_eq!(public_origin(&config, &headers("KODE666.com")).as_deref(), Some("https://kode666.com"));
        assert_eq!(public_origin(&config, &headers("127.0.0.1:55461")).as_deref(), Some("http://127.0.0.1:55461"));
        // Unknown hosts get the main origin, never their own.
        assert_eq!(public_origin(&config, &headers("evil.invalid")).as_deref(), Some("https://collabcode.cc"));
        assert_eq!(public_origin(&config, &HeaderMap::new()).as_deref(), Some("https://collabcode.cc"));
    }

    #[test]
    fn download_urls_and_names_are_encoded() {
        let mut a = asset("r", "windows-x86_64", "installer", false);
        a.file_name = "ShareCode Client_0.2.0_x64-setup.exe".into();
        assert_eq!(
            download_path(&a),
            "/api/client/downloads/r-windows-x86_64-installer/ShareCode%20Client_0.2.0_x64-setup.exe"
        );
        assert_eq!(
            content_disposition("客户端 \"setup\".exe").to_str().unwrap(),
            "attachment; filename=\"___ _setup_.exe\"; filename*=UTF-8''%E5%AE%A2%E6%88%B7%E7%AB%AF%20%22setup%22.exe"
        );
    }
}
