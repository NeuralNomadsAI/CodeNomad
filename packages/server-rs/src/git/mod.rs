//! Git of an owned checkout. Probes use bounded slots; explicit mutations use
//! the user's Git configuration.
mod branches;
mod config_guard;
pub use config_guard::filter_disables;
mod history;
mod repository_source;
mod status_read;
mod user_command;

pub fn routes() -> axum::Router<Shared> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/api/workspaces/{id}/git-branches", get(branches::list))
        .route("/api/workspaces/{id}/repository-source", get(repository_source::read))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-status", get(status_read::status))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-diff", get(status_read::diff))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-history", get(history::history))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-history/{commit}", get(history::commit_details))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-stage", post(stage))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-unstage", post(unstage))
        .route("/api/workspaces/{id}/worktrees/{slug}/git-commit", post(commit))
        .route("/api/workspaces/{id}/git-init", post(init))
}

use crate::{Error, Shared, Workspace, error, files, shared::read_capped, worktrees};
use axum::{
    Json,
    extract::{Path as Route, State},
    http::StatusCode as Status,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, path::Path, process::Stdio, sync::LazyLock, time::Duration};
use tokio::{process::Command, sync::Semaphore};

const TWO_MIB: usize = 2 * 1024 * 1024;
static SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));
#[cfg(test)]
pub(crate) async fn test_git_serial() -> tokio::sync::MutexGuard<'static, ()> {
    static SERIAL: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
    SERIAL.lock().await
}
pub fn bad(s: &str) -> Error {
    error(Status::BAD_REQUEST, s)
}
fn conflict(s: &str) -> Error {
    error(Status::CONFLICT, s)
}
fn coded(status: Status, msg: &str, code: &str) -> Error {
    (status, Json(json!({"error":msg,"code":code})))
}
fn missing_git() -> Error {
    coded(
        Status::SERVICE_UNAVAILABLE,
        "git_required: This Git/worktree operation requires Git in the CodeNomad backend's PATH. Conversations remain available in the explicitly opened folder. Ask your agent to help install Git, then restart CodeNomad after changing PATH.",
        "git_required",
    )
}
pub(crate) fn is_missing_git(err: &Error) -> bool {
    err.0 == Status::SERVICE_UNAVAILABLE && err.1.0.get("code").and_then(Value::as_str) == Some("git_required")
}
pub struct Output {
    pub code: i32,
    pub bytes: Vec<u8>,
    err: Vec<u8>,
}
impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    pub(crate) fn stderr(&self) -> &[u8] {
        &self.err
    }
    pub fn ok(self) -> Result<Self, Error> {
        if self.code == 0 { Ok(self) } else { Err(bad("Git read failed")) }
    }
    pub fn not_a_repository(&self) -> bool {
        self.code == 128 && self.err.starts_with(b"fatal: not a git repository (or any ")
    }
    fn mutation(self) -> Result<(), Error> {
        if self.code == 0 {
            Ok(())
        } else {
            let msg = String::from_utf8_lossy(&self.err);
            Err(conflict(if msg.trim().is_empty() { "Git mutation failed" } else { msg.trim() }))
        }
    }
}
/// `core.hooksPath` names an empty folder of the server's private data
/// (audit I2) rather than relying on how Git for Windows maps `/dev/null`.
static HOOKS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn empty_hooks(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    if std::fs::symlink_metadata(dir)?.file_type().is_symlink() || std::fs::read_dir(dir)?.next().is_some() {
        return Err(io::Error::other("Git hooks folder must be an empty physical folder"));
    }
    let dir = dir.to_str().ok_or_else(|| io::Error::other("Git hooks folder path"))?;
    let _ = HOOKS.set(format!("core.hooksPath={dir}"));
    Ok(())
}
pub(crate) fn hooks() -> &'static str {
    HOOKS.get().map_or("core.hooksPath=/dev/null", String::as_str)
}
pub fn command(dir: &Path, args: &[&str]) -> Command {
    #[cfg(test)]
    crate::worktrees::fence_test_trace::record("git command", args.first().copied().unwrap_or(""));
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args([
            "-c",
            hooks(),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "log.showSignature=false",
            "-c",
            "diff.external=",
            "-c",
            "submodule.recurse=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, _) in std::env::vars_os() {
        let name = k.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("GIT_")
            && !matches!(
                name.as_str(),
                "GIT_CEILING_DIRECTORIES"
                    | "GIT_CONFIG_GLOBAL"
                    | "GIT_CONFIG_SYSTEM"
                    | "GIT_CONFIG_NOSYSTEM"
                    | "GIT_ATTR_NOSYSTEM"
                    | "GIT_AUTHOR_NAME"
                    | "GIT_AUTHOR_EMAIL"
                    | "GIT_AUTHOR_DATE"
                    | "GIT_COMMITTER_NAME"
                    | "GIT_COMMITTER_EMAIL"
                    | "GIT_COMMITTER_DATE"
            )
        {
            cmd.env_remove(k);
        }
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LITERAL_PATHSPECS", "1");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}
async fn run_command(mut cmd: Command, max: usize) -> Result<Output, Error> {
    #[cfg(test)]
    crate::worktrees::fence_test_trace::record("git semaphore", "waiting");
    let _slot = SLOTS.acquire().await.unwrap();
    #[cfg(test)]
    let _trace = crate::worktrees::fence_test_trace::held("git semaphore");
    let mut child = cmd
        .spawn()
        .map_err(|e| if e.kind() == io::ErrorKind::NotFound { missing_git() } else { bad("Git could not start") })?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let (bytes, err, status) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::try_join!(read_capped(out, max), read_capped(err, 32 * 1024), child.wait())
    })
    .await
    .map_err(|_| bad("Git operation timed out"))?
    .map_err(|_| bad("Git output unavailable or too large"))?;
    Ok(Output { code: status.code().unwrap_or(-1), bytes, err })
}
pub async fn run(dir: &Path, args: &[&str], max: usize) -> Result<Output, Error> {
    run_command(command(dir, args), max).await
}
/// Runs Git while setting `GIT_CEILING_DIRECTORIES` to include `scope.parent()` when `scope` is
/// non-empty, preventing Git repository discovery from ascending above `scope` and loading a
/// parent checkout's config or includes.
pub async fn run_in_scope(dir: &Path, scope: &Path, args: &[&str], max: usize) -> Result<Output, Error> {
    let mut cmd = command(dir, args);
    if !scope.as_os_str().is_empty()
        && let Some(ceiling) = scope.parent()
    {
        let mut ceilings = vec![ceiling.to_path_buf()];
        if let Some(existing) = std::env::var_os("GIT_CEILING_DIRECTORIES") {
            ceilings.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(&ceilings) {
            cmd.env("GIT_CEILING_DIRECTORIES", joined);
        } else {
            cmd.env("GIT_CEILING_DIRECTORIES", ceiling);
        }
    }
    run_command(cmd, max).await
}
pub async fn run_with_stdin(dir: &Path, args: &[&str], stdin_bytes: &[u8], max: usize) -> Result<Output, Error> {
    let _slot = SLOTS.acquire().await.unwrap();
    let mut cmd = command(dir, args);
    cmd.stdin(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| if e.kind() == io::ErrorKind::NotFound { missing_git() } else { bad("Git could not start") })?;
    let mut stdin = child.stdin.take().unwrap();
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let write_stdin = async {
        use tokio::io::AsyncWriteExt;
        match stdin.write_all(stdin_bytes).await {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => {}
            Err(e) => return Err(e),
        }
        let _ = stdin.shutdown().await;
        drop(stdin);
        Ok(())
    };
    let (_, bytes, err, status) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::try_join!(write_stdin, read_capped(out, max), read_capped(err, 32 * 1024), child.wait())
    })
    .await
    .map_err(|_| bad("Git operation timed out"))?
    .map_err(|_| bad("Git output unavailable or too large"))?;
    Ok(Output { code: status.code().unwrap_or(-1), bytes, err })
}
pub async fn repo(app: &crate::App, id: &str, slug: &str) -> Result<Workspace, Error> {
    Ok(repo_target(app, id, slug).await?.0)
}

