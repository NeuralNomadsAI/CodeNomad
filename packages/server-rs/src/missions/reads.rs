mod delivery;
mod projection;
#[cfg(test)]
mod tests;

pub(super) use delivery::{
    LARGE_RESPONSE_BUDGET_UNITS, deliver_admitted_json_bytes, deliver_json_bytes, encode_json_bytes_holding,
};

use self::delivery::LARGE_RESPONSE_THRESHOLD;
use self::projection::{project_direct_mission_bytes, project_snapshot_bytes};
use crate::{Error, Shared, error, files, opencode, worktrees::fence};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

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
