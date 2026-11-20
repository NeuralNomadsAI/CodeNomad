//! Git display and mutations of an owned checkout, every command under an admitted
//! configuration (`config_guard`), a bounded output and a shared slot.
mod config_guard;
mod history;
mod status_read;

pub fn routes() -> axum::Router<Shared> {
    use axum::routing::{get, post};
    axum::Router::new()
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
pub struct Output {
    pub code: i32,
    pub bytes: Vec<u8>,
    err: Vec<u8>,
}
impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    pub fn ok(self) -> Result<Self, Error> {
        if self.code == 0 { Ok(self) } else { Err(bad("Git read failed")) }
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
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LITERAL_PATHSPECS", "1");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}
pub async fn run(dir: &Path, args: &[&str], max: usize) -> Result<Output, Error> {
    let _slot = SLOTS.acquire().await.unwrap();
    let mut child = command(dir, args)
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
pub async fn repo(app: &crate::App, id: &str, slug: &str) -> Result<Workspace, Error> {
    let w = app.workspace(id)?;
    match worktrees::root_only(&w).await? {
        Some(false) => return Err(missing_git()),
        Some(true) => return Err(bad("Workspace is not a Git repository")),
        None => {}
    }
    let cat = crate::worktrees::linked::catalogue(app, &w, false).await?;
    guard_config(&cat.main).await?;
    let tree = cat.get(slug)?;
    if tree.nested_missing {
        return Err(error(Status::NOT_FOUND, "Worktree folder is missing"));
    }
    // The directory Git runs in may read its own `config.worktree`.
    if tree.path != cat.main {
        config_guard::effective(&tree.path).await?;
    }
    Ok(crate::worktrees::linked::scope(w, tree))
}
pub async fn guard_config(main: &Path) -> Result<(), Error> {
    for path in [".git/objects/info/alternates", ".git/objects/info/http-alternates"] {
        if !matches!(std::fs::symlink_metadata(main.join(path)),Err(e) if e.kind()==io::ErrorKind::NotFound) {
            return Err(error(Status::FORBIDDEN, "Repository uses external object storage"));
        }
    }
    // Config capable of executing external filters (or importing more
    // config) is out of scope. Never start a Git display/mutation with it.
    config_guard::effective(main).await?;
    config_guard::submodules(main).await
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
async fn paths(app: Shared, id: String, slug: String, items: Vec<String>, stage: bool) -> Result<Json<Value>, Error> {
    if items.is_empty() || items.len() > 256 {
        return Err(bad("Invalid path count"));
    }
    let _guard = app.project_mutation.lock().await;
    let w = repo(&app, &id, &slug).await?;
    files::root(&w)?;
    let mut validated = Vec::new();
    for p in items {
        let p = files::relative(p.trim(), false)?;
        crate::files::links::guard(&w.path, &p)?;
        // A link is staged as a link (Git's own rule); only folders are refused.
        if std::fs::symlink_metadata(crate::files::links::target(&w.path, &p)).is_ok_and(|m| m.is_dir()) {
            return Err(bad("Staging requires individual files"));
        }
        if !validated.contains(&p) {
            validated.push(p);
        }
    }
    if validated.iter().map(String::len).sum::<usize>() > 16000 {
        return Err(bad("Git paths exceed limit"));
    }
    let mut args = if stage {
        vec!["add", "--"]
    } else if run(&w.path, &["rev-parse", "--verify", "HEAD"], 1024).await?.code == 0 {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "--quiet", "--"]
    };
    args.extend(validated.iter().map(String::as_str));
    run(&w.path, &args, 64 * 1024).await?.mutation()?;
    notify(&app, &w);
    Ok(Json(json!({"ok":true})))
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
    let _guard = app.project_mutation.lock().await;
    let w = repo(&app, &id, &slug).await?;
    run(&w.path, &["commit", "-m", message], 64 * 1024).await?.mutation()?;
    notify(&app, &w);
    let mut ack = json!({"ok":true});
    if let Ok(head) = run(&w.path, &["rev-parse", "HEAD"], 1024).await
        && head.code == 0
        && sha(head.text().trim())
    {
        ack["commitSha"] = json!(head.text().trim());
    }
    Ok(Json(ack))
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
    let _guard = app.project_mutation.lock().await;
    let w = app.workspace(&id)?;
    let mismatch =
        || coded(Status::CONFLICT, "Only the opened folder can be initialized", "git_init_directory_mismatch");
    files::directory(&w, Some(&body.directory)).map_err(|_| mismatch())?;
    let identity = files::host_identity(&w.path).map_err(|_| mismatch())?;
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
            notify(&app, &w);
            app.emit(json!({"type":"workspace.worktreesChanged","workspaceId":w.id}));
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
