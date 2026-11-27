//! The checkouts a workspace owns: its folder and linked worktrees (`inventory`,
//! `linked`), location ownership (`ownership`) and the deletion fence (`fence`).
pub mod fence;
#[cfg(test)]
pub(crate) mod fence_test_trace;
mod inventory;
pub mod linked;
pub mod ownership;

pub(crate) use inventory::precheck_git_layout_in_scope;

pub(crate) fn inventory_revision(app: &App) -> u64 {
    inventory::revision(app)
}

pub(crate) fn event_inventory_revision(app: &App, workspace_id: uuid::Uuid) -> (u64, u64) {
    inventory::event_revision(app, workspace_id)
}

pub fn routes() -> axum::Router<Shared> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route("/api/workspaces/{id}/worktrees", get(list).post(linked::create))
        .route("/api/workspaces/{id}/worktrees/{slug}", delete(linked::remove))
        .route("/api/workspaces/{id}/sessions/{session}/worktree", post(linked::place))
}

use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::io::ErrorKind;

use crate::{App, Error, Shared, Workspace, error};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    fresh: Option<String>,
}

pub(super) fn probe_error() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Git ownership could not be verified")
}

pub async fn root_only(workspace: &Workspace) -> Result<Option<bool>, Error> {
    root_only_with_slot(workspace, None).await
}

pub(crate) async fn root_only_with_slot(
    workspace: &Workspace,
    slot: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Result<Option<bool>, Error> {
    let path = workspace.path.clone();
    let canonical_ok = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        dunce::canonicalize(&path).ok().as_ref() == Some(&path)
    })
    .await
    .unwrap_or(false);
    if !canonical_ok {
        crate::bench::route_trace(format_args!("root-proof canonical path changed"));
        return Err(probe_error());
    }
    match crate::git::run(&workspace.path, &["rev-parse", "--show-toplevel"], 16 * 1024).await {
        Ok(output) if output.code == 0 => Ok(None),
        Ok(output) if output.not_a_repository() => Ok(Some(true)),
        Err(err) if crate::git::is_missing_git(&err) => Ok(Some(false)),
        Ok(output) => {
            crate::bench::route_trace(format_args!("root-proof git exited {}", output.code));
            Err(probe_error())
        }
        Err(_) => {
            crate::bench::route_trace(format_args!("root-proof git failed"));
            Err(probe_error())
        }
    }
}

/// Strict non-Git verification for `session-media` subfolder authorization (TS
/// `checkout-identity.ts:3-77`, `worktree-directory.ts:248-262`): refuses to conclude non-Git when
/// Git discovery is overridden by the environment or when any `.git`/`HEAD`/`commondir` marker
/// exists on `workspace.path` or its ancestors up to a device boundary.
pub(super) async fn strict_non_git_workspace(workspace: &Workspace) -> Result<bool, Error> {
    const DISCOVERY_ENV: &[&str] = &[
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_OBJECT_DIRECTORY",
    ];
    if DISCOVERY_ENV.iter().any(|k| std::env::var_os(k).is_some()) {
        return Err(probe_error());
    }
    let ws_path = workspace.path.clone();
    let has_residual_git = tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let root_dev = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&ws_path).ok().map(|m| m.dev())
        };
        let mut cur = ws_path.as_path();
        loop {
            if cur.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".git")) {
                return true;
            }
            for marker in [".git", "HEAD", "commondir"] {
                match std::fs::symlink_metadata(cur.join(marker)) {
                    Err(e) if e.kind() == ErrorKind::NotFound => {}
                    _ => return true,
                }
            }
            let Some(parent) = cur.parent() else { return false };
            if parent == cur {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if let Some(dev) = root_dev
                    && std::fs::metadata(parent).ok().map(|m| m.dev()) != Some(dev)
                {
                    return false;
                }
            }
            cur = parent;
        }
    })
    .await
    .unwrap_or(true);
    if has_residual_git { Err(probe_error()) } else { Ok(true) }
}

pub async fn exact_root_supported(app: &App, workspace: &Workspace) -> Result<bool, Error> {
    match inventory::probe_root_checkout(&app.scope, workspace).await? {
        inventory::RootCheckout::NonGit | inventory::RootCheckout::MissingGit => Ok(true),
        inventory::RootCheckout::FallbackNonGit => Err(probe_error()),
        inventory::RootCheckout::Git(Err(_)) => Ok(false),
        inventory::RootCheckout::Git(Ok(local)) => Ok(inventory::root_supported_with(app, workspace, *local).await),
    }
}

