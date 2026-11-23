//! Permission receipts: a session's asked and replied permissions, recorded from native events.
mod recovery;
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
pub(crate) use recovery::Recovery;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path as FsPath, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use crate::{
    App, Error, Shared, Workspace, error, not_found,
    opencode::{Endpoint, upstream_error},
};

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
async fn scope(app: &App, endpoint: &Endpoint) -> Result<String, Error> {
    let failed = || error(Status::SERVICE_UNAVAILABLE, "Receipt scope unavailable");
    let native = app
        .native
        .client
        .get(endpoint.url.join("/api/config").map_err(|_| failed())?)
        .basic_auth("opencode", Some(&endpoint.password))
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
            hash(&json!(["basic", "opencode", endpoint.password]).to_string())
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
    const MAX: u64 = 1024 * 1024;
    match fs::File::open(file) {
        Ok(file) => {
            if !file.metadata().is_ok_and(|m| m.is_file() && m.len() <= MAX) {
                return Err(failed());
            }
            let mut bytes = Vec::new();
            file.take(MAX + 1).read_to_end(&mut bytes).map_err(|_| failed())?;
            if bytes.len() as u64 > MAX {
                return Err(failed());
            }
            serde_json::from_slice(&bytes).map(Some).map_err(|_| failed())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        _ => Err(failed()),
    }
}
fn persist(file: &FsPath, record: &Record) -> Result<(), Error> {
    fs::create_dir_all(file.parent().unwrap())
        .map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Permission receipt unavailable"))?;
    crate::storage::write(file, &json!(record))
}
async fn capture(
    app: &App,
    scope: &str,
    request: Snapshot,
    current: impl FnOnce() -> bool + Send + 'static,
    reanchored: impl FnOnce() + Send + 'static,
) -> Result<(), Error> {
    let file = dir(app, scope, &request.session_id).join(format!("{}.json", hash(&request.request_id)));
    let serial = SERIAL.lock().await;
    tokio::task::spawn_blocking(move || {
        let _serial = serial;
        if !current() {
            return Ok(());
        }
        match read(&file)? {
            None => {
                persist(&file, &Record { request, receipt: None })?;
                Ok(())
            }
            // A native settlement can persist before its already-read snapshot.
            Some(mut entry)
                if entry.request.action.is_none()
                    && request.action.is_some()
                    && entry.receipt.as_ref().is_some_and(|receipt| receipt.origin == "native") =>
            {
                entry.request = request;
                entry.receipt.as_mut().unwrap().request = entry.request.clone();
                persist(&file, &entry)?;
                reanchored();
                Ok(())
            }
            Some(_) => Ok(()),
        }
    })
    .await
    .map_err(|_| upstream_error())?
}

pub async fn observe(
    app: &Shared,
    endpoint: &std::sync::Arc<Endpoint>,
    event: &Value,
    recipients: &[Workspace],
) -> Result<(), Error> {
    let kind = event["type"].as_str().unwrap_or_default();
    if !matches!(kind, "permission.asked" | "permission.replied" | "session.deleted") || recipients.is_empty() {
        return Ok(());
    }
    let data = &event["data"];
    let Some(session) = id(&data["sessionID"]) else { return Ok(()) };
    let scope = scope(app, endpoint).await?;
    if !app.native.current(endpoint) {
        return Err(upstream_error());
    }
    if kind == "permission.asked" {
        if let Some(request) = snapshot(data) {
            let (owner, endpoint) = (app.clone(), endpoint.clone());
            capture(app, &scope, request, move || owner.native.current(&endpoint), || {}).await?;
        }
        return Ok(());
    }
    let _serial = SERIAL.lock().await;
    if !app.native.current(endpoint) {
        return Err(upstream_error());
    }
    let folder = dir(app, &scope, session);
    if kind == "session.deleted" {
        return match fs::remove_dir_all(folder) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error(Status::SERVICE_UNAVAILABLE, "Permission receipt unavailable")),
        };
    }
    if let (Some(request), Some(decision @ ("once" | "always" | "reject"))) =
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

