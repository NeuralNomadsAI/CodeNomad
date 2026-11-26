//! OpenCode configuration settings routes backed by `PluginControls` document acquisition:
//! - `GET`/`PUT /api/workspaces/:id/websearch-settings` (`routes/websearch-settings.ts`, `opencode/websearch-settings.ts`)
//! - `GET`/`PUT /api/workspaces/:id/image-settings` (`routes/image-settings.ts`, `opencode/image-settings.ts`)

mod images;
mod websearch;

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    App, Shared, Workspace,
    auth::Principal,
    files::node_path::Style,
    opencode::Endpoint,
    shared::fastify,
    subagent_depth::{
        Fail, Target,
        document::{DocError, Document},
        fs, jsonc, resolve_targets, rules,
    },
    worktrees::{fence, ownership},
};

const BODY_LIMIT: usize = 1024 * 1024;
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    Global,
    Project,
}

impl Scope {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    pub(crate) fn is_project(self) -> bool {
        matches!(self, Self::Project)
    }
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/websearch-settings", get(websearch::get).put(websearch::put).fallback(not_found))
        .route("/api/workspaces/{id}/image-settings", get(images::get).put(images::put).fallback(not_found))
}

async fn not_found() -> Response {
    (Status::NOT_FOUND, Json(json!({ "message": "Not Found" }))).into_response()
}

pub(crate) const fn fail(status: Status, message: &'static str) -> Fail {
    Fail::Status(status, message)
}

pub(crate) fn mapped(error: DocError) -> Fail {
    match error {
        DocError::Invalid(message) => fail(Status::UNPROCESSABLE_ENTITY, message),
        DocError::Conflict(message) => fail(Status::CONFLICT, message),
        DocError::Filesystem(message) => fail(Status::SERVICE_UNAVAILABLE, message),
        DocError::Plain => Fail::Generic,
    }
}

pub(crate) fn raw(_: DocError) -> Fail {
    Fail::Generic
}

pub(super) fn fail_response(error: Fail, generic_message: &'static str) -> Response {
    match error {
        Fail::Status(status, message) => (status, Json(json!({ "error": message }))).into_response(),
        Fail::Generic => (Status::SERVICE_UNAVAILABLE, Json(json!({ "error": generic_message }))).into_response(),
    }
}

pub(crate) fn bad_request(message: &'static str) -> Response {
    (Status::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

pub(crate) fn principal_token(principal: Option<axum::Extension<Principal>>) -> Option<CancellationToken> {
    principal.map(|axum::Extension(p)| p.0)
}

pub(crate) fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| (c as u32) <= 0x1f || c == '\x7f')
}

pub(crate) fn decode_query(raw: &str) -> String {
    let plus = raw.replace('+', " ");
    percent_encoding::percent_decode_str(&plus).decode_utf8().map(|c| c.into_owned()).unwrap_or(plus)
}

/// Strict Zod `z.string().trim().min(1).max(32_768)` using JS trim & UTF-16 code units.
pub(crate) fn location_directory(raw: &str) -> Option<String> {
    let trimmed = crate::shared::js_trim(raw).to_owned();
    (1..=32_768).contains(&trimmed.encode_utf16().count()).then_some(trimmed)
}

/// Strict `Location` query: exactly one `directory` parameter.
pub(super) fn query_directory(raw: Option<&str>) -> Option<String> {
    let mut found = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode_query(key) != "directory" || found.is_some() {
            return None;
        }
        found = Some(decode_query(value));
    }
    location_directory(&found?)
}

pub(super) fn parse_location_object(value: &Value) -> Option<String> {
    let map = value.as_object().filter(|m| m.len() == 1)?;
    location_directory(map.get("directory")?.as_str()?)
}

