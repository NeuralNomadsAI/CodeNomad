//! Bounded HTTP adapter for `POST /api/workspaces/clone` and pure destination
//! path helpers mirroring `packages/ui/src/lib/clone-destination.ts`.
use crate::backend::{Backend, read_json_limited};
use futures_lite::StreamExt;
use serde_json::{Value, json};
use std::fmt;

const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_PATH_UTF16: usize = 4096;
const MAX_ERROR_MESSAGE_UTF16: usize = 512;

#[cfg(not(target_arch = "wasm32"))]
const CLONE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneWorkspaceRequest {
    pub repository_url: String,
    pub destination_path: String,
    pub cleanup: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClonedWorkspace {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloneWorkspaceError {
    /// The server requires re-authentication (HTTP 401).
    Unauthorized,
    /// The server does not expose or support workspace cloning (HTTP 404/501/503).
    Unavailable,
    /// Destination conflict (HTTP 409, e.g. non-empty directory without cleanup).
    Conflict(Option<String>),
    /// Invalid request rejected by the server (HTTP 400).
    BadRequest(Option<String>),
    /// Any other HTTP, transport, or response contract error.
    Other(String),
}

impl CloneWorkspaceError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable)
    }

    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict(_))
    }

    pub fn is_bad_request(&self) -> bool {
        matches!(self, Self::BadRequest(_))
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Conflict(message) | Self::BadRequest(message) => message.as_deref(),
            Self::Other(message) => Some(message.as_str()),
            Self::Unauthorized | Self::Unavailable => None,
        }
    }
}

impl fmt::Display for CloneWorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => f.write_str("authentication required"),
            Self::Unavailable => f.write_str("workspace cloning unavailable"),
            Self::Conflict(Some(message)) => f.write_str(message),
            Self::Conflict(None) => f.write_str("destination conflict"),
            Self::BadRequest(Some(message)) => f.write_str(message),
            Self::BadRequest(None) => f.write_str("invalid clone request"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CloneWorkspaceError {}

fn has_url_scheme(source: &str) -> bool {
    let Some((scheme, _)) = source.split_once("://") else {
        return false;
    };
    let mut bytes = scheme.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'.' | b'-'))
}

fn strip_trailing_git_segment(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.len() >= 5
        && matches!(bytes[bytes.len() - 5], b'/' | b'\\')
        && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".git")
    {
        &path[..bytes.len() - 5]
    } else {
        path
    }
}

fn strip_git_suffix(name: &str) -> &str {
    let bytes = name.as_bytes();
    if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".git") {
        &name[..bytes.len() - 4]
    } else {
        name
    }
}

fn is_unc_share_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() < 5 || !matches!(bytes[0], b'/' | b'\\') || !matches!(bytes[1], b'/' | b'\\') {
        return false;
    }
    let rest = &path[2..];
    let rest = if rest.ends_with(['/', '\\']) {
        &rest[..rest.len() - 1]
    } else {
        rest
    };
    let mut parts = rest.split(['/', '\\']);
    let Some(server) = parts.next() else {
        return false;
    };
    let Some(share) = parts.next() else {
        return false;
    };
    !server.is_empty() && !share.is_empty() && parts.next().is_none()
}

/// The folder `git clone` creates for a repository: its last path segment without `.git`.
pub fn repository_folder_name(repository_url: &str) -> String {
    // Like git: a source ending in `/.git` (a repository's Git folder) is named after the folder holding it.
    let source = repository_url.trim();
    // Only URLs carry a query or fragment; `#` is an ordinary character in a local path.
    let stripped = if has_url_scheme(source) {
        source.split(['?', '#']).next().unwrap_or(source)
    } else {
        source
    };
    let path = strip_trailing_git_segment(stripped.trim_end_matches(['/', '\\']))
        .trim_end_matches(['/', '\\']);
    let segment = path.rsplit(['/', '\\', ':']).next().unwrap_or("");
    let name = strip_git_suffix(segment);
    if matches!(name, "." | "..") {
        String::new()
    } else {
        name.to_owned()
    }
}

