//! Project files: listing, previews and writes under an owned checkout,
//! the global file browser and its watches.
pub mod browse;
pub mod links;
pub mod node_path;
pub mod paths;
pub mod watch;

pub fn routes() -> axum::Router<Shared> {
    use axum::{extract::DefaultBodyLimit, routing};
    axum::Router::new()
        .route("/api/workspaces/{id}/files", routing::get(list))
        .route("/api/workspaces/{id}/files/preview", routing::get(preview))
        .route("/api/workspaces/{id}/files/content", routing::put(put).layer(DefaultBodyLimit::max(8 * 1024 * 1024)))
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
    io::{self, Read, Seek, Write},
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

pub fn relative(input: &str, root: bool) -> Result<String, Error> {
    if root && matches!(input, "" | "." | "./" | "/") {
        return Ok(".".into());
    }
    if input.len() > 4096 || input.starts_with(['/', '\\']) {
        return Err(invalid());
    }
    let value = input.strip_prefix("./").unwrap_or(input).replace('\\', "/");
    for name in value.split('/') {
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
        let cat = crate::worktrees::linked::catalogue(app, &w, false).await.map_err(|_| not_owned())?;
        let tree = match (slug, q.directory.as_deref()) {
            (Some(s), Some(p)) => cat.get(s).ok().filter(|t| cat.by_directory(p) == Some(*t)),
            (Some(s), None) => cat.get(s).ok(),
            (None, Some(p)) => cat.by_directory(p),
            _ => None,
        }
        .ok_or_else(not_owned)?;
        return Ok(crate::worktrees::linked::scope(w, tree));
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
    let mut entries = Vec::new();
    for (index, entry) in std::fs::read_dir(&physical).map_err(io_error)?.enumerate() {
        if index >= 4096 {
            return Err(error(Status::BAD_REQUEST, "Directory listing too large"));
        }
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let p = if key == "." { name.to_owned() } else { format!("{key}/{name}") };
        if relative(&p, false).is_err() || links::guard(&w.path, &p).is_err() {
            continue;
        }
        // Followed like the reference's `stat`; a dangling link or loop is skipped.
        let entry_path = links::target(&w.path, &p);
        let Ok(m) = std::fs::metadata(&entry_path) else { continue };
        if !m.is_dir() && !m.is_file() {
            continue;
        }
        let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let mut row = json!({"name":name,"path":p,"absolutePath":w.path.join(&p),
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
    let _write = app.project_mutation.lock().await;
    let w = select(&app, &id, &q).await?;
    let p = workspace_path(&w.path, q.path.as_deref().ok_or_else(invalid)?, false)?;
    root(&w)?;
    // Written through links like the reference (`links`).
    links::guard(&w.path, &p)?;
    let p = links::target(&w.path, &p);
    let expected = match (headers.get(axum::http::header::IF_MATCH), body.expected_version.as_deref()) {
        (Some(_), Some(_)) => return Err(error(Status::BAD_REQUEST, "Conflicting version selectors")),
        (Some(h), None) => Some(h.to_str().map_err(|_| error(Status::BAD_REQUEST, "Invalid file version"))?),
        (None, other) => other,
    };
    if expected.is_some() && !p.is_file() {
        return Err(error(Status::CONFLICT, "File changed on disk"));
    }
    // One handle for the optional CAS and the write; truncate only after it.
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true).write(true).create(expected.is_none());
    let mut file = opts.open(&p).map_err(io_error)?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(error(Status::BAD_REQUEST, "Selected path is not a file"));
    }
    if let Some(expected) = expected {
        let original = bounded(&mut file, MAX)?;
        if expected != version(&original) {
            return Err(error(Status::CONFLICT, "File changed on disk"));
        }
    }
    file.rewind().map_err(io_error)?;
    file.write_all(body.contents.as_bytes()).map_err(io_error)?;
    file.set_len(body.contents.len() as u64).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    Ok(Status::NO_CONTENT.into_response())
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
}
