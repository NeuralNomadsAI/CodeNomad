//! Open workspaces: creation (validated by the daemon's location, cancellable by request
//! ID), listing, release of a creation claim and removal.
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use axum::{
    Extension, Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    App, Error, Shared, Workspace,
    app::Inventory,
    auth,
    files::paths,
    now,
    opencode::{Refusal, admission, daemon},
};

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces", get(list).post(create))
        .route("/api/workspaces/clone", post(crate::workspace_clone::clone))
        .route("/api/workspaces/{id}", get(detail).delete(delete))
        .route("/api/workspaces/creation/cancel", post(cancel))
        .route("/api/workspaces/{id}/creation/release", post(release))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Create {
    path: std::path::PathBuf,
    name: Option<String>,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    request_id: String,
}

#[derive(Default)]
pub struct EarlyCancellations(VecDeque<(String, Instant)>);
impl EarlyCancellations {
    fn cancel(&mut self, key: String, now: Instant) {
        self.0.retain(|(id, _)| id != &key);
        self.0.push_back((key, now + Duration::from_secs(30)));
        if self.0.len() > 1024 {
            self.0.pop_front();
        }
    }
    fn admits(&mut self, key: &str, now: Instant) -> bool {
        if self.0.iter().any(|(id, until)| id == key && *until > now) {
            return false;
        }
        self.0.retain(|(id, _)| id != key);
        true
    }
}

async fn list(State(app): State<Shared>) -> Json<Vec<Workspace>> {
    Json(app.inner.lock().unwrap().workspaces.clone())
}

async fn detail(State(app): State<Shared>, Path(id): Path<String>) -> Result<Json<Workspace>, Error> {
    app.workspace(&id).map(Json)
}

struct CreationGuard(Shared, String);
impl Drop for CreationGuard {
    fn drop(&mut self) {
        self.0.inner.lock().unwrap().pending.remove(&self.1);
    }
}

pub(crate) fn request_id_valid(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= 128
}