pub(crate) fn close_response(mut response: Response) -> Response {
    response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn body_too_large() -> Response {
    close_response(
        fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
            .into_response(),
    )
}

/// Reads the raw request body bytes enforcing Fastify 5 content-type framing and 1 MiB limit.
pub(crate) async fn read_body_bytes(
    headers: &HeaderMap,
    body: Body,
    invalid_message: &'static str,
) -> Result<Vec<u8>, Box<Response>> {
    let media_error = || {
        Box::new(
            fastify::error(Status::UNSUPPORTED_MEDIA_TYPE, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type")
                .into_response(),
        )
    };

    // Fastify selects the content-type parser before checking body size or draining the stream.
    // Without `Content-Type`, Fastify 5 only skips the parser when `Transfer-Encoding` is absent
    // and `Content-Length` is absent or literally `"0"`.
    let raw_content_length = headers.get(header::CONTENT_LENGTH);
    let declared_len = raw_content_length.and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
    let has_transfer_encoding = headers.contains_key(header::TRANSFER_ENCODING);

    match headers.get(header::CONTENT_TYPE) {
        None => {
            if has_transfer_encoding || raw_content_length.is_some_and(|v| v.as_bytes() != b"0") {
                return Err(media_error());
            }
            if raw_content_length.is_some() {
                return Err(Box::new(bad_request(invalid_message)));
            }
        }
        Some(kind) => {
            let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !matches!(essence.as_str(), "application/json" | "text/plain") {
                return Err(media_error());
            }
        }
    }

    if declared_len.is_some_and(|n| n > BODY_LIMIT as u64) {
        return Err(Box::new(body_too_large()));
    }

    let mut bytes = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            // Transport truncation / premature EOF: 400 without route schema error or 413.
            return Err(Box::new(close_response(Status::BAD_REQUEST.into_response())));
        };
        if headers.get(header::CONTENT_TYPE).is_none() && !chunk.is_empty() {
            return Err(media_error());
        }
        if bytes.len().saturating_add(chunk.len()) > BODY_LIMIT {
            return Err(Box::new(body_too_large()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Reads and parses a Fastify 5 JSON body within the 1 MiB default body limit.
pub(crate) async fn read_json_body(
    headers: &HeaderMap,
    body: Body,
    invalid_message: &'static str,
) -> Result<Value, Box<Response>> {
    let bytes = read_body_bytes(headers, body, invalid_message).await?;
    match fastify::body(headers, &bytes) {
        Ok(Some(fastify::Body::Json(value))) => Ok(value),
        Ok(_) => Err(Box::new(bad_request(invalid_message))),
        Err(err) => {
            let close = err.0 == Status::BAD_REQUEST;
            let response = err.into_response();
            Err(Box::new(if close { close_response(response) } else { response }))
        }
    }
}

pub(crate) struct CommitGuard<'a> {
    _connection: crate::opencode::ConnectionGuard<'a>,
    _workspaces: std::sync::MutexGuard<'a, crate::app::Inventory>,
}

/// Acquires workspace and connection locks in canonical order (`app.inner` -> `native.endpoint` ->
/// `native.validated`) and confirms both remain live for the duration of the returned guard.
pub(crate) fn guard_current<'a>(
    app: &'a App,
    endpoint: &Arc<Endpoint>,
    pinned_endpoint: Option<&Arc<Endpoint>>,
    workspace: &Workspace,
    principal: Option<&CancellationToken>,
) -> Result<CommitGuard<'a>, Fail> {
    if principal.is_some_and(CancellationToken::is_cancelled) {
        return Err(fail(Status::UNAUTHORIZED, "Authentication required"));
    }
    if pinned_endpoint.is_some_and(|pinned| !Arc::ptr_eq(pinned, endpoint)) {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed"));
    }
    let workspaces = app.inner.lock().unwrap();
    let workspace_live = workspaces.workspaces.iter().any(|current| {
        current.id == workspace.id
            && current.status == "ready"
            && current.created_at == workspace.created_at
            && current.path == workspace.path
    });
    if !workspace_live {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed"));
    }
    let Some(connection) = app.native.guard_current(endpoint) else {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed"));
    };
    if principal.is_some_and(CancellationToken::is_cancelled) {
        return Err(fail(Status::UNAUTHORIZED, "Authentication required"));
    }
    Ok(CommitGuard { _connection: connection, _workspaces: workspaces })
}

pub(crate) fn assert_current(
    app: &App,
    endpoint: &Arc<Endpoint>,
    workspace: &Workspace,
    principal: Option<&CancellationToken>,
) -> Result<(), Fail> {
    guard_current(app, endpoint, None, workspace, principal).map(|_| ())
}

pub(super) async fn acquire_ready_connection(
    app: &App,
    workspace_id: &str,
    unavailable_message: &'static str,
) -> Result<(Workspace, Arc<Endpoint>), Fail> {
    let workspace = app
        .workspace(workspace_id)
        .ok()
        .filter(|w| w.status == "ready")
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, unavailable_message))?;
    let endpoint = app
        .native
        .acquire(Instant::now() + ACQUIRE_TIMEOUT)
        .await
        .map_err(|_| fail(Status::SERVICE_UNAVAILABLE, unavailable_message))?;
    if guard_current(app, &endpoint, None, &workspace, None).is_err() {
        return Err(fail(Status::SERVICE_UNAVAILABLE, unavailable_message));
    }
    Ok((workspace, endpoint))
}

