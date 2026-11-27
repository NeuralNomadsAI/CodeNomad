//! `POST /api/workspaces/:id/session-pruning/{preview,prune}` and
//! `POST /api/workspaces/:id/session-history/prune` (batch): narrow brokers to the
//! bundled `codenomad.session-pruning` plugin, matching `routes/session-pruning.ts`
//! and `routes/session-history.ts`.
#[path = "pruning_contract.rs"]
mod contract;

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    time::Duration,
};

use axum::{
    Extension, Json,
    extract::{Path as RoutePath, Request, State},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::time::Instant;

use self::contract::{Action, ParsedInput, parse_request, validate_output};
use crate::{
    App, Error, Shared, Workspace,
    auth::Principal,
    error,
    opencode::{self, Endpoint},
    worktrees::{fence, ownership},
};

const READY_CAP: Duration = Duration::from_secs(5);
const CARRIER_TIMEOUT: Duration = Duration::from_secs(5);
const DETACHED_RPC_DRAIN: Duration = Duration::from_secs(60);
const SESSION_BODY_LIMIT: usize = 2 * 1024 * 1024;
const PLUGIN_LIST_LIMIT: usize = 1024 * 1024;

pub async fn preview(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
    req: Request,
) -> Result<Response, Error> {
    Ok(handle(app, principal, id, Action::Preview, req).await)
}

pub async fn prune(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
    req: Request,
) -> Result<Response, Error> {
    Ok(handle(app, principal, id, Action::Prune, req).await)
}

pub(super) async fn batch(app: Shared, principal: Principal, id: String, req: Request) -> Result<Response, Error> {
    Ok(handle(app, principal, id, Action::Batch, req).await)
}

async fn handle(app: Shared, principal: Principal, id: String, action: Action, req: Request) -> Response {
    let parsed = match parse_request(&principal, action, req).await {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };

    let workspace = app.workspace(&id).ok();
    let base_dir = workspace.as_ref().and_then(|w| {
        w.location["directory"].as_str().map(str::to_owned).or_else(|| Some(w.path.to_string_lossy().into_owned()))
    });
    let ws_identity = workspace.as_ref().map(|w| fence::identity(&w.path));
    if base_dir.as_deref().is_some_and(fence::is_blocked) || ws_identity.as_deref().is_some_and(fence::is_blocked) {
        return error(Status::CONFLICT, "Worktree deletion is in progress").into_response();
    }

    let mut initial_displays = Vec::new();
    if let Some(base) = &base_dir {
        initial_displays.push(fence::capture_display(base));
    }
    if let Some(ws_id) = &ws_identity
        && base_dir.as_deref().map(fence::normalize).as_deref() != Some(fence::normalize(ws_id).as_str())
    {
        initial_displays.push(fence::capture_display(ws_id));
    }

    let deadline = Instant::now() + action.timeout();
    let run = async {
        let Some(workspace) = workspace else {
            return parsed.blocked_response();
        };
        let Ok(endpoint) = app.native.acquire(deadline).await else {
            return parsed.blocked_response();
        };
        let _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(&app, &endpoint)).await;
        let work = execute(&app, &principal, &workspace, &endpoint, &parsed, action, initial_displays, deadline);
        let result = tokio::select! {
            biased;
            _ = app.native.wait_retired(&endpoint) => parsed.blocked_response(),
            result = work => result,
        };
        if let Err(err) = principal.live() {
            return err.into_response();
        }
        result
    };

    tokio::select! {
        biased;
        _ = principal.0.cancelled() => crate::auth::unauthorized().into_response(),
        result = tokio::time::timeout_at(deadline, run) => result.unwrap_or_else(|_| parsed.blocked_response()),
    }
}

