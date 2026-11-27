//! `POST /api/workspaces/:id/images-conversation`: find or create a Location's Images
//! conversation through `codenomad.session-pruning` / `imagesConversation`, matching
//! `packages/server/src/server/routes/images-conversation.ts`.
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
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use super::{
    design_git_exclude::exclude_design_folder_cancellable,
    pruning::{
        OwnedTarget, fetch_session_bounded, is_json_content_type, prepare_pruning, prove_ownership, valid_location_str,
    },
};
use crate::{
    App, Error, Shared, Workspace,
    auth::Principal,
    error, git,
    opencode::{self, Endpoint, proxy_body},
    shared::fastify,
    worktrees::{fence, ownership},
};

const BODY_LIMIT: usize = 8192;
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const LOCATION_READ_TIMEOUT: Duration = Duration::from_secs(8);
const LOCATION_BODY_LIMIT: usize = 128 * 1024;
const RPC_BODY_LIMIT: usize = 64 * 1024;
const RPC_NODE_LIMIT: usize = 1_000;

fn unavailable() -> Response {
    Json(json!({ "status": "blocked", "reason": "unavailable" })).into_response()
}

fn denied() -> Response {
    error(Status::FORBIDDEN, "Location does not belong to workspace").into_response()
}

fn deleting() -> Response {
    error(Status::CONFLICT, "Worktree deletion is in progress").into_response()
}

fn invalid() -> Error {
    error(Status::BAD_REQUEST, "Invalid Images conversation request")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Lookup,
    Open,
    New,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lookup => "lookup",
            Self::Open => "open",
            Self::New => "new",
        }
    }
}

struct ParsedRequest {
    directory: String,
    mode: Mode,
    title: Option<String>,
    agent: Option<String>,
    model: Option<Value>,
}

fn utf16_len_in(s: &str, min: usize, max: usize) -> bool {
    let len = s.encode_utf16().count();
    (min..=max).contains(&len)
}

fn parse_request_body(value: &Value) -> Result<ParsedRequest, Error> {
    let obj = value.as_object().ok_or_else(invalid)?;
    if !obj.keys().all(|k| matches!(k.as_str(), "directory" | "mode" | "title" | "agent" | "model")) {
        return Err(invalid());
    }
    let directory =
        obj.get("directory").and_then(Value::as_str).filter(|s| utf16_len_in(s, 1, 4096)).ok_or_else(invalid)?;
    let mode = match obj.get("mode").and_then(Value::as_str) {
        Some("lookup") => Mode::Lookup,
        Some("open") => Mode::Open,
        Some("new") => Mode::New,
        _ => return Err(invalid()),
    };
    let opt_str = |key: &str| -> Result<Option<String>, Error> {
        match obj.get(key) {
            None => Ok(None),
            Some(Value::String(s)) if utf16_len_in(s, 1, 256) => Ok(Some(s.clone())),
            Some(_) => Err(invalid()),
        }
    };
    let title = opt_str("title")?;
    let agent = opt_str("agent")?;
    let model = match obj.get("model") {
        None => None,
        Some(Value::Object(m)) => {
            if !m.keys().all(|k| matches!(k.as_str(), "providerID" | "id" | "variant")) {
                return Err(invalid());
            }
            let provider_id =
                m.get("providerID").and_then(Value::as_str).filter(|s| utf16_len_in(s, 1, 256)).ok_or_else(invalid)?;
            let id = m.get("id").and_then(Value::as_str).filter(|s| utf16_len_in(s, 1, 256)).ok_or_else(invalid)?;
            let mut clean = Map::new();
            clean.insert("providerID".into(), json!(provider_id));
            clean.insert("id".into(), json!(id));
            if let Some(variant) = m.get("variant") {
                let v = variant.as_str().filter(|s| utf16_len_in(s, 1, 256)).ok_or_else(invalid)?;
                clean.insert("variant".into(), json!(v));
            }
            Some(Value::Object(clean))
        }
        Some(_) => return Err(invalid()),
    };
    Ok(ParsedRequest { directory: directory.to_owned(), mode, title, agent, model })
}

