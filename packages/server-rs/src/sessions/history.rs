//! `POST /api/workspaces/:id/session-history/:action`: history navigation through the
//! session-pruning plugin, schema-checked both ways.
use super::{media, user_files};
use crate::{App, Error, Shared, auth::Principal, error, unavailable};
use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use serde_json::{Value, json, value::RawValue};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    time::Duration,
};
pub fn pending_valid(value: &Value) -> bool {
    crate::sessions::contracts::valid(crate::sessions::contracts::get("pending", true), value)
}

#[derive(Clone, PartialEq, Eq)]
enum DirIdentity {
    #[cfg(unix)]
    Unix(u64, u64),
    #[cfg(not(unix))]
    Handle(Arc<same_file::Handle>),
}

/// Identifies a live directory without opening POSIX FIFOs or symlinks (`lstat` on Unix;
/// `symlink_metadata().is_dir()` before `same_file::Handle` on Windows).
fn directory_identity(path: &std::path::Path) -> std::io::Result<DirIdentity> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(DirIdentity::Unix(meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(DirIdentity::Handle(Arc::new(same_file::Handle::from_path(path)?)))
    }
}

pub(super) struct Placement {
    workspace: crate::Workspace,
    pub(super) endpoint: Arc<crate::opencode::Endpoint>,
    source: Value,
    /// Physical checkout of the session's owned location (root or linked worktree).
    path: std::path::PathBuf,
    anchor: std::path::PathBuf,
    physical: DirIdentity,
    workspace_physical: Option<DirIdentity>,
    checkout: crate::worktrees::ownership::DirectoryProof,
    displays: Vec<Arc<AtomicBool>>,
    media: bool,
    strict_media: bool,
}

