//! `filesystem/browser.ts`: the folder browser, under the server root or, with
//! `--unrestricted-root`, over local drives from the home folder; folder creation.
use axum::{
    Json,
    body::Bytes,
    extract::{Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use crate::{App, Error, Shared, error, files::paths, settings::document::home, shared::fastify};

/// `WINDOWS_DRIVES_ROOT`
pub const DRIVES: &str = "__drives__";
const SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    path: Option<String>,
    include_files: Option<String>,
}

fn invalid() -> Error {
    error(Status::BAD_REQUEST, "Path is outside the authorized filesystem root")
}
fn text(status: Status, message: &str) -> Response {
    (status, [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], message.to_owned()).into_response()
}
/// Node's message for a failed `fs` call (`ENOENT: no such file or directory, scandir '…'`).
fn node_error(e: &io::Error, call: &str, path: &str) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, {call} '{path}'"),
        io::ErrorKind::PermissionDenied => format!("EPERM: operation not permitted, {call} '{path}'"),
        io::ErrorKind::AlreadyExists => format!("EEXIST: file already exists, {call} '{path}'"),
        _ => format!("{e}, {call} '{path}'"),
    }
}
fn modified(info: &std::fs::Metadata) -> String {
    DateTime::<Utc>::from(info.modified().unwrap_or(SystemTime::UNIX_EPOCH))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `path.win32.normalize` / `path.posix.normalize` of an absolute or home-relative input.
pub fn normalize(input: &str) -> String {
    let s = if cfg!(windows) { input.replace('/', "\\") } else { input.to_owned() };
    let b = s.as_bytes();
    if cfg!(windows) && s.starts_with("\\\\") {
        let mut parts = s[2..].splitn(3, '\\');
        if let (Some(server), Some(share)) = (parts.next(), parts.next())
            && !server.is_empty()
            && !share.is_empty()
        {
            return finish(
                format!("\\\\{server}\\{share}"),
                true,
                parts.next().unwrap_or(""),
                s.len() > 2 && s.ends_with('\\'),
            );
        }
    }
    let (device, rest) = if cfg!(windows) && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        (s[..2].to_owned(), &s[2..])
    } else {
        (String::new(), s.as_str())
    };
    let rooted = rest.starts_with(SEPARATOR);
    finish(device, rooted, rest, rest.len() > 1 && rest.ends_with(SEPARATOR))
}
fn finish(prefix: String, rooted: bool, rest: &str, trailing: bool) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(SEPARATOR) {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if rooted => {}
            part => parts.push(part),
        }
    }
    let mut out = prefix;
    if rooted {
        out.push(SEPARATOR);
    }
    out.push_str(&parts.join(&SEPARATOR.to_string()));
    if parts.is_empty() && !rooted {
        out.push('.');
    } else if trailing && !parts.is_empty() {
        out.push(SEPARATOR);
    }
    out
}

/// `resolveUnrestrictedPath`: the server root by default, else an absolute path or one
/// relative to the home folder.
fn resolve_unrestricted(app: &App, input: Option<&str>) -> String {
    match input {
        None | Some("" | "." | "./") => app.root.to_string_lossy().into_owned(),
        Some(DRIVES) if cfg!(windows) => DRIVES.into(),
        Some(input) => {
            let normalized = normalize(input);
            let absolute = if cfg!(windows) {
                normalized.as_bytes().get(1) == Some(&b':') && normalized.as_bytes()[0].is_ascii_alphabetic()
                    || normalized.starts_with("\\\\")
            } else {
                normalized.starts_with('/')
            };
            match (absolute, normalized.starts_with(SEPARATOR)) {
                (true, _) => normalized,
                // A rooted Windows path takes the home folder's drive.
                (false, true) => {
                    normalize(&format!("{}{normalized}", home().to_string_lossy().chars().take(2).collect::<String>()))
                }
                (false, false) => normalize(&format!("{}{SEPARATOR}{normalized}", home().display())),
            }
        }
    }
}
fn child(parent: &str, name: &str) -> String {
    match parent.ends_with(SEPARATOR) {
        true => normalize(&format!("{parent}{name}")),
        false => normalize(&format!("{parent}{SEPARATOR}{name}")),
    }
}
/// `getUnrestrictedParent`: a Windows drive root goes up to the drive list.
fn parent(current: &str) -> Option<String> {
    let b = current.as_bytes();
    let root = if cfg!(windows) && current.starts_with("\\\\") {
        let server = current[2..].find(SEPARATOR).map(|i| i + 3);
        server.and_then(|s| current[s..].find(SEPARATOR).map(|e| s + e + 1)).unwrap_or(current.len())
    } else if cfg!(windows) && b.len() >= 2 && b[1] == b':' {
        if b.get(2) == Some(&b'\\') { 3 } else { 2 }
    } else {
        usize::from(current.starts_with(SEPARATOR))
    };
    if current.len() <= root {
        return cfg!(windows).then(|| DRIVES.into());
    }
    match current.trim_end_matches(SEPARATOR).rfind(SEPARATOR) {
        Some(i) if i > root => Some(current[..i].to_owned()),
        _ => Some(current[..root].to_owned()),
    }
}

