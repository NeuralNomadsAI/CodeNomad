//! `GET /api/filesystem`: the folder browser under the server root.
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use crate::{Error, Shared, error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    path: Option<PathBuf>,
    include_files: Option<String>,
}

fn invalid() -> Error {
    error(Status::BAD_REQUEST, "Path is outside the authorized filesystem root")
}

pub async fn browse(
    State(app): State<Shared>,
    input: Result<Query<Input>, QueryRejection>,
) -> Result<Json<Value>, Error> {
    let Query(input) = input.map_err(|_| invalid())?;
    let path = input.path.unwrap_or_else(|| PathBuf::from("."));
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(invalid());
    }
    let directory = crate::files::paths::canonical(&app.root, app.root.join(path)).ok_or_else(invalid)?;
    let relative = |path: &Path| {
        path.strip_prefix(&app.root)
            .ok()
            .map(
                |path| {
                    if path.as_os_str().is_empty() { ".".into() } else { path.to_string_lossy().replace('\\', "/") }
                },
            )
            .ok_or_else(invalid)
    };
    let current = relative(&directory)?;
    let mut listing = tokio::fs::read_dir(&directory).await.map_err(|_| invalid())?;
    let mut entries = Vec::new();
    while let Some(entry) = listing.next_entry().await.map_err(|_| invalid())? {
        let absolute = entry.path();
        // A link can name an unauthorized root. Do not publish it or its stats.
        let Ok(resolved) = dunce::canonicalize(&absolute) else { continue };
        if !resolved.starts_with(&app.root) {
            continue;
        }
        let Ok(info) = tokio::fs::metadata(&resolved).await else { continue };
        if !info.is_dir() && (!info.is_file() || input.include_files.as_deref() == Some("")) {
            continue;
        }
        let modified = DateTime::<Utc>::from(info.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let mut value = json!({"name":name,"path":relative(&absolute)?,"absolutePath":absolute,
            "type":if info.is_dir() {"directory"} else {"file"}, "modifiedAt":modified.to_rfc3339_opts(SecondsFormat::Millis,true)});
        if info.is_file() {
            value["size"] = json!(info.len());
        }
        entries.push(value);
        if entries.len() > 2000 {
            return Err(error(Status::BAD_REQUEST, "Directory listing too large"));
        }
    }
    entries.sort_by_cached_key(|value| value["name"].as_str().unwrap_or_default().to_lowercase());
    let mut metadata = json!({"scope":"restricted","currentPath":current,"rootPath":app.root,
        "homePath":app.root,"displayPath":directory,"pathKind":"relative"});
    if current != "." {
        metadata["parentPath"] = json!(relative(directory.parent().ok_or_else(invalid)?)?);
    }
    Ok(Json(json!({"entries":entries,"metadata":metadata})))
}