struct OwnedTarget {
    directory: String,
    path: PathBuf,
    anchor: PathBuf,
    anchor_id: String,
    checkout: ownership::DirectoryProof,
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    app: &Shared,
    principal: &Principal,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    parsed: &ParsedInput,
    action: Action,
    mut displays: Vec<Arc<AtomicBool>>,
    deadline: Instant,
) -> Response {
    let is_current = |displays: &[Arc<AtomicBool>]| {
        app.native.current(endpoint)
            && super::permission_mode::workspace_current(app, workspace)
            && displays.iter().all(|d| d.load(Relaxed))
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let forbidden = || error(Status::FORBIDDEN, "Session does not belong to workspace").into_response();
    let conflict = || error(Status::CONFLICT, "Worktree deletion is in progress").into_response();

    if !is_current(&displays) {
        return parsed.blocked_response();
    }

    let Ok(session) = fetch_session(app, endpoint, &parsed.session_id, remaining()).await else {
        return parsed.blocked_response();
    };
    if !is_current(&displays) {
        return parsed.blocked_response();
    }

    let directory = match read_session_directory(&session, action) {
        Ok(dir) => dir,
        Err(Some(err)) => return err.into_response(),
        Err(None) => return parsed.blocked_response(),
    };

    let target = match prove_ownership(app, workspace, endpoint, &directory).await {
        Ok(Some(target)) => target,
        Ok(None) => {
            if !is_current(&displays) {
                return parsed.blocked_response();
            }
            return forbidden();
        }
        Err(()) => return parsed.blocked_response(),
    };
    if !is_current(&displays) {
        return parsed.blocked_response();
    }

    let target_display = fence::capture_display(&target.directory);
    let scope_clone = app.scope.clone();
    let path_clone = target.path.clone();
    let Ok(checkout_path) = tokio::task::spawn_blocking(move || fence::checkout_root(&scope_clone, &path_clone)).await
    else {
        return parsed.blocked_response();
    };
    if !is_current(&displays) {
        return parsed.blocked_response();
    }
    let identity = fence::identity(&checkout_path);
    let mut enter_keys = vec![identity.clone(), target.directory.clone()];
    if action.mutating() {
        enter_keys.push(fence::session(&parsed.session_id));
    }
    let Some(entered) = fence::enter(&enter_keys) else {
        return conflict();
    };
    if !target_display.load(Relaxed) {
        return parsed.blocked_response();
    }
    displays.push(target_display);
    displays.push(fence::capture_display(&identity));

    let ready_deadline = deadline.min(Instant::now() + READY_CAP);
    if prepare_pruning(app, endpoint, &target.directory, ready_deadline, || is_current(&displays)).await.is_err() {
        return parsed.blocked_response();
    }

    let Ok(latest) =
        revalidate(app, workspace, endpoint, &parsed.session_id, action, &target, &displays, remaining).await
    else {
        return parsed.blocked_response();
    };

    if action.mutating() {
        if verify_ordinary_session(app, endpoint, &parsed.session_id, &target.directory, &latest, remaining())
            .await
            .is_err()
        {
            return parsed.blocked_response();
        }
        let Ok(post_carrier) =
            revalidate(app, workspace, endpoint, &parsed.session_id, action, &target, &displays, remaining).await
        else {
            return parsed.blocked_response();
        };
        if post_carrier["metadata"].get("codenomad.schedule-carrier").is_some() {
            return parsed.blocked_response();
        }
    }

    if !is_current(&displays) || principal.0.is_cancelled() || Instant::now() >= deadline {
        return parsed.blocked_response();
    }

    let (body, _entered) = if action.mutating() {
        // Re-check detachment, cancellation, retirement, and deadline inside the spawned task
        // right before sending the POST so nothing is dispatched after abort; once dispatched,
        // keep `entered` alive until the full native response finishes (up to `DETACHED_RPC_DRAIN`
        // after caller detachment), matching `opencode::proxy_write::forward`.
        let detached = tokio_util::sync::CancellationToken::new();
        let _observer = detached.clone().drop_guard();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app_rpc = app.clone();
        let principal_cancel = principal.0.clone();
        let ws_rpc = workspace.clone();
        let endpoint_rpc = endpoint.clone();
        let displays_rpc = displays.clone();
        let dir_rpc = target.directory.clone();
        let input_rpc = parsed.rpc_input.clone();
        tokio::spawn(async move {
            if detached.is_cancelled()
                || principal_cancel.is_cancelled()
                || !app_rpc.native.current(&endpoint_rpc)
                || !super::permission_mode::workspace_current(&app_rpc, &ws_rpc)
                || !displays_rpc.iter().all(|d| d.load(Relaxed))
                || Instant::now() >= deadline
            {
                let _ = tx.send((Err(()), entered));
                return;
            }
            let rpc = call_pruning_rpc(&app_rpc, &endpoint_rpc, &dir_rpc, action, &input_rpc);
            tokio::pin!(rpc);
            let res = tokio::select! {
                biased;
                res = &mut rpc => res,
                _ = detached.cancelled() => {
                    let _ = tokio::time::timeout(DETACHED_RPC_DRAIN, rpc).await;
                    return;
                }
            };
            let _ = tx.send((res, entered));
        });
        let Ok((Ok(body), entered)) = rx.await else {
            return parsed.blocked_response();
        };
        (body, entered)
    } else {
        // Read-only preview has no mutation to protect on disconnect or timeout; run inline so
        // `entered` releases immediately instead of blocking worktree deletion for the drain window.
        let Ok(Ok(body)) = tokio::time::timeout_at(
            deadline,
            call_pruning_rpc(app, endpoint, &target.directory, action, &parsed.rpc_input),
        )
        .await
        else {
            return parsed.blocked_response();
        };
        (body, entered)
    };

    if revalidate(app, workspace, endpoint, &parsed.session_id, action, &target, &displays, remaining).await.is_err() {
        return parsed.blocked_response();
    }
    if !is_current(&displays) {
        return parsed.blocked_response();
    }

    let node_limit = action.rpc_node_limit();
    let parsed_output = if body.len() > 32 * 1024 {
        let parsed_owned = parsed.clone();
        tokio::task::spawn_blocking(move || {
            parse_rpc_output(&body, node_limit).and_then(|raw_output| validate_output(&parsed_owned, &raw_output))
        })
        .await
        .ok()
        .flatten()
    } else {
        parse_rpc_output(&body, node_limit).and_then(|raw_output| validate_output(parsed, &raw_output))
    };

    if !is_current(&displays) || principal.0.is_cancelled() {
        return parsed.blocked_response();
    }

    match parsed_output {
        Some(output) => Json(output).into_response(),
        None => parsed.blocked_response(),
    }
}

fn parse_rpc_output(body: &[u8], node_limit: usize) -> Option<Value> {
    if !super::media_stream::json_node_count_within(body, node_limit) {
        return None;
    }
    let mut envelope = serde_json::from_slice::<Value>(body).ok()?;
    envelope.as_object_mut()?.remove("output")
}

fn is_json_content_type(headers: &reqwest::header::HeaderMap) -> bool {
    headers.get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let essence = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        essence == "application/json" || essence.ends_with("+json")
    })
}

