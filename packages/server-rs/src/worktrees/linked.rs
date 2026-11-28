//! Linked worktrees: creation, removal with session evacuation and session placement.
pub use super::inventory::{
    Catalogue, EventCache, Tree, blocking_invalidation, catalogue, event_catalogue_at, forget, invalidate,
    invalidate_blocking, readable_checkout, scope,
};
pub(crate) use super::inventory::{HttpSnapshot, ReadMode, emit_worktrees_changed, http_read};
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let endpoint = app.native.acquire(deadline).await.map_err(|_| native_error())?;
    let url = endpoint.url.join(path).map_err(|_| native_error())?;
    let request = app.native.client.request(method, url).basic_auth("opencode", Some(&endpoint.password));
    send(request, query, body, max).await
}

pub(super) async fn send(
    request: reqwest::RequestBuilder,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
) -> Result<Value, Error> {
    send_with_timeout(request, query, body, max, Duration::from_secs(60)).await
}

pub(super) async fn send_with_timeout(
    request: reqwest::RequestBuilder,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
    timeout: Duration,
) -> Result<Value, Error> {
    let mut request = request.query(query).timeout(timeout);
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
enum DeleteError {
    /// Failed before dispatching `DELETE /api/worktree` or OpenCode returned a confirmed 4xx refusal.
    ConfirmedNoDelete(Error),
    /// Dispatched `DELETE /api/worktree` and timed out, lost transport, or received 5xx: deletion
    /// may still be running in OpenCode, so evacuated sessions must remain at the main checkout.
    Uncertain(Error),
}

impl DeleteError {
    fn into_error(self) -> Error {
        match self {
            Self::ConfirmedNoDelete(err) | Self::Uncertain(err) => err,
        }
    }
}

/// `DELETE /api/worktree` without force, pinned to an acquired endpoint and shared deadline.
async fn delete_worktree_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    project: &str,
    directory: &str,
    deadline: tokio::time::Instant,
) -> Result<(), DeleteError> {
    if !app.native.current(endpoint) {
        return Err(DeleteError::ConfirmedNoDelete(native_error()));
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(DeleteError::ConfirmedNoDelete(native_error()));
    }
    let body = json!({"projectID": project, "directory": directory, "force": false});
    let url = endpoint.url.join("/api/worktree").map_err(|_| DeleteError::ConfirmedNoDelete(native_error()))?;
    let response = app
        .native
        .client
        .request(Method::DELETE, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .json(&body)
        .timeout(remaining)
        .send()
        .await
        .map_err(|_| DeleteError::Uncertain(native_error()))?;
    let status = response.status();
    if status.is_success() {
        if status == Status::NO_CONTENT {
            return Ok(());
        }
        crate::opencode::read_json(response, 16384).await.map(drop).map_err(|_| DeleteError::Uncertain(native_error()))
    } else if status.is_client_error() {
        Err(DeleteError::ConfirmedNoDelete(native_error()))
    } else {
        Err(DeleteError::Uncertain(native_error()))
    }
}

async fn native_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
) -> Result<Value, Error> {
    native_at_deadline(
        app,
        endpoint,
        method,
        path,
        query,
        body,
        max,
        tokio::time::Instant::now() + Duration::from_secs(60),
    )
    .await
}

async fn native_at_deadline(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
    deadline: tokio::time::Instant,
) -> Result<Value, Error> {
    if !app.native.current(endpoint) {
        return Err(native_error());
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(native_error());
    }
    let url = endpoint.url.join(path).map_err(|_| native_error())?;
    let request = app.native.client.request(method, url).basic_auth("opencode", Some(&endpoint.password));
    send_with_timeout(request, query, body, max, remaining).await
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
    invalidate_blocking(app);
    emit_worktrees_changed(app, w.id);
}

async fn repo_common(path: &Path, non_git: Status) -> Result<PathBuf, Error> {
    let out = git::run(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024).await?;
    if out.not_a_repository() {
        return Err(error(non_git, "Workspace is not a Git repository"));
    }
    let text = out.ok()?.text();
    dunce::canonicalize(text.trim()).map_err(|_| native_error())
}

/// Coordinate session moves and worktree deletions across occurrences of the same repository.
async fn topology(
    app: &App,
    id: &str,
    non_git: Status,
) -> Result<(Workspace, tokio::sync::OwnedMutexGuard<()>), Error> {
    let workspace = app.workspace(id)?;
    let common = repo_common(&workspace.path, non_git).await?;
    #[cfg(test)]
    super::fence_test_trace::record("topology reservation", "wait");
    let guard = super::fence::serialize(format!("worktree\n{}", super::fence::identity(&common))).await;
    if !crate::sessions::permission_mode::workspace_current(app, &workspace)
        || repo_common(&workspace.path, non_git).await.ok().as_ref() != Some(&common)
    {
        return Err(conflict("Workspace changed"));
    }
    Ok((workspace, guard))
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
    // Detach the mutation so an HTTP client disconnect mid-flight cannot leave a
    // half-created detached checkout or skip rollback/announcement.
    tokio::spawn(create_owned(app, id, branch.to_owned(), input.from_slug)).await.map_err(|_| native_error())?
}

