//! The checkouts a workspace owns: its folder and linked worktrees (`inventory`,
//! `linked`), location ownership (`ownership`) and the deletion fence (`fence`).
pub mod fence;
mod inventory;
pub mod linked;
pub mod ownership;

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
    let mut git = crate::git::command(&workspace.path, args);
    tokio::time::timeout(Duration::from_secs(3), git.output()).await?
}

pub async fn root_only(workspace: &Workspace) -> Result<Option<bool>, Error> {
    if dunce::canonicalize(&workspace.path).ok().as_ref() != Some(&workspace.path) {
        return Err(probe_error());
    }
    match git(workspace, &["rev-parse", "--show-toplevel"]).await {
        Ok(output) if output.status.success() => Ok(None),
        Ok(output) if String::from_utf8_lossy(&output.stderr).contains("not a git repository") => Ok(Some(true)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Some(false)),
        _ => Err(probe_error()),
    }
}

pub async fn exact_root_supported(app: &App, workspace: &Workspace) -> Result<bool, Error> {
    Ok(root_only(workspace).await?.is_some()
        || crate::worktrees::linked::catalogue(app, workspace, false).await.is_ok())
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
        return dunce::canonicalize(directory).ok().as_ref() == Some(&w.path);
    }
    if !crate::files::paths::canonical(&app.root, directory).is_some_and(|p| p.starts_with(&app.root)) {
        return false;
    }
    crate::worktrees::linked::event_catalogue(app, w).await.is_some_and(|c| c.by_directory(directory).is_some())
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
    let Ok(path) = dunce::canonicalize(directory) else { return Err(false) };
    if w.location["directory"] == directory && path == w.path {
        return Ok("root".into());
    }
    let owned = if path.starts_with(&app.root) {
        match crate::worktrees::linked::catalogue(app, w, false).await {
            Ok(c) => c.by_directory(directory).map(|t| t.slug.clone()),
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
    if !crate::files::paths::canonical(&app.root, directory).is_some_and(|path| path.starts_with(&app.root)) {
        return false;
    }
    crate::worktrees::linked::catalogue(app, w, false).await.ok().is_some_and(|c| c.by_directory(directory).is_some())
}
