use super::{
    Blocks, OWNER, current, directory, key, maybe_supervised, owns_root, recorded, refresh_before_send, remember, root,
    rules, saved, session_lock, unavailable, workspace_current,
};
use crate::{
    App, Error, Shared, Workspace, files,
    opencode::{self, Endpoint},
    worktrees::{self, fence},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
pub(crate) struct RefreshQueue {
    pending: Mutex<HashMap<String, Option<Value>>>,
}

static JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

fn ordinary(id: &str) -> bool {
    id.starts_with("ses") && opencode::valid_id(id) && !id.starts_with("ses_cn_schedule_")
}
fn source_id(row: &Value) -> Option<&str> {
    row["fork"]["sessionID"].as_str().or_else(|| row["parentID"].as_str())
}
fn placement(row: &Value, earlier: &Value) -> bool {
    ["id", "projectID", "location", "fork", "parentID"].iter().all(|k| row[*k] == earlier[*k])
        && row["time"]["created"].is_u64()
        && row["time"]["created"] == earlier["time"]["created"]
        && row["metadata"].get("codenomad.schedule-carrier").is_none()
}

struct Place {
    paths: [(PathBuf, String); 2],
    checkout: String,
}

impl Place {
    async fn load(app: &App, workspace: &Workspace, row: &Value) -> Option<Self> {
        if row["metadata"].get("codenomad.schedule-carrier").is_some() {
            return None;
        }
        let dir = directory(row)?;
        let dir = worktrees::ownership::resolve(app, workspace, dir).await?;
        let project = row["projectID"].as_str()?;
        if !worktrees::native_project(app, workspace, project).await.ok()? {
            return None;
        }
        let own = |path: PathBuf| files::host_identity(&path).ok().map(|identity| (path, identity));
        let checkout = fence::identity(&dir.checkout);
        Some(Self { paths: [own(dir.directory.into())?, own(dir.checkout)?], checkout })
    }

    fn current(&self) -> bool {
        self.paths.iter().all(|(path, id)| files::host_identity(path).ok().as_ref() == Some(id))
    }
}

/// Proxy fork responses are already point reads bound to the request's direct source.
pub(crate) async fn observe_fork(
    app: &App,
    endpoint: &Arc<Endpoint>,
    workspace: &Workspace,
    row: &Value,
    source: &Value,
) -> Result<bool, Error> {
    observe(app, endpoint, workspace, row, source, &row["permissions"]).await
}

async fn observe(
    app: &App,
    endpoint: &Arc<Endpoint>,
    workspace: &Workspace,
    child: &Value,
    source: &Value,
    copied: &Value,
) -> Result<bool, Error> {
    let id = child["id"].as_str().filter(|id| ordinary(id)).ok_or_else(unavailable)?;
    let from = source["id"].as_str().filter(|id| ordinary(id)).ok_or_else(unavailable)?;
    let rules = rules::parse(copied).map_err(|_| unavailable())?;
    if id == from
        || source_id(child) != Some(from)
        || child["projectID"] != source["projectID"]
        || !maybe_supervised(&rules)
    {
        return Ok(false);
    }
    let (one, two) = if id < from { (id, from) } else { (from, id) };
    let _locks = (session_lock(one).await, session_lock(two).await);
    let (child_place, source_place) =
        tokio::join!(Place::load(app, workspace, child), Place::load(app, workspace, source));
    let (Some(child_place), Some(source_place)) = (child_place, source_place) else { return Ok(false) };
    let _fence =
        fence::enter(&[child_place.checkout.clone(), source_place.checkout.clone()]).ok_or_else(unavailable)?;
    let (live, direct) = tokio::try_join!(
        opencode::session_record_at(app, endpoint, id),
        opencode::session_record_at(app, endpoint, from)
    )?;
    if !placement(&live, child)
        || !placement(&direct, source)
        || direct["time"]["updated"].as_u64().zip(live["time"]["created"].as_u64()).is_none_or(|(a, b)| a > b)
        || rules::parse(&live["permissions"]).ok().as_ref() != Some(&rules)
        || rules::parse(&direct["permissions"]).ok().as_ref() != Some(&rules)
        || !current(app, endpoint)
        || !workspace_current(app, workspace)
        || !child_place.current()
        || !source_place.current()
    {
        return Ok(false);
    }
    let target_key = key(&live)?;
    let prior = saved(&app.settings, &target_key)?;
    if Blocks::read(prior.as_ref())?.exists() {
        return Ok(true);
    }
    let from = saved(&app.settings, &key(&direct)?)?;
    let parent = Blocks::read(from.as_ref())?;
    let Some(block) = parent.active.filter(|block| {
        parent.pending.is_none()
            && (root(&direct) || from.as_ref().is_some_and(|p| p["child"] == true))
            && rules::positions(&rules, block).count() == 1
    }) else {
        return Ok(false);
    };
    let fork = if !live["fork"].is_null() && owns_root(&direct, from.as_ref()) {
        json!({"copy":from.as_ref().map(|p| &p["fork"]["copy"])})
    } else {
        Value::Null
    };
    remember(&app.settings, &target_key, prior.as_ref(), Some(recorded(&live, &block, None, &fork)))?;
    Ok(true)
}

async fn owner(app: &App, row: &Value) -> Option<(Workspace, Place)> {
    let mut candidates = app.inner.lock().unwrap().workspaces.clone();
    candidates.sort_by_key(|w| directory(row) != w.location["directory"].as_str());
    for w in candidates {
        if let Some(place) = Place::load(app, &w, row).await {
            return Some((w, place));
        }
    }
    None
}

async fn refresh(app: &App, endpoint: &Arc<Endpoint>, row: &Value, live: impl Fn() -> bool + Sync) {
    let Some((w, place)) = owner(app, row).await else { return };
    let Some(_fence) = fence::enter(std::slice::from_ref(&place.checkout)) else { return };
    let _ = refresh_before_send(app, endpoint, row, || live() && workspace_current(app, &w) && place.current()).await;
}

fn records(app: &App, dir: Option<&str>, id: Option<&str>) -> Vec<(String, Value)> {
    app.settings
        .private_state_owner(OWNER)
        .ok()
        .into_iter()
        .flatten()
        .filter(|(digest, raw)| {
            let t = &raw["target"];
            let matches = id.is_none_or(|id| t["id"] == id) && dir.is_none_or(|dir| t["directory"] == dir);
            matches
                && t["distro"].is_null()
                && t["id"].as_str().is_some_and(ordinary)
                && key(&json!({"id":t["id"],"time":{"created":t["created"]}})).is_ok_and(|key| key == *digest)
        })
        .collect()
}

/// Keep permission projections out of the transcript/SSE delivery lane.
impl RefreshQueue {
    pub(crate) fn enqueue(
        self: &Arc<Self>,
        app: &Shared,
        endpoint: &Arc<Endpoint>,
        stream: &tokio_util::sync::CancellationToken,
        event: &Value,
    ) {
        let kind = event["type"].as_str().unwrap_or_default();
        if !matches!(
            kind,
            "server.connected"
                | "config.updated"
                | "session.created"
                | "session.forked"
                | "session.moved"
                | "session.permissions"
                | "session.deleted"
        ) {
            return;
        }
        let data = &event["data"];
        let id = data["sessionID"].as_str().filter(|id| ordinary(id)).map(str::to_owned);
        if kind.starts_with("session.") && id.is_none() {
            return;
        }
        if matches!(kind, "session.created" | "session.forked") && !data["parentID"].as_str().is_some_and(ordinary) {
            return;
        }
        let lane = match id.as_deref() {
            Some(id) if matches!(kind, "session.created" | "session.forked" | "session.deleted") => {
                format!("{kind}:{id}")
            }
            Some(id) => format!("session:{id}"),
            None => format!("config:{}", event["location"]["directory"].as_str().unwrap_or_default()),
        };
        {
            let mut pending = self.pending.lock().unwrap();
            if let Some(trailing) = pending.get_mut(&lane) {
                *trailing = Some(event.clone());
                return;
            }
            if pending.len() >= 256 {
                return;
            }
            pending.insert(lane.clone(), None);
        }
        let (app, endpoint, stream, event) = (app.clone(), endpoint.clone(), stream.clone(), event.clone());
        let queue = self.clone();
        tokio::spawn(async move {
            let mut event = event;
            loop {
                tokio::select! {
                    biased;
                    _ = stream.cancelled() => {
                        queue.pending.lock().unwrap().remove(&lane);
                        return;
                    }
                    Ok(_slot) = JOBS.acquire() => {
                        let _ = tokio::time::timeout(Duration::from_secs(90), process(&app, &endpoint, &stream, &event)).await;
                    }
                }
                let mut pending = queue.pending.lock().unwrap();
                let Some(next) = pending.get_mut(&lane).and_then(Option::take) else {
                    pending.remove(&lane);
                    return;
                };
                event = next;
            }
        });
    }
}

async fn process(app: &Shared, endpoint: &Arc<Endpoint>, stream: &tokio_util::sync::CancellationToken, event: &Value) {
    let kind = event["type"].as_str().unwrap_or_default();
    let created = &event["created"];
    let data = &event["data"];
    let dir = event["location"]["directory"].as_str();
    let id = data["sessionID"].as_str();
    let live = || !stream.is_cancelled() && current(app, endpoint);
    if !live() {
        return;
    }
    if matches!(kind, "server.connected" | "config.updated") {
        for (_, row) in records(&app, dir, None) {
            if !live() {
                return;
            }
            let t = &row["target"];
            let session = opencode::session_record_at(&app, &endpoint, t["id"].as_str().unwrap()).await;
            if let Ok(session) = session
                && session["time"]["created"] == t["created"]
            {
                refresh(&app, &endpoint, &session, live).await;
            }
        }
        return;
    }
    let Some(id) = id else { return };
    if kind == "session.deleted" {
        let _lock = session_lock(id).await;
        for (key, raw) in records(&app, None, Some(id)) {
            if live()
                && opencode::session_record_at(&app, &endpoint, id)
                    .await
                    .is_err_and(|(status, _)| status == axum::http::StatusCode::NOT_FOUND)
                && live()
            {
                let _ = remember(&app.settings, &key, Some(&raw), None);
            }
        }
        return;
    }
    if !matches!(kind, "session.created" | "session.forked") && records(&app, None, Some(id)).is_empty() {
        return;
    }
    let Ok(row) = opencode::session_record_at(&app, &endpoint, id).await else { return };
    if matches!(kind, "session.created" | "session.forked") {
        let from = data["parentID"].as_str().unwrap_or_default();
        if &row["time"]["created"] != created
            || source_id(&row) != Some(from)
            || kind == "session.created"
                && (root(&row) || row["projectID"] != data["projectID"] || row["location"] != data["location"])
        {
            return;
        }
        let Ok(source) = opencode::session_record_at(&app, &endpoint, from).await else { return };
        let Some((w, _)) = owner(&app, &row).await else { return };
        let rules = if kind == "session.created" { &data["permissions"] } else { &row["permissions"] };
        if !live() || !observe(&app, &endpoint, &w, &row, &source, rules).await.unwrap_or(false) {
            return;
        }
    }
    refresh(&app, &endpoint, &row, live).await;
}