impl Placement {
    pub(super) async fn capture(app: &Shared, id: &str, session: &str, references: bool) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, false, false, references).await
    }

    pub(super) async fn capture_for_media(app: &Shared, id: &str, session: &str) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, true, true, false).await
    }

    pub(super) async fn capture_with_media(
        app: &Shared,
        id: &str,
        session: &str,
        media: bool,
        fenced: bool,
    ) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, media, false, fenced).await
    }

    async fn capture_inner(
        app: &Shared,
        id: &str,
        session: &str,
        media: bool,
        strict_media: bool,
        fenced: bool,
    ) -> Result<Self, Error> {
        let workspace = app.workspace(id)?;
        let unavailable = || error(Status::SERVICE_UNAVAILABLE, "History placement unavailable");
        let workspace_physical = if media {
            let path = workspace.path.clone();
            let handle = tokio::task::spawn_blocking(move || directory_identity(&path))
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
            Some(handle)
        } else {
            None
        };
        let display =
            |path: &std::path::Path| crate::worktrees::fence::capture_display(&crate::worktrees::fence::identity(path));
        let mut displays = Vec::new();
        if fenced {
            displays.push(display(&workspace.path));
        }
        let endpoint = {
            let timeout = if media { Duration::from_secs(30) } else { Duration::from_secs(15) };
            let deadline = tokio::time::Instant::now() + timeout;
            let endpoint = app.native.acquire(deadline).await.map_err(|_| crate::opencode::upstream_error())?;
            let _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(app, &endpoint)).await;
            endpoint
        };
        let capture = async {
            let current_fast = |displays: &[Arc<AtomicBool>]| {
                app.native.current(&endpoint) && app.workspace(id).is_ok() && displays.iter().all(|d| d.load(Relaxed))
            };
            if media
                && (!current_fast(&displays)
                    || !same_identity_async(workspace.path.clone(), workspace_physical.clone()).await
                    || !current_fast(&displays))
            {
                return Err(error(Status::GONE, "Media operation stale"));
            }
            let source = compact_placement_record(if strict_media {
                crate::opencode::session_record_media_raw_at(app, &endpoint, session).await?
            } else if media {
                crate::opencode::session_record_media_at(app, &endpoint, session).await?
            } else {
                crate::opencode::session_record_opaque_at(
                    app,
                    &endpoint,
                    session,
                    Duration::from_secs(15),
                    true,
                    16 * 1024 * 1024,
                )
                .await?
            });
            if media
                && (!current_fast(&displays)
                    || !same_identity_async(workspace.path.clone(), workspace_physical.clone()).await
                    || !current_fast(&displays))
            {
                return Err(error(Status::GONE, "Media operation stale"));
            }
            // Reference: `ownsLocation(id, session.location)`, linked worktrees included.
            let forbidden = || error(Status::FORBIDDEN, "Session does not belong to workspace");
            if strict_media && source["id"] != session {
                return Err(forbidden());
            }
            let location = &source["location"];
            if let Some(ws_id) = location.get("workspaceID") {
                if ws_id.as_str().is_some_and(|s| !s.is_empty()) {
                    return Err(forbidden());
                }
                return Err(unavailable());
            }
            let directory = location["directory"]
                .as_str()
                .filter(|d| crate::files::paths::local_absolute(d))
                .ok_or_else(unavailable)?;
            if !crate::files::paths::under(&app.scope, std::path::Path::new(directory)) {
                return Err(forbidden());
            }
            let scope = app.scope.clone();
            let dir_owned = directory.to_owned();
            let (path, anchor, physical) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
                let unavailable = || error(Status::SERVICE_UNAVAILABLE, "History placement unavailable");
                let forbidden = || error(Status::FORBIDDEN, "Session does not belong to workspace");
                let (path, anchor) = crate::worktrees::ownership::resolve_media_path_checked(&scope, &dir_owned)
                    .map_err(|_| unavailable())?
                    .ok_or_else(forbidden)?;
                let physical = directory_identity(&anchor).map_err(|_| unavailable())?;
                Ok((path, anchor, physical))
            })
            .await
            .map_err(|_| unavailable())??;
            if fenced {
                let raw_path = std::path::Path::new(directory);
                if raw_path != workspace.path && raw_path != path.as_path() {
                    displays.push(display(raw_path));
                }
                if path != workspace.path {
                    displays.push(display(&path));
                }
            }
            let proof =
                crate::worktrees::ownership::media_directory(app, &workspace, &endpoint, &path, &anchor, strict_media)
                    .await
                    .map_err(|_| crate::opencode::upstream_error())?;
            if media
                && (!current_fast(&displays)
                    || !same_identity_async(workspace.path.clone(), workspace_physical.clone()).await
                    || !current_fast(&displays))
            {
                return Err(error(Status::GONE, "Media operation stale"));
            }
            let checkout = proof.ok_or_else(forbidden)?;
            Ok(Self {
                workspace,
                endpoint: endpoint.clone(),
                source,
                path,
                anchor,
                physical,
                workspace_physical,
                checkout,
                displays,
                media,
                strict_media,
            })
        };
        if media {
            tokio::select! {
                biased;
                _ = app.native.wait_retired(&endpoint) => Err(error(Status::GONE, "Media operation stale")),
                result = capture => result,
            }
        } else {
            capture.await
        }
    }

    async fn current(&self, app: &App, id: &str, session: &str) -> Recheck {
        match self.latest(app, id, session).await {
            Ok(newest) if newest.get("revert") == self.source.get("revert") => Recheck::Current,
            Ok(_) => Recheck::Conflict,
            Err((Status::CONFLICT, _)) => Recheck::Conflict,
            Err(_) => Recheck::Unavailable,
        }
    }

    fn operation_current_fast(&self, app: &App, id: &str) -> bool {
        app.native.current(&self.endpoint)
            && app.workspace(id).is_ok_and(|w| w.id == self.workspace.id && w.path == self.workspace.path)
            && self.displays.iter().all(|display| display.load(Relaxed))
    }

    pub(super) async fn operation_current(&self, app: &App, id: &str) -> bool {
        self.operation_current_fast(app, id)
            && same_identity_async(self.workspace.path.clone(), self.workspace_physical.clone()).await
            && self.operation_current_fast(app, id)
    }

    pub(super) async fn latest(&self, app: &App, id: &str, session: &str) -> Result<Value, Error> {
        let changed = || error(Status::CONFLICT, "Session location changed");
        if !self.operation_current(app, id).await {
            return Err(crate::opencode::upstream_error());
        }
        if !self.live(app, id).await {
            return Err(changed());
        }
        // Match TS `session-media.ts:65-90` and `session-navigation.ts:64-87` exact order:
        // re-read `session.get`, then verify fresh worktree catalogue ownership (OpenCode has
        // no atomic combined session + worktree read; shared limitation tracked in `solid-backlog.md`).
        let newest = compact_placement_record(if self.strict_media || self.media {
            crate::opencode::session_record_media_raw_at(app, &self.endpoint, session).await?
        } else {
            crate::opencode::session_record_opaque_at(
                app,
                &self.endpoint,
                session,
                Duration::from_secs(15),
                false,
                16 * 1024 * 1024,
            )
            .await?
        });
        if !self.operation_current(app, id).await {
            return Err(crate::opencode::upstream_error());
        }
        // Validate `newest.location` shape BEFORE comparing against `self.source` so a malformed
        // final `session.get` (e.g. `workspaceID: null`) reports unavailable (`502`/`404`/
        // `blocked/unavailable`) rather than conflict (`409`/`blocked/conflict`, TS `location.ts:5-11`).
        let newest_loc = &newest["location"];
        if !newest_loc["directory"].as_str().is_some_and(crate::files::paths::local_absolute)
            || newest_loc.get("workspaceID").is_some_and(|w| !w.as_str().is_some_and(|s| !s.is_empty()))
        {
            return Err(crate::opencode::upstream_error());
        }
        if newest["id"] != self.source["id"]
            || newest["location"]["directory"] != self.source["location"]["directory"]
            || newest["location"].get("workspaceID") != self.source["location"].get("workspaceID")
            || (!self.strict_media && newest["projectID"] != self.source["projectID"])
            || !self.live(app, id).await
        {
            return Err(changed());
        }
        let cur_anchor = {
            let path = self.path.clone();
            tokio::task::spawn_blocking(move || {
                crate::worktrees::ownership::directory_anchor(&path).ok().flatten().map(std::path::PathBuf::from)
            })
            .await
            .ok()
            .flatten()
            .ok_or_else(changed)?
        };
        let current = crate::worktrees::ownership::media_directory(
            app,
            &self.workspace,
            &self.endpoint,
            &self.path,
            &cur_anchor,
            self.strict_media,
        )
        .await
        .map_err(|_| crate::opencode::upstream_error())?;
        if !self.operation_current(app, id).await {
            return Err(crate::opencode::upstream_error());
        }
        let current = current.ok_or_else(changed)?;
        if !self.checkout.same_checkout(&current) || !self.live(app, id).await {
            return Err(changed());
        }
        Ok(newest)
    }

    pub(super) async fn live(&self, app: &App, id: &str) -> bool {
        if !self.operation_current_fast(app, id) || !self.displays.iter().all(|display| display.load(Relaxed)) {
            return false;
        }
        let Some(raw_dir) = self.source["location"]["directory"].as_str().map(str::to_owned) else {
            return false;
        };
        let scope = app.scope.clone();
        let workspace_path = self.workspace.path.clone();
        let workspace_physical = self.workspace_physical.clone();
        let path = self.path.clone();
        let anchor = self.anchor.clone();
        let physical = self.physical.clone();
        let checkout = self.checkout.clone();
        let (ok, reprove_anchor) = tokio::task::spawn_blocking(move || {
            let workspace_ok = workspace_physical
                .as_ref()
                .is_none_or(|expected| directory_identity(&workspace_path).is_ok_and(|current| &current == expected));
            if !workspace_ok
                || crate::worktrees::ownership::resolve_media_path(&scope, &raw_dir).map(|(p, _)| p).as_ref()
                    != Some(&path)
            {
                return (false, None);
            }
            let Ok(Some(cur_anchor)) = crate::worktrees::ownership::directory_anchor(&path) else {
                return (false, None);
            };
            let anchor_ok = if cur_anchor == anchor.as_path() || cur_anchor.starts_with(&anchor) {
                // Workspace root identity is checked via `workspace_ok` (and `physical` when
                // `anchor == workspace_path`). A subfolder recreated in place under an intact
                // workspace/checkout remains valid (TS `session-navigation.ts:64-87`,
                // `session-media.ts:65-90`, `worktree-directory.ts:166-193`).
                anchor != workspace_path || directory_identity(&anchor).is_ok_and(|current| current == physical)
            } else {
                // TS `session-navigation.ts:64-87`, `session-media.ts:61-76`, and
                // `worktree-directory.ts:166-193`: if only a session's subfolder disappears while
                // its checkout stays intact, ownership resolves through the existing ancestor.
                anchor.starts_with(cur_anchor)
                    && std::fs::symlink_metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            };
            if !anchor_ok {
                return (false, None);
            }
            if checkout.live(&path) {
                (true, None)
            } else {
                // A benign Git config edit (e.g. `user.name`) invalidates the cached config stamp
                // without changing ownership; fall back to a fresh ownership recheck (TS
                // `session-navigation.ts:64-96`).
                (false, Some(cur_anchor.to_path_buf()))
            }
        })
        .await
        .unwrap_or((false, None));
        let owned_ok = if ok {
            true
        } else if let Some(cur_anchor) = reprove_anchor
            && self.operation_current_fast(app, id)
        {
            crate::worktrees::ownership::media_directory(
                app,
                &self.workspace,
                &self.endpoint,
                &self.path,
                &cur_anchor,
                self.strict_media,
            )
            .await
            .ok()
            .flatten()
            .is_some()
        } else {
            false
        };
        owned_ok && self.operation_current_fast(app, id) && self.displays.iter().all(|display| display.load(Relaxed))
    }

    async fn ready(&self, app: &Shared, id: &str, session: &str) -> Result<&str, Recheck> {
        let directory = self.source["location"]["directory"].as_str().ok_or(Recheck::Unavailable)?;
        // Share a single 5 s readiness budget across plugin catalogue activation and presence
        // challenge, matching TS `desktop-plugin-lifecycle.ts:135-154`. Provisioning already ran
        // once on connection acquisition (`Placement::capture`); do not re-provision here.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let still_valid =
            || self.operation_current_fast(app, id) && self.displays.iter().all(|display| display.load(Relaxed));
        let url = self.endpoint.url.join("/api/plugin").map_err(|_| Recheck::Unavailable)?;
        super::pending::await_plugin_with(super::pending::SESSION_PRUNING_PLUGIN, directory, deadline, || {
            still_valid()
                .then(|| app.native.client.get(url.clone()).basic_auth("opencode", Some(&self.endpoint.password)))
        })
        .await
        .map_err(|_| Recheck::Unavailable)?;
        if !self.operation_current(app, id).await {
            return Err(Recheck::Unavailable);
        }
        if !self.live(app, id).await {
            return Err(Recheck::Conflict);
        }
        crate::extensions::lifecycle::ready_at(app, &self.endpoint, directory, deadline, still_valid)
            .await
            .map_err(|_| Recheck::Unavailable)?;
        match self.current(app, id, session).await {
            Recheck::Current => Ok(directory),
            other => Err(other),
        }
    }
}

