//! Scoped workspace files; directory ownership and physical paths stay with the server.
pub mod images;
use crate::{
    backend::{Backend, read_json, read_json_limited},
    history::{Result, valid_id},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::collections::HashSet;

// Shared files/preview caps bytes at 5 MiB; base64 expands each three bytes to four.
pub const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 4096;
const MAX_CONTENTS: usize = MAX_FILE_BYTES.div_ceil(3) * 4;
const MAX_PREVIEW_JSON: usize = MAX_CONTENTS + 64 * 1024;

#[derive(Debug)]
pub struct ListingTooLarge;
impl std::fmt::Display for ListingTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Directory listing too large")
    }
}
impl std::error::Error for ListingTooLarge {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileError {
    NotFound,
    WorkspaceUnavailable,
    Unavailable,
    AccessDenied,
    Unauthorized,
    TooLarge,
    Conflict,
    InvalidRequest,
    InvalidEncoding,
    UnexpectedResponse,
    Transport,
    Server,
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "file_not_found",
            Self::WorkspaceUnavailable => "file_workspace_unavailable",
            Self::Unavailable => "file_unavailable",
            Self::AccessDenied => "file_access_denied",
            Self::Unauthorized => "file_unauthorized",
            Self::TooLarge => "file_too_large",
            Self::Conflict => "file_conflict",
            Self::InvalidRequest => "file_invalid_request",
            Self::InvalidEncoding => "file_invalid_encoding",
            Self::UnexpectedResponse => "file_unexpected_response",
            Self::Transport => "file_transport",
            Self::Server => "file_server",
        })
    }
}
impl std::error::Error for FileError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub absolute_path: Option<String>,
    pub directory_identity: Option<String>,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub workspace_id: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteConflict {
    ChangedOnDisk,
    WorktreeDeleting,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteResult {
    Saved(Option<String>),
    Conflict(WriteConflict),
}

impl Backend {
    /// Workspace Markdown uses the application URL as its base, rather than a checkout path.
    pub fn file_link(&self, destination: &str) -> Option<String> {
        #[cfg(target_arch = "wasm32")]
        let page = web_sys::window().and_then(|window| window.location().href().ok());
        #[cfg(not(target_arch = "wasm32"))]
        let page: Option<String> = None;
        file_link(page.as_deref().unwrap_or(&self.base), destination)
    }

    pub async fn write_file(
        &self,
        directory: &str,
        path: &str,
        contents: &str,
        expected_version: &str,
    ) -> Result<WriteResult> {
        self.file_scope(directory, path, false)?;
        if contents.len() > MAX_FILE_BYTES {
            return Err(FileError::TooLarge.into());
        }
        if expected_version.is_empty() {
            return Err(FileError::InvalidRequest.into());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "contents":contents,"expectedVersion":expected_version
        }))
        .map_err(|_| FileError::InvalidRequest)?;
        if body.len() > 8 * 1024 * 1024 {
            return Err(FileError::TooLarge.into());
        }
        let response = self
            .client
            .put(format!(
                "{}api/workspaces/{}/files/content",
                self.base, self.workspace
            ))
            .query(&[("path", path), ("directory", directory)])
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| FileError::Transport)?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            let reason = read_json_limited(response, 4096)
                .await
                .ok()
                .and_then(|body| {
                    let reason = body["error"].as_str()?.trim();
                    (!reason.is_empty()).then(|| reason.to_owned())
                });
            let conflict = match reason.as_deref() {
                Some("File changed on disk") => WriteConflict::ChangedOnDisk,
                Some("Worktree deletion is in progress") => WriteConflict::WorktreeDeleting,
                _ => WriteConflict::Other,
            };
            return Ok(WriteResult::Conflict(conflict));
        }
        if !response.status().is_success() {
            return Err(classify_http_error(response, false).await);
        }
        let version = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128)
            .map(str::to_owned);
        Ok(WriteResult::Saved(version))
    }
    /// One listing, with the shared 2 MiB JSON budget; an oversized folder fails intact.
    pub async fn files(&self, directory: &str, path: &str) -> Result<Vec<Entry>> {
        self.file_scope(directory, path, true)?;
        let response = self
            .client
            .get(format!(
                "{}api/workspaces/{}/files",
                self.base, self.workspace
            ))
            .query(&[("path", path), ("directory", directory)])
            .send()
            .await
            .map_err(|_| FileError::Transport)?;
        if !response.status().is_success() {
            return Err(classify_http_error(response, true).await);
        }
        let data = read_json(response).await.map_err(map_json_error)?;
        let rows = data.as_array().ok_or(FileError::UnexpectedResponse)?;
        if rows.len() > MAX_ENTRIES {
            return Err(ListingTooLarge.into());
        }
        let mut seen = HashSet::new();
        rows.iter()
            .map(|row| {
                let name = string(row, "name")?;
                let key = string(row, "path")?;
                relative(key, false, directory).map_err(|_| FileError::UnexpectedResponse)?;
                let (parent, leaf) = key.rsplit_once('/').unwrap_or((".", key));
                if parent != path || leaf != name || !seen.insert(key) {
                    return Err(FileError::UnexpectedResponse.into());
                }
                let absolute_path = optional(row, "absolutePath")?;
                if absolute_path
                    .as_deref()
                    .is_some_and(|p| !crate::absolute_server_path(p))
                {
                    return Err(FileError::UnexpectedResponse.into());
                }
                Ok(Entry {
                    name: name.into(),
                    path: key.into(),
                    kind: match string(row, "type")? {
                        "file" => EntryKind::File,
                        "directory" => EntryKind::Directory,
                        _ => return Err(FileError::UnexpectedResponse.into()),
                    },
                    absolute_path,
                    directory_identity: optional(row, "directoryIdentity")?,
                    size: row
                        .get("size")
                        .map(|v| v.as_u64().ok_or(FileError::UnexpectedResponse))
                        .transpose()?,
                    modified_at: optional(row, "modifiedAt")?,
                })
            })
            .collect()
    }
    pub async fn preview_file(&self, directory: &str, path: &str) -> Result<Preview> {
        self.file_scope(directory, path, false)?;
        let response = self
            .client
            .get(format!(
                "{}api/workspaces/{}/files/preview",
                self.base, self.workspace
            ))
            .query(&[("path", path), ("directory", directory)])
            .send()
            .await
            .map_err(|_| FileError::Transport)?;
        if !response.status().is_success() {
            return Err(classify_http_error(response, false).await);
        }
        let data = read_json_limited(response, MAX_PREVIEW_JSON)
            .await
            .map_err(map_json_error)?;
        if data["workspaceId"].as_str() != Some(self.workspace.as_str())
            || data["relativePath"].as_str() != Some(path)
        {
            return Err(FileError::UnexpectedResponse.into());
        }
        if data["encoding"].as_str() != Some("base64") {
            return Err(FileError::InvalidEncoding.into());
        }
        let contents = string(&data, "contents")?;
        if contents.len() > MAX_CONTENTS {
            return Err(FileError::TooLarge.into());
        }
        let bytes = STANDARD
            .decode(contents)
            .map_err(|_| FileError::InvalidEncoding)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(FileError::TooLarge.into());
        }
        Ok(Preview {
            workspace_id: self.workspace.clone(),
            path: path.into(),
            bytes,
            version: optional(&data, "version")?,
        })
    }
    fn file_scope(&self, directory: &str, path: &str, listing: bool) -> Result<()> {
        if !valid_id(&self.workspace) || !crate::absolute_server_path(directory) {
            return Err(FileError::InvalidRequest.into());
        }
        relative(path, listing, directory)
    }
}

