//! Bounded local branch sources for the Mission editor, under the checkout deletion fence.
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    Error, Shared, error,
    worktrees::{fence, ownership},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Source {
    directory: String,
}

pub(super) async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    query: Result<Query<Source>, QueryRejection>,
) -> Result<Json<Value>, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid branch directory");
    let Query(Source { directory }) = query.map_err(|_| invalid())?;
    if !(1..=4096).contains(&directory.encode_utf16().count()) {
        return Err(invalid());
    }
    let workspace = app.workspace(&id)?;
    let foreign = || error(Status::FORBIDDEN, "Foreign branch directory");
    let owned = ownership::resolve(&app, &workspace, &directory).await.ok_or_else(foreign)?;
    let guard = fence::identity(&owned.checkout);
    let _permit = fence::enter(std::slice::from_ref(&guard))
        .ok_or_else(|| error(Status::CONFLICT, "Worktree deletion pending"))?;
    let checkout = std::path::Path::new(&owned.directory);
    let refs = super::run(
        checkout,
        &["for-each-ref", "--count=201", "--sort=refname", "--format=%(refname)", "refs/heads/"],
        256 * 1024,
    )
    .await?
    .ok()?
    .text();
    let branches: Vec<_> = refs.lines().filter(|r| !r.is_empty()).collect();
    if branches.len() > 200 || branches.iter().any(|r| !r.starts_with("refs/heads/") || r.encode_utf16().count() > 1024)
    {
        return Err(error(Status::BAD_REQUEST, "Local branch listing exceeds its bound"));
    }
    let fresh = app.workspace(&id)?;
    if fresh.path != workspace.path
        || fresh.location != workspace.location
        || !ownership::resolve(&app, &fresh, &directory)
            .await
            .is_some_and(|o| o.directory == owned.directory && fence::identity(&o.checkout) == guard)
    {
        return Err(error(Status::BAD_REQUEST, "Branch directory changed"));
    }
    Ok(Json(json!({ "branches": branches })))
}
