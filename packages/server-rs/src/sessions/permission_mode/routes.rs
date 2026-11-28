use super::{Target, current, directory, mode, mode_locked, session_lock};
use crate::{
    App, Error, Shared, Workspace,
    auth::Principal,
    error, files, opencode,
    worktrees::{fence, ownership},
};
use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{Method, StatusCode as Status, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use tokio::time::{Instant, timeout_at};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode {
    Autonomous,
    Supervised,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: Mode,
}

fn ordinary(id: &str) -> bool {
    id.starts_with("ses") && id.len() > 3 && opencode::valid_id(id) && !id.starts_with("ses_cn_schedule_")
}

pub(crate) async fn handle(
    State(app): State<Shared>,
    Path((wid, id)): Path<(String, String)>,
    Extension(p): Extension<Principal>,
    request: Request,
) -> Response {
    let result = run(&app, &wid, &id, &p, request).await;
    let mut response = result.into_response();
    response.headers_mut().insert(CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn run(app: &Shared, wid: &str, id: &str, p: &Principal, request: Request) -> Result<Json<Value>, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid conversation permission mode request");
    if !ordinary(id) {
        return Err(invalid());
    }
    let write = if request.method() == Method::PUT {
        let bytes = to_bytes(request.into_body(), 1024).await.map_err(|_| invalid())?;
        Some(serde_json::from_slice::<Input>(&bytes).map_err(|_| invalid())?.mode)
    } else {
        None
    };
    let workspace = app.workspace(wid)?;
    let endpoint = app.native.endpoint().ok_or_else(super::unavailable)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    p.live()?;
    let foreign = || error(Status::FORBIDDEN, "Conversation does not belong to workspace");
    let family = || error(Status::CONFLICT, "Conversation family unavailable");
    let mut chain = vec![];
    let mut paths = vec![];
    let mut checkouts = vec![];
    let mut visited = HashSet::new();
    let mut session_id = id.to_owned();
    let mut project = None;
    loop {
        if !ordinary(&session_id) || visited.len() >= 64 || !visited.insert(session_id.clone()) {
            return Err(family());
        }
        let session = timeout_at(deadline, opencode::session_record_at(app, &endpoint, &session_id))
            .await
            .map_err(|_| super::unavailable())?
            .map_err(|e| if session_id != id && e.0 == Status::NOT_FOUND { family() } else { e })?;
        let dir = directory(&session).ok_or_else(foreign)?;
        let owner = session["projectID"].as_str().filter(|s| !s.is_empty()).ok_or_else(foreign)?;
        if project.as_deref().is_some_and(|project| owner != project)
            || session["metadata"].get("codenomad.schedule-carrier").is_some()
        {
            return Err(foreign());
        }
        project = Some(owner.to_owned());
        let owned = timeout_at(deadline, owned_location(app, &workspace, dir))
            .await
            .map_err(|_| super::unavailable())?
            .ok_or_else(foreign)?;
        for path in [owned.directory.into(), owned.checkout.clone()] {
            let identity = files::host_identity(&path).map_err(|_| foreign())?;
            paths.push((path, identity));
        }
        checkouts.push(fence::identity(&owned.checkout));
        checkouts.push(fence::session(&session_id));
        let parent = session["parentID"].as_str().map(str::to_owned);
        let root = session["parentID"].is_null() || !session["fork"].is_null();
        chain.push(session);
        if root {
            break;
        }
        session_id = parent.ok_or_else(family)?;
    }
    let root = chain.last().unwrap();
    let mode = if let Some(write) = write {
        let mut cleanup_guards = Vec::with_capacity(chain.len());
        for session in &chain {
            let sid = session["id"].as_str().ok_or_else(family)?;
            cleanup_guards.push(app.session_cleanup.enter_mutation(sid).ok_or_else(family)?);
        }
        let permit = fence::enter(&checkouts).ok_or_else(family)?;
        timeout_at(
            deadline,
            opencode::proxy::verify_mutation(app, &session_id, directory(root).ok_or_else(foreign)?, root),
        )
        .await
        .map_err(|_| super::unavailable())??;
        for session in &chain {
            let id = session["id"].as_str().ok_or_else(family)?;
            let fresh = timeout_at(deadline, opencode::session_record_at(app, &endpoint, id))
                .await
                .map_err(|_| super::unavailable())??;
            if !["projectID", "location", "parentID", "fork"].iter().all(|k| fresh[k] == session[k])
                || fresh["time"]["created"] != session["time"]["created"]
            {
                return Err(family());
            }
        }
        let lock = tokio::select! {
            biased;
            _ = p.0.cancelled() => return Err(crate::auth::unauthorized()),
            lock = timeout_at(deadline, session_lock(&session_id)) => lock.map_err(|_| super::unavailable())?,
        };
        let disconnected = tokio_util::sync::CancellationToken::new();
        let _disconnect_guard = disconnected.clone().drop_guard();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app_task = app.clone();
        let endpoint_task = endpoint.clone();
        let root_owned = root.clone();
        let p_task = Principal(p.0.clone());
        tokio::spawn(async move {
            let (_lock, _permit, _cleanup_guards) = (lock, permit, cleanup_guards);
            let authority = || {
                !disconnected.is_cancelled()
                    && Instant::now() < deadline
                    && p_task.live().is_ok()
                    && current(&app_task, &endpoint_task)
                    && workspace_current(&app_task, &workspace)
                    && paths.iter().all(|(path, identity)| files::host_identity(path).as_ref().ok() == Some(identity))
            };
            let target =
                Target { app: &app_task, endpoint: &endpoint_task, session: &root_owned, authority: &authority };
            let _ = tx.send(mode_locked(&target, Some(write)).await);
        });
        tokio::select! {
            biased;
            _ = p.0.cancelled() => return Err(crate::auth::unauthorized()),
            outcome = rx => outcome.map_err(|_| super::unavailable())??,
        }
    } else {
        let authority = || {
            Instant::now() < deadline
                && p.live().is_ok()
                && current(app, &endpoint)
                && workspace_current(app, &workspace)
                && paths.iter().all(|(path, identity)| files::host_identity(path).as_ref().ok() == Some(identity))
        };
        let target = Target { app, endpoint: &endpoint, session: root, authority: &authority };
        mode(&target, None).await?
    };
    Ok(Json(if id == session_id { json!({"mode":mode}) } else { json!({"mode":mode,"rootSessionID":session_id}) }))
}

async fn owned_location(app: &App, workspace: &Workspace, dir: &str) -> Option<ownership::Owned> {
    if !files::paths::local_absolute(dir) {
        return None;
    }
    ownership::resolve(app, workspace, dir).await
}

pub(crate) fn workspace_current(app: &App, w: &Workspace) -> bool {
    app.workspace(&w.id.to_string())
        .is_ok_and(|fresh| fresh.path == w.path && fresh.location == w.location && fresh.created_at == w.created_at)
}