/// `${dev}:${ino}` of a followed folder, as Node's bigint `stat` reports it.
pub fn directory_identity(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, GetFileInformationByHandle,
        };
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        // SAFETY: a valid open handle and a zeroed out-structure.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        (unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0).then(|| {
            format!(
                "{}:{}",
                info.dwVolumeSerialNumber,
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)
            )
        })
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|m| format!("{}:{}", m.dev(), m.ino()))
    }
}

/// `readDirectoryEntries` with absolute entry paths; links are followed, unreadable entries skipped.
async fn unrestricted_entries(directory: &str, files: bool) -> io::Result<Vec<Value>> {
    let directory = directory.to_owned();
    tokio::task::spawn_blocking(move || -> io::Result<Vec<Value>> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            let entry_path = entry.path();
            let Ok(info) = std::fs::metadata(&entry_path) else { continue };
            if !files && !info.is_dir() {
                continue;
            }
            let path = child(&directory, &name);
            let mut row = json!({"name": name, "path": path, "absolutePath": path,
                "type": if info.is_dir() { "directory" } else { "file" }, "modifiedAt": modified(&info)});
            if info.is_dir() {
                if let Some(identity) = directory_identity(&entry_path) {
                    row["directoryIdentity"] = json!(identity);
                }
            } else {
                row["size"] = json!(info.len());
            }
            entries.push(row);
        }
        entries.sort_by_cached_key(|row| row["name"].as_str().unwrap_or_default().to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(|_| io::Error::other("Directory listing cancelled"))?
}

fn drives(app: &App) -> Value {
    let mut entries: Vec<Value> = (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|drive| Path::new(drive).metadata().is_ok())
        .map(|drive| json!({"name": &drive[..2], "path": drive, "absolutePath": drive, "type": "directory"}))
        .collect();
    entries.push(json!({"name": "UNC Network", "path": "\\\\", "absolutePath": "\\\\", "type": "directory"}));
    json!({"entries": entries, "metadata": {"scope": "unrestricted", "currentPath": DRIVES, "rootPath": app.root,
        "homePath": home(), "displayPath": "Drives", "pathKind": "drives"}})
}

/// Only local folders are opened: a UNC share or device path is refused (audit M2).
fn local(path: &str) -> Result<&str, String> {
    match paths::local_absolute(path) {
        true => Ok(path),
        false => Err("Path is not a local folder".into()),
    }
}

pub async fn browse(State(app): State<Shared>, input: Result<Query<Input>, QueryRejection>) -> Response {
    let Ok(Query(input)) = input else { return invalid().into_response() };
    let files = input.include_files.as_deref() != Some("");
    if !app.unrestricted {
        return restricted(&app, input.path.map(PathBuf::from), files).await.into_response();
    }
    let current = resolve_unrestricted(&app, input.path.as_deref());
    if current == DRIVES {
        return Json(drives(&app)).into_response();
    }
    let listed = match local(&current) {
        Ok(path) => unrestricted_entries(path, files).await.map_err(|e| node_error(&e, "scandir", &current)),
        Err(e) => Err(e),
    };
    match listed {
        Ok(entries) => {
            let mut metadata = json!({"scope": "unrestricted", "currentPath": current, "rootPath": app.root,
                "homePath": home(), "displayPath": current, "pathKind": "absolute"});
            if let Some(parent) = parent(&current) {
                metadata["parentPath"] = json!(parent);
            }
            Json(json!({"entries": entries, "metadata": metadata})).into_response()
        }
        Err(message) => error(Status::BAD_REQUEST, &message).into_response(),
    }
}

async fn restricted(app: &App, path: Option<PathBuf>, files: bool) -> Result<Json<Value>, Error> {
    let path = path.unwrap_or_else(|| PathBuf::from("."));
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(invalid());
    }
    let root_dir = app.root.clone();
    let (directory, current, parent_path, entries) =
        tokio::task::spawn_blocking(move || -> Result<(PathBuf, String, Option<String>, Vec<Value>), Error> {
            let directory = paths::canonical(&root_dir, root_dir.join(path)).ok_or_else(invalid)?;
            let rel = |path: &Path| {
                path.strip_prefix(&root_dir)
                    .ok()
                    .map(|path| {
                        if path.as_os_str().is_empty() { ".".into() } else { path.to_string_lossy().replace('\\', "/") }
                    })
                    .ok_or_else(invalid)
            };
            let current = rel(&directory)?;
            let parent_path = if current != "." { Some(rel(directory.parent().ok_or_else(invalid)?)?) } else { None };
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&directory).map_err(|_| invalid())? {
                let entry = entry.map_err(|_| invalid())?;
                let absolute = entry.path();
                // A link can name an unauthorized root. Do not publish it or its stats.
                let Ok(resolved) = dunce::canonicalize(&absolute) else { continue };
                if !resolved.starts_with(&root_dir) {
                    continue;
                }
                let Ok(info) = std::fs::metadata(&resolved) else { continue };
                if !info.is_dir() && (!info.is_file() || !files) {
                    continue;
                }
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let mut value = json!({"name":name,"path":rel(&absolute)?,"absolutePath":absolute,
                    "type":if info.is_dir() {"directory"} else {"file"}, "modifiedAt":modified(&info)});
                if info.is_file() {
                    value["size"] = json!(info.len());
                }
                entries.push(value);
            }
            entries.sort_by_cached_key(|value| value["name"].as_str().unwrap_or_default().to_lowercase());
            Ok((directory, current, parent_path, entries))
        })
        .await
        .map_err(|_| invalid())??;
    let mut metadata = json!({"scope":"restricted","currentPath":current,"rootPath":app.root,
        "homePath":app.root,"displayPath":directory,"pathKind":"relative"});
    if let Some(parent_path) = parent_path {
        metadata["parentPath"] = json!(parent_path);
    }
    Ok(Json(json!({"entries":entries,"metadata":metadata})))
}

