//! Session placement capture, directory identity verification, and plugin readiness checks.
use crate::{App, Error, Shared, error};
use axum::http::StatusCode as Status;
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    time::Duration,
};
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

pub(in crate::sessions) struct Placement {
    workspace: crate::Workspace,
    pub(in crate::sessions) endpoint: Arc<crate::opencode::Endpoint>,
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

    pub(in crate::sessions) async fn capture_for_media(app: &Shared, id: &str, session: &str) -> Result<Self, Error> {
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

    pub(super) async fn current(&self, app: &App, id: &str, session: &str) -> Recheck {
        match self.latest(app, id, session).await {
            Ok(newest) if newest.get("revert") == self.source.get("revert") => Recheck::Current,
            Ok(_) => Recheck::Conflict,
            Err((Status::CONFLICT, _)) => Recheck::Conflict,
            Err(_) => Recheck::Unavailable,
        }
    }

    pub(super) fn operation_current_fast(&self, app: &App, id: &str) -> bool {
        app.native.current(&self.endpoint)
            && app.workspace(id).is_ok_and(|w| w.id == self.workspace.id && w.path == self.workspace.path)
            && self.displays.iter().all(|display| display.load(Relaxed))
    }

    pub(in crate::sessions) async fn operation_current(&self, app: &App, id: &str) -> bool {
        self.operation_current_fast(app, id)
            && same_identity_async(self.workspace.path.clone(), self.workspace_physical.clone()).await
            && self.operation_current_fast(app, id)
    }

    pub(in crate::sessions) async fn latest(&self, app: &App, id: &str, session: &str) -> Result<Value, Error> {
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

    pub(in crate::sessions) async fn live(&self, app: &App, id: &str) -> bool {
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
            .is_some_and(|fresh| self.checkout.same_checkout(&fresh))
        } else {
            false
        };
        owned_ok && self.operation_current_fast(app, id) && self.displays.iter().all(|display| display.load(Relaxed))
    }

    pub(super) async fn ready(&self, app: &Shared, id: &str, session: &str) -> Result<&str, Recheck> {
        let directory = self.source["location"]["directory"].as_str().ok_or(Recheck::Unavailable)?;
        // Share a single 5 s readiness budget across plugin catalogue activation and presence
        // challenge, matching TS `desktop-plugin-lifecycle.ts:135-154`. Provisioning already ran
        // once on connection acquisition (`Placement::capture`); do not re-provision here.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        // Check that this exact captured endpoint already owns the active pruning readiness lease
        // BEFORE polling `/api/plugin` (matching TS `desktop-plugin-lifecycle.ts:147-154`).
        if !crate::extensions::lifecycle::has_ready_lease(app, &self.endpoint) {
            return Err(Recheck::Unavailable);
        }
        let still_valid =
            || self.operation_current_fast(app, id) && self.displays.iter().all(|display| display.load(Relaxed));
        let url = self.endpoint.url.join("/api/plugin").map_err(|_| Recheck::Unavailable)?;
        crate::sessions::pending::await_plugin_with(
            crate::sessions::pending::SESSION_PRUNING_PLUGIN,
            directory,
            deadline,
            || {
                still_valid()
                    .then(|| app.native.client.get(url.clone()).basic_auth("opencode", Some(&self.endpoint.password)))
            },
        )
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
pub(super) enum Recheck {
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

pub(in crate::sessions) async fn prepare(
    app: &Shared,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
    deadline: tokio::time::Instant,
    still_valid: impl Fn() -> bool,
) -> Option<()> {
    if !still_valid() || !crate::extensions::lifecycle::has_ready_lease(app, endpoint) {
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