async fn read_request(request: Request, principal: &Principal) -> Result<ParsedRequest, Response> {
    let (head, body) = request.into_parts();
    let declared =
        head.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|len| len > BODY_LIMIT) {
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized().into_response()),
            _ = proxy_body::read(body, BODY_LIMIT, declared) => {}
        }
        principal.live().map_err(IntoResponse::into_response)?;
        return Err(proxy_body::too_large().into_response());
    }
    let bytes = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized().into_response()),
        res = proxy_body::read(body, BODY_LIMIT, declared) => res.map_err(IntoResponse::into_response)?,
    };
    principal.live().map_err(IntoResponse::into_response)?;
    let parsed_body = match fastify::body(&head.headers, &bytes).map_err(IntoResponse::into_response)? {
        None => Value::Null,
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    };
    parse_request_body(&parsed_body).map_err(IntoResponse::into_response)
}

enum RpcOutput {
    Found { session_id: String, created: bool },
    Absent,
    Unknown,
    Blocked { reason: String },
}

fn validate_rpc_output(value: &Value) -> Option<RpcOutput> {
    let obj = value.as_object()?;
    match obj.get("status").and_then(Value::as_str)? {
        "found" if obj.len() == 3 => {
            let session_id = obj.get("sessionID").and_then(Value::as_str).filter(|s| utf16_len_in(s, 1, 256))?;
            let created = obj.get("created").and_then(Value::as_bool)?;
            Some(RpcOutput::Found { session_id: session_id.to_owned(), created })
        }
        "absent" if obj.len() == 1 => Some(RpcOutput::Absent),
        "unknown" if obj.len() == 1 => Some(RpcOutput::Unknown),
        "blocked" if obj.len() == 2 => {
            let reason = obj.get("reason").and_then(Value::as_str).filter(|s| utf16_len_in(s, 0, 80))?;
            Some(RpcOutput::Blocked { reason: reason.to_owned() })
        }
        _ => None,
    }
}

fn build_rpc_input(parsed: &ParsedRequest, permissions: Option<&Value>) -> Value {
    let mut input = Map::new();
    input.insert("mode".into(), json!(parsed.mode.as_str()));
    if let Some(title) = &parsed.title {
        input.insert("title".into(), json!(title));
    }
    if let Some(agent) = &parsed.agent {
        input.insert("agent".into(), json!(agent));
    }
    if let Some(model) = &parsed.model {
        input.insert("model".into(), model.clone());
    }
    if let Some(perms) = permissions {
        input.insert("permissions".into(), perms.clone());
    }
    Value::Object(input)
}

async fn read_native_location(
    app: &App,
    endpoint: &Endpoint,
    directory: &str,
    timeout: Duration,
) -> Result<Option<String>, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let url = endpoint.url.join("/api/location").map_err(|_| ())?;
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() || !is_json_content_type(response.headers()) {
        return Ok(None);
    }
    let raw = opencode::read_json(response, LOCATION_BODY_LIMIT).await?;
    let loc = raw.get("data").unwrap_or(&raw);
    let Some(obj) = loc.as_object() else {
        return Ok(None);
    };
    let Some(dir) = obj.get("directory").and_then(valid_location_str) else {
        return Ok(None);
    };
    if obj.contains_key("workspaceID") {
        return Ok(None);
    }
    Ok(Some(dir.to_owned()))
}

async fn revalidate_target(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    target: &OwnedTarget,
    is_current: impl Fn() -> bool,
) -> Result<(), ()> {
    if !is_current() {
        return Err(());
    }
    let fresh = prove_ownership(app, workspace, endpoint, &target.directory).await?.ok_or(())?;
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

enum LocalRepo {
    Git(PathBuf),
    NonGit,
    MissingGit,
}

enum Precheck {
    Owned(PathBuf),
    Denied,
    Unavailable,
}

async fn local_common_dir(dir: &Path, timeout: Duration) -> Result<LocalRepo, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let out = match tokio::time::timeout(
        timeout,
        git::run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024),
    )
    .await
    {
        Ok(Ok(out)) => out,
        Ok(Err(err)) if git::is_missing_git(&err) => return Ok(LocalRepo::MissingGit),
        _ => return Err(()),
    };
    if out.not_a_repository() {
        return Ok(LocalRepo::NonGit);
    }
    let out = out.ok().map_err(|_| ())?;
    let trimmed = out.text().trim().to_owned();
    tokio::task::spawn_blocking(move || dunce::canonicalize(trimmed).ok())
        .await
        .map_err(|_| ())?
        .map(LocalRepo::Git)
        .ok_or(())
}

