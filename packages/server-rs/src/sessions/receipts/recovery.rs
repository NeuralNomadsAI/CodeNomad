//! Reconnect snapshots inspect only already-loaded native Locations.
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    Error, Shared, Workspace,
    opencode::{Endpoint, upstream_error},
    worktrees::ownership::LoadedOwnership,
};

#[derive(Default)]
pub(crate) struct Recovery {
    wake: tokio::sync::Notify,
    active: Mutex<Option<Arc<Scan>>>,
}

#[derive(Default)]
struct Scan {
    deleted: Mutex<HashSet<String>>,
    stopped: CancellationToken,
}

impl Recovery {
    pub(crate) fn schedule(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn retire(&self, session: &str) {
        let active = self.active.lock().unwrap();
        let Some(scan) = active.as_ref() else { return };
        let mut deleted = scan.deleted.lock().unwrap();
        if deleted.len() >= 4096 {
            scan.stopped.cancel();
        } else {
            deleted.insert(session.into());
        }
    }

    pub(crate) async fn run(self: Arc<Self>, app: Shared, endpoint: Arc<Endpoint>, cancel: CancellationToken) {
        let mut seen = HashSet::new();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.wake.notified() => {}
            }
            let mut workspaces = app.inner.lock().unwrap().workspaces.clone();
            seen.retain(|id| workspaces.iter().any(|w| w.id == *id));
            workspaces.retain(|w| !seen.contains(&w.id));
            if !workspaces.is_empty() {
                let scan = Arc::new(Scan::default());
                *self.active.lock().unwrap() = Some(scan.clone());
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    _ = scan.stopped.cancelled() => Some(()),
                    _ = scan.snapshot(&app, &endpoint, workspaces, &mut seen) => Some(())
                };
                scan.stopped.cancel();
                *self.active.lock().unwrap() = None;
                if result.is_none() {
                    return;
                }
            }
        }
    }
}

async fn get(
    app: &Shared,
    endpoint: &Arc<Endpoint>,
    path: &str,
    directory: Option<&str>,
    max: usize,
) -> Result<Value, Error> {
    if !app.native.current(endpoint) {
        return Err(upstream_error());
    }
    let url = endpoint.url.join(path).map_err(|_| upstream_error())?;
    let mut request = app.native.client.get(url).basic_auth("opencode", Some(&endpoint.password));
    if let Some(directory) = directory {
        request = request.query(&[("location[directory]", directory)]);
    }
    let response = request
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| upstream_error())?;
    let body = crate::opencode::read_json(response, max).await.map_err(|_| upstream_error())?;
    app.native.current(endpoint).then_some(body).ok_or_else(upstream_error)
}

impl Scan {
    async fn snapshot(
        self: &Arc<Self>,
        app: &Shared,
        endpoint: &Arc<Endpoint>,
        workspaces: Vec<Workspace>,
        seen: &mut HashSet<uuid::Uuid>,
    ) {
        let source = self.source(app, endpoint).await;
        let Ok((scope, locations)) = source else {
            eprintln!("Permission receipt recovery incomplete");
            return;
        };
        let mut projects = stream::iter(workspaces)
            .map(|workspace| {
                let scope = &scope;
                let locations = &locations;
                async move {
                    let id = workspace.id;
                    let mut covered = self.project(app, endpoint, workspace.clone(), scope, locations).await;
                    if !covered && current(app, endpoint, &workspace) {
                        // Retry only this project; no completed peer waits for it.
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        covered = self.project(app, endpoint, workspace, scope, locations).await;
                    }
                    (id, covered)
                }
            })
            .buffer_unordered(4);
        while let Some((id, covered)) = projects.next().await {
            if covered {
                seen.insert(id);
            } else {
                eprintln!("Permission receipt recovery incomplete");
            }
        }
    }

    async fn source(&self, app: &Shared, endpoint: &Arc<Endpoint>) -> Result<(String, Vec<String>), Error> {
        if !app.native.current(endpoint) {
            return Err(upstream_error());
        }
        let scope = super::scope(app, endpoint).await?;
        let locations = get(app, endpoint, "/api/debug/location", None, 256 * 1024).await?;
        let mut distinct = HashSet::new();
        let locations = locations
            .as_array()
            .ok_or_else(upstream_error)?
            .iter()
            .filter_map(directory)
            .filter(|d| distinct.insert(*d))
            .map(str::to_owned)
            .collect();
        Ok((scope, locations))
    }