async fn repo_target(
    app: &crate::App,
    id: &str,
    slug: &str,
) -> Result<(Workspace, crate::worktrees::linked::Tree), Error> {
    let w = app.workspace(id)?;
    let hit = crate::worktrees::linked::http_read(app, &w, crate::worktrees::linked::ReadMode::Validated).await?;
    let hit = if hit.from_cache && matches!(hit.snapshot, crate::worktrees::linked::HttpSnapshot::NonGit) {
        let dot_git = w.path.join(".git");
        let appeared =
            tokio::task::spawn_blocking(move || std::fs::symlink_metadata(&dot_git).is_ok()).await.unwrap_or(false);
        if appeared {
            crate::worktrees::linked::http_read(app, &w, crate::worktrees::linked::ReadMode::Fresh).await?
        } else {
            hit
        }
    } else {
        hit
    };
    let mut cat = match hit.snapshot {
        crate::worktrees::linked::HttpSnapshot::MissingGit => return Err(missing_git()),
        crate::worktrees::linked::HttpSnapshot::NonGit => return Err(bad("Workspace is not a Git repository")),
        crate::worktrees::linked::HttpSnapshot::Git(cat) => cat,
    };
    if hit.from_cache {
        let (root_live, tree_ok) = {
            let cat_clone = std::sync::Arc::clone(&cat);
            let opened = w.path.clone();
            let slug_owned = slug.to_owned();
            tokio::task::spawn_blocking(move || {
                let root_live = cat_clone.root_live_for(&opened);
                let tree_ok = root_live
                    && cat_clone.get(&slug_owned).ok().is_some_and(|t| t.direct_folder() && t.contains_live(&t.path));
                (root_live, tree_ok)
            })
            .await
            .unwrap_or((false, false))
        };
        if !tree_ok {
            let missing_slug = root_live && cat.get(slug).is_err();
            if !missing_slug || !hit.refreshed_on_miss {
                let retry_mode = if missing_slug {
                    crate::worktrees::linked::ReadMode::RefreshOnMiss(hit.generation)
                } else {
                    crate::worktrees::linked::ReadMode::Fresh
                };
                let fresh = crate::worktrees::linked::http_read(app, &w, retry_mode).await?;
                cat = match fresh.snapshot {
                    crate::worktrees::linked::HttpSnapshot::MissingGit => return Err(missing_git()),
                    crate::worktrees::linked::HttpSnapshot::NonGit => {
                        return Err(bad("Workspace is not a Git repository"));
                    }
                    crate::worktrees::linked::HttpSnapshot::Git(cat) => cat,
                };
                if fresh.from_cache {
                    let cat_clone = std::sync::Arc::clone(&cat);
                    let slug_owned = slug.to_owned();
                    let still_live = tokio::task::spawn_blocking(move || {
                        cat_clone.get(&slug_owned).ok().is_none_or(|t| t.direct_folder() && t.contains_live(&t.path))
                    })
                    .await
                    .unwrap_or(false);
                    if !still_live {
                        let forced =
                            crate::worktrees::linked::http_read(app, &w, crate::worktrees::linked::ReadMode::Fresh)
                                .await?;
                        cat = match forced.snapshot {
                            crate::worktrees::linked::HttpSnapshot::MissingGit => return Err(missing_git()),
                            crate::worktrees::linked::HttpSnapshot::NonGit => {
                                return Err(bad("Workspace is not a Git repository"));
                            }
                            crate::worktrees::linked::HttpSnapshot::Git(cat) => cat,
                        };
                    }
                }
            }
        }
    }
    let tree = cat.get(slug)?;
    if !tree.direct_folder() {
        return Err(error(Status::NOT_FOUND, "Worktree folder is missing"));
    }
    Ok((crate::worktrees::linked::scope(w, tree), tree.clone()))
}
pub fn sha(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
fn notify(app: &crate::App, w: &Workspace) {
    app.emit(json!({"type":"workspace.filesChanged","workspaceId":w.id,"changes":[{"directory":w.path,"path":"."}]}));
}
#[derive(Deserialize)]
pub struct Paths {
    paths: Vec<String>,
}
pub async fn stage(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Json(body): Json<Paths>,
) -> Result<Json<Value>, Error> {
    paths(app, id, slug, body.paths, true).await
}
pub async fn unstage(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Json(body): Json<Paths>,
) -> Result<Json<Value>, Error> {
    paths(app, id, slug, body.paths, false).await
}
async fn apply_paths_with(
    dir: &Path,
    stage: bool,
    validated: &[String],
    verify_live: impl Fn() -> Result<(), Error>,
    configure: impl Fn(&mut Command),
) -> Result<(), Error> {
    let args: &[&str] = if stage {
        &["add", "--pathspec-from-file=-", "--pathspec-file-nul"]
    } else {
        let mut head_cmd = user_command::literal_command(dir, &["rev-parse", "--verify", "HEAD"]);
        configure(&mut head_cmd);
        if user_command::execute(head_cmd).await?.code == 0 {
            &["restore", "--staged", "--pathspec-from-file=-", "--pathspec-file-nul"]
        } else {
            &["rm", "--cached", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"]
        }
    };
    verify_live()?;
    let mut stdin_bytes = Vec::with_capacity(validated.iter().map(|p| p.len() + 1).sum());
    for path in validated {
        stdin_bytes.extend_from_slice(path.as_bytes());
        stdin_bytes.push(0);
    }
    let mut cmd = user_command::literal_command(dir, args);
    configure(&mut cmd);
    user_command::execute_with_stdin(cmd, stdin_bytes).await?.mutation()
}

async fn paths(app: Shared, id: String, slug: String, items: Vec<String>, stage: bool) -> Result<Json<Value>, Error> {
    if items.is_empty() {
        return Err(bad("Invalid path count"));
    }
    let (w, tree) = repo_target(&app, &id, &slug).await?;
    let admitted = crate::worktrees::fence::admit(&[crate::worktrees::fence::identity(tree.registered())])?;
    app.workspace(&id)?;
    files::root(&w)?;
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    let mut validated = Vec::with_capacity(items.len());
    for p in items {
        let p = files::relative(p.trim(), false)?;
        crate::files::links::guard(&w.path, &p)?;
        // A link is staged as a link (Git's own rule); only folders are refused.
        if std::fs::symlink_metadata(crate::files::links::target(&w.path, &p)).is_ok_and(|m| m.is_dir()) {
            return Err(bad("Staging requires individual files"));
        }
        if seen.insert(p.clone()) {
            validated.push(p);
        }
    }
    tokio::spawn(async move {
        let _admitted = admitted;
        let root = user_command::run(&w.path, &["rev-parse", "--show-toplevel"]).await?;
        if root.code != 0
            || dunce::canonicalize(root.text().trim_end_matches(['\r', '\n'])).as_deref().ok()
                != Some(tree.registered())
            || !tree.contains_live(&w.path)
            || app.workspace(&id).is_err()
        {
            return Err(conflict("Worktree changed"));
        }
        apply_paths_with(
            &w.path,
            stage,
            &validated,
            || {
                if !tree.contains_live(&w.path) || app.workspace(&id).is_err() {
                    return Err(conflict("Worktree changed"));
                }
                Ok(())
            },
            |_| {},
        )
        .await?;
        notify(&app, &w);
        Ok(Json(json!({"ok":true})))
    })
    .await
    .map_err(|_| conflict("Git outcome unavailable"))?
}
#[derive(Deserialize)]
pub struct Commit {
    message: String,
}
pub async fn commit(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Json(body): Json<Commit>,
) -> Result<Json<Value>, Error> {
    let message = body.message.trim();
    if message.is_empty() || message.len() > 16384 || message.contains('\0') {
        return Err(bad("Invalid commit message"));
    }
    let (w, tree) = repo_target(&app, &id, &slug).await?;
    let admitted = crate::worktrees::fence::admit(&[crate::worktrees::fence::identity(tree.registered())])?;
    app.workspace(&id)?;
    if !tree.contains_live(&w.path) {
        return Err(error(Status::CONFLICT, "Worktree changed"));
    }
    let message = message.to_owned();
    tokio::spawn(async move {
        let _admitted = admitted;
        let root = user_command::run(&w.path, &["rev-parse", "--show-toplevel"]).await?.ok()?;
        if dunce::canonicalize(root.text().trim()).as_deref().ok() != Some(tree.registered())
            || !tree.contains_live(&w.path)
            || app.workspace(&id).is_err()
        {
            return Err(conflict("Worktree changed"));
        }
        user_command::run(&w.path, &["commit", "-m", &message]).await?.mutation()?;
        notify(&app, &w);
        let mut ack = json!({"ok":true});
        if let Ok(head) = user_command::run(&w.path, &["rev-parse", "HEAD"]).await
            && head.code == 0
            && sha(head.text().trim())
        {
            ack["commitSha"] = json!(head.text().trim());
        }
        Ok(Json(ack))
    })
    .await
    .map_err(|_| conflict("Git outcome unavailable"))?
}
#[derive(Deserialize)]
pub struct Init {
    directory: String,
}
pub async fn init(
    State(app): State<Shared>,
    Route(id): Route<String>,
    Json(body): Json<Init>,
) -> Result<Json<Value>, Error> {
    let w = app.workspace(&id)?;
    let mismatch =
        || coded(Status::CONFLICT, "Only the opened folder can be initialized", "git_init_directory_mismatch");
    files::directory(&w, Some(&body.directory)).map_err(|_| mismatch())?;
    let identity = files::host_identity(&w.path).map_err(|_| mismatch())?;
    let _admitted = crate::worktrees::fence::admit(&[crate::worktrees::fence::identity(&w.path)])?;
    let exists = || coded(Status::CONFLICT, "Folder already belongs to a Git repository", "git_init_repository_exists");
    match worktrees::root_only(&w).await? {
        None => return Err(exists()),
        Some(false) => return Err(missing_git()),
        Some(true) => {}
    }
    let native = w.location["directory"].as_str().ok_or_else(mismatch)?;
    let fail = || coded(Status::BAD_GATEWAY, "Git initialization failed", "git_init_failed");
    let current = app
        .native
        .get("/api/location")
        .query(&[("location[directory]", native)])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| fail())?
        .error_for_status()
        .map_err(|_| fail())?
        .json::<Value>()
        .await
        .map_err(|_| fail())?;
    let target = current["project"]["directory"].as_str().ok_or_else(mismatch)?;
    files::directory(&w, Some(target)).map_err(|_| mismatch())?;
    if files::host_identity(&w.path).ok().as_ref() != Some(&identity) {
        return Err(mismatch());
    }
    let _invalidate = worktrees::linked::blocking_invalidation(&app);
    let response = app
        .native
        .request(reqwest::Method::POST, app.native.url().join("/api/vcs/init").unwrap())
        .query(&[("location[directory]", native), ("provider", "git")])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| fail())?;
    match response.status().as_u16() {
        200..=299 => {
            worktrees::linked::invalidate_blocking(&app);
            notify(&app, &w);
            worktrees::linked::emit_worktrees_changed(&app, w.id);
            Ok(Json(json!({"ok":true})))
        }
        409 => Err(exists()),
        501 => Err(coded(Status::NOT_IMPLEMENTED, "Git initialization is unsupported", "git_init_unsupported")),
        _ => Err(fail()),
    }
}