/// The folder containing `path`, keeping a root's trailing separator (`D:\`, `/`, `\\server\share\`).
pub fn parent_directory(path: &str) -> String {
    if is_unc_share_root(path) {
        return if path.ends_with(['/', '\\']) {
            path.to_owned()
        } else {
            let sep = path.as_bytes()[0] as char;
            format!("{path}{sep}")
        };
    }
    let core = path.trim_end_matches(['/', '\\']);
    let trimmed = if core.len() < path.len()
        && core
            .chars()
            .next_back()
            .is_some_and(|ch| !matches!(ch, '/' | '\\' | ':'))
    {
        core
    } else {
        path
    };
    let Some(index) = trimmed.rfind(['/', '\\']) else {
        return String::new();
    };
    let parent = &trimmed[..index];
    if parent.is_empty() || parent.ends_with(':') {
        trimmed[..=index].to_owned()
    } else {
        parent.to_owned()
    }
}

/// The suggested clone destination: the repository's folder inside `parent`.
pub fn suggest_clone_destination(parent: Option<&str>, repository_url: &str) -> String {
    let Some(parent) = parent.filter(|p| !p.is_empty()) else {
        return String::new();
    };
    let name = repository_folder_name(repository_url);
    if name.is_empty() {
        return String::new();
    }
    let separator = if parent.contains('\\') && !parent.contains('/') {
        '\\'
    } else {
        '/'
    };
    if parent.ends_with(['/', '\\']) {
        format!("{parent}{name}")
    } else {
        format!("{parent}{separator}{name}")
    }
}

fn sanitize_error_message(raw: &str) -> Option<String> {
    if raw
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return None;
    }
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed
            .encode_utf16()
            .nth(MAX_ERROR_MESSAGE_UTF16)
            .is_some()
    {
        return None;
    }
    Some(trimmed.to_owned())
}

