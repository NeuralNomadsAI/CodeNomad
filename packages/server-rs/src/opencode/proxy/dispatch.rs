//! Upstream HTTP dispatch, streaming response forwarding, and response-side workspace filtering.
use std::{path::PathBuf, sync::Arc};

use axum::{
    Json,
    body::Body,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::guards::{foreign, is_transport_json_content_type, relayed};
use super::mutation::InputRecheck;
use crate::opencode::{Endpoint, NativeBody, pre_dispatch_unavailable, read_json, session_directory, upstream_error};
use crate::{Error, Shared, Workspace, error, not_found};

pub(super) struct DispatchContext {
    pub app: Shared,
    pub workspace: Workspace,
    pub endpoint: Arc<Endpoint>,
    pub principal: crate::auth::Principal,
    pub upstream: reqwest::RequestBuilder,
    pub method: String,
    pub route: String,
    pub opened: String,
    pub directory: String,
    pub id: String,
    pub send_input: bool,
    pub session: Option<String>,
    pub bound_directory: Option<String>,
    pub initial_identity: Option<(PathBuf, PathBuf, String)>,
    pub input_checkout: Option<crate::worktrees::ownership::DirectoryProof>,
    pub message_list: bool,
    pub account_route: bool,
    pub fork: bool,
    pub actual: Option<Value>,
    pub project: Option<String>,
    pub root_permissions: Option<Value>,
    pub receipt: Option<crate::sessions::receipts::Prepared>,
    pub mutation: Option<crate::worktrees::fence::Entered>,
    pub account_manual: Option<crate::provider_usage::selection::ManualGuard>,
    pub account_verified_locs: Vec<super::mutation::VerifiedAccountLocation>,
    pub rules_lock: Option<tokio::sync::OwnedMutexGuard<()>>,
}

pub(super) async fn dispatch_upstream(ctx: DispatchContext) -> Result<Response, Error> {
    let DispatchContext {
        app,
        workspace,
        endpoint,
        principal,
        upstream,
        method,
        route,
        opened,
        directory,
        id,
        send_input,
        session,
        bound_directory,
        initial_identity,
        input_checkout,
        message_list,
        account_route,
        fork,
        actual,
        project,
        root_permissions,
        receipt,
        mutation,
        account_manual,
        account_verified_locs,
        rules_lock,
    } = ctx;
    let dispatched_mutation = mutation.is_some();
    let observer = principal.0.clone();
    let self_invalidated = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let self_invalidated_dispatch = Arc::clone(&self_invalidated);
    let observer_app = app.clone();
    let observer_endpoint = endpoint.clone();
    let observer_id = id.clone();
    let observer_workspace = workspace.clone();
    let dispatch = move |detached: tokio_util::sync::CancellationToken,
                         gate: crate::opencode::proxy_write::DispatchGate| {
        Box::pin(async move {
            if principal.0.is_cancelled() {
                return Ok(crate::auth::unauthorized_before_dispatch());
            }
            if !account_verified_locs.is_empty() {
                let pre_dispatch = async {
                    for loc in &account_verified_locs {
                        if !super::mutation::verify_account_location_live(&app, &workspace, loc).await {
                            return Err(foreign());
                        }
                    }
                    Ok(())
                };
                tokio::select! {
                    biased;
                    _ = detached.cancelled() => return Err(upstream_error()),
                    _ = principal.0.cancelled() => return Ok(crate::auth::unauthorized_before_dispatch()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    res = pre_dispatch => res?,
                }
            }
            if principal.0.is_cancelled() {
                return Ok(crate::auth::unauthorized_before_dispatch());
            }
            if detached.is_cancelled()
                || !app.native.current(&endpoint)
                || !crate::sessions::permission_mode::workspace_current(&app, &workspace)
            {
                return if send_input {
                    Ok(super::before_dispatch_error(pre_dispatch_unavailable()))
                } else {
                    Err(upstream_error())
                };
            }
            if send_input {
                let recheck = InputRecheck {
                    app: &app,
                    workspace: &workspace,
                    endpoint: &endpoint,
                    principal: &principal,
                    session: session.as_deref(),
                    directory: &directory,
                    native_directory: actual.as_ref().and_then(|r| r["location"]["directory"].as_str()),
                    bound_directory: bound_directory.as_deref(),
                    message_list: false,
                    actual: &actual,
                    initial_identity: &initial_identity,
                    input_checkout: &input_checkout,
                };
                match Box::pin(recheck.verify()).await {
                    Ok(_) => {}
                    Err(e) if e.0 == Status::UNAUTHORIZED => return Ok(crate::auth::unauthorized_before_dispatch()),
                    Err(e) => return Ok(super::before_dispatch_error(e)),
                }
                if principal.0.is_cancelled() {
                    return Ok(crate::auth::unauthorized_before_dispatch());
                }
                if detached.is_cancelled() || !app.native.current(&endpoint) {
                    return Ok(super::before_dispatch_error(pre_dispatch_unavailable()));
                }
            }
            if !gate.try_dispatch() {
                return Ok(crate::auth::unauthorized_before_dispatch());
            }
            let ws_closed_headers = async {
                loop {
                    let notified = app.workspace_closed.notified();
                    if !app
                        .workspace(&id)
                        .is_ok_and(|current| current.id == workspace.id && current.path == workspace.path)
                    {
                        return;
                    }
                    notified.await;
                }
            };
            // Undici's default headers deadline for the TypeScript runtime transport.
            // Do not cap the total lifetime of a streaming native response.
            let response = tokio::select! {
                biased;
                _ = principal.0.cancelled(), if !dispatched_mutation => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint), if !dispatched_mutation => return Err(upstream_error()),
                _ = ws_closed_headers, if !dispatched_mutation && !message_list => return Err(not_found()),
                response = tokio::time::timeout(crate::opencode::PROXY_IDLE, upstream.send()) => match response {
                    Ok(Ok(response)) => response,
                    Ok(Err(err)) => {
                        app.native.invalidate(&endpoint);
                        return if send_input && err.is_connect() {
                            Ok(super::before_dispatch_error(pre_dispatch_unavailable()))
                        } else {
                            Err(upstream_error())
                        };
                    }
                    Err(_) => return Err(upstream_error()),
                },
            };
            if (message_list || account_route) && matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                drop(response);
                app.native.invalidate(&endpoint);
                return Err((
                    Status::INTERNAL_SERVER_ERROR,
                    Json(json!({"statusCode": 500, "error": "Internal Server Error", "message": "fetch failed"})),
                ));
            }
            if account_route && !response.status().is_success() {
                let status = response.status();
                let unauthorized = status == Status::UNAUTHORIZED;
                drop(response);
                if status == Status::NOT_MODIFIED {
                    app.native.invalidate(&endpoint);
                    return Err(upstream_error());
                }
                if unauthorized {
                    app.native.invalidate_if_current_with(&endpoint, || {
                        self_invalidated_dispatch.store(true, std::sync::atomic::Ordering::Release);
                    });
                }
                return Ok((
                    status,
                    Json(json!({
                        "_tag": "OpenCodeContractError",
                        "error": status.canonical_reason().unwrap_or("Upstream Error"),
                        "message": format!("OpenCode account request returned HTTP {}", status.as_u16()),
                        "status": status.as_u16(),
                        "profile": "modern",
                        "method": method,
                    })),
                )
                    .into_response());
            }
            if message_list && !response.status().is_success() && !is_transport_json_content_type(response.headers()) {
                let status = response.status();
                let unauthorized = status == Status::UNAUTHORIZED;
                drop(response);
                if status == Status::NOT_MODIFIED {
                    app.native.invalidate(&endpoint);
                    return Err(upstream_error());
                }
                if unauthorized {
                    app.native.invalidate(&endpoint);
                }
                let version = if endpoint.version.is_empty() { "v2" } else { endpoint.version.as_str() };
                return Ok((
                    status,
                    Json(json!({
                        "_tag": "OpenCodeContractError",
                        "message": format!("OpenCode {version}: {method} {route} returned HTTP {}", status.as_u16()),
                        "status": status.as_u16(),
                        "profile": "modern",
                        "method": method,
                        "path": route,
                    })),
                )
                    .into_response());
            }
            if message_list && response.status().is_success() {
                if !app.native.current(&endpoint) {
                    return Err(upstream_error());
                }
                principal.live()?;
            }
            if response.status().is_success() {
                if let Some(receipt) = receipt {
                    if let Err(error) = receipt.confirm(&app, &workspace).await {
                        eprintln!("Permission confirmed; receipt persistence failed: {}", error.0);
                    }
                }
            }
            if fork && response.status().is_success() {
                let builder = relayed(&response);
                let native = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
                let row = native.get("data").unwrap_or(&native);
                let source = actual.as_ref().ok_or_else(upstream_error)?;
                if row["projectID"] != source["projectID"]
                    || row["fork"]["sessionID"] != source["id"]
                    || row["location"] != source["location"]
                {
                    return Err(foreign());
                }
                let _ = crate::sessions::permission_mode::observe_fork(&app, &endpoint, &workspace, row, source).await;
                return builder
                    .extension(NativeBody)
                    .body(Body::from(native.to_string()))
                    .map_err(|_| upstream_error());
            }
            if let Some(block) = root_permissions.filter(|_| response.status().is_success()) {
                let builder = relayed(&response);
                let native = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
                let row = native.get("data").unwrap_or(&native);
                let session = row["id"].as_str().ok_or_else(upstream_error)?;
                let project = row["projectID"].as_str().filter(|s| !s.is_empty()).ok_or_else(upstream_error)?;
                crate::sessions::permission_mode::confirm_root(
                    &app,
                    &endpoint,
                    &directory,
                    project,
                    session,
                    &block,
                    false,
                    || crate::sessions::permission_mode::workspace_current(&app, &workspace),
                )
                .await?;
                return builder
                    .extension(NativeBody)
                    .body(Body::from(native.to_string()))
                    .map_err(|_| upstream_error());
            }
            if response.status().is_success() && project.is_some() {
                let builder = relayed(&response);
                let mut native = read_json(response, 8 * 1024 * 1024).await.map_err(|_| upstream_error())?;
                if !crate::worktrees::native_project(&app, &workspace, project.as_deref().unwrap()).await? {
                    return Err(error(Status::FORBIDDEN, "Session list does not belong to workspace"));
                }
                let rows = native["data"].as_array_mut().ok_or_else(upstream_error)?;
                let hit = crate::worktrees::linked::http_read(
                    &app,
                    &workspace,
                    crate::worktrees::linked::ReadMode::Validated,
                )
                .await?;
                let catalogue = match hit.snapshot.catalogue() {
                    Some(cat)
                        if !hit.from_cache || {
                            let c = std::sync::Arc::clone(&cat);
                            let opened = workspace.path.clone();
                            tokio::task::spawn_blocking(move || c.root_live_for(&opened)).await.unwrap_or(false)
                        } =>
                    {
                        cat
                    }
                    _ => {
                        crate::worktrees::linked::http_read(&app, &workspace, crate::worktrees::linked::ReadMode::Fresh)
                            .await?
                            .snapshot
                            .catalogue()
                            .ok_or_else(upstream_error)?
                    }
                };
                rows.retain(|row| {
                    row["location"].get("workspaceID").is_none()
                        && row["location"]["directory"].as_str().is_some_and(|p| catalogue.by_directory(p).is_some())
                });
                app.workspace(&id)?;
                principal.live()?;
                return builder
                    .extension(NativeBody)
                    .body(Body::from(native.to_string()))
                    .map_err(|_| upstream_error());
            }
            if response.status().is_success() && matches!(route.as_str(), "/api/project" | "/api/session/active") {
                let mut native: Value = response.json().await.map_err(|_| upstream_error())?;
                if route == "/api/project" {
                    let mut projects = native.as_array().cloned().ok_or_else(upstream_error)?;
                    let catalogue = match crate::worktrees::linked::http_read(
                        &app,
                        &workspace,
                        crate::worktrees::linked::ReadMode::Validated,
                    )
                    .await
                    {
                        Ok(hit) => match hit.snapshot.catalogue() {
                            Some(cat) if hit.from_cache => {
                                let c = std::sync::Arc::clone(&cat);
                                let opened = workspace.path.clone();
                                if tokio::task::spawn_blocking(move || c.root_live_for(&opened)).await.unwrap_or(false)
                                {
                                    Some(cat)
                                } else {
                                    crate::worktrees::linked::http_read(
                                        &app,
                                        &workspace,
                                        crate::worktrees::linked::ReadMode::Fresh,
                                    )
                                    .await
                                    .ok()
                                    .and_then(|fresh| fresh.snapshot.catalogue())
                                }
                            }
                            other => other,
                        },
                        Err(_) => None,
                    };
                    projects.retain(|project| {
                        project["canonical"].as_str().and_then(|s| dunce::canonicalize(s).ok()).as_ref()
                            == Some(catalogue.as_ref().map_or(&workspace.path, |c| &c.main))
                            && catalogue.as_ref().is_none_or(|c| project["id"] == c.project)
                    });
                    for project in &mut projects {
                        if let Some(paths) = project["sandboxes"].as_array_mut() {
                            paths.retain(|path| {
                                path.as_str().is_some_and(|p| {
                                    p == opened || catalogue.as_ref().is_some_and(|c| c.by_registered(p).is_some())
                                })
                            });
                        }
                    }
                    return Ok(Json(projects).into_response());
                }
                let active = native["data"].as_object_mut().ok_or_else(upstream_error)?;
                for id in active.keys().cloned().collect::<Vec<_>>() {
                    if session_directory(&app, &id).await.as_deref().ok() != Some(directory.as_str()) {
                        active.remove(&id);
                    }
                }
                return Ok(Json(native).into_response());
            }
            let status = response.status();
            let unauthorized = status == Status::UNAUTHORIZED;
            let builder = relayed(&response);
            let builder = if dispatched_mutation {
                builder
            } else if unauthorized {
                builder.extension(crate::shared::CancelWrite::token(principal.0.clone()))
            } else if message_list {
                builder.extension(crate::shared::CancelWrite::new(crate::shared::proxy_stream_abort(
                    app.clone(),
                    endpoint.clone(),
                    principal.0.clone(),
                    None,
                )))
            } else {
                builder.extension(crate::shared::CancelWrite::new(crate::shared::stream_abort(
                    app.clone(),
                    id.clone(),
                    workspace.clone(),
                    endpoint.clone(),
                    principal.0.clone(),
                )))
            };
            use futures_util::StreamExt;
            let cancelled = Box::pin(principal.0.clone().cancelled_owned());
            let app_retire = app.clone();
            let endpoint_retire = endpoint.clone();
            let ws_key = id.clone();
            let ws_snapshot = workspace.clone();
            let ws_app = app.clone();
            let ws_closed = Box::pin(async move {
                if dispatched_mutation || message_list {
                    std::future::pending::<()>().await;
                }
                loop {
                    let notified = ws_app.workspace_closed.notified();
                    if !ws_app
                        .workspace(&ws_key)
                        .is_ok_and(|current| current.id == ws_snapshot.id && current.path == ws_snapshot.path)
                    {
                        return;
                    }
                    notified.await;
                }
            });
            struct InvalidateOnDrop {
                app: Shared,
                endpoint: std::sync::Arc<Endpoint>,
                self_invalidated: Arc<std::sync::atomic::AtomicBool>,
            }
            impl Drop for InvalidateOnDrop {
                fn drop(&mut self) {
                    let flag = &self.self_invalidated;
                    self.app.native.invalidate_if_current_with(&self.endpoint, || {
                        flag.store(true, std::sync::atomic::Ordering::Release);
                    });
                }
            }
            let invalidate = unauthorized.then(|| InvalidateOnDrop {
                app: app.clone(),
                endpoint: endpoint.clone(),
                self_invalidated: Arc::clone(&self_invalidated_dispatch),
            });
            let bytes = futures_util::stream::unfold(
                (
                    response.bytes_stream(),
                    cancelled,
                    ws_closed,
                    app_retire,
                    endpoint_retire,
                    dispatched_mutation,
                    unauthorized,
                    invalidate,
                    account_manual,
                    false,
                ),
                |(
                    mut inner,
                    mut cancelled,
                    mut ws_closed,
                    app_retire,
                    endpoint_retire,
                    dispatched_mutation,
                    unauthorized,
                    invalidate,
                    account_manual,
                    done,
                )| async move {
                    if done {
                        return None;
                    }
                    let next = tokio::select! {
                        biased;
                        _ = &mut cancelled, if !dispatched_mutation => {
                            return Some((
                                Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                                (
                                    inner,
                                    cancelled,
                                    ws_closed,
                                    app_retire,
                                    endpoint_retire,
                                    dispatched_mutation,
                                    unauthorized,
                                    invalidate,
                                    account_manual,
                                    true,
                                ),
                            ));
                        }
                        _ = &mut ws_closed, if !dispatched_mutation => {
                            return Some((
                                Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "workspace closed")),
                                (
                                    inner,
                                    cancelled,
                                    ws_closed,
                                    app_retire,
                                    endpoint_retire,
                                    dispatched_mutation,
                                    unauthorized,
                                    invalidate,
                                    account_manual,
                                    true,
                                ),
                            ));
                        }
                        _ = app_retire.native.wait_retired(&endpoint_retire), if !dispatched_mutation && !unauthorized => {
                            return Some((
                                Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                                (
                                    inner,
                                    cancelled,
                                    ws_closed,
                                    app_retire,
                                    endpoint_retire,
                                    dispatched_mutation,
                                    unauthorized,
                                    invalidate,
                                    account_manual,
                                    true,
                                ),
                            ));
                        }
                        item = inner.next() => item,
                    };
                    next.map(|chunk| {
                        (
                            chunk.map_err(std::io::Error::other),
                            (
                                inner,
                                cancelled,
                                ws_closed,
                                app_retire,
                                endpoint_retire,
                                dispatched_mutation,
                                unauthorized,
                                invalidate,
                                account_manual,
                                false,
                            ),
                        )
                    })
                },
            );
            builder.extension(NativeBody).body(Body::from_stream(bytes)).map_err(|_| upstream_error())
        })
    };
    if let Some(permit) = mutation {
        let retire_app = observer_app.clone();
        let retire_ep = observer_endpoint.clone();
        let guards = crate::opencode::proxy_write::ObserverGuards {
            principal: observer,
            retired: Box::pin(async move {
                retire_app.native.wait_retired(&retire_ep).await;
                if self_invalidated.load(std::sync::atomic::Ordering::Acquire) {
                    std::future::pending::<()>().await;
                }
            }),
            closed: Box::pin(async move {
                loop {
                    let notified = observer_app.workspace_closed.notified();
                    if !observer_app.workspace(&observer_id).is_ok_and(|current| {
                        current.id == observer_workspace.id && current.path == observer_workspace.path
                    }) {
                        return;
                    }
                    notified.await;
                }
            }),
            send_input,
        };
        crate::opencode::proxy_write::forward(permit, rules_lock, guards, dispatch).await
    } else {
        dispatch(tokio_util::sync::CancellationToken::new(), crate::opencode::proxy_write::DispatchGate::new()).await
    }
}