fn compact_placement_record(mut record: Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(id) = record.get_mut("id").map(Value::take) {
        out.insert("id".into(), id);
    }
    if let Some(project) = record.get_mut("projectID").map(Value::take) {
        out.insert("projectID".into(), project);
    }
    if let Some(loc) = record.get_mut("location").and_then(Value::as_object_mut) {
        let mut compact_loc = serde_json::Map::new();
        if let Some(dir) = loc.remove("directory") {
            compact_loc.insert("directory".into(), dir);
        }
        if let Some(ws) = loc.remove("workspaceID") {
            compact_loc.insert("workspaceID".into(), ws);
        }
        out.insert("location".into(), Value::Object(compact_loc));
    }
    if let Some(revert) = record.get_mut("revert").map(Value::take) {
        out.insert("revert".into(), revert);
    }
    Value::Object(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Recheck {
    Current,
    Conflict,
    Unavailable,
}

async fn same_identity_async(path: std::path::PathBuf, expected: Option<DirIdentity>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    tokio::task::spawn_blocking(move || directory_identity(&path).is_ok_and(|physical| physical == expected))
        .await
        .unwrap_or(false)
}

pub(super) async fn prepare(
    app: &Shared,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
    deadline: tokio::time::Instant,
    still_valid: impl Fn() -> bool,
) -> Option<()> {
    if !still_valid() {
        return None;
    }
    let url = endpoint.url.join("/api/plugin").ok()?;
    crate::sessions::pending::await_plugin_with(
        crate::sessions::pending::SESSION_PRUNING_PLUGIN,
        directory,
        deadline,
        || {
            (app.native.current(endpoint) && still_valid())
                .then(|| app.native.client.get(url.clone()).basic_auth("opencode", Some(&endpoint.password)))
        },
    )
    .await
    .ok()?;
    crate::extensions::lifecycle::ready_at(app, endpoint, directory, deadline, still_valid).await.ok()
}

pub(super) async fn rpc(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
) -> Result<(Status, Bytes), ()> {
    rpc_with_timeout(app, endpoint, directory, method, input, Duration::from_secs(10)).await
}

pub(super) async fn rpc_with_timeout(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
    timeout: Duration,
) -> Result<(Status, Bytes), ()> {
    let (status, mut body) = rpc_with_limit(app, endpoint, directory, method, input, timeout, 24 * 1024 * 1024).await?;
    body.shrink_to_fit();
    Ok((status, body.into()))
}

async fn rpc_with_limit(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
    timeout: Duration,
    limit: usize,
) -> Result<(Status, Vec<u8>), ()> {
    let response = app
        .native
        .client
        .post(endpoint.url.join(&format!("/api/rpc/codenomad.session-pruning/{method}")).map_err(|_| ())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({"input": input}))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    Ok((status, crate::opencode::read_bytes(response, limit).await?))
}

#[derive(serde::Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    output: Option<&'a RawValue>,
    #[serde(rename = "_tag")]
    tag: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn blocked(reason: &str) -> Response {
    Json(json!({"status":"blocked","reason":reason})).into_response()
}

fn detach_or_slice(body: Bytes, raw_range: std::ops::Range<usize>) -> Bytes {
    if body.len() > raw_range.len().saturating_add(4096) {
        Bytes::copy_from_slice(&body[raw_range])
    } else {
        body.slice(raw_range)
    }
}

/// Validates and optionally defers a `window` RPC output in-place inside `body: Vec<u8>` without
/// building a `serde_json::Value` tree over `messages[*]` tool payloads or allocating a second
/// 24 MiB copy, so valid windows with millions of numeric samples never amplify memory or trip a
/// node cap.
fn process_window_payload(
    status: Status,
    mut body: Vec<u8>,
    id: &str,
    session: &str,
    reference: bool,
    defer: bool,
) -> Result<Bytes, Response> {
    use super::media_stream;
    let (raw_range, patches) = {
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&body) else { return Err(blocked("unavailable")) };
        let Some(raw) = envelope.output else { return Err(blocked("unavailable")) };
        let raw_str = raw.get();
        let raw_bytes = raw_str.as_bytes();
        let offset = raw_bytes.as_ptr() as usize - body.as_ptr() as usize;
        let raw_range = offset..offset + raw_bytes.len();
        if !status.is_success() || !media_stream::validate_json_syntax(raw_bytes) {
            return Err(blocked("unavailable"));
        }
        let mut envelope_map = serde_json::Map::new();
        let mut messages_raw: Option<&str> = None;
        let mut envelope_ok = true;
        if media_stream::for_each_json_object_field(raw_str, |k, v| {
            if !envelope_ok {
                return;
            }
            if k == "\0" {
                envelope_ok = false;
            } else if k == "messages" {
                messages_raw = Some(v);
            } else if envelope_map.len() >= 32
                || v.len() > 8192
                || !media_stream::json_node_count_within(v.as_bytes(), 1024)
            {
                envelope_ok = false;
            } else if let Ok(val) = serde_json::from_str::<Value>(v) {
                envelope_map.insert(k.to_owned(), val);
            } else {
                envelope_ok = false;
            }
        })
        .is_none()
            || !envelope_ok
        {
            return Err(blocked("unavailable"));
        }
        if envelope_map.get("status").and_then(Value::as_str) != Some("window") {
            if messages_raw.is_some() {
                envelope_map.insert("messages".into(), Value::Null);
            }
            if !crate::sessions::contracts::valid(
                crate::sessions::contracts::get("window", true),
                &Value::Object(envelope_map),
            ) {
                return Err(blocked("unavailable"));
            }
            (raw_range, Vec::new())
        } else {
            let user_files_marker = envelope_map.remove("userFiles");
            if user_files_marker.as_ref().is_some_and(|v| v.as_str() != Some(user_files::REFERENCE))
                || (reference && user_files_marker.is_none())
            {
                return Err(blocked("unavailable"));
            }
            let Some(messages_str) = messages_raw else {
                return Err(blocked("unavailable"));
            };
            let can_defer = defer && media::valid_id(id) && media::valid_id(session);
            let (ws_enc, ses_enc) =
                if can_defer { (media::encode(id), media::encode(session)) } else { (String::new(), String::new()) };
            let raw_base = raw_str.as_ptr() as usize;
            let mut check_messages: Vec<Value> = Vec::new();
            let mut patches: Vec<(usize, usize, String)> = Vec::new();
            let mut messages_ok = true;
            let mut count = 0usize;
            if media_stream::for_each_json_array_item(messages_str, 201, |_, msg_str| {
                if !messages_ok {
                    return;
                }
                count += 1;
                if count > 200 {
                    messages_ok = false;
                    return;
                }
                let (mut id_tok, mut type_tok, mut time_tok, mut files_tok) = (None, None, None, None);
                if media_stream::for_each_json_object_field(msg_str, |k, v| match k {
                    "id" => id_tok = Some(v),
                    "type" => type_tok = Some(v),
                    "time" => time_tok = Some(v),
                    "files" => files_tok = Some(v),
                    _ => {}
                })
                .is_none()
                {
                    messages_ok = false;
                    return;
                }
                let (Some(id_tok), Some(type_tok), Some(time_tok)) = (id_tok, type_tok, time_tok) else {
                    messages_ok = false;
                    return;
                };
                if id_tok.len() > 2048 || type_tok.len() > 128 {
                    messages_ok = false;
                    return;
                }
                let (Ok(id_val), Ok(type_val)) =
                    (serde_json::from_str::<Value>(id_tok), serde_json::from_str::<Value>(type_tok))
                else {
                    messages_ok = false;
                    return;
                };
                let mut created_tok = None;
                if media_stream::for_each_json_object_field(time_tok, |k, v| {
                    if k == "created" {
                        created_tok = Some(v);
                    }
                })
                .is_none()
                {
                    messages_ok = false;
                    return;
                }
                let Some(created_tok) = created_tok.filter(|t| t.len() <= 64) else {
                    messages_ok = false;
                    return;
                };
                let Ok(created_val) = serde_json::from_str::<Value>(created_tok) else {
                    messages_ok = false;
                    return;
                };
                if reference
                    && type_val.as_str() == Some("user")
                    && let Some(files_tok) = files_tok
                    && !media_stream::valid_reference_files(files_tok, user_files::FILE_COUNT)
                {
                    messages_ok = false;
                    return;
                }
                check_messages.push(json!({"id": id_val, "type": type_val, "time": {"created": created_val}}));
                if can_defer && type_val.as_str() == Some("assistant") {
                    let msg_offset = msg_str.as_ptr() as usize - raw_base;
                    if let Some(item_patches) = media_stream::collect_item_patches(&ws_enc, &ses_enc, msg_str) {
                        for (start, end, replacement) in item_patches {
                            patches.push((msg_offset + start, msg_offset + end, replacement));
                        }
                    }
                }
            })
            .is_none()
                || !messages_ok
            {
                return Err(blocked("unavailable"));
            }
            envelope_map.insert("messages".into(), Value::Array(check_messages));
            if !crate::sessions::contracts::valid(
                crate::sessions::contracts::get("window", true),
                &Value::Object(envelope_map),
            ) {
                return Err(blocked("unavailable"));
            }
            (raw_range, patches)
        }
    };
    if !patches.is_empty() {
        let mut patches = patches;
        patches.sort_unstable_by_key(|(start, _, _)| *start);
        // Splice all deferred image URIs in-place inside `body` with ZERO second buffer
        // allocation: every deferred URI (`<= 4096` bytes) is strictly shorter than the `> 32 KiB`
        // data URI it replaces.
        let base = raw_range.start;
        let raw_end = raw_range.end;
        let mut read_pos = base;
        let mut write_pos = 0usize;
        for (rel_start, rel_end, replacement) in patches {
            let start = base + rel_start;
            let end = base + rel_end;
            let rep = replacement.as_bytes();
            if start < read_pos || end > raw_end || rep.len() > end - start {
                return Err(blocked("unavailable"));
            }
            let prefix_len = start - read_pos;
            if write_pos != read_pos && prefix_len > 0 {
                body.copy_within(read_pos..start, write_pos);
            }
            write_pos += prefix_len;
            body[write_pos..write_pos + rep.len()].copy_from_slice(rep);
            write_pos += rep.len();
            read_pos = end;
        }
        let tail_len = raw_end - read_pos;
        if write_pos != read_pos && tail_len > 0 {
            body.copy_within(read_pos..raw_end, write_pos);
        }
        write_pos += tail_len;
        if reference && write_pos > 24 * 1024 * 1024 {
            return Err(blocked("unsupported_storage"));
        }
        body.truncate(write_pos);
        body.shrink_to_fit();
        return Ok(body.into());
    }
    let raw_len = raw_range.len();
    if reference && raw_len > 24 * 1024 * 1024 {
        return Err(blocked("unsupported_storage"));
    }
    if raw_range.start > 0 {
        body.copy_within(raw_range, 0);
    }
    body.truncate(raw_len);
    body.shrink_to_fit();
    Ok(body.into())
}

fn process_history_payload(
    status: Status,
    mut body: Vec<u8>,
    action: &str,
    id: &str,
    session: &str,
    reference: bool,
    defer: bool,
) -> Result<Bytes, Response> {
    body.shrink_to_fit();
    if action == "window" {
        return process_window_payload(status, body, id, session, reference, defer);
    }
    let body: Bytes = body.into();
    let Ok(envelope) = serde_json::from_slice::<Envelope>(&body) else { return Err(blocked("unavailable")) };
    let Some(raw) = envelope.output else { return Err(blocked("unavailable")) };
    let raw_bytes = raw.get().as_bytes();
    let offset = raw_bytes.as_ptr() as usize - body.as_ptr() as usize;
    let raw_range = offset..offset + raw_bytes.len();
    // `outline` / `outlinePreview` schemas are strict flat lists (max 16,384 / 12 entries, max
    // string 4096 UTF-16 units = <= 24,576 raw JSON bytes when fully escaped, no passthrough
    // metadata). Capping both node count and per-string raw length keeps `serde_json`'s unescape
    // scratch buffer <= 64 KiB and total peak RAM well within the 56 MiB History reservation.
    const MAX_OUTLINE_NODES: usize = 400_000;
    const MAX_OUTLINE_STRING_BYTES: usize = 64 * 1024;
    if !crate::sessions::media_stream::json_bounds_within(raw_bytes, MAX_OUTLINE_NODES, MAX_OUTLINE_STRING_BYTES) {
        return Err(blocked("unavailable"));
    }
    let Ok(output) = serde_json::from_str::<Value>(raw.get()) else { return Err(blocked("unavailable")) };
    if !status.is_success()
        || !crate::sessions::contracts::valid(crate::sessions::contracts::get(action, true), &output)
    {
        return Err(blocked("unavailable"));
    }
    if output["entries"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item.get("omitted").is_some() != item["layout"].as_str().is_some_and(|layout| layout.contains('-'))
        })
    }) {
        return Err(blocked("unavailable"));
    }
    Ok(detach_or_slice(body, raw_range))
}

