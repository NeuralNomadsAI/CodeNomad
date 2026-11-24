use super::activity::ojson::{self, J};
use crate::{Error, Shared, error, files, opencode, worktrees::fence};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::time::Instant;

const PANEL: usize = 64 * 1024;
pub(crate) fn unavailable(status: Status, reason: &str) -> Response {
    let mut body = json!({"available":false,"reason":reason});
    // Reference `readMissionPlugin`: plugin and workspace refusals carry an empty list.
    if matches!(reason, "host-unavailable" | "plugin-unavailable" | "plugin-failed" | "workspace-unavailable") {
        body["missions"] = json!([]);
    }
    (status, Json(body)).into_response()
}
fn bad(message: &str) -> Error {
    error(Status::BAD_REQUEST, message)
}
fn valid(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn digest(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
/// The owned Location's active plugin (reference `readMissionPlugin` preamble).
pub(crate) struct Opened {
    pub slot: tokio::sync::OwnedSemaphorePermit,
    pub workspace: crate::Workspace,
    pub dir: String,
    pub project: String,
    pub canonical: String,
    pub endpoint: Arc<opencode::Endpoint>,
    pub initial: Option<String>,
    pub display: Arc<std::sync::atomic::AtomicBool>,
}
pub(crate) async fn open(app: &crate::App, id: &str) -> Result<Opened, Response> {
    let Ok(workspace) = app.workspace(id) else {
        return Err(unavailable(Status::NOT_FOUND, "workspace-unavailable"));
    };
    if !app.mission_reads {
        return Err(unavailable(Status::OK, "host-unavailable"));
    }
    let Some(dir) = workspace.location["directory"].as_str().map(str::to_owned) else {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    };
    let initial = files::host_identity(&workspace.path).ok();
    if initial.is_none() || files::root(&workspace).is_err() {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    }
    let display = fence::capture_display(&fence::identity(&workspace.path));
    let slot = app.mission_read_slot.clone().acquire_owned().await.unwrap();
    let Some(endpoint) = app.native.endpoint() else {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    };
    let resolved = native_read(app, &endpoint, Method::GET, "/api/location", &dir, None, 128 * 1024)
        .await
        .map_err(|_| unavailable(Status::OK, "workspace-unavailable"))?;
    if resolved["directory"].as_str().and_then(|v| dunce::canonicalize(v).ok()).as_ref() != Some(&workspace.path) {
        return Err(unavailable(Status::FORBIDDEN, "workspace-unavailable"));
    }
    let Some(project) = resolved["project"]["id"].as_str().filter(|p| valid(p, 240)).map(str::to_owned) else {
        return Err(unavailable(Status::FORBIDDEN, "workspace-unavailable"));
    };
    let Some(canonical) = resolved["project"]["canonical"].as_str() else {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    };
    let slot = active_plugin_holding(app, &endpoint, &dir, slot)
        .await
        .map_err(|reason| unavailable(Status::OK, reason))?;
    Ok(Opened { slot, workspace, dir, project, initial, canonical: canonical.to_owned(), endpoint, display })
}

pub(super) async fn active_plugin(
    app: &crate::App,
    endpoint: &crate::opencode::Endpoint,
    dir: &str,
) -> Result<(), &'static str> {
    active_plugin_holding(app, endpoint, dir, ()).await
}

async fn active_plugin_holding<T: Send + 'static>(
    app: &crate::App,
    endpoint: &crate::opencode::Endpoint,
    dir: &str,
    hold: T,
) -> Result<T, &'static str> {
    let off = "plugin-unavailable";
    let (plugins, hold) =
        native_read_holding(app, endpoint, Method::GET, "/api/plugin", dir, None, 512 * 1024, hold)
            .await
            .map_err(|_| off)?;
    let Some(plugin) = plugins["data"].as_array().and_then(|a| a.iter().find(|r| r["id"] == "codenomad.missions"))
    else {
        return Err(off);
    };
    match plugin["state"]["status"].as_str() {
        Some("active") => Ok(hold),
        Some("failed") => Err("plugin-failed"),
        _ => Err(off),
    }
}

enum NativeRpcError<T> {
    Absent(T),
    Failed,
}

async fn native_read(
    app: &crate::App,
    endpoint: &opencode::Endpoint,
    method: Method,
    path: &str,
    dir: &str,
    body: Option<Value>,
    max: usize,
) -> Result<Value, ()> {
    native_read_holding(app, endpoint, method, path, dir, body, max, ()).await.map(|(value, ())| value)
}