pub struct Prepared {
    file: PathBuf,
    decision: String,
    reason: Option<String>,
}

/// Reuse the admitted request and pin the receipt's original storage namespace.
pub async fn prepare(app: &App, endpoint: &Endpoint, request: &Value, input: &Value) -> Result<Prepared, Error> {
    let request = snapshot(request).ok_or_else(upstream_error)?;
    let decision = input["decision"].as_str().ok_or_else(upstream_error)?.to_owned();
    let reason = text(&input["message"]);
    let scope = scope(app, endpoint).await?;
    let _serial = SERIAL.lock().await;
    let file = dir(app, &scope, &request.session_id).join(format!("{}.json", hash(&request.request_id)));
    if read(&file)?.is_none() {
        persist(&file, &Record { request, receipt: None })?;
    }
    Ok(Prepared { file, decision, reason })
}
impl Prepared {
    /// Upgrade only the same native decision; a removed snapshot stays removed.
    pub async fn confirm(self, app: &App, workspace: &Workspace) -> Result<(), Error> {
        let _serial = SERIAL.lock().await;
        let Some(mut saved) = read(&self.file)? else { return Ok(()) };
        if saved.receipt.as_ref().is_some_and(|r| r.origin != "native" || r.decision != self.decision) {
            return Ok(());
        }
        let at = saved
            .receipt
            .as_ref()
            .map(|r| r.resolved_at)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);
        saved.receipt = Some(Receipt {
            request: saved.request.clone(),
            decision: self.decision,
            origin: "codenomad".into(),
            resolved_at: at,
            reason: self.reason,
        });
        persist(&self.file, &saved)?;
        if crate::sessions::permission_mode::workspace_current(app, workspace) {
            let mut change = json!({"type":"permission.receiptsChanged","instanceId":workspace.id,"sessionId":saved.request.session_id});
            if let Some(source) = &saved.request.source {
                change["messageId"] = json!(source.message_id);
            }
            app.emit(change);
        }
        Ok(())
    }
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
    let Some(endpoint) = app.native.endpoint() else {
        return route_error(Status::SERVICE_UNAVAILABLE, "Receipt scope unavailable");
    };
    let found = match crate::opencode::session_record_at(&app, &endpoint, &session).await {
        Ok(found) => found,
        Err((Status::NOT_FOUND, _)) => return route_error(Status::NOT_FOUND, "Session not found"),
        Err((status, _)) => return route_error(status, "OpenCode is unavailable"),
    };
    let Some(placement) = owned_location(&app, &open, &endpoint, &found["location"]).await else {
        return route_error(Status::FORBIDDEN, "Session does not belong to workspace");
    };
    let Ok(scope) = scope(&app, &endpoint).await else {
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
    let live = || {
        app.native.current(&endpoint)
            && super::permission_mode::workspace_current(&app, &open)
            && same_file::Handle::from_path(&open.path).is_ok_and(|path| path == physical)
    };
    if !live()
        || !crate::opencode::session_record_at(&app, &endpoint, &session)
            .await
            .is_ok_and(|current| current["location"] == found["location"] && current["projectID"] == found["projectID"])
        || !live()
        || !placement.live(&app, &open)
        || !app.native.current(&endpoint)
    {
        return route_error(Status::CONFLICT, "Workspace changed");
    }
    let mut response = json!({"receipts":receipts});
    if scanned < names.len() {
        response["next"] = json!(names[scanned - 1]);
    }
    reply(Status::OK, response)
}

async fn owned_location(
    app: &Shared,
    workspace: &Workspace,
    endpoint: &std::sync::Arc<Endpoint>,
    location: &Value,
) -> Option<crate::worktrees::ownership::ReceiptLocation> {
    if location.get("workspaceID").is_some() {
        return None;
    }
    let directory = location["directory"].as_str()?;
    crate::worktrees::ownership::receipt_location(app, workspace, endpoint, directory).await
}
