//! The checkouts a workspace owns: its folder and linked worktrees (`inventory`,
//! `linked`), location ownership (`ownership`) and the deletion fence (`fence`).
pub mod fence;
#[cfg(test)]
pub(crate) mod fence_test_trace;
mod inventory;
pub mod linked;
pub mod ownership;

pub(crate) fn inventory_revision(app: &App) -> u64 {
    inventory::revision(app)
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
use std::{io::ErrorKind, time::Duration};

use crate::{App, Error, Shared, Workspace, error};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    fresh: Option<String>,
}

fn probe_error() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Git ownership could not be verified")
}
async fn git(workspace: &Workspace, args: &[&str]) -> Result<std::process::Output, std::io::Error> {
    let _slot = crate::git::slot().await;
    let mut git = crate::git::command(&workspace.path, args);
    tokio::time::timeout(Duration::from_secs(3), git.output()).await?
}

pub async fn root_only(workspace: &Workspace) -> Result<Option<bool>, Error> {
    let path = workspace.path.clone();
    let canonical_ok = tokio::task::spawn_blocking(move || dunce::canonicalize(&path).ok().as_ref() == Some(&path))
        .await
        .unwrap_or(false);
    if !canonical_ok {
        crate::bench::route_trace(format_args!("root-proof canonical path changed"));
        return Err(probe_error());
    }
    match git(workspace, &["rev-parse", "--show-toplevel"]).await {
        Ok(output) if output.status.success() => Ok(None),
        Ok(output) if String::from_utf8_lossy(&output.stderr).contains("not a git repository") => Ok(Some(true)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Some(false)),
        Ok(output) => {
            crate::bench::route_trace(format_args!("root-proof git exited {:?}", output.status.code()));
            Err(probe_error())
        }
        Err(err) => {
            crate::bench::route_trace(format_args!("root-proof git failed: {:?}", err.kind()));
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
    Ok(root_only(workspace).await?.is_some() || inventory::root_supported(app, workspace).await)
}

pub async fn native_project(app: &App, workspace: &Workspace, project: &str) -> Result<bool, Error> {
    if !crate::opencode::valid_id(project) || project == "global" {
        return Ok(false);
    }
    Ok(crate::worktrees::linked::catalogue(app, workspace, false).await.is_ok_and(|c| c.project == project))
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
    let Some(git) = root_only(&workspace).await? else {
        return Ok(Json(
            crate::worktrees::linked::catalogue(&app, &workspace, input.fresh.as_deref() != Some("false"))
                .await?
                .response(),
        )
        .into_response());
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

pub async fn owns_event(app: &Shared, w: &Workspace, directory: &str) -> bool {
    if w.location["directory"] == directory {
        let dir = directory.to_owned();
        let expected = w.path.clone();
        return tokio::task::spawn_blocking(move || dunce::canonicalize(&dir).ok().as_ref() == Some(&expected))
            .await
            .unwrap_or(false);
    }
    let scope = app.scope.clone();
    let dir = directory.to_owned();
    let in_scope = tokio::task::spawn_blocking(move || {
        crate::files::paths::canonical(&scope, &dir).is_some_and(|p| p.starts_with(&scope))
    })
    .await
    .unwrap_or(false);
    if !in_scope {
        return false;
    }
    let Some(catalogue) = crate::worktrees::linked::event_catalogue(app, w).await else {
        return false;
    };
    let dir = directory.to_owned();
    tokio::task::spawn_blocking(move || catalogue.by_directory(&dir).is_some()).await.unwrap_or(false)
}

/// Owned session location with its list slug (TS `resolveLocationPlacement`).
/// `Err(true)` only when a fresh read proves another owner; an unreadable
/// path or inventory is `Err(false)`, which denies without claiming departure.
pub async fn placement(app: &App, w: &Workspace, location: &serde_json::Value) -> Result<String, bool> {
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
        return Ok("root".into());
    }
    let owned = if path.starts_with(&app.scope) {
        match crate::worktrees::linked::catalogue(app, w, false).await {
            Ok(c) => {
                let dir_owned = directory.to_owned();
                tokio::task::spawn_blocking(move || c.by_directory(&dir_owned).map(|t| t.slug.clone()))
                    .await
                    .unwrap_or(None)
            }
            // Without a Git catalogue only the opened folder is authority, and
            // the reference's strict read reaches no verdict elsewhere.
            Err(_) => return Err(false),
        }
    } else {
        None
    };
    if let Some(slug) = owned {
        return Ok(slug);
    }
    // The reference owns subfolders of the opened checkout (closed here), and
    // its strict read fails rather than refuses for a non-Git folder.
    Err(!path.starts_with(&w.path) && crate::worktrees::linked::readable_checkout(&path).await)
}

pub async fn owns(app: &App, w: &Workspace, directory: &str) -> bool {
    if w.location["directory"] == directory && dunce::canonicalize(directory).ok().as_ref() == Some(&w.path) {
        return true;
    }
    if !crate::files::paths::canonical(&app.scope, directory).is_some_and(|path| path.starts_with(&app.scope)) {
        return false;
    }
    crate::worktrees::linked::catalogue(app, w, false).await.ok().is_some_and(|c| c.by_directory(directory).is_some())
}