#[allow(clippy::too_many_arguments)]
async fn native_read_holding<T: Send + 'static>(
    app: &crate::App,
    endpoint: &opencode::Endpoint,
    method: Method,
    path: &str,
    dir: &str,
    body: Option<Value>,
    max: usize,
    hold: T,
) -> Result<(Value, T), ()> {
    match native_read_rpc_holding(app, endpoint, method, path, dir, body, max, false, hold).await {
        Ok(result) => Ok(result),
        Err(_) => Err(()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn native_read_rpc_holding<T: Send + 'static>(
    app: &crate::App,
    endpoint: &opencode::Endpoint,
    method: Method,
    path: &str,
    dir: &str,
    body: Option<Value>,
    max: usize,
    detect_missing_method: bool,
    hold: T,
) -> Result<(Value, T), NativeRpcError<T>> {
    native_read_rpc_with_client(
        &app.native.client,
        endpoint,
        method,
        path,
        dir,
        body,
        max,
        detect_missing_method,
        hold,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn native_read_rpc_with_client<T: Send + 'static>(
    client: &reqwest::Client,
    endpoint: &opencode::Endpoint,
    method: Method,
    path: &str,
    dir: &str,
    body: Option<Value>,
    max: usize,
    detect_missing_method: bool,
    hold: T,
) -> Result<(Value, T), NativeRpcError<T>> {
    let url = endpoint.url.join(path).map_err(|_| NativeRpcError::Failed)?;
    let mut request = client
        .request(method, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(10));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| NativeRpcError::Failed)?;
    let status = response.status();
    if !status.is_success() {
        if detect_missing_method && status == Status::BAD_REQUEST {
            if let Ok(err_body) = opencode::read_json(response, 16 * 1024).await
                && opencode::native_rpc_method_not_found(&err_body, status)
            {
                return Err(NativeRpcError::Absent(hold));
            }
        }
        return Err(NativeRpcError::Failed);
    }
    opencode::read_json_holding(response, max, hold).await.map_err(|_| NativeRpcError::Failed)
}

#[allow(clippy::too_many_arguments)]
async fn native_read_bytes_rpc_with_client<T: Send + 'static>(
    client: &reqwest::Client,
    endpoint: &opencode::Endpoint,
    method: Method,
    path: &str,
    dir: &str,
    body: Option<Value>,
    max: usize,
    detect_missing_method: bool,
    hold: T,
) -> Result<(Vec<u8>, T), NativeRpcError<T>> {
    let url = endpoint.url.join(path).map_err(|_| NativeRpcError::Failed)?;
    let mut request = client
        .request(method, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(10));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| NativeRpcError::Failed)?;
    let status = response.status();
    if !status.is_success() {
        if detect_missing_method && status == Status::BAD_REQUEST {
            if let Ok(err_body) = opencode::read_json(response, 16 * 1024).await
                && opencode::native_rpc_method_not_found(&err_body, status)
            {
                return Err(NativeRpcError::Absent(hold));
            }
        }
        return Err(NativeRpcError::Failed);
    }
    let bytes = opencode::read_bytes(response, max).await.map_err(|_| NativeRpcError::Failed)?;
    Ok((bytes, hold))
}

const LARGE_RESPONSE_THRESHOLD: usize = 4 * 1024 * 1024;
const LARGE_RESPONSE_CHUNK: usize = 64 * 1024;
pub(super) const LARGE_RESPONSE_BUDGET_UNITS: usize = 2048;
const LARGE_RESPONSE_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const LARGE_RESPONSE_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) async fn encode_json_bytes_holding<T: Send + 'static>(
    value: Value,
    hold: T,
    offload: bool,
    _compact_mission: bool,
) -> Result<(Vec<u8>, T), ()> {
    let encode = move || {
        let encoded = serde_json::to_vec(&value).map_err(|_| ());
        drop(value);
        encoded.map(|bytes| (bytes, hold))
    };
    if offload { tokio::task::spawn_blocking(encode).await.map_err(|_| ())? } else { encode() }
}

fn json_bytes_response(bytes: Vec<u8>) -> Response {
    use axum::http::{HeaderValue, header};
    let len = bytes.len();
    let mut response = axum::body::Body::from(bytes).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(&len.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    response
}

pub(super) fn stream_large_bytes(
    bytes: Vec<u8>,
    budget: tokio::sync::OwnedSemaphorePermit,
    chunk_timeout: Duration,
    total_timeout: Duration,
) -> Response {
    use axum::http::{HeaderValue, header};
    let len = bytes.len();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let total_deadline = Instant::now() + total_timeout;
        let mut offset = 0usize;
        while offset < bytes.len() {
            let remaining = total_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = tx.try_send(Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Mission response delivery exceeded total deadline",
                )));
                break;
            }
            let end = (offset + LARGE_RESPONSE_CHUNK).min(bytes.len());
            // Copy each 64 KiB slice so queued/in-flight chunks never retain the full buffer
            // after this task drops `bytes` and releases `budget`.
            let chunk = axum::body::Bytes::copy_from_slice(&bytes[offset..end]);
            match tokio::time::timeout(chunk_timeout.min(remaining), tx.send(Ok(chunk))).await {
                Ok(Ok(())) => offset = end,
                Ok(Err(_)) => break,
                Err(_) => {
                    let _ = tx.try_send(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Mission response delivery timed out",
                    )));
                    break;
                }
            }
        }
        drop(bytes);
        drop(budget);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let mut response = axum::body::Body::from_stream(stream).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(&len.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    response
}