pub async fn native_project(app: &App, workspace: &Workspace, project: &str) -> Result<bool, Error> {
    if !crate::opencode::valid_id(project) || project == "global" {
        return Ok(false);
    }
    let hit = match inventory::http_read(app, workspace, inventory::ReadMode::Validated).await {
        Ok(hit) => hit,
        Err(_) => return Ok(false),
    };
    let check_live = |cat: &std::sync::Arc<linked::Catalogue>, path: &std::path::Path| {
        let cat = std::sync::Arc::clone(cat);
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || cat.root_live_for(&path))
    };
    if let inventory::HttpSnapshot::Git(cat) = hit.snapshot {
        let live = !hit.from_cache || check_live(&cat, &workspace.path).await.unwrap_or(false);
        if live {
            if cat.project == project {
                return Ok(true);
            }
            if !hit.from_cache || hit.refreshed_on_miss {
                return Ok(false);
            }
        }
        let retry_mode =
            if live { inventory::ReadMode::RefreshOnMiss(hit.generation) } else { inventory::ReadMode::Fresh };
        let refreshed = match inventory::http_read(app, workspace, retry_mode).await {
            Ok(res) => res,
            Err(_) => return Ok(false),
        };
        return Ok(refreshed.snapshot.catalogue().is_some_and(|c| c.project == project));
    }
    Ok(false)
}