async fn create(
    State(app): State<Shared>,
    Extension(principal): Extension<auth::Principal>,
    input: Result<Json<Create>, JsonRejection>,
) -> Response {
    let bad_request = |message: String| (Status::BAD_REQUEST, message).into_response();
    let Ok(Json(input)) = input else { return bad_request("Invalid workspace creation request".into()) };
    let request_id = input.request_id.map(|s| s.trim_matches(crate::shared::js_space).to_owned());
    if request_id.as_ref().is_some_and(|s| !request_id_valid(s)) {
        return bad_request("Invalid workspace creation request".into());
    }
    let cancellation = CancellationToken::new();
    let _claim = if let Some(key) = &request_id {
        let mut store = app.inner.lock().unwrap();
        if !store.early_cancellations.admits(key, Instant::now()) {
            return bad_request(format!("Workspace creation request {key} was cancelled"));
        }
        if store.pending.contains_key(key)
            || store.released.values().any(|v| v == key)
            || store.workspaces.iter().any(|w| w.request_id.as_deref() == Some(key))
        {
            return bad_request(format!("Workspace creation request {key} is already in use"));
        }
        if store.pending.len() >= 16 {
            return bad_request("Too many workspace creations are already in progress".into());
        }
        store.pending.insert(key.clone(), cancellation.clone());
        Some(CreationGuard(app.clone(), key.clone()))
    } else {
        None
    };
    let candidate = app.root.join(input.path);
    // `--unrestricted-root`: any local folder, absolute or relative to the root (audit M2 still applies).
    let candidate = match app.unrestricted {
        true => std::path::PathBuf::from(crate::files::browse::normalize(&candidate.to_string_lossy())),
        false => candidate,
    };
    if !paths::under(&app.scope, &candidate) {
        return bad_request("Workspace directory is not authorized".into());
    }
    let authorized = |path: &std::path::PathBuf| path.starts_with(&app.scope) && path.is_dir();
    let Some(path) = dunce::canonicalize(candidate).ok().filter(authorized) else {
        return bad_request("Workspace directory is not authorized".into());
    };
    if crate::worktrees::fence::is_deleting_root(&crate::worktrees::fence::identity(&path)) {
        return bad_request("Workspace directory is being removed".into());
    }
    let validation = async {
        let deadline = tokio::time::Instant::now() + daemon::TIMEOUT;
        let endpoint = app.native.acquire(deadline).await?;
        crate::extensions::lifecycle::prepare(&app, &endpoint).await;
        let response = app
            .native
            .get("/api/location")
            .query(&[("location[directory]", &path)])
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()
            .and_then(|r| r.error_for_status().ok());
        let Some(response) = response else { return Ok(None) };
        let native: Value = response.json().await.unwrap_or_default();
        let location = native.get("data").unwrap_or(&native);
        let directory = location["directory"].as_str().filter(|d| dunce::canonicalize(d).is_ok_and(|d| d == path));
        Ok(directory.map(|directory| json!({"directory": directory})))
    };
    let cancelled =
        || bad_request(format!("Workspace creation request {} was cancelled", request_id.as_deref().unwrap_or("")));
    let location = tokio::select! {
        _ = cancellation.cancelled() => return cancelled(),
        _ = principal.0.cancelled() => return auth::unauthorized().into_response(),
        location = validation => location,
    };
    let location = match location {
        Ok(location) => location,
        Err(refusal) => {
            eprintln!("Workspace failed to start: {refusal}");
            return match refusal {
                Refusal::Unsupported { ref actual, reason } => (
                    Status::UPGRADE_REQUIRED,
                    Json(json!({"error": "opencode_update_required", "message": refusal.to_string(),
                        "actualVersion": actual, "minimumVersion": admission::MINIMUM_VERSION, "reason": reason})),
                )
                    .into_response(),
                Refusal::Failed(message) => bad_request(message),
            };
        }
    };
    let Some(location) = location else { return bad_request("OpenCode location is unavailable".into()) };
    if let Err(e) = principal.live() {
        return e.into_response();
    }
    if dunce::canonicalize(&path).ok().as_ref() != Some(&path) {
        return bad_request("Workspace folder changed during opening".into());
    }
    let mut store = app.inner.lock().unwrap();
    if crate::worktrees::fence::is_deleting_root(&crate::worktrees::fence::identity(&path)) {
        return bad_request("Workspace directory is being removed".into());
    }
    if store.workspaces.len() >= 128 {
        return bad_request("Too many open workspaces".into());
    }
    if cancellation.is_cancelled() {
        return cancelled();
    }
    let id = Uuid::new_v4();
    let temporary = app.temporary_workspaces.as_ref().is_some_and(|t| t.has(&path)).then_some(true);
    let current_binary = app.current_binary();
    let mut workspace = Workspace {
        id,
        request_id,
        path,
        name: input.name,
        status: "starting",
        proxy_path: format!("/workspaces/{id}/instance"),
        binary_id: current_binary.clone(),
        binary_label: current_binary.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        created_at: now(),
        updated_at: now(),
        location,
        temporary,
    };
    app.emit(json!({"type":"workspace.created","workspace":workspace}));
    workspace.status = "ready";
    workspace.updated_at = now();
    app.emit(json!({"type":"workspace.started","workspace":workspace}));
    store.workspaces.push(workspace.clone());
    if store.generation > 0 {
        app.emit_status(id, store.status, store.generation, None);
    }
    app.opened.notify_one();
    (Status::CREATED, Json(workspace)).into_response()
}

async fn delete(State(app): State<Shared>, Path(id): Path<String>) -> Status {
    let mut store = app.inner.lock().unwrap();
    if let Some(index) = store.workspaces.iter().position(|w| w.id.to_string() == id) {
        app.remove(&mut store, index, true);
    }
    Status::NO_CONTENT
}

fn read_claim(input: Result<Json<Claim>, JsonRejection>) -> Result<String, (Status, &'static str)> {
    input
        .ok()
        .map(|value| value.0.request_id.trim_matches(crate::shared::js_space).to_owned())
        .filter(|key| request_id_valid(key))
        .ok_or((Status::BAD_REQUEST, "Invalid workspace creation request"))
}

