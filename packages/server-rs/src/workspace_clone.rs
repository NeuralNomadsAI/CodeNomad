//! `POST /api/workspaces/clone`: strict local HTTP Git repository cloning with
//! destination safety checks, scope enforcement, hook-free execution, and
//! transactional replacement when `cleanup` is enabled (TS `workspaces/git-clone.ts`).
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
};

use axum::{
    Extension, Json,
    body::Body,
    extract::{Request, State},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use uuid::Uuid;

use crate::{
    App, Error, Shared, auth, error,
    files::{browse, paths},
    git,
    settings::document::home,
    shared::{fastify, js_space},
    worktrees::fence,
};

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

struct CloneRequest {
    repository_url: String,
    destination_path: String,
    cleanup: bool,
}

fn bad(msg: impl AsRef<str>) -> Error {
    error(Status::BAD_REQUEST, msg.as_ref())
}

fn conflict(msg: impl AsRef<str>) -> Error {
    error(Status::CONFLICT, msg.as_ref())
}

fn internal(msg: impl AsRef<str>) -> Error {
    error(Status::INTERNAL_SERVER_ERROR, msg.as_ref())
}

/// `POST /api/workspaces/clone`
/// Strict local body `{ repositoryUrl, destinationPath, cleanup? }` and empty query.
pub async fn clone(
    State(app): State<Shared>,
    Extension(principal): Extension<auth::Principal>,
    request: Request<Body>,
) -> Result<Response, Error> {
    principal.live()?;
    let (parts, body) = request.into_parts();

    // `WorkspaceCreationQuerySchema = z.object({}).strict()`: reject any query parameter before host work.
    if parts.uri.query().is_some_and(|q| !q.is_empty()) {
        return Err(bad("Unexpected query parameters"));
    }

    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES).await.map_err(|_| {
        fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
    })?;
    let parsed = match fastify::body(&parts.headers, &bytes)? {
        Some(fastify::Body::Json(value)) => value,
        None => json!({}),
        Some(fastify::Body::Text(_)) => return Err(bad("Invalid clone request body")),
    };
    let input = parse_request(parsed)?;
    validate_repository_url(&app, &input.repository_url)?;
    let destination = resolve_destination(&app, &input.destination_path)?;

    // Detach the filesystem + git execution onto a spawned task so a mid-flight
    // client disconnect never aborts a transactional backup/replace swap halfway.
    let repo_url = input.repository_url;
    let cleanup = input.cleanup;
    let scope = app.scope.clone();
    let unrestricted = app.unrestricted;
    let cloned = tokio::spawn(async move { execute_clone(repo_url, destination, cleanup, scope, unrestricted).await })
        .await
        .map_err(|_| internal("Clone task failed unexpectedly"))??;

    Ok((Status::CREATED, Json(json!({ "path": cloned.to_string_lossy() }))).into_response())
}

fn parse_request(value: Value) -> Result<CloneRequest, Error> {
    let Some(map) = value.as_object() else {
        return Err(bad("Invalid clone request body"));
    };
    // Reject retired selector before reading other fields (TS `workspaces-retired-target.test.ts`).
    if map.contains_key("serverId") {
        return Err(bad("Unsupported workspace selector"));
    }
    for key in map.keys() {
        if !matches!(key.as_str(), "repositoryUrl" | "destinationPath" | "cleanup") {
            return Err(bad(format!("Unrecognized key in clone request: {key}")));
        }
    }
    let repository_url = map
        .get("repositoryUrl")
        .and_then(Value::as_str)
        .map(|s| s.trim_matches(js_space).to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("Repository URL is required"))?;
    let destination_path = map
        .get("destinationPath")
        .and_then(Value::as_str)
        .map(|s| s.trim_matches(js_space).to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("Destination path is required"))?;
    let cleanup = match map.get("cleanup") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(bad("Invalid cleanup option")),
    };
    Ok(CloneRequest { repository_url, destination_path, cleanup })
}

fn has_windows_network_or_device_prefix(raw: &str) -> bool {
    #[cfg(windows)]
    {
        raw.starts_with("\\\\")
            || raw.starts_with("//")
            || raw.starts_with("\\/")
            || raw.starts_with("/\\")
            || raw.starts_with("\\??\\")
    }
    #[cfg(not(windows))]
    {
        let _ = raw;
        false
    }
}