async fn prepare_pruning(
    app: &Shared,
    endpoint: &Arc<Endpoint>,
    directory: &str,
    deadline: Instant,
    still_valid: impl Fn() -> bool,
) -> Result<(), ()> {
    if !still_valid()
        || !crate::extensions::readiness::readiness_directory(directory)
        || !crate::extensions::lifecycle::has_strict_ready_lease(app, endpoint)
    {
        return Err(());
    }
    let url = endpoint.url.join("/api/plugin").map_err(|_| ())?;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || !app.native.current(endpoint) || !still_valid() {
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
        if response.status() != Status::OK || !is_json_content_type(response.headers()) {
            return Err(());
        }
        let catalogue = opencode::read_json(response, PLUGIN_LIST_LIMIT).await?;
        let loc = catalogue.get("location").and_then(Value::as_object).ok_or(())?;
        if loc.get("directory").and_then(Value::as_str) != Some(directory) || loc.contains_key("workspaceID") {
            return Err(());
        }
        let status = catalogue["data"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == super::pending::SESSION_PRUNING_PLUGIN))
            .and_then(|p| p["state"]["status"].as_str());
        match status {
            Some("active") => break,
            Some("failed") => return Err(()),
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    crate::extensions::lifecycle::ready_strict_at(app, endpoint, directory, deadline, still_valid).await.map_err(|_| ())
}

/// Validates `session.location` with exact per-route TS order:
/// - `preview`/`prune` (`session-pruning.ts:36-37`): `readLocationRef` first (malformed/NUL/blank
///   `workspaceID` -> `None`/blocked), then `ownsLocation` (valid `workspaceID` -> `403`).
/// - `pruneBatch` (`session-history.ts:138-140`): `ownsLocation` first (any present `workspaceID`,
///   including `null`/blank/NUL -> `403`), then `readLocationRef`.
fn valid_location_str(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.trim().is_empty() && !s.contains('\0'))
}