async fn local_worktree_toplevel(dir: &Path, timeout: Duration) -> Result<Option<PathBuf>, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let out = match tokio::time::timeout(
        timeout,
        git::run(dir, &["rev-parse", "--path-format=absolute", "--show-toplevel"], 16 * 1024),
    )
    .await
    {
        Ok(Ok(out)) => out,
        Ok(Err(err)) if git::is_missing_git(&err) => return Ok(None),
        _ => return Err(()),
    };
    if out.code != 0 {
        return Ok(None);
    }
    let trimmed = out.text().trim().to_owned();
    if trimmed.is_empty() {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || dunce::canonicalize(trimmed).ok()).await.map_err(|_| ())
}

async fn local_repo_root(dir: &Path, timeout: Duration) -> PathBuf {
    local_worktree_toplevel(dir, timeout).await.ok().flatten().unwrap_or_else(|| dir.to_path_buf())
}

async fn local_worktree_listed(repo_root: &Path, toplevel: &Path, timeout: Duration) -> Result<bool, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let out = tokio::time::timeout(timeout, git::run(repo_root, &["worktree", "list", "--porcelain"], 512 * 1024))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    if out.code != 0 {
        return Err(());
    }
    let text = out.text();
    let target = toplevel.to_path_buf();
    let paths: Vec<String> = text
        .lines()
        .filter_map(|line| line.strip_suffix('\r').unwrap_or(line).strip_prefix("worktree "))
        .map(str::to_owned)
        .collect();
    tokio::task::spawn_blocking(move || {
        paths.into_iter().any(|entry| dunce::canonicalize(&entry).ok().as_deref() == Some(target.as_path()))
    })
    .await
    .map_err(|_| ())
}

/// Pure-local ownership and checkout-root discovery before entering `WorktreeDeletionFence` or
/// acquiring OpenCode, ensuring unowned or deleting directories never start or probe the daemon.
async fn local_precheck(app: &App, workspace: &Workspace, directory: &str, deadline: Instant) -> Precheck {
    if directory.contains('\0')
        || !crate::files::paths::local_absolute(directory)
        || !crate::files::paths::under(&app.scope, Path::new(directory))
    {
        return Precheck::Denied;
    }
    let scope = app.scope.clone();
    let dir_owned = directory.to_owned();
    let (path, anchor) =
        match tokio::task::spawn_blocking(move || ownership::resolve_media_path_checked(&scope, &dir_owned)).await {
            Ok(Ok(Some(resolved))) => resolved,
            Ok(Ok(None)) => return Precheck::Denied,
            _ => return Precheck::Unavailable,
        };
    let rem = || deadline.saturating_duration_since(Instant::now());
    if path == workspace.path {
        return Precheck::Owned(local_repo_root(&workspace.path, rem()).await);
    }
    let external = !ownership::within(&workspace.path, &path);
    let root_repo = match local_common_dir(&workspace.path, rem()).await {
        Ok(repo) => repo,
        Err(()) => return Precheck::Unavailable,
    };
    if external {
        let LocalRepo::Git(root_common) = root_repo else {
            return Precheck::Denied;
        };
        let target_common = match local_common_dir(&anchor, rem()).await {
            Ok(LocalRepo::Git(common)) => common,
            Ok(_) => return Precheck::Denied,
            Err(()) => return Precheck::Unavailable,
        };
        if target_common != root_common {
            return Precheck::Denied;
        }
        let toplevel = match local_worktree_toplevel(&anchor, rem()).await {
            Ok(Some(tl)) if tl.starts_with(&app.scope) => tl,
            Ok(_) => return Precheck::Denied,
            Err(()) => return Precheck::Unavailable,
        };
        let root_toplevel = local_repo_root(&workspace.path, rem()).await;
        if toplevel == root_toplevel {
            return Precheck::Denied;
        }
        return match local_worktree_listed(&workspace.path, &toplevel, rem()).await {
            Ok(true) => Precheck::Owned(toplevel),
            Ok(false) => Precheck::Denied,
            Err(()) => Precheck::Unavailable,
        };
    }
    match root_repo {
        LocalRepo::MissingGit => Precheck::Denied,
        LocalRepo::NonGit => {
            let root = workspace.path.clone();
            let live = tokio::task::spawn_blocking(move || dunce::canonicalize(&root).ok().as_ref() == Some(&root))
                .await
                .unwrap_or(false);
            if live { Precheck::Owned(workspace.path.clone()) } else { Precheck::Unavailable }
        }
        LocalRepo::Git(root_common) => match local_common_dir(&anchor, rem()).await {
            Ok(LocalRepo::Git(target_common)) if target_common == root_common => {
                match local_worktree_toplevel(&anchor, rem()).await {
                    Ok(Some(tl)) if tl.starts_with(&app.scope) => Precheck::Owned(tl),
                    Ok(_) => Precheck::Denied,
                    Err(()) => Precheck::Unavailable,
                }
            }
            Ok(_) => Precheck::Owned(local_repo_root(&workspace.path, rem()).await),
            Err(()) => Precheck::Unavailable,
        },
    }
}

