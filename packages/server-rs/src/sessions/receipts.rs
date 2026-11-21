//! Permission receipts: a session's asked and replied permissions, recorded from native events.
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path as FsPath, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use crate::{App, Error, Shared, Workspace, error, not_found};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Source {
    message_id: String,
    call_id: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    request_id: String,
    session_id: String,
    resources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<Source>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    #[serde(flatten)]
    request: Snapshot,
    decision: String,
    origin: String,
    resolved_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Record {
    request: Snapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<Receipt>,
}
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn scope(app: &App) -> Result<String, Error> {
    let failed = || error(Status::SERVICE_UNAVAILABLE, "Receipt scope unavailable");
    let native = app
        .native
        .get("/api/config")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| failed())?
        .error_for_status()
        .map_err(|_| failed())?;
    let config = crate::opencode::read_json(native, 2 * 1024 * 1024).await.map_err(|_| failed())?;
    let location = config
        .as_array()
        .ok_or_else(failed)?
        .iter()
        .find(|x| x["type"] == "directory")
        .and_then(|x| x["path"].as_str())
        .filter(|p| FsPath::new(p).is_absolute() && !p.contains('\0'))
        .ok_or_else(failed)?;
    let location = if cfg!(windows) { location.replace('/', "\\").to_lowercase() } else { location.into() };
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    Ok(hash(
        &json!([
            format!("host:{platform}"),
            location,
            hash(&json!(["basic", "opencode", app.native.password()]).to_string())
        ])
        .to_string(),
    ))
}
fn dir(app: &App, scope: &str, session: &str) -> PathBuf {
    app.data.join("permission-receipts").join(scope).join(hash(session))
}
static RECORD_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}\.json$").unwrap());
fn id(value: &Value) -> Option<&str> {
    value.as_str().filter(|v| !v.is_empty() && v.encode_utf16().count() <= 512)
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(|v| String::from_utf16_lossy(&v.encode_utf16().take(4096).collect::<Vec<_>>()))
}
fn snapshot(value: &Value) -> Option<Snapshot> {
    let source = &value["source"];
    let source = if source["type"] == "tool" {
        Some(Source { message_id: id(&source["messageID"])?.into(), call_id: id(&source["id"])?.into() })
    } else {
        None
    };
    Some(Snapshot {
        request_id: id(&value["id"])?.into(),
        session_id: id(&value["sessionID"])?.into(),
        action: text(&value["action"]),
        request_message: text(&value["message"]),
        source,
        resources: value["resources"].as_array().into_iter().flatten().filter_map(text).take(64).collect(),
    })
}
fn read(file: &FsPath) -> Result<Option<Record>, Error> {
    let failed = || error(Status::INTERNAL_SERVER_ERROR, "Permission receipt unavailable");
    match fs::read(file) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => serde_json::from_slice(&bytes).map(Some).map_err(|_| failed()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        _ => Err(failed()),
    }
}
fn persist(file: &FsPath, record: &Record) -> Result<(), Error> {
    fs::create_dir_all(file.parent().unwrap())
        .map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Permission receipt unavailable"))?;
    crate::storage::write(file, &json!(record))
}
pub async fn observe(app: &App, event: &Value, recipients: &[Workspace]) -> Result<(), Error> {
    let kind = event["type"].as_str().unwrap_or_default();
    if !matches!(kind, "permission.asked" | "permission.replied" | "session.deleted") || recipients.is_empty() {
        return Ok(());
    }
    let data = &event["data"];
    let Some(session) = id(&data["sessionID"]) else { return Ok(()) };
    let scope = scope(app).await?;
    let _serial = SERIAL.lock().await;
    let folder = dir(app, &scope, session);
    if kind == "session.deleted" {
        return match fs::remove_dir_all(folder) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error(Status::SERVICE_UNAVAILABLE, "Permission receipt unavailable")),
        };
    }
    if kind == "permission.asked" {
        if let Some(request) = snapshot(data) {
            let file = folder.join(format!("{}.json", hash(&request.request_id)));
            if read(&file)?.is_none() {
                persist(&file, &Record { request, receipt: None })?;
            }
        }
    } else if let (Some(request), Some(decision @ ("once" | "always" | "reject"))) =
        (id(&data["requestID"]), data["reply"].as_str())
    {
        let file = folder.join(format!("{}.json", hash(request)));
        let mut saved = read(&file)?.unwrap_or_else(|| Record {
            request: Snapshot {
                request_id: request.into(),
                session_id: session.into(),
                resources: Vec::new(),
                action: None,
                request_message: None,
                source: None,
            },
            receipt: None,
        });
        if saved.receipt.is_none() {
            saved.receipt = Some(Receipt {
                request: saved.request.clone(),
                decision: decision.into(),
                origin: "native".into(),
                reason: None,
                resolved_at: event["created"].as_u64().unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64),
            });
            persist(&file, &saved)?;
        }
        for workspace in recipients {
            if app.workspace(&workspace.id.to_string()).is_ok() {
                let mut changed =
                    json!({"type":"permission.receiptsChanged","instanceId":workspace.id,"sessionId":session});
                if let Some(source) = &saved.request.source {
                    changed["messageId"] = json!(source.message_id);
                }
                app.emit(changed);
            }
        }
    }
    Ok(())
}