fn read_session_directory(session: &Value, action: Action) -> Result<String, Option<Error>> {
    let loc = session.get("location").and_then(Value::as_object).ok_or(None)?;
    let forbidden = || error(Status::FORBIDDEN, "Session does not belong to workspace");
    match action {
        Action::Batch => {
            if loc.contains_key("workspaceID") {
                return Err(Some(forbidden()));
            }
            let dir = loc.get("directory").and_then(valid_location_str).ok_or(None)?;
            Ok(dir.to_owned())
        }
        Action::Preview | Action::Prune => {
            let dir = loc.get("directory").and_then(valid_location_str).ok_or(None)?;
            if let Some(ws) = loc.get("workspaceID") {
                return if valid_location_str(ws).is_some() { Err(Some(forbidden())) } else { Err(None) };
            }
            Ok(dir.to_owned())
        }
    }
}

async fn prove_ownership(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    directory: &str,
) -> Result<Option<OwnedTarget>, ()> {
    if !crate::files::paths::local_absolute(directory) || !crate::files::paths::under(&app.scope, Path::new(directory))
    {
        return Ok(None);
    }
    let scope = app.scope.clone();
    let dir_owned = directory.to_owned();
    let resolved = tokio::task::spawn_blocking(move || -> Result<Option<(PathBuf, PathBuf, String)>, ()> {
        let Some((path, anchor)) = ownership::resolve_media_path_checked(&scope, &dir_owned).map_err(|_| ())? else {
            return Ok(None);
        };
        let anchor_id = crate::files::directory_identity(&anchor).map_err(|_| ())?;
        Ok(Some((path, anchor, anchor_id)))
    })
    .await
    .map_err(|_| ())??;
    let Some((path, anchor, anchor_id)) = resolved else {
        return Ok(None);
    };
    let proof = ownership::media_directory(app, workspace, endpoint, &path, &anchor, false).await.map_err(|_| ())?;
    Ok(proof.map(|checkout| OwnedTarget { directory: directory.to_owned(), path, anchor, anchor_id, checkout }))
}

#[allow(clippy::too_many_arguments)]
async fn revalidate(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    session_id: &str,
    action: Action,
    target: &OwnedTarget,
    displays: &[Arc<AtomicBool>],
    remaining: impl Fn() -> Duration,
) -> Result<Value, ()> {
    let check_fast = || {
        app.native.current(endpoint)
            && super::permission_mode::workspace_current(app, workspace)
            && displays.iter().all(|d| d.load(Relaxed))
    };
    if !check_fast() {
        return Err(());
    }
    let latest = fetch_session(app, endpoint, session_id, remaining()).await?;
    if !check_fast() {
        return Err(());
    }
    let latest_dir = read_session_directory(&latest, action).map_err(|_| ())?;
    if latest_dir != target.directory {
        return Err(());
    }
    let fresh = prove_ownership(app, workspace, endpoint, &latest_dir).await?.ok_or(())?;
    if fresh.path != target.path
        || fresh.anchor != target.anchor
        || fresh.anchor_id != target.anchor_id
        || !target.checkout.same_checkout(&fresh.checkout)
        || !check_fast()
    {
        return Err(());
    }
    Ok(latest)
}