fn is_windows_drive_absolute(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

pub(crate) fn validate_repository_url(app: &App, url: &str) -> Result<(), Error> {
    if url.is_empty() {
        return Err(bad("Repository URL is required"));
    }
    if url.len() > 8192 || url.chars().any(char::is_control) {
        return Err(bad("Invalid repository URL"));
    }
    // Block Git option injection even though `--` is also passed.
    if url.starts_with('-') {
        return Err(bad("Invalid repository URL"));
    }
    // Block Git remote-helper syntax such as `ext::sh -c ...` or `fd::...`.
    if let Some((prefix, _)) = url.split_once("::")
        && !prefix.contains('/')
        && !prefix.contains('\\')
    {
        return Err(bad("Unsupported repository URL protocol"));
    }

    if let Some((scheme, _)) = url.split_once("://")
        && !scheme.contains('/')
        && !scheme.contains('\\')
    {
        let lower = scheme.to_ascii_lowercase();
        if !matches!(lower.as_str(), "https" | "http" | "ssh" | "git" | "file") {
            return Err(bad("Unsupported repository URL protocol"));
        }
        let parsed = reqwest::Url::parse(url).map_err(|_| bad("Invalid repository URL"))?;
        if matches!(lower.as_str(), "ssh" | "git") {
            if parsed.username().starts_with('-')
                || parsed.host_str().is_none_or(|h| h.is_empty() || h.starts_with('-'))
            {
                return Err(bad("Invalid repository URL"));
            }
        } else if matches!(lower.as_str(), "https" | "http") {
            if parsed.host_str().is_none_or(str::is_empty) {
                return Err(bad("Invalid repository URL"));
            }
        } else if lower == "file" {
            let local_path = parsed.to_file_path().map_err(|_| bad("Invalid repository URL"))?;
            let normalized = normalize_local_path(&local_path.to_string_lossy());
            if !paths::under(&app.scope, &normalized) {
                return Err(bad("Repository path is outside the authorized workspace root"));
            }
            if !app.unrestricted
                && let Ok(real) = dunce::canonicalize(&normalized)
                && !real.starts_with(&app.scope)
            {
                return Err(bad("Repository path is outside the authorized workspace root"));
            }
        }
        return Ok(());
    }

    // SCP-style SSH URL: `[user@]host:path` (not a Windows drive letter `C:\...` / `C:/...`).
    if let Some((left, right)) = url.split_once(':')
        && !(cfg!(windows) && left.len() == 1 && left.as_bytes()[0].is_ascii_alphabetic())
        && !left.contains('/')
        && !left.contains('\\')
    {
        if right.is_empty() || right.starts_with(':') || left.chars().any(char::is_whitespace) {
            return Err(bad("Invalid repository URL"));
        }
        let lower_left = left.to_ascii_lowercase();
        if matches!(
            lower_left.as_str(),
            "ext" | "fd" | "javascript" | "data" | "vbscript" | "blob" | "about" | "ftp" | "ftps"
        ) {
            return Err(bad("Unsupported repository URL protocol"));
        }
        let host = match left.split_once('@') {
            Some((user, host)) => {
                if user.is_empty() || user.starts_with('-') || host.is_empty() || host.starts_with('-') {
                    return Err(bad("Invalid repository URL"));
                }
                host
            }
            None => {
                if left.is_empty() || left.starts_with('-') {
                    return Err(bad("Invalid repository URL"));
                }
                left
            }
        };
        if host.is_empty() {
            return Err(bad("Invalid repository URL"));
        }
        return Ok(());
    }

    // Local filesystem repository path (used for local bare repos and tests).
    if has_windows_network_or_device_prefix(url) {
        return Err(bad("Invalid repository URL"));
    }
    let normalized = normalize_local_path(url);
    if !paths::under(&app.scope, &normalized) {
        return Err(bad("Repository path is outside the authorized workspace root"));
    }
    if !app.unrestricted
        && let Ok(real) = dunce::canonicalize(&normalized)
        && !real.starts_with(&app.scope)
    {
        return Err(bad("Repository path is outside the authorized workspace root"));
    }
    Ok(())
}

fn normalize_local_path(raw: &str) -> PathBuf {
    let mut normalized = browse::normalize(raw);
    let root = root_prefix(&normalized);
    if normalized != root {
        while normalized.ends_with(['/', '\\']) {
            normalized.pop();
            if normalized == root {
                break;
            }
        }
    }
    PathBuf::from(normalized)
}

fn root_prefix(path: &str) -> String {
    #[cfg(windows)]
    {
        let b = path.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
            return format!("{}:\\", path.as_bytes()[0] as char);
        }
        String::new()
    }
    #[cfg(not(windows))]
    {
        if path.starts_with('/') { "/".to_owned() } else { String::new() }
    }
}

