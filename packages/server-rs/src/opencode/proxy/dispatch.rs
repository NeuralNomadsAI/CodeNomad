//! Upstream HTTP dispatch, streaming response forwarding, and response-side workspace filtering.
use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::guards::{foreign, is_transport_json_content_type, relayed};
use crate::opencode::{Endpoint, NativeBody, read_json, session_directory, upstream_error};
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
    pub message_list: bool,
    pub account_route: bool,
    pub fork: bool,
    pub actual: Option<Value>,
    pub project: Option<String>,
    pub root_permissions: Option<Value>,
    pub receipt: Option<crate::sessions::receipts::Prepared>,
    pub mutation: Option<crate::worktrees::fence::Entered>,
    pub account_manual: Option<crate::provider_usage::selection::ManualGuard>,
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
        message_list,
        account_route,
        fork,
        actual,
        project,
        root_permissions,
        receipt,
        mutation,
        account_manual,
        rules_lock,
    } = ctx;
    let dispatched_mutation = mutation.is_some();
    let observer = principal.0.clone();
    let dispatch = move |detached: tokio_util::sync::CancellationToken| {
        Box::pin(async move {
            principal.live()?;
            if detached.is_cancelled()
                || !app.native.current(&endpoint)
                || !crate::sessions::permission_mode::workspace_current(&app, &workspace)
            {
                return Err(upstream_error());
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
                    Ok(Err(_)) => {
                        app.native.invalidate(&endpoint);
                        return Err(upstream_error());
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
            if !response.status().is_success()
                && (account_route || (message_list && !is_transport_json_content_type(response.headers())))
            {
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
                let mut payload = json!({
                    "_tag": "OpenCodeContractError",
                    "message": format!("OpenCode {version}: {method} {route} returned HTTP {}", status.as_u16()),
                    "status": status.as_u16(),
                    "profile": "modern",
                    "method": method,
                    "path": route,
                });
                if account_route {
                    payload["error"] = json!(status.canonical_reason().unwrap_or("Upstream Error"));
                }
                return Ok((status, Json(payload)).into_response());
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
            }
            impl Drop for InvalidateOnDrop {
                fn drop(&mut self) {
                    self.app.native.invalidate(&self.endpoint);
                }
            }
            let invalidate = unauthorized.then(|| InvalidateOnDrop { app: app.clone(), endpoint: endpoint.clone() });
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
        crate::opencode::proxy_write::forward(permit, rules_lock, observer, dispatch).await
    } else {
        dispatch(tokio_util::sync::CancellationToken::new()).await
    }
}
