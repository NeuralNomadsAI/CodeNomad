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
    Refused,
}

enum Precheck {
    Owned(Vec<PathBuf>),
    Denied,
    Unavailable,
}

async fn local_common_dir(dir: &Path, scope: &Path, timeout: Duration) -> Result<LocalRepo, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let dir_check = dir.to_path_buf();
    let scope_check = scope.to_path_buf();
    let layout_ok =
        tokio::task::spawn_blocking(move || crate::worktrees::precheck_git_layout_in_scope(&scope_check, &dir_check))
            .await
            .map_err(|_| ())?;
    if !layout_ok {
        return Ok(LocalRepo::Refused);
    }
    let out = match tokio::time::timeout(
        timeout,
        git::run_in_scope(dir, scope, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024),
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
    let scope_owned = scope.to_path_buf();
    match tokio::task::spawn_blocking(move || ownership::resolve_media_path_checked(&scope_owned, &trimmed))
        .await
        .map_err(|_| ())?
    {
        Ok(Some((p, a))) if p == a => Ok(LocalRepo::Git(p)),
        Ok(_) => Ok(LocalRepo::Refused),
        Err(()) => Err(()),
    }
}

async fn local_worktree_toplevel(dir: &Path, scope: &Path, timeout: Duration) -> Result<Option<PathBuf>, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let dir_check = dir.to_path_buf();
    let scope_check = scope.to_path_buf();
    let layout_ok =
        tokio::task::spawn_blocking(move || crate::worktrees::precheck_git_layout_in_scope(&scope_check, &dir_check))
            .await
            .map_err(|_| ())?;
    if !layout_ok {
        return Ok(None);
    }
    let out = match tokio::time::timeout(
        timeout,
        git::run_in_scope(dir, scope, &["rev-parse", "--path-format=absolute", "--show-toplevel"], 16 * 1024),
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
    let scope_owned = scope.to_path_buf();
    match tokio::task::spawn_blocking(move || ownership::resolve_media_path_checked(&scope_owned, &trimmed))
        .await
        .map_err(|_| ())?
    {
        Ok(Some((p, a))) if p == a => Ok(Some(p)),
        Ok(_) => Ok(None),
        Err(()) => Err(()),
    }
}

async fn local_repo_root(dir: &Path, scope: &Path, timeout: Duration) -> PathBuf {
    local_worktree_toplevel(dir, scope, timeout).await.ok().flatten().unwrap_or_else(|| dir.to_path_buf())
}

fn has_git_component(path: &Path) -> bool {
    path.components().any(|comp| match comp {
        std::path::Component::Normal(name) => {
            if cfg!(windows) {
                name.to_string_lossy().eq_ignore_ascii_case(".git")
            } else {
                name == std::ffi::OsStr::new(".git")
            }
        }
        _ => false,
    })
}