fn normalize_for_comparison(path: &Path) -> String {
    let text = normalize_local_path(&path.to_string_lossy()).to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

pub(crate) fn resolve_destination(app: &App, requested: &str) -> Result<PathBuf, Error> {
    if requested.is_empty() {
        return Err(bad("Destination path is required"));
    }
    if requested.contains('\0') {
        return Err(bad("Invalid destination path"));
    }
    if has_windows_network_or_device_prefix(requested) {
        return Err(bad("Invalid destination path"));
    }
    let is_abs = if cfg!(windows) { is_windows_drive_absolute(requested) } else { requested.starts_with('/') };
    if !is_abs {
        return Err(bad("Destination path must be absolute"));
    }

    let destination = normalize_local_path(requested);
    let dest_str = destination.to_str().ok_or_else(|| bad("Invalid destination path"))?;
    if !paths::local_absolute(dest_str) {
        return Err(bad("Invalid destination path"));
    }

    let root = root_prefix(dest_str);
    if normalize_for_comparison(&destination) == normalize_for_comparison(Path::new(&root))
        || destination.parent().is_none()
    {
        return Err(bad("Destination path cannot be a filesystem root"));
    }

    let home_dir = home();
    if !home_dir.as_os_str().is_empty() && normalize_for_comparison(&destination) == normalize_for_comparison(&home_dir)
    {
        return Err(bad("Destination path cannot be the home folder"));
    }

    let parent = destination.parent().ok_or_else(|| bad("Destination path cannot be a filesystem root"))?;
    if !paths::under(&app.scope, &destination) || (!app.unrestricted && !paths::under(&app.scope, parent)) {
        return Err(bad("Destination path is outside the authorized workspace root"));
    }

    if !app.unrestricted {
        verify_existing_ancestors_in_scope(&app.scope, &destination)?;
    }

    Ok(destination)
}

fn verify_existing_ancestors_in_scope(scope: &Path, target: &Path) -> Result<(), Error> {
    // Check target itself if it is a symlink (including dangling symlink) before walking ancestors.
    if let Ok(meta) = std::fs::symlink_metadata(target)
        && meta.file_type().is_symlink()
    {
        let real = dunce::canonicalize(target)
            .map_err(|_| bad("Destination path is outside the authorized workspace root"))?;
        if !real.starts_with(scope) {
            return Err(bad("Destination path is outside the authorized workspace root"));
        }
    }
    let mut cursor = Some(target);
    while let Some(path) = cursor {
        if std::fs::symlink_metadata(path).is_ok() {
            let real = dunce::canonicalize(path)
                .map_err(|_| bad("Destination path is outside the authorized workspace root"))?;
            if !real.starts_with(scope) {
                return Err(bad("Destination path is outside the authorized workspace root"));
            }
            return Ok(());
        }
        cursor = path.parent();
    }
    Err(bad("Destination path is outside the authorized workspace root"))
}

async fn execute_clone(
    repository_url: String,
    destination: PathBuf,
    cleanup: bool,
    scope: PathBuf,
    unrestricted: bool,
) -> Result<PathBuf, Error> {
    let dest_for_prep = destination.clone();
    let scope_for_prep = scope.clone();
    let destination_exists = tokio::task::spawn_blocking(move || {
        prepare_destination(&dest_for_prep, cleanup, &scope_for_prep, unrestricted)
    })
    .await
    .map_err(|_| internal("Failed to prepare clone destination"))??;

    if destination_exists && cleanup {
        replace_destination_after_successful_clone(&repository_url, &destination).await?;
    } else {
        run_git_clone(&repository_url, &destination).await?;
    }

    Ok(destination)
}

fn prepare_destination(destination: &Path, cleanup: bool, scope: &Path, unrestricted: bool) -> Result<bool, Error> {
    if !unrestricted {
        verify_existing_ancestors_in_scope(scope, destination)?;
    }
    let parent = destination.parent().ok_or_else(|| bad("Destination path cannot be a filesystem root"))?;
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| bad(format!("Failed to create destination parent folder: {e}")))?;
    }
    if !unrestricted {
        let real_parent = dunce::canonicalize(parent)
            .map_err(|_| bad("Destination path is outside the authorized workspace root"))?;
        if !real_parent.starts_with(scope) {
            return Err(bad("Destination path is outside the authorized workspace root"));
        }
    }

    let symlink_meta = match std::fs::symlink_metadata(destination) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(bad(format!("Failed to inspect clone destination: {e}"))),
    };

    if symlink_meta.file_type().is_symlink() {
        // Refuse cloning/replacing over a dangling symlink or symlink outside scope.
        let meta =
            std::fs::metadata(destination).map_err(|_| conflict("Destination path exists and is not a folder"))?;
        if !meta.is_dir() {
            return Err(conflict("Destination path exists and is not a folder"));
        }
        if !unrestricted {
            let real = dunce::canonicalize(destination)
                .map_err(|_| bad("Destination path is outside the authorized workspace root"))?;
            if !real.starts_with(scope) {
                return Err(bad("Destination path is outside the authorized workspace root"));
            }
        }
    } else if !symlink_meta.is_dir() {
        return Err(conflict("Destination path exists and is not a folder"));
    }

    if fence::is_deleting_root(&fence::identity(destination)) {
        return Err(conflict("Destination directory is being removed"));
    }

    if !cleanup {
        let mut entries =
            std::fs::read_dir(destination).map_err(|e| bad(format!("Failed to inspect destination folder: {e}")))?;
        if entries.next().transpose().map_err(|e| bad(format!("Failed to inspect destination folder: {e}")))?.is_some()
        {
            return Err(conflict("Destination folder is not empty"));
        }
    }

    Ok(true)
}