pub async fn handle(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
    request: Request,
) -> Response {
    let parsed = match read_request(request, &principal).await {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };

    // Authorize the workspace and directory before any OpenCode request: reading a
    // Location boots its services (configuration discovery, plugins).
    let Ok(workspace) = app.workspace(&id) else {
        return denied();
    };
    let Some(base_dir) = workspace.location["directory"].as_str().map(str::to_owned) else {
        return denied();
    };
    let deadline = Instant::now() + RPC_TIMEOUT;
    let run = async {
        let mut displays = vec![fence::capture_display(&parsed.directory)];
        if fence::normalize(&base_dir) != fence::normalize(&parsed.directory) {
            displays.push(fence::capture_display(&base_dir));
        }
        let ws_identity = fence::identity(&workspace.path);
        if fence::normalize(&ws_identity) != fence::normalize(&base_dir)
            && fence::normalize(&ws_identity) != fence::normalize(&parsed.directory)
        {
            displays.push(fence::capture_display(&ws_identity));
        }

        let checkout = match local_precheck(&app, &workspace, &parsed.directory, deadline).await {
            Precheck::Owned(checkout) => checkout,
            Precheck::Denied => return denied(),
            Precheck::Unavailable => return unavailable(),
        };
        let scope_clone = app.scope.clone();
        let Ok(checkout_path) =
            tokio::task::spawn_blocking(move || fence::checkout_root(&scope_clone, &checkout)).await
        else {
            return unavailable();
        };
        let identity = fence::identity(&checkout_path);
        let Some(_entered) = fence::enter(&[identity.clone(), parsed.directory.clone()]) else {
            return deleting();
        };
        displays.push(fence::capture_display(&identity));

        // `_entered` lives inside this future so cancellation, disconnect, retirement,
        // workspace closure, or timeout releases the deletion fence immediately.
        let Ok(endpoint) = app.native.acquire(deadline).await else {
            return unavailable();
        };
        let work = async {
            let _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(&app, &endpoint)).await;
            admitted(&app, &principal, &workspace, &endpoint, &parsed, &displays, deadline).await
        };
        let result = tokio::select! {
            biased;
            _ = app.native.wait_retired(&endpoint) => unavailable(),
            res = work => res,
        };
        if let Err(err) = principal.live() {
            return err.into_response();
        }
        result
    };

    tokio::select! {
        biased;
        _ = principal.0.cancelled() => crate::auth::unauthorized().into_response(),
        _ = wait_workspace_closed(&app, &workspace) => unavailable(),
        res = tokio::time::timeout_at(deadline, run) => res.unwrap_or_else(|_| unavailable()),
    }
}