async fn local_listed_worktrees(repo_root: &Path, scope: &Path, timeout: Duration) -> Result<Vec<PathBuf>, ()> {
    if timeout.is_zero() {
        return Err(());
    }
    let out = tokio::time::timeout(
        timeout,
        git::run_in_scope(repo_root, scope, &["worktree", "list", "--porcelain", "-z"], 4 << 20),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if out.code != 0 {
        return Err(());
    }
    let text = out.text();
    let raw_paths: Vec<String> = text
        .split("\0\0")
        .filter_map(|record| {
            let mut fields = record.split('\0').filter(|f| !f.is_empty());
            let path = fields.next()?.strip_prefix("worktree ")?;
            if fields.any(|f| f == "bare" || f == "prunable" || f.starts_with("prunable ")) {
                return None;
            }
            Some(path.to_owned())
        })
        .collect();
    let scope = scope.to_path_buf();
    tokio::task::spawn_blocking(move || {
        raw_paths
            .into_iter()
            .filter_map(|entry| {
                ownership::resolve_media_path_checked(&scope, &entry)
                    .ok()
                    .flatten()
                    .filter(|(p, a)| p == a)
                    .map(|(p, _)| p)
            })
            .collect()
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
    if has_git_component(&path) {
        return Precheck::Denied;
    }
    let rem = || deadline.saturating_duration_since(Instant::now());
    if path == workspace.path {
        return Precheck::Owned(vec![local_repo_root(&workspace.path, &app.scope, rem()).await]);
    }
    let external = !ownership::within(&workspace.path, &path);
    let root_repo = match local_common_dir(&workspace.path, &app.scope, rem()).await {
        Ok(repo) => repo,
        Err(()) => return Precheck::Unavailable,
    };
    if external {
        let LocalRepo::Git(root_common) = root_repo else {
            return Precheck::Denied;
        };
        let target_common = match local_common_dir(&anchor, &app.scope, rem()).await {
            Ok(LocalRepo::Git(common)) => common,
            Ok(_) => return Precheck::Denied,
            Err(()) => return Precheck::Unavailable,
        };
        if target_common != root_common {
            return Precheck::Denied;
        }
        let toplevel = match local_worktree_toplevel(&anchor, &app.scope, rem()).await {
            Ok(Some(tl)) if tl.starts_with(&app.scope) => tl,
            Ok(_) => return Precheck::Denied,
            Err(()) => return Precheck::Unavailable,
        };
        let Some(root_toplevel) = (match local_worktree_toplevel(&workspace.path, &app.scope, rem()).await {
            Ok(tl) => tl,
            Err(()) => return Precheck::Unavailable,
        }) else {
            return Precheck::Denied;
        };
        let Ok(tail) = workspace.path.strip_prefix(&root_toplevel) else {
            return Precheck::Denied;
        };
        let listed = match local_listed_worktrees(&workspace.path, &app.scope, rem()).await {
            Ok(roots) => roots,
            Err(()) => return Precheck::Unavailable,
        };
        if !listed.iter().any(|r| r == &toplevel) {
            return Precheck::Denied;
        }
        if tail.as_os_str().is_empty() {
            return if toplevel != root_toplevel && ownership::within(&toplevel, &path) {
                Precheck::Owned(vec![toplevel])
            } else {
                Precheck::Denied
            };
        }
        let tail_owned = tail.to_path_buf();
        let scope_owned = app.scope.clone();
        let path_owned = path.clone();
        let root_top_owned = root_toplevel.clone();
        let matched = tokio::task::spawn_blocking(move || -> Option<Vec<PathBuf>> {
            let mut best: Option<(usize, Vec<PathBuf>)> = None;
            for wt in listed.iter().filter(|wt| **wt != root_top_owned) {
                let projected = wt.join(&tail_owned);
                let Some(projected_str) = projected.to_str() else {
                    continue;
                };
                // Resolve hop-by-hop within `scope` before canonicalizing so a projected symlink
                // to a network share or out-of-scope path never triggers out-of-scope I/O, while
                // preserving missing (`ENOENT`) projected subfolders like `Tree::contains_media`.
                // Ignore unrelated sibling errors (such as ENOTDIR when another checkout has a
                // file where `tail` expects a directory) so matching siblings remain reachable.
                let Ok(Some((resolved_projected, proj_anchor))) =
                    ownership::resolve_media_path_checked(&scope_owned, projected_str)
                else {
                    continue;
                };
                let candidate = if resolved_projected == projected {
                    let missing = proj_anchor != projected;
                    let missing_ok = !missing
                        || std::fs::symlink_metadata(&projected)
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
                    (missing_ok && path_owned.starts_with(&projected) && path_owned.starts_with(wt))
                        .then(|| (projected.as_os_str().len(), vec![wt.clone()]))
                } else if resolved_projected == proj_anchor {
                    listed
                        .iter()
                        .filter(|r| resolved_projected.starts_with(r))
                        .max_by_key(|r| r.as_os_str().len())
                        .filter(|_| path_owned.starts_with(&resolved_projected))
                        .map(|target_wt| {
                            let mut roots = vec![wt.clone()];
                            if target_wt != wt {
                                roots.push(target_wt.clone());
                            }
                            (resolved_projected.as_os_str().len(), roots)
                        })
                } else {
                    None
                };
                if let Some((len, roots)) = candidate
                    && best.as_ref().is_none_or(|(best_len, _)| len > *best_len)
                {
                    best = Some((len, roots));
                }
            }
            best.map(|(_, roots)| roots)
        })
        .await;
        return match matched {
            Ok(Some(roots)) => Precheck::Owned(roots),
            Ok(None) => Precheck::Denied,
            Err(_) => Precheck::Unavailable,
        };
    }
    match root_repo {
        LocalRepo::MissingGit | LocalRepo::Refused => Precheck::Denied,
        LocalRepo::NonGit => {
            let root = workspace.path.clone();
            let scope = app.scope.clone();
            let live = tokio::task::spawn_blocking(move || {
                root.to_str().is_some_and(|s| {
                    ownership::resolve_media_path_checked(&scope, s)
                        .ok()
                        .flatten()
                        .is_some_and(|(p, a)| p == a && p == root)
                })
            })
            .await
            .unwrap_or(false);
            if live { Precheck::Owned(vec![workspace.path.clone()]) } else { Precheck::Unavailable }
        }
        LocalRepo::Git(root_common) => match local_common_dir(&anchor, &app.scope, rem()).await {
            Ok(LocalRepo::Git(target_common)) => match local_worktree_toplevel(&anchor, &app.scope, rem()).await {
                Ok(Some(tl)) if target_common == root_common => {
                    if tl.starts_with(&app.scope) {
                        Precheck::Owned(vec![tl])
                    } else {
                        Precheck::Denied
                    }
                }
                Ok(Some(_)) => Precheck::Owned(vec![local_repo_root(&workspace.path, &app.scope, rem()).await]),
                Ok(None) => Precheck::Denied,
                Err(()) => Precheck::Unavailable,
            },
            Ok(LocalRepo::NonGit) => Precheck::Owned(vec![local_repo_root(&workspace.path, &app.scope, rem()).await]),
            Ok(LocalRepo::MissingGit | LocalRepo::Refused) => Precheck::Denied,
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

        let checkouts = match local_precheck(&app, &workspace, &parsed.directory, deadline).await {
            Precheck::Owned(checkouts) => checkouts,
            Precheck::Denied => return denied(),
            Precheck::Unavailable => return unavailable(),
        };
        let scope_clone = app.scope.clone();
        let Ok(identities) = tokio::task::spawn_blocking(move || {
            let mut ids = Vec::with_capacity(checkouts.len());
            for checkout in checkouts {
                let root = fence::checkout_root(&scope_clone, &checkout);
                let id = fence::identity(&root);
                if !ids.iter().any(|existing: &String| fence::normalize(existing) == fence::normalize(&id)) {
                    ids.push(id);
                }
            }
            ids
        })
        .await
        else {
            return unavailable();
        };
        let mut enter_keys = identities.clone();
        enter_keys.push(parsed.directory.clone());
        let Some(_entered) = fence::enter(&enter_keys) else {
            return deleting();
        };
        for id in &identities {
            displays.push(fence::capture_display(id));
        }

        // `_entered` lives inside this future so cancellation, disconnect, retirement,
        // workspace closure, or timeout releases the deletion fence immediately.
        let Ok(endpoint) = app.native.acquire(deadline).await else {
            return unavailable();
        };
        let work = admitted(&app, &principal, &workspace, &endpoint, &parsed, &mut displays, &identities, deadline);
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

#[allow(clippy::too_many_arguments)]
async fn admitted(
    app: &Shared,
    principal: &Principal,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    parsed: &ParsedRequest,
    displays: &mut Vec<Arc<AtomicBool>>,
    fenced_identities: &[String],
    deadline: Instant,
) -> Response {
    let check_current = |displays: &[Arc<AtomicBool>]| {
        !principal.0.is_cancelled()
            && Instant::now() < deadline
            && app.native.current(endpoint)
            && super::permission_mode::workspace_current(app, workspace)
            && displays.iter().all(|d| d.load(Relaxed))
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());

    if !check_current(displays) {
        return unavailable();
    }
    let target = match prove_ownership(app, workspace, endpoint, &parsed.directory).await {
        Ok(Some(target)) => target,
        Ok(None) => return if !check_current(displays) { unavailable() } else { denied() },
        Err(()) => return unavailable(),
    };
    if !check_current(displays) {
        return unavailable();
    }

    // Fence any additional checkout root proven by OpenCode's inventory (such as the
    // physical target checkout of a projected subfolder symlink) before reading the Location.
    let extra_roots = target.checkout.fence_roots(&target.path);
    let scope_clone = app.scope.clone();
    let already: Vec<String> = fenced_identities.iter().map(|s| fence::normalize(s)).collect();
    let Ok(extra_identities) = tokio::task::spawn_blocking(move || {
        let mut extra = Vec::new();
        for root in extra_roots {
            let resolved = fence::checkout_root(&scope_clone, &root);
            let id = fence::identity(&resolved);
            let norm = fence::normalize(&id);
            if !already.iter().any(|a| *a == norm) && !extra.iter().any(|e: &String| fence::normalize(e) == norm) {
                extra.push(id);
            }
        }
        extra
    })
    .await
    else {
        return unavailable();
    };
    let _extra_entered = if extra_identities.is_empty() {
        None
    } else {
        let Some(guard) = fence::enter(&extra_identities) else {
            return deleting();
        };
        for id in &extra_identities {
            displays.push(fence::capture_display(id));
        }
        Some(guard)
    };
    let is_current = || check_current(displays);
    if !is_current() {
        return unavailable();
    }
    if revalidate_target(app, workspace, endpoint, &target, is_current).await.is_err() {
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

    let _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(app, endpoint)).await;
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
    let git_exclusion = exclude_design_folder_cancellable(&target.path, &app.scope, deadline, valid_for_exclude).await;
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