fn create_sibling_unique_path(destination: &Path, label: &str) -> Result<PathBuf, Error> {
    let parent = destination.parent().ok_or_else(|| bad("Destination path cannot be a filesystem root"))?;
    let base = destination
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("Invalid destination path"))?;
    Ok(parent.join(format!("{base}.{label}-{}", Uuid::new_v4().simple())))
}

async fn replace_destination_after_successful_clone(repository_url: &str, destination: &Path) -> Result<(), Error> {
    let temp_clone = create_sibling_unique_path(destination, "clone")?;
    let clone_res = run_git_clone(repository_url, &temp_clone).await;
    if let Err(err) = clone_res {
        let cleanup_temp = temp_clone.clone();
        let _ = tokio::task::spawn_blocking(move || remove_tree(&cleanup_temp)).await;
        return Err(err);
    }

    let backup = create_sibling_unique_path(destination, "backup")?;
    let dest = destination.to_path_buf();
    let temp = temp_clone.clone();
    tokio::task::spawn_blocking(move || -> Result<(), Error> {
        let mut backup_exists = false;
        let mut preserve_backup = false;
        let outcome = (|| -> Result<(), Error> {
            std::fs::rename(&dest, &backup)
                .map_err(|e| internal(format!("Failed to prepare clone destination: {e}")))?;
            backup_exists = true;

            if let Err(replace_err) = std::fs::rename(&temp, &dest) {
                if let Err(restore_err) = std::fs::rename(&backup, &dest) {
                    preserve_backup = true;
                    return Err(internal(format!(
                        "Failed to replace clone destination and restore previous contents: {restore_err}"
                    )));
                }
                backup_exists = false;
                return Err(internal(format!("Failed to replace clone destination: {replace_err}")));
            }

            remove_tree(&backup);
            backup_exists = false;
            Ok(())
        })();

        if backup_exists && !preserve_backup {
            remove_tree(&backup);
        }
        if temp.exists() {
            remove_tree(&temp);
        }
        outcome
    })
    .await
    .map_err(|_| internal("Failed to replace clone destination"))?
}

/// Removes a directory tree, clearing Windows read-only attributes (common on `.git/objects/pack/*`).
fn remove_tree(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        let _ = std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
        return;
    }
    if std::fs::remove_dir_all(path).is_ok() {
        return;
    }
    clear_readonly_recursive(path);
    let _ = std::fs::remove_dir_all(path);
}

fn clear_readonly_recursive(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    let mut perms = meta.permissions();
    if perms.readonly() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(perms.mode() | 0o200);
        }
        #[cfg(windows)]
        #[allow(clippy::permissions_set_readonly_false)]
        {
            perms.set_readonly(false);
        }
        let _ = std::fs::set_permissions(path, perms);
    }
    if meta.is_dir()
        && let Ok(entries) = std::fs::read_dir(path)
    {
        for entry in entries.flatten() {
            clear_readonly_recursive(&entry.path());
        }
    }
}

async fn run_git_clone(repository_url: &str, destination: &Path) -> Result<(), Error> {
    let parent = destination.parent().ok_or_else(|| bad("Destination path cannot be a filesystem root"))?;
    let mut cmd = Command::new("git");
    cmd.current_dir(parent)
        .args([
            "-c",
            git::hooks(),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "protocol.ext.allow=never",
            "clone",
            "--",
        ])
        .arg(repository_url)
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Keep user credential/SSH configuration while preventing ambient repo relocation or config injection.
    for key in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_QUARANTINE_PATH",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd.spawn().map_err(|e| internal(format!("Failed to start git clone: {e}")))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let (_, stderr_bytes, status) =
        tokio::try_join!(drain_capped(out, MAX_OUTPUT_BYTES), drain_capped(err, MAX_OUTPUT_BYTES), child.wait(),)
            .map_err(|e| internal(format!("Failed to wait for git clone: {e}")))?;

    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
        Err(conflict(format!("git clone failed with code {code}")))
    } else {
        Err(conflict(trimmed))
    }
}

async fn drain_capped(mut input: impl AsyncRead + Unpin, max: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = input.read(&mut buf).await?;
        if n == 0 {
            return Ok(out);
        }
        let take = n.min(max.saturating_sub(out.len()));
        if take > 0 {
            out.extend_from_slice(&buf[..take]);
        }
    }
}

#[cfg(test)]
#[path = "workspace_clone_tests.rs"]
mod tests;
