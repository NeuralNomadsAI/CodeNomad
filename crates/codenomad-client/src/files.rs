//! Scoped workspace files; directory ownership and physical paths stay with the server.
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
pub enum EntryKind {
    File,
    Directory,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateEntry {
    Created,
    NameTaken,
    Rejected(Option<String>),
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
pub enum WriteResult {
    Saved,
    Conflict,
}

impl Backend {
    pub async fn create_entry(
        &self,
        directory: &str,
        parent: &str,
        name: &str,
        kind: EntryKind,
    ) -> Result<CreateEntry> {
        self.file_scope(directory, parent, true)?;
        relative(name, false, directory)?;
        if name.contains('/') {
            return Err("expected a single file name".into());
        }
        let kind = match kind {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
        };
        let response = self
            .client
            .post(format!(
                "{}api/workspaces/{}/files/entries",
                self.base, self.workspace
            ))
            .query(&[("directory", directory)])
            .json(&serde_json::json!({ "parent": parent, "name": name, "kind": kind }))
            .send()
            .await?;
        match response.status() {
            reqwest::StatusCode::CREATED => Ok(CreateEntry::Created),
            reqwest::StatusCode::CONFLICT => Ok(CreateEntry::NameTaken),
            status
                if status.is_client_error() && status != reqwest::StatusCode::REQUEST_TIMEOUT =>
            {
                let body = read_json_limited(response, 4096).await.ok();
                let reason = body
                    .as_ref()
                    .and_then(|body| body["error"].as_str())
                    .map(str::trim)
                    .filter(|reason| !reason.is_empty())
                    .map(str::to_owned);
                Ok(CreateEntry::Rejected(reason))
            }
            _ => {
                response.error_for_status()?;
                Err("unexpected file creation response".into())
            }
        }
    }

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
        if contents.len() > MAX_FILE_BYTES || expected_version.is_empty() {
            return Err("invalid file write".into());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "contents":contents,"expectedVersion":expected_version
        }))?;
        if body.len() > 8 * 1024 * 1024 {
            return Err("oversized file write".into());
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
            .await?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            return Ok(WriteResult::Conflict);
        }
        let response = response.error_for_status()?;
        if !response.status().is_success() {
            return Err("unexpected file write response".into());
        }
        Ok(WriteResult::Saved)
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
            .await?;
        if response.status() == reqwest::StatusCode::BAD_REQUEST {
            let error = response.error_for_status_ref().err();
            let body = read_json_limited(response, 4096).await;
            if body.is_ok_and(|body| body["error"] == "Directory listing too large") {
                return Err(ListingTooLarge.into());
            }
            return Err(error.ok_or("invalid file listing response")?.into());
        }
        let data = read_json(response.error_for_status()?).await?;
        let rows = data.as_array().ok_or("invalid file listing")?;
        if rows.len() > MAX_ENTRIES {
            return Err(ListingTooLarge.into());
        }
        let mut seen = HashSet::new();
        rows.iter()
            .map(|row| {
                let name = string(row, "name")?;
                let key = string(row, "path")?;
                relative(key, false, directory)?;
                let (parent, leaf) = key.rsplit_once('/').unwrap_or((".", key));
                if parent != path || leaf != name || !seen.insert(key) {
                    return Err("foreign or duplicate file entry".into());
                }
                let absolute_path = optional(row, "absolutePath")?;
                if absolute_path
                    .as_deref()
                    .is_some_and(|p| !crate::absolute_server_path(p))
                {
                    return Err("invalid absolute file path".into());
                }
                Ok(Entry {
                    name: name.into(),
                    path: key.into(),
                    kind: match string(row, "type")? {
                        "file" => EntryKind::File,
                        "directory" => EntryKind::Directory,
                        _ => return Err("invalid file entry type".into()),
                    },
                    absolute_path,
                    directory_identity: optional(row, "directoryIdentity")?,
                    size: row
                        .get("size")
                        .map(|v| v.as_u64().ok_or("invalid file size"))
                        .transpose()?,
                    modified_at: optional(row, "modifiedAt")?,
                })
            })
            .collect()
    }
    pub async fn preview_file(&self, directory: &str, path: &str) -> Result<Preview> {
        self.file_scope(directory, path, false)?;
        let data = read_json_limited(
            self.client
                .get(format!(
                    "{}api/workspaces/{}/files/preview",
                    self.base, self.workspace
                ))
                .query(&[("path", path), ("directory", directory)])
                .send()
                .await?
                .error_for_status()?,
            MAX_PREVIEW_JSON,
        )
        .await?;
        if data["workspaceId"].as_str() != Some(self.workspace.as_str())
            || data["relativePath"].as_str() != Some(path)
        {
            return Err("foreign file preview".into());
        }
        if data["encoding"].as_str() != Some("base64") {
            return Err("invalid file preview encoding".into());
        }
        let contents = string(&data, "contents")?;
        if contents.len() > MAX_CONTENTS {
            return Err("oversized file preview".into());
        }
        let bytes = STANDARD.decode(contents)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("oversized file preview".into());
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
            return Err("invalid file scope".into());
        }
        relative(path, listing, directory)
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
        return Err("invalid relative file path".into());
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| "invalid file response".into())
}
fn optional(value: &Value, key: &str) -> Result<Option<String>> {
    value
        .get(key)
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "invalid file metadata".into())
        })
        .transpose()
}