/// Both sides of one file diff: base64 images, else text unless either side holds a NUL.
fn sides(out: &mut Value, image: Option<&str>, before: Option<Vec<u8>>, after: Option<Vec<u8>>) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    if let Some(mime) = image {
        out["isBinary"] = json!(true);
        out["image"] = json!({"mime": mime, "before": before.map(|b| STANDARD.encode(b)), "after": after.map(|b| STANDARD.encode(b))});
        return;
    }
    let (before, after) = (before.unwrap_or_default(), after.unwrap_or_default());
    if before.contains(&0) || after.contains(&0) {
        out["isBinary"] = json!(true);
    } else {
        out["before"] = json!(String::from_utf8_lossy(&before));
        out["after"] = json!(String::from_utf8_lossy(&after));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{App, auth, opencode, settings};
    use axum::{Router, extract::Request, http::Method, response::IntoResponse, routing::any};
    use std::{path::PathBuf, process::Command as StdCommand, sync::Arc};
    use uuid::Uuid;

    struct FixtureGuard {
        dir: PathBuf,
        http: tokio::task::JoinHandle<()>,
    }

    impl Drop for FixtureGuard {
        fn drop(&mut self) {
            self.http.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn fake_native(State(root): State<PathBuf>, request: Request) -> impl IntoResponse {
        match (request.method().clone(), request.uri().path()) {
            (Method::GET, "/api/location") => {
                let requested = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                    .ok()
                    .and_then(|url| {
                        url.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned())
                    })
                    .unwrap_or_else(|| root.to_string_lossy().into_owned());
                Json(json!({
                    "directory": requested,
                    "project": { "id": "project_fixture", "directory": root, "canonical": root },
                }))
                .into_response()
            }
            (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
            (Method::GET, "/api/worktree") => Json(json!([{"directory": root}])).into_response(),
            _ => Status::NOT_IMPLEMENTED.into_response(),
        }
    }

    fn raw_git(dir: &Path, args: &[&str]) -> Vec<u8> {
        let mut cmd = StdCommand::new("git");
        cmd.arg("-C").arg(dir).args(args);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        let out = cmd
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    #[tokio::test]
    async fn local_lfs_filter_allows_stage_unstage_and_commit_while_reads_stay_guarded() {
        let dir = crate::shared::test_dir("git-local-lfs-config");
        let repo_dir = dir.join("repo");
        let empty_hooks = dir.join("empty-hooks");
        std::fs::create_dir_all(&repo_dir).unwrap();
        std::fs::create_dir_all(&empty_hooks).unwrap();
        raw_git(&repo_dir, &["init", "-q"]);
        raw_git(&repo_dir, &["config", "user.name", "tester"]);
        raw_git(&repo_dir, &["config", "user.email", "tester@example.com"]);
        raw_git(&repo_dir, &["config", "commit.gpgSign", "false"]);
        raw_git(&repo_dir, &["config", "core.hooksPath", empty_hooks.to_str().unwrap()]);
        let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:1111\nsize 18\n";
        raw_git(
            &repo_dir,
            &[
                "config",
                "filter.testlfs.clean",
                "printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:1111\\nsize 18\\n'",
            ],
        );
        raw_git(&repo_dir, &["config", "filter.testlfs.required", "true"]);
        std::fs::write(repo_dir.join(".gitattributes"), "*.bin filter=testlfs -text\n").unwrap();
        std::fs::write(repo_dir.join("asset.bin"), b"\x00\x01LOCAL-LFS-PAYLOAD\xff").unwrap();

        let root = dunce::canonicalize(&repo_dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = opencode::Native::test_connection(listener.local_addr().unwrap());
        let stub_root = root.clone();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(stub_root)).await.unwrap()
        });
        let _guard = FixtureGuard { dir: dir.clone(), http };

        let auth = auth::Auth::new(auth::Settings {
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
        let settings =
            settings::Settings::new(settings::document::Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            root.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
            None,
        ));
        let id = Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id,
            request_id: None,
            path: root.clone(),
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": root}),
            temporary: None,
        });
        let id_str = id.to_string();

        // Passive status read succeeds on a repo with local LFS filter without executing the filter.
        let marker = dir.join("passive-filter-ran");
        raw_git(
            &repo_dir,
            &[
                "config",
                "filter.testlfs.smudge",
                &format!("sh -c 'touch \"{}\" && cat'", marker.to_string_lossy().replace('\\', "/")),
            ],
        );
        let status_rows = status_read::status(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert!(
            status_rows.as_array().unwrap().iter().any(|r| r["path"] == "asset.bin"),
            "status must include asset.bin: {status_rows}"
        );
        assert!(!marker.exists(), "passive status read must neutralize local filter drivers");

        // Explicit stage honors the local LFS filter and indexes the pointer, not raw binary bytes.
        assert_eq!(
            stage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: vec!["asset.bin".into()] }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        assert_eq!(raw_git(&repo_dir, &["cat-file", "-p", ":asset.bin"]), pointer.as_bytes());

        // Explicit unstage succeeds on the same locally configured repository.
        assert_eq!(
            unstage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: vec!["asset.bin".into()] }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        assert!(raw_git(&repo_dir, &["ls-files", "--cached"]).is_empty());

        // Re-stage and commit through the explicit mutation routes.
        assert_eq!(
            stage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: vec!["asset.bin".into()] }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        let committed = commit(
            State(app.clone()),
            Route((id_str, "root".into())),
            Json(Commit { message: "add lfs asset".into() }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(committed["ok"], true);
        assert!(committed["commitSha"].as_str().is_some_and(sha), "{committed}");
        assert_eq!(raw_git(&repo_dir, &["show", "HEAD:asset.bin"]), pointer.as_bytes());
    }

    #[test]
    fn read_command_preserves_global_and_system_git_config() {
        let dir = crate::shared::test_dir("git-read-preserves-config");
        let cmd = command(&dir, &["rev-parse", "--show-toplevel"]);
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|s| s.to_string_lossy().into_owned())))
            .collect();
        for forbidden_override in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM"]
        {
            assert!(
                !envs.iter().any(|(k, _)| k.eq_ignore_ascii_case(forbidden_override)),
                "git::command must not override or strip {forbidden_override}: {envs:?}"
            );
        }
        assert!(
            envs.iter().any(|(k, v)| k == "GIT_TERMINAL_PROMPT" && v.as_deref() == Some("0")),
            "git::command must keep GIT_TERMINAL_PROMPT=0"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn build_git_fixture(label: &str, repo_dir: &Path) -> (Shared, String, FixtureGuard) {
        let dir = repo_dir.parent().unwrap().to_path_buf();
        let root = dunce::canonicalize(repo_dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = opencode::Native::test_connection(listener.local_addr().unwrap());
        let stub_root = root.clone();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(stub_root)).await.unwrap()
        });
        let guard = FixtureGuard { dir: dir.clone(), http };
        let auth = auth::Auth::new(auth::Settings {
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
        let settings =
            settings::Settings::new(settings::document::Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            root.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
            None,
        ));
        let id = Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id,
            request_id: None,
            path: root.clone(),
            name: Some(label.into()),
            status: "running",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": root}),
            temporary: None,
        });
        (app, id.to_string(), guard)
    }

    #[tokio::test]
    async fn common_repos_with_include_if_worktree_config_partial_clone_and_alternates_read_cleanly() {
        let _serial = test_git_serial().await;
        let dir = crate::shared::test_dir("git-m4-common-repos");
        let origin_dir = dir.join("origin");
        let clone_dir = dir.join("shared-clone");
        let included = dir.join("conditional.gitconfig");
        let marker = dir.join("filter-executed");
        let gpg_marker = dir.join("gpg-executed");
        std::fs::create_dir_all(&origin_dir).unwrap();

        raw_git(&origin_dir, &["init", "-q"]);
        raw_git(&origin_dir, &["config", "user.name", "test"]);
        raw_git(&origin_dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(origin_dir.join("file.txt"), "hello\n").unwrap();
        std::fs::write(origin_dir.join(".gitattributes"), "*.txt filter=cond -text\n").unwrap();
        raw_git(&origin_dir, &["add", "."]);
        raw_git(&origin_dir, &["commit", "-q", "-m", "initial"]);

        // Create a commit with a synthetic `gpgsig` header so `log.showSignature=true` would invoke `gpg.program`.
        let tree_oid =
            String::from_utf8(raw_git(&origin_dir, &["rev-parse", "HEAD^{tree}"])).unwrap().trim().to_owned();
        let parent_oid = String::from_utf8(raw_git(&origin_dir, &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
        let signed_commit_raw = format!(
            "tree {tree_oid}\nparent {parent_oid}\nauthor test <test@example.com> 1700000000 +0000\ncommitter test <test@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\nsigned commit\n"
        );
        let mut hash_cmd = std::process::Command::new("git");
        hash_cmd
            .arg("-C")
            .arg(&origin_dir)
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = hash_cmd.spawn().unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), signed_commit_raw.as_bytes()).unwrap();
        let hash_out = child.wait_with_output().unwrap();
        assert!(hash_out.status.success(), "{}", String::from_utf8_lossy(&hash_out.stderr));
        let signed_oid = String::from_utf8(hash_out.stdout).unwrap().trim().to_owned();
        raw_git(&origin_dir, &["reset", "--hard", "-q", &signed_oid]);

        // Clone with `--shared` to create `.git/objects/info/alternates`.
        raw_git(&dir, &["clone", "--quiet", "--shared", origin_dir.to_str().unwrap(), clone_dir.to_str().unwrap()]);
        assert!(clone_dir.join(".git/objects/info/alternates").is_file(), "shared clone must create alternates");

        // Add an extra commit ONLY in `origin_dir` after cloning: present in alternates, unreachable from `clone_dir`.
        std::fs::write(origin_dir.join("secret.txt"), "origin-only\n").unwrap();
        raw_git(&origin_dir, &["add", "secret.txt"]);
        raw_git(&origin_dir, &["commit", "-q", "-m", "origin-only"]);
        let origin_only_oid =
            String::from_utf8(raw_git(&origin_dir, &["rev-parse", "HEAD"])).unwrap().trim().to_owned();

        // Configure `includeIf` (with `filter` + `log.showSignature` + executable `gpg.program`),
        // `extensions.worktreeConfig`, `config.worktree` filter, and partial clone promisor.
        let marker_posix = marker.to_string_lossy().replace('\\', "/");
        #[cfg(windows)]
        let fake_gpg = {
            let script = dir.join("fake-gpg.cmd");
            std::fs::write(&script, format!("@echo off\r\necho ran > \"{}\"\r\nexit /b 1\r\n", gpg_marker.display()))
                .unwrap();
            script
        };
        #[cfg(not(windows))]
        let fake_gpg = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("fake-gpg.sh");
            std::fs::write(&script, format!("#!/bin/sh\ntouch \"{}\"\nexit 1\n", gpg_marker.display())).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        };
        let fake_gpg_posix = fake_gpg.to_string_lossy().replace('\\', "/");
        std::fs::write(
            &included,
            format!(
                "[filter \"cond\"]\n\tclean = sh -c 'touch \"{marker_posix}\" && cat'\n\trequired = true\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = {fake_gpg_posix}\n"
            ),
        )
        .unwrap();
        let clone_posix = clone_dir.to_string_lossy().replace('\\', "/");
        raw_git(
            &clone_dir,
            &[
                "config",
                &format!("includeIf.gitdir:{clone_posix}/.path"),
                &included.to_string_lossy().replace('\\', "/"),
            ],
        );
        raw_git(&clone_dir, &["config", "extensions.worktreeConfig", "true"]);
        raw_git(
            &clone_dir,
            &["config", "--worktree", "filter.wt.clean", &format!("sh -c 'touch \"{marker_posix}\" && cat'")],
        );
        raw_git(&clone_dir, &["config", "extensions.partialClone", "origin"]);
        raw_git(&clone_dir, &["config", "remote.origin.promisor", "true"]);
        raw_git(&clone_dir, &["config", "user.name", "test"]);
        raw_git(&clone_dir, &["config", "user.email", "test@example.com"]);

        // Positive control for the `includeIf` filter driver via plain `git add`.
        std::fs::write(clone_dir.join("rebased.txt"), "mid\n").unwrap();
        raw_git(&clone_dir, &["add", "rebased.txt"]);
        assert!(marker.exists(), "positive control: plain git add must execute includeIf filter");
        let mid_tree = String::from_utf8(raw_git(&clone_dir, &["write-tree"])).unwrap().trim().to_owned();
        let clone_base_oid = String::from_utf8(raw_git(&clone_dir, &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
        // Create `clone_mid_oid` + `clone_rebased_oid` with `commit-tree` and advance HEAD directly to
        // `clone_rebased_oid`, then reset back: `clone_mid_oid` never enters `HEAD` reflog directly and
        // is reachable ONLY as an ancestor of `clone_rebased_oid` in the `HEAD` reflog.
        let clone_mid_oid = String::from_utf8(raw_git(
            &clone_dir,
            &["commit-tree", &mid_tree, "-p", &clone_base_oid, "-m", "mid-not-in-reflog"],
        ))
        .unwrap()
        .trim()
        .to_owned();
        let clone_rebased_oid = String::from_utf8(raw_git(
            &clone_dir,
            &["commit-tree", &mid_tree, "-p", &clone_mid_oid, "-m", "tip-in-reflog"],
        ))
        .unwrap()
        .trim()
        .to_owned();
        raw_git(&clone_dir, &["reset", "--hard", "-q", &clone_rebased_oid]);
        raw_git(&clone_dir, &["reset", "--hard", "-q", &clone_base_oid]);
        let reflog_entries =
            String::from_utf8(raw_git(&clone_dir, &["log", "--no-show-signature", "-g", "--format=%H", "HEAD"]))
                .unwrap();
        assert!(
            !reflog_entries.lines().any(|line| line.trim() == clone_mid_oid),
            "clone_mid_oid must not be a direct HEAD reflog entry"
        );
        let _ = std::fs::remove_file(&marker);

        std::fs::write(clone_dir.join("file.txt"), "hello updated\n").unwrap();

        let (app, id_str, _guard) = build_git_fixture("m4-common", &clone_dir).await;
        let status = status_read::status(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert!(
            status.as_array().unwrap().iter().any(|r| r["path"] == "file.txt" && r["unstagedStatus"] == "modified"),
            "status must report modified file.txt: {status}"
        );
        let diff = status_read::diff(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({"path": "file.txt", "scope": "unstaged"})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(diff["before"], "hello\n");
        assert_eq!(diff["after"], "hello updated\n");
        let hist = history::history(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(hist["commits"].as_array().unwrap().len(), 2);
        let details = history::commit_details(
            State(app.clone()),
            Route((id_str.clone(), "root".into(), signed_oid.clone())),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(details["id"], signed_oid);

        // Pinned pagination anchor AND intermediate ancestor commits from this clone's HEAD reflog stay readable.
        let rebased_hist = history::history(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({"head": clone_rebased_oid})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(rebased_hist["head"], clone_rebased_oid);
        let mid_details = history::commit_details(
            State(app.clone()),
            Route((id_str.clone(), "root".into(), clone_mid_oid.clone())),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(mid_details["id"], clone_mid_oid);

        // Unreachable commit present only in alternate object store must be rejected on both history routes.
        let alt_hist = history::history(
            State(app.clone()),
            Route((id_str.clone(), "root".into())),
            axum::extract::Query(serde_json::from_value(json!({"head": origin_only_oid})).unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(alt_hist.0, Status::BAD_REQUEST, "unreachable alternate head must be rejected");
        let alt_details = history::commit_details(
            State(app.clone()),
            Route((id_str, "root".into(), origin_only_oid)),
            axum::extract::Query(serde_json::from_value(json!({})).unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(alt_details.0, Status::BAD_REQUEST, "unreachable alternate commit must be rejected");

        assert!(!marker.exists(), "passive Git reads must never execute included or worktree filter drivers");
        assert!(!gpg_marker.exists(), "passive Git history reads must never invoke gpg.program via log.showSignature");

        // Positive control: plain `git log` in `clone_dir` DOES execute `fake_gpg` via included `log.showSignature=true`.
        let control =
            std::process::Command::new("git").arg("-C").arg(&clone_dir).args(["log", "-n", "1"]).output().unwrap();
        assert!(control.status.success(), "{}", String::from_utf8_lossy(&control.stderr));
        assert!(gpg_marker.exists(), "positive control must confirm included log.showSignature invokes fake-gpg");

        // Non-alternates repo: pinned pagination anchor after reset (even with reflog expired) stays readable like TS.
        std::fs::write(origin_dir.join("detached.txt"), "v1\n").unwrap();
        raw_git(&origin_dir, &["add", "detached.txt"]);
        raw_git(&origin_dir, &["commit", "-q", "-m", "to-be-rebased"]);
        let origin_rebased_oid =
            String::from_utf8(raw_git(&origin_dir, &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
        raw_git(&origin_dir, &["reset", "--hard", "-q", "HEAD~1"]);
        raw_git(&origin_dir, &["reflog", "expire", "--expire=now", "--all"]);
        let (origin_app, origin_id, _origin_guard) = build_git_fixture("m4-origin", &origin_dir).await;
        let origin_page = history::history(
            State(origin_app),
            Route((origin_id, "root".into())),
            axum::extract::Query(serde_json::from_value(json!({"head": origin_rebased_oid})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(origin_page["head"], origin_rebased_oid);
    }

    #[tokio::test]
    async fn stage_and_unstage_handle_more_than_256_paths_above_16kb() {
        let _serial = test_git_serial().await;
        let dir = crate::shared::test_dir("git-m13-many-paths");
        let repo_dir = dir.join("repo");
        let nested = repo_dir.join("deeply_nested_directory_segment_for_path_budget_testing");
        std::fs::create_dir_all(&nested).unwrap();
        raw_git(&repo_dir, &["init", "-q"]);
        raw_git(&repo_dir, &["config", "user.name", "test"]);
        raw_git(&repo_dir, &["config", "user.email", "test@example.com"]);

        let mut file_paths = Vec::with_capacity(320);
        for i in 0..320 {
            let rel = format!("deeply_nested_directory_segment_for_path_budget_testing/item_{i:04}.txt");
            std::fs::write(repo_dir.join(&rel), format!("v1-{i}\n")).unwrap();
            file_paths.push(rel);
        }
        assert!(file_paths.len() > 256);
        assert!(file_paths.iter().map(String::len).sum::<usize>() > 16_000);

        let (app, id_str, _guard) = build_git_fixture("m13-many", &repo_dir).await;

        // 1. Stage > 256 paths (> 16 KiB total) without HEAD.
        assert_eq!(
            stage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: file_paths.clone() }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        let staged = String::from_utf8(raw_git(&repo_dir, &["ls-files", "--cached"])).unwrap();
        assert_eq!(staged.lines().count(), 320);

        // 2. Unstage > 256 paths without HEAD (`git rm --cached --pathspec-from-file=-`).
        assert_eq!(
            unstage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: file_paths.clone() }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        assert!(raw_git(&repo_dir, &["ls-files", "--cached"]).is_empty());

        // 3. Re-stage, commit, modify all 320, re-stage, and unstage with HEAD (`git restore --staged --pathspec-from-file=-`).
        assert_eq!(
            stage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: file_paths.clone() })
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        assert_eq!(
            commit(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Commit { message: "add 320 files".into() }),
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        for (i, rel) in file_paths.iter().enumerate() {
            std::fs::write(repo_dir.join(rel), format!("v2-{i}\n")).unwrap();
        }
        assert_eq!(
            stage(
                State(app.clone()),
                Route((id_str.clone(), "root".into())),
                Json(Paths { paths: file_paths.clone() })
            )
            .await
            .unwrap()
            .0["ok"],
            true
        );
        let staged_diff = String::from_utf8(raw_git(&repo_dir, &["diff", "--cached", "--name-only"])).unwrap();
        assert_eq!(staged_diff.lines().count(), 320);

        assert_eq!(
            unstage(State(app.clone()), Route((id_str, "root".into())), Json(Paths { paths: file_paths }))
                .await
                .unwrap()
                .0["ok"],
            true
        );
        let staged_after = String::from_utf8(raw_git(&repo_dir, &["diff", "--cached", "--name-only"])).unwrap();
        assert!(staged_after.is_empty(), "all 320 modified files must be unstaged");
    }
}
