use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::{auth::AuthUser, error::ApiError, state::AppState};

const CACHE_TTL: Duration = Duration::from_secs(60);

const LANGUAGE_MAP: &[(&str, &str)] = &[
    ("c", "c"),
    ("cpp", "c++"),
    ("csharp", "csharp"),
    ("go", "go"),
    ("java", "java"),
    ("javascript", "javascript"),
    ("typescript", "typescript"),
    ("python", "python"),
    ("rust", "rust"),
    ("ruby", "ruby"),
    ("php", "php"),
    ("swift", "swift"),
    ("kotlin", "kotlin"),
    ("scala", "scala"),
    ("r", "rscript"),
    ("perl", "perl"),
    ("lua", "lua"),
    ("haskell", "haskell"),
    ("bash", "bash"),
    ("sql", "sqlite3"),
    ("plaintext", "bash"),
];

const FILE_EXTENSIONS: &[(&str, &str)] = &[
    ("c", "c"),
    ("c++", "cpp"),
    ("csharp", "cs"),
    ("go", "go"),
    ("java", "java"),
    ("javascript", "js"),
    ("typescript", "ts"),
    ("python", "py"),
    ("rust", "rs"),
    ("ruby", "rb"),
    ("php", "php"),
    ("swift", "swift"),
    ("kotlin", "kt"),
    ("scala", "scala"),
    ("rscript", "r"),
    ("perl", "pl"),
    ("lua", "lua"),
    ("haskell", "hs"),
    ("bash", "sh"),
    ("sqlite3", "sql"),
];

#[derive(Debug, Deserialize)]
pub struct ExecuteRequest {
    pub source_code: Option<String>,
    pub language_id: Option<String>,
    pub stdin: Option<String>,
}

#[derive(Debug, Serialize)]
struct PistonExecuteRequest {
    language: String,
    version: String,
    files: Vec<PistonFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdin: Option<String>,
    run_timeout: u32,
    compile_timeout: u32,
}

#[derive(Debug, Serialize)]
struct PistonFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    content: String,
}

#[derive(Debug, Deserialize, Clone)]
struct PistonRuntime {
    language: String,
    version: String,
    aliases: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PistonResult {
    run: PistonRunResult,
}

#[derive(Debug, Deserialize)]
struct PistonRunResult {
    stdout: String,
    stderr: String,
    code: i32,
    #[allow(dead_code)]
    signal: Option<String>,
    #[allow(dead_code)]
    message: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
    memory: i64,
    wall_time: f64,
}

struct RuntimeCache {
    runtimes: Vec<PistonRuntime>,
    fetched_at: Instant,
}

static RUNTIME_CACHE: std::sync::OnceLock<RwLock<Option<RuntimeCache>>> =
    std::sync::OnceLock::new();

pub async fn execute_code(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Json(payload): Json<ExecuteRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let source_code = payload.source_code.unwrap_or_default();
    let language_id = payload.language_id.unwrap_or_default();

    if source_code.is_empty() {
        return Err(ApiError::bad_request("Source code is required"));
    }

    if language_id.is_empty() {
        return Err(ApiError::bad_request("Language ID is required"));
    }

    let piston_language = map_language(&language_id);
    let runtimes = match get_runtimes(&state).await {
        Ok(runtimes) => runtimes,
        Err(err) => {
            return Ok((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "Code execution failed",
                    "message": err.to_string(),
                    "output": "",
                    "status": "Internal Error",
                    "statusId": 13,
                    "isSuccess": false,
                })),
            ));
        }
    };
    let runtime = find_runtime(&runtimes, piston_language);

    let runtime = match runtime {
        Some(runtime) => runtime,
        None => {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": format!("Language '{}' is not supported", language_id),
                    "output": "",
                    "status": "Language Not Found",
                    "statusId": 0,
                    "isSuccess": false,
                })),
            ));
        }
    };

    let ext = file_extension(&runtime.language);
    let file_name = format!("main.{ext}");

    let piston_request = PistonExecuteRequest {
        language: runtime.language.clone(),
        version: runtime.version.clone(),
        files: vec![PistonFile {
            name: Some(file_name),
            content: source_code,
        }],
        stdin: Some(payload.stdin.unwrap_or_default()),
        run_timeout: 3000,
        compile_timeout: 3000,
    };

    let client = Client::new();
    let result = client
        .post(format!("{}/api/v2/execute", state.config.piston_url))
        .json(&piston_request)
        .send()
        .await;

    let response = match result {
        Ok(response) => response,
        Err(err) => {
            return Ok((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "Code execution failed",
                    "message": err.to_string(),
                    "output": "",
                    "status": "Internal Error",
                    "statusId": 13,
                    "isSuccess": false,
                })),
            ));
        }
    };

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Ok((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "Code execution failed",
                "message": text,
                "output": "",
                "status": "Internal Error",
                "statusId": 13,
                "isSuccess": false,
            })),
        ));
    }

    let result: PistonResult = response
        .json()
        .await
        .map_err(|err| ApiError::internal(format!("Failed to parse piston response: {err}")))?;

    let output = result.run.stdout;
    let error = result.run.stderr;
    let is_success = result.run.code == 0;
    let status = if is_success {
        "Accepted"
    } else {
        "Runtime Error"
    };
    let status_id = if is_success { 3 } else { 11 };

    let memory_kb = (result.run.memory as f64 / 1024.0).round() as i64;

    Ok((
        StatusCode::OK,
        Json(json!({
            "output": output,
            "error": error,
            "status": status,
            "statusId": status_id,
            "isSuccess": is_success,
            "time": format!("{:.3}", result.run.wall_time / 1000.0),
            "memory": memory_kb,
        })),
    ))
}