async fn create_owned(
    app: Shared,
    id: String,
    branch: String,
    from_slug: Option<String>,
) -> Result<(Status, Json<Value>), Error> {
    let branch = branch.as_str();
    let w = app.workspace(&id)?;
    let endpoint =
        app.native.acquire(tokio::time::Instant::now() + Duration::from_secs(30)).await.map_err(|_| native_error())?;
    let from_slug = from_slug.as_deref().unwrap_or("root");
    let catalogue = super::inventory::catalogue_at(&app, &w, true, Some(&endpoint), Duration::from_secs(12)).await?;
    let from = catalogue.get(from_slug)?;
    if !from.creatable_source() {
        return Err(invalid("Source worktree not found"));
    }
    let mut paths: Vec<_> = catalogue.trees.iter().map(|tree| super::fence::identity(tree.registered())).collect();
    paths.push(super::fence::identity(&catalogue.parent));
    let _admitted = super::fence::enter(&paths).ok_or_else(|| conflict("A worktree is being removed"))?;
    let confirmed = super::inventory::catalogue_at(&app, &w, false, Some(&endpoint), Duration::from_secs(12)).await?;
    if confirmed.get(from_slug).ok() != Some(from) || !from.source_live() {
        return Err(conflict("Source worktree changed"));
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
    let relative = from.source_relative(&w.path, catalogue.get("root")?.registered()).ok_or_else(native_error)?;
    if !relative.as_os_str().is_empty() {
        let relative = host(&relative)?.replace('\\', "/");
        let kind = git(from.registered(), &["cat-file", "-t", &format!("{rev}:{relative}")]).await.ok();
        if kind.as_deref().map(str::trim) != Some("tree") {
            let body = json!({"code": "nested_folder_unavailable",
                "error": "The starting commit does not track the workspace folder"});
            return Err((Status::CONFLICT, Json(body)));
        }
    }
    {
        let _exclude =
            super::fence::serialize(format!("worktree-exclude\n{}", super::fence::identity(&catalogue.main))).await;
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
        // Ensure `.codenomad/worktrees/` is listed in the effective `info/exclude`, matching TS
        // `worktree-map.ts:6-21, 62-74`, `native-worktrees.ts:217-229`, and `worktrees.ts:359-364`:
        // ignore mkdir/read failures (e.g. unwritable info dir or directory at `info/exclude`), and
        // propagate only append failures as `400` before `POST /api/worktree`. Anchor every step
        // to the verified Git common directory via `cap_std` + Unix `O_NONBLOCK` + `fstat` so a
        // racing symlink at `info/` or FIFO at `exclude` can neither escape the repo nor block.
        let git_paths = git(
            &catalogue.main,
            &["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", "info/exclude"],
        )
        .await;
        if let Ok(raw) = git_paths {
            let mut lines = raw.lines();
            if let (Some(common_raw), Some(exclude_raw)) = (lines.next(), lines.next()) {
                let common_path = PathBuf::from(common_raw.trim());
                let exclude_path = PathBuf::from(exclude_raw.trim());
                // Move `_exclude` into `spawn_blocking` so cancelling the request mid-write
                // never releases the serialization lock before the worker finishes.
                let exclude_updated = tokio::task::spawn_blocking(move || -> Result<(), Error> {
                    let _exclude_guard = _exclude;
                    let Ok(common_canon) = dunce::canonicalize(&common_path) else { return Ok(()) };
                    let rel = match exclude_path
                        .strip_prefix(&common_path)
                        .or_else(|_| exclude_path.strip_prefix(&common_canon))
                    {
                        Ok(r) => r.to_path_buf(),
                        Err(_) => return Ok(()),
                    };
                    let mut comps = rel.components();
                    let (
                        Some(std::path::Component::Normal(info_comp)),
                        Some(std::path::Component::Normal(file_comp)),
                        None,
                    ) = (comps.next(), comps.next(), comps.next())
                    else {
                        return Ok(());
                    };
                    // Require the exact `info/exclude` components: if `<common_dir>/info` was an
                    // in-repo symlink already resolved by `git rev-parse --path-format=absolute`,
                    // `info_comp` will not be `"info"` and we refuse to follow it.
                    if info_comp != std::ffi::OsStr::new("info") || file_comp != std::ffi::OsStr::new("exclude") {
                        return Ok(());
                    }
                    let Ok(common_dir) =
                        cap_std::fs::Dir::open_ambient_dir(&common_canon, cap_std::ambient_authority())
                    else {
                        return Ok(());
                    };
                    // Match TS `worktree-map.ts:8-12`: ignore mkdir/open failure for `info/`.
                    // Refuse to follow an in-repo symlink at `info` so we never write outside the
                    // physical `info/` directory inside the verified Git common directory.
                    let _ = common_dir.create_dir(info_comp);
                    let Ok(info_meta) = common_dir.symlink_metadata(info_comp) else { return Ok(()) };
                    if !info_meta.is_dir() || info_meta.is_symlink() {
                        return Ok(());
                    }
                    let Ok(info) = common_dir.open_dir(info_comp) else { return Ok(()) };
                    #[cfg(unix)]
                    {
                        use cap_std::fs::MetadataExt;
                        let expected_info_path = common_canon.join(info_comp);
                        if dunce::canonicalize(&expected_info_path).ok().as_deref()
                            != Some(expected_info_path.as_path())
                        {
                            return Ok(());
                        }
                        let Ok(opened_meta) = info.dir_metadata() else { return Ok(()) };
                        if opened_meta.dev() != info_meta.dev() || opened_meta.ino() != info_meta.ino() {
                            return Ok(());
                        }
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
                        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
                        let expected_info_path = common_canon.join(info_comp);
                        let handle = info.as_raw_handle();
                        let len = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
                        if len == 0 {
                            return Ok(());
                        }
                        let mut buf = vec![0u16; len as usize];
                        let written = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), len, 0) };
                        if written == 0 || written as usize >= buf.len() {
                            return Ok(());
                        }
                        let actual =
                            dunce::simplified(Path::new(&std::ffi::OsString::from_wide(&buf[..written as usize])))
                                .to_path_buf();
                        if actual != expected_info_path {
                            return Ok(());
                        }
                    }
                    #[cfg(unix)]
                    let add_nonblock = |opts: &mut cap_std::fs::OpenOptions| {
                        use cap_std::fs::OpenOptionsExt;
                        #[cfg(any(
                            target_os = "macos",
                            target_os = "freebsd",
                            target_os = "openbsd",
                            target_os = "netbsd"
                        ))]
                        const O_NONBLOCK: i32 = 0x0004;
                        #[cfg(not(any(
                            target_os = "macos",
                            target_os = "freebsd",
                            target_os = "openbsd",
                            target_os = "netbsd"
                        )))]
                        const O_NONBLOCK: i32 = 0x0800;
                        opts.custom_flags(O_NONBLOCK);
                    };
                    // Match TS `worktree-map.ts:15-20`: missing file is empty; any other read failure
                    // (including a directory, symlink, or FIFO at `info/exclude`) returns without error.
                    let mut contents = Vec::new();
                    match info.symlink_metadata(file_comp) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Ok(m) if m.is_file() && !m.is_symlink() => {
                            let mut read_opts = cap_std::fs::OpenOptions::new();
                            read_opts.read(true);
                            #[cfg(unix)]
                            add_nonblock(&mut read_opts);
                            let Ok(mut reader) = info.open_with(file_comp, &read_opts) else { return Ok(()) };
                            if !reader.metadata().is_ok_and(|m| m.is_file()) {
                                return Ok(());
                            }
                            if (&mut reader).take(64 * 1024 + 1).read_to_end(&mut contents).is_err()
                                || contents.len() > 64 * 1024
                            {
                                return Ok(());
                            }
                        }
                        _ => return Ok(()),
                    }
                    let text = String::from_utf8_lossy(&contents);
                    if text.lines().any(|line| line.trim_end_matches('\r') == ".codenomad/worktrees/") {
                        return Ok(());
                    }
                    // Match TS `worktree-map.ts:21, 62-74`: append failure propagates as `400`.
                    let write_err = || error(Status::BAD_REQUEST, "Git exclude is unavailable");
                    let mut append_opts = cap_std::fs::OpenOptions::new();
                    append_opts.append(true).create(true);
                    #[cfg(unix)]
                    add_nonblock(&mut append_opts);
                    let mut writer = info.open_with(file_comp, &append_opts).map_err(|_| write_err())?;
                    if !writer.metadata().is_ok_and(|m| m.is_file()) {
                        return Err(write_err());
                    }
                    writer.write_all(b"\n# codenomad\n.codenomad/worktrees/\n").map_err(|_| write_err())?;
                    Ok(())
                })
                .await
                .map_err(|_| error(Status::BAD_REQUEST, "Git exclude is unavailable"))?;
                exclude_updated?;
            }
        }
    }
    let name = branch.replace('/', "-");
    let body = json!({"projectID": catalogue.project, "from": from.service_root, "branch": rev,
        "directory": catalogue.parent, "name": name});
    let _invalidate = blocking_invalidation(&app);
    let created = native_at(&app, &endpoint, Method::POST, "/api/worktree", &[], Some(body), 64 * 1024).await?;
    let service = created["directory"].as_str().ok_or_else(native_error)?;
    let inside = |d: &PathBuf| *d != catalogue.parent && d.starts_with(&catalogue.parent);
    physical(service).filter(inside).ok_or_else(native_error)?;
    if catalogue.by_registered(service).is_some() {
        return Err(native_error());
    }
    let read_catalogue_once_retry = || async {
        match super::inventory::catalogue_at(&app, &w, false, Some(&endpoint), Duration::from_secs(12)).await {
            Ok(cat) => Ok(cat),
            Err(err) if err.1["error"].as_str() == Some(super::inventory::CONFIG_CHANGED_ERROR) => {
                super::inventory::catalogue_at(&app, &w, false, Some(&endpoint), Duration::from_secs(12)).await
            }
            Err(err) => Err(err),
        }
    };
    let confirmed = read_catalogue_once_retry().await?;
    let checkout = confirmed
        .by_registered(service)
        .filter(|t| t.slug != "root" && t.head.as_deref() == Some(&rev))
        .ok_or_else(native_error)?;
    let args = if existing { vec!["switch", "--", branch] } else { vec!["switch", "-c", branch] };
    if git(checkout.registered(), &args).await.is_err() {
        let rollback_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        delete_worktree_at(&app, &endpoint, &catalogue.project, service, rollback_deadline)
            .await
            .map_err(DeleteError::into_error)?;
        return Err(conflict("Unable to attach the branch"));
    }
    // Retry the final inventory read once ONLY on `WorktreeConfigChangedError` so a newly created
    // and attached worktree is not falsely reported as failed (TS `native-worktrees.ts:256-264`).
    let updated = read_catalogue_once_retry().await?;
    let row = updated
        .by_registered(service)
        .filter(|r| r.branch.as_deref() == Some(branch))
        .ok_or_else(native_error)?
        .public();
    announce(&app, &w);
    Ok((Status::CREATED, Json(row)))
}