async fn cancel(
    State(app): State<Shared>,
    input: Result<Json<Claim>, JsonRejection>,
) -> Result<Status, (Status, &'static str)> {
    let key = read_claim(input)?;
    app.cancel_workspace_creation(&key);
    Ok(Status::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_cancellation_keeps_exact_identity_until_its_deadline() {
        let now = Instant::now();
        let mut cancelled = EarlyCancellations::default();
        cancelled.cancel("departing".into(), now);
        assert!(!cancelled.admits("departing", now));
        assert!(!cancelled.admits("departing", now + Duration::from_millis(29_999)));
        assert!(cancelled.admits("other", now));
        assert_eq!(cancelled.0.len(), 1);
        assert!(cancelled.admits("departing", now + Duration::from_secs(30)));
        assert!(cancelled.0.is_empty());
    }

    #[test]
    fn repeated_cancellation_refreshes_ttl_and_eviction_order_with_a_fixed_bound() {
        let now = Instant::now();
        let mut cancelled = EarlyCancellations::default();
        for i in 0..1024 {
            cancelled.cancel(i.to_string(), now);
        }
        cancelled.cancel("0".into(), now + Duration::from_secs(5));
        cancelled.cancel("new".into(), now + Duration::from_secs(5));
        assert_eq!(cancelled.0.len(), 1024);
        assert!(cancelled.admits("1", now + Duration::from_secs(5)));
        assert!(!cancelled.admits("0", now + Duration::from_secs(30)));
        assert!(!cancelled.admits("new", now + Duration::from_secs(30)));
        assert!(cancelled.admits("0", now + Duration::from_secs(35)));
        assert!(cancelled.admits("new", now + Duration::from_secs(35)));
    }

    #[test]
    fn claim_parsing_uses_javascript_trim_and_zod_scalar_bound() {
        let claim = |id: &str| read_claim(Ok(Json(Claim { request_id: id.into() })));
        assert_eq!(claim("\u{feff} request \u{feff}").unwrap(), "request");
        assert_eq!(claim("\u{85}request\u{85}").unwrap(), "\u{85}request\u{85}");
        assert!(claim(&format!("{}x", "🦀".repeat(64))).is_ok());
        assert!(claim(&"🦀".repeat(128)).is_ok());
        assert!(claim(&"🦀".repeat(129)).is_err());
        assert!(claim(&"x".repeat(128)).is_ok());
        assert!(claim(&"x".repeat(129)).is_err());
        assert!(claim("\u{feff} \t\u{feff}").is_err());
    }
}

async fn release(
    State(app): State<Shared>,
    Path(id): Path<Uuid>,
    input: Result<Json<Claim>, JsonRejection>,
) -> Result<Status, (Status, &'static str)> {
    let key = read_claim(input)?;
    let mut store = app.inner.lock().unwrap();
    if store.released.get(&id) == Some(&key) {
        return Ok(Status::NO_CONTENT);
    }
    let Some(workspace) = store.workspaces.iter_mut().find(|w| w.id == id && w.request_id.as_deref() == Some(&key))
    else {
        return Err((Status::NOT_FOUND, "Workspace creation request not found"));
    };
    workspace.request_id = None;
    store.released.insert(id, key);
    Ok(Status::NO_CONTENT)
}

impl App {
    pub(crate) fn cancel_workspace_creation(&self, key: &str) {
        let mut store = self.inner.lock().unwrap();
        if let Some(pending) = store.pending.get(key) {
            pending.cancel();
        } else if !store.released.values().any(|id| id == key)
            && !store.workspaces.iter().any(|w| w.request_id.as_deref() == Some(key))
        {
            // A departing client's keepalive can arrive before its creation POST.
            store.early_cancellations.cancel(key.to_owned(), Instant::now());
        }
        if let Some(index) = store.workspaces.iter().position(|w| w.request_id.as_deref() == Some(key)) {
            self.remove(&mut store, index, true);
        }
    }

    pub(crate) fn remove(&self, store: &mut Inventory, index: usize, temporary_retained: bool) {
        let workspace = store.workspaces.remove(index);
        crate::worktrees::linked::forget(self, workspace.id);
        self.file_watches.lock().unwrap().forget(workspace.id);
        store.released.remove(&workspace.id);
        self.emit_status(workspace.id, "disconnected", store.generation, Some("workspace stopped"));
        let mut stopped = json!({"type":"workspace.stopped","workspaceId":workspace.id,"reason":"deleted"});
        if temporary_retained {
            stopped["temporaryRetained"] = json!(true);
        }
        self.emit(stopped);
        self.workspace_closed.notify_waiters();
    }
}