    async fn project(
        self: &Arc<Self>,
        app: &Shared,
        endpoint: &Arc<Endpoint>,
        workspace: Workspace,
        scope: &str,
        locations: &[String],
    ) -> bool {
        let inventory = tokio::time::timeout(Duration::from_secs(6), LoadedOwnership::load(app, &workspace, endpoint))
            .await
            .unwrap_or_else(|_| LoadedOwnership::opened_only(app));
        let mut complete = inventory.complete();
        let inventory = Arc::new(inventory);
        let valid = || current(app, endpoint, &workspace) && inventory.valid(app);
        for directory in locations.iter().map(String::as_str) {
            if !valid() {
                return false;
            }
            if !inventory.owns(app, &workspace, directory) {
                continue;
            }
            if !valid() {
                return false;
            }
            let Ok(body) = get(app, endpoint, "/api/permission/request", Some(directory), 2 * 1024 * 1024).await else {
                complete = false;
                continue;
            };
            let Some(rows) = body["data"].as_array().filter(|_| self::directory(&body["location"]) == Some(directory))
            else {
                complete = false;
                continue;
            };
            for row in rows {
                // One stalled capture must not starve later permissions in the same queue.
                let limit = tokio::time::Instant::now() + Duration::from_secs(20);
                let Some(request) = super::snapshot(row) else { continue };
                if !valid() {
                    return false;
                }
                let session = match crate::opencode::session_record_at(app, endpoint, &request.session_id).await {
                    Ok(session) => session,
                    Err((axum::http::StatusCode::NOT_FOUND, _)) => continue,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                let Some(location) = self::directory(&session["location"]) else { continue };
                if !inventory.owns(app, &workspace, location) {
                    continue;
                }
                let (owner, connection, captured) = (app.clone(), endpoint.clone(), workspace.clone());
                let (scan, session, proof) = (self.clone(), request.session_id.clone(), inventory.clone());
                let source = request.source.as_ref().map(|source| source.message_id.clone());
                let capture = super::capture(
                    app,
                    scope,
                    request,
                    {
                        let (session, location) = (session.clone(), location.to_owned());
                        move || {
                            tokio::time::Instant::now() < limit
                                && !scan.stopped.is_cancelled()
                                && !scan.deleted.lock().unwrap().contains(&session)
                                && current(&owner, &connection, &captured)
                                && proof.owns(&owner, &captured, &location)
                                && proof.valid(&owner)
                        }
                    },
                    {
                        let (app, endpoint, location) = (app.clone(), endpoint.clone(), location.to_owned());
                        let (workspace, inventory) = (workspace.clone(), inventory.clone());
                        move |previous| {
                            super::invalidate_fallbacks(&app, &endpoint, &session, source.as_deref(), previous);
                            publish_recovered(
                                &app,
                                &endpoint,
                                &location,
                                &session,
                                source.as_deref(),
                                &workspace,
                                &inventory,
                            )
                        }
                    },
                );
                if !matches!(tokio::time::timeout_at(limit, capture).await, Ok(Ok(()))) {
                    complete = false;
                }
            }
        }
        complete && valid()
    }
}

fn publish_recovered(
    app: &Shared,
    endpoint: &Arc<Endpoint>,
    location: &str,
    session: &str,
    source: Option<&str>,
    workspace: &Workspace,
    inventory: &LoadedOwnership,
) {
    let open = app.inner.lock().unwrap().workspaces.clone();
    for w in open {
        let cached;
        let proof = if w.id == workspace.id {
            inventory
        } else {
            cached = LoadedOwnership::cached(app, &w, endpoint);
            &cached
        };
        if !current(app, endpoint, &w) || !proof.owns(app, &w, location) || !proof.valid(app) {
            continue;
        }
        let mut event = json!({"type":"permission.receiptsChanged","instanceId":w.id,"sessionId":session});
        app.emit(event.clone());
        if let Some(message) = source {
            event["messageId"] = json!(message);
            app.emit(event);
        }
    }
}

fn directory(location: &Value) -> Option<&str> {
    if location.get("workspaceID").is_some() {
        return None;
    }
    location["directory"].as_str().filter(|d| crate::files::paths::local_absolute(d))
}

fn current(app: &Shared, endpoint: &Arc<Endpoint>, workspace: &Workspace) -> bool {
    app.native.current(endpoint) && crate::sessions::permission_mode::workspace_current(app, workspace)
}
