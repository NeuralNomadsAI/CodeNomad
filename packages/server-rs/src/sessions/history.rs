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

pub(super) struct Placement {
    workspace: crate::Workspace,
    pub(super) endpoint: Arc<crate::opencode::Endpoint>,
    source: Value,
    /// Physical checkout of the session's owned location (root or linked worktree).
    path: std::path::PathBuf,
    anchor: std::path::PathBuf,
    physical: Arc<same_file::Handle>,
    workspace_physical: Option<Arc<same_file::Handle>>,
    checkout: crate::worktrees::ownership::DirectoryProof,
    displays: Vec<Arc<AtomicBool>>,
    media: bool,
    strict_media: bool,
}

impl Placement {
    pub(super) async fn capture(app: &App, id: &str, session: &str, references: bool) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, false, false, references).await
    }

    pub(super) async fn capture_for_media(app: &App, id: &str, session: &str) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, true, true, false).await
    }

    pub(super) async fn capture_with_media(
        app: &App,
        id: &str,
        session: &str,
        media: bool,
        fenced: bool,
    ) -> Result<Self, Error> {
        Self::capture_inner(app, id, session, media, false, fenced).await
    }

    async fn capture_inner(
        app: &App,
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
            let handle = tokio::task::spawn_blocking(move || same_file::Handle::from_path(&path))
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
            Some(Arc::new(handle))
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
            let timeout = if media { Duration::from_secs(30) } else { Duration::from_secs(10) };
            let deadline = tokio::time::Instant::now() + timeout;
            app.native.acquire(deadline).await.map_err(|_| crate::opencode::upstream_error())?
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
            let source = if strict_media {
                crate::opencode::session_record_media_raw_at(app, &endpoint, session).await?
            } else if media {
                crate::opencode::session_record_media_at(app, &endpoint, session).await?
            } else {
                crate::opencode::session_record_at(app, &endpoint, session).await?
            };
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
            if location.get("workspaceID").is_some() {
                return Err(forbidden());
            }
            let directory = location["directory"]
                .as_str()
                .filter(|d| crate::files::paths::local_absolute(d))
                .ok_or_else(unavailable)?;
            if !crate::files::paths::under(&app.scope, std::path::Path::new(directory)) {
                return Err(forbidden());
            }
            let dir_owned = directory.to_owned();
            let (path, anchor, physical) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
                let unavailable = || error(Status::SERVICE_UNAVAILABLE, "History placement unavailable");
                let forbidden = || error(Status::FORBIDDEN, "Session does not belong to workspace");
                let path = crate::worktrees::ownership::resolve_exact_directory(&dir_owned).ok_or_else(unavailable)?;
                let anchor = crate::worktrees::ownership::directory_anchor(&path)
                    .map_err(|_| unavailable())?
                    .ok_or_else(forbidden)?
                    .to_owned();
                let physical = same_file::Handle::from_path(&anchor).map_err(|_| unavailable())?;
                Ok((path, anchor, Arc::new(physical)))
            })
            .await
            .map_err(|_| unavailable())??;
            if fenced && path != workspace.path {
                displays.push(display(&path));
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
            Ok(newest) if newest["revert"] == self.source["revert"] => Recheck::Current,
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
        let newest = if self.strict_media {
            crate::opencode::session_record_media_raw_at(app, &self.endpoint, session).await?
        } else if self.media {
            crate::opencode::session_record_media_at(app, &self.endpoint, session).await?
        } else {
            crate::opencode::session_record_at(app, &self.endpoint, session).await?
        };
        if !self.operation_current(app, id).await {
            return Err(crate::opencode::upstream_error());
        }
        if newest["id"] != self.source["id"]
            || newest["location"] != self.source["location"]
            || (!self.strict_media && newest["projectID"] != self.source["projectID"])
            || !self.live(app, id).await
        {
            return Err(changed());
        }
        if self.media {
            let current = crate::worktrees::ownership::media_directory(
                app,
                &self.workspace,
                &self.endpoint,
                &self.path,
                &self.anchor,
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
        let workspace_path = self.workspace.path.clone();
        let workspace_physical = self.workspace_physical.clone();
        let path = self.path.clone();
        let anchor = self.anchor.clone();
        let physical = self.physical.clone();
        let checkout = self.checkout.clone();
        let ok = tokio::task::spawn_blocking(move || {
            workspace_physical.as_ref().is_none_or(|expected| {
                same_file::Handle::from_path(&workspace_path).is_ok_and(|current| current == **expected)
            }) && crate::worktrees::ownership::resolve_exact_directory(&raw_dir).as_ref() == Some(&path)
                && crate::worktrees::ownership::directory_anchor(&path) == Ok(Some(anchor.as_path()))
                && same_file::Handle::from_path(&anchor).is_ok_and(|current| current == *physical)
                && checkout.live(&path)
        })
        .await
        .unwrap_or(false);
        ok && self.operation_current_fast(app, id) && self.displays.iter().all(|display| display.load(Relaxed))
    }

    async fn ready(&self, app: &App, id: &str, session: &str) -> Result<&str, Recheck> {
        let directory = self.source["location"]["directory"].as_str().ok_or(Recheck::Unavailable)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        if self.media {
            let url = self.endpoint.url.join("/api/plugin").map_err(|_| Recheck::Unavailable)?;
            super::pending::await_plugin_with(super::pending::SESSION_PRUNING_PLUGIN, directory, deadline, || {
                (self.operation_current_fast(app, id) && self.displays.iter().all(|d| d.load(Relaxed)))
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
            crate::extensions::lifecycle::ready(directory, deadline).await.map_err(|_| Recheck::Unavailable)?;
        } else {
            prepare(app, directory, deadline).await.ok_or(Recheck::Unavailable)?;
        }
        match self.current(app, id, session).await {
            Recheck::Current => Ok(directory),
            other => Err(other),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Recheck {
    Current,
    Conflict,
    Unavailable,
}

async fn same_identity_async(path: std::path::PathBuf, expected: Option<Arc<same_file::Handle>>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    tokio::task::spawn_blocking(move || same_file::Handle::from_path(&path).is_ok_and(|physical| physical == *expected))
        .await
        .unwrap_or(false)
}

pub(super) async fn prepare(app: &App, directory: &str, deadline: tokio::time::Instant) -> Option<()> {
    crate::sessions::pending::await_plugin(app, crate::sessions::pending::SESSION_PRUNING_PLUGIN, directory, deadline)
        .await
        .ok()?;
    crate::extensions::lifecycle::ready(directory, deadline).await.ok()
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
    rpc_with_limit(app, endpoint, directory, method, input, timeout, 24 * 1024 * 1024).await
}

async fn rpc_with_limit(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
    timeout: Duration,
    limit: usize,
) -> Result<(Status, Bytes), ()> {
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
    Ok((status, crate::opencode::read_bytes(response, limit).await?.into()))
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

struct ValidatedHistory {
    output: Value,
    raw_range: std::ops::Range<usize>,
    body: Bytes,
    user_files_marker: Option<Value>,
}

fn parse_and_validate_history(
    status: Status,
    body: axum::body::Bytes,
    action: &str,
    reference: bool,
) -> Result<ValidatedHistory, Response> {
    let Ok(envelope) = serde_json::from_slice::<Envelope>(&body) else { return Err(blocked("unavailable")) };
    let Some(raw) = envelope.output else { return Err(blocked("unavailable")) };
    let raw_bytes = raw.get().as_bytes();
    let offset = raw_bytes.as_ptr() as usize - body.as_ptr() as usize;
    let raw_range = offset..offset + raw_bytes.len();
    let Ok(mut output) = serde_json::from_str::<Value>(raw.get()) else { return Err(blocked("unavailable")) };
    // Temporarily strip valid `userFiles` so base contract validation runs before session revalidation,
    // while still rejecting a present-but-invalid `userFiles` value before revalidation
    // (TS `navigation-contract.ts:77-83`, `session-navigation.ts:85-91`).
    let user_files_marker = if reference && output["status"] == "window" {
        let marker = output.as_object_mut().and_then(|root| root.remove("userFiles"));
        if marker.as_ref().is_some_and(|v| v.as_str() != Some(user_files::REFERENCE)) {
            return Err(blocked("unavailable"));
        }
        marker
    } else {
        None
    };
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
    Ok(ValidatedHistory { output, raw_range, body, user_files_marker })
}

fn finalize_history_payload(
    mut validated: ValidatedHistory,
    id: &str,
    session: &str,
    reference: bool,
    defer: bool,
) -> Result<Bytes, Response> {
    if reference && validated.output["status"] == "window" {
        if let Some(marker) = validated.user_files_marker.take()
            && let Some(root) = validated.output.as_object_mut()
        {
            root.insert("userFiles".into(), marker);
        }
        if !user_files::validate_window(&mut validated.output) {
            return Err(blocked("unavailable"));
        }
    }
    let deferred =
        defer && validated.output["status"] == "window" && media::defer(id, session, &mut validated.output["messages"]);
    let referenced = reference && validated.output["status"] == "window";
    let payload: Bytes = if referenced || deferred {
        if referenced {
            validated.output["userFiles"] = user_files::REFERENCE.into();
        }
        let Ok(projected) = serde_json::to_vec(&validated.output) else { return Err(blocked("unavailable")) };
        if referenced && projected.len() > 24 * 1024 * 1024 {
            return Err(blocked("unsupported_storage"));
        }
        projected.into()
    } else {
        validated.body.slice(validated.raw_range)
    };
    Ok(payload)
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
    let bytes = to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Request body is too large"))?;
    let schema = crate::sessions::contracts::get(&action, false);
    let input: Option<Value> = serde_json::from_slice(&bytes).ok();
    let input = input.filter(|i| crate::sessions::contracts::valid(schema, i)).ok_or_else(invalid)?;
    let session = input["sessionID"].as_str().ok_or_else(invalid)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let request = async {
        // Always capture deletion fences for history navigation (TS `session-navigation.ts:48-55`).
        let placement = match Placement::capture_with_media(&app, &id, session, defer, true).await {
            Ok(placement) => placement,
            Err((Status::FORBIDDEN, body)) => return (Status::FORBIDDEN, body).into_response(),
            Err(_) => return blocked("unavailable"),
        };
        static DEFER_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let work = async {
            let slot = if defer {
                let workspace_closed = async {
                    loop {
                        let notified = app.workspace_closed.notified();
                        if !placement.operation_current_fast(&app, &id) {
                            return;
                        }
                        notified.await;
                    }
                };
                let permit = tokio::select! {
                    biased;
                    _ = workspace_closed => return blocked("unavailable"),
                    permit = DEFER_SLOTS.acquire() => match permit {
                        Ok(permit) => permit,
                        Err(_) => return blocked("unavailable"),
                    }
                };
                Some(permit)
            } else {
                None
            };
            // Acquire the deferred permit before final revalidation so a closed project or
            // retired daemon cannot dispatch an RPC after waiting for a slot.
            let directory = match placement.ready(&app, &id, session).await {
                Ok(directory) => directory,
                Err(Recheck::Conflict) => return blocked("conflict"),
                Err(_) => return blocked("unavailable"),
            };
            if !placement.operation_current(&app, &id).await {
                return blocked("unavailable");
            }
            let rpc_limit = 24 * 1024 * 1024 + if defer { 64 * 1024 } else { 0 };
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
                    match placement.current(&app, &id, session).await {
                        Recheck::Current => {}
                        Recheck::Conflict => return blocked("conflict"),
                        Recheck::Unavailable => return blocked("unavailable"),
                    }
                    let fallback_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
                    let Ok(fallback) =
                        rpc_with_timeout(&app, &placement.endpoint, directory, "outline", &input, fallback_timeout)
                            .await
                    else {
                        return blocked("unavailable");
                    };
                    (status, body) = fallback;
                }
            }
            let body_len = body.len();
            let (validated, slot) = if defer && body_len > 32 * 1024 {
                let action_owned = action.clone();
                match tokio::task::spawn_blocking(move || {
                    (parse_and_validate_history(status, body, &action_owned, reference), slot)
                })
                .await
                {
                    Ok((Ok(validated), slot)) => (validated, slot),
                    Ok((Err(invalid_response), _)) => return invalid_response,
                    Err(_) => return blocked("unavailable"),
                }
            } else {
                match parse_and_validate_history(status, body, &action, reference) {
                    Ok(validated) => (validated, slot),
                    Err(invalid_response) => return invalid_response,
                }
            };
            // Reserve response-stream memory BEFORE final session revalidation so no blocking
            // wait occurs after the last native check.
            let mem = if defer {
                let workspace_closed = async {
                    loop {
                        let notified = app.workspace_closed.notified();
                        if !placement.operation_current_fast(&app, &id) {
                            return;
                        }
                        notified.await;
                    }
                };
                let permit = tokio::select! {
                    biased;
                    _ = workspace_closed => return blocked("unavailable"),
                    permit = crate::shared::reserve_response_memory(body_len) => match permit {
                        Ok(permit) => permit,
                        Err(_) => return blocked("unavailable"),
                    }
                };
                Some(permit)
            } else {
                None
            };
            match placement.current(&app, &id, session).await {
                Recheck::Current => {}
                Recheck::Conflict => return blocked("conflict"),
                Recheck::Unavailable => return blocked("unavailable"),
            }
            let projected = if defer && body_len > 32 * 1024 {
                let (id, session) = (id.clone(), session.to_owned());
                match tokio::task::spawn_blocking(move || {
                    (finalize_history_payload(validated, &id, &session, reference, defer), slot)
                })
                .await
                {
                    Ok((result, slot)) => (result, slot),
                    Err(_) => return blocked("unavailable"),
                }
            } else {
                (finalize_history_payload(validated, &id, session, reference, defer), slot)
            };
            let (payload, slot) = match projected {
                (Ok(payload), slot) => (payload, slot),
                (Err(invalid_response), _) => return invalid_response,
            };
            drop(slot);
            if !placement.operation_current(&app, &id).await {
                return blocked("unavailable");
            }
            if !placement.live(&app, &id).await {
                return blocked("conflict");
            }
            if principal.live().is_err() {
                return crate::auth::unauthorized().into_response();
            }
            let length = axum::http::HeaderValue::from(payload.len());
            let response_body = if defer {
                let abort = crate::shared::stream_abort(
                    app.clone(),
                    id.clone(),
                    placement.workspace.clone(),
                    placement.endpoint.clone(),
                    principal.0.clone(),
                );
                crate::shared::permit_body(payload, mem, abort)
            } else {
                axum::body::Body::from(payload)
            };
            (
                [
                    (header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json")),
                    (header::CONTENT_LENGTH, length),
                ],
                response_body,
            )
                .into_response()
        };
        if defer {
            tokio::select! {
                biased;
                _ = app.native.wait_retired(&placement.endpoint) => blocked("unavailable"),
                response = work => response,
            }
        } else {
            work.await
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout_at(deadline, request) => Ok(result.unwrap_or_else(|_| blocked("unavailable"))),
    }
}

pub async fn attachment(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, session, message, index, sha)): Path<(String, String, String, String, String)>,
) -> Result<Response, Error> {
    let missing = || error(Status::NOT_FOUND, "Attachment not found");
    let invalid = || error(Status::BAD_REQUEST, "Invalid attachment reference");
    let index: usize = index
        .parse::<usize>()
        .ok()
        .filter(|n| *n < user_files::FILE_COUNT && n.to_string() == index)
        .ok_or_else(invalid)?;
    if [session.as_str(), message.as_str()].iter().any(|id| id.len() > 256 || !crate::opencode::valid_id(id))
        || !user_files::valid_digest(&sha)
    {
        return Err(invalid());
    }
    let request = async {
        let placement = Placement::capture(&app, &id, &session, true)
            .await
            .map_err(|e| if e.0 == Status::FORBIDDEN { e } else { missing() })?;
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
        let bytes =
            user_files::inline(&output["data"]).filter(|bytes| user_files::digest(bytes) == sha).ok_or_else(missing)?;
        input["confirm"] = true.into();
        let (status, reply) =
            rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
        let reply: Value = serde_json::from_slice(&reply).map_err(|_| missing())?;
        if !status.is_success() || reply["output"]["status"] != "current" {
            return Err(missing());
        }
        principal.live()?;
        if !placement.operation_current(&app, &id).await {
            return Err(missing());
        }
        if !placement.live(&app, &id).await {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::CONTENT_DISPOSITION, "attachment"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response())
    };
    tokio::select! {
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
