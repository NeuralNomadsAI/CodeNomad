//! Linked worktrees: creation, removal with session evacuation and session placement.
pub use super::inventory::{
    Catalogue, EventCache, Tree, catalogue, event_catalogue, forget, invalidate, readable_checkout, scope,
};
use crate::{App, Error, Shared, Workspace, error, files, git, opencode::proxy};
use axum::{
    Extension, Json,
    extract::{Path as Route, Query, State},
    http::{Method, StatusCode as Status},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

fn invalid(message: &str) -> Error {
    error(Status::BAD_REQUEST, message)
}
pub(super) fn conflict(message: &str) -> Error {
    error(Status::CONFLICT, message)
}
pub(super) fn missing() -> Error {
    error(Status::NOT_FOUND, "Worktree not found")
}
pub(super) fn native_error() -> Error {
    error(Status::BAD_GATEWAY, "Native worktree operation could not be verified")
}

pub async fn native(
    app: &App,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
) -> Result<Value, Error> {
    let mut request = app
        .native
        .request(method, app.native.url.join(path).map_err(|_| native_error())?)
        .query(query)
        .timeout(Duration::from_secs(12));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.ok().filter(|r| r.status().is_success()).ok_or_else(native_error)?;
    if response.status() == Status::NO_CONTENT {
        return Ok(Value::Null);
    }
    crate::opencode::read_json(response, max).await.map_err(|_| native_error())
}
async fn native_get(app: &App, path: &str, max: usize) -> Result<Value, Error> {
    native(app, Method::GET, path, &[], None, max).await
}
/// `DELETE /api/worktree` without force.
async fn delete_worktree(app: &App, project: &str, directory: &str) -> Result<(), Error> {
    let body = json!({"projectID": project, "directory": directory, "force": false});
    native(app, Method::DELETE, "/api/worktree", &[], Some(body), 16384).await.map(drop)
}
fn row_id(row: &Value) -> Result<&str, Error> {
    row["id"].as_str().ok_or_else(native_error)
}
pub(super) async fn git(path: &Path, args: &[&str]) -> Result<String, Error> {
    Ok(git::run(path, args, 128 * 1024).await?.ok()?.text())
}
pub(super) fn physical(s: &str) -> Option<PathBuf> {
    // Network and device paths are never opened, whoever names them.
    if !crate::files::paths::local_absolute(s) { None } else { dunce::canonicalize(s).ok().filter(|p| p.is_dir()) }
}
pub(super) fn host(path: &Path) -> Result<&str, Error> {
    path.to_str().ok_or_else(native_error)
}

fn announce(app: &App, w: &Workspace) {
    invalidate(app);
    app.emit(json!({"type":"workspace.worktreesChanged","workspaceId":w.id}));
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    slug: String,
    branch: Option<String>,
    from_slug: Option<String>,
}
pub async fn create(
    State(app): State<Shared>,
    Route(id): Route<String>,
    Json(input): Json<Create>,
) -> Result<(Status, Json<Value>), Error> {
    let branch = input.slug.trim();
    if branch == "root"
        || branch.starts_with('-')
        || branch.len() > 120
        || !crate::opencode::valid_id(branch)
            && !branch.bytes().all(|x| x.is_ascii_alphanumeric() || matches!(x, b'-' | b'_' | b'.' | b'/'))
        || input.branch.as_deref().is_some_and(|s| s.trim() != branch)
    {
        return Err(invalid("Invalid worktree branch"));
    }
    let _guard = app.project_mutation.lock().await;
    let w = app.workspace(&id)?;
    let catalogue = catalogue(&app, &w, true).await?;
    git::guard_config(&catalogue.main).await?;
    let from = catalogue.get(input.from_slug.as_deref().unwrap_or("root"))?;
    if from.nested_missing {
        return Err(conflict("Source worktree does not contain the workspace folder"));
    }
    git(&w.path, &["check-ref-format", "--branch", branch]).await.map_err(|_| invalid("Invalid worktree branch"))?;
    let branch_ref = format!("refs/heads/{branch}");
    if git(&w.path, &["worktree", "list", "--porcelain", "-z"])
        .await?
        .split('\0')
        .any(|s| s == format!("branch {branch_ref}"))
    {
        return Err(invalid("Branch is already checked out"));
    }
    let branch_object =
        git::run(&w.path, &["rev-parse", "--verify", "--quiet", &format!("{branch_ref}^{{commit}}")], 1024).await?;
    let existing = branch_object.code == 0;
    let rev = if existing {
        branch_object.text().trim().to_owned()
    } else {
        from.head.clone().ok_or_else(|| invalid("Source worktree has no commit"))?
    };
    if !git::sha(&rev) {
        return Err(native_error());
    }
    let relative = w.path.strip_prefix(catalogue.get("root")?.registered()).map_err(|_| native_error())?;
    if !relative.as_os_str().is_empty() {
        let relative = host(relative)?.replace('\\', "/");
        let kind = git(from.registered(), &["cat-file", "-t", &format!("{rev}:{relative}")]).await.ok();
        if kind.as_deref().map(str::trim) != Some("tree") {
            let body = json!({"code": "nested_folder_unavailable",
                "error": "The starting commit does not track the workspace folder"});
            return Err((Status::CONFLICT, Json(body)));
        }
    }
    let mut main_workspace = w.clone();
    main_workspace.path = catalogue.main.clone();
    let into = files::root(&main_workspace)?;
    for dir in [".codenomad", ".codenomad/worktrees"] {
        files::contained(&into, dir, true)?;
        if !into.is_dir(dir) {
            into.create_dir(dir).map_err(|_| conflict("Unable to create worktree directory"))?;
        }
        if into.canonicalize(dir).ok().as_deref() != Some(Path::new(dir)) {
            return Err(conflict("Worktree parent was replaced"));
        }
    }
    let info = into.open_dir(".git/info").map_err(|_| conflict("Git exclude is unavailable"))?;
    if into.canonicalize(".git/info").ok().as_deref() != Some(Path::new(".git/info")) {
        return Err(conflict("Git exclude is not physically owned"));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).append(true).create(true);
    if info.symlink_metadata("exclude").is_ok_and(|m| !m.is_file() || m.is_symlink()) {
        return Err(conflict("Git exclude is not physically owned"));
    }
    let mut excludes = info.open_with("exclude", &options).map_err(|_| conflict("Git exclude is unavailable"))?;
    let mut contents = Vec::new();
    let unavailable = || conflict("Git exclude is unavailable");
    (&mut excludes).take(64 * 1024 + 1).read_to_end(&mut contents).map_err(|_| unavailable())?;
    if contents.len() > 64 * 1024 {
        return Err(conflict("Git exclude exceeds the limit"));
    }
    let text = String::from_utf8_lossy(&contents);
    if !text.lines().any(|line| line == ".codenomad/worktrees/") {
        excludes.write_all(b"\n# codenomad\n.codenomad/worktrees/\n").map_err(|_| unavailable())?;
    }
    let name = branch.replace('/', "-");
    let body = json!({"projectID": catalogue.project, "from": from.service_root, "branch": rev,
        "directory": catalogue.parent, "name": name});
    let created = native(&app, Method::POST, "/api/worktree", &[], Some(body), 64 * 1024).await?;
    let service = created["directory"].as_str().ok_or_else(native_error)?;
    let inside = |d: &PathBuf| *d != catalogue.parent && d.starts_with(&catalogue.parent);
    physical(service).filter(inside).ok_or_else(native_error)?;
    let confirmed = self::catalogue(&app, &w, false).await?;
    let checkout = confirmed
        .by_registered(service)
        .filter(|t| t.slug != "root" && t.head.as_deref() == Some(&rev))
        .ok_or_else(native_error)?;
    let args = if existing { vec!["switch", "--", branch] } else { vec!["switch", "-c", branch] };
    if git(checkout.registered(), &args).await.is_err() {
        delete_worktree(&app, &catalogue.project, service).await?;
        return Err(conflict("Unable to attach the branch"));
    }
    let updated = self::catalogue(&app, &w, false).await?;
    let row = updated
        .by_registered(service)
        .filter(|r| r.branch.as_deref() == Some(branch))
        .ok_or_else(native_error)?
        .public();
    announce(&app, &w);
    Ok((Status::CREATED, Json(row)))
}

pub async fn sessions(app: &App, project: &str) -> Result<Vec<Value>, Error> {
    let mut result = Vec::new();
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut cursors = HashSet::new();
    // Same bounds as the TS evacuation inventory (10 000 pages, 1 000 000 sessions).
    for _ in 0..10_000 {
        let first = [("project", project), ("limit", "100"), ("order", "asc")];
        let next = [("cursor", cursor.as_deref().unwrap_or_default())];
        let query = if cursor.is_some() { &next[..] } else { &first[..] };
        let page = native(app, Method::GET, "/api/session", query, None, 2 * 1024 * 1024).await?;
        let rows = page["data"].as_array().filter(|r| r.len() <= 100).ok_or_else(native_error)?;
        for row in rows {
            let id = row["id"].as_str().filter(|s| crate::opencode::valid_id(s)).ok_or_else(native_error)?;
            if row["projectID"] != project || !seen.insert(id.to_owned()) || !row["location"]["directory"].is_string() {
                return Err(native_error());
            }
            if result.len() >= 1_000_000 {
                return Err(conflict("Session inventory exceeds the placement limit"));
            }
            result.push(row.clone());
        }
        let page_cursor = page["cursor"].as_object().ok_or_else(native_error)?;
        cursor = match page_cursor.get("next") {
            None | Some(Value::Null) => return Ok(result),
            Some(Value::String(s))
                if !rows.is_empty() && !s.is_empty() && s.len() <= 8192 && cursors.insert(s.clone()) =>
            {
                Some(s.clone())
            }
            _ => return Err(native_error()),
        };
    }
    Err(conflict("Session inventory exceeds the placement limit"))
}
fn directory(row: &Value) -> Result<&str, Error> {
    row["location"]["directory"]
        .as_str()
        .filter(|_| row["location"].get("workspaceID").is_none())
        .ok_or_else(native_error)
}
pub fn family(rows: &[Value], session: &str) -> Result<(String, Vec<Value>), Error> {
    let lookup: HashMap<_, _> = rows.iter().filter_map(|r| Some((r["id"].as_str()?, r))).collect();
    let parents = |mut id: String| {
        let mut visited = HashSet::new();
        for depth in 0..64 {
            if !visited.insert(id.clone()) {
                return Err(conflict("Session family contains a cycle"));
            }
            let row = lookup.get(id.as_str()).ok_or_else(|| conflict("Session family is incomplete"))?;
            let Some(parent) = row["parentID"].as_str() else { return Ok((id, depth)) };
            id = parent.into();
        }
        Err(conflict("Session family exceeds the placement limit"))
    };
    if !lookup.contains_key(session) {
        return Err(error(Status::NOT_FOUND, "Session not found in project"));
    }
    let (root, _) = parents(session.to_owned())?;
    let mut found = Vec::new();
    for row in rows {
        let id = row_id(row)?;
        let (top, depth) = parents(id.to_owned())?;
        if top == root {
            found.push((depth, row.clone()));
        }
    }
    found.sort_by_key(|(depth, _)| *depth);
    Ok((root, found.into_iter().map(|(_, row)| row).collect()))
}
async fn inactive(app: &App, members: &[Value]) -> Result<(), Error> {
    let active = native_get(app, "/api/session/active", 256 * 1024).await?;
    let active = active["data"].as_object().ok_or_else(native_error)?;
    if members.iter().any(|row| row["id"].as_str().is_some_and(|id| active.contains_key(id))) {
        return Err(conflict("Active sessions block this operation"));
    }
    Ok(())
}
async fn native_move(app: &App, id: &str, where_to: &str) -> Result<(), Error> {
    let body = Some(json!({"directory": where_to}));
    native(app, Method::POST, &format!("/api/session/{id}/move"), &[], body, 16384).await.map(drop)
}
async fn move_members(
    app: &App,
    w: &Workspace,
    cat: &Catalogue,
    members: &[Value],
    target: &Tree,
    principal: &crate::auth::Principal,
) -> Result<(), Error> {
    inactive(app, members).await?;
    for member in members {
        let from = directory(member)?;
        if cat.by_directory(from).is_none() {
            return Err(conflict("Session worktree is not owned"));
        }
        proxy::verify_mutation(app, row_id(member)?, from, member).await?;
    }
    let checked = catalogue(app, w, false).await?;
    if checked.get(&target.slug)? != target {
        return Err(conflict("Worktree changed before the session move"));
    }
    let mut attempted = Vec::new();
    let operation = async {
        for member in members {
            let id = row_id(member)?;
            inactive(app, std::slice::from_ref(member)).await?;
            principal.live()?;
            if directory(member)? == target.service {
                continue;
            }
            attempted.push(member);
            native_move(app, id, &target.service).await?;
            let now = crate::opencode::session_record(app, id).await?;
            if now["projectID"] != cat.project || directory(&now)? != target.service {
                return Err(conflict("Session move could not be verified"));
            }
        }
        let current = sessions(app, &cat.project).await?;
        let (_, now) = family(&current, members[0]["id"].as_str().ok_or_else(native_error)?)?;
        if now.len() != members.len() || now.iter().any(|r| directory(r).ok() != Some(target.service.as_str())) {
            return Err(conflict("Session family changed during the move"));
        }
        Ok(())
    }
    .await;
    if let Err(e) = operation {
        for member in attempted.into_iter().rev() {
            let id = row_id(member)?;
            let old = directory(member)?;
            let now = crate::opencode::session_record(app, id).await?;
            if directory(&now)? == old {
                continue;
            }
            if directory(&now)? != target.service || catalogue(app, w, false).await?.by_directory(old).is_none() {
                return Err(conflict("Session move requires manual recovery"));
            }
            native_move(app, id, old).await?;
            if directory(&crate::opencode::session_record(app, id).await?)? != old {
                return Err(conflict("Session rollback could not be verified"));
            }
        }
        return Err(e);
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Move {
    worktree_slug: String,
}
pub async fn place(
    State(app): State<Shared>,
    Route((id, session)): Route<(String, String)>,
    Extension(principal): Extension<crate::auth::Principal>,
    Json(input): Json<Move>,
) -> Result<Json<Value>, Error> {
    // Keep the verification/rollback obligation if the HTTP observer goes
    // away after dispatch. Revocation still blocks the next native move.
    tokio::spawn(place_owned(app, id, session, input, principal)).await.map_err(|_| native_error())?
}
async fn place_owned(
    app: Shared,
    id: String,
    session: String,
    input: Move,
    principal: crate::auth::Principal,
) -> Result<Json<Value>, Error> {
    let _guard = app.project_mutation.lock().await;
    principal.live()?;
    let w = app.workspace(&id)?;
    let cat = catalogue(&app, &w, true).await?;
    let target = cat.get(input.worktree_slug.trim())?;
    let (root, members) = family(&sessions(&app, &cat.project).await?, &session)?;
    move_members(&app, &w, &cat, &members, target, &principal).await?;
    announce(&app, &w);
    let ids: Vec<_> = members.iter().map(|m| &m["id"]).collect();
    Ok(Json(json!({"rootSessionId": root, "sessionIds": ids, "worktreeSlug": target.slug})))
}

async fn no_blockers(app: &App, target: &Tree, catalogue: &Catalogue, allow_owned: bool) -> Result<(), Error> {
    // The daemon is private to the prototype. Check every known location and
    // project, including other repositories that may reference this directory.
    let locations = native_get(app, "/api/debug/location", 256 * 1024).await?;
    let rows = locations.as_array().filter(|a| a.len() <= 96).ok_or_else(native_error)?;
    let mut directories = HashSet::from([target.service.as_str()]);
    for row in rows {
        if row.get("workspaceID").is_some() {
            return Err(conflict("Unsupported native location"));
        }
        directories.insert(row["directory"].as_str().ok_or_else(native_error)?);
    }
    for directory in directories {
        for resource in ["/api/shell", "/api/pty"] {
            let list =
                native(app, Method::GET, resource, &[("location[directory]", directory)], None, 128 * 1024).await?;
            let list = list["data"].as_array().ok_or_else(native_error)?;
            for row in list {
                if row["status"] == "running" && within(target, row["cwd"].as_str().ok_or_else(native_error)?) {
                    return Err(conflict("A running terminal blocks deletion"));
                }
            }
        }
    }
    let projects = native_get(app, "/api/project", 256 * 1024).await?;
    let projects = projects.as_array().filter(|a| a.len() <= 32).ok_or_else(native_error)?;
    let mut project_ids = HashSet::from([catalogue.project.as_str()]);
    for row in projects {
        project_ids.insert(row["id"].as_str().filter(|r| crate::opencode::valid_id(r)).ok_or_else(native_error)?);
    }
    let mut remaining = 512usize;
    for project in project_ids {
        for row in sessions(app, project).await? {
            remaining =
                remaining.checked_sub(1).ok_or_else(|| conflict("Terminal inventory exceeds the deletion limit"))?;
            if within(target, directory(&row)?) && !(allow_owned && project == catalogue.project) {
                return Err(conflict("A session still owns the checkout"));
            }
            let id = row_id(&row)?;
            let ptys = native_get(app, &format!("/api/experimental/session/{id}/terminal"), 128 * 1024).await?;
            for pty in ptys["data"].as_array().ok_or_else(native_error)? {
                if pty["status"] == "running" && within(target, pty["cwd"].as_str().ok_or_else(native_error)?) {
                    return Err(conflict("A running persistent terminal blocks deletion"));
                }
            }
        }
    }
    Ok(())
}
fn within(target: &Tree, candidate: &str) -> bool {
    let path = Path::new(candidate);
    path.starts_with(target.registered()) || dunce::canonicalize(path).is_ok_and(|p| p.starts_with(target.registered()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Removal {
    force: Option<String>,
}
pub async fn remove(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Query(query): Query<Removal>,
    Extension(principal): Extension<crate::auth::Principal>,
) -> Result<Status, Error> {
    if slug == "root" {
        return Err(invalid("Invalid worktree slug"));
    }
    if query.force.as_deref().is_some_and(|v| v != "false") {
        return Err(invalid("Forced worktree removal is unavailable"));
    }
    tokio::spawn(remove_owned(app, id, slug, principal)).await.map_err(|_| native_error())?
}
async fn remove_owned(
    app: Shared,
    id: String,
    slug: String,
    principal: crate::auth::Principal,
) -> Result<Status, Error> {
    let _guard = app.project_mutation.lock().await;
    principal.live()?;
    let w = app.workspace(&id)?;
    let cat = catalogue(&app, &w, true).await?;
    git::guard_config(&cat.main).await?;
    let target = cat.get(&slug)?;
    if target.locked || !target.removable {
        return Err(conflict("Worktree is locked or not removable"));
    }
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    if workspaces.iter().any(|other| other.id != w.id && other.path.starts_with(target.registered())) {
        return Err(conflict("Worktree is open in another workspace"));
    }
    clean(target).await?;
    no_blockers(&app, target, &cat, true).await?;
    let rows = sessions(&app, &cat.project).await?;
    let root = cat.get("root")?;
    if root.nested_missing {
        return Err(conflict("Evacuation destination is missing"));
    }
    let mut families = Vec::new();
    let mut found = HashSet::new();
    for row in &rows {
        if within(target, directory(row)?) {
            let (id, members) = family(&rows, row_id(row)?)?;
            if found.insert(id) {
                families.push(members);
            }
        }
    }
    // `worktreeDeletionFence.run`: the target and the evacuation destination stay blocked
    // through evacuation, removal and rollback (consulted by `subagent-depth` writes).
    // A drain timeout is not a `ProjectSessionError`: `asProjectError` answers 502.
    let _fence = crate::worktrees::fence::block(&[
        crate::worktrees::fence::identity(target.registered()),
        crate::worktrees::fence::identity(root.registered()),
    ])
    .await
    .map_err(|message| error(Status::BAD_GATEWAY, message))?;
    let mut moved = Vec::new();
    let removal = async {
        for members in &families {
            principal.live()?;
            move_members(&app, &w, &cat, members, root, &principal).await?;
            moved.extend(members.iter());
        }
        no_blockers(&app, target, &cat, false).await?;
        let now = catalogue(&app, &w, false).await?;
        if now.get(&slug)? != target {
            return Err(conflict("Worktree changed before deletion"));
        }
        clean(target).await?;
        principal.live()?;
        delete_worktree(&app, &cat.project, &target.service_root).await
    }
    .await;
    if let Err(err) = removal {
        if !moved.is_empty() {
            let verified = catalogue(&app, &w, false)
                .await
                .map_err(|_| conflict("Deletion unconfirmed; sessions remain at the main checkout"))?;
            if verified.get(&slug).ok() != Some(target) {
                return Err(conflict("Checkout changed; sessions remain at the safe destination"));
            }
            for member in moved.into_iter().rev() {
                let id = row_id(member)?;
                let original = directory(member)?;
                let session = crate::opencode::session_record(&app, id).await?;
                if directory(&session)? == original {
                    continue;
                }
                if session["projectID"] != cat.project
                    || directory(&session)? != root.service
                    || verified.by_directory(original) != cat.by_directory(original)
                    || verified.by_directory(original).is_none()
                {
                    return Err(conflict("Evacuation rollback requires manual reconciliation"));
                }
                inactive(&app, std::slice::from_ref(&session)).await?;
                native_move(&app, id, original).await?;
                if directory(&crate::opencode::session_record(&app, id).await?)? != original {
                    return Err(conflict("Evacuation rollback could not be verified"));
                }
            }
        }
        return Err(err);
    }
    if target.registered().exists() || catalogue(&app, &w, false).await?.get(&slug).is_ok() {
        return Err(native_error());
    }
    app.file_watches.lock().unwrap().forget_under(target.registered());
    announce(&app, &w);
    Ok(Status::NO_CONTENT)
}
async fn clean(target: &Tree) -> Result<(), Error> {
    let status = git(target.registered(), &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
    if status.is_empty() { Ok(()) } else { Err(conflict("Worktree has uncommitted changes")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_requires_complete_acyclic_parentage() {
        let root = json!({"id":"root"});
        let child = json!({"id":"child","parentID":"root"});
        let (id, members) = family(&[child.clone(), root.clone()], "child").unwrap();
        assert_eq!(id, "root");
        assert_eq!(members, [root, child.clone()]);
        assert!(family(&[child], "child").is_err());
        let cycle = [json!({"id":"root","parentID":"child"}), json!({"id":"child","parentID":"root"})];
        assert!(family(&cycle, "child").is_err());
    }
}
