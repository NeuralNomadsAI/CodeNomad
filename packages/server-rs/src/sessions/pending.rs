//! Pending questions and permissions of a workspace, from the native pending-requests plugin.
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::{Error, Shared, error, unavailable};

/// `PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS` and `READINESS_WAIT_MS` of the reference.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_WAIT: Duration = Duration::from_secs(5);
pub const SESSION_PRUNING_PLUGIN: &str = "codenomad-session-pruning";

pub enum PluginWait {
    TimedOut,
    Failed,
}
/// Reference `awaitNativePlugin`: prepares only a caller-authorized Location
/// by polling the native plugin catalogue until the plugin is active, within
/// the 5 s readiness wait and the caller's deadline.
pub async fn await_plugin(
    app: &crate::App,
    plugin: &str,
    directory: &str,
    deadline: tokio::time::Instant,
) -> Result<(), PluginWait> {
    let ready = tokio::time::Instant::now() + READINESS_WAIT;
    loop {
        let left = ready.min(deadline).saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err(PluginWait::TimedOut);
        }
        let listed =
            app.native.get("/api/plugin").query(&[("location[directory]", directory)]).timeout(left).send().await;
        let catalogue: Value = match listed {
            Err(e) if e.is_timeout() => return Err(PluginWait::TimedOut),
            Err(_) => return Err(PluginWait::Failed),
            Ok(r) if !r.status().is_success() => return Err(PluginWait::Failed),
            Ok(r) => crate::opencode::read_json(r, 1024 * 1024).await.map_err(|_| PluginWait::Failed)?,
        };
        if catalogue["location"]["directory"] != directory {
            return Err(PluginWait::Failed);
        }
        let state = catalogue["data"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == plugin))
            .map(|p| p["state"]["status"].clone());
        match state.as_ref().and_then(Value::as_str) {
            Some("active") => return Ok(()),
            Some("failed") => return Err(PluginWait::Failed),
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

pub async fn snapshot(
    State(app): State<Shared>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    Extension(shutdown): Extension<CancellationToken>,
) -> Result<Response, Error> {
    // A read waiting for plugin readiness outlives the desktop host's shutdown grace.
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => Err(error(Status::SERVICE_UNAVAILABLE, "Server is shutting down")),
        result = read_snapshot(app, id, query) => result,
    }
}

async fn read_snapshot(app: Shared, id: String, query: Option<String>) -> Result<Response, Error> {
    let bad = || error(Status::BAD_REQUEST, "Invalid pending request directories");
    let mut parsed = app.native.url();
    parsed.set_query(query.as_deref());
    let items: Vec<_> = parsed.query_pairs().collect();
    if items.is_empty()
        || items.len() > 128
        || items.iter().any(|(key, value)| {
            !matches!(key.as_ref(), "directories" | "optionalDirectories")
                || value.is_empty()
                || value.encode_utf16().count() > 4096
        })
    {
        return Err(bad());
    }
    let mandatory: Vec<_> = items.iter().filter(|(key, _)| key == "directories").map(|(_, value)| value).collect();
    let optional: Vec<_> =
        items.iter().filter(|(key, _)| key == "optionalDirectories").map(|(_, value)| value).collect();
    if mandatory.is_empty()
        || mandatory.len() > 64
        || optional.len() > 64
        || optional.iter().any(|path| !mandatory.contains(path))
    {
        return Err(bad());
    }
    let workspace = app.workspace(&id)?;
    if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
        return Ok(unavailable());
    }
    let directory = workspace.location["directory"].as_str().ok_or_else(bad)?;
    let placement = same_file::Handle::from_path(&workspace.path).map_err(|_| bad())?;
    if mandatory.iter().any(|path| path.as_ref() != directory) {
        return Err(error(Status::FORBIDDEN, "Directory does not belong to workspace"));
    }
    let deadline = tokio::time::Instant::now() + SNAPSHOT_TIMEOUT;
    let fail = || error(Status::SERVICE_UNAVAILABLE, "Pending requests unavailable; retain existing queues");
    let timeout = || {
        (
            Status::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Pending requests unavailable; retain existing queues","code":"timeout"})),
        )
    };
    // Warm only the authorized bootstrap: the validated read below proves
    // registration (reference #1590, `awaitNativePlugin`, 5 s readiness wait).
    match await_plugin(&app, SESSION_PRUNING_PLUGIN, directory, deadline).await {
        Ok(()) => {}
        Err(PluginWait::TimedOut) => return Err(timeout()),
        Err(PluginWait::Failed) => return Err(fail()),
    }
    app.workspace(&id)?;
    let resp = app
        .native
        .rpc("codenomad.pending-requests/snapshot", directory, &json!({"directories": [directory]}))
        .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { timeout() } else { fail() })?;
    let status = resp.status();
    if status == Status::BAD_REQUEST {
        let data: Option<Value> = resp.json().await.ok();
        data.filter(|d| crate::opencode::native_rpc_absent(d, status)).ok_or_else(fail)?;
        app.workspace(&id)?;
        if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
            return Ok(unavailable());
        }
        return Ok(([(header::CACHE_CONTROL, "no-store")], Json(json!({"supported":false}))).into_response());
    }
    if status.is_success() {
        let body = crate::opencode::read_json(resp, 4 * 1024 * 1024).await.ok();
        let valid =
            |b: &Value| crate::sessions::history::pending_valid(b) && b["output"]["originDirectory"] == directory;
        let body = body.filter(valid).ok_or_else(fail)?;
        let rows = body["output"]["data"].as_array();
        let rows = rows.filter(|r| r.len() == 1 && r[0]["directory"] == directory).ok_or_else(fail)?;
        let locations = rows[0]["locations"].as_array().ok_or_else(fail)?;
        let current = app.workspace(&id)?;
        if current.path != workspace.path
            || !same_file::Handle::from_path(&current.path).is_ok_and(|current| current == placement)
            || !crate::worktrees::exact_root_supported(&app, &current).await?
        {
            return Err(fail());
        }
        let result = if locations.len() > 1
            || locations
                .iter()
                .any(|row| row["location"]["directory"] != directory || row["location"].get("workspaceID").is_some())
        {
            json!({"supported":true,"directories":[{"directory":directory,"status":"error","reason":"not-owned"}]})
        } else {
            let locations = if locations.is_empty() {
                json!([{"location":{"directory":directory},"permissions":[],"forms":[]}])
            } else {
                Value::Array(locations.clone())
            };
            json!({"supported":true,"directories":[{"directory":directory,"status":"ok","locations":locations}]})
        };
        return Ok(([(header::CACHE_CONTROL, "no-store")], Json(result)).into_response());
    }
    Err(fail())
}
