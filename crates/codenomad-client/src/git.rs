//! Display reads and explicit mutations for CodeNomad's owned Git checkouts.
use crate::{
    backend::{Backend, read_json_limited},
    catalog::{Project, Sessions},
    files::{MAX_FILE_BYTES, relative},
    history::{Result, valid_id},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{RequestBuilder, Url};
use serde_json::{Value, json};
use std::{collections::HashSet, fmt};

const INVENTORY_BYTES: usize = 8 * 1024 * 1024;
const DIFF_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repository {
    Git,
    Uninitialized,
    NoGit,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub slug: String,
    pub directory: String,
    pub service_directory: Option<String>,
    pub branch: Option<String>,
    pub missing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktrees {
    pub repository: Repository,
    pub trees: Vec<Worktree>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Section {
    Staged,
    Unstaged,
}

impl Section {
    pub fn key(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub kind: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: Option<Change>,
    pub unstaged: Option<Change>,
    pub whitespace_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    pub id: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub head: Option<String>,
    pub commits: Vec<Commit>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Details {
    pub id: String,
    pub message: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Diff {
    Text {
        before: String,
        after: String,
    },
    Image {
        mime: String,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
    },
    Binary,
}

#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    pub code: Option<String>,
    message: Option<String>,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(message) = &self.message {
            f.write_str(message)
        } else {
            write!(f, "HTTP {}", self.status)
        }
    }
}
impl std::error::Error for Refusal {}

impl Backend {
    pub async fn git_hide_whitespace(&self) -> Result<bool> {
        let data = read(
            self.client
                .get(format!("{}api/storage/config/ui", self.base)),
            INVENTORY_BYTES,
        )
        .await?;
        match &data["settings"]["hideDiffWhitespaceChanges"] {
            Value::Bool(hide) => Ok(*hide),
            Value::Null => Ok(true),
            _ => Err("invalid Git whitespace preference".into()),
        }
    }

    fn git_route(&self, segments: &[&str]) -> Result<Url> {
        if !valid_id(&self.workspace) {
            return Err("invalid Git workspace".into());
        }
        let mut url = Url::parse(&self.base)?;
        url.path_segments_mut()
            .map_err(|_| "invalid Git backend URL")?
            .pop_if_empty()
            .extend(["api", "workspaces", &self.workspace])
            .extend(segments.iter().copied());
        Ok(url)
    }

    fn git_tree_route(&self, slug: &str, tail: &[&str]) -> Result<Url> {
        if !valid_slug(slug) {
            return Err("invalid Git worktree".into());
        }
        let mut url = self.git_route(&["worktrees", slug])?;
        url.path_segments_mut()
            .map_err(|_| "invalid Git backend URL")?
            .extend(tail.iter().copied());
        Ok(url)
    }

    pub async fn git_worktrees(&self, fresh: bool) -> Result<Worktrees> {
        let data = read(
            self.client
                .get(self.git_route(&["worktrees"])?)
                .query(&[("fresh", if fresh { "true" } else { "false" })]),
            INVENTORY_BYTES,
        )
        .await?;
        let repository = match (data["gitAvailable"].as_bool(), data["isGitRepo"].as_bool()) {
            (Some(false), _) => Repository::NoGit,
            (_, Some(true)) => Repository::Git,
            (_, Some(false)) => Repository::Uninitialized,
            _ => Repository::Unknown,
        };
        let mut seen = HashSet::new();
        let trees = rows(&data["worktrees"], 4096)?
            .iter()
            .map(|row| {
                let slug = field(row, "slug")?;
                let directory = field(row, "directory")?;
                if !valid_slug(&slug)
                    || !crate::absolute_server_path(&directory)
                    || !seen.insert(slug.clone())
                {
                    return Err("invalid or duplicate worktree".into());
                }
                let service_directory = optional(row, "serviceDirectory")?;
                if service_directory
                    .as_deref()
                    .is_some_and(|d| !crate::absolute_server_path(d))
                {
                    return Err("invalid worktree service directory".into());
                }
                Ok(Worktree {
                    slug,
                    directory,
                    service_directory,
                    branch: optional(row, "branch")?,
                    missing: flag(row, "nestedFolderMissing")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if !seen.contains("root") {
            return Err("worktree inventory has no root".into());
        }
        Ok(Worktrees { repository, trees })
    }

    pub async fn git_status(&self, tree: &Worktree, hide_whitespace: bool) -> Result<Vec<Status>> {
        let mut request = self
            .client
            .get(self.git_tree_route(&tree.slug, &["git-status"])?);
        if hide_whitespace {
            request = request.query(&[("hideWhitespace", "1")]);
        }
        let data = read(request, INVENTORY_BYTES).await?;
        let mut seen = HashSet::new();
        rows(&data, 8192)?
            .iter()
            .map(|row| {
                let path = field(row, "path")?;
                relative(&path, false, &tree.directory)?;
                if !seen.insert(path.clone()) {
                    return Err("duplicate Git status path".into());
                }
                let staged = change(row, "stagedStatus", "stagedAdditions", "stagedDeletions")?;
                let unstaged = change(
                    row,
                    "unstagedStatus",
                    "unstagedAdditions",
                    "unstagedDeletions",
                )?;
                let whitespace_only = flag(row, "unstagedWhitespaceOnly")?
                    && unstaged
                        .as_ref()
                        .is_some_and(|value| value.kind == "modified")
                    && staged.as_ref().is_none_or(|value| value.kind != "unmerged");
                Ok(Status {
                    path,
                    original_path: original_path(row, &tree.directory)?,
                    staged,
                    unstaged,
                    whitespace_only,
                })
            })
            .collect()
    }

    pub async fn git_history(&self, slug: &str, previous: Option<(&str, usize)>) -> Result<Page> {
        let mut request = self
            .client
            .get(self.git_tree_route(slug, &["git-history"])?);
        request = if let Some((head, offset)) = previous {
            sha(head)?;
            request.query(&[("offset", offset.to_string().as_str()), ("head", head)])
        } else {
            request.query(&[("offset", "0")])
        };
        let data = read(request, INVENTORY_BYTES).await?;
        let head = optional(&data, "head")?;
        if let Some(head) = &head {
            sha(head)?;
        }
        let mut ids = HashSet::new();
        let commits = rows(&data["commits"], 50)?
            .iter()
            .map(|row| {
                let id = field(row, "id")?;
                sha(&id)?;
                if !ids.insert(id.clone()) {
                    return Err("duplicate Git commit".into());
                }
                Ok(Commit {
                    id,
                    subject: field(row, "subject")?,
                    author: field(row, "author")?,
                    date: field(row, "date")?,
                    refs: field(row, "refs")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let has_more = data["hasMore"]
            .as_bool()
            .ok_or("missing Git continuation flag")?;
        if (head.is_none() && (!commits.is_empty() || has_more))
            || has_more && commits.is_empty()
            || previous.is_some_and(|(anchor, _)| head.as_deref() != Some(anchor))
            || previous.is_none() && commits.first().map(|item| &item.id) != head.as_ref()
        {
            return Err("invalid Git history anchor".into());
        }
        Ok(Page {
            head,
            commits,
            has_more,
        })
    }

    pub async fn git_commit_details(&self, tree: &Worktree, commit: &str) -> Result<Details> {
        sha(commit)?;
        let data = read(
            self.client
                .get(self.git_tree_route(&tree.slug, &["git-history", commit])?),
            INVENTORY_BYTES,
        )
        .await?;
        if data["id"].as_str() != Some(commit) {
            return Err("foreign Git commit".into());
        }
        let mut seen = HashSet::new();
        let files = rows(&data["files"], 8192)?
            .iter()
            .map(|row| {
                let path = field(row, "path")?;
                relative(&path, false, &tree.directory)?;
                if !seen.insert(path.clone()) {
                    return Err("duplicate Git commit file".into());
                }
                Ok(CommitFile {
                    path,
                    original_path: original_path(row, &tree.directory)?,
                    kind: field(row, "status")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Details {
            id: commit.into(),
            message: field(&data, "message")?,
            files,
        })
    }

    pub async fn git_local_diff(
        &self,
        tree: &Worktree,
        section: Section,
        path: &str,
        original: Option<&str>,
    ) -> Result<Diff> {
        exact_path(path, &tree.directory)?;
        let mut request = self
            .client
            .get(self.git_tree_route(&tree.slug, &["git-diff"])?)
            .query(&[("path", path), ("scope", section.key())]);
        if let Some(original) = original {
            exact_path(original, &tree.directory)?;
            request = request.query(&[("originalPath", original)]);
        }
        let data = read(request, DIFF_BYTES).await?;
        if data["scope"].as_str() != Some(section.key())
            || optional(&data, "originalPath")?.as_deref() != original
        {
            return Err("foreign Git diff scope".into());
        }
        diff(data, path)
    }

    pub async fn git_commit_diff(&self, tree: &Worktree, commit: &str, path: &str) -> Result<Diff> {
        sha(commit)?;
        relative(path, false, &tree.directory)?;
        diff(
            read(
                self.client
                    .get(self.git_tree_route(&tree.slug, &["git-history", commit])?)
                    .query(&[("path", path)]),
                DIFF_BYTES,
            )
            .await?,
            path,
        )
    }

    pub async fn git_move_paths(
        &self,
        tree: &Worktree,
        from: Section,
        paths: &[String],
    ) -> Result<()> {
        if paths.is_empty() || paths.len() > 8192 {
            return Err("invalid Git mutation paths".into());
        }
        for path in paths {
            exact_path(path, &tree.directory)?;
        }
        let route = match from {
            Section::Staged => "git-unstage",
            Section::Unstaged => "git-stage",
        };
        let route = self.git_tree_route(&tree.slug, &[route])?;
        // An acknowledged prefix is never replayed after a failed batch.
        for paths in path_batches(paths) {
            acknowledge(
                self.client
                    .post(route.clone())
                    .json(&json!({"paths": paths})),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn git_commit(&self, slug: &str, message: &str) -> Result<()> {
        let message = message.trim();
        if message.is_empty() || message.len() > 16_384 || message.contains('\0') {
            return Err("invalid Git commit message".into());
        }
        acknowledge(
            self.client
                .post(self.git_tree_route(slug, &["git-commit"])?)
                .json(&json!({"message":message})),
        )
        .await
    }

    pub async fn git_init(&self, directory: &str) -> Result<()> {
        if !crate::absolute_server_path(directory) {
            return Err("invalid Git init directory".into());
        }
        acknowledge(
            self.client
                .post(self.git_route(&["git-init"])?)
                .json(&json!({"directory":directory})),
        )
        .await
    }

    pub async fn git_init_sessions(&self, tree: &Worktree) -> Result<Sessions> {
        if !valid_id(&self.workspace) || tree.slug != "root" {
            return Err("invalid Git root session scope".into());
        }
        let directory = tree.service_directory.as_deref().unwrap_or(&tree.directory);
        let location = read(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/location",
                    self.base, self.workspace
                ))
                .query(&[("location[directory]", directory)]),
            INVENTORY_BYTES,
        )
        .await?;
        if !location["directory"]
            .as_str()
            .is_some_and(|path| crate::same_server_path(path, directory))
            || !location["project"]["id"].as_str().is_some_and(valid_id)
        {
            return Err("unexpected Git init project".into());
        }
        self.sessions(
            &Project {
                id: self.workspace.clone(),
                path: directory.into(),
            },
            None,
        )
        .await
    }
}

fn path_batches(mut paths: &[String]) -> impl Iterator<Item = &[String]> {
    std::iter::from_fn(move || {
        let mut bytes = 0;
        let length = paths
            .iter()
            .take(256)
            .take_while(|path| {
                bytes += path.len();
                bytes <= 16_000
            })
            .count();
        if length == 0 {
            return None;
        }
        let (batch, rest) = paths.split_at(length);
        paths = rest;
        Some(batch)
    })
}

async fn read(request: RequestBuilder, limit: usize) -> Result<Value> {
    let response = request.send().await?;
    if response.status().is_success() {
        return read_json_limited(response, limit).await;
    }
    let status = response.status().as_u16();
    let data = read_json_limited(response, 64 * 1024)
        .await
        .unwrap_or(Value::Null);
    Err(Refusal {
        status,
        code: data["code"].as_str().map(str::to_owned),
        message: data["error"]
            .as_str()
            .or(data["message"].as_str())
            .map(str::to_owned),
    }
    .into())
}

async fn acknowledge(request: RequestBuilder) -> Result<()> {
    if read(request, 64 * 1024).await?["ok"] == true {
        Ok(())
    } else {
        Err("unconfirmed Git mutation".into())
    }
}

fn valid_slug(slug: &str) -> bool {
    !matches!(slug, "" | "." | "..") && slug.len() <= 200 && !slug.chars().any(char::is_control)
}

fn sha(value: &str) -> Result<()> {
    if matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err("invalid Git commit id".into())
    }
}

fn exact_path(path: &str, directory: &str) -> Result<()> {
    if path != path.trim() {
        return Err("Git route trims path edge spaces".into());
    }
    relative(path, false, directory)
}

fn rows(value: &Value, limit: usize) -> Result<&[Value]> {
    value
        .as_array()
        .filter(|items| items.len() <= limit)
        .map(Vec::as_slice)
        .ok_or_else(|| "invalid or oversized Git list".into())
}

fn field(value: &Value, name: &str) -> Result<String> {
    optional(value, name)?.ok_or_else(|| "missing Git response field".into())
}

fn optional(value: &Value, name: &str) -> Result<Option<String>> {
    match &value[name] {
        Value::Null => Ok(None),
        Value::String(value) => Ok(Some(value.clone())),
        _ => Err("invalid Git response field".into()),
    }
}

fn flag(value: &Value, name: &str) -> Result<bool> {
    match &value[name] {
        Value::Null => Ok(false),
        Value::Bool(value) => Ok(*value),
        _ => Err("invalid Git response flag".into()),
    }
}

fn original_path(row: &Value, directory: &str) -> Result<Option<String>> {
    let path = optional(row, "originalPath")?;
    if let Some(path) = &path {
        relative(path, false, directory)?;
    }
    Ok(path)
}

fn change(row: &Value, field: &str, additions: &str, deletions: &str) -> Result<Option<Change>> {
    let Some(kind) = optional(row, field)? else {
        return Ok(None);
    };
    if !matches!(
        kind.as_str(),
        "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged"
    ) {
        return Err("invalid Git status".into());
    }
    Ok(Some(Change {
        kind,
        additions: row[additions].as_u64().ok_or("invalid Git additions")?,
        deletions: row[deletions].as_u64().ok_or("invalid Git deletions")?,
    }))
}

fn diff(data: Value, path: &str) -> Result<Diff> {
    if data["path"].as_str() != Some(path) {
        return Err("foreign Git diff path".into());
    }
    let image = &data["image"];
    if !image.is_null() {
        let mime = field(image, "mime")?;
        if !matches!(
            mime.as_str(),
            "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/x-icon"
                | "image/svg+xml"
        ) {
            return Err("unsupported Git image type".into());
        }
        let decode = |side| -> Result<Option<Vec<u8>>> {
            let Some(encoded) = optional(image, side)? else {
                return Ok(None);
            };
            if encoded.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
                return Err("oversized Git image".into());
            }
            let bytes = STANDARD.decode(encoded)?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err("oversized Git image".into());
            }
            Ok(Some(bytes))
        };
        Ok(Diff::Image {
            mime,
            before: decode("before")?,
            after: decode("after")?,
        })
    } else if flag(&data, "isBinary")? {
        Ok(Diff::Binary)
    } else {
        let before = field(&data, "before")?;
        let after = field(&data, "after")?;
        // Lossy UTF-8 can expand each source byte to the replacement character.
        if before.len().max(after.len()) > 6 * 1024 * 1024 {
            return Err("oversized Git text".into());
        }
        Ok(Diff::Text { before, after })
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