pub(super) fn deliver_json_bytes(app: &crate::App, bytes: Vec<u8>) -> Result<Response, ()> {
    if bytes.len() <= LARGE_RESPONSE_THRESHOLD {
        return Ok(json_bytes_response(bytes));
    }
    let units = bytes.len().div_ceil(LARGE_RESPONSE_CHUNK).min(LARGE_RESPONSE_BUDGET_UNITS) as u32;
    let budget = app.mission_large_response_budget.clone().try_acquire_many_owned(units).map_err(|_| ())?;
    Ok(stream_large_bytes(bytes, budget, LARGE_RESPONSE_CHUNK_TIMEOUT, LARGE_RESPONSE_TOTAL_TIMEOUT))
}

/// Deliver an already-admitted mutation response using its pre-reserved mutation delivery budget
/// (independent of `mission_control_slot` and read-side `mission_large_response_budget`).
/// Excess pre-reserved units are released immediately once the encoded size is known.
pub(super) fn deliver_admitted_json_bytes(
    bytes: Vec<u8>,
    mut budget: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    if bytes.len() <= LARGE_RESPONSE_THRESHOLD {
        drop(budget);
        return json_bytes_response(bytes);
    }
    let units = bytes.len().div_ceil(LARGE_RESPONSE_CHUNK).min(LARGE_RESPONSE_BUDGET_UNITS);
    let keep = budget.split(units).unwrap_or(budget);
    stream_large_bytes(bytes, keep, LARGE_RESPONSE_CHUNK_TIMEOUT, LARGE_RESPONSE_TOTAL_TIMEOUT)
}