pub(crate) async fn native_get(
    app: &App,
    endpoint: &Endpoint,
    path: &str,
    query: &[(&str, &str)],
    timeout: Duration,
    max_bytes: usize,
) -> Result<Value, ()> {
    let url = endpoint.url.join(path).map_err(|_| ())?;
    let response = app
        .native
        .client
        .request(Method::GET, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(query)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    crate::opencode::read_json(response, max_bytes).await
}

pub(super) struct ConfigContext {
    pub(super) workspace: Workspace,
    pub(super) endpoint: Arc<Endpoint>,
    pub(super) location: String,
    pub(super) entries: Vec<Value>,
    pub(super) targets: Vec<Target>,
}

pub(super) struct AcquiredDocuments {
    pub(super) workspace: Workspace,
    pub(super) location: String,
    pub(super) entries: Vec<Value>,
    pub(super) documents: Vec<(Target, Document)>,
}

/// `PluginControls.readContext` (`strictDocuments = false`) with explicit connection & ownership checks.
async fn read_context(
    app: &App,
    workspace_id: &str,
    requested: &str,
    acquired: Option<Arc<Endpoint>>,
    principal: Option<&CancellationToken>,
) -> Result<ConfigContext, Fail> {
    let workspace = app.workspace(workspace_id).map_err(|_| fail(Status::NOT_FOUND, "Workspace not found"))?;
    let directory = crate::shared::js_trim(requested).to_owned();
    if directory.is_empty() || directory.contains('\0') {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "Invalid OpenCode location"));
    }
    let endpoint = match acquired {
        Some(ep) => {
            if workspace.status != "ready" {
                return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"));
            }
            ep
        }
        None => {
            if workspace.status != "ready" {
                return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"));
            }
            app.native
                .acquire(Instant::now() + ACQUIRE_TIMEOUT)
                .await
                .map_err(|_| fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"))?
        }
    };
    assert_current(app, &endpoint, &workspace, principal)?;

    let foreign = fail(Status::FORBIDDEN, "Location is not owned by this workspace");
    let resolved = ownership::resolve(app, &workspace, &directory).await.ok_or(foreign.clone())?;
    let location = resolved.directory;
    if ownership::resolve(app, &workspace, &location).await.is_none() {
        return Err(foreign);
    }

    let query = [("location[directory]", location.as_str())];
    let (config, plugin) = tokio::join!(
        native_get(app, &endpoint, "/api/config", &query, Duration::from_secs(12), 16 * 1024 * 1024),
        native_get(app, &endpoint, "/api/plugin", &query, Duration::from_secs(12), 16 * 1024 * 1024),
    );
    assert_current(app, &endpoint, &workspace, principal)?;
    let entries = match (config, plugin) {
        (Ok(Value::Array(entries)), Ok(p)) if p["data"].is_array() => entries,
        _ => return Err(fail(Status::SERVICE_UNAVAILABLE, "Unable to read OpenCode plugin configuration")),
    };

    let style = Style::host();
    let global = entries
        .iter()
        .find(|e| e["type"] == "directory")
        .and_then(rules::path_of)
        .filter(|g| style.valid_absolute(g))
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode did not report its global configuration directory"))?
        .to_owned();
    if !style.valid_absolute(&location) {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "OpenCode location directory is invalid"));
    }

    let (project_dir, entry_list) = (location.clone(), entries.clone());
    let targets =
        tokio::task::spawn_blocking(move || resolve_targets(style, &global, &project_dir, &entry_list, false))
            .await
            .map_err(|_| Fail::Generic)??;
    assert_current(app, &endpoint, &workspace, principal)?;

    Ok(ConfigContext { workspace, endpoint, location, entries, targets })
}

