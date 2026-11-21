//! Pending questions and permissions of a workspace, from the native pending-requests plugin.
use axum::{
    Extension, Json,
    extract::{Path as Route, RawQuery, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::Ordering::Relaxed,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

use crate::{
    App, Error, Shared, Workspace, error, unavailable,
    worktrees::{fence, ownership},
};

/// `PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS` and `READINESS_WAIT_MS` of the reference.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_WAIT: Duration = Duration::from_secs(5);
pub const SESSION_PRUNING_PLUGIN: &str = "codenomad-session-pruning";

pub enum PluginWait {
    TimedOut,
    Failed,
}
/// Reference `awaitNativePlugin`: prepares only a caller-authorized Location
/// by polling the native plugin catalogue until the plugin is active, within
/// the 5 s readiness wait and the caller's deadline.
pub async fn await_plugin(
    app: &crate::App,
    plugin: &str,
    directory: &str,
    deadline: tokio::time::Instant,
) -> Result<(), PluginWait> {
    let ready = tokio::time::Instant::now() + READINESS_WAIT;
    loop {
        let left = ready.min(deadline).saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err(PluginWait::TimedOut);
        }
        let listed =
            app.native.get("/api/plugin").query(&[("location[directory]", directory)]).timeout(left).send().await;
        let catalogue: Value = match listed {
            Err(e) if e.is_timeout() => return Err(PluginWait::TimedOut),
            Err(_) => return Err(PluginWait::Failed),
            Ok(r) if !r.status().is_success() => return Err(PluginWait::Failed),
            Ok(r) => crate::opencode::read_json(r, 1024 * 1024).await.map_err(|_| PluginWait::Failed)?,
        };
        if catalogue["location"]["directory"] != directory {
            return Err(PluginWait::Failed);
        }
        let state = catalogue["data"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == plugin))
            .map(|p| p["state"]["status"].clone());
        match state.as_ref().and_then(Value::as_str) {
            Some("active") => return Ok(()),
            Some("failed") => return Err(PluginWait::Failed),
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// Where one submitted directory stands before the native read (`pending-requests.ts`).
enum Candidate {
    /// Owned: its service directory, deletion-fence key and, off the root, its Git common directory.
    Owned {
        directory: String,
        fence: String,
        common: Option<PathBuf>,
    },
    /// Optional history whose host directory is absent, owned by `fence` (its own or an ancestor's).
    Missing {
        directory: Option<String>,
        fence: String,
        ancestor: bool,
    },
    /// Optional history proven outside the project.
    Outside {
        proof: String,
    },
    Error(&'static str),
}

/// `missingHost`: only a path that does not exist at all.
fn missing(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
}
fn real(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

struct Batch<'a> {
    app: &'a App,
    workspace: &'a Workspace,
    root: String,
    common: tokio::sync::OnceCell<Option<PathBuf>>,
}
impl Batch<'_> {
    async fn workspace_common(&self) -> Option<PathBuf> {
        self.common.get_or_init(|| ownership::common_directory(&self.workspace.path)).await.clone()
    }
    /// `outsideHistory`: an absent direct child of a canonical folder outside the checkout,
    /// or an existing folder of another repository.
    async fn outside(&self, candidate: &str) -> Result<Option<String>, ()> {
        if !crate::files::paths::local_absolute(candidate) {
            return Ok(None);
        }
        if missing(candidate) {
            let root = real(&self.workspace.path).ok_or(())?;
            if ownership::within(&root, Path::new(candidate)) {
                return Ok(None);
            }
            let parent = Path::new(candidate).parent().ok_or(())?;
            return Ok((real(parent).as_deref() == Some(parent))
                .then(|| format!("missing\0{candidate}\0{}", parent.display())));
        }
        let common = ownership::common_directory(Path::new(candidate)).await.ok_or(())?;
        if Some(&common) == self.workspace_common().await.as_ref() {
            return Ok(None);
        }
        Ok(Some(format!("foreign\0{}\0{}", real(Path::new(candidate)).ok_or(())?.display(), common.display())))
    }
    /// `ownedMissingAncestor`: the nearest existing ancestor, owned canonically and of this repository.
    async fn owned_ancestor(&self, candidate: &str) -> Option<String> {
        let mut ancestor = PathBuf::from(candidate);
        for _ in 0..64 {
            if !missing(&ancestor.to_string_lossy()) {
                let owned = ownership::resolve(self.app, self.workspace, &ancestor.to_string_lossy()).await?;
                let fence = fence::identity(&owned.checkout);
                let common = self.workspace_common().await?;
                if fence::is_blocked(&fence)
                    || !real(&ancestor).is_some_and(|dir| Some(dir) == real(Path::new(&owned.directory)))
                    || ownership::common_directory(&ancestor).await.as_ref() != Some(&common)
                {
                    return None;
                }
                return Some(fence);
            }
            ancestor = ancestor.parent()?.to_path_buf();
        }
        None
    }
    async fn classify(&self, candidate: &str, optional: bool) -> Candidate {
        if !crate::files::paths::local_absolute(candidate) {
            return Candidate::Error(if optional { "unverified" } else { "not-owned" });
        }
        let Some(owned) = ownership::resolve(self.app, self.workspace, candidate).await else {
            if !optional {
                return Candidate::Error("not-owned");
            }
            let ancestor = if Path::new(candidate).is_absolute() && missing(candidate) {
                self.owned_ancestor(candidate).await
            } else {
                None
            };
            return match ancestor {
                Some(fence) => Candidate::Missing { directory: None, fence, ancestor: true },
                None => match self.outside(candidate).await {
                    Ok(Some(proof)) => Candidate::Outside { proof },
                    Ok(None) if !missing(candidate) => Candidate::Error("not-owned"),
                    _ => Candidate::Error("unverified"),
                },
            };
        };
        let fence = fence::identity(&owned.checkout);
        if fence::is_blocked(&fence) {
            return Candidate::Error("deleting");
        }
        let root = owned.directory == self.root;
        if !root && missing(&owned.directory) {
            return match optional {
                true => Candidate::Missing { directory: Some(owned.directory), fence, ancestor: false },
                false => Candidate::Error("missing"),
            };
        }
        let common = if root { None } else { ownership::common_directory(Path::new(&owned.directory)).await };
        if !root && common.is_none() {
            return Candidate::Error("unverified");
        }
        Candidate::Owned { directory: owned.directory, fence, common }
    }
    /// `revalidateCandidates`: each admitted or excluded directory still stands as it was read.
    async fn still(&self, submitted: &str, candidate: &Candidate) -> bool {
        let owned = || ownership::resolve(self.app, self.workspace, submitted);
        match candidate {
            Candidate::Owned { directory, fence, common } => {
                !fence::is_blocked(fence)
                    && owned()
                        .await
                        .is_some_and(|o| &o.directory == directory && fence::identity(&o.checkout) == *fence)
                    && (*directory == self.root || ownership::common_directory(Path::new(directory)).await == *common)
            }
            Candidate::Missing { directory, fence, ancestor } => {
                !fence::is_blocked(fence)
                    && match (owned().await, directory) {
                        (None, None) => true,
                        (Some(o), Some(d)) => &o.directory == d && fence::identity(&o.checkout) == *fence,
                        _ => false,
                    }
                    && missing(directory.as_deref().unwrap_or(submitted))
                    && (!ancestor || self.owned_ancestor(submitted).await.as_ref() == Some(fence))
            }
            Candidate::Outside { proof } => {
                owned().await.is_none() && self.outside(submitted).await.ok().flatten().as_ref() == Some(proof)
            }
            Candidate::Error(_) => true,
        }
    }
    fn deleting(candidate: &Candidate) -> bool {
        Self::fence(candidate).is_some_and(fence::is_blocked)
    }
    fn fence(candidate: &Candidate) -> Option<&str> {
        match candidate {
            Candidate::Owned { fence, .. } | Candidate::Missing { fence, .. } => Some(fence),
            _ => None,
        }
    }
}

enum Refusal {
    Unavailable,
    Timeout,
}
fn refused(kind: Refusal) -> Error {
    let body = match kind {
        Refusal::Unavailable => json!({"error": "Pending requests unavailable; retain existing queues"}),
        Refusal::Timeout => json!({"error": "Pending requests unavailable; retain existing queues", "code": "timeout"}),
    };
    (Status::SERVICE_UNAVAILABLE, Json(body))
}

/// `GET /api/workspaces/:id/pending-requests?directories=…[&optionalDirectories=…]`: the pending
/// permissions and Forms of each owned directory, through the pruning plugin's snapshot RPC.
pub async fn snapshot(
    State(app): State<Shared>,
    Route(id): Route<String>,
    RawQuery(query): RawQuery,
    Extension(shutdown): Extension<CancellationToken>,
) -> Response {
    // A read waiting for plugin readiness outlives the desktop host's shutdown grace.
    let mut response = tokio::select! {
        biased;
        _ = shutdown.cancelled() => Err(error(Status::SERVICE_UNAVAILABLE, "Server is shutting down")),
        result = snapshot_response(app, id, query) => result,
    }
    .into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    response
}

async fn snapshot_response(app: Shared, id: String, query: Option<String>) -> Result<Response, Error> {
    let mut parsed = app.native.url();
    parsed.set_query(query.as_deref());
    let items: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
    let list = |key: &str| items.iter().filter(|(k, _)| k == key).map(|(_, v)| v.clone()).collect::<Vec<_>>();
    let (directories, optional) = (list("directories"), list("optionalDirectories"));
    if directories.is_empty()
        || directories.len() > 64
        || optional.len() > 64
        || items.iter().any(|(k, v)| {
            !matches!(k.as_str(), "directories" | "optionalDirectories") || !(1..=4096).contains(&v.chars().count())
        })
    {
        return Err(error(Status::BAD_REQUEST, "Invalid pending request directories"));
    }
    let workspace = app.workspace(&id)?;
    let mut submitted: Vec<String> = Vec::new();
    for d in directories {
        if !submitted.contains(&d) {
            submitted.push(d);
        }
    }
    if optional.iter().any(|d| !submitted.contains(d)) {
        return Err(error(Status::BAD_REQUEST, "Invalid optional pending request directories"));
    }
    if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
        return Ok(unavailable());
    }
    let deadline = tokio::time::Instant::now() + SNAPSHOT_TIMEOUT;
    match tokio::time::timeout_at(deadline, read(&app, &id, &workspace, &submitted, &optional, deadline)).await {
        Ok(Ok(body)) => Ok(Json(body).into_response()),
        Ok(Err(Ok(response))) => Ok(response),
        Ok(Err(Err(kind))) => Err(refused(kind)),
        Err(_) => Err(refused(Refusal::Timeout)),
    }
}

/// The checked read; `Err(Ok)` is a refusal with its own body, `Err(Err)` a 503.
async fn read(
    app: &App,
    id: &str,
    workspace: &Workspace,
    submitted: &[String],
    optional: &[String],
    deadline: tokio::time::Instant,
) -> Result<Value, Result<Response, Refusal>> {
    let bootstrap = workspace.location["directory"].as_str().ok_or(Err(Refusal::Unavailable))?.to_owned();
    let placement = same_file::Handle::from_path(&workspace.path).map_err(|_| Err(Refusal::Unavailable))?;
    let root =
        ownership::resolve(app, workspace, &workspace.path.to_string_lossy()).await.ok_or(Err(Refusal::Unavailable))?;
    let root_fence = fence::identity(&root.checkout);
    let root_display = fence::capture_display(&root_fence);
    let batch = Batch { app, workspace, root: root.directory.clone(), common: Default::default() };
    if !Path::new(&bootstrap).is_absolute()
        || ownership::resolve(app, workspace, &bootstrap).await.map(|o| o.directory) != Some(root.directory.clone())
    {
        return Err(Err(Refusal::Unavailable));
    }
    let endpoint = app.native.endpoint().ok_or(Err(Refusal::Unavailable))?;
    let current = || {
        if !app.native.endpoint().is_some_and(|now| std::sync::Arc::ptr_eq(&now, &endpoint)) {
            return false;
        }
        app.workspace(id).is_ok_and(|w| {
            w.id == workspace.id
                && w.path == workspace.path
                && w.location["directory"] == bootstrap.as_str()
                && same_file::Handle::from_path(&w.path).is_ok_and(|h| h == placement)
        }) && root_display.load(Relaxed)
            && !fence::is_blocked(&root_fence)
    };
    if !current() {
        return Err(Err(Refusal::Unavailable));
    }
    let mut candidates = Vec::new();
    for directory in submitted {
        candidates.push((directory.clone(), batch.classify(directory, optional.contains(directory)).await));
    }
    let displays: Vec<_> = candidates.iter().map(|(_, c)| Batch::fence(c).map(fence::capture_display)).collect();
    let mut reported: Vec<Value> = Vec::new();
    for (directory, candidate) in &candidates {
        match candidate {
            Candidate::Error(reason) => {
                reported.push(json!({"directory": directory, "status": "error", "reason": reason}))
            }
            Candidate::Missing { .. } | Candidate::Outside { .. } => {
                reported.push(json!({"directory": directory, "status": "excluded"}))
            }
            Candidate::Owned { .. } => {}
        }
    }
    let resolved: Vec<&(String, Candidate)> =
        candidates.iter().filter(|(_, c)| matches!(c, Candidate::Owned { .. })).collect();
    let forbidden = |directories: Vec<Value>| {
        Err(Ok((
            Status::FORBIDDEN,
            Json(json!({"error": "Directory does not belong to workspace", "directories": directories})),
        )
            .into_response()))
    };
    if resolved.is_empty() && reported.iter().any(|d| d["status"] != "excluded") {
        return forbidden(reported);
    }
    if !current() {
        return Err(Err(Refusal::Unavailable));
    }
    match await_plugin(app, SESSION_PRUNING_PLUGIN, &bootstrap, deadline).await {
        Ok(()) => {}
        Err(PluginWait::TimedOut) => return Err(Err(Refusal::Timeout)),
        Err(PluginWait::Failed) => return Err(Err(Refusal::Unavailable)),
    }
    let revalidate = || async {
        let mut failed: Vec<(String, &'static str)> = Vec::new();
        for ((directory, candidate), display) in candidates.iter().zip(&displays) {
            let still = batch.still(directory, candidate).await;
            let deleting = Batch::deleting(candidate) || display.as_ref().is_some_and(|live| !live.load(Relaxed));
            if !still || deleting {
                failed.push((directory.clone(), if deleting { "deleting" } else { "changed" }));
            }
        }
        failed
    };
    let failed = revalidate().await;
    if !current() {
        return Err(Err(Refusal::Unavailable));
    }
    let admitted: Vec<&String> = resolved
        .iter()
        .filter(|(d, _)| !failed.iter().any(|(f, _)| f == d))
        .map(|(_, c)| match c {
            Candidate::Owned { directory, .. } => directory,
            _ => unreachable!(),
        })
        .collect();
    let with_failures = |reported: &[Value], failed: &[(String, &str)]| {
        let mut out: Vec<Value> =
            reported.iter().filter(|d| !failed.iter().any(|(f, _)| d["directory"] == f.as_str())).cloned().collect();
        out.extend(failed.iter().map(|(d, reason)| json!({"directory": d, "status": "error", "reason": reason})));
        out
    };
    if admitted.is_empty() && !failed.is_empty() {
        return forbidden(with_failures(&reported, &failed));
    }
    let mut expected: Vec<String> = Vec::new();
    for directory in if admitted.is_empty() { vec![&root.directory] } else { admitted } {
        if !expected.contains(directory) {
            expected.push(directory.clone());
        }
    }
    let response = app
        .native
        .rpc("codenomad.pending-requests/snapshot", &bootstrap, &json!({"directories": expected}))
        .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
        .send()
        .await
        .map_err(|e| Err(if e.is_timeout() { Refusal::Timeout } else { Refusal::Unavailable }))?;
    let status = response.status();
    if !current() {
        return Err(Err(Refusal::Unavailable));
    }
    if status == Status::BAD_REQUEST {
        let data: Option<Value> = response.json().await.ok();
        data.filter(|d| crate::opencode::native_rpc_absent(d, status)).ok_or(Err(Refusal::Unavailable))?;
        revalidate().await;
        if !current() || !crate::worktrees::exact_root_supported(app, workspace).await.unwrap_or(false) {
            return Err(Err(Refusal::Unavailable));
        }
        return Ok(json!({"supported": false}));
    }
    if !status.is_success() {
        return Err(Err(Refusal::Unavailable));
    }
    let body = crate::opencode::read_json(response, 4 * 1024 * 1024)
        .await
        .ok()
        .filter(crate::sessions::history::pending_valid)
        .ok_or(Err(Refusal::Unavailable))?;
    let native = &body["output"];
    let data = native["data"].as_array().ok_or(Err(Refusal::Unavailable))?;
    let covered: Vec<&str> = data.iter().filter_map(|e| e["directory"].as_str()).collect();
    let mut distinct = covered.clone();
    distinct.sort();
    distinct.dedup();
    if covered.len() != expected.len()
        || distinct.len() != expected.len()
        || covered.iter().any(|d| !expected.iter().any(|e| e == d))
        || data.iter().map(|e| e["locations"].as_array().map_or(0, Vec::len)).sum::<usize>() > 64
    {
        return Err(Err(Refusal::Unavailable));
    }
    let mut placement_failed: Vec<(String, &'static str)> = Vec::new();
    let mut ok: Vec<Value> = Vec::new();
    for entry in data {
        let directory = entry["directory"].as_str().unwrap_or_default();
        let snapshots = entry["locations"].as_array().ok_or(Err(Refusal::Unavailable))?;
        let mut seen: Vec<&Value> = snapshots.iter().map(|s| &s["location"]["directory"]).collect();
        seen.sort_by_key(|v| v.to_string());
        seen.dedup();
        let count = |key: &str| snapshots.iter().map(|s| s[key].as_array().map_or(0, Vec::len)).sum::<usize>();
        if seen.len() != snapshots.len() || count("permissions") > 1024 || count("forms") > 1024 {
            return Err(Err(Refusal::Unavailable));
        }
        let mut locations = Vec::new();
        let mut rejected = None;
        for snapshot in snapshots {
            let at = snapshot["location"]["directory"].as_str().unwrap_or_default();
            let owned = snapshot["location"].get("workspaceID").is_none()
                && Path::new(at).is_absolute()
                && ownership::resolve(app, workspace, at).await.is_some_and(|o| o.directory == directory);
            if !owned {
                rejected = Some("not-owned");
                break;
            }
            locations.push(json!({"location": {"directory": at}, "permissions": snapshot["permissions"], "forms": snapshot["forms"]}));
        }
        if locations.is_empty() && rejected.is_none() {
            locations.push(json!({"location": {"directory": directory}, "permissions": [], "forms": []}));
        }
        for (submitted, candidate) in &resolved {
            if matches!(candidate, Candidate::Owned { directory: d, .. } if d == directory) {
                match rejected {
                    Some(reason) => placement_failed.push((submitted.clone(), reason)),
                    None => ok.push(json!({"directory": submitted, "status": "ok", "locations": locations})),
                }
            }
        }
    }
    let origin = native["originDirectory"].as_str().unwrap_or_default();
    if !Path::new(origin).is_absolute()
        || ownership::resolve(app, workspace, origin).await.map(|o| o.directory) != Some(root.directory.clone())
    {
        return Err(Err(Refusal::Unavailable));
    }
    let mut failed = revalidate().await;
    if !current() {
        return Err(Err(Refusal::Unavailable));
    }
    for (directory, reason) in placement_failed {
        if !failed.iter().any(|(f, _)| *f == directory) {
            failed.push((directory, reason));
        }
    }
    reported.extend(ok);
    Ok(json!({"supported": true, "directories": with_failures(&reported, &failed)}))
}
