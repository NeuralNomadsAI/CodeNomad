//! Git of an owned checkout. Probes use bounded slots; explicit mutations use
//! the user's Git configuration.
mod branches;
mod config_guard;
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
    pub fn stderr_contains(&self, needle: &str) -> bool {
        String::from_utf8_lossy(&self.err).contains(needle)
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
    #[cfg(test)]
    crate::worktrees::fence_test_trace::record("git semaphore", "waiting");
    let _slot = SLOTS.acquire().await.unwrap();
    #[cfg(test)]
    let _trace = crate::worktrees::fence_test_trace::held("git semaphore");
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
    Ok(repo_target(app, id, slug, true).await?.0)
}

async fn repo_target(
    app: &crate::App,
    id: &str,
    slug: &str,
    guard: bool,
) -> Result<(Workspace, crate::worktrees::linked::Tree), Error> {
    let w = app.workspace(id)?;
    let local = match crate::worktrees::linked::probe_root_checkout(&w).await? {
        crate::worktrees::linked::RootCheckout::MissingGit => return Err(missing_git()),
        crate::worktrees::linked::RootCheckout::NonGit => return Err(bad("Workspace is not a Git repository")),
        crate::worktrees::linked::RootCheckout::Git(res) => *res?,
    };
    let cat = crate::worktrees::linked::catalogue_with_local(app, &w, false, local).await?;
    if guard {
        guard_config(&cat.main).await?;
    }
    let tree = cat.get(slug)?;
    if !tree.direct_folder() {
        return Err(error(Status::NOT_FOUND, "Worktree folder is missing"));
    }
    // The directory Git runs in may read its own `config.worktree`.
    if guard && tree.path != cat.main {
        config_guard::effective(&tree.path).await?;
    }
    Ok((crate::worktrees::linked::scope(w, tree), tree.clone()))
}
pub async fn guard_config(main: &Path) -> Result<(), Error> {
    for path in [".git/objects/info/alternates", ".git/objects/info/http-alternates"] {
        if !matches!(std::fs::symlink_metadata(main.join(path)),Err(e) if e.kind()==io::ErrorKind::NotFound) {
            return Err(error(Status::FORBIDDEN, "Repository uses external object storage"));
        }
    }
    // Config capable of executing external filters (or importing more
    // config) is out of scope for passive Git reads and linked worktree lifecycle commands.
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
async fn apply_paths_with(
    dir: &Path,
    stage: bool,
    validated: &[String],
    verify_live: impl Fn() -> Result<(), Error>,
    configure: impl Fn(&mut Command),
) -> Result<(), Error> {
    let mut args = if stage {
        vec!["add", "--"]
    } else {
        let mut head_cmd = user_command::literal_command(dir, &["rev-parse", "--verify", "HEAD"]);
        configure(&mut head_cmd);
        if user_command::execute(head_cmd).await?.code == 0 {
            vec!["restore", "--staged", "--"]
        } else {
            vec!["rm", "--cached", "--quiet", "--"]
        }
    };
    verify_live()?;
    args.extend(validated.iter().map(String::as_str));
    let mut cmd = user_command::literal_command(dir, &args);
    configure(&mut cmd);
    user_command::execute(cmd).await?.mutation()
}

async fn paths(app: Shared, id: String, slug: String, items: Vec<String>, stage: bool) -> Result<Json<Value>, Error> {
    if items.is_empty() || items.len() > 256 {
        return Err(bad("Invalid path count"));
    }
    let (w, tree) = repo_target(&app, &id, &slug, false).await?;
    let admitted = crate::worktrees::fence::admit(&[crate::worktrees::fence::identity(tree.registered())])?;
    app.workspace(&id)?;
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
    let (w, tree) = repo_target(&app, &id, &slug, false).await?;
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
        });
        let id_str = id.to_string();

        // Passive reads stay protected by `config_guard` against unqualified local filters.
        let Err(read_err) = repo(&app, &id_str, "root").await else {
            panic!("expected passive read to be refused for unqualified local filter");
        };
        assert_eq!(read_err.0, Status::FORBIDDEN);

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
}