async fn fetch_session(app: &App, endpoint: &Endpoint, session_id: &str, timeout: Duration) -> Result<Value, ()> {
    if timeout.is_zero()
        || session_id.is_empty()
        || session_id.encode_utf16().nth(256).is_some()
        || matches!(session_id, "." | "..")
        || session_id.bytes().any(|b| b.is_ascii_control())
    {
        return Err(());
    }
    let mut url = endpoint.url.clone();
    url.path_segments_mut().map_err(|_| ())?.clear().extend(["api", "session", session_id]);
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ())?;
    if response.status() != Status::OK || !is_json_content_type(response.headers()) {
        return Err(());
    }
    let raw = opencode::read_bytes(response, SESSION_BODY_LIMIT).await?;
    if !super::media_stream::json_node_count_within(&raw, 100_000) {
        return Err(());
    }
    let body: Value = serde_json::from_slice(&raw).map_err(|_| ())?;
    let data = body.get("data").filter(|d| d.is_object() && d["id"].as_str() == Some(session_id)).ok_or(())?;
    Ok(data.clone())
}

fn is_exact_application_json(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
}

fn is_carrier_rpc_absent(body: &Value, status: Status) -> bool {
    if !matches!(status, Status::BAD_REQUEST | Status::NOT_FOUND)
        || body.as_object().is_none_or(|o| o.len() != 3)
        || body["_tag"] != "RpcError"
    {
        return false;
    }
    matches!(body["type"].as_str(), Some("rpc.method_not_found" | "rpc.unavailable"))
        && body["message"].as_str().is_some_and(|s| {
            let len = s.encode_utf16().count();
            (1..=4096).contains(&len)
        })
}

async fn verify_ordinary_session(
    app: &App,
    endpoint: &Endpoint,
    session_id: &str,
    directory: &str,
    record: &Value,
    remaining: Duration,
) -> Result<(), ()> {
    if session_id.starts_with("ses_cn_schedule_")
        || record["metadata"].get("codenomad.schedule-carrier").is_some()
        || remaining.is_zero()
    {
        return Err(());
    }
    let route = endpoint.url.join("/api/rpc/codenomad.missions/scheduleCarrierRead").map_err(|_| ())?;
    let response = app
        .native
        .client
        .post(route)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({ "input": { "sessionID": session_id } }))
        .timeout(remaining.min(CARRIER_TIMEOUT))
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    // Match TS `transport.ts:59`: non-OK responses must carry `application/json` (not
    // `application/problem+json`), otherwise the transport turns them into `OpenCodeContractError`.
    let mime_ok = if status == Status::OK {
        is_json_content_type(response.headers())
    } else {
        is_exact_application_json(response.headers())
    };
    if !mime_ok {
        return Err(());
    }
    let raw = opencode::read_bytes(response, 64 * 1024).await?;
    let body: Value = serde_json::from_slice(&raw).map_err(|_| ())?;
    if status == Status::OK {
        return (body["output"]["owned"].as_bool() == Some(false)).then_some(()).ok_or(());
    }
    if is_carrier_rpc_absent(&body, status)
        && record["model"]["providerID"] != "codenomad-missions-local"
        && record["title"] != "Mission schedule carrier"
    {
        Ok(())
    } else {
        Err(())
    }
}

async fn call_pruning_rpc(
    app: &App,
    endpoint: &Endpoint,
    directory: &str,
    action: Action,
    input: &Value,
) -> Result<Vec<u8>, ()> {
    let url =
        endpoint.url.join(&format!("/api/rpc/codenomad.session-pruning/{}", action.rpc_method())).map_err(|_| ())?;
    let response = app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({ "input": input }))
        .send()
        .await
        .map_err(|_| ())?;
    let ok = response.status() == Status::OK && is_json_content_type(response.headers());
    let body = opencode::read_bytes(response, action.rpc_body_limit()).await;
    if ok { body } else { Err(()) }
}

#[cfg(test)]
#[path = "pruning_tests.rs"]
mod tests;
