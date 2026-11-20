//! Open workspaces: creation (validated by the daemon's location, cancellable by request
//! ID), listing, release of a creation claim and removal.
use std::time::Duration;

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

use crate::{App, Error, Shared, Workspace, app::Inventory, auth, files::paths, now};

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces", get(list).post(create))
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

fn request_id_valid(key: &str) -> bool {
    !key.is_empty() && key.encode_utf16().count() <= 128
}

async fn create(
    State(app): State<Shared>,
    Extension(principal): Extension<auth::Principal>,
    input: Result<Json<Create>, JsonRejection>,
) -> Response {
    let bad_request = |message: String| (Status::BAD_REQUEST, message).into_response();
    let Ok(Json(input)) = input else { return bad_request("Invalid workspace creation request".into()) };
    let request_id = input.request_id.map(|s| s.trim().to_owned());
    if request_id.as_ref().is_some_and(|s| !request_id_valid(s)) {
        return bad_request("Invalid workspace creation request".into());
    }
    let cancellation = CancellationToken::new();
    let _claim = if let Some(key) = &request_id {
        let mut store = app.inner.lock().unwrap();
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
    if !paths::under(&app.root, &candidate) {
        return bad_request("Workspace directory is not authorized".into());
    }
    let authorized = |path: &std::path::PathBuf| path.starts_with(&app.root) && path.is_dir();
    let Some(path) = dunce::canonicalize(candidate).ok().filter(authorized) else {
        return bad_request("Workspace directory is not authorized".into());
    };
    let validation = async {
        let response = app
            .native
            .get("/api/location")
            .query(&[("location[directory]", &path)])
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let native: Value = response.json().await.ok()?;
        let location = native.get("data").unwrap_or(&native);
        let directory = location["directory"].as_str()?;
        (dunce::canonicalize(directory).ok()? == path).then(|| json!({"directory": directory}))
    };
    let cancelled =
        || bad_request(format!("Workspace creation request {} was cancelled", request_id.as_deref().unwrap_or("")));
    let location = tokio::select! {
        _ = cancellation.cancelled() => return cancelled(),
        _ = principal.0.cancelled() => return auth::unauthorized().into_response(),
        location = validation => location,
    };
    let Some(location) = location else { return bad_request("OpenCode location is unavailable".into()) };
    let _publish = app.project_mutation.lock().await;
    if let Err(e) = principal.live() {
        return e.into_response();
    }
    if dunce::canonicalize(&path).ok().as_ref() != Some(&path) {
        return bad_request("Workspace folder changed during opening".into());
    }
    let mut store = app.inner.lock().unwrap();
    if store.workspaces.len() >= 128 {
        return bad_request("Too many open workspaces".into());
    }
    if cancellation.is_cancelled() {
        return cancelled();
    }
    let id = Uuid::new_v4();
    let mut workspace = Workspace {
        id,
        request_id,
        path,
        name: input.name,
        status: "starting",
        proxy_path: format!("/workspaces/{id}/instance"),
        binary_id: app.binary.clone(),
        binary_label: app.binary.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        created_at: now(),
        updated_at: now(),
        location,
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
    let _mutation = app.project_mutation.lock().await;
    let mut store = app.inner.lock().unwrap();
    if let Some(index) = store.workspaces.iter().position(|w| w.id.to_string() == id) {
        app.remove(&mut store, index);
    }
    Status::NO_CONTENT
}

fn read_claim(input: Result<Json<Claim>, JsonRejection>) -> Result<String, (Status, &'static str)> {
    input
        .ok()
        .map(|value| value.0.request_id.trim().to_owned())
        .filter(|key| request_id_valid(key))
        .ok_or((Status::BAD_REQUEST, "Invalid workspace creation request"))
}

async fn cancel(
    State(app): State<Shared>,
    input: Result<Json<Claim>, JsonRejection>,
) -> Result<Status, (Status, &'static str)> {
    let key = read_claim(input)?;
    let _mutation = app.project_mutation.lock().await;
    let mut store = app.inner.lock().unwrap();
    if let Some(pending) = store.pending.get(&key) {
        pending.cancel();
    }
    if let Some(index) = store.workspaces.iter().position(|w| w.request_id.as_deref() == Some(&key)) {
        app.remove(&mut store, index);
    }
    Ok(Status::NO_CONTENT)
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
    fn remove(&self, store: &mut Inventory, index: usize) {
        let workspace = store.workspaces.remove(index);
        crate::worktrees::linked::forget(self, workspace.id);
        self.file_watches.lock().unwrap().forget(workspace.id);
        store.released.remove(&workspace.id);
        self.emit_status(workspace.id, "disconnected", store.generation, Some("workspace stopped"));
        self.emit(json!({"type":"workspace.stopped","workspaceId":workspace.id,"reason":"deleted"}));
    }
}