async fn parse_error(response: reqwest::Response) -> CloneWorkspaceError {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return CloneWorkspaceError::Unauthorized;
    }
    if matches!(status.as_u16(), 404 | 501 | 503) {
        return CloneWorkspaceError::Unavailable;
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    let mut exceeded = false;
    while let Some(chunk) = chunks.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        if chunk.len() > MAX_ERROR_BYTES.saturating_sub(bytes.len()) {
            exceeded = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let message = if !exceeded
        && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
        && let Some(obj) = body.as_object()
    {
        obj.get("message")
            .and_then(Value::as_str)
            .and_then(sanitize_error_message)
            .or_else(|| {
                obj.get("error")
                    .and_then(Value::as_str)
                    .and_then(sanitize_error_message)
            })
    } else {
        None
    };
    match status {
        reqwest::StatusCode::CONFLICT => CloneWorkspaceError::Conflict(message),
        reqwest::StatusCode::BAD_REQUEST => CloneWorkspaceError::BadRequest(message),
        _ => CloneWorkspaceError::Other(
            message.unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
        ),
    }
}

fn parse_cloned_workspace(
    data: &Value,
) -> std::result::Result<ClonedWorkspace, CloneWorkspaceError> {
    let path = data
        .as_object()
        .and_then(|obj| obj.get("path"))
        .and_then(Value::as_str)
        .filter(|path| {
            !path.trim().is_empty()
                && crate::absolute_server_path(path)
                && !path.chars().any(char::is_control)
                && path.encode_utf16().nth(MAX_PATH_UTF16).is_none()
        })
        .ok_or_else(|| CloneWorkspaceError::Other("invalid cloned workspace path".into()))?;
    Ok(ClonedWorkspace {
        path: path.to_owned(),
    })
}

impl Backend {
    /// Clones a Git repository into `destination_path` on the connected server
    /// via `POST /api/workspaces/clone`.
    pub async fn clone_workspace_repository(
        &self,
        request: &CloneWorkspaceRequest,
    ) -> std::result::Result<ClonedWorkspace, CloneWorkspaceError> {
        let payload = json!({
            "repositoryUrl": request.repository_url,
            "destinationPath": request.destination_path,
            "cleanup": request.cleanup,
        });
        let builder = self
            .client
            .post(format!("{}api/workspaces/clone", self.base))
            .json(&payload);
        #[cfg(not(target_arch = "wasm32"))]
        let builder = builder.timeout(CLONE_TIMEOUT);
        let response = builder
            .send()
            .await
            .map_err(|err| CloneWorkspaceError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        let data = read_json_limited(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|err| CloneWorkspaceError::Other(err.to_string()))?;
        parse_cloned_workspace(&data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_folder_name_matches_git_and_solid_contract() {
        assert_eq!(
            repository_folder_name("https://github.com/pascalandr/open-design"),
            "open-design"
        );
        assert_eq!(
            repository_folder_name(" https://github.com/user/repo.git/ "),
            "repo"
        );
        assert_eq!(
            repository_folder_name("https://github.com/user/repo.GIT///"),
            "repo"
        );
        assert_eq!(
            repository_folder_name("git@github.com:user/repo.git"),
            "repo"
        );
        assert_eq!(repository_folder_name("git@github.com:repo.git"), "repo");
        assert_eq!(
            repository_folder_name("https://host/user/repo?tab=readme#top"),
            "repo"
        );
        assert_eq!(
            repository_folder_name("ssh://git@host:2222/team/app.git#main"),
            "app"
        );
        assert_eq!(repository_folder_name("D:\\src\\repo\\.git"), "repo");
        assert_eq!(repository_folder_name("D:\\src\\repo\\.GIT\\"), "repo");
        assert_eq!(
            repository_folder_name("D:\\src\\C#-examples"),
            "C#-examples"
        );
        assert_eq!(
            repository_folder_name("/srv/notes?v=1#hash"),
            "notes?v=1#hash"
        );
        assert_eq!(repository_folder_name("/srv/repo.git/.git/"), "repo");
        assert_eq!(repository_folder_name(""), "");
        assert_eq!(repository_folder_name("   "), "");
        assert_eq!(repository_folder_name("."), "");
        assert_eq!(repository_folder_name(".."), "");
        assert_eq!(repository_folder_name("/foo/."), "");
        assert_eq!(repository_folder_name("/foo/.."), "");
        assert_eq!(repository_folder_name("/foo/..git"), "");
        assert_eq!(repository_folder_name(".git"), "");
        assert_eq!(repository_folder_name("/.git"), "");
    }

    #[test]
    fn parent_directory_preserves_roots_and_unc_shares() {
        assert_eq!(parent_directory("D:\\open-design"), "D:\\");
        assert_eq!(parent_directory("D:\\"), "D:\\");
        assert_eq!(parent_directory("D:\\repos\\open-design\\"), "D:\\repos");
        assert_eq!(parent_directory("/home/me/src/repo"), "/home/me/src");
        assert_eq!(parent_directory("/home/me/src/repo///"), "/home/me/src");
        assert_eq!(parent_directory("/repo"), "/");
        assert_eq!(parent_directory("/"), "/");
        assert_eq!(
            parent_directory("\\\\server\\share\\repo"),
            "\\\\server\\share"
        );
        assert_eq!(parent_directory("\\\\server\\share"), "\\\\server\\share\\");
        assert_eq!(
            parent_directory("\\\\server\\share\\"),
            "\\\\server\\share\\"
        );
        assert_eq!(parent_directory("//server/share"), "//server/share/");
        assert_eq!(parent_directory("plain"), "");
    }

    #[test]
    fn suggest_clone_destination_matches_parent_separator() {
        assert_eq!(
            suggest_clone_destination(Some("D:\\"), "https://github.com/pascalandr/open-design"),
            "D:\\open-design"
        );
        assert_eq!(
            suggest_clone_destination(Some("D:\\repos"), "https://github.com/user/repo.git"),
            "D:\\repos\\repo"
        );
        assert_eq!(
            suggest_clone_destination(Some("/home/me/src"), "git@github.com:user/repo.git"),
            "/home/me/src/repo"
        );
        assert_eq!(
            suggest_clone_destination(
                Some(&parent_directory("\\\\server\\share")),
                "https://host/user/repo"
            ),
            "\\\\server\\share\\repo"
        );
        assert_eq!(
            suggest_clone_destination(None, "https://github.com/user/repo"),
            ""
        );
        assert_eq!(suggest_clone_destination(Some("/home/me"), ""), "");
        assert_eq!(suggest_clone_destination(Some("/home/me"), ".."), "");
        assert_eq!(
            suggest_clone_destination(Some(""), "https://github.com/user/repo"),
            ""
        );
    }
}
