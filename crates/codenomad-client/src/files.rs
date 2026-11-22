//! Read-only workspace files; directory ownership and physical paths stay with the server.
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

impl Backend {
    /// One listing, with the shared 2 MiB JSON budget; an oversized folder fails intact.
    pub async fn files(&self, directory: &str, path: &str) -> Result<Vec<Entry>> {
        self.file_scope(directory, path, true)?;
        let data = read_json(
            self.client
                .get(format!(
                    "{}api/workspaces/{}/files",
                    self.base, self.workspace
                ))
                .query(&[("path", path), ("directory", directory)])
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let rows = data
            .as_array()
            .filter(|r| r.len() <= MAX_ENTRIES)
            .ok_or("invalid file listing")?;
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