pub async fn handle(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, action)): Path<(String, String)>,
    req: Request,
) -> Result<Response, Error> {
    if matches!(action.as_str(), "query" | "ranked") {
        return super::history_search::handle(app, principal, id, &action, req).await;
    }
    let reference =
        action == "window" && req.headers().get("x-codenomad-user-files").is_some_and(|v| v == user_files::REFERENCE);
    let (method, limit) = match action.as_str() {
        "outline" => ("outlineLayout", 96 * 1024),
        "outlinePreview" => ("outlinePreview", 8192),
        "window" => (if reference { "windowUserFilesV1" } else { "window" }, 8192),
        _ => return Ok(unavailable()),
    };
    let defer = action == "window" && media::wants_deferred(req.headers());
    let invalid = || error(Status::BAD_REQUEST, "Invalid history navigation request");
    let (parts, body) = req.into_parts();
    if let Some(kind) = parts.headers.get(header::CONTENT_TYPE) {
        let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !matches!(essence.as_str(), "application/json" | "text/plain") {
            return Err(crate::shared::fastify::error(
                Status::UNSUPPORTED_MEDIA_TYPE,
                "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                "Unsupported Media Type",
            ));
        }
    }
    let bytes = to_bytes(body, limit).await.map_err(|_| {
        crate::shared::fastify::error(
            Status::PAYLOAD_TOO_LARGE,
            "FST_ERR_CTP_BODY_TOO_LARGE",
            "Request body is too large",
        )
    })?;
    let parsed = match crate::shared::fastify::body(&parts.headers, &bytes)? {
        Some(crate::shared::fastify::Body::Json(value)) => Some(value),
        Some(crate::shared::fastify::Body::Text(_)) | None => None,
    };
    let schema = crate::sessions::contracts::get(&action, false);
    let input = parsed.filter(|i| crate::sessions::contracts::valid(schema, i)).ok_or_else(invalid)?;
    let session = input["sessionID"].as_str().ok_or_else(invalid)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let request = async {
        // Bound concurrent 16 MiB `session.get` admissions, 24 MiB RPC reads, and
        // `spawn_blocking` parses across all three navigation actions (`window`, `outline`,
        // `outlinePreview`).
        static HISTORY_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let initial_workspace = match app.workspace(&id) {
            Ok(workspace) => workspace,
            Err(_) => return blocked("unavailable"),
        };
        let slot = {
            let workspace_closed = async {
                loop {
                    let notified = app.workspace_closed.notified();
                    if !app
                        .workspace(&id)
                        .is_ok_and(|w| w.id == initial_workspace.id && w.path == initial_workspace.path)
                    {
                        return;
                    }
                    notified.await;
                }
            };
            tokio::select! {
                biased;
                _ = workspace_closed => return blocked("unavailable"),
                permit = HISTORY_SLOTS.acquire() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return blocked("unavailable"),
                }
            }
        };
        // Always capture deletion fences for history navigation (TS `session-navigation.ts:48-55`).
        let placement = match Placement::capture_with_media(&app, &id, session, defer, true).await {
            Ok(placement) => placement,
            Err((Status::FORBIDDEN, body)) => return (Status::FORBIDDEN, body).into_response(),
            Err(_) => return blocked("unavailable"),
        };
        let work = async {
            // Revalidate after admission while holding the navigation slot.
            let directory = match placement.ready(&app, &id, session).await {
                Ok(directory) => directory,
                Err(Recheck::Conflict) => return blocked("conflict"),
                Err(_) => return blocked("unavailable"),
            };
            if !placement.operation_current(&app, &id).await {
                return blocked("unavailable");
            }
            let rpc_limit = 24 * 1024 * 1024 + 64 * 1024;
            // Reserve `ResponsePool::History` (64 MiB) memory BEFORE reading the up-to-24 MiB RPC
            // payload: `outline`/`outlinePreview` expand JSON into a `serde_json::Value` tree, so
            // reserve 56 MiB to serialize concurrent full-size parses under the 64 MiB pool;
            // `window` projects bytes in-place (+ 8 MiB peak for one decoded deferred image URI),
            // then shrinks the permit down to the serialized payload size.
            let reserve_bytes =
                if action == "window" { rpc_limit + if defer { 8 * 1024 * 1024 } else { 0 } } else { 56 * 1024 * 1024 };
            let mem = {
                let workspace_closed = async {
                    loop {
                        let notified = app.workspace_closed.notified();
                        if !placement.operation_current_fast(&app, &id) {
                            return;
                        }
                        notified.await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = workspace_closed => return blocked("unavailable"),
                    permit = crate::shared::reserve_response_memory(crate::shared::ResponsePool::History, reserve_bytes) => {
                        match permit {
                            Ok(permit) => Some(permit),
                            Err(_) => return blocked("unavailable"),
                        }
                    }
                }
            };
            let rpc_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rpc_timeout.is_zero() {
                return blocked("unavailable");
            }
            let Ok((mut status, mut body)) =
                rpc_with_limit(&app, &placement.endpoint, directory, method, &input, rpc_timeout, rpc_limit).await
            else {
                return blocked("unavailable");
            };
            if action == "outline" && status == Status::BAD_REQUEST {
                let fallback = serde_json::from_slice::<Envelope>(&body).ok().is_some_and(|envelope| {
                    envelope.tag.as_deref() == Some("RpcError")
                        && envelope.kind.as_deref() == Some("rpc.method_not_found")
                });
                if fallback {
                    // Release the first RPC buffer before reading the fallback so two ~24 MiB
                    // bodies never coexist under a single `ResponsePool::History` reservation.
                    body.clear();
                    body.shrink_to_fit();
                    match placement.current(&app, &id, session).await {
                        Recheck::Current => {}
                        Recheck::Conflict => return blocked("conflict"),
                        Recheck::Unavailable => return blocked("unavailable"),
                    }
                    let fallback_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
                    let Ok(fallback) = rpc_with_limit(
                        &app,
                        &placement.endpoint,
                        directory,
                        "outline",
                        &input,
                        fallback_timeout,
                        24 * 1024 * 1024,
                    )
                    .await
                    else {
                        return blocked("unavailable");
                    };
                    (status, body) = fallback;
                }
            }
            let body_len = body.len();
            // Validate and project BEFORE final session/revert revalidation, moving both `slot`
            // and `mem` into `spawn_blocking` so client cancellation never releases pool permits
            // while a detached worker still holds `body`.
            let (projected, slot, mut mem) = if body_len > 32 * 1024 {
                let (action_owned, id_owned, session_owned) = (action.clone(), id.clone(), session.to_owned());
                match tokio::task::spawn_blocking(move || {
                    let result = process_history_payload(
                        status,
                        body,
                        &action_owned,
                        &id_owned,
                        &session_owned,
                        reference,
                        defer,
                    );
                    (result, slot, mem)
                })
                .await
                {
                    Ok(triple) => triple,
                    Err(_) => return blocked("unavailable"),
                }
            } else {
                (process_history_payload(status, body, &action, &id, session, reference, defer), slot, mem)
            };
            if defer || body_len > 32 * 1024 {
                let keep_bytes = projected.as_ref().map_or(0, |p| p.len().saturating_add(4096));
                let keep_units = if keep_bytes == 0 {
                    0
                } else {
                    crate::shared::response_memory_units(crate::shared::ResponsePool::History, keep_bytes) as usize
                };
                if keep_units == 0 {
                    mem = None;
                } else if let Some(permit) = &mut mem {
                    let excess = permit.num_permits().saturating_sub(keep_units);
                    if excess > 0 {
                        let _ = permit.split(excess);
                    }
                }
            } else {
                mem = None;
            }
            let payload = match projected {
                Ok(payload) => payload,
                Err(invalid_response) => return invalid_response,
            };
            match placement.current(&app, &id, session).await {
                Recheck::Current => {}
                Recheck::Conflict => return blocked("conflict"),
                Recheck::Unavailable => return blocked("unavailable"),
            }
            drop(slot);
            if principal.live().is_err() {
                return crate::auth::unauthorized().into_response();
            }
            const HISTORY_STREAM_MAX: Duration = Duration::from_secs(120);
            let length = axum::http::HeaderValue::from(payload.len());
            let abort = crate::shared::materialized_stream_abort(principal.0.clone(), HISTORY_STREAM_MAX);
            let response_body = crate::shared::permit_body(payload, mem, abort);
            let mut response = (
                [
                    (header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json")),
                    (header::CONTENT_LENGTH, length),
                ],
                response_body,
            )
                .into_response();
            let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), HISTORY_STREAM_MAX);
            response.extensions_mut().insert(crate::shared::CancelWrite::new(write_abort));
            response
        };
        tokio::select! {
            biased;
            _ = app.native.wait_retired(&placement.endpoint) => blocked("unavailable"),
            response = work => response,
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout_at(deadline, request) => Ok(result.unwrap_or_else(|_| blocked("unavailable"))),
    }
}

