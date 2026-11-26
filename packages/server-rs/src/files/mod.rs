//! Project files: listing, previews and writes under an owned checkout,
//! the global file browser and its watches.
pub mod browse;
pub mod links;
pub mod node_path;
pub mod paths;
mod save;
pub mod watch;

pub fn routes() -> axum::Router<Shared> {
    use axum::{extract::DefaultBodyLimit, routing};
    axum::Router::new()
        .route("/api/workspaces/{id}/files", routing::get(list))
        .route("/api/workspaces/{id}/files/preview", routing::get(preview))
        .route("/api/workspaces/{id}/files/content", routing::put(put).layer(DefaultBodyLimit::max(32 * 1024 * 1024)))
        .route("/api/filesystem", routing::get(browse::browse))
        .route("/api/filesystem/folders", routing::post(browse::create_folder))
}

use crate::{Error, Shared, Workspace, error};
use axum::{
    Json,
    extract::{Path as Route, Query, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use cap_std::{ambient_authority, fs::Dir};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const MAX: usize = 5 * 1024 * 1024;
fn invalid() -> Error {
    error(Status::BAD_REQUEST, "Access outside of root is not allowed")
}
fn unavailable() -> Error {
    error(Status::BAD_REQUEST, "Selected path is unavailable")
}
fn io_error(e: io::Error) -> Error {
    if e.kind() == io::ErrorKind::PermissionDenied { invalid() } else { unavailable() }
}
fn not_owned() -> Error {
    error(Status::BAD_REQUEST, "Directory is not owned by this workspace")
}
fn large() -> Error {
    error(Status::BAD_REQUEST, "Selected file is too large to attach")
}

pub(super) fn is_missing_or_not_dir(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
        || (cfg!(windows) && matches!(err.raw_os_error(), Some(2 | 3 | 267)))
}

pub(super) fn check_component(name: &str) -> Result<(), Error> {
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let port = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"));
    if name.is_empty()
        || matches!(name, "." | "..")
        || name == ".git"
        // APFS and HFS+ are case-insensitive by default (audit I7).
        || cfg!(target_os = "macos") && name.eq_ignore_ascii_case(".git")
        || name.contains('\0')
        || cfg!(windows)
            && (name.eq_ignore_ascii_case(".git")
                || name.ends_with(['.', ' '])
                || name.chars().any(|c| {
                    c.is_control() || matches!(c, ':' | '*' | '?' | '<' | '>' | '|' | '"')
                })
                || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
                || port.is_some_and(|p| ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&p)))
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn relative(input: &str, root: bool) -> Result<String, Error> {
    if root && matches!(input, "" | "." | "./" | "/") {
        return Ok(".".into());
    }
    if input.len() > 4096 || input.starts_with(['/', '\\']) {
        return Err(invalid());
    }
    let value = input.strip_prefix("./").unwrap_or(input).replace('\\', "/");
    for name in value.split('/') {
        check_component(name)?;
    }
    Ok(value)
}
fn workspace_path(base: &Path, input: &str, listing: bool) -> Result<String, Error> {
    if listing && input == "/" {
        return Ok(".".into());
    }
    if input.len() > 4096 || input.starts_with("//") || input.starts_with("\\\\") {
        return Err(invalid());
    }
    let normalized = input.replace('\\', "/");
    let given = Path::new(&normalized);
    if given.is_absolute() && !paths::under(base, given) {
        return Err(invalid());
    }
    let relative_name = if given.is_absolute() {
        let rel = given
            .strip_prefix(base)
            .or_else(|_| {
                // Compare the prefix as an actual directory on Windows rather
                // than lowercasing components on case-sensitive filesystems.
                let mut ancestor = given;
                while let Some(parent) = ancestor.parent() {
                    if dunce::canonicalize(parent).ok().as_deref() == Some(base) {
                        return given.strip_prefix(parent);
                    }
                    ancestor = parent;
                }
                given.strip_prefix(base)
            })
            .map_err(|_| invalid())?;
        relative_name_string(rel)?
    } else {
        normalized
    };
    let mut parts = Vec::new();
    for part in relative_name.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(invalid());
                }
            }
            _ => {
                relative(part, false)?;
                parts.push(part);
            }
        }
    }
    relative(&parts.join("/"), listing)
}
fn relative_name_string(path: &Path) -> Result<String, Error> {
    Ok(path.to_str().ok_or_else(invalid)?.replace('\\', "/"))
}
pub fn root(workspace: &Workspace) -> Result<Dir, Error> {
    if dunce::canonicalize(&workspace.path).ok().as_ref() != Some(&workspace.path) {
        return Err(invalid());
    }
    Dir::open_ambient_dir(&workspace.path, ambient_authority()).map_err(io_error)
}
pub fn directory(workspace: &Workspace, value: Option<&str>) -> Result<(), Error> {
    if let Some(value) = value {
        let path = Path::new(value.trim());
        if !path.is_absolute()
            || value.starts_with(['\\', '/']) && cfg!(windows)
            || !paths::under(&workspace.path, path)
            || dunce::canonicalize(path).ok().as_ref() != Some(&workspace.path)
        {
            return Err(not_owned());
        }
    }
    Ok(())
}
pub fn contained(dir: &Dir, path: &str, missing: bool) -> Result<(), Error> {
    // Check all prefixes, even when the last component was deleted from disk.
    let mut prefix = PathBuf::new();
    let mut parts = Path::new(path).components().peekable();
    while let Some(c) = parts.next() {
        prefix.push(c.as_os_str());
        match dir.symlink_metadata(&prefix) {
            Ok(meta) if parts.peek().is_none() && meta.is_symlink() => return Err(invalid()),
            Ok(_) => {
                let target = dir.canonicalize(&prefix).map_err(io_error)?;
                relative(&target.to_string_lossy(), true)?;
            }
            Err(e) if missing && e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}
fn bounded(mut file: impl Read, max: usize) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    file.by_ref().take((max + 1) as u64).read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() > max { Err(large()) } else { Ok(bytes) }
}
fn version(b: &[u8]) -> String {
    format!("\"{:x}\"", Sha256::digest(b))
}
pub fn host_identity(path: &Path) -> io::Result<String> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut h = DefaultHasher::new();
    same_file::Handle::from_path(path)?.hash(&mut h);
    Ok(format!("{:x}", h.finish()))
}