pub async fn sessions(app: &App, project: &str) -> Result<Vec<Value>, Error> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let endpoint = app.native.acquire(deadline).await.map_err(|_| native_error())?;
    sessions_at(app, &endpoint, project, deadline).await
}
async fn sessions_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    project: &str,
    deadline: tokio::time::Instant,
) -> Result<Vec<Value>, Error> {
    let mut result = Vec::new();
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut cursors = HashSet::new();
    // Same bounds as the TS evacuation inventory (10 000 pages, 1 000 000 sessions).
    for _ in 0..10_000 {
        let first = [("project", project), ("limit", "100"), ("order", "asc")];
        let next = [("cursor", cursor.as_deref().unwrap_or_default())];
        let query = if cursor.is_some() { &next[..] } else { &first[..] };
        let page =
            native_at_deadline(app, endpoint, Method::GET, "/api/session", query, None, 2 * 1024 * 1024, deadline)
                .await?;
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
enum MoveOutcome {
    Moved(String, Vec<Value>),
    Retry,
}

fn family_signature(members: &[Value]) -> Result<Vec<(String, Option<String>, String)>, Error> {
    let mut sig = members
        .iter()
        .map(|row| {
            Ok((row_id(row)?.to_owned(), row["parentID"].as_str().map(str::to_owned), directory(row)?.to_owned()))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    sig.sort();
    Ok(sig)
}

async fn move_members(
    app: &App,
    w: &Workspace,
    cat: &Catalogue,
    evacuating: Option<&Tree>,
    requested_session: Option<&str>,
    members: &[Value],
    target: &Tree,
    principal: &crate::auth::Principal,
) -> Result<MoveOutcome, Error> {
    let keys = members.iter().map(|row| row_id(row).map(super::fence::session)).collect::<Result<Vec<_>, _>>()?;
    let _placing = super::fence::try_block(&keys).ok_or_else(|| conflict("A session request is in progress"))?;
    inactive(app, members).await?;
    let (verified_root, active_members) = if evacuating.is_none() {
        let expected = family_signature(members)?;
        let fresh_rows = sessions(app, &cat.project).await?;
        let anchor = requested_session.unwrap_or(row_id(&members[0])?);
        let (fresh_root, fresh_members) = family(&fresh_rows, anchor)?;
        if family_signature(&fresh_members)? != expected {
            return Ok(MoveOutcome::Retry);
        }
        (fresh_root, fresh_members)
    } else {
        (row_id(&members[0])?.to_owned(), members.to_vec())
    };
    for member in &active_members {
        let from = directory(member)?;
        if member_owner(cat, evacuating, from).is_none() {
            return Err(conflict("Session worktree is not owned"));
        }
        proxy::verify_mutation(app, row_id(member)?, from, member).await?;
    }
    let checked = catalogue(app, w, false).await?;
    if checked.get(&target.slug)? != target {
        return Err(conflict("Worktree changed before the session move"));
    }
    let mut attempted = Vec::new();
    let mut invalidation = None;
    let operation = async {
        for member in &active_members {
            let id = row_id(member)?;
            inactive(app, std::slice::from_ref(member)).await?;
            principal.live()?;
            if !crate::sessions::permission_mode::workspace_current(app, w) {
                return Err(conflict("Workspace changed"));
            }
            if directory(member)? == target.service {
                continue;
            }
            invalidation.get_or_insert_with(|| blocking_invalidation(app));
            attempted.push(member);
            native_move(app, id, &target.service).await?;
            let now = crate::opencode::session_record(app, id).await?;
            if now["projectID"] != cat.project || directory(&now)? != target.service {
                return Err(conflict("Session move could not be verified"));
            }
        }
        let current = sessions(app, &cat.project).await?;
        let anchor = requested_session.unwrap_or(row_id(&active_members[0])?);
        let (now_root, now) = family(&current, anchor)?;
        let now_ids: HashSet<&str> = now.iter().filter_map(|row| row["id"].as_str()).collect();
        if now_root != verified_root
            || now.len() != active_members.len()
            || !active_members.iter().all(|member| member["id"].as_str().is_some_and(|id| now_ids.contains(id)))
            || now.iter().any(|r| directory(r).ok() != Some(target.service.as_str()))
        {
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
            let verified = catalogue(app, w, false).await?;
            let verified_evac = evacuating.and_then(|t| verified.get(&t.slug).ok().filter(|v| *v == t));
            let original_owner = member_owner(cat, evacuating, old);
            let verified_owner = member_owner(&verified, verified_evac, old);
            if directory(&now)? != target.service || verified_owner.is_none() || verified_owner != original_owner {
                return Err(conflict("Session move requires manual recovery"));
            }
            native_move(app, id, old).await?;
            if directory(&crate::opencode::session_record(app, id).await?)? != old {
                return Err(conflict("Session rollback could not be verified"));
            }
        }
        return Err(e);
    }
    if let Some(guard) = invalidation {
        guard.disarm();
    }
    Ok(MoveOutcome::Moved(verified_root, active_members))
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
    let (w, _guard) = topology(&app, &id, Status::CONFLICT).await?;
    principal.live()?;
    let cat = catalogue(&app, &w, true).await?;
    let target = cat.get(input.worktree_slug.trim())?;
    for _ in 0..3 {
        let (_, members) = family(&sessions(&app, &cat.project).await?, &session)?;
        let mut paths = vec![super::fence::identity(target.registered())];
        for member in &members {
            let tree = owner(&cat, directory(member)?).ok_or_else(|| conflict("Session worktree is not owned"))?;
            paths.push(super::fence::identity(tree.registered()));
        }
        let _admitted = super::fence::enter(&paths).ok_or_else(|| conflict("A session worktree is being removed"))?;
        if let MoveOutcome::Moved(root, moved_members) =
            move_members(&app, &w, &cat, None, Some(&session), &members, target, &principal).await?
        {
            announce(&app, &w);
            let ids: Vec<_> = moved_members.iter().map(|m| &m["id"]).collect();
            return Ok(Json(json!({"rootSessionId": root, "sessionIds": ids, "worktreeSlug": target.slug})));
        }
    }
    Err(conflict("Session family changed before the session move"))
}

async fn no_blockers(app: &App, target: &Tree, catalogue: &Catalogue, allow_owned: bool) -> Result<(), Error> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let endpoint = app.native.acquire(deadline).await.map_err(|_| native_error())?;
    no_blockers_at(app, &endpoint, target, catalogue, allow_owned, deadline).await
}

async fn no_blockers_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    target: &Tree,
    catalogue: &Catalogue,
    allow_owned: bool,
    deadline: tokio::time::Instant,
) -> Result<(), Error> {
    // Check every native location and project without artificial daemon-wide count caps,
    // matching TS `routes/worktrees.ts:309-354`, pinned to one daemon endpoint and one overall deadline.
    let locations =
        native_at_deadline(app, endpoint, Method::GET, "/api/debug/location", &[], None, 4 * 1024 * 1024, deadline)
            .await?;
    let rows = locations.as_array().ok_or_else(native_error)?;
    let mut seen_directories = HashSet::new();
    let mut directories: Vec<String> = Vec::with_capacity(rows.len() + 1);
    if seen_directories.insert(target.service.clone()) {
        directories.push(target.service.clone());
    }
    for row in rows {
        // Match TS `location.ts:25` (`Unsupported workspace selector`): refuse deletion when
        // a remote workspace selector is present rather than sending an unqualified query.
        if matches!(row.get("workspaceID"), Some(v) if !v.is_null()) {
            return Err(conflict("Unsupported native location"));
        }
        let dir = row["directory"].as_str().ok_or_else(native_error)?.to_owned();
        if seen_directories.insert(dir.clone()) {
            directories.push(dir);
        }
    }
    for chunk in directories.chunks(16) {
        let checks = chunk.iter().map(|directory| async move {
            let query = [("location[directory]", directory.as_str())];
            for resource in ["/api/shell", "/api/pty"] {
                let list =
                    native_at_deadline(app, endpoint, Method::GET, resource, &query, None, 1024 * 1024, deadline)
                        .await?;
                let list = list["data"].as_array().ok_or_else(native_error)?;
                for row in list {
                    if row["status"] == "running" && within(target, row["cwd"].as_str().ok_or_else(native_error)?) {
                        return Err(conflict("A running terminal blocks deletion"));
                    }
                }
            }
            Ok::<(), Error>(())
        });
        futures_util::future::try_join_all(checks).await?;
    }
    let projects =
        native_at_deadline(app, endpoint, Method::GET, "/api/project", &[], None, 4 * 1024 * 1024, deadline).await?;
    let projects = projects.as_array().ok_or_else(native_error)?;
    let mut project_ids = HashSet::from([catalogue.project.as_str()]);
    for row in projects {
        project_ids.insert(row["id"].as_str().filter(|r| crate::opencode::valid_id(r)).ok_or_else(native_error)?);
    }
    let mut session_ids = Vec::new();
    for project in project_ids {
        for row in sessions_at(app, endpoint, project, deadline).await? {
            let dir = row["location"]["directory"].as_str().ok_or_else(native_error)?;
            if within(target, dir) && !(allow_owned && project == catalogue.project) {
                return Err(conflict("A session still owns the checkout"));
            }
            session_ids.push(row_id(&row)?.to_owned());
        }
    }
    for chunk in session_ids.chunks(16) {
        let checks = chunk.iter().map(|id| async move {
            let path = format!("/api/experimental/session/{id}/terminal");
            let ptys = native_at_deadline(app, endpoint, Method::GET, &path, &[], None, 1024 * 1024, deadline).await?;
            for pty in ptys["data"].as_array().ok_or_else(native_error)? {
                if pty["status"] == "running" && within(target, pty["cwd"].as_str().ok_or_else(native_error)?) {
                    return Err(conflict("A running persistent terminal blocks deletion"));
                }
            }
            Ok::<(), Error>(())
        });
        futures_util::future::try_join_all(checks).await?;
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
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let trace = |stage: &str| {
        if *TRACE.get_or_init(|| std::env::var_os("CNRS_MUTATION_FENCE_TRACE").is_some()) {
            eprintln!("mutation-fence DELETE {slug}: {stage}");
        }
    };
    let w = app.workspace(&id)?;
    let common = repo_common(&w.path, Status::BAD_REQUEST).await?;
    trace("read catalogue");
    principal.live()?;
    let mut cat = catalogue(&app, &w, true).await?;
    let preliminary_root = {
        let target = cat.get(&slug)?;
        if target.locked || !target.removable {
            return Err(conflict("Worktree is locked or not removable"));
        }
        target.registered().to_path_buf()
    };
    let _deleting =
        super::fence::reserve_deletion_root(&super::fence::identity(&preliminary_root)).map_err(conflict)?;
    let _invalidate = blocking_invalidation(&app);
    if app
        .inner
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .any(|other| other.id != w.id && other.path.starts_with(&preliminary_root))
    {
        return Err(conflict("Worktree is open in another workspace"));
    }
    trace("wait for topology");
    #[cfg(test)]
    super::fence_test_trace::record("topology reservation", "wait");
    let (_guard, waited) =
        super::fence::serialize_checked(format!("worktree\n{}", super::fence::identity(&common))).await;
    principal.live()?;
    if !crate::sessions::permission_mode::workspace_current(&app, &w) {
        return Err(conflict("Workspace changed"));
    }
    if waited {
        cat = catalogue(&app, &w, false).await?;
        let target = cat.get(&slug).map_err(|_| conflict("Worktree changed before deletion"))?;
        if target.registered() != preliminary_root.as_path() {
            return Err(conflict("Worktree changed before deletion"));
        }
        if target.locked || !target.removable {
            return Err(conflict("Worktree is locked or not removable"));
        }
    }
    if app
        .inner
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .any(|other| other.id != w.id && other.path.starts_with(&preliminary_root))
    {
        return Err(conflict("Worktree is open in another workspace"));
    }
    clean(cat.get(&slug)?).await?;
    trace("first native blocker inventory");
    no_blockers(&app, cat.get(&slug)?, &cat, true).await?;
    trace("read evacuation sessions");
    let rows = sessions(&app, &cat.project).await?;
    let mut families = evacuation_families(&rows, cat.get(&slug)?)?;
    let mut admitted = match evacuation_paths(&cat, cat.get(&slug)?, &families) {
        Ok(paths) => paths,
        Err(_) => {
            cat = catalogue(&app, &w, false).await?;
            let target = cat.get(&slug).map_err(|_| conflict("Worktree changed before deletion"))?;
            if target.registered() != preliminary_root.as_path() {
                return Err(conflict("Worktree changed before deletion"));
            }
            families = evacuation_families(&rows, target)?;
            evacuation_paths(&cat, target, &families)?
        }
    };
    let target = cat.get(&slug)?;
    let root = cat.get("root")?;
    if root.nested_missing {
        return Err(conflict("Evacuation destination is missing"));
    }
    // `worktreeDeletionFence.run`: the target and the evacuation destination stay blocked
    // through evacuation, removal and rollback (consulted by `subagent-depth` writes).
    // A drain timeout is not a `ProjectSessionError`: `asProjectError` answers 502.
    admitted.extend([super::fence::identity(target.registered()), super::fence::identity(root.registered())]);
    let paths: Vec<_> = admitted.iter().cloned().collect();
    trace("enter fence drain");
    let _fence = crate::worktrees::fence::block(&paths).await.map_err(|message| error(Status::BAD_GATEWAY, message))?;
    #[cfg(test)]
    let _trace = super::fence_test_trace::held("checkout fence");
    trace("fence drained");
    if !crate::sessions::permission_mode::workspace_current(&app, &w) {
        return Err(conflict("Workspace changed"));
    }
    if app
        .inner
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .any(|other| other.id != w.id && other.path.starts_with(target.registered()))
    {
        return Err(conflict("Worktree is open in another workspace"));
    }
    let fresh = catalogue(&app, &w, false).await?;
    if fresh.get(&slug).ok() != Some(target)
        || fresh.get("root").ok().is_none_or(|r| {
            r.registered() != root.registered() || r.path != root.path || r.service != root.service || r.nested_missing
        })
    {
        return Err(conflict("Worktree changed before deletion"));
    }
    let cat = fresh;
    let target = cat.get(&slug)?;
    let root = cat.get("root")?;
    let families = evacuation_families(&sessions(&app, &cat.project).await?, target)?;
    let needed = evacuation_paths(&cat, target, &families)?;
    if !super::fence::covered(&admitted, &needed) {
        return Err(conflict("Session worktrees changed before deletion"));
    }
    no_blockers(&app, target, &cat, true).await?;
    let mut moved = Vec::new();
    let mut final_endpoint = None;
    let mut delete_uncertain = false;
    let removal = async {
        for members in &families {
            principal.live()?;
            let _ = move_members(&app, &w, &cat, Some(target), None, members, root, &principal).await?;
            moved.extend(members.iter());
        }
        let final_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let endpoint = app.native.acquire(final_deadline).await.map_err(|_| native_error())?;
        no_blockers_at(&app, &endpoint, target, &cat, false, final_deadline).await?;
        let remaining = final_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(native_error());
        }
        let now = tokio::time::timeout_at(
            final_deadline,
            super::inventory::catalogue_at(&app, &w, false, Some(&endpoint), remaining),
        )
        .await
        .map_err(|_| native_error())??;
        if now.get(&slug).ok() != Some(target) {
            return Err(conflict("Worktree changed before deletion"));
        }
        tokio::time::timeout_at(final_deadline, clean(target)).await.map_err(|_| native_error())??;
        principal.live()?;
        trace("issue native deletion");
        match delete_worktree_at(&app, &endpoint, &cat.project, &target.service_root, final_deadline).await {
            Ok(()) => {
                final_endpoint = Some(endpoint);
                Ok(())
            }
            Err(DeleteError::ConfirmedNoDelete(err)) => Err(err),
            Err(DeleteError::Uncertain(err)) => {
                delete_uncertain = true;
                Err(err)
            }
        }
    }
    .await;
    if let Err(err) = removal {
        if !moved.is_empty() {
            if delete_uncertain {
                return Err(conflict("Deletion unconfirmed; sessions remain at the main checkout"));
            }
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
                    || member_owner(&verified, verified.get(&slug).ok(), original)
                        != member_owner(&cat, Some(target), original)
                    || member_owner(&verified, verified.get(&slug).ok(), original).is_none()
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
    let post =
        super::inventory::catalogue_at(&app, &w, false, final_endpoint.as_ref(), Duration::from_secs(12)).await?;
    if target.registered().exists() || post.get(&slug).is_ok() {
        return Err(native_error());
    }
    app.file_watches.lock().unwrap().forget_under(target.registered());
    announce(&app, &w);
    Ok(Status::NO_CONTENT)
}

fn evacuation_families(rows: &[Value], target: &Tree) -> Result<Vec<Vec<Value>>, Error> {
    let mut families = Vec::new();
    let mut found = HashSet::new();
    for row in rows {
        if within(target, directory(row)?) {
            let (id, members) = family(rows, row_id(row)?)?;
            if found.insert(id) {
                families.push(members);
            }
        }
    }
    Ok(families)
}

fn owner<'a>(cat: &'a Catalogue, dir: &str) -> Option<&'a Tree> {
    if let Some(exact) = cat.by_directory(dir) {
        return Some(exact);
    }
    let resolved = physical(dir)?;
    cat.trees.iter().filter(|tree| tree.contains_live(&resolved)).max_by_key(|tree| tree.path.as_os_str().len())
}

fn member_owner<'a>(cat: &'a Catalogue, evacuating: Option<&'a Tree>, dir: &str) -> Option<&'a Tree> {
    owner(cat, dir).or_else(|| evacuating.filter(|tree| within(tree, dir)))
}

fn evacuation_paths(cat: &Catalogue, target: &Tree, families: &[Vec<Value>]) -> Result<HashSet<String>, Error> {
    families
        .iter()
        .flatten()
        .map(|row| {
            let dir = directory(row)?;
            let tree = member_owner(cat, Some(target), dir).ok_or_else(|| conflict("Session worktree is not owned"))?;
            Ok(super::fence::identity(tree.registered()))
        })
        .collect()
}
async fn clean(target: &Tree) -> Result<(), Error> {
    let filter_flags = crate::git::filter_disables(target.registered()).await?;
    let mut args: Vec<&str> = filter_flags.iter().map(String::as_str).collect();
    args.extend(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]);
    let status = git(target.registered(), &args).await?;
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

    #[tokio::test]
    async fn no_blockers_handles_large_daemon_inventory_above_legacy_caps() {
        use axum::{Router, extract::Request, response::IntoResponse, routing::any};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        #[derive(Clone)]
        struct State {
            target_dir: String,
            mode: Arc<AtomicUsize>, // 0 = clean, 1 = session #550 owns target, 2 = session #550 has running pty in target
        }

        async fn fake_native(
            axum::extract::State(st): axum::extract::State<State>,
            req: Request,
        ) -> axum::response::Response {
            let path = req.uri().path();
            match path {
                "/api/debug/location" => {
                    let mode = st.mode.load(Ordering::Relaxed);
                    let rows: Vec<Value> = (0..110)
                        .map(|i| {
                            if mode == 4 && i == 109 {
                                json!({"directory": format!("/remote/loc-{i}"), "workspaceID": "ws_remote"})
                            } else {
                                json!({"directory": format!("/other/loc-{i}")})
                            }
                        })
                        .collect();
                    Json(json!(rows)).into_response()
                }
                "/api/shell" | "/api/pty" => Json(json!({"data": []})).into_response(),
                "/api/project" => {
                    let rows: Vec<Value> = (0..40).map(|i| json!({"id": format!("prj_{i:02}")})).collect();
                    Json(json!(rows)).into_response()
                }
                "/api/session" => {
                    let query = req.uri().query().unwrap_or_default();
                    let project = reqwest::Url::parse(&format!("http://localhost/?{query}"))
                        .ok()
                        .and_then(|u| u.query_pairs().find(|(k, _)| k == "project").map(|(_, v)| v.into_owned()))
                        .unwrap_or_default();
                    let idx: usize = project.strip_prefix("prj_").and_then(|s| s.parse().ok()).unwrap_or(0);
                    // 40 projects * 14 sessions = 560 sessions (> 512 legacy cap).
                    let mode = st.mode.load(Ordering::Relaxed);
                    let data: Vec<Value> = (0..14)
                        .map(|j| {
                            let sid = format!("ses_{idx:02}_{j:02}");
                            let dir = if matches!(mode, 1 | 3) && idx == 39 && j == 13 {
                                st.target_dir.clone()
                            } else {
                                format!("/other/prj-{idx}")
                            };
                            let location = if mode == 3 && idx == 39 && j == 13 {
                                json!({"directory": dir, "workspaceID": "ws_remote"})
                            } else {
                                json!({"directory": dir})
                            };
                            json!({
                                "id": sid,
                                "projectID": project,
                                "location": location
                            })
                        })
                        .collect();
                    Json(json!({"data": data, "cursor": {"next": null}})).into_response()
                }
                p if p.starts_with("/api/experimental/session/") && p.ends_with("/terminal") => {
                    let mode = st.mode.load(Ordering::Relaxed);
                    if mode == 2 && p == "/api/experimental/session/ses_39_13/terminal" {
                        Json(json!({"data": [{"id": "pty_block", "status": "running", "cwd": st.target_dir}]}))
                            .into_response()
                    } else {
                        Json(json!({"data": []})).into_response()
                    }
                }
                _ => Status::NOT_FOUND.into_response(),
            }
        }

        let dir = crate::shared::test_dir("linked-m5-large-inventory");
        let main_dir = dir.join("main");
        let target_dir = dir.join("feature");
        std::fs::create_dir_all(&main_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        let main_dir = dunce::canonicalize(&main_dir).unwrap();
        let target_dir = dunce::canonicalize(&target_dir).unwrap();
        let target_str = target_dir.to_string_lossy().into_owned();

        let mode = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = crate::opencode::Native::test_connection(listener.local_addr().unwrap());
        let st = State { target_dir: target_str.clone(), mode: Arc::clone(&mode) };
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(st)).await.unwrap()
        });

        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let target = Tree::test_stub(target_dir.clone(), main_dir.join(".git"), "worktree-feature", Some("feature"));
        let cat =
            Catalogue { project: "prj_00".into(), trees: vec![target.clone()], parent: dir.clone(), main: main_dir };

        // 1. 110 locations, 40 projects, 560 sessions with no blockers -> Ok(())
        no_blockers(&app, &target, &cat, false).await.unwrap();

        // 2. Session #560 in project #39 owns target -> 409 Conflict
        mode.store(1, Ordering::Relaxed);
        let err = no_blockers(&app, &target, &cat, false).await.unwrap_err();
        assert_eq!(err.0, Status::CONFLICT);

        // 3. Session #560 has a running persistent terminal in target -> 409 Conflict
        mode.store(2, Ordering::Relaxed);
        let err = no_blockers(&app, &target, &cat, false).await.unwrap_err();
        assert_eq!(err.0, Status::CONFLICT);

        // 4. Session #560 in project #39 carries workspaceID AND directory in target -> still 409 Conflict
        mode.store(3, Ordering::Relaxed);
        let err = no_blockers(&app, &target, &cat, false).await.unwrap_err();
        assert_eq!(err.0, Status::CONFLICT);

        // 5. Remote location with workspaceID in /api/debug/location -> fails closed (409 Conflict)
        mode.store(4, Ordering::Relaxed);
        let err = no_blockers(&app, &target, &cat, false).await.unwrap_err();
        assert_eq!(err.0, Status::CONFLICT);

        http.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn clean_never_runs_submodule_filter_driver() {
        let _serial = crate::git::test_git_serial().await;
        let dir = crate::shared::test_dir("linked-m4-submodule-clean");
        let sub_origin = dir.join("sub-origin");
        let parent = dir.join("parent");
        let marker = dir.join("submodule-filter-ran");
        std::fs::create_dir_all(&sub_origin).unwrap();
        std::fs::create_dir_all(&parent).unwrap();

        let run_git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };

        run_git(&sub_origin, &["init", "-q"]);
        run_git(&sub_origin, &["config", "user.name", "test"]);
        run_git(&sub_origin, &["config", "user.email", "test@example.com"]);
        std::fs::write(sub_origin.join("data.txt"), "v1\n").unwrap();
        std::fs::write(sub_origin.join(".gitattributes"), "*.txt filter=subf -text\n").unwrap();
        run_git(&sub_origin, &["add", "."]);
        run_git(&sub_origin, &["commit", "-q", "-m", "sub init"]);

        run_git(&parent, &["init", "-q"]);
        run_git(&parent, &["config", "user.name", "test"]);
        run_git(&parent, &["config", "user.email", "test@example.com"]);
        run_git(
            &parent,
            &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub_origin.to_str().unwrap(), "sub"],
        );
        run_git(&parent, &["commit", "-q", "-m", "add submodule"]);

        // Configure filter ONLY inside the submodule and modify its tracked file.
        let sub_dir = parent.join("sub");
        let marker_posix = marker.to_string_lossy().replace('\\', "/");
        run_git(&sub_dir, &["config", "filter.subf.clean", &format!("sh -c 'touch \"{marker_posix}\" && cat'")]);
        std::fs::write(sub_dir.join("data.txt"), "v2\n").unwrap();

        let parent_canon = dunce::canonicalize(&parent).unwrap();
        let target = Tree::test_stub(parent_canon.clone(), parent_canon.join(".git"), "root", Some("main"));
        clean(&target).await.unwrap();
        assert!(!marker.exists(), "clean() must never execute a submodule-local filter driver");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn create_completes_when_caller_disconnects_mid_flight() {
        use axum::response::IntoResponse;
        use std::sync::Arc;
        use uuid::Uuid;

        let _serial = crate::git::test_git_serial().await;
        let dir = crate::shared::test_dir("linked-create-disconnect");
        let main_dir = dir.join("main");
        std::fs::create_dir_all(&main_dir).unwrap();

        let run_git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };

        run_git(&main_dir, &["init", "-q", "-b", "main"]);
        run_git(&main_dir, &["config", "user.name", "test"]);
        run_git(&main_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(main_dir.join("README.md"), "hello\n").unwrap();
        run_git(&main_dir, &["add", "."]);
        run_git(&main_dir, &["commit", "-q", "-m", "init"]);
        let main_canon = dunce::canonicalize(&main_dir).unwrap();

        struct CreateFixture {
            root: PathBuf,
            created: std::sync::Mutex<Option<PathBuf>>,
            paused_once: std::sync::atomic::AtomicBool,
            after_post_reached: Arc<tokio::sync::Notify>,
            after_post_release: Arc<tokio::sync::Notify>,
        }

        let after_post_reached = Arc::new(tokio::sync::Notify::new());
        let after_post_release = Arc::new(tokio::sync::Notify::new());
        let fixture = Arc::new(CreateFixture {
            root: main_canon.clone(),
            created: std::sync::Mutex::new(None),
            paused_once: std::sync::atomic::AtomicBool::new(false),
            after_post_reached: after_post_reached.clone(),
            after_post_release: after_post_release.clone(),
        });

        let fake_router = axum::Router::new().fallback(axum::routing::any({
            let fixture = fixture.clone();
            move |req: axum::extract::Request| {
                let fixture = fixture.clone();
                async move {
                    let method = req.method().clone();
                    let path = req.uri().path().to_owned();
                    let query = req.uri().query().unwrap_or_default().to_owned();
                    let body = axum::body::to_bytes(req.into_body(), 256 * 1024).await.unwrap_or_default();
                    match (method, path.as_str()) {
                        (Method::GET, "/api/location") => {
                            let requested = reqwest::Url::parse(&format!("http://localhost/?{query}"))
                                .ok()
                                .and_then(|u| {
                                    u.query_pairs()
                                        .find(|(k, _)| k == "location[directory]")
                                        .map(|(_, v)| v.into_owned())
                                })
                                .unwrap_or_else(|| fixture.root.to_string_lossy().into_owned());
                            Json(json!({
                                "directory": requested,
                                "project": {
                                    "id": "prj_create_disconnect",
                                    "directory": fixture.root,
                                    "canonical": fixture.root,
                                }
                            }))
                            .into_response()
                        }
                        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
                        (Method::GET, "/api/worktree") => {
                            let created = fixture.created.lock().unwrap().clone();
                            if created.is_some() && !fixture.paused_once.swap(true, std::sync::atomic::Ordering::SeqCst)
                            {
                                fixture.after_post_reached.notify_one();
                                fixture.after_post_release.notified().await;
                            }
                            let mut items = vec![json!({"directory": fixture.root})];
                            if let Some(dir) = created {
                                items.push(json!({"directory": dir}));
                            }
                            Json(Value::Array(items)).into_response()
                        }
                        (Method::POST, "/api/worktree") => {
                            let payload: Value = serde_json::from_slice(&body).unwrap();
                            let rev = payload["branch"].as_str().unwrap();
                            let parent = PathBuf::from(payload["directory"].as_str().unwrap());
                            let name = payload["name"].as_str().unwrap();
                            let checkout = parent.join(name);
                            let out = crate::git::command(
                                &fixture.root,
                                &["worktree", "add", "--detach", checkout.to_str().unwrap(), rev],
                            )
                            .output()
                            .await
                            .unwrap();
                            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
                            let checkout_canon = dunce::canonicalize(&checkout).unwrap();
                            *fixture.created.lock().unwrap() = Some(checkout_canon.clone());
                            Json(json!({"directory": checkout_canon})).into_response()
                        }
                        _ => Status::NOT_IMPLEMENTED.into_response(),
                    }
                }
            }
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let http = tokio::spawn(async move { axum::serve(listener, fake_router).await.unwrap() });

        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            main_canon.clone(),
            false,
            settings,
            Value::Null,
            crate::opencode::Native::test_connection(addr),
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let ws_id = Uuid::new_v4();
        let ws = Workspace {
            id: ws_id,
            request_id: None,
            path: main_canon.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": main_canon, "project": {"id": "prj_create_disconnect", "directory": main_canon, "canonical": main_canon}}),
            temporary: None,
        };
        app.inner.lock().unwrap().workspaces.push(ws);
        let sub = app.events.subscribe();

        let caller = tokio::spawn(create(
            State(app.clone()),
            Route(ws_id.to_string()),
            Json(Create { slug: "feature-detached".into(), branch: None, from_slug: None }),
        ));

        tokio::time::timeout(Duration::from_secs(15), after_post_reached.notified())
            .await
            .expect("create should reach post-POST inventory read");
        let checkout = fixture.created.lock().unwrap().clone().expect("POST /api/worktree must have run");
        assert!(run_git(&checkout, &["branch", "--show-current"]).is_empty(), "checkout starts detached");

        // Simulate an HTTP client disconnect mid-flight by dropping the handler future.
        caller.abort();
        let _ = caller.await;

        after_post_release.notify_one();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut announced = false;
        while tokio::time::Instant::now() < deadline {
            while let crate::events::Next::Frame(frame) = app.events.pop(&sub) {
                if let Ok(event) = serde_json::from_str::<Value>(&frame)
                    && event["type"] == "workspace.worktreesChanged"
                    && event["workspaceId"] == ws_id.to_string()
                {
                    announced = true;
                }
            }
            if announced {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(announced, "detached create must still finish and announce workspace.worktreesChanged");
        assert_eq!(
            run_git(&checkout, &["branch", "--show-current"]),
            "feature-detached",
            "detached create must finish switching the new worktree onto the requested branch"
        );

        http.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
#[path = "mutation_race.rs"]
mod mutation_race;