fn valid_attachment_output(output: &Value) -> bool {
    let Some(obj) = output.as_object() else {
        return false;
    };
    match obj.get("status").and_then(Value::as_str) {
        Some("missing" | "too_large" | "current") => obj.len() == 1,
        Some("file") => {
            obj.len() == 2
                && obj
                    .get("data")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.len() <= user_files::FILE_BYTES.div_ceil(3) * 4)
        }
        Some("blocked") => {
            obj.len() == 2
                && obj.get("reason").and_then(Value::as_str).is_some_and(|r| {
                    matches!(
                        r,
                        "busy"
                            | "conflict"
                            | "unavailable"
                            | "maintenance_required"
                            | "not_deletable"
                            | "unsupported_storage"
                    )
                })
        }
        _ => false,
    }
}

pub async fn attachment(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, session, message, index, sha)): Path<(String, String, String, String, String)>,
) -> Result<Response, Error> {
    let missing = || error(Status::NOT_FOUND, "Attachment not found");
    let invalid = || error(Status::BAD_REQUEST, "Invalid attachment reference");
    let canonical_decimal =
        !index.is_empty() && (index == "0" || (!index.starts_with('0') && index.bytes().all(|b| b.is_ascii_digit())));
    if [session.as_str(), message.as_str()].iter().any(|id| id.len() > 256 || !crate::opencode::valid_id(id))
        || !canonical_decimal
        || !user_files::valid_digest(&sha)
    {
        return Err(invalid());
    }
    let Some(index) = index.parse::<usize>().ok().filter(|&n| n < user_files::FILE_COUNT) else {
        return Err(error(Status::BAD_REQUEST, "Invalid history navigation request"));
    };
    let request = async {
        let placement = Placement::capture(&app, &id, &session, true)
            .await
            .map_err(|e| if e.0 == Status::FORBIDDEN { e } else { missing() })?;
        let after_capture = async {
            if !placement.operation_current(&app, &id).await {
                return Err(missing());
            }
            if !placement.live(&app, &id).await {
                return Err(error(Status::CONFLICT, "Session location changed"));
            }
            let directory = match placement.ready(&app, &id, &session).await {
                Ok(directory) => directory,
                Err(Recheck::Conflict) => return Err(error(Status::CONFLICT, "Session location changed")),
                Err(_) => return Err(missing()),
            };
            let mut input = json!({"sessionID":session,"messageID":message,"fileIndex":index,"sha256":sha});
            let (status, body) =
                rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
            if !status.is_success() {
                return Err(missing());
            }
            let output: Value = serde_json::from_slice(&body).map_err(|_| missing())?;
            let output = &output["output"];
            if !valid_attachment_output(output) {
                return Err(missing());
            }
            match placement.current(&app, &id, &session).await {
                Recheck::Current => {}
                Recheck::Conflict => return Err(error(Status::CONFLICT, "Session location changed")),
                Recheck::Unavailable => return Err(missing()),
            }
            if output["status"] == "too_large" {
                return Err(error(Status::PAYLOAD_TOO_LARGE, "Attachment exceeds the size limit"));
            }
            if output["status"] != "file" {
                return Err(missing());
            }
            let bytes = user_files::inline(&output["data"])
                .filter(|bytes| user_files::digest(bytes) == sha)
                .ok_or_else(missing)?;
            input["confirm"] = true.into();
            let (status, reply) =
                rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
            let reply: Value = serde_json::from_slice(&reply).map_err(|_| missing())?;
            if !status.is_success()
                || !valid_attachment_output(&reply["output"])
                || reply["output"]["status"] != "current"
            {
                return Err(missing());
            }
            if !placement.operation_current(&app, &id).await {
                return Err(missing());
            }
            if !placement.live(&app, &id).await {
                return Err(error(Status::CONFLICT, "Session location changed"));
            }
            principal.live()?;
            const ATTACHMENT_STREAM_MAX: Duration = Duration::from_secs(60);
            let length = axum::http::HeaderValue::from(bytes.len());
            let abort = crate::shared::materialized_stream_abort(principal.0.clone(), ATTACHMENT_STREAM_MAX);
            let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), ATTACHMENT_STREAM_MAX);
            let mut response = (
                [
                    (header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/octet-stream")),
                    (header::CONTENT_LENGTH, length),
                    (header::CACHE_CONTROL, axum::http::HeaderValue::from_static("private, no-store")),
                    (header::CONTENT_DISPOSITION, axum::http::HeaderValue::from_static("attachment")),
                    (header::X_CONTENT_TYPE_OPTIONS, axum::http::HeaderValue::from_static("nosniff")),
                ],
                crate::shared::permit_body(bytes.into(), None, abort),
            )
                .into_response();
            response.extensions_mut().insert(crate::shared::CancelWrite::new(write_abort));
            Ok(response)
        };
        tokio::select! {
            biased;
            _ = app.native.wait_retired(&placement.endpoint) => Err(missing()),
            result = after_capture => result,
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), request) => result.unwrap_or_else(|_| Err(missing())),
    }
}

#[test]
fn directory_anchor_accepts_existing_or_missing_descendant_and_rejects_files() {
    use crate::worktrees::ownership::directory_anchor;
    let dir = crate::shared::test_dir("media-anchor");
    let file = dir.join("leaf.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(directory_anchor(&dir), Ok(Some(dir.as_path())));
    assert_eq!(directory_anchor(&dir.join("missing").join("nested")), Ok(Some(dir.as_path())));
    assert_eq!(directory_anchor(&file), Ok(None));
    assert_eq!(directory_anchor(&file.join("child")), Ok(None));
    std::fs::remove_dir_all(dir).unwrap();
}