async fn classify_http_error(response: reqwest::Response, listing: bool) -> crate::history::Error {
    let status = response.status();
    let message = read_json_limited(response, 4096)
        .await
        .ok()
        .and_then(|body| {
            body["error"]
                .as_str()
                .or(body["message"].as_str())
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        });
    if listing
        && status == reqwest::StatusCode::BAD_REQUEST
        && message.as_deref() == Some("Directory listing too large")
    {
        return ListingTooLarge.into();
    }
    classify_status(status, message.as_deref()).into()
}

fn classify_status(status: reqwest::StatusCode, message: Option<&str>) -> FileError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => FileError::Unauthorized,
        reqwest::StatusCode::FORBIDDEN => FileError::AccessDenied,
        reqwest::StatusCode::NOT_FOUND => match message {
            Some("Workspace not found") => FileError::WorkspaceUnavailable,
            _ => FileError::NotFound,
        },
        reqwest::StatusCode::CONFLICT => FileError::Conflict,
        reqwest::StatusCode::PAYLOAD_TOO_LARGE => FileError::TooLarge,
        reqwest::StatusCode::BAD_REQUEST => match message {
            Some("Selected file is too large to attach") => FileError::TooLarge,
            Some("Access outside of root is not allowed")
            | Some("Directory is not owned by this workspace") => FileError::AccessDenied,
            Some("Selected path is unavailable") => FileError::Unavailable,
            _ => FileError::InvalidRequest,
        },
        status if status.is_server_error() => FileError::Server,
        status if status.is_client_error() => FileError::InvalidRequest,
        _ => FileError::UnexpectedResponse,
    }
}

fn map_json_error(error: crate::history::Error) -> crate::history::Error {
    if error.is::<reqwest::Error>() {
        FileError::Transport.into()
    } else if error.to_string() == "oversized response" {
        FileError::TooLarge.into()
    } else {
        FileError::UnexpectedResponse.into()
    }
}
fn file_link(base: &str, destination: &str) -> Option<String> {
    if destination.trim().is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(base).ok()?.join(destination).ok()?;
    matches!(url.scheme(), "http" | "https" | "mailto").then(|| url.into())
}

#[cfg(test)]
#[test]
fn reader_links_preserve_the_base_page_context() {
    let base = "https://example.invalid/app/?locale=he";
    assert_eq!(
        file_link(base, "#reader").as_deref(),
        Some("https://example.invalid/app/?locale=he#reader")
    );
    assert_eq!(
        file_link(base, "./notes.md").as_deref(),
        Some("https://example.invalid/app/notes.md")
    );
    assert!(file_link(base, "file:///C:/secret.md").is_none());
}

// The listing contract emits relative slash paths. The server owns OS-specific admission.
pub(crate) fn relative(path: &str, listing: bool, directory: &str) -> Result<()> {
    if listing && path == "." {
        return Ok(());
    }
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || !directory.starts_with('/') && crate::absolute_server_path(path)
        || path.contains(['\\', '\0'])
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(FileError::InvalidRequest.into());
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| FileError::UnexpectedResponse.into())
}
fn optional(value: &Value, key: &str) -> Result<Option<String>> {
    value
        .get(key)
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| FileError::UnexpectedResponse.into())
        })
        .transpose()
}
