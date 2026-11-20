use crate::{Error, Shared, error, worktrees::linked, files};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const PANEL: usize = 64 * 1024;
pub(crate) fn unavailable(status: Status, reason: &str) -> Response {
    let mut body = json!({"available":false,"reason":reason});
    // Reference `readMissionPlugin`: plugin and workspace refusals carry an empty list.
    if matches!(
        reason,
        "host-unavailable" | "plugin-unavailable" | "plugin-failed" | "workspace-unavailable"
    ) {
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
    s.len() == 43
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
/// The owned Location's active plugin (reference `readMissionPlugin` preamble).
pub(crate) struct Opened<'a> {
    pub slot: tokio::sync::SemaphorePermit<'a>,
    pub workspace: crate::Workspace,
    pub dir: String,
    pub project: String,
    pub initial: Option<String>,
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
    let slot = app.mission_read_slot.acquire().await.unwrap();
    let location = [("location[directory]", dir.as_str())];
    let Ok(resolved) = linked::native(
        &app,
        Method::GET,
        "/api/location",
        &location,
        None,
        128 * 1024,
    )
    .await
    else {
        return Err(unavailable(Status::OK, "workspace-unavailable"));
    };
    if resolved["directory"]
        .as_str()
        .and_then(|v| dunce::canonicalize(v).ok())
        .as_ref()
        != Some(&workspace.path)
        || resolved["project"]["canonical"]
            .as_str()
            .and_then(|v| dunce::canonicalize(v).ok())
            .as_ref()
            != Some(&workspace.path)
    {
        return Err(unavailable(Status::FORBIDDEN, "workspace-unavailable"));
    }
    let Some(project) = resolved["project"]["id"]
        .as_str()
        .filter(|p| valid(p, 240) && *p != "global")
        .map(str::to_owned)
    else {
        return Err(unavailable(Status::FORBIDDEN, "workspace-unavailable"));
    };
    let Ok(plugins) = linked::native(
        app,
        Method::GET,
        "/api/plugin",
        &location,
        None,
        512 * 1024,
    )
    .await
    else {
        return Err(unavailable(Status::OK, "plugin-unavailable"));
    };
    let Some(plugin) = plugins["data"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == "codenomad.missions"))
    else {
        return Err(unavailable(Status::OK, "plugin-unavailable"));
    };
    match plugin["state"]["status"].as_str() {
        Some("active") => {}
        Some("failed") => return Err(unavailable(Status::OK, "plugin-failed")),
        _ => return Err(unavailable(Status::OK, "plugin-unavailable")),
    }
    Ok(Opened { slot, workspace, dir, project, initial })
}
async fn read(app: Shared, id: String, method: &'static str, input: Value, max: usize) -> Response {
    let Opened { slot: _slot, workspace, dir, project, initial } = match open(&app, &id).await {
        Ok(opened) => opened,
        Err(refused) => return refused,
    };
    let location = [("location[directory]", dir.as_str())];
    let Ok(output) = linked::native(
        &app,
        Method::POST,
        &format!("/api/rpc/codenomad.missions/{method}"),
        &location,
        Some(json!({"input":input})),
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
        || after.location != workspace.location
        || files::host_identity(&after.path).ok() != initial
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
            && map["projectCanonical"]
                .as_str()
                .and_then(|p| dunce::canonicalize(p).ok())
                .as_ref()
                == Some(&workspace.path)
    };
    let owned = match method {
        "panelPage" => panel_scope(&input, result),
        "mission" => result
            .get("mission")
            .is_none_or(|map| map["id"] == input["missionID"] && owned_map(map)),
        "tasks" | "content" => result["missionID"] == input["missionID"],
        "list" => result["missions"]
            .as_array()
            .is_some_and(|maps| maps.iter().all(owned_map)),
        _ => false,
    };
    if !scope || !owned || serde_json::to_vec(result).map_or(true, |b| b.len() > max) {
        return unavailable(Status::BAD_GATEWAY, "plugin-unavailable");
    }
    let mut response = result.clone();
    response["available"] = json!(true);
    Json(response).into_response()
}
fn panel_scope(input: &Value, result: &Value) -> bool {
    let mission = if input["source"] == "tasks" {
        input["task"].get("missionID")
    } else {
        input.get("missionID")
    };
    result["available"] == true
        && input["source"] == result["source"]
        && result.get("taskMarksThrough").is_some() == (input["source"] == "task-marks")
        && result.get("missionID") == mission
        && ["field", "part", "text", "header"]
            .iter()
            .all(|key| input.get(*key) == result.get(*key))
        && input.get("window").is_some() == result.get("window").is_some()
        && result["page"]["digest"].as_str().is_some_and(digest)
        && result["page"]["total"].is_u64()
        && result["page"]["pieces"]
            .as_array()
            .is_some_and(|p| p.len() <= 50)
        && input.get("window").is_none_or(|w| {
            let (Some(offset), Some(total)) =
                (w["offset"].as_u64(), result["window"]["total"].as_u64())
            else {
                return false;
            };
            let count = if input["text"] == true { 1 } else { 50 };
            result["window"]["offset"] == offset.min(total)
                && result["window"]["end"] == offset.saturating_add(count).min(total)
                && w.get("order")
                    .is_none_or(|order| &result["window"]["order"] == order)
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    include: Option<String>,
    summaries: Option<String>,
}
pub async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<List>,
) -> Result<Response, Error> {
    let mut input = json!({});
    if let Some(include) = q.include {
        let mut names = include
            .split(',')
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
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
    Ok(read(
        app,
        id,
        "mission",
        json!({"missionID":mission}),
        4 * 1024 * 1024,
    )
    .await)
}
pub async fn content(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Result<Response, Error> {
    if !valid(&mission, 100) {
        return Err(bad("Invalid mission ID"));
    }
    let mut input = json!({"missionID":mission});
    for (key, value) in q {
        match key.as_str() {
            "kind" if matches!(value.as_str(), "mission" | "task" | "report" | "change") => {
                input[key] = json!(value)
            }
            "field" | "taskKey" if valid(&value, 64) => input[key] = json!(value),
            "reportId" if valid(&value, 240) => input[key] = json!(value),
            "digest" if digest(&value) => input[key] = json!(value),
            "offset" | "change" if value.len() <= 15 => {
                input[key] = json!(
                    value
                        .parse::<u64>()
                        .map_err(|_| bad("Invalid mission content selector"))?
                )
            }
            _ => return Err(bad("Invalid mission content selector")),
        }
    }
    if input["kind"].is_null()
        || input["field"].is_null()
        || input["offset"].is_null()
        || input["offset"] != 0 && input["digest"].is_null()
    {
        return Err(bad("Invalid mission content selector"));
    }
    Ok(read(app, id, "content", input, 512 * 1024).await)
}
pub async fn tasks(
    State(app): State<Shared>,
    Path((id, mission)): Path<(String, String)>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Result<Response, Error> {
    if !valid(&mission, 100) {
        return Err(bad("Invalid mission ID"));
    }
    let mut input = json!({"missionID":mission});
    let mut names = 0;
    for (key, value) in q {
        match key.as_str() {
            "order" if digest(&value) => input[key] = json!(value),
            "offset" | "attention" if value.len() <= 15 => {
                input[key] = json!(
                    value
                        .parse::<u64>()
                        .map_err(|_| bad("Invalid mission task selector"))?
                )
            }
            "keys" | "ids" | "reports" => {
                let items = value
                    .split(',')
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>();
                names += items.len();
                if names > 50
                    || items
                        .iter()
                        .any(|v| !valid(v, if key == "keys" { 64 } else { 240 }))
                {
                    return Err(bad("Invalid mission task selector"));
                }
                input[if key == "reports" {
                    "reportIds".into()
                } else {
                    key
                }] = json!(items);
            }
            _ => return Err(bad("Invalid mission task selector")),
        }
    }
    Ok(read(app, id, "tasks", input, 4 * 1024 * 1024).await)
}
pub async fn panel(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> Response {
    if matches!(input["source"].as_str(), Some("activity" | "marks")) {
        // Persisted context, then live actor observation (`readMissionPanelObservation`).
        return crate::missions::activity::panel(app, id, input).await;
    }
    if !matches!(
        input["source"].as_str(),
        Some("summaries" | "cleanups" | "mission" | "tasks" | "task-marks")
    ) {
        return unavailable(Status::BAD_REQUEST, "invalid-request");
    }
    // The native registered schema validates the complete selector. This
    // transport admits no live actor observation or activity sources.
    read(app, id, "panelPage", input, PANEL).await
}