/// `PluginControls.readConfigDocuments` (`strictDocuments = false`).
pub(super) async fn read_config_documents(
    app: &App,
    workspace_id: &str,
    directory: &str,
    acquired: Option<Arc<Endpoint>>,
    principal: Option<&CancellationToken>,
) -> Result<AcquiredDocuments, Fail> {
    let ctx = read_context(app, workspace_id, directory, acquired, principal).await?;
    let targets = ctx.targets;
    let documents = tokio::task::spawn_blocking(move || {
        targets.into_iter().map(|t| fs::load(&t.io).map(|d| (t, d))).collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| Fail::Generic)?
    .map_err(raw)?;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    Ok(AcquiredDocuments { workspace: ctx.workspace, location: ctx.location, entries: ctx.entries, documents })
}

/// `PluginControls.editConfigDocument` (`strictDocuments = false`) with per-scope queue,
/// worktree deletion fence, connection/workspace re-check under the file lock, and atomic rename.
pub(super) async fn edit_config_document<F>(
    app: &Shared,
    workspace_id: &str,
    directory: &str,
    scope: Scope,
    pinned_endpoint: Option<Arc<Endpoint>>,
    principal: Option<CancellationToken>,
    edit: F,
) -> Result<(), Fail>
where
    F: FnOnce(&Document) -> Result<jsonc::Text, Fail> + Send + 'static,
{
    let queue_key = match scope {
        Scope::Global => format!("{workspace_id}\nglobal"),
        Scope::Project => fence::project_key(workspace_id, directory),
    };
    let queue_guard = fence::serialize(queue_key).await;

    let ctx = read_context(app, workspace_id, directory, None, principal.as_ref()).await?;
    if let Some(ref pinned) = pinned_endpoint {
        assert_current(app, pinned, &ctx.workspace, principal.as_ref())?;
    }

    let target = ctx
        .targets
        .into_iter()
        .find(|t| t.project == scope.is_project())
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable"))?;

    let owner = ownership::resolve(app, &ctx.workspace, &ctx.location)
        .await
        .ok_or(fail(Status::FORBIDDEN, "Location is not owned by an active worktree"))?;
    let admitted = fence::enter(&[fence::identity(&owner.checkout)])
        .ok_or(fail(Status::CONFLICT, "Worktree deletion is in progress"))?;

    let app_commit = app.clone();
    let endpoint = ctx.endpoint;
    let workspace = ctx.workspace;

    // Hold both the worktree deletion admission and the per-target queue until the file write ends.
    tokio::task::spawn_blocking(move || {
        let _held = (admitted, queue_guard);
        let document = fs::load(&target.io).map_err(mapped)?;
        if let Some(ref pinned) = pinned_endpoint {
            assert_current(&app_commit, pinned, &workspace, principal.as_ref())?;
        }
        assert_current(&app_commit, &endpoint, &workspace, principal.as_ref())?;
        let updated = edit(&document)?;
        let prepared = fs::prepare(&document, &updated).map_err(mapped)?;
        // `beforeCommit`: verify and hold workspace + connection locks across `std::fs::rename`
        // under the file lock so an invalidation or workspace closure cannot race the commit.
        prepared.commit_checked(mapped, || {
            guard_current(&app_commit, &endpoint, pinned_endpoint.as_ref(), &workspace, principal.as_ref())
        })
    })
    .await
    .map_err(|_| Fail::Generic)?
}

#[cfg(test)]
mod tests;
