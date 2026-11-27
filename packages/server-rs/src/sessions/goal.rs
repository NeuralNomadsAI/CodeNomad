//! `GET /api/workspaces/:id/sessions/:sessionId/goal`: read a session's `/goal` state
//! through the fixed `opencode.goal` `get` RPC in the session's own Location, matching
//! `packages/server/src/server/routes/session-goal.ts` and `opencode/goal-contract.ts`.
use std::{sync::Arc, time::Duration};

use axum::{
    Extension, Json,
    extract::{Path as RoutePath, State},
    http::{HeaderValue, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use super::pruning::{
    OwnedTarget, fetch_session_bounded, is_exact_application_json, is_json_content_type, prove_ownership,
    valid_location_str,
};
use crate::{
    App, Error, Shared, Workspace,
    auth::Principal,
    error,
    opencode::{self, Endpoint},
};

const GOAL_RPC_ID: &str = "opencode.goal";
const READ_TIMEOUT: Duration = Duration::from_secs(8);
const PLUGIN_LIST_LIMIT: usize = 1024 * 1024;
const GOAL_RPC_BODY_LIMIT: usize = 256 * 1024;
const GOAL_RPC_NODE_LIMIT: usize = 10_000;
const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn unavailable() -> Response {
    no_store(Json(json!({ "status": "unavailable" })).into_response())
}

fn unsupported() -> Response {
    no_store(Json(json!({ "status": "unsupported" })).into_response())
}

fn valid_session_id(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    (4..=512).contains(&bytes.len())
        && raw.starts_with("ses")
        && bytes[3..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn non_neg_safe_int(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n <= MAX_SAFE_INT).then_some(n);
    }
    let f = value.as_f64()?;
    (f.is_finite() && f >= 0.0 && f.fract() == 0.0 && f <= MAX_SAFE_INT as f64).then_some(f as u64)
}

/// Validates `goalStateSchema.nullable()` and keeps only the 7 displayed fields
/// (unknown fields are dropped, matching `opencode/goal-contract.ts`).
fn project_goal_output(value: &Value) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    let map = value.as_object()?;
    let id = map.get("id").and_then(Value::as_str)?;
    let id_len = id.encode_utf16().count();
    if !(1..=256).contains(&id_len) {
        return None;
    }
    let objective = map.get("objective").and_then(Value::as_str)?;
    if objective.encode_utf16().count() > 64 * 1024 {
        return None;
    }
    let status = map.get("status").and_then(Value::as_str)?;
    if !matches!(status, "active" | "paused" | "complete") {
        return None;
    }
    let reason = match map.get("reason") {
        None => None,
        Some(Value::String(s)) if s.encode_utf16().count() <= 16 * 1024 => Some(s.clone()),
        Some(_) => return None,
    };
    let rounds = non_neg_safe_int(map.get("rounds")?)?;
    let max_rounds = non_neg_safe_int(map.get("maxRounds")?)?;
    let updated_at = map.get("updatedAt")?;
    if !updated_at.as_f64().is_some_and(f64::is_finite) {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("objective".into(), json!(objective));
    out.insert("status".into(), json!(status));
    if let Some(r) = reason {
        out.insert("reason".into(), json!(r));
    }
    out.insert("rounds".into(), json!(rounds));
    out.insert("maxRounds".into(), json!(max_rounds));
    out.insert("updatedAt".into(), updated_at.clone());
    Some(Value::Object(out))
}

fn read_goal_directory(session: &Value) -> Result<String, Option<Error>> {
    let loc = session.get("location").and_then(Value::as_object).ok_or(None)?;
    let dir = loc.get("directory").and_then(valid_location_str).ok_or(None)?;
    if let Some(ws) = loc.get("workspaceID") {
        return if valid_location_str(ws).is_some() {
            Err(Some(error(Status::FORBIDDEN, "Session does not belong to workspace")))
        } else {
            Err(None)
        };
    }
    Ok(dir.to_owned())
}

fn is_method_not_found(status: Status, headers: &reqwest::header::HeaderMap, body: &Value) -> bool {
    matches!(status, Status::BAD_REQUEST | Status::NOT_FOUND)
        && is_exact_application_json(headers)
        && body.as_object().is_some_and(|o| o.len() == 3)
        && body["_tag"] == "RpcError"
        && body["type"] == "rpc.method_not_found"
        && body["message"].as_str().is_some_and(|s| (1..=4096).contains(&s.encode_utf16().count()))
}

async fn await_goal_plugin(
    app: &App,
    endpoint: &Endpoint,
    directory: &str,
    deadline: Instant,
    still_valid: impl Fn() -> bool,
) -> Result<(), ()> {
    let url = endpoint.url.join("/api/plugin").map_err(|_| ())?;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || !still_valid() {
            return Err(());
        }
        let response = app
            .native
            .client
            .get(url.clone())
            .basic_auth("opencode", Some(&endpoint.password))
            .query(&[("location[directory]", directory)])
            .timeout(left)
            .send()
            .await
            .map_err(|_| ())?;
        if !still_valid() || response.status() != Status::OK || !is_json_content_type(response.headers()) {
            return Err(());
        }
        let catalogue = opencode::read_json(response, PLUGIN_LIST_LIMIT).await?;
        if !still_valid() {
            return Err(());
        }
        let loc = catalogue.get("location").and_then(Value::as_object).ok_or(())?;
        if loc.get("directory").and_then(Value::as_str) != Some(directory) || loc.contains_key("workspaceID") {
            return Err(());
        }
        let status = catalogue["data"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == GOAL_RPC_ID))
            .and_then(|p| p["state"]["status"].as_str());
        match status {
            Some("active") => return Ok(()),
            Some("failed") => return Err(()),
            _ => {
                let pause = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(50));
                if pause.is_zero() {
                    return Err(());
                }
                tokio::time::sleep(pause).await;
            }
        }
    }
}

