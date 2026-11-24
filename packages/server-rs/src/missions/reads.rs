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
pub(crate) struct Opened<'a> {
    pub slot: tokio::sync::SemaphorePermit<'a>,
    pub workspace: crate::Workspace,
    pub dir: String,
    pub project: String,
    pub canonical: String,
    pub endpoint: Arc<opencode::Endpoint>,
    pub initial: Option<String>,
    pub display: Arc<std::sync::atomic::AtomicBool>,
}
pub(crate) async fn open<'a>(app: &'a crate::App, id: &str) -> Result<Opened<'a>, Response> {
    if !app.mission_reads {
        return Err(unavailable(Status::OK, "host-unavailable"));
    }
    let Ok(workspace) = app.workspace(id) else {
        return Err(unavailable(Status::NOT_FOUND, "workspace-unavailable"));
    };
    let Some(dir) = workspace.location["directory"].as_str().map(str::to_owned) else {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    };
    let initial = files::host_identity(&workspace.path).ok();
    if initial.is_none() || files::root(&workspace).is_err() {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    }
    let display = fence::capture_display(&fence::identity(&workspace.path));
    let slot = app.mission_read_slot.acquire().await.unwrap();
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
    active_plugin(app, &endpoint, &dir).await.map_err(|reason| unavailable(Status::OK, reason))?;
    Ok(Opened { slot, workspace, dir, project, initial, canonical: canonical.to_owned(), endpoint, display })
}

pub(super) async fn active_plugin(
    app: &crate::App,
    endpoint: &crate::opencode::Endpoint,
    dir: &str,
) -> Result<(), &'static str> {
    let off = "plugin-unavailable";
    let plugins =
        native_read(app, endpoint, Method::GET, "/api/plugin", dir, None, 512 * 1024).await.map_err(|_| off)?;
    let Some(plugin) = plugins["data"].as_array().and_then(|a| a.iter().find(|r| r["id"] == "codenomad.missions"))
    else {
        return Err(off);
    };
    match plugin["state"]["status"].as_str() {
        Some("active") => Ok(()),
        Some("failed") => Err("plugin-failed"),
        _ => Err(off),
    }
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
    let url = endpoint.url.join(path).map_err(|_| ())?;
    let mut request = app
        .native
        .client
        .request(method, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(10));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| ())?.error_for_status().map_err(|_| ())?;
    opencode::read_json(response, max).await
}

async fn read(app: Shared, id: String, method: &'static str, input: Value, max: usize) -> Response {
    let Opened { slot: _slot, workspace, dir, project, canonical, initial, endpoint, display } =
        match open(&app, &id).await {
            Ok(opened) => opened,
            Err(refused) => return refused,
        };
    let args = if method == "snapshot" { json!({}) } else { input.clone() };
    let Ok(output) = native_read(
        &app,
        &endpoint,
        Method::POST,
        &format!("/api/rpc/codenomad.missions/{method}"),
        &dir,
        Some(json!({"input":args})),
        max + 256,
    )
    .await
    else {
        return unavailable(Status::OK, "plugin-unavailable");
    };
    let Ok(after) = app.workspace(&id) else {
        return unavailable(Status::NOT_FOUND, "workspace-unavailable");
    };
    if after.path != workspace.path
        || after.created_at != workspace.created_at
        || after.location != workspace.location
        || files::host_identity(&after.path).ok() != initial
        || !app.native.endpoint().is_some_and(|p| Arc::ptr_eq(&p, &endpoint))
        || !display.load(Ordering::Relaxed)
    {
        return unavailable(Status::CONFLICT, "workspace-unavailable");
    }
    let Some(result) = output.get("output") else {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    };
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
            return Json(result.clone()).into_response();
        }
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    let scope = result["projectID"] == project && result["version"] == 1;
    let owned_map = |map: &Value| {
        map["projectID"] == project
            && map["projectCanonical"].as_str().is_some_and(|p| fence::normalize(p) == fence::normalize(&canonical))
    };
    let owned = match method {
        "panelPage" => panel_scope(&input, result),
        "mission" => result.get("mission").is_none_or(|map| map["id"] == input["missionID"] && owned_map(map)),
        "tasks" | "content" => result["missionID"] == input["missionID"],
        "list" | "snapshot" => result["missions"].as_array().is_some_and(|maps| maps.iter().all(owned_map)),
        _ => false,
    };
    if !scope || !owned || serde_json::to_vec(result).map_or(true, |b| b.len() > max) {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    if method == "snapshot" {
        return Json(admission_projection(result, &input["missionID"])).into_response();
    }
    let mut response = result.clone();
    response["available"] = json!(true);
    Json(response).into_response()
}

fn admission_projection(snapshot: &Value, mission: &Value) -> Value {
    let cleanups: Vec<&Value> =
        snapshot["cleanups"].as_array().into_iter().flatten().filter(|c| &c["missionID"] == mission).collect();
    let mut result = json!({"available":true,"version":snapshot["version"],"projectID":snapshot["projectID"],
        "generatedAt":snapshot["generatedAt"],"cleanups":cleanups});
    if let Some(map) = snapshot["missions"].as_array().into_iter().flatten().find(|m| &m["id"] == mission) {
        result["mission"] = map.clone();
    }
    for flag in ["cleanupUnavailable", "controlUnavailable", "notificationUnavailable"] {
        if snapshot[flag] == true {
            result[flag] = json!(true);
        }
    }
    result
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
    if !valid(&mission, 100) {
        return Err(bad("Invalid mission ID"));
    }
    Ok(read(app, id, "mission", json!({"missionID":mission}), super::run::LARGE_MISSION_RPC_LIMIT).await)
}

pub async fn admission(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
) -> Result<Response, Error> {
    let mission = crate::shared::js_trim(&mission);
    if !valid(mission, 100) {
        return Err(bad("Invalid mission read request"));
    }
    Ok(read(app, id, "snapshot", json!({"missionID":mission}), super::run::LARGE_MISSION_RPC_LIMIT).await)
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
}