fn workspace_current(
    app: &crate::App,
    id: &str,
    workspace: &crate::Workspace,
    initial: &Option<String>,
    endpoint: &Arc<opencode::Endpoint>,
    display: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), Response> {
    let Ok(after) = app.workspace(id) else {
        return Err(unavailable(Status::NOT_FOUND, "workspace-unavailable"));
    };
    if after.path != workspace.path
        || after.created_at != workspace.created_at
        || after.location != workspace.location
        || files::host_identity(&after.path).ok() != *initial
        || !app.native.endpoint().is_some_and(|p| Arc::ptr_eq(&p, endpoint))
        || !display.load(Ordering::Relaxed)
    {
        return Err(unavailable(Status::CONFLICT, "workspace-unavailable"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct EnvelopeRaw<'a> {
    #[serde(borrow)]
    output: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct MissionHeaderPeek<'a> {
    id: &'a str,
    #[serde(rename = "projectID")]
    project_id: &'a str,
    #[serde(rename = "projectCanonical")]
    project_canonical: &'a str,
}

#[derive(Deserialize)]
struct CleanupHeaderPeek<'a> {
    #[serde(rename = "missionID")]
    mission_id: &'a str,
}

#[derive(Deserialize)]
struct SnapshotOutputRaw<'a> {
    version: Option<u64>,
    #[serde(rename = "projectID")]
    project_id: Option<&'a str>,
    #[serde(rename = "generatedAt", borrow)]
    generated_at: Option<&'a RawValue>,
    #[serde(borrow)]
    missions: Option<Vec<&'a RawValue>>,
    #[serde(borrow)]
    cleanups: Option<Vec<&'a RawValue>>,
    #[serde(rename = "cleanupUnavailable")]
    cleanup_unavailable: Option<bool>,
    #[serde(rename = "controlUnavailable")]
    control_unavailable: Option<bool>,
    #[serde(rename = "notificationUnavailable")]
    notification_unavailable: Option<bool>,
}

/// Extract a single Mission from a raw `snapshot` RPC envelope without materializing
/// AST nodes for other missions in the project, preserving wire key order for compaction.
fn project_snapshot_bytes(
    bytes: &[u8],
    target_id: &str,
    project: &str,
    canonical: &str,
    compact_mission: bool,
) -> Result<Vec<u8>, ()> {
    let envelope: EnvelopeRaw<'_> = serde_json::from_slice(bytes).map_err(|_| ())?;
    let output_raw = envelope.output.ok_or(())?;
    let snap: SnapshotOutputRaw<'_> = serde_json::from_str(output_raw.get()).map_err(|_| ())?;
    if snap.version != Some(1) || snap.project_id != Some(project) {
        return Err(());
    }
    let normalized = fence::normalize(canonical);
    let missions_raw = snap.missions.ok_or(())?;
    let mut target_raw: Option<&RawValue> = None;
    for raw in missions_raw {
        let peek: MissionHeaderPeek<'_> = serde_json::from_str(raw.get()).map_err(|_| ())?;
        if peek.project_id != project || fence::normalize(peek.project_canonical) != normalized {
            return Err(());
        }
        if peek.id == target_id && target_raw.is_none() {
            target_raw = Some(raw);
        }
    }
    let mut kept_cleanups = Vec::new();
    if let Some(cleanups_raw) = snap.cleanups {
        for raw in cleanups_raw {
            if let Ok(peek) = serde_json::from_str::<CleanupHeaderPeek<'_>>(raw.get())
                && peek.mission_id == target_id
            {
                kept_cleanups.push(ojson::parse(raw.get().as_bytes()).ok_or(())?);
            }
        }
    }
    let generated_at = snap
        .generated_at
        .and_then(|r| ojson::parse(r.get().as_bytes()))
        .unwrap_or(J::Null);
    let mut out_entries = vec![
        ("available".to_owned(), J::Bool(true)),
        ("version".to_owned(), J::U(1)),
        ("projectID".to_owned(), J::S(project.to_owned())),
        ("generatedAt".to_owned(), generated_at),
        ("cleanups".to_owned(), J::A(kept_cleanups)),
    ];
    if let Some(raw) = target_raw {
        let parsed = ojson::parse(raw.get().as_bytes()).ok_or(())?;
        let projected = if compact_mission { super::compact::compact_mission_j(parsed) } else { parsed };
        out_entries.push(("mission".to_owned(), projected));
    }
    if snap.cleanup_unavailable == Some(true) {
        out_entries.push(("cleanupUnavailable".to_owned(), J::Bool(true)));
    }
    if snap.control_unavailable == Some(true) {
        out_entries.push(("controlUnavailable".to_owned(), J::Bool(true)));
    }
    if snap.notification_unavailable == Some(true) {
        out_entries.push(("notificationUnavailable".to_owned(), J::Bool(true)));
    }
    Ok(J::O(out_entries).stringify().into_bytes())
}

/// Process a direct `mission` RPC envelope in insertion-ordered `ojson::J` so structured
/// body digests match JavaScript `JSON.stringify` wire key order, then compact in place.
fn project_direct_mission_bytes(
    bytes: &[u8],
    target_id: &str,
    project: &str,
    canonical: &str,
) -> Result<Vec<u8>, ()> {
    let envelope: EnvelopeRaw<'_> = serde_json::from_slice(bytes).map_err(|_| ())?;
    let output_raw = envelope.output.ok_or(())?;
    let parsed = ojson::parse(output_raw.get().as_bytes()).ok_or(())?;
    let J::O(mut entries) = parsed else { return Err(()) };
    if entries.iter().find(|(k, _)| k == "projectID").and_then(|(_, v)| v.str()) != Some(project)
        || entries.iter().find(|(k, _)| k == "version").and_then(|(_, v)| v.count()) != Some(1)
    {
        return Err(());
    }
    let normalized = fence::normalize(canonical);
    if let Some(pos) = entries.iter().position(|(k, _)| k == "mission") {
        let map = std::mem::replace(&mut entries[pos].1, J::Null);
        if !matches!(map, J::Null) {
            if map.get("id").and_then(J::str) != Some(target_id)
                || map.get("projectID").and_then(J::str) != Some(project)
                || map
                    .get("projectCanonical")
                    .and_then(J::str)
                    .is_none_or(|p| fence::normalize(p) != normalized)
            {
                return Err(());
            }
            entries[pos].1 = super::compact::compact_mission_j(map);
        }
    }
    if let Some(slot) = entries.iter_mut().find(|(k, _)| k == "available") {
        slot.1 = J::Bool(true);
    } else {
        entries.push(("available".to_owned(), J::Bool(true)));
    }
    Ok(J::O(entries).stringify().into_bytes())
}

async fn read_mission_or_snapshot(
    app: Shared,
    id: String,
    method: &'static str,
    target_id: String,
    max: usize,
) -> Response {
    let Opened { slot, workspace, dir, project, canonical, initial, endpoint, display } = match open(&app, &id).await {
        Ok(opened) => opened,
        Err(refused) => return refused,
    };
    let mut effective_method = method;
    let args = if method == "snapshot" { json!({}) } else { json!({"missionID": target_id}) };
    let (raw_bytes, slot) = match native_read_bytes_rpc_with_client(
        &app.native.client,
        &endpoint,
        Method::POST,
        &format!("/api/rpc/codenomad.missions/{method}"),
        &dir,
        Some(json!({"input":args})),
        max + 256,
        method == "mission",
        slot,
    )
    .await
    {
        Ok(result) => result,
        Err(NativeRpcError::Absent(slot)) => {
            if let Err(refused) = workspace_current(&app, &id, &workspace, &initial, &endpoint, &display) {
                return refused;
            }
            effective_method = "snapshot";
            let Ok(result) = native_read_bytes_rpc_with_client(
                &app.native.client,
                &endpoint,
                Method::POST,
                "/api/rpc/codenomad.missions/snapshot",
                &dir,
                Some(json!({"input":{}})),
                max + 256,
                false,
                slot,
            )
            .await
            else {
                return unavailable(Status::OK, "plugin-unavailable");
            };
            result
        }
        Err(NativeRpcError::Failed) => return unavailable(Status::OK, "plugin-unavailable"),
    };
    if let Err(refused) = workspace_current(&app, &id, &workspace, &initial, &endpoint, &display) {
        return refused;
    }
    let compact_single = method == "mission";
    let (project_owned, canonical_owned, target_owned) = (project.clone(), canonical.clone(), target_id.clone());
    let projected = tokio::task::spawn_blocking(move || {
        let out = if effective_method == "snapshot" {
            project_snapshot_bytes(&raw_bytes, &target_owned, &project_owned, &canonical_owned, compact_single)
        } else {
            project_direct_mission_bytes(&raw_bytes, &target_owned, &project_owned, &canonical_owned)
        };
        drop(raw_bytes);
        out.map(|bytes| (bytes, slot))
    })
    .await;
    let Ok(Ok((bytes, slot))) = projected else {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    };
    drop(slot);
    if let Err(refused) = workspace_current(&app, &id, &workspace, &initial, &endpoint, &display) {
        return refused;
    }
    if bytes.len() > max + 32 {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    match deliver_json_bytes(&app, bytes) {
        Ok(response) => response,
        Err(()) => unavailable(Status::SERVICE_UNAVAILABLE, "plugin-unavailable"),
    }
}

async fn read(app: Shared, id: String, method: &'static str, input: Value, max: usize) -> Response {
    let Opened { slot, workspace, dir, project, canonical, initial, endpoint, display } = match open(&app, &id).await {
        Ok(opened) => opened,
        Err(refused) => return refused,
    };
    let (mut output, slot) = match native_read_rpc_holding(
        &app,
        &endpoint,
        Method::POST,
        &format!("/api/rpc/codenomad.missions/{method}"),
        &dir,
        Some(json!({"input":input.clone()})),
        max + 256,
        false,
        slot,
    )
    .await
    {
        Ok(result) => result,
        Err(NativeRpcError::Absent(_) | NativeRpcError::Failed) => {
            return unavailable(Status::OK, "plugin-unavailable");
        }
    };
    if let Err(refused) = workspace_current(&app, &id, &workspace, &initial, &endpoint, &display) {
        return refused;
    }
    let Some(mut result) = output.as_object_mut().and_then(|o| o.remove("output")) else {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    };
    drop(output);
    if method == "panelPage" && result["available"] == false {
        if result.as_object().is_some_and(|o| o.len() == 2)
            && matches!(
                result["reason"].as_str(),
                Some(
                    "invalid-request"
                        | "changed"
                        | "mission-not-found"
                        | "field-not-found"
                        | "invalid-cursor"
                        | "damaged"
                        | "observation-unavailable"
                )
            )
        {
            return Json(result).into_response();
        }
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    let scope = result["projectID"] == project && result["version"] == 1;
    let owned_map = |map: &Value| {
        map["projectID"] == project
            && map["projectCanonical"].as_str().is_some_and(|p| fence::normalize(p) == fence::normalize(&canonical))
    };
    let owned = match method {
        "panelPage" => panel_scope(&input, &result),
        "tasks" | "content" => result["missionID"] == input["missionID"],
        "list" => result["missions"].as_array().is_some_and(|maps| maps.iter().all(owned_map)),
        _ => false,
    };
    if !scope || !owned {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    result["available"] = json!(true);
    let Ok((bytes, slot)) = encode_json_bytes_holding(result, slot, max >= LARGE_RESPONSE_THRESHOLD, false).await
    else {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    };
    drop(slot);
    if let Err(refused) = workspace_current(&app, &id, &workspace, &initial, &endpoint, &display) {
        return refused;
    }
    if bytes.len() > max + 32 {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    match deliver_json_bytes(&app, bytes) {
        Ok(response) => response,
        Err(()) => unavailable(Status::SERVICE_UNAVAILABLE, "plugin-unavailable"),
    }
}

#[cfg(test)]
fn admission_projection_owned(mut snapshot: Value, mission: &Value) -> Value {
    let cleanups: Vec<Value> = snapshot
        .get_mut("cleanups")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .into_iter()
        .flatten()
        .filter(|c| &c["missionID"] == mission)
        .collect();
    let mut result = json!({"available":true,"version":snapshot["version"],"projectID":snapshot["projectID"],
        "generatedAt":snapshot["generatedAt"],"cleanups":cleanups});
    if let Some(map) = snapshot
        .get_mut("missions")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .into_iter()
        .flatten()
        .find(|m| &m["id"] == mission)
    {
        result["mission"] = map;
    }
    for flag in ["cleanupUnavailable", "controlUnavailable", "notificationUnavailable"] {
        if snapshot[flag] == true {
            result[flag] = json!(true);
        }
    }
    result
}

#[cfg(test)]
fn admission_projection(snapshot: &Value, mission: &Value) -> Value {
    admission_projection_owned(snapshot.clone(), mission)
}
fn panel_scope(input: &Value, result: &Value) -> bool {
    let mission = if input["source"] == "tasks" { input["task"].get("missionID") } else { input.get("missionID") };
    result["available"] == true
        && input["source"] == result["source"]
        && result.get("taskMarksThrough").is_some() == (input["source"] == "task-marks")
        && result.get("missionID") == mission
        && ["field", "part", "text", "header"].iter().all(|key| input.get(*key) == result.get(*key))
        && input.get("window").is_some() == result.get("window").is_some()
        && result["page"]["digest"].as_str().is_some_and(digest)
        && result["page"]["total"].is_u64()
        && result["page"]["pieces"].as_array().is_some_and(|p| p.len() <= 50)
        && input.get("window").is_none_or(|w| {
            let (Some(offset), Some(total)) = (w["offset"].as_u64(), result["window"]["total"].as_u64()) else {
                return false;
            };
            let count = if input["text"] == true { 1 } else { 50 };
            result["window"]["offset"] == offset.min(total)
                && result["window"]["end"] == offset.saturating_add(count).min(total)
                && w.get("order").is_none_or(|order| &result["window"]["order"] == order)
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    include: Option<String>,
    summaries: Option<String>,
}
pub async fn list(State(app): State<Shared>, Path(id): Path<String>, Query(q): Query<List>) -> Result<Response, Error> {
    let mut input = json!({});
    if let Some(include) = q.include {
        let mut names = include.split(',').filter(|v| !v.is_empty()).collect::<Vec<_>>();
        names.sort_unstable();
        names.dedup();
        if names.len() > 4 || names.iter().any(|v| !valid(v, 100)) {
            return Err(bad("Invalid mission list request"));
        }
        input["include"] = json!(names);
    }
    if let Some(s) = q.summaries {
        if !valid(&s, 64) {
            return Err(bad("Invalid mission list request"));
        }
        input["summariesVersion"] = json!(s);
    }
    Ok(read(app, id, "list", input, 4 * 1024 * 1024).await)
}
pub async fn mission(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
) -> Result<Response, Error> {
    let id = crate::shared::js_trim(&id).to_owned();
    let mission = crate::shared::js_trim(&mission);
    if !valid(&id, 200) || !valid(mission, 100) {
        return Err(bad("Invalid mission read request"));
    }
    Ok(read_mission_or_snapshot(app, id, "mission", mission.to_owned(), super::run::LARGE_MISSION_RPC_LIMIT).await)
}

pub async fn admission(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
) -> Result<Response, Error> {
    let id = crate::shared::js_trim(&id).to_owned();
    let mission = crate::shared::js_trim(&mission);
    if !valid(&id, 200) || !valid(mission, 100) {
        return Err(bad("Invalid mission read request"));
    }
    Ok(read_mission_or_snapshot(app, id, "snapshot", mission.to_owned(), super::run::LARGE_MISSION_RPC_LIMIT).await)
}
pub async fn content(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Result<Response, Error> {
    let invalid = || bad("Invalid mission content request");
    let mission = crate::shared::js_trim(&mission);
    if !valid(&mission, 100) {
        return Err(invalid());
    }
    let mut input = json!({"missionID":mission});
    for (key, value) in q {
        match key.as_str() {
            "kind" if matches!(value.as_str(), "mission" | "task" | "report" | "change") => input[key] = json!(value),
            "field" if valid(&value, 64) => input[key] = json!(value),
            "taskKey" if super::task_sessions::valid_key(&value) => input[key] = json!(value),
            "reportId" if valid(&value, 240) => input[key] = json!(value),
            "digest" if digest(&value) => input[key] = json!(value),
            "offset" | "change" if value.len() <= 15 && value.bytes().all(|b| b.is_ascii_digit()) => {
                input[key] = json!(value.parse::<u64>().map_err(|_| invalid())?)
            }
            _ => return Err(invalid()),
        }
    }
    if input["kind"].is_null()
        || input["field"].is_null()
        || input["offset"].is_null()
        || input["offset"] != 0 && input["digest"].is_null()
        || (input["kind"] == "task") != input.get("taskKey").is_some()
        || (input["kind"] == "report") != input.get("reportId").is_some()
        || (input["kind"] == "change") != input.get("change").is_some()
        || input["change"] == 0
    {
        return Err(invalid());
    }
    Ok(read(app, id, "content", input, 512 * 1024).await)
}
pub async fn tasks(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Result<Response, Error> {
    let invalid = || bad("Invalid mission task request");
    let mission = crate::shared::js_trim(&mission);
    if !valid(&mission, 100) {
        return Err(invalid());
    }
    let mut input = json!({"missionID":mission});
    let mut names = 0;
    for (key, value) in q {
        match key.as_str() {
            "order" if valid(&value, 64) => input[key] = json!(value),
            "offset" | "attention" if value.len() <= 15 && value.bytes().all(|b| b.is_ascii_digit()) => {
                input[key] = json!(value.parse::<u64>().map_err(|_| invalid())?)
            }
            "keys" | "ids" | "reports" if value.chars().count() <= 50 * 241 => {
                let items = value.split(',').filter(|v| !v.is_empty()).collect::<Vec<_>>();
                names += items.len();
                if names > 50 || items.iter().any(|v| !valid(v, if key == "keys" { 64 } else { 240 })) {
                    return Err(invalid());
                }
                input[if key == "reports" { "reportIds".into() } else { key }] = json!(items);
            }
            _ => return Err(invalid()),
        }
    }
    let named = ["keys", "ids", "reportIds"].iter().any(|k| input.get(*k).is_some());
    if [input.get("offset").is_some(), input.get("attention").is_some(), named]
        .into_iter()
        .filter(|selected| *selected)
        .count()
        != 1
    {
        return Err(invalid());
    }
    Ok(read(app, id, "tasks", input, 4 * 1024 * 1024).await)
}
pub async fn panel(State(app): State<Shared>, Path(id): Path<String>, Json(input): Json<Value>) -> Response {
    if matches!(input["source"].as_str(), Some("activity" | "marks")) {
        // Persisted context, then live actor observation (`readMissionPanelObservation`).
        return crate::missions::activity::panel(app, id, input).await;
    }
    if !matches!(input["source"].as_str(), Some("summaries" | "cleanups" | "mission" | "tasks" | "task-marks")) {
        return unavailable(Status::BAD_REQUEST, "invalid-request");
    }
    // The native registered schema validates the complete selector. This
    // transport admits no live actor observation or activity sources.
    read(app, id, "panelPage", input, PANEL).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_preserves_full_target_map_and_project_damage_without_other_missions() {
        let target = json!({"id":"msn_target","tasks":[{"brief":"full"}],"actors":[]});
        let snapshot = json!({"projectID":"project","version":1,"generatedAt":10,"controlUnavailable":true,
            "cleanupUnavailable":true,"notificationUnavailable":false,"missions":[{"id":"msn_other"},target],
            "cleanups":[{"missionID":"msn_target"},{"missionID":"msn_other"}]});
        assert_eq!(
            admission_projection(&snapshot, &json!("msn_target")),
            json!({
                "available":true,"version":1,"projectID":"project","generatedAt":10,"controlUnavailable":true,
                "cleanupUnavailable":true,"mission":target,"cleanups":[{"missionID":"msn_target"}]
            })
        );
        assert!(admission_projection(&snapshot, &json!("msn_missing")).get("mission").is_none());
    }

    #[tokio::test]
    async fn stream_large_bytes_holds_budget_until_drain_and_releases_on_stall_timeout() {
        use futures_util::StreamExt;
        let budget = Arc::new(tokio::sync::Semaphore::new(4));
        let permit = budget.clone().try_acquire_many_owned(3).unwrap();
        let payload = vec![b'x'; 256 * 1024 + 17];
        let response = stream_large_bytes(payload.clone(), permit, Duration::from_secs(5), Duration::from_secs(30));
        assert_eq!(budget.available_permits(), 1);
        let mut stream = response.into_body().into_data_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first.len(), LARGE_RESPONSE_CHUNK);
        let mut collected = first.to_vec();
        while let Some(chunk) = stream.next().await {
            collected.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(collected, payload);
        tokio::task::yield_now().await;
        assert_eq!(budget.available_permits(), 4, "budget must release once body finishes");
        // Chunks are copied into independent 64 KiB allocations, so holding `first` does not
        // retain the full backing buffer.
        assert_eq!(first.len(), LARGE_RESPONSE_CHUNK);

        // Stalled client: channel holds 2 chunks (128 KiB); chunk 3 blocks and times out cleanly.
        let stall_permit = budget.clone().try_acquire_many_owned(3).unwrap();
        let stalled = stream_large_bytes(
            vec![b'y'; 256 * 1024],
            stall_permit,
            Duration::from_millis(40),
            Duration::from_secs(5),
        );
        assert_eq!(budget.available_permits(), 1);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(budget.available_permits(), 4, "budget must release after stall timeout");
        drop(stalled);

        // Slow-trickling client: total deadline fires even when individual chunks arrive within chunk_timeout.
        let trickle_permit = budget.clone().try_acquire_many_owned(3).unwrap();
        let trickled = stream_large_bytes(
            vec![b'z'; 512 * 1024],
            trickle_permit,
            Duration::from_secs(5),
            Duration::from_millis(60),
        );
        assert_eq!(budget.available_permits(), 1);
        let mut slow_stream = trickled.into_body().into_data_stream();
        let _ = slow_stream.next().await;
        tokio::time::sleep(Duration::from_millis(110)).await;
        while let Some(item) = slow_stream.next().await {
            if item.is_err() {
                break;
            }
        }
        tokio::task::yield_now().await;
        assert_eq!(budget.available_permits(), 4, "budget must release after total deadline");
    }

    #[test]
    fn project_snapshot_bytes_streams_target_and_compacts_preserving_wire_key_order() {
        let raw_mode = r#"{"kind":"independent","reason":"lifetime","explanation":"Needs isolated root"}"#;
        let snapshot = format!(
            r#"{{"output":{{"version":1,"projectID":"prj_1","generatedAt":10,"controlUnavailable":true,"missions":[{{"id":"msn_other","projectID":"prj_1","projectCanonical":"/repo","tasks":[{{"brief":"huge other"}}]}},{{"version":1,"id":"msn_target","projectID":"prj_1","projectCanonical":"/repo","objective":"Obj","template":"custom","status":"active","runState":"running","coordinatorSessionId":"ses_coord","revision":1,"actors":[],"tasks":[{{"id":"tsk_1","key":"k1","title":"T1","brief":"B1","role":"specialist","blockedBy":[],"status":"ready","executionMode":{raw_mode},"createdAt":1,"updatedAt":1}}],"reports":[],"frontier":[],"claims":[],"createdAt":1,"updatedAt":1,"history":[],"historyTruncated":false}}],"cleanups":[{{"missionID":"msn_other"}},{{"missionID":"msn_target","deletionId":"del_1"}}]}}}}"#
        );
        let full_bytes = project_snapshot_bytes(snapshot.as_bytes(), "msn_target", "prj_1", "/repo", false).unwrap();
        let full: Value = serde_json::from_slice(&full_bytes).unwrap();
        assert_eq!(full["mission"]["objective"], "Obj");
        assert_eq!(full["cleanups"].as_array().unwrap().len(), 1);
        assert_eq!(full["controlUnavailable"], true);

        let compact_bytes = project_snapshot_bytes(snapshot.as_bytes(), "msn_target", "prj_1", "/repo", true).unwrap();
        let compact: Value = serde_json::from_slice(&compact_bytes).unwrap();
        assert!(compact["mission"].get("objective").is_none());
        assert_eq!(
            compact["mission"]["tasks"][0]["bodies"]["executionMode"]["digest"],
            ojson::content_digest(raw_mode)
        );
    }

    #[tokio::test]
    async fn encode_json_bytes_holding_keeps_permit_inside_blocking_task() {
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = sem.clone().acquire_owned().await.unwrap();
        assert_eq!(sem.available_permits(), 0);
        let (bytes, returned) = encode_json_bytes_holding(json!({"ok": true}), permit, true, false).await.unwrap();
        assert_eq!(sem.available_permits(), 0, "permit must stay held until caller drops it");
        assert_eq!(bytes, br#"{"ok":true}"#);
        drop(returned);
        assert_eq!(sem.available_permits(), 1);
    }

    #[tokio::test]
    async fn native_read_rpc_holding_detects_missing_method_only_and_rejects_rpc_unavailable() {
        use axum::{Router, routing::post};
        let router = Router::new()
            .route(
                "/api/rpc/codenomad.missions/mission",
                post(|| async {
                    (
                        Status::BAD_REQUEST,
                        Json(json!({
                            "_tag": "RpcError",
                            "type": "rpc.method_not_found",
                            "message": "Unknown RPC method: mission"
                        })),
                    )
                }),
            )
            .route(
                "/api/rpc/codenomad.missions/unavailable",
                post(|| async {
                    (
                        Status::BAD_REQUEST,
                        Json(json!({
                            "_tag": "RpcError",
                            "type": "rpc.unavailable",
                            "message": "Plugin temporarily unavailable"
                        })),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let endpoint = opencode::Endpoint {
            url: reqwest::Url::parse(&format!("http://{addr}/")).unwrap(),
            password: "secret".into(),
            version: String::new(),
            pid: 0,
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = sem.clone().acquire_owned().await.unwrap();
        let res = native_read_rpc_with_client(
            &client,
            &endpoint,
            Method::POST,
            "/api/rpc/codenomad.missions/mission",
            "/fixture",
            Some(json!({"input": {"missionID": "msn_1"}})),
            4096,
            true,
            permit,
        )
        .await;
        match res {
            Err(NativeRpcError::Absent(returned)) => {
                assert_eq!(sem.available_permits(), 0);
                drop(returned);
                assert_eq!(sem.available_permits(), 1);
            }
            _ => panic!("expected NativeRpcError::Absent for rpc.method_not_found"),
        }
        let permit = sem.clone().acquire_owned().await.unwrap();
        let res = native_read_rpc_with_client(
            &client,
            &endpoint,
            Method::POST,
            "/api/rpc/codenomad.missions/unavailable",
            "/fixture",
            Some(json!({"input": {"missionID": "msn_1"}})),
            4096,
            true,
            permit,
        )
        .await;
        assert!(matches!(res, Err(NativeRpcError::Failed)), "rpc.unavailable must not fall back to snapshot");
        assert_eq!(sem.available_permits(), 1);
        server.abort();
    }
}