pub async fn get_languages(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let runtimes = get_runtimes(&state)
        .await
        .map_err(|_| ApiError::internal("Failed to get languages"))?;

    let languages = LANGUAGE_MAP
        .iter()
        .filter_map(|(editor_lang, piston_lang)| {
            let runtime = find_runtime(&runtimes, piston_lang);
            runtime.map(|runtime| {
                json!({
                    "name": *editor_lang,
                    "id": *editor_lang,
                    "version": runtime.version,
                    "available": true,
                })
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({ "languages": languages })))
}

pub async fn check_piston_health(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let client = Client::new();
    let response = client
        .get(format!("{}/api/v2/runtimes", state.config.piston_url))
        .send()
        .await;

    let response = match response {
        Ok(resp) => resp,
        Err(_) => {
            return Ok((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "status": "error",
                    "error": "Piston is not available"
                })),
            ));
        }
    };

    if !response.status().is_success() {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "error",
                "error": "Piston is not available"
            })),
        ));
    }

    let runtimes: Vec<PistonRuntime> = response
        .json()
        .await
        .map_err(|err| ApiError::internal(format!("Failed to parse runtimes: {err}")))?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "piston": {
                "runtimes": runtimes.len(),
                "languages": runtimes.iter().map(|r| r.language.clone()).collect::<Vec<_>>(),
            }
        })),
    ))
}

async fn get_runtimes(state: &AppState) -> Result<Vec<PistonRuntime>, ApiError> {
    let cache = RUNTIME_CACHE.get_or_init(|| RwLock::new(None));

    {
        let guard = cache.read().await;
        if let Some(cache) = guard.as_ref() {
            if cache.fetched_at.elapsed() < CACHE_TTL {
                return Ok(cache.runtimes.clone());
            }
        }
    }

    let client = Client::new();
    let response = client
        .get(format!("{}/api/v2/runtimes", state.config.piston_url))
        .send()
        .await
        .map_err(|err| ApiError::internal(format!("Piston API error: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::internal(format!(
            "Piston API error: {} - {}",
            status, text
        )));
    }

    let runtimes: Vec<PistonRuntime> = response
        .json()
        .await
        .map_err(|err| ApiError::internal(format!("Failed to parse runtimes: {err}")))?;

    let mut guard = cache.write().await;
    *guard = Some(RuntimeCache {
        runtimes: runtimes.clone(),
        fetched_at: Instant::now(),
    });

    Ok(runtimes)
}

fn find_runtime(runtimes: &[PistonRuntime], language: &str) -> Option<PistonRuntime> {
    runtimes
        .iter()
        .find(|runtime| {
            runtime.language == language || runtime.aliases.contains(&language.to_string())
        })
        .cloned()
}

fn map_language(language: &str) -> &str {
    LANGUAGE_MAP
        .iter()
        .find(|(editor, _)| editor == &language)
        .map(|(_, piston)| *piston)
        .unwrap_or(language)
}

fn file_extension(language: &str) -> &str {
    FILE_EXTENSIONS
        .iter()
        .find(|(lang, _)| lang == &language)
        .map(|(_, ext)| *ext)
        .unwrap_or("txt")
}