async fn admitted(
    app: &Shared,
    principal: &Principal,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    parsed: &ParsedRequest,
    displays: &[Arc<AtomicBool>],
    deadline: Instant,
) -> Response {
    let is_current = || {
        !principal.0.is_cancelled()
            && Instant::now() < deadline
            && app.native.current(endpoint)
            && super::permission_mode::workspace_current(app, workspace)
            && displays.iter().all(|d| d.load(Relaxed))
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());

    if !is_current() {
        return unavailable();
    }
    let target = match prove_ownership(app, workspace, endpoint, &parsed.directory).await {
        Ok(Some(target)) => target,
        Ok(None) => return if !is_current() { unavailable() } else { denied() },
        Err(()) => return unavailable(),
    };
    if !is_current() {
        return unavailable();
    }

    let loc_timeout = remaining().min(LOCATION_READ_TIMEOUT);
    let location = read_native_location(app, endpoint, &parsed.directory, loc_timeout).await.ok().flatten();
    if !is_current() {
        return unavailable();
    }
    if location.as_deref() != Some(parsed.directory.as_str()) {
        return denied();
    }
    match prove_ownership(app, workspace, endpoint, &parsed.directory).await {
        Ok(Some(fresh))
            if fresh.path == target.path
                && fresh.anchor == target.anchor
                && fresh.anchor_id == target.anchor_id
                && target.checkout.same_checkout(&fresh.checkout) => {}
        Ok(_) => return if !is_current() { unavailable() } else { denied() },
        Err(()) => return unavailable(),
    }
    if !is_current() {
        return unavailable();
    }

    if prepare_pruning(app, endpoint, &target.directory, deadline, is_current).await.is_err() {
        return unavailable();
    }

    let permissions = if parsed.mode == Mode::Lookup {
        None
    } else {
        match tokio::time::timeout_at(
            deadline,
            super::permission_mode::new_root(app, endpoint, &target.directory, true),
        )
        .await
        {
            Ok(Ok(perms)) => perms,
            _ => return unavailable(),
        }
    };

    if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
        return unavailable();
    }

    let Ok(url) = endpoint.url.join("/api/rpc/codenomad.session-pruning/imagesConversation") else {
        return unavailable();
    };
    let rpc_input = build_rpc_input(parsed, permissions.as_ref());
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
        .json(&json!({ "input": rpc_input }))
        .timeout(left)
        .send()
        .await
    else {
        return unavailable();
    };
    if !is_current() || response.status() != Status::OK || !is_json_content_type(response.headers()) {
        return unavailable();
    }
    let Ok(raw) = opencode::read_bytes(response, RPC_BODY_LIMIT).await else {
        return unavailable();
    };
    if !is_current() || !super::media_stream::json_node_count_within(&raw, RPC_NODE_LIMIT) {
        return unavailable();
    }
    if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
        return unavailable();
    }
    let Ok(envelope) = serde_json::from_slice::<Value>(&raw) else {
        return unavailable();
    };
    let Some(output) = envelope.as_object().and_then(|o| o.get("output")).and_then(validate_rpc_output) else {
        return unavailable();
    };

    let (session_id, created) = match output {
        RpcOutput::Found { session_id, created } => (session_id, created),
        RpcOutput::Absent => return Json(json!({ "status": "absent" })).into_response(),
        RpcOutput::Unknown => return Json(json!({ "status": "unknown" })).into_response(),
        RpcOutput::Blocked { reason } => return Json(json!({ "status": "blocked", "reason": reason })).into_response(),
    };

    if let Some(block) = permissions.as_ref().filter(|_| created) {
        let Ok(session) = fetch_session_bounded(app, endpoint, &session_id, 256, remaining()).await else {
            return unavailable();
        };
        let Some(loc) = session.get("location").and_then(Value::as_object) else {
            return unavailable();
        };
        if session["id"].as_str() != Some(session_id.as_str())
            || loc.get("directory").and_then(Value::as_str) != Some(target.directory.as_str())
            || loc.contains_key("workspaceID")
        {
            return unavailable();
        }
        let Some(project_id) = session["projectID"].as_str() else {
            return unavailable();
        };
        if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
            return unavailable();
        }
        let confirmed = tokio::time::timeout_at(
            deadline,
            super::permission_mode::confirm_root(
                app,
                endpoint,
                &target.directory,
                project_id,
                &session_id,
                block,
                false,
                is_current,
            ),
        )
        .await;
        if !matches!(confirmed, Ok(Ok(()))) {
            return unavailable();
        }
    }

    if parsed.mode == Mode::Lookup {
        return Json(json!({ "status": "found", "sessionID": session_id, "created": created })).into_response();
    }

    if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
        return unavailable();
    }
    let valid_for_exclude: Arc<dyn Fn() -> bool + Send + Sync> = {
        let app_c = Arc::clone(app);
        let principal_c = principal.clone();
        let workspace_c = workspace.clone();
        let endpoint_c = Arc::clone(endpoint);
        let displays_c: Vec<Arc<AtomicBool>> = displays.to_vec();
        Arc::new(move || {
            !principal_c.0.is_cancelled()
                && Instant::now() < deadline
                && app_c.native.current(&endpoint_c)
                && super::permission_mode::workspace_current(&app_c, &workspace_c)
                && displays_c.iter().all(|d| d.load(Relaxed))
        })
    };
    let git_exclusion = exclude_design_folder_cancellable(&target.path, deadline, valid_for_exclude).await;
    if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
        return unavailable();
    }

    Json(json!({
        "status": "found",
        "sessionID": session_id,
        "created": created,
        "gitExclusion": git_exclusion.as_str(),
    }))
    .into_response()
}