/// Capture the authoritative pending request before an explicit reply.
pub async fn capture(app: &App, value: &Value) -> Result<(), Error> {
    let request = snapshot(value).ok_or_else(|| error(Status::BAD_GATEWAY, "Invalid permission snapshot"))?;
    let scope = scope(app).await?;
    let _serial = SERIAL.lock().await;
    let file = dir(app, &scope, &request.session_id).join(format!("{}.json", hash(&request.request_id)));
    if read(&file)?.is_none() {
        persist(&file, &Record { request, receipt: None })?;
    }
    Ok(())
}
/// A confirmed explicit reply upgrades only the same native decision, preserving cascades.
pub async fn confirmed(app: &App, workspace: &Workspace, request: &Value, input: &Value) -> Result<(), Error> {
    let request = snapshot(request).ok_or_else(|| error(Status::BAD_GATEWAY, "Invalid permission snapshot"))?;
    let decision = input["decision"]
        .as_str()
        .filter(|v| matches!(*v, "once" | "always" | "reject"))
        .ok_or_else(|| error(Status::BAD_REQUEST, "Invalid permission decision"))?;
    let scope = scope(app).await?;
    let _serial = SERIAL.lock().await;
    let file = dir(app, &scope, &request.session_id).join(format!("{}.json", hash(&request.request_id)));
    let mut saved = read(&file)?.unwrap_or(Record { request, receipt: None });
    if saved.receipt.as_ref().is_some_and(|r| r.origin != "native" || r.decision != decision) {
        return Ok(());
    }
    let at =
        saved.receipt.as_ref().map(|r| r.resolved_at).unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);
    saved.receipt = Some(Receipt {
        request: saved.request.clone(),
        decision: decision.into(),
        origin: "codenomad".into(),
        resolved_at: at,
        reason: text(&input["message"]),
    });
    persist(&file, &saved)?;
    app.emit(
        json!({"type":"permission.receiptsChanged","instanceId":workspace.id,"sessionId":saved.request.session_id}),
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    message_id: Option<String>,
    unanchored: Option<String>,
    cursor: Option<String>,
    limit: Option<u8>,
}
fn reply(status: Status, data: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(data)).into_response()
}
fn route_error(status: Status, text: &str) -> Response {
    reply(status, json!({"statusCode":status.as_u16(),"error":status.canonical_reason(),"message":text}))
}
pub async fn list(
    State(app): State<Shared>,
    Path((workspace, session)): Path<(String, String)>,
    input: Result<Query<Input>, QueryRejection>,
) -> Response {
    let invalid = || reply(Status::BAD_REQUEST, json!({"error":"Invalid permission receipt query"}));
    let Ok(Query(input)) = input else { return invalid() };
    if !session.starts_with("ses")
        || session.encode_utf16().count() > 512
        || input.message_id.as_ref().is_some_and(|x| x.is_empty() || x.encode_utf16().count() > 512)
        || input.unanchored.as_deref().is_some_and(|x| x != "true")
        || input.message_id.is_some() == input.unanchored.is_some()
        || input.cursor.as_ref().is_some_and(|x| !RECORD_FILE.is_match(x))
        || input.limit.is_some_and(|x| !(1..=100).contains(&x))
    {
        return invalid();
    }
    let Ok(open) = app.workspace(&workspace) else { return route_error(not_found().0, "Workspace not found") };
    let Ok(physical) = same_file::Handle::from_path(&open.path) else {
        return route_error(Status::CONFLICT, "Workspace changed");
    };
    let found = match crate::opencode::session_record(&app, &session).await {
        Ok(found) => found,
        Err((Status::NOT_FOUND, _)) => return route_error(Status::NOT_FOUND, "Session not found"),
        Err((status, _)) => return route_error(status, "OpenCode is unavailable"),
    };
    if found["location"]["directory"] != open.location["directory"] || found["location"].get("workspaceID").is_some() {
        return route_error(Status::FORBIDDEN, "Session does not belong to workspace");
    }
    let Ok(scope) = scope(&app).await else {
        return route_error(Status::SERVICE_UNAVAILABLE, "Receipt scope unavailable");
    };
    let folder = dir(&app, &scope, &session);
    let mut names = match fs::read_dir(&folder) {
        Ok(read) => read
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| RECORD_FILE.is_match(n) && input.cursor.as_ref().is_none_or(|cursor| n > cursor))
            .collect::<Vec<_>>(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return route_error(Status::INTERNAL_SERVER_ERROR, "Permission receipt unavailable"),
    };
    names.sort_unstable();
    let mut receipts = Vec::new();
    let mut scanned = 0;
    for name in &names {
        scanned += 1;
        let Ok(record) = read(&folder.join(name)) else {
            return route_error(Status::INTERNAL_SERVER_ERROR, "Permission receipt unavailable");
        };
        if let Some(receipt) = record.and_then(|record| record.receipt) {
            if receipt.request.session_id != session {
                return route_error(Status::INTERNAL_SERVER_ERROR, "Permission receipt unavailable");
            }
            if receipt.request.source.as_ref().map(|s| &s.message_id) == input.message_id.as_ref() {
                receipts.push(receipt);
            }
        }
        if receipts.len() >= usize::from(input.limit.unwrap_or(100)) || scanned >= 500 {
            break;
        }
    }
    if app.workspace(&workspace).is_err()
        || !same_file::Handle::from_path(&open.path).is_ok_and(|path| path == physical)
        || !crate::opencode::session_record(&app, &session)
            .await
            .is_ok_and(|current| current["location"] == found["location"] && current["projectID"] == found["projectID"])
    {
        return route_error(Status::CONFLICT, "Workspace changed");
    }
    let mut response = json!({"receipts":receipts});
    if scanned < names.len() {
        response["next"] = json!(names[scanned - 1]);
    }
    reply(Status::OK, response)
}