async fn revalidate_session(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    session_id: &str,
    project_id: &Value,
    target: &OwnedTarget,
    is_current: impl Fn() -> bool,
    remaining: impl Fn() -> Duration,
) -> Result<(), ()> {
    if !is_current() {
        return Err(());
    }
    let latest = fetch_session_bounded(app, endpoint, session_id, 512, remaining()).await?;
    if !is_current() || &latest["projectID"] != project_id {
        return Err(());
    }
    let latest_dir = read_goal_directory(&latest).map_err(|_| ())?;
    if latest_dir != target.directory {
        return Err(());
    }
    let fresh = prove_ownership(app, workspace, endpoint, &latest_dir).await?.ok_or(())?;
    if fresh.path != target.path
        || fresh.anchor != target.anchor
        || fresh.anchor_id != target.anchor_id
        || !target.checkout.same_checkout(&fresh.checkout)
        || !is_current()
    {
        return Err(());
    }
    Ok(())
}

async fn wait_workspace_closed(app: &App, workspace: &Workspace) {
    loop {
        let notified = app.workspace_closed.notified();
        if !super::permission_mode::workspace_current(app, workspace) {
            return;
        }
        notified.await;
    }
}

pub async fn read(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    RoutePath((id, session_id)): RoutePath<(String, String)>,
) -> Response {
    if !valid_session_id(&session_id) {
        return no_store(error(Status::BAD_REQUEST, "Invalid session").into_response());
    }
    if let Err(err) = principal.live() {
        return no_store(err.into_response());
    }
    let deadline = Instant::now() + READ_TIMEOUT;
    let run = async {
        let Ok(workspace) = app.workspace(&id) else {
            return no_store(error(Status::FORBIDDEN, "Session does not belong to workspace").into_response());
        };
        if workspace.location["directory"].as_str().is_none() {
            return no_store(error(Status::FORBIDDEN, "Session does not belong to workspace").into_response());
        }
        let Ok(endpoint) = app.native.acquire(deadline).await else {
            return unavailable();
        };
        let work = execute(&app, &principal, &workspace, &endpoint, &session_id, deadline);
        let result = tokio::select! {
            biased;
            _ = app.native.wait_retired(&endpoint) => unavailable(),
            _ = wait_workspace_closed(&app, &workspace) => unavailable(),
            res = work => res,
        };
        if let Err(err) = principal.live() {
            return no_store(err.into_response());
        }
        result
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => no_store(crate::auth::unauthorized().into_response()),
        res = tokio::time::timeout_at(deadline, run) => res.unwrap_or_else(|_| unavailable()),
    }
}

async fn execute(
    app: &Shared,
    principal: &Principal,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    session_id: &str,
    deadline: Instant,
) -> Response {
    let is_current = || {
        !principal.0.is_cancelled()
            && Instant::now() < deadline
            && app.native.current(endpoint)
            && super::permission_mode::workspace_current(app, workspace)
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let forbidden = || no_store(error(Status::FORBIDDEN, "Session does not belong to workspace").into_response());

    if !is_current() {
        return unavailable();
    }
    let session = fetch_session_bounded(app, endpoint, session_id, 512, remaining()).await.ok();
    if !is_current() {
        return unavailable();
    }
    let Some(session) = session else {
        return no_store(error(Status::NOT_FOUND, "Session not found").into_response());
    };
    let directory = match read_goal_directory(&session) {
        Ok(dir) => dir,
        Err(Some(err)) => return no_store(err.into_response()),
        Err(None) => return unavailable(),
    };
    let target = match prove_ownership(app, workspace, endpoint, &directory).await {
        Ok(Some(target)) => target,
        Ok(None) => return if !is_current() { unavailable() } else { forbidden() },
        Err(()) => return unavailable(),
    };
    if !is_current() {
        return unavailable();
    }
    let project_id = session["projectID"].clone();

    if await_goal_plugin(app, endpoint, &target.directory, deadline, is_current).await.is_err() {
        return unavailable();
    }
    if revalidate_session(app, workspace, endpoint, session_id, &project_id, &target, is_current, remaining)
        .await
        .is_err()
    {
        return unavailable();
    }

    let Ok(url) = endpoint.url.join("/api/rpc/opencode.goal/get") else {
        return unavailable();
    };
    let left = remaining();
    if left.is_zero() || !is_current() {
        return unavailable();
    }
    let Ok(response) = app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", target.directory.as_str())])
        .json(&json!({ "input": { "sessionID": session_id } }))
        .timeout(left)
        .send()
        .await
    else {
        return unavailable();
    };
    if !is_current() {
        return unavailable();
    }
    let status = response.status();
    let headers = response.headers().clone();
    let Ok(raw) = opencode::read_bytes(response, GOAL_RPC_BODY_LIMIT).await else {
        return unavailable();
    };
    if !is_current() || !super::media_stream::json_node_count_within(&raw, GOAL_RPC_NODE_LIMIT) {
        return unavailable();
    }
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return unavailable();
    };
    if status != Status::OK {
        return if is_method_not_found(status, &headers, &body) { unsupported() } else { unavailable() };
    }
    if !is_json_content_type(&headers) {
        return unavailable();
    }
    if revalidate_session(app, workspace, endpoint, session_id, &project_id, &target, is_current, remaining)
        .await
        .is_err()
    {
        return unavailable();
    }
    let Some(output) = body.as_object().and_then(|o| o.get("output")) else {
        return unavailable();
    };
    match project_goal_output(output) {
        Some(goal) => no_store(Json(json!({ "status": "goal", "goal": goal })).into_response()),
        None => unavailable(),
    }
}
