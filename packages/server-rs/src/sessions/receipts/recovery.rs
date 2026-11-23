//! Reconnect snapshots inspect only already-loaded native Locations.
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

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
                    _ = scan.stopped.cancelled() => Some(false),
                    result = scan.snapshot(&app, &endpoint, &workspaces) => Some(matches!(result, Ok(true)))
                };
                scan.stopped.cancel();
                *self.active.lock().unwrap() = None;
                match result {
                    None => return,
                    Some(true) => seen.extend(workspaces.iter().map(|w| w.id)),
                    Some(false) => eprintln!("Permission receipt recovery incomplete"),
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
        workspaces: &[Workspace],
    ) -> Result<bool, Error> {
        if !app.native.current(endpoint) {
            return Err(upstream_error());
        }
        let scope = super::scope(app, endpoint).await?;
        let locations = get(app, endpoint, "/api/debug/location", None, 256 * 1024).await?;
        let workspaces_all = app.inner.lock().unwrap().workspaces.clone();
        let mut inventories = Vec::with_capacity(workspaces_all.len());
        let mut complete = true;
        for workspace in workspaces_all {
            if current(app, endpoint, &workspace) {
                match tokio::time::timeout(Duration::from_secs(6), LoadedOwnership::load(app, &workspace, endpoint))
                    .await
                {
                    Ok(inventory) => inventories.push((workspace, Arc::new(inventory))),
                    Err(_) => complete = false,
                }
            }
        }
        let mut locations_seen = HashSet::new();
        for location in locations.as_array().ok_or_else(upstream_error)? {
            let Some(directory) = directory(location).filter(|d| locations_seen.insert(*d)) else { continue };
            let mut owners = Vec::new();
            for (workspace, inventory) in &inventories {
                if workspaces.iter().any(|w| w.id == workspace.id)
                    && current(app, endpoint, workspace)
                    && inventory.owns(app, workspace, directory)
                {
                    owners.push((workspace, inventory));
                }
            }
            if owners.is_empty() {
                continue;
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
                if !owners.iter().any(|(w, _)| current(app, endpoint, w)) {
                    break;
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
                let Some((workspace, inventory)) =
                    owners.iter().find(|(w, inventory)| current(app, endpoint, w) && inventory.owns(app, w, location))
                else {
                    continue;
                };
                let (owner, connection, workspace) = (app.clone(), endpoint.clone(), (**workspace).clone());
                let (scan, session, inventory) = (self.clone(), request.session_id.clone(), Arc::clone(inventory));
                let source = request.source.as_ref().map(|source| source.message_id.clone());
                let capture = super::capture(
                    app,
                    &scope,
                    request,
                    {
                        let (session, location) = (session.clone(), location.to_owned());
                        move || {
                            tokio::time::Instant::now() < limit
                                && !scan.stopped.is_cancelled()
                                && !scan.deleted.lock().unwrap().contains(&session)
                                && current(&owner, &connection, &workspace)
                                && inventory.owns(&owner, &workspace, &location)
                        }
                    },
                    {
                        let (app, endpoint, location) = (app.clone(), endpoint.clone(), location.to_owned());
                        let watchers = inventories
                            .iter()
                            .filter(|(w, inventory)| inventory.owns(&app, w, &location))
                            .cloned()
                            .collect::<Vec<_>>();
                        move || publish_recovered(&app, &endpoint, &location, &session, source.as_deref(), &watchers)
                    },
                );
                if !matches!(tokio::time::timeout_at(limit, capture).await, Ok(Ok(()))) {
                    complete = false;
                }
            }
        }
        Ok(complete)
    }
}

fn publish_recovered(
    app: &Shared,
    endpoint: &Arc<Endpoint>,
    location: &str,
    session: &str,
    source: Option<&str>,
    watchers: &[(Workspace, Arc<LoadedOwnership>)],
) {
    for (workspace, inventory) in watchers {
        if current(app, endpoint, workspace)
            && inventory.owns(app, workspace, location)
            && current(app, endpoint, workspace)
        {
            let mut event = json!({"type":"permission.receiptsChanged","instanceId":workspace.id,"sessionId":session});
            app.emit(event.clone());
            if let Some(message) = source {
                event["messageId"] = json!(message);
                app.emit(event);
            }
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