pub async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    query: Result<Query<Input>, QueryRejection>,
) -> Result<Response, Error> {
    let Query(input) = query.map_err(|_| error(Status::BAD_REQUEST, "Invalid worktree query"))?;
    if input.fresh.as_deref().is_some_and(|v| !matches!(v, "true" | "false")) {
        return Err(error(Status::BAD_REQUEST, "Invalid worktree query"));
    }
    let workspace = app.workspace(&id)?;
    let mode =
        if input.fresh.as_deref() == Some("true") { inventory::ReadMode::Fresh } else { inventory::ReadMode::Cached };
    let git = match inventory::http_list(&app, &workspace, mode).await? {
        inventory::HttpSnapshot::Git(catalogue) => return Ok(Json(catalogue.response()).into_response()),
        inventory::HttpSnapshot::NonGit => true,
        inventory::HttpSnapshot::MissingGit => false,
    };
    app.workspace(&id)?;
    let mut root = json!({"slug":"root","kind":"root","directory":workspace.path,"serviceDirectory":workspace.location["directory"]});
    Ok(Json(if git {
        json!({"isGitRepo":false,"worktrees":[root]})
    } else {
        root["directoryOnly"] = json!(true);
        json!({"gitAvailable":false,"worktrees":[root]})
    })
    .into_response())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventOwnership {
    Owned,
    NotOwned,
    Unavailable,
}

/// Event routing ownership check distinguishing a proven non-owner (`NotOwned`) from a
/// transiently unreadable root probe or worktree inventory (`Unavailable`), matching TS
/// `instance-events.ts:298-315`.
pub async fn event_ownership(
    app: &Shared,
    w: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    directory: &str,
) -> EventOwnership {
    let scope = app.scope.clone();
    let dir = directory.to_owned();
    let path = match tokio::task::spawn_blocking(move || ownership::resolve_media_path_checked(&scope, &dir)).await {
        Ok(Ok(Some((path, _anchor)))) => path,
        Ok(Ok(None)) => return EventOwnership::NotOwned,
        Ok(Err(())) | Err(_) => return EventOwnership::Unavailable,
    };
    if path == w.path {
        return EventOwnership::Owned;
    }
    let external = !path.starts_with(&w.path);
    match root_only(w).await {
        Ok(Some(true)) => return if external { EventOwnership::NotOwned } else { EventOwnership::Owned },
        Ok(Some(false)) => return EventOwnership::NotOwned,
        Err(_) => return EventOwnership::Unavailable,
        Ok(None) => {}
    }
    let Some(catalogue) = crate::worktrees::linked::event_catalogue_at(app, w, endpoint).await else {
        return EventOwnership::Unavailable;
    };
    if ownership::catalogue_owns_event(catalogue, path, external).await {
        EventOwnership::Owned
    } else {
        EventOwnership::NotOwned
    }
}

#[derive(Clone)]
pub struct VerifiedPlacement {
    pub slug: String,
    tree: Option<linked::Tree>,
}

impl VerifiedPlacement {
    /// Re-verifies live ownership of `directory` against the already-validated checkout
    /// (`owns()` parity without repeating `catalogue()`).
    pub fn owns_now(&self, scope: &std::path::Path, w: &Workspace, directory: &str) -> bool {
        if w.location["directory"] == directory && dunce::canonicalize(directory).ok().as_ref() == Some(&w.path) {
            return true;
        }
        let Some(tree) = &self.tree else { return false };
        let Some(path) = crate::files::paths::canonical(scope, directory) else { return false };
        path.starts_with(scope) && tree.owns_path(&path)
    }
}

/// Owned session location with its list slug (TS `resolveLocationPlacement`).
/// `Err(true)` only when a fresh read proves another owner; an unreadable
/// path or inventory is `Err(false)`, which denies without claiming departure.
pub async fn placement(app: &App, w: &Workspace, location: &serde_json::Value) -> Result<String, bool> {
    placement_verified(app, w, location).await.map(|p| p.slug)
}

pub async fn placement_verified(
    app: &App,
    w: &Workspace,
    location: &serde_json::Value,
) -> Result<VerifiedPlacement, bool> {
    let Some(directory) = location["directory"].as_str() else { return Err(false) };
    if location.get("workspaceID").is_some() {
        return Err(true);
    }
    // Outside the root stays a possible departure (reference parity); a
    // network or device path is never opened.
    if !crate::files::paths::local_absolute(directory) {
        return Err(false);
    }
    let dir_owned = directory.to_owned();
    let Ok(path) = tokio::task::spawn_blocking(move || dunce::canonicalize(&dir_owned)).await.map_err(|_| false)?
    else {
        return Err(false);
    };
    if w.location["directory"] == directory && path == w.path {
        return Ok(VerifiedPlacement { slug: "root".into(), tree: None });
    }
    let owned = if path.starts_with(&app.scope) {
        match lookup_owned_tree(app, w, directory).await {
            Ok(tree) => tree,
            // Without a Git catalogue only the opened folder is authority, and
            // the reference's strict read reaches no verdict elsewhere.
            Err(()) => return Err(false),
        }
    } else {
        None
    };
    if let Some(tree) = owned {
        return Ok(VerifiedPlacement { slug: tree.slug.clone(), tree: Some(tree) });
    }
    // The reference owns subfolders of the opened checkout (closed here), and
    // its strict read fails rather than refuses for a non-Git folder.
    Err(!path.starts_with(&w.path) && crate::worktrees::linked::readable_checkout(&path).await)
}

async fn lookup_owned_tree(app: &App, w: &Workspace, directory: &str) -> Result<Option<linked::Tree>, ()> {
    let hit = inventory::http_read(app, w, inventory::ReadMode::Validated).await.map_err(|_| ())?;
    let Some(cat) = hit.snapshot.catalogue() else {
        return Err(());
    };
    let (found, root_live) = {
        let cat = std::sync::Arc::clone(&cat);
        let dir = directory.to_owned();
        let opened = w.path.clone();
        let check_root = hit.from_cache;
        tokio::task::spawn_blocking(move || {
            let live = !check_root || cat.root_live_for(&opened);
            let tree = if live { cat.by_directory(&dir).cloned() } else { None };
            (tree, live)
        })
        .await
        .unwrap_or((None, false))
    };
    if found.is_some() {
        return Ok(found);
    }
    if hit.from_cache && (!root_live || !hit.refreshed_on_miss) {
        let retry_mode =
            if root_live { inventory::ReadMode::RefreshOnMiss(hit.generation) } else { inventory::ReadMode::Fresh };
        let fresh = inventory::http_read(app, w, retry_mode).await.map_err(|_| ())?;
        let Some(cat) = fresh.snapshot.catalogue() else {
            return Err(());
        };
        let dir = directory.to_owned();
        return Ok(tokio::task::spawn_blocking(move || cat.by_directory(&dir).cloned()).await.unwrap_or(None));
    }
    Ok(None)
}

pub async fn owns(app: &App, w: &Workspace, directory: &str) -> bool {
    if w.location["directory"] == directory && dunce::canonicalize(directory).ok().as_ref() == Some(&w.path) {
        return true;
    }
    if !crate::files::paths::canonical(&app.scope, directory).is_some_and(|path| path.starts_with(&app.scope)) {
        return false;
    }
    lookup_owned_tree(app, w, directory).await.ok().flatten().is_some()
}

#[cfg(test)]
mod root_probe_tests;