/// Identifies a live directory without opening POSIX FIFOs or symlinks (`lstat` dev/ino on Unix;
/// `symlink_metadata().is_dir()` before `same_file::Handle` on Windows).
pub(crate) fn directory_identity(path: &Path) -> io::Result<String> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{:x}:{:x}", meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        host_identity(path)
    }
}

#[derive(Deserialize)]
pub struct Input {
    path: Option<String>,
    directory: Option<String>,
    worktree: Option<String>,
}
async fn select(app: &crate::App, id: &str, q: &Input) -> Result<Workspace, Error> {
    let w = app.workspace(id)?;
    if q.directory.as_deref().is_some_and(|d| !paths::under(&app.scope, Path::new(d))) {
        return Err(not_owned());
    }
    let slug = q.worktree.as_deref().filter(|s| !s.is_empty());
    if slug.is_some_and(|s| s != "root") || directory(&w, q.directory.as_deref()).is_err() {
        let hit = crate::worktrees::linked::http_read(app, &w, crate::worktrees::linked::ReadMode::Validated)
            .await
            .map_err(|_| not_owned())?;
        let cat = hit.snapshot.catalogue().ok_or_else(not_owned)?;
        let (found, root_live) = {
            let cat_clone = std::sync::Arc::clone(&cat);
            let opened = w.path.clone();
            let slug_owned = slug.map(str::to_owned);
            let dir_owned = q.directory.clone();
            let check_live = hit.from_cache;
            tokio::task::spawn_blocking(move || {
                let root_live = !check_live || cat_clone.root_live_for(&opened);
                let tree = if root_live {
                    let chosen = match (slug_owned.as_deref(), dir_owned.as_deref()) {
                        (Some(s), Some(p)) => cat_clone.get(s).ok().filter(|t| cat_clone.by_directory(p) == Some(*t)),
                        (Some(s), None) => cat_clone.get(s).ok(),
                        (None, Some(p)) => cat_clone.by_directory(p),
                        _ => None,
                    };
                    chosen.filter(|t| !check_live || t.contains_live(&t.path)).cloned()
                } else {
                    None
                };
                (tree, root_live)
            })
            .await
            .unwrap_or((None, false))
        };
        if let Some(tree) = found {
            return Ok(crate::worktrees::linked::scope(w, &tree));
        }
        if hit.from_cache && (!root_live || !hit.refreshed_on_miss) {
            let retry_mode = if root_live {
                crate::worktrees::linked::ReadMode::RefreshOnMiss(hit.generation)
            } else {
                crate::worktrees::linked::ReadMode::Fresh
            };
            let fresh = crate::worktrees::linked::http_read(app, &w, retry_mode).await.map_err(|_| not_owned())?;
            let cat = fresh.snapshot.catalogue().ok_or_else(not_owned)?;
            let cat_clone = std::sync::Arc::clone(&cat);
            let slug_owned = slug.map(str::to_owned);
            let dir_owned = q.directory.clone();
            let check_live = fresh.from_cache;
            let resolved = tokio::task::spawn_blocking(move || {
                let chosen = match (slug_owned.as_deref(), dir_owned.as_deref()) {
                    (Some(s), Some(p)) => cat_clone.get(s).ok().filter(|t| cat_clone.by_directory(p) == Some(*t)),
                    (Some(s), None) => cat_clone.get(s).ok(),
                    (None, Some(p)) => cat_clone.by_directory(p),
                    _ => None,
                };
                match chosen {
                    Some(t) if !check_live || t.contains_live(&t.path) => Some(Ok(t.clone())),
                    Some(_) => Some(Err(())),
                    None => None,
                }
            })
            .await
            .unwrap_or(None);
            match resolved {
                Some(Ok(tree)) => return Ok(crate::worktrees::linked::scope(w, &tree)),
                Some(Err(())) => {
                    let forced =
                        crate::worktrees::linked::http_read(app, &w, crate::worktrees::linked::ReadMode::Fresh)
                            .await
                            .map_err(|_| not_owned())?;
                    let cat = forced.snapshot.catalogue().ok_or_else(not_owned)?;
                    let tree = match (slug, q.directory.as_deref()) {
                        (Some(s), Some(p)) => cat.get(s).ok().filter(|t| cat.by_directory(p) == Some(*t)),
                        (Some(s), None) => cat.get(s).ok(),
                        (None, Some(p)) => cat.by_directory(p),
                        _ => None,
                    }
                    .ok_or_else(not_owned)?;
                    return Ok(crate::worktrees::linked::scope(w, tree));
                }
                None => return Err(not_owned()),
            }
        }
        return Err(not_owned());
    }
    directory(&w, q.directory.as_deref())?;
    Ok(w)
}
pub async fn list(
    State(app): State<Shared>,
    Route(id): Route<String>,
    Query(q): Query<Input>,
) -> Result<Json<Value>, Error> {
    let w = select(&app, &id, &q).await?;
    let key = workspace_path(&w.path, q.path.as_deref().unwrap_or("."), true)?;
    root(&w)?;
    // Links are followed like the reference (`links`).
    links::guard(&w.path, &key)?;
    let physical = dunce::canonicalize(links::target(&w.path, &key)).map_err(io_error)?;
    watch::observe(&app, &w, &key, &physical);
    let workspace_path = w.path.clone();
    let entries = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, Error> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&physical).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let p = if key == "." { name.to_owned() } else { format!("{key}/{name}") };
            if relative(&p, false).is_err() || links::guard(&workspace_path, &p).is_err() {
                continue;
            }
            // Followed like the reference's `stat`; a dangling link or loop is skipped.
            let entry_path = links::target(&workspace_path, &p);
            let Ok(m) = std::fs::metadata(&entry_path) else { continue };
            if !m.is_dir() && !m.is_file() {
                continue;
            }
            let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let mut row = json!({"name":name,"path":p,"absolutePath":workspace_path.join(&p),
                "type":if m.is_dir(){"directory"}else{"file"},
                "modifiedAt":DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis,true)});
            if m.is_dir() {
                row["directoryIdentity"] = json!(host_identity(&entry_path).unwrap_or_default());
            } else {
                row["size"] = json!(m.len());
            }
            entries.push(row);
        }
        entries.sort_by_cached_key(|r| r["name"].as_str().unwrap_or_default().to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(|_| unavailable())??;
    app.workspace(&id)?;
    Ok(Json(json!(entries)))
}
/// `GET files/preview`: the base64 contents and version of a project file.
pub async fn preview(
    State(app): State<Shared>,
    Route(id): Route<String>,
    Query(q): Query<Input>,
) -> Result<Response, Error> {
    let w = select(&app, &id, &q).await?;
    let key = q.path.as_deref().ok_or_else(invalid)?;
    let p = workspace_path(&w.path, key, false)?;
    let _slot = app.file_reader.acquire().await.unwrap();
    root(&w)?;
    let bytes = links::read(&w.path, &p, MAX)?.ok_or_else(unavailable)?;
    let tag = version(&bytes);
    app.workspace(&id)?;
    let contents = STANDARD.encode(&bytes);
    Ok((
        [(axum::http::header::ETAG, tag.clone())],
        Json(json!({"workspaceId":id,"relativePath":key,"contents":contents,"encoding":"base64","version":tag})),
    )
        .into_response())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    contents: String,
    expected_version: Option<String>,
}
pub async fn put(
    State(app): State<Shared>,
    Route(id): Route<String>,
    Query(q): Query<Input>,
    headers: HeaderMap,
    Json(body): Json<Save>,
) -> Result<Response, Error> {
    if body.contents.len() > MAX {
        return Err(large());
    }
    let w = select(&app, &id, &q).await?;
    let p = workspace_path(&w.path, q.path.as_deref().ok_or_else(invalid)?, false)?;
    let mut if_match = headers.get_all(axum::http::header::IF_MATCH).iter();
    let expected = match (if_match.next(), if_match.next(), body.expected_version.as_deref()) {
        (Some(_), _, Some(_)) => return Err(error(Status::BAD_REQUEST, "Conflicting version selectors")),
        (Some(_), Some(_), None) => return Err(error(Status::BAD_REQUEST, "Invalid file version")),
        (Some(h), None, None) => {
            let value = h.to_str().map_err(|_| error(Status::BAD_REQUEST, "Invalid file version"))?;
            if value.trim().is_empty() {
                return Err(error(Status::BAD_REQUEST, "Invalid file version"));
            }
            Some(value.to_owned())
        }
        (None, None, Some("")) => return Err(error(Status::BAD_REQUEST, "Invalid file version")),
        (None, None, other) => other.map(str::to_owned),
        (None, Some(_), _) => unreachable!(),
    };
    use crate::worktrees::fence;
    let checkout = fence::identity(&fence::checkout_root(&app.scope, &w.path));
    if fence::is_blocked(&checkout) {
        return Err(error(Status::CONFLICT, "Worktree deletion is in progress"));
    }
    root(&w)?;
    links::guard(&w.path, &p)?;
    let target = links::write_target(links::target(&w.path, &p), true, expected.is_some())?;
    let key = fence::identity(&target);
    let admitted = fence::admit(&[checkout, key.clone()])?;
    let write = fence::serialize(format!("file\n{key}")).await;
    // Physical aliases have distinct paths but must share the version check.
    let identity = save::file_identity(&target, expected.is_some())?;
    let aliases = match &identity {
        Some(key) => Some(fence::serialize(format!("file-identity\n{key}")).await),
        None => None,
    };
    app.workspace(&id)?;
    let tag = version(body.contents.as_bytes());
    tokio::task::spawn_blocking(move || {
        let (_write, _aliases, _admitted) = (write, aliases, admitted);
        let current = || {
            app.workspace(&id)?;
            root(&w)?;
            links::guard(&w.path, &p)?;
            if links::write_target(links::target(&w.path, &p), true, true)? != target {
                return Err(error(Status::CONFLICT, "File changed on disk"));
            }
            if save::file_identity(&target, expected.is_some())? != identity {
                return Err(error(Status::CONFLICT, "File changed on disk"));
            }
            Ok(())
        };
        current()?;
        save::replace(&target, expected.as_deref(), current, |file| file.write_all(body.contents.as_bytes()))
    })
    .await
    .map_err(|_| unavailable())??;
    Ok((Status::NO_CONTENT, [(axum::http::header::ETAG, tag)]).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn rejects_unrepresentable_or_protected_project_paths() {
        for p in [
            "../x",
            "sub/../x",
            "\\\\host\\share\\x",
            "C:relative",
            "NUL.txt",
            "lpt²",
            "file:stream",
            ".GiT/config",
            "x.",
            "x/",
        ] {
            assert!(relative(p, false).is_err(), "{p}");
        }
        assert_eq!(relative("dossier\\étude.txt", false).unwrap(), "dossier/étude.txt");
    }
    #[test]
    #[cfg(any(windows, target_os = "macos"))]
    fn git_directory_is_protected_in_any_case() {
        for p in [".GIT/config", "sub/.Git/HEAD"] {
            assert!(relative(p, false).is_err(), "{p}");
        }
    }
    #[test]
    #[cfg(windows)]
    fn absolute_paths_are_admitted_lexically() {
        let root = Path::new(r"C:\fixture");
        for p in [r"\\host\share\x", r"/\host\share", r"//host/x", r"C:\other\x", r"\\.\pipe\x"] {
            assert!(workspace_path(root, p, false).is_err(), "{p}");
        }
        assert_eq!(workspace_path(root, r"C:/fixture/a.txt", false).unwrap(), "a.txt");
    }
    #[test]
    fn normalizes_only_within_workspace() {
        let root = Path::new(if cfg!(windows) { r"C:\fixture" } else { "/fixture" });
        assert_eq!(workspace_path(root, "nested/../report.txt", false).unwrap(), "report.txt");
        assert!(workspace_path(root, "../report.txt", false).is_err());
        assert!(workspace_path(root, ".git/config", false).is_err());
        #[cfg(unix)]
        assert_eq!(workspace_path(root, "nul.txt", false).unwrap(), "nul.txt");
    }

    #[tokio::test]
    async fn lists_and_sorts_directories_with_more_than_4096_entries() {
        use crate::{App, auth, opencode, settings};
        use std::{sync::Arc, time::Duration};
        use uuid::Uuid;

        struct CleanupDir(PathBuf);
        impl Drop for CleanupDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        let dir = crate::shared::test_dir("files-large-dir");
        let _cleanup = CleanupDir(dir.clone());
        let root = dir.join("workspace");
        let generated = root.join("generated");
        std::fs::create_dir_all(&generated).unwrap();
        let count = 4097usize;
        for i in (0..count).rev() {
            std::fs::File::create(generated.join(format!("item-{i:04}.txt"))).unwrap();
        }
        let root = dunce::canonicalize(&root).unwrap();
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
        let native = opencode::Native::test_connection(([127, 0, 0, 1], 9).into());
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
            watch::Watches::new(tx),
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

        let expected: Vec<String> = (0..count).map(|i| format!("item-{i:04}.txt")).collect();

        let listed = list(
            State(app.clone()),
            Route(id.to_string()),
            Query(Input { path: Some("generated".into()), directory: None, worktree: None }),
        )
        .await
        .unwrap()
        .0;
        let listed_names: Vec<&str> = listed.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(listed_names, expected);

        let browsed = browse::browse_restricted_for_test(&app, Some(PathBuf::from("generated")), true).await.unwrap().0;
        let browse_names: Vec<&str> =
            browsed["entries"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(browse_names, expected);

        let unrestricted = browse::browse_unrestricted_for_test(generated.to_str().unwrap(), true).await.unwrap();
        let unrestricted_names: Vec<&str> = unrestricted.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(unrestricted_names, expected);
    }

    #[tokio::test]
    async fn put_files_content_accepts_32mib_escaped_body_and_returns_409_on_missing_or_file_parent() {
        use std::sync::Arc;
        let dir = crate::shared::test_dir("files-write-parity");
        let root_dir = dunce::canonicalize(&dir).unwrap();
        let ws_dir = root_dir.join("project");
        std::fs::create_dir_all(&ws_dir).unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "codenomad".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: std::time::Duration::from_secs(60),
            absolute: std::time::Duration::from_secs(60),
        })
        .unwrap();
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(crate::App::new(
            auth,
            0,
            root_dir.clone(),
            root_dir.clone(),
            false,
            settings,
            Value::Null,
            crate::opencode::Native::test_connection(([127, 0, 0, 1], 9).into()),
            PathBuf::new(),
            None,
            watch::Watches::new(tx),
            None,
        ));
        let ws_id = uuid::Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: ws_id,
            request_id: None,
            path: ws_dir.clone(),
            name: Some("project".into()),
            status: "running",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({ "directory": ws_dir }),
            temporary: None,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, routes().with_state(app)).await;
        });
        let client = reqwest::Client::new();
        let base = format!("http://{addr}/api/workspaces/{ws_id}/files");

        // 1. A <= 5 MiB UTF-8 file whose JSON-escaped body exceeds the old 8 MiB limit (~12 MiB) succeeds.
        let escaped_heavy = "\u{0001}".repeat(2_000_000);
        let payload = serde_json::to_vec(&json!({ "contents": escaped_heavy })).unwrap();
        assert!(payload.len() > 8 * 1024 * 1024 && payload.len() < 32 * 1024 * 1024);
        let saved = client
            .put(format!("{base}/content?path=escaped.txt"))
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
            .unwrap();
        assert_eq!(saved.status(), Status::NO_CONTENT);
        assert_eq!(
            saved.headers().get(axum::http::header::ETAG).unwrap().to_str().unwrap(),
            version(escaped_heavy.as_bytes())
        );
        assert_eq!(std::fs::read(ws_dir.join("escaped.txt")).unwrap(), escaped_heavy.as_bytes());

        // 2. Deleting the parent directory or replacing it with a regular file returns 409 on conditional PUT.
        let sub = ws_dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("note.txt"), "v1").unwrap();
        let preview_body: Value =
            client.get(format!("{base}/preview?path=sub/note.txt")).send().await.unwrap().json().await.unwrap();
        let v1 = preview_body["version"].as_str().unwrap().to_owned();

        std::fs::remove_dir_all(&sub).unwrap();
        let deleted_parent = client
            .put(format!("{base}/content?path=sub/note.txt"))
            .json(&json!({ "contents": "v2", "expectedVersion": v1 }))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted_parent.status(), Status::CONFLICT);
        assert_eq!(deleted_parent.json::<Value>().await.unwrap(), json!({ "error": "File changed on disk" }));

        std::fs::write(&sub, "now-a-file").unwrap();
        let file_parent = client
            .put(format!("{base}/content?path=sub/note.txt"))
            .json(&json!({ "contents": "v2", "expectedVersion": v1 }))
            .send()
            .await
            .unwrap();
        assert_eq!(file_parent.status(), Status::CONFLICT);
        assert_eq!(file_parent.json::<Value>().await.unwrap(), json!({ "error": "File changed on disk" }));

        // 3. Invalid version selectors return 400.
        let blank_if_match = client
            .put(format!("{base}/content?path=escaped.txt"))
            .header(axum::http::header::IF_MATCH, "   ")
            .json(&json!({ "contents": "x" }))
            .send()
            .await
            .unwrap();
        assert_eq!(blank_if_match.status(), Status::BAD_REQUEST);

        let empty_expected = client
            .put(format!("{base}/content?path=escaped.txt"))
            .json(&json!({ "contents": "x", "expectedVersion": "" }))
            .send()
            .await
            .unwrap();
        assert_eq!(empty_expected.status(), Status::BAD_REQUEST);

        let dup_if_match = client
            .put(format!("{base}/content?path=escaped.txt"))
            .header(axum::http::header::IF_MATCH, &v1)
            .header(axum::http::header::IF_MATCH, &v1)
            .json(&json!({ "contents": "x" }))
            .send()
            .await
            .unwrap();
        assert_eq!(dup_if_match.status(), Status::BAD_REQUEST);

        let conflicting = client
            .put(format!("{base}/content?path=escaped.txt"))
            .header(axum::http::header::IF_MATCH, &v1)
            .json(&json!({ "contents": "x", "expectedVersion": v1 }))
            .send()
            .await
            .unwrap();
        assert_eq!(conflicting.status(), Status::BAD_REQUEST);

        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
}