#[cfg(test)]
pub(super) async fn browse_restricted_for_test(
    app: &App,
    path: Option<PathBuf>,
    files: bool,
) -> Result<Json<Value>, Error> {
    restricted(app, path, files).await
}

#[cfg(test)]
pub(super) async fn browse_unrestricted_for_test(directory: &str, files: bool) -> io::Result<Vec<Value>> {
    unrestricted_entries(directory, files).await
}

/// `normalizeFolderName`
fn folder_name(input: &str) -> Result<&str, &'static str> {
    let name = input.trim();
    match name {
        "" => Err("Folder name is required"),
        "." | ".." => Err("Invalid folder name"),
        _ if name.starts_with('~') || name.contains('\0') => Err("Invalid folder name"),
        _ if name.contains(['/', '\\']) => Err("Folder name must not include path separators"),
        _ => Ok(name),
    }
}

/// `POST /api/filesystem/folders` `{ parentPath?, name }`: 201 with the new folder's path.
pub async fn create_folder(State(app): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Response {
    let body = match fastify::body(&headers, &bytes) {
        Ok(Some(fastify::Body::Json(body))) => body,
        Ok(None) => json!({}),
        Ok(Some(fastify::Body::Text(_))) => Value::Null,
        Err(e) => return e.into_response(),
    };
    let (Some(name), Some(parent)) =
        (body["name"].as_str(), body.get("parentPath").map_or(Some(None), |p| p.as_str().map(Some)))
    else {
        // The reference's schema parse throws outside its handler's `try`.
        let message = "Invalid folder creation request";
        return (
            Status::INTERNAL_SERVER_ERROR,
            Json(json!({"statusCode": 500, "error": "Internal Server Error", "message": message})),
        )
            .into_response();
    };
    let name = match folder_name(name) {
        Ok(name) => name,
        Err(message) => return text(Status::BAD_REQUEST, message),
    };
    let (parent, path, absolute) = if app.unrestricted {
        let parent = resolve_unrestricted(&app, parent);
        if parent == DRIVES {
            return text(Status::BAD_REQUEST, "Cannot create folders at drive root");
        }
        let absolute = child(&parent, name);
        (PathBuf::from(&parent), absolute.clone(), PathBuf::from(absolute))
    } else {
        let relative = parent.unwrap_or(".").replace('\\', "/");
        let relative = relative.trim_start_matches("./").trim_start_matches('/');
        let relative = if relative.is_empty() { "." } else { relative };
        if Path::new(relative).components().any(|c| c == Component::ParentDir) {
            return text(Status::BAD_REQUEST, "Access outside of root is not allowed");
        }
        let Some(parent) = paths::canonical(&app.root, app.root.join(relative)) else {
            return text(Status::BAD_REQUEST, "Access outside of root is not allowed");
        };
        let path = if relative == "." { name.to_owned() } else { format!("{relative}/{name}") };
        (parent.clone(), path, parent.join(name))
    };
    let shown = parent.to_string_lossy().into_owned();
    if let Err(message) = local(&shown) {
        return text(Status::BAD_REQUEST, &message);
    }
    match tokio::fs::metadata(&parent).await {
        Ok(info) if info.is_dir() => {}
        Ok(_) => return text(Status::BAD_REQUEST, &format!("Path is not a directory: {shown}")),
        Err(e) => return text(Status::BAD_REQUEST, &node_error(&e, "stat", &shown)),
    }
    match tokio::fs::create_dir(&absolute).await {
        Ok(()) => (Status::CREATED, Json(json!({"path": path, "absolutePath": absolute}))).into_response(),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => text(Status::CONFLICT, "Folder already exists"),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => text(Status::FORBIDDEN, "Permission denied"),
        Err(e) => text(Status::BAD_REQUEST, &node_error(&e, "mkdir", &absolute.to_string_lossy())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn windows_paths_normalize_like_node() {
        for (input, expected) in [
            (r"C:\Users\a\..\b", r"C:\Users\b"),
            ("C:/Users//x/./y/", r"C:\Users\x\y\"),
            (r"C:\", r"C:\"),
            (r"C:\..", r"C:\"),
            (r"\\server\share\x\..\y", r"\\server\share\y"),
            (r"a\..\..\b", r"..\b"),
            (r"\\", r"\"),
        ] {
            assert_eq!(normalize(input), expected, "{input}");
        }
        assert_eq!(parent(r"C:\Users\x"), Some(r"C:\Users".into()));
        assert_eq!(parent(r"C:\Users"), Some(r"C:\".into()));
        assert_eq!(parent(r"C:\"), Some(DRIVES.into()));
        assert_eq!(parent(r"\\server\share\x"), Some(r"\\server\share\".into()));
        assert_eq!(child(r"C:\", "x"), r"C:\x");
        assert_eq!(child(r"C:\a", "x"), r"C:\a\x");
    }

    #[test]
    #[cfg(unix)]
    fn posix_paths_normalize_like_node() {
        assert_eq!(normalize("/a/b/../c//d/"), "/a/c/d/");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(parent("/a/b"), Some("/a".into()));
        assert_eq!(parent("/a"), Some("/".into()));
        assert_eq!(parent("/"), None);
    }

    #[test]
    fn folder_names_follow_the_reference() {
        assert_eq!(folder_name("  new  "), Ok("new"));
        for bad in ["", " ", ".", "..", "~x", "a/b", "a\\b", "a\0"] {
            assert!(folder_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn folder_identity_is_device_and_index() {
        let dir = crate::shared::test_dir("browse-identity");
        let identity = directory_identity(&dir).unwrap();
        let (device, index) = identity.split_once(':').unwrap();
        assert!(device.parse::<u64>().is_ok() && index.parse::<u64>().is_ok());
        assert_eq!(directory_identity(&dir), Some(identity));
        let _ = std::fs::remove_dir_all(dir);
    }
}
