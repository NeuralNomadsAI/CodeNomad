//! The checkout inventory: `git worktree list` joined to native projects, cached for event routing.
mod cache;
use super::linked::{conflict, git, missing, native, native_error, physical};
use crate::{App, Error, Workspace, files};
use axum::http::Method;
pub use cache::{EventCache, blocking_invalidation, event_catalogue_at, forget, invalidate, invalidate_blocking};
pub(crate) use cache::{HttpSnapshot, ReadMode, emit_worktrees_changed, http_read};
pub(super) use cache::{event_revision, history_catalogue, http_list, media_http_read, receipt_catalogue, revision};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
struct MetaStamp {
    modified: std::time::SystemTime,
    len: u64,
    #[cfg(unix)]
    extra: (u64, u64, i64, i64),
    #[cfg(windows)]
    extra: (u64, u64, u32),
}

fn meta_stamp(meta: &std::fs::Metadata) -> Option<MetaStamp> {
    #[cfg(unix)]
    let extra = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec())
    };
    #[cfg(windows)]
    let extra = {
        use std::os::windows::fs::MetadataExt;
        (meta.last_write_time(), meta.creation_time(), meta.file_attributes())
    };
    Some(MetaStamp { modified: meta.modified().ok()?, len: meta.len(), extra })
}

#[derive(Clone, Debug, PartialEq)]
struct ConfigStamp {
    entry: MetaStamp,
    identity: Option<String>,
    target: Option<(PathBuf, MetaStamp, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Physical {
    root: PathBuf,
    common: PathBuf,
    admin: PathBuf,
    root_id: String,
    common_id: String,
    admin_id: String,
    marker: Option<Vec<u8>>,
    backlink: Option<Vec<u8>>,
    common_marker: Option<Vec<u8>>,
    stamp: [Option<ConfigStamp>; 2],
    ancestors: Vec<(PathBuf, [Option<MetaStamp>; 3])>,
}
pub(super) const CONFIG_CHANGED_ERROR: &str = "Git configuration changed during worktree validation";

fn config_changed_error() -> Error {
    crate::error(axum::http::StatusCode::BAD_REQUEST, CONFIG_CHANGED_ERROR)
}

fn file_identity_stamp(path: &Path) -> Option<String> {
    // On Unix, `meta_stamp` already captures `(dev, ino, ctime, ctime_nsec)` from `lstat`/`stat`
    // without opening the file, so a replaced POSIX FIFO can never stall an open() call.
    #[cfg(unix)]
    {
        let _ = path;
        Some(String::new())
    }
    #[cfg(not(unix))]
    {
        use std::hash::{DefaultHasher, Hash, Hasher};
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        let file = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return None;
        }
        let mut h = DefaultHasher::new();
        same_file::Handle::from_file(file).ok()?.hash(&mut h);
        Some(format!("{:x}", h.finish()))
    }
}

fn resolve_dir_in(scope: &Path, path: &Path) -> Option<PathBuf> {
    if !scope.as_os_str().is_empty() {
        let raw = path.to_str()?;
        super::ownership::resolve_media_path_checked(scope, raw).ok().flatten().and_then(|(p, a)| (p == a).then_some(p))
    } else {
        dunce::canonicalize(path).ok()
    }
}

fn resolve_symlink_file_in(
    scope: &Path,
    path: &Path,
) -> Result<Option<(PathBuf, std::fs::Metadata)>, std::io::ErrorKind> {
    let mut cur = path.to_path_buf();
    for _ in 0..40 {
        let raw_target = match std::fs::read_link(&cur) {
            Ok(target) => target,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(std::io::ErrorKind::NotFound),
            Err(_) => return Ok(None),
        };
        let simplified = dunce::simplified(&raw_target);
        if super::ownership::reject_network_path(&simplified.to_string_lossy(), simplified).is_err() {
            return Ok(None);
        }
        let joined = if simplified.is_absolute() {
            simplified.to_path_buf()
        } else {
            let Some(parent) = cur.parent() else {
                return Ok(None);
            };
            parent.join(simplified)
        };
        let Some(parent) = joined.parent() else {
            return Ok(None);
        };
        let Some(name) = joined.file_name() else {
            return Ok(None);
        };
        let Some(parent_str) = parent.to_str() else {
            return Ok(None);
        };
        let (real_parent, anchor) = match super::ownership::resolve_media_path_checked(scope, parent_str) {
            Ok(Some(pair)) => pair,
            Ok(None) | Err(()) => return Ok(None),
        };
        if real_parent != anchor {
            return Err(std::io::ErrorKind::NotFound);
        }
        let candidate = real_parent.join(name);
        match std::fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.file_type().is_symlink() => cur = candidate,
            Ok(meta) if meta.is_file() => {
                // `real_parent` is already canonical within `scope` and `name` is a verified
                // regular file component; return `candidate` directly without a racy follow-up
                // `canonicalize` that could chase a newly swapped link.
                return Ok(candidate.starts_with(scope).then_some((candidate, meta)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(std::io::ErrorKind::NotFound),
            _ => return Ok(None),
        }
    }
    Ok(None)
}

fn config_stamp_in(scope: &Path, path: &Path) -> Option<Option<ConfigStamp>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Some(Some(ConfigStamp {
            entry: meta_stamp(&meta)?,
            identity: Some(file_identity_stamp(path)?),
            target: None,
        })),
        Ok(meta) if meta.file_type().is_symlink() => {
            let entry = meta_stamp(&meta)?;
            // Represent a dangling config symlink (e.g. unused `config.worktree`) with `target: None`
            // rather than failing the inventory scan (TS `git-worktrees.ts:72-85`).
            if scope.as_os_str().is_empty() {
                match dunce::canonicalize(path) {
                    Ok(real) => match std::fs::symlink_metadata(&real) {
                        Ok(target_meta) if target_meta.is_file() => {
                            let id = file_identity_stamp(&real)?;
                            Some(Some(ConfigStamp {
                                entry,
                                identity: None,
                                target: Some((real, meta_stamp(&target_meta)?, id)),
                            }))
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            Some(Some(ConfigStamp { entry, identity: None, target: None }))
                        }
                        _ => None,
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        Some(Some(ConfigStamp { entry, identity: None, target: None }))
                    }
                    Err(_) => None,
                }
            } else {
                match resolve_symlink_file_in(scope, path) {
                    Ok(Some((real, target_meta))) => {
                        let id = file_identity_stamp(&real)?;
                        Some(Some(ConfigStamp {
                            entry,
                            identity: None,
                            target: Some((real, meta_stamp(&target_meta)?, id)),
                        }))
                    }
                    Ok(None) => None,
                    Err(std::io::ErrorKind::NotFound) => {
                        Some(Some(ConfigStamp { entry, identity: None, target: None }))
                    }
                    Err(_) => None,
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
        _ => None,
    }
}
fn identity(path: &Path) -> Result<String, Error> {
    files::directory_identity(path).map_err(|_| native_error())
}
fn small(path: &Path) -> Result<Vec<u8>, Error> {
    use std::io::Read;
    std::fs::symlink_metadata(path).ok().filter(|m| m.is_file() && m.len() <= 4096).ok_or_else(native_error)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path).map_err(|_| native_error())?;
    let meta = file.metadata().map_err(|_| native_error())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(native_error());
        }
    }
    if !meta.is_file() || meta.len() > 4096 {
        return Err(native_error());
    }
    let mut value = Vec::new();
    file.take(4097).read_to_end(&mut value).map_err(|_| native_error())?;
    if value.len() > 4096 { Err(native_error()) } else { Ok(value) }
}
fn ancestor_markers(opened: &Path, root: &Path) -> Option<Vec<(PathBuf, [Option<MetaStamp>; 3])>> {
    let mut out = Vec::new();
    let mut cur = opened.to_path_buf();
    while cur != root {
        let stamps = [".git", "HEAD", "commondir"]
            .map(|name| std::fs::symlink_metadata(cur.join(name)).ok().and_then(|meta| meta_stamp(&meta)));
        out.push((cur.clone(), stamps));
        if !cur.pop() {
            return None;
        }
    }
    Some(out)
}

fn is_local_git_target(text: &str) -> bool {
    if text.is_empty() || text.len() > 32_768 || text.contains('\0') {
        return false;
    }
    #[cfg(windows)]
    {
        let b = text.as_bytes();
        let sep = |c: u8| c == b'\\' || c == b'/';
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && sep(b[2]) && !text[2..].contains(':')
    }
    #[cfg(not(windows))]
    {
        text.starts_with('/')
    }
}

fn config_stamp_matches_in(scope: &Path, path: &Path, expected: &Option<ConfigStamp>) -> bool {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => expected.is_none(),
        Ok(meta) => {
            let Some(exp) = expected.as_ref() else {
                return false;
            };
            meta_stamp(&meta).as_ref() == Some(&exp.entry) && config_stamp_in(scope, path).as_ref() == Some(expected)
        }
        Err(_) => false,
    }
}

fn canonical_dir_in(scope: &Path, path: &Path, expected: &Path) -> bool {
    if !scope.as_os_str().is_empty() {
        expected.starts_with(scope)
            && path.to_str().is_some_and(|s| {
                super::ownership::resolve_media_path_checked(scope, s)
                    .ok()
                    .flatten()
                    .is_some_and(|(p, a)| p == a && p == expected)
            })
    } else {
        dunce::canonicalize(path).ok().as_deref() == Some(expected)
    }
}

fn canonical_file_in(scope: &Path, path: &Path, expected: &Path) -> bool {
    if !scope.as_os_str().is_empty() {
        if !expected.starts_with(scope) {
            return false;
        }
        let Some(parent) = path.parent() else {
            return false;
        };
        let Some(exp_parent) = expected.parent() else {
            return false;
        };
        let Some(name) = path.file_name() else {
            return false;
        };
        let Some(exp_name) = expected.file_name() else {
            return false;
        };
        canonical_dir_in(scope, parent, exp_parent) && {
            let joined = exp_parent.join(name);
            std::fs::symlink_metadata(&joined).is_ok_and(|m| m.is_file())
                && (name == exp_name
                    || (cfg!(windows)
                        && name.eq_ignore_ascii_case(exp_name)
                        && file_identity_stamp(&joined)
                            .is_some_and(|id| file_identity_stamp(expected).as_deref() == Some(id.as_str()))))
        }
    } else {
        dunce::canonicalize(path).ok().as_deref() == Some(expected)
    }
}

impl Physical {
    #[cfg(test)]
    fn live(&self) -> bool {
        self.live_in(Path::new(""))
    }
    fn live_in(&self, scope: &Path) -> bool {
        let canonical = |path: &Path| canonical_dir_in(scope, path, path);
        canonical(&self.root)
            && canonical(&self.admin)
            && canonical(&self.common)
            && identity(&self.root).ok().as_ref() == Some(&self.root_id)
            && identity(&self.admin).ok().as_ref() == Some(&self.admin_id)
            && identity(&self.common).ok().as_ref() == Some(&self.common_id)
            && super::ownership::valid_git_admin_in(scope, &self.admin, &self.common)
            && config_stamp_matches_in(scope, &self.common.join("config"), &self.stamp[0])
            && config_stamp_matches_in(scope, &self.admin.join("config.worktree"), &self.stamp[1])
            && match (&self.marker, &self.backlink, &self.common_marker) {
                (Some(marker), Some(backlink), Some(common_marker)) => {
                    small(&self.root.join(".git")).ok().as_ref() == Some(marker)
                        && small(&self.admin.join("gitdir")).ok().as_ref() == Some(backlink)
                        && small(&self.admin.join("commondir")).ok().as_ref() == Some(common_marker)
                        && linked_markers_in(scope, &self.root, &self.admin, &self.common)
                            .is_ok_and(|[m, b, c]| &m == marker && &b == backlink && &c == common_marker)
                }
                (Some(marker), None, None) => {
                    separate_marker_live_in(scope, &self.root, &self.common, marker)
                        && std::fs::symlink_metadata(self.admin.join("commondir"))
                            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }
                (None, None, None) => std::fs::symlink_metadata(self.admin.join("commondir"))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
                _ => false,
            }
    }
    /// Also verifies that `opened` still canonicalizes to itself and intermediate discovery markers
    /// (`.git`, `HEAD`, `commondir`) between `opened` and `self.root` are unchanged since probing.
    fn live_for_in(&self, scope: &Path, opened: &Path) -> bool {
        self.live_in(scope)
            && canonical_dir_in(scope, opened, opened)
            && ancestor_markers(opened, &self.root).as_ref() == Some(&self.ancestors)
    }
}
/// The checkout's `.git`, its `gitdir:` admin directory, or an administrative backlink
/// (`gitdir` / `commondir`) is missing (`ENOENT`, TS `readCheckoutIdentity` / `native-worktrees.ts:135-150`).
#[cfg(test)]
fn git_layout_gone(root: &Path) -> bool {
    git_layout_gone_in(Path::new(""), root)
}

fn git_layout_gone_in(scope: &Path, root: &Path) -> bool {
    if !scope.as_os_str().is_empty() {
        let Some(root_str) = root.to_str() else {
            return false;
        };
        match super::ownership::resolve_media_path_checked(scope, root_str) {
            Ok(Some((resolved, anchor))) if resolved == anchor && resolved == root => {}
            Ok(Some(_)) => return true,
            Ok(None) | Err(()) => return false,
        }
    }
    let marker = root.join(".git");
    match std::fs::symlink_metadata(&marker) {
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        Ok(meta) if meta.is_file() => {
            small(&marker).ok().and_then(|bytes| String::from_utf8(bytes).ok()).is_some_and(|text| {
                text.lines().find_map(|line| line.strip_prefix("gitdir:")).is_some_and(|dir| {
                    let dir = Path::new(dir.trim());
                    let dir = if dir.is_absolute() { dir.to_path_buf() } else { root.join(dir) };
                    let checked_dir = if !scope.as_os_str().is_empty() {
                        let Some(dir_str) = dir.to_str() else {
                            return false;
                        };
                        match super::ownership::resolve_media_path_checked(scope, dir_str) {
                            Ok(Some((resolved, anchor))) if resolved == anchor => resolved,
                            Ok(Some(_)) => return true,
                            Ok(None) | Err(()) => return false,
                        }
                    } else {
                        if std::fs::symlink_metadata(&dir).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
                            return true;
                        }
                        dir
                    };
                    // A linked worktree whose `admin/gitdir` backlink or `admin/commondir` disappeared
                    // mid-removal is gone (TS `readCheckoutIdentity` throws ENOENT).
                    let is_linked = checked_dir.parent().and_then(|p| p.file_name()).is_some_and(|n| n == "worktrees");
                    is_linked
                        && (std::fs::symlink_metadata(checked_dir.join("gitdir"))
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                            || std::fs::symlink_metadata(checked_dir.join("commondir"))
                                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound))
                })
            })
        }
        Ok(_) => false,
    }
}
/// A readable Git checkout or a verified non-Git local directory: TS `sharesGitCommonDirectory`
/// (`strict: true`) proves departure (`false` -> `session_located_elsewhere`) for both another
/// Git checkout and a readable non-Git folder, while throwing on unreadable/I/O errors.
pub async fn readable_checkout(path: &Path) -> bool {
    if checkout(path).await.is_ok() {
        return true;
    }
    crate::git::run(path, &["rev-parse", "--git-common-dir"], 16 * 1024)
        .await
        .ok()
        .is_some_and(|out| out.not_a_repository())
}

#[cfg(test)]
fn linked_markers(root: &Path, admin: &Path, common: &Path) -> Result<[Vec<u8>; 3], Error> {
    linked_markers_in(Path::new(""), root, admin, common)
}

fn strip_git_eol(text: &str) -> &str {
    text.trim_end_matches(['\r', '\n'])
}

fn is_reparse_entry(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || (meta.file_attributes() & 0x0400) != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn linked_markers_in(scope: &Path, root: &Path, admin: &Path, common: &Path) -> Result<[Vec<u8>; 3], Error> {
    if admin.parent() != Some(common.join("worktrees").as_path()) {
        return Err(conflict("Foreign worktree administration"));
    }
    let marker = small(&root.join(".git"))?;
    let gitdir = std::str::from_utf8(&marker)
        .ok()
        .and_then(|text| strip_git_eol(text).strip_prefix("gitdir: "))
        .filter(|path| !path.is_empty())
        .ok_or_else(native_error)?;
    if !canonical_dir_in(scope, &root.join(gitdir), admin) {
        return Err(conflict("Git worktree marker changed"));
    }
    let backlink = small(&admin.join("gitdir"))?;
    let text = strip_git_eol(std::str::from_utf8(&backlink).map_err(|_| native_error())?);
    if !canonical_file_in(scope, &admin.join(text), &root.join(".git")) {
        return Err(conflict("Foreign Git backlink"));
    }
    let common_marker = small(&admin.join("commondir"))?;
    let text = strip_git_eol(std::str::from_utf8(&common_marker).map_err(|_| native_error())?);
    if !canonical_dir_in(scope, &admin.join(text), common) {
        return Err(conflict("Foreign Git common directory"));
    }
    Ok([marker, backlink, common_marker])
}

fn separate_marker_live_in(scope: &Path, root: &Path, common: &Path, expected: &[u8]) -> bool {
    let dot_git = root.join(".git");
    if expected.is_empty() {
        return std::fs::symlink_metadata(&dot_git).is_ok_and(|meta| meta.file_type().is_symlink())
            && canonical_dir_in(scope, &dot_git, common);
    }
    let Ok(marker) = small(&dot_git) else {
        return false;
    };
    if marker != expected {
        return false;
    }
    std::str::from_utf8(&marker)
        .ok()
        .and_then(|text| strip_git_eol(text).strip_prefix("gitdir: "))
        .filter(|path| !path.is_empty())
        .is_some_and(|gitdir| canonical_dir_in(scope, &root.join(gitdir), common))
}

fn separate_marker_in(scope: &Path, root: &Path, common: &Path) -> Result<Vec<u8>, Error> {
    let dot_git = root.join(".git");
    if std::fs::symlink_metadata(&dot_git).is_ok_and(|meta| meta.file_type().is_symlink())
        && canonical_dir_in(scope, &dot_git, common)
    {
        return Ok(Vec::new());
    }
    let marker = small(&dot_git)?;
    let gitdir = std::str::from_utf8(&marker)
        .ok()
        .and_then(|text| strip_git_eol(text).strip_prefix("gitdir: "))
        .filter(|path| !path.is_empty())
        .ok_or_else(native_error)?;
    if !canonical_dir_in(scope, &root.join(gitdir), common) {
        return Err(conflict("External Git directory is unavailable"));
    }
    Ok(marker)
}

fn local_include_scope(scope: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut comps = scope.components();
        let prefix = comps.next()?;
        let root = comps.next()?;
        if !matches!(prefix, std::path::Component::Prefix(_)) || !matches!(root, std::path::Component::RootDir) {
            return None;
        }
        let mut out = PathBuf::new();
        out.push(prefix.as_os_str());
        out.push(root.as_os_str());
        Some(out)
    }
    #[cfg(not(windows))]
    {
        let _ = scope;
        Some(PathBuf::from("/"))
    }
}

fn read_config_file_nofollow(path: &Path) -> Result<Vec<u8>, ()> {
    use std::io::Read;
    const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(());
        }
    }
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return Err(());
    }
    let mut out = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut out).map_err(|_| ())?;
    if out.len() as u64 > MAX_CONFIG_BYTES { Err(()) } else { Ok(out) }
}

fn parse_git_config_include_paths(bytes: &[u8]) -> Result<Vec<String>, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut chars = text.chars().peekable();
    let mut in_include = false;
    let mut paths = Vec::new();
    while let Some(&ch) = chars.peek() {
        if matches!(ch, ' ' | '\t' | '\r' | '\n') {
            chars.next();
            continue;
        }
        if matches!(ch, '#' | ';') {
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            continue;
        }
        if ch == '[' {
            chars.next();
            let mut section = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphanumeric() || c == '-' {
                    section.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            in_include = section.eq_ignore_ascii_case("include") || section.eq_ignore_ascii_case("includeif");
            let mut quoted = false;
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == '\n' {
                    break;
                }
                if quoted {
                    if c == '\\' {
                        let _ = chars.next();
                    } else if c == '"' {
                        quoted = false;
                    }
                } else if c == '"' {
                    quoted = true;
                } else if c == ']' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(());
            }
            continue;
        }
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if matches!(c, ' ' | '\t' | '=' | '#' | ';' | '\r' | '\n') {
                break;
            }
            key.push(c);
            chars.next();
        }
        while let Some(&c) = chars.peek() {
            if matches!(c, ' ' | '\t') {
                chars.next();
            } else {
                break;
            }
        }
        let is_include_path = in_include && key.eq_ignore_ascii_case("path");
        if chars.peek() == Some(&'=') {
            chars.next();
            while let Some(&c) = chars.peek() {
                if matches!(c, ' ' | '\t') {
                    chars.next();
                } else {
                    break;
                }
            }
            let mut value = String::new();
            let mut pending_ws = String::new();
            let mut quoted = false;
            while let Some(c) = chars.next() {
                if !quoted && matches!(c, '#' | ';') {
                    for rest in chars.by_ref() {
                        if rest == '\n' {
                            break;
                        }
                    }
                    break;
                }
                if c == '\n' {
                    if quoted && is_include_path {
                        return Err(());
                    }
                    break;
                }
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                    if quoted && is_include_path {
                        return Err(());
                    }
                    break;
                }
                if c == '"' {
                    if !pending_ws.is_empty() {
                        value.push_str(&pending_ws);
                        pending_ws.clear();
                    }
                    quoted = !quoted;
                    continue;
                }
                if c == '\\' {
                    match chars.next() {
                        Some('\n') => continue,
                        Some('\r') if chars.peek() == Some(&'\n') => {
                            chars.next();
                            continue;
                        }
                        Some(esc) => {
                            if !pending_ws.is_empty() {
                                value.push_str(&pending_ws);
                                pending_ws.clear();
                            }
                            let decoded = match esc {
                                '\\' => '\\',
                                '"' => '"',
                                'n' => '\n',
                                't' => '\t',
                                'b' => '\x08',
                                _ if is_include_path => return Err(()),
                                other => other,
                            };
                            value.push(decoded);
                        }
                        None if is_include_path => return Err(()),
                        None => break,
                    }
                    continue;
                }
                if !quoted && matches!(c, ' ' | '\t' | '\r') {
                    if !value.is_empty() {
                        pending_ws.push(c);
                    }
                } else {
                    if !pending_ws.is_empty() {
                        value.push_str(&pending_ws);
                        pending_ws.clear();
                    }
                    value.push(c);
                }
            }
            if quoted && is_include_path {
                return Err(());
            }
            if is_include_path {
                paths.push(value);
            }
        } else {
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            if is_include_path {
                return Err(());
            }
        }
    }
    Ok(paths)
}

/// Resolves a Git config include entry, returning `(opened_path, real_path)` when the target file
/// exists on the local volume. `opened_path` preserves the symlink's own directory so transitive
/// relative includes are checked from the same directory Git resolves them against.
fn resolve_config_include_in(
    include_scope: &Path,
    base_dir: &Path,
    raw: &str,
) -> Result<Option<(PathBuf, PathBuf)>, ()> {
    if raw.is_empty() || raw.len() > 32_768 || raw.contains('\0') {
        return Err(());
    }
    let expanded = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or(())?;
        PathBuf::from(home).join(rest)
    } else if raw.starts_with('~') || raw.starts_with("%(") {
        return Err(());
    } else {
        PathBuf::from(raw)
    };
    let simplified = dunce::simplified(&expanded);
    super::ownership::reject_network_path(&simplified.to_string_lossy(), simplified)?;
    let joined = if simplified.is_absolute() { simplified.to_path_buf() } else { base_dir.join(simplified) };
    let parent = joined.parent().ok_or(())?;
    let name = joined.file_name().ok_or(())?;
    let parent_str = parent.to_str().ok_or(())?;
    let (real_parent, anchor) = super::ownership::resolve_media_path_checked(include_scope, parent_str)?.ok_or(())?;
    if real_parent != anchor {
        return Ok(None);
    }
    let candidate = real_parent.join(name);
    match std::fs::symlink_metadata(&candidate) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(meta) if meta.file_type().is_symlink() => match resolve_symlink_file_in(include_scope, &candidate) {
            Ok(Some((real, _))) => Ok(Some((candidate, real))),
            Err(std::io::ErrorKind::NotFound) => Ok(None),
            Ok(None) | Err(_) => Err(()),
        },
        Ok(meta) if meta.is_file() => {
            candidate.starts_with(include_scope).then(|| Some((candidate.clone(), candidate))).ok_or(())
        }
        _ => Err(()),
    }
}

fn validate_local_config_includes_in(scope: &Path, common: &Path, admin: &Path) -> bool {
    if scope.as_os_str().is_empty() {
        return true;
    }
    let Some(include_scope) = local_include_scope(scope) else {
        return false;
    };
    let mut queue = std::collections::VecDeque::new();
    let mut seen = HashSet::new();
    for candidate in [common.join("config"), admin.join("config.worktree")] {
        let resolved = match std::fs::symlink_metadata(&candidate) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Ok(meta) if meta.file_type().is_symlink() => match resolve_symlink_file_in(scope, &candidate) {
                Ok(Some((real, _))) => Some((candidate, real)),
                Err(std::io::ErrorKind::NotFound) => None,
                Ok(None) | Err(_) => return false,
            },
            Ok(meta) if meta.is_file() && candidate.starts_with(scope) => Some((candidate.clone(), candidate)),
            _ => return false,
        };
        if let Some(pair) = resolved
            && seen.insert(pair.clone())
        {
            queue.push_back(pair);
        }
    }
    while let Some((opened, real)) = queue.pop_front() {
        let Ok(bytes) = read_config_file_nofollow(&real) else {
            return false;
        };
        let Ok(include_values) = parse_git_config_include_paths(&bytes) else {
            return false;
        };
        if include_values.is_empty() {
            continue;
        }
        let Some(base_dir) = opened.parent() else {
            return false;
        };
        for value in include_values {
            let Ok(target) = resolve_config_include_in(&include_scope, base_dir, &value) else {
                return false;
            };
            if let Some(pair) = target
                && seen.insert(pair.clone())
            {
                if seen.len() > 32 {
                    return false;
                }
                queue.push_back(pair);
            }
        }
    }
    true
}

#[derive(PartialEq)]
enum PreConfig {
    Found(Box<(PathBuf, PathBuf, [Option<ConfigStamp>; 2])>),
    None,
    Refused,
}

fn resolve_git_path_in(scope: &Path, path: &Path) -> Result<Option<PathBuf>, ()> {
    if !scope.as_os_str().is_empty() {
        let raw = path.to_str().ok_or(())?;
        match super::ownership::resolve_media_path_checked(scope, raw)? {
            Some((p, a)) if p == a => Ok(Some(p)),
            Some(_) => Ok(None),
            None => Err(()),
        }
    } else {
        match dunce::canonicalize(path) {
            Ok(p) => Ok(Some(p)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }
}

pub(crate) fn precheck_git_layout_in_scope(scope: &Path, dir: &Path) -> bool {
    pre_config_stamps_in(scope, dir) != PreConfig::Refused
}

fn check_admin_entry_in_scope(scope: &Path, path: &Path) -> bool {
    let meta = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
        Ok(meta) => meta,
    };
    if !is_reparse_entry(&meta) {
        return true;
    }
    if scope.as_os_str().is_empty() {
        let Ok(target) = std::fs::read_link(path) else {
            return false;
        };
        let simplified = dunce::simplified(&target);
        return super::ownership::reject_network_path(&simplified.to_string_lossy(), simplified).is_ok();
    }
    if resolve_git_path_in(scope, path).is_ok() {
        return true;
    }
    matches!(resolve_symlink_file_in(scope, path), Ok(Some(_)) | Err(std::io::ErrorKind::NotFound))
}

fn validate_admin_dir_in(scope: &Path, admin: &Path) -> Result<(PathBuf, [Option<ConfigStamp>; 2]), PreConfig> {
    let common = match std::fs::symlink_metadata(admin.join("commondir")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => admin.to_path_buf(),
        Ok(m) if m.is_file() => {
            let Ok(cb) = small(&admin.join("commondir")) else {
                return Err(PreConfig::Refused);
            };
            let Some(ct) = std::str::from_utf8(&cb).ok().map(strip_git_eol).filter(|s| !s.is_empty()) else {
                return Err(PreConfig::None);
            };
            let common_path = if Path::new(ct).is_absolute() {
                if !is_local_git_target(ct) {
                    return Err(PreConfig::Refused);
                }
                PathBuf::from(ct)
            } else {
                admin.join(ct)
            };
            match resolve_git_path_in(scope, &common_path) {
                Ok(Some(p)) => p,
                Ok(None) => return Err(PreConfig::None),
                Err(()) => return Err(PreConfig::Refused),
            }
        }
        _ => return Err(PreConfig::Refused),
    };
    if !check_admin_entry_in_scope(scope, &admin.join("HEAD"))
        || !check_admin_entry_in_scope(scope, &common.join("objects"))
        || !check_admin_entry_in_scope(scope, &common.join("refs"))
        || !check_admin_entry_in_scope(scope, &common.join("reftable"))
    {
        return Err(PreConfig::Refused);
    }
    let Some(s0) = config_stamp_in(scope, &common.join("config")) else {
        return Err(PreConfig::Refused);
    };
    let Some(s1) = config_stamp_in(scope, &admin.join("config.worktree")) else {
        return Err(PreConfig::Refused);
    };
    if !validate_local_config_includes_in(scope, &common, admin) {
        return Err(PreConfig::Refused);
    }
    Ok((common, [s0, s1]))
}

fn validate_gitfile_in(scope: &Path, cur: &Path, marker: &Path) -> PreConfig {
    let Ok(bytes) = small(marker) else {
        return PreConfig::Refused;
    };
    let Some(gitdir) = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|t| strip_git_eol(t).strip_prefix("gitdir: "))
        .filter(|s| !s.is_empty())
    else {
        return PreConfig::None;
    };
    let admin_path = if Path::new(gitdir).is_absolute() {
        if !is_local_git_target(gitdir) {
            return PreConfig::Refused;
        }
        PathBuf::from(gitdir)
    } else {
        cur.join(gitdir)
    };
    let admin = match resolve_git_path_in(scope, &admin_path) {
        Ok(Some(p)) => p,
        Ok(None) => return PreConfig::None,
        Err(()) => return PreConfig::Refused,
    };
    match validate_admin_dir_in(scope, &admin) {
        Ok((common, stamps)) => PreConfig::Found(Box::new((common, admin, stamps))),
        Err(other) => other,
    }
}

fn pre_config_stamps_in(scope: &Path, path: &Path) -> PreConfig {
    let mut cur = match resolve_git_path_in(scope, path) {
        Ok(Some(p)) => p,
        Ok(None) => return PreConfig::None,
        Err(()) => return PreConfig::Refused,
    };
    let mut first_found: Option<(PathBuf, PathBuf, [Option<ConfigStamp>; 2])> = None;
    loop {
        let marker = cur.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return PreConfig::Refused,
            Ok(meta) if is_reparse_entry(&meta) => match resolve_git_path_in(scope, &marker) {
                Ok(Some(resolved)) => match std::fs::metadata(&resolved) {
                    Ok(m) if m.is_dir() => match validate_admin_dir_in(scope, &resolved) {
                        Ok((common, stamps)) => {
                            if super::ownership::valid_git_admin_in(scope, &resolved, &common) {
                                return PreConfig::Found(Box::new((common, resolved, stamps)));
                            }
                            first_found.get_or_insert((common, resolved, stamps));
                        }
                        Err(PreConfig::Refused) => return PreConfig::Refused,
                        Err(PreConfig::None | PreConfig::Found(_)) => {}
                    },
                    Ok(m) if m.is_file() => return validate_gitfile_in(scope, &cur, &resolved),
                    _ => return PreConfig::Refused,
                },
                Ok(None) => {}
                Err(()) if !scope.as_os_str().is_empty() => match resolve_symlink_file_in(scope, &marker) {
                    Ok(Some((resolved_file, _))) => return validate_gitfile_in(scope, &cur, &resolved_file),
                    Err(std::io::ErrorKind::NotFound) => {}
                    Ok(None) | Err(_) => return PreConfig::Refused,
                },
                Err(()) => return PreConfig::Refused,
            },
            Ok(meta) if meta.is_dir() => match validate_admin_dir_in(scope, &marker) {
                Ok((common, stamps)) => {
                    if super::ownership::valid_git_admin_in(scope, &marker, &common) {
                        return PreConfig::Found(Box::new((common, marker, stamps)));
                    }
                    first_found.get_or_insert((common, marker, stamps));
                }
                Err(PreConfig::Refused) => return PreConfig::Refused,
                Err(PreConfig::None | PreConfig::Found(_)) => {}
            },
            Ok(meta) if meta.is_file() => return validate_gitfile_in(scope, &cur, &marker),
            Ok(_) => return PreConfig::Refused,
        }
        // Git also recognizes bare repositories and direct admin directories (`HEAD` + `objects`
        // or `commondir`) without a `.git` entry during upward discovery.
        match std::fs::symlink_metadata(cur.join("HEAD")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return PreConfig::Refused,
            Ok(hm) if hm.is_dir() && !is_reparse_entry(&hm) => {}
            Ok(_) => {
                let has_objects = match std::fs::symlink_metadata(cur.join("objects")) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                    Ok(_) => true,
                    Err(_) => return PreConfig::Refused,
                };
                let has_commondir = match std::fs::symlink_metadata(cur.join("commondir")) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                    Ok(_) => true,
                    Err(_) => return PreConfig::Refused,
                };
                if has_objects || has_commondir {
                    match validate_admin_dir_in(scope, &cur) {
                        Ok((common, stamps)) => {
                            if super::ownership::valid_git_admin_in(scope, &cur, &common) {
                                return PreConfig::Found(Box::new((common, cur, stamps)));
                            }
                            first_found.get_or_insert((common, cur.clone(), stamps));
                        }
                        Err(PreConfig::Refused) => return PreConfig::Refused,
                        Err(PreConfig::None | PreConfig::Found(_)) => {}
                    }
                }
            }
        }
        if !scope.as_os_str().is_empty() && cur == scope {
            break;
        }
        if !cur.pop() {
            break;
        }
    }
    first_found.map_or(PreConfig::None, |f| PreConfig::Found(Box::new(f)))
}

pub(crate) enum RootCheckout {
    Git(Result<Box<Physical>, Error>),
    /// Confirmed non-Git directory (`git rev-parse` exited 128 with `"not a git repository"`).
    NonGit,
    /// Non-ENOENT `rev-parse` failure: display falls back to `isGitRepo: false`, while authority checks fail closed.
    FallbackNonGit,
    MissingGit,
}

async fn parse_checkout_in(
    scope: PathBuf,
    opened: PathBuf,
    text: String,
    pre: Option<(PathBuf, PathBuf, [Option<ConfigStamp>; 2])>,
) -> Result<Physical, Error> {
    tokio::task::spawn_blocking(move || {
        let mut lines = text.lines();
        let resolve = |raw: &str| {
            if !scope.as_os_str().is_empty() { resolve_dir_in(&scope, Path::new(raw)) } else { physical(raw) }
        };
        let root = lines.next().and_then(resolve).ok_or_else(native_error)?;
        let admin = lines.next().and_then(resolve).ok_or_else(native_error)?;
        let common = lines.next().and_then(resolve).ok_or_else(native_error)?;
        if lines.next().is_some() {
            return Err(native_error());
        }
        let (marker, backlink, common_marker) = if admin == common {
            if common != root.join(".git") {
                (Some(separate_marker_in(&scope, &root, &common)?), None, None)
            } else {
                (None, None, None)
            }
        } else {
            let [marker, backlink, common_marker] = linked_markers_in(&scope, &root, &admin, &common)?;
            (Some(marker), Some(backlink), Some(common_marker))
        };
        let stamp = [
            config_stamp_in(&scope, &common.join("config")).ok_or_else(native_error)?,
            config_stamp_in(&scope, &admin.join("config.worktree")).ok_or_else(native_error)?,
        ];
        if let Some((pre_common, pre_admin, pre_stamp)) = pre
            && pre_common == common
            && pre_admin == admin
            && pre_stamp != stamp
        {
            return Err(config_changed_error());
        }
        if std::fs::symlink_metadata(admin.join("HEAD")).is_err() {
            return Err(native_error());
        }
        let opened = resolve_dir_in(&scope, &opened).ok_or_else(native_error)?;
        let ancestors = ancestor_markers(&opened, &root).ok_or_else(native_error)?;
        Ok(Physical {
            stamp,
            root_id: identity(&root)?,
            admin_id: identity(&admin)?,
            common_id: identity(&common)?,
            root,
            admin,
            common,
            marker,
            backlink,
            common_marker,
            ancestors,
        })
    })
    .await
    .map_err(|_| native_error())?
}

/// Single `git::run` root probe (`SLOTS` + 15 s) that simultaneously classifies
/// non-Git / missing-Git workspaces and captures the root `Physical` checkout so
/// `catalogue` / `repo_target` / `worktrees::list` never spawn `rev-parse` twice.
pub(crate) async fn probe_root_checkout(scope: &Path, workspace: &Workspace) -> Result<RootCheckout, Error> {
    let path = workspace.path.clone();
    let scope_owned = scope.to_path_buf();
    let (canonical_ok, pre) = tokio::task::spawn_blocking(move || {
        let ok = canonical_dir_in(&scope_owned, &path, &path);
        let pre = if ok { pre_config_stamps_in(&scope_owned, &path) } else { PreConfig::Refused };
        (ok, pre)
    })
    .await
    .unwrap_or((false, PreConfig::Refused));
    if !canonical_ok {
        crate::bench::route_trace(format_args!("root-proof canonical path changed"));
        return Err(super::probe_error());
    }
    let pre = match pre {
        PreConfig::Found(stamp) => Some(*stamp),
        PreConfig::None => None,
        PreConfig::Refused => return Ok(RootCheckout::Git(Err(native_error()))),
    };
    let args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"];
    match crate::git::run_in_scope(&workspace.path, scope, &args, 128 * 1024).await {
        Ok(out) if out.code == 0 => Ok(RootCheckout::Git(
            parse_checkout_in(scope.to_path_buf(), workspace.path.clone(), out.text(), pre).await.map(Box::new),
        )),
        Ok(out) if out.not_a_repository() => Ok(RootCheckout::NonGit),
        Err(err) if crate::git::is_missing_git(&err) => Ok(RootCheckout::MissingGit),
        Ok(out) => {
            crate::bench::route_trace(format_args!("root-proof git exited {}", out.code));
            Ok(RootCheckout::FallbackNonGit)
        }
        Err(_) => {
            crate::bench::route_trace(format_args!("root-proof git failed"));
            Ok(RootCheckout::FallbackNonGit)
        }
    }
}

async fn checkout(path: &Path) -> Result<Physical, Error> {
    checkout_in(Path::new(""), path).await
}

async fn checkout_in(scope: &Path, path: &Path) -> Result<Physical, Error> {
    // Capture config stamps BEFORE `git rev-parse` (TS `git-worktrees.ts:92-135`) so a mid-probe
    // config edit cannot pair an old `rev-parse` root with a newly written config stamp.
    let pre = tokio::task::spawn_blocking({
        let path = path.to_path_buf();
        let scope = scope.to_path_buf();
        move || pre_config_stamps_in(&scope, &path)
    })
    .await
    .unwrap_or(PreConfig::Refused);
    let pre = match pre {
        PreConfig::Found(stamp) => Some(*stamp),
        PreConfig::None => None,
        PreConfig::Refused => return Err(native_error()),
    };
    let text = if scope.as_os_str().is_empty() {
        git(path, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).await?
    } else {
        crate::git::run_in_scope(
            path,
            scope,
            &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
            128 * 1024,
        )
        .await
        .map_err(|_| native_error())?
        .ok()
        .map_err(|_| native_error())?
        .text()
    };
    parse_checkout_in(scope.to_path_buf(), path.to_path_buf(), text, pre).await
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    pub path: PathBuf,
    pub service: String,
    pub slug: String,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) locked: bool,
    pub(super) service_root: String,
    pub nested_missing: bool,
    pub(super) removable: bool,
    layout: Physical,
    identity: Option<String>,
    /// When a sibling worktree's projected subfolder is a symlink into a verified worktree of
    /// the same repository, stores `(link_path, resolved_target, target_layout, target_id)`
    /// so `Tree.path` remains inside the sibling worktree (never directing Git staging into
    /// another worktree) while media/history ownership checks validate the resolved target
    /// and the target checkout's own Git layout.
    projected_link: Option<Box<(PathBuf, PathBuf, Physical, String)>>,
    scope: PathBuf,
}
impl Tree {
    #[cfg(test)]
    pub(super) fn test_stub(root: PathBuf, common: PathBuf, slug: &str, branch: Option<&str>) -> Self {
        let service = root.to_string_lossy().into_owned();
        Self {
            path: root.clone(),
            service: service.clone(),
            slug: slug.into(),
            branch: branch.map(str::to_string),
            head: None,
            locked: false,
            service_root: service,
            nested_missing: false,
            removable: true,
            layout: Physical {
                admin: root.join(".git"),
                root,
                common,
                root_id: String::new(),
                common_id: String::new(),
                admin_id: String::new(),
                marker: None,
                backlink: None,
                common_marker: None,
                stamp: [None, None],
                ancestors: Vec::new(),
            },
            identity: None,
            projected_link: None,
            scope: PathBuf::new(),
        }
    }
    pub fn registered(&self) -> &Path {
        &self.layout.root
    }
    pub(crate) fn same_physical_checkout(&self, other: &Self) -> bool {
        self.layout.root == other.layout.root
            && self.layout.root_id == other.layout.root_id
            && self.layout.admin == other.layout.admin
            && self.layout.admin_id == other.layout.admin_id
            && self.layout.common == other.layout.common
            && self.layout.common_id == other.layout.common_id
    }
    pub(super) fn target_root(&self) -> &Path {
        self.projected_link.as_ref().map_or(&self.layout.root, |link| link.2.root.as_path())
    }
    pub(super) fn media_path_len(&self) -> usize {
        self.projected_link.as_ref().map_or(&self.path, |link| &link.1).as_os_str().len()
    }
    fn link_live(&self) -> bool {
        self.projected_link.as_ref().is_none_or(|link| canonical_dir_in(&self.scope, &link.0, &link.1))
    }
    pub(super) fn public(&self) -> Value {
        let label = self.branch.clone().unwrap_or_else(|| {
            format!(
                "{} @ {}",
                self.layout.root.file_name().unwrap_or_default().to_string_lossy(),
                self.head.as_deref().and_then(|h| h.get(..7)).unwrap_or("HEAD")
            )
        });
        let mut row = json!({"slug":self.slug,"label":label,"kind":if self.slug=="root"{"root"}else{"worktree"},
            "directory":self.path,"registeredDirectory":self.layout.root,"serviceDirectory":self.service,
            "serviceRoot":self.service_root,"removable":self.removable});
        if let Some(v) = &self.branch {
            row["branch"] = json!(v);
        }
        if let Some(v) = &self.head {
            row["head"] = json!(v);
        }
        if self.nested_missing {
            row["nestedFolderMissing"] = json!(true);
        }
        row
    }
    pub fn direct_folder(&self) -> bool {
        !self.nested_missing && self.identity.is_some() && self.projected_link.is_none()
    }
    /// Worktree creation source (`native-worktrees.ts:209-218`): accepts both direct project
    /// folders and sibling checkouts whose projected subfolder symlinks within the same repo.
    pub fn creatable_source(&self) -> bool {
        !self.nested_missing && (self.identity.is_some() || self.projected_link.is_some())
    }
    pub fn source_live(&self) -> bool {
        if let Some(link) = &self.projected_link {
            let (_, target, _, _) = link.as_ref();
            self.contains_media(target)
        } else {
            self.contains_live(&self.path)
        }
    }
    /// Relative folder path to verify in the starting commit (`git-worktrees.ts:149-154`):
    /// uses the symlinked source folder's prefix within its checkout when `projected_link` is set.
    pub fn source_relative(&self, workspace_path: &Path, root_registered: &Path) -> Option<PathBuf> {
        if let Some(link) = &self.projected_link {
            let (_, target, target_layout, _) = link.as_ref();
            target.strip_prefix(&target_layout.root).ok().map(Path::to_path_buf)
        } else {
            workspace_path.strip_prefix(root_registered).ok().map(Path::to_path_buf)
        }
    }
    pub(super) fn projected_target_root(&self) -> Option<&Path> {
        self.projected_link.as_ref().map(|link| link.2.root.as_path())
    }
    pub(super) fn owns_path(&self, dir: &Path) -> bool {
        self.path == dir
            && !self.nested_missing
            && self.projected_link.is_none()
            && self.identity.is_some()
            && self.layout.live_in(&self.scope)
            && self.link_live()
            && identity(dir).ok() == self.identity
    }
    /// `dir` (physical, possibly not yet existing) lies in this live checkout's project folder.
    /// Only `subagent-depth` (`ownership`) admits such subfolders, as the reference does.
    pub fn contains_live(&self, dir: &Path) -> bool {
        dir.starts_with(&self.path)
            && !self.nested_missing
            && self.projected_link.is_none()
            && self.identity.is_some()
            && self.layout.live_in(&self.scope)
            && self.link_live()
            && identity(&self.path).ok() == self.identity
    }
    /// History search provenance (`query`/`ranked`): admits a sibling worktree whose projected
    /// subfolder symlinks into another verified worktree of the same repository or does not exist
    /// yet under its verified checkout, while keeping `contains_live`/`owns_path`/`direct_folder`
    /// strict for Git staging and mutations.
    pub(super) fn contains_history(&self, dir: &Path) -> bool {
        self.contains_media(dir)
    }
    pub(super) fn contains_media(&self, dir: &Path) -> bool {
        if let Some(link) = &self.projected_link {
            let (link_path, target, target_layout, target_id) = link.as_ref();
            let link_live = || {
                link_path.to_str().is_some_and(|s| {
                    super::ownership::resolve_media_path_checked(&self.scope, s)
                        .ok()
                        .flatten()
                        .is_some_and(|(p, a)| p == a && p == *target)
                })
            };
            return dir.starts_with(target)
                && link_live()
                && self.layout.live_in(&self.scope)
                && target_layout.live_in(&self.scope)
                && link_live()
                && identity(target).ok().as_deref() == Some(target_id.as_str());
        }
        // Exact prefix match prevents cross-workspace matches on case-sensitive NTFS when
        // projected `Projet` is absent while a distinct sibling `projet` exists.
        if !dir.starts_with(&self.path) || !self.layout.live_in(&self.scope) {
            return false;
        }
        let Some((resolved, anchor)) = self
            .path
            .to_str()
            .and_then(|s| super::ownership::resolve_media_path_checked(&self.scope, s).ok().flatten())
        else {
            return false;
        };
        if resolved != self.path {
            return false;
        }
        if anchor != self.path {
            dir.starts_with(self.registered())
        } else {
            !self.nested_missing && self.identity.is_some() && identity(&self.path).ok() == self.identity
        }
    }
    pub(super) fn contains_receipt_location(&self, dir: &Path) -> bool {
        super::ownership::within(&self.path, dir)
            && self.layout.live_in(&self.scope)
            && self.path.to_str().and_then(super::ownership::resolve_directory).as_deref() == Some(&self.path)
            && super::ownership::existing_directory(&self.path).is_some()
    }
}
#[derive(Clone)]
pub struct Catalogue {
    pub project: String,
    pub trees: Vec<Tree>,
    pub parent: PathBuf,
    pub main: PathBuf,
}
impl Catalogue {
    pub fn get(&self, slug: &str) -> Result<&Tree, Error> {
        self.trees.iter().find(|t| t.slug == slug).ok_or_else(missing)
    }
    pub fn by_directory(&self, dir: &str) -> Option<&Tree> {
        let path = physical(dir)?;
        self.trees.iter().find(|t| t.owns_path(&path))
    }
    pub fn by_registered(&self, dir: &str) -> Option<&Tree> {
        let path = physical(dir)?;
        self.trees.iter().find(|t| t.registered() == path && t.layout.live_in(&t.scope))
    }
    pub fn response(&self) -> Value {
        json!({"isGitRepo":true,"defaultDirectory":self.parent,"worktrees":self.trees.iter().map(Tree::public).collect::<Vec<_>>()})
    }
    pub(super) fn same_snapshot(&self, other: &Self) -> bool {
        self.project == other.project
            && self.parent == other.parent
            && self.trees.len() == other.trees.len()
            && self.trees.iter().zip(&other.trees).all(|(a, b)| {
                a.slug == b.slug
                    && a.path == b.path
                    && a.layout.root == b.layout.root
                    && a.service == b.service
                    && a.service_root == b.service_root
                    && a.branch == b.branch
                    && a.head == b.head
                    && a.removable == b.removable
                    && a.nested_missing == b.nested_missing
            })
    }

    /// Re-verifies locally (no Git subprocess) that the workspace root checkout still matches
    /// the cached layout and ancestor markers.
    pub(crate) fn root_live_for(&self, opened: &Path) -> bool {
        self.get("root").is_ok_and(|root| root.layout.live_for_in(&root.scope, opened))
    }
}
pub fn scope(mut w: Workspace, tree: &Tree) -> Workspace {
    w.path = tree.path.clone();
    w.location = json!({"directory":tree.service});
    w
}

struct Root {
    project: String,
    local: Physical,
    main: Physical,
}
async fn catalogue_native(
    app: &App,
    w: &Workspace,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
    max: usize,
    timeout: std::time::Duration,
) -> Result<Value, Error> {
    let Some(endpoint) = endpoint else { return native(app, method, path, query, body, max).await };
    let current = || app.native.current(endpoint) && app.workspace(&w.id.to_string()).is_ok();
    if !current() {
        return Err(native_error());
    }
    let url = endpoint.url.join(path).map_err(|_| native_error())?;
    let request = app.native.client.request(method, url).basic_auth("opencode", Some(&endpoint.password));
    let result = super::linked::send_with_timeout(request, query, body, max, timeout).await?;
    current().then_some(result).ok_or_else(native_error)
}

async fn root_at(
    app: &App,
    w: &Workspace,
    scoped: bool,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    timeout: std::time::Duration,
    prechecked_local: Option<Physical>,
) -> Result<Root, Error> {
    let native_dir = w.location["directory"].as_str().ok_or_else(native_error)?;
    let here = catalogue_native(
        app,
        w,
        endpoint,
        Method::GET,
        "/api/location",
        &[("location[directory]", native_dir)],
        None,
        128 * 1024,
        timeout,
    )
    .await?;
    let project = here["project"]["id"].as_str().filter(|p| crate::opencode::valid_id(p)).ok_or_else(native_error)?;
    let live_scope = if scoped { app.scope.clone() } else { PathBuf::new() };
    let local = match prechecked_local {
        Some(local) => local,
        None => checkout_in(&live_scope, &w.path).await?,
    };
    let main_raw = here["project"]["canonical"].as_str().map(str::to_owned).ok_or_else(native_error)?;
    let here_dir_raw = here["directory"].as_str().map(str::to_owned);
    let project_dir_raw = here["project"]["directory"].as_str().map(str::to_owned);
    let scope_for_root = app.scope.clone();
    let (main_path, here_dir, project_dir) = tokio::task::spawn_blocking(move || {
        let resolve = |raw: &str| {
            if scoped {
                super::ownership::resolve_media_path_checked(&scope_for_root, raw)
                    .ok()
                    .flatten()
                    .filter(|(p, a)| p == a)
                    .map(|(p, _)| p)
            } else {
                physical(raw)
            }
        };
        (resolve(&main_raw), here_dir_raw.as_deref().and_then(resolve), project_dir_raw.as_deref().and_then(resolve))
    })
    .await
    .map_err(|_| native_error())?;
    let main_path = main_path.ok_or_else(|| {
        if scoped { conflict("Workspace and native project do not share a checkout") } else { native_error() }
    })?;
    let main = if main_path == local.root { local.clone() } else { checkout_in(&live_scope, &main_path).await? };
    if here_dir.as_ref() != Some(&w.path)
        || project_dir.as_ref() != Some(&local.root)
        || main.root != main_path
        || main.admin != main.common
        || main.common != local.common
        || main.common_id != local.common_id
        || scoped && (!main_path.starts_with(&app.scope) || !local.root.starts_with(&app.scope))
    {
        return Err(conflict("Workspace and native project do not share a checkout"));
    }
    let opened_path = w.path.clone();
    let (live_ok, local, main) = tokio::task::spawn_blocking(move || {
        let ok = local.live_for_in(&live_scope, &opened_path) && main.live_in(&live_scope);
        (ok, local, main)
    })
    .await
    .map_err(|_| native_error())?;
    if !live_ok {
        return Err(native_error());
    }
    Ok(Root { project: project.into(), local, main })
}
/// Root-only session mutations need the opened checkout's proof, independent of sibling inventory size.
pub(crate) async fn root_supported_with(app: &App, w: &Workspace, local: Physical) -> bool {
    root_at(app, w, true, None, std::time::Duration::from_secs(12), Some(local)).await.is_ok()
}
pub async fn catalogue(app: &App, w: &Workspace, refresh: bool) -> Result<Catalogue, Error> {
    catalogue_in(app, w, refresh, true, None).await
}

async fn catalogue_in(
    app: &App,
    w: &Workspace,
    refresh: bool,
    scoped: bool,
    prechecked_local: Option<Physical>,
) -> Result<Catalogue, Error> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
    let endpoint = app.native.acquire(deadline).await.map_err(|_| native_error())?;
    catalogue_in_at(app, w, refresh, scoped, Some(&endpoint), std::time::Duration::from_secs(12), prechecked_local)
        .await
}

pub(crate) async fn catalogue_at(
    app: &App,
    w: &Workspace,
    refresh: bool,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    timeout: std::time::Duration,
) -> Result<Catalogue, Error> {
    catalogue_at_with_local(app, w, refresh, endpoint, timeout, None).await
}

pub(crate) async fn catalogue_at_with_local(
    app: &App,
    w: &Workspace,
    refresh: bool,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    timeout: std::time::Duration,
    prechecked_local: Option<Physical>,
) -> Result<Catalogue, Error> {
    catalogue_in_at(app, w, refresh, true, endpoint, timeout, prechecked_local).await
}

async fn validate_local_config_includes(scope: &Path, local: &Physical) -> Result<(), Error> {
    if scope.as_os_str().is_empty() {
        return Ok(());
    }
    let scope = scope.to_path_buf();
    let root = local.root.clone();
    let common = local.common.clone();
    let admin = local.admin.clone();
    let ok = tokio::task::spawn_blocking(move || {
        canonical_dir_in(&scope, &root, &root) && validate_local_config_includes_in(&scope, &common, &admin)
    })
    .await
    .unwrap_or(false);
    if ok { Ok(()) } else { Err(native_error()) }
}

async fn catalogue_in_at(
    app: &App,
    w: &Workspace,
    refresh: bool,
    scoped: bool,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    timeout: std::time::Duration,
    prechecked_local: Option<Physical>,
) -> Result<Catalogue, Error> {
    let Root { project, local, main } = root_at(app, w, scoped, endpoint, timeout, prechecked_local).await?;
    let live_scope = if scoped { app.scope.clone() } else { PathBuf::new() };
    validate_local_config_includes(&live_scope, &local).await?;
    // Snapshot effective Git config with `--includes` when `include.path` is present so mid-scan
    // edits inside included config files are detected before publication (TS `git-worktrees.ts:104-135`).
    let effective_config =
        crate::git::run_in_scope(&local.root, &live_scope, &["config", "--null", "--list", "--includes"], 4 << 20)
            .await
            .map_err(|_| native_error())?
            .ok()
            .map_err(|_| native_error())?
            .text();
    let include_snapshot = effective_config
        .split('\0')
        .any(|entry| {
            entry
                .split_once('\n')
                .is_some_and(|(k, _)| k == "include.path" || (k.starts_with("includeif.") && k.ends_with(".path")))
        })
        .then_some(effective_config);
    let native_dir = w.location["directory"].as_str().ok_or_else(native_error)?;
    let project = project.as_str();
    let tail = w.path.strip_prefix(&local.root).map_err(|_| native_error())?;
    if refresh {
        catalogue_native(
            app,
            w,
            endpoint,
            Method::POST,
            "/api/worktree/refresh",
            &[],
            Some(json!({"projectID":project})),
            16384,
            timeout,
        )
        .await?;
    }
    // The reference lists every registration; only the response sizes are bounded.
    let entries = catalogue_native(
        app,
        w,
        endpoint,
        Method::GET,
        "/api/worktree",
        &[("projectID", project)],
        None,
        4 << 20,
        timeout,
    )
    .await?;
    let entries = entries.as_array().ok_or_else(native_error)?;
    let service_roots: Vec<String> = entries
        .iter()
        .map(|entry| entry["directory"].as_str().map(str::to_owned).ok_or_else(native_error))
        .collect::<Result<Vec<_>, _>>()?;
    if !tokio::task::spawn_blocking({
        let scope = live_scope.clone();
        let root = main.root.clone();
        move || precheck_git_layout_in_scope(&scope, &root)
    })
    .await
    .unwrap_or(false)
    {
        return Err(native_error());
    }
    validate_local_config_includes(&live_scope, &main).await?;
    let annotations =
        crate::git::run_in_scope(&main.root, &live_scope, &["worktree", "list", "--porcelain", "-z"], 4 << 20)
            .await?
            .ok()?
            .text();
    let scope_for_resolve = app.scope.clone();
    let candidates = tokio::task::spawn_blocking(move || {
        let resolve_root = |raw: &str| -> Option<PathBuf> {
            if scoped {
                super::ownership::resolve_media_path_checked(&scope_for_resolve, raw)
                    .ok()
                    .flatten()
                    .filter(|(p, a)| p == a)
                    .map(|(p, _)| p)
            } else {
                physical(raw)
            }
        };
        let snapshot: HashMap<PathBuf, String> = annotations
            .split("\0\0")
            .filter_map(|s| Some((resolve_root(s.split('\0').next()?.strip_prefix("worktree ")?)?, s.to_owned())))
            .collect();
        let mut seen = HashSet::new();
        let mut resolved = Vec::new();
        for service_root in service_roots {
            let Some(root) = resolve_root(&service_root) else { continue };
            if !seen.insert(root.clone()) {
                continue;
            }
            let Some(meta) = snapshot.get(&root).cloned() else { continue };
            resolved.push((service_root, root, meta));
        }
        resolved
    })
    .await
    .map_err(|_| native_error())?;
    let live_scope = if scoped { app.scope.clone() } else { PathBuf::new() };
    let mut verified_roots = Vec::new();
    for (service_root, root, meta) in candidates {
        let check = if root == local.root {
            local.clone()
        } else if root == main.root {
            main.clone()
        } else {
            match checkout_in(&live_scope, &root).await {
                Ok(check) => check,
                // Reference `listNativeWorktrees`: a registration whose Git layout
                // is gone (removal or prune in progress, interrupted removal) is no
                // longer a checkout and is omitted rather than failing the list.
                Err(_)
                    if tokio::task::spawn_blocking({
                        let root = root.clone();
                        let live_scope = live_scope.clone();
                        move || git_layout_gone_in(&live_scope, &root)
                    })
                    .await
                    .unwrap_or(false) =>
                {
                    crate::bench::route_trace(format_args!("worktree-omitted layout-gone"));
                    continue;
                }
                Err(error) if root.starts_with(&app.scope) => return Err(error),
                Err(_) => continue,
            }
        };
        if check.root != root || check.common != local.common || check.common_id != local.common_id {
            continue;
        }
        verified_roots.push((service_root, root, meta, check));
    }
    let repo_layouts: Arc<Vec<Physical>> =
        Arc::new(verified_roots.iter().map(|(_, _, _, check)| check.clone()).collect());
    let mut checked = Vec::new();
    for (service_root, root, meta, check) in verified_roots {
        let service_root = service_root.as_str();
        let meta = meta.as_str();
        let opened = root == local.root;
        let projected = if tail.as_os_str().is_empty() { root.clone() } else { root.join(tail) };
        let (check, tree_path, id, projected_link, nested_missing) = {
            let root = root.clone();
            let projected = projected.clone();
            let scope = app.scope.clone();
            let live_scope = live_scope.clone();
            let repo_layouts = repo_layouts.clone();
            match tokio::task::spawn_blocking(
                move || -> Result<
                    Option<(Physical, PathBuf, Option<String>, Option<Box<(PathBuf, PathBuf, Physical, String)>>, bool)>,
                    Error,
                > {
                    if !check.live_in(&live_scope) {
                        // A layout that vanished mid-scan is omitted; a config change rejects the
                        // whole scan rather than publishing a partial inventory (TS `git-worktrees.ts:128-135`).
                        return if git_layout_gone_in(&live_scope, &root) {
                            Ok(None)
                        } else {
                            Err(config_changed_error())
                        };
                    }
                    let resolved_projected = if root.starts_with(&scope) {
                        match projected.to_str() {
                            Some(proj_str) => match super::ownership::resolve_media_path_checked(&scope, proj_str) {
                                Ok(Some((real, anchor))) if real == anchor => Ok(real),
                                Ok(Some(_)) => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                                Ok(None) => {
                                    // Unresolvable, file-backed, dangling-loop, or out-of-scope/network
                                    // projection: mark missing without touching any out-of-scope target.
                                    return if !opened {
                                        Ok(Some((check, projected, None, None, true)))
                                    } else {
                                        Err(conflict("Projected worktree directory is not physically owned"))
                                    };
                                }
                                Err(()) => Err(std::io::Error::other("projected path unreadable")),
                            },
                            None => Err(std::io::Error::other("non-utf8 projected path")),
                        }
                    } else {
                        dunce::canonicalize(&projected)
                    };
                    let (tree_path, id, projected_link, nested_missing) = match resolved_projected {
                        Ok(real) if real == projected && real.is_dir() => match identity(&projected) {
                            Ok(value) => (projected, Some(value), None, false),
                            Err(_) if !opened && !root.starts_with(&scope) => (projected, None, None, true),
                            Err(error) => return Err(error),
                        },
                        // TS resolves a sibling worktree's symlinked projected subfolder and admits it
                        // for media/history ownership when its target stays inside a verified worktree
                        // of the same repo (`manager.ts:582-605`, `worktree-directory.ts:248-278`).
                        // When its target lies outside verified checkouts or outside `scope`, TS still
                        // keeps the sibling checkout descriptor in `/worktrees` with
                        // `nestedFolderMissing: false` (`native-worktrees.ts:159-181`) while ownership
                        // refuses the foreign target.
                        Ok(real) if !opened && real.is_dir() => {
                            if real.starts_with(&scope)
                                && let Some(target_layout) = repo_layouts
                                    .iter()
                                    .filter(|layout| real.starts_with(&layout.root))
                                    .max_by_key(|layout| layout.root.as_os_str().len())
                            {
                                match identity(&real) {
                                    Ok(value) => (
                                        projected.clone(),
                                        None,
                                        Some(Box::new((projected, real, target_layout.clone(), value))),
                                        false,
                                    ),
                                    Err(_) => return Ok(None),
                                }
                            } else {
                                (projected, None, None, false)
                            }
                        }
                        Ok(real) if !opened && (real.is_file() || !root.starts_with(&scope)) => {
                            (projected, None, None, true)
                        }
                        Ok(_) if !opened => return Ok(None),
                        Ok(_) => return Err(conflict("Projected worktree directory is not physically owned")),
                        Err(_) => (projected, None, None, true),
                    };
                    Ok(Some((check, tree_path, id, projected_link, nested_missing)))
                },
            )
            .await
            .map_err(|_| native_error())??
            {
                Some(tuple) => tuple,
                None => continue,
            }
        };
        let service = if opened {
            native_dir.to_string()
        } else if tail.as_os_str().is_empty() {
            service_root.to_string()
        } else {
            Path::new(service_root).join(tail).to_str().ok_or_else(native_error)?.into()
        };
        let digest = format!("{:x}", Sha256::digest(super::linked::host(&root)?.as_bytes()));
        let slug = if opened { "root".into() } else { format!("worktree-{}", &digest[..20]) };
        let field = |prefix: &str| meta.split('\0').find_map(|s| s.strip_prefix(prefix)).map(str::to_owned);
        checked.push(Tree {
            path: tree_path,
            service,
            slug,
            identity: id.clone(),
            nested_missing,
            service_root: service_root.into(),
            removable: !opened && check.admin != check.common,
            layout: check,
            projected_link,
            scope: if scoped { app.scope.clone() } else { PathBuf::new() },
            branch: field("branch refs/heads/"),
            head: field("HEAD ").filter(|s| s.bytes().any(|b| b != b'0')),
            locked: meta.split('\0').any(|s| s == "locked" || s.starts_with("locked ")),
        });
    }
    app.workspace(&w.id.to_string())?;
    if !checked.iter().any(|t| t.slug == "root" && !t.nested_missing) {
        return Err(native_error());
    }
    // Re-verify every checkout's Git layout and config stamps right before publication
    // (TS `git-worktrees.ts:128-135`) so a mid-inventory config change cannot publish stale data.
    if let Some(expected_config) = include_snapshot {
        validate_local_config_includes(&live_scope, &local).await?;
        let current_config =
            crate::git::run_in_scope(&local.root, &live_scope, &["config", "--null", "--list", "--includes"], 4 << 20)
                .await
                .map_err(|_| native_error())?
                .ok()
                .map_err(|_| native_error())?
                .text();
        if current_config != expected_config {
            return Err(config_changed_error());
        }
    }
    let layouts: Vec<Physical> = std::iter::once(local)
        .chain(std::iter::once(main.clone()))
        .chain(checked.iter().map(|t| t.layout.clone()))
        .collect();
    let live_scope = if scoped { app.scope.clone() } else { PathBuf::new() };
    let all_live = tokio::task::spawn_blocking(move || layouts.iter().all(|layout| layout.live_in(&live_scope)))
        .await
        .map_err(|_| native_error())?;
    if !all_live {
        return Err(config_changed_error());
    }
    checked.sort_by_key(|t| (t.slug != "root", t.branch.clone(), t.slug.clone()));
    Ok(Catalogue {
        project: project.into(),
        parent: main.root.join(".codenomad/worktrees"),
        main: main.root,
        trees: checked,
    })
}

#[cfg(test)]
mod layout_tests {
    use super::{checkout, git_layout_gone, linked_markers};

    #[test]
    fn a_registration_without_git_layout_is_gone() {
        let base = crate::shared::test_dir("layout");
        let tree = base.join("tree");
        let admin = base.join("admin");
        std::fs::create_dir_all(&tree).unwrap();
        assert!(git_layout_gone(&tree), "no .git");
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        assert!(git_layout_gone(&tree), "administrative directory removed");
        std::fs::create_dir_all(&admin).unwrap();
        assert!(!git_layout_gone(&tree), "complete linked layout");
        std::fs::remove_file(tree.join(".git")).unwrap();
        std::fs::create_dir_all(tree.join(".git")).unwrap();
        assert!(!git_layout_gone(&tree), "main checkout directory");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn a_changed_common_directory_invalidates_a_captured_layout() {
        let base = crate::shared::test_dir("worktree-common-directory");
        let root = base.join("root");
        let tree = base.join("tree");
        std::fs::create_dir_all(&root).unwrap();
        for args in [
            &["init", "-q"][..],
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "initial",
                "--allow-empty",
            ],
            &["worktree", "add", "--detach", tree.to_str().unwrap(), "HEAD"],
        ] {
            assert!(crate::git::command(&root, args).status().await.unwrap().success());
        }
        let main_layout = checkout(&root).await.unwrap();
        assert!(main_layout.live());
        let layout = checkout(&tree).await.unwrap();
        assert!(layout.live());
        let marker = tree.join(".git");
        let original = std::fs::read(&marker).unwrap();
        std::fs::write(&marker, format!("gitdir: {}\n", layout.common.display())).unwrap();
        assert!(linked_markers(&layout.root, &layout.admin, &layout.common).is_err());
        std::fs::write(&marker, original).unwrap();
        std::fs::write(layout.admin.join("commondir"), "../elsewhere\n").unwrap();
        assert!(!layout.live());
        std::fs::write(main_layout.admin.join("commondir"), "../elsewhere\n").unwrap();
        assert!(!main_layout.live());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn precheck_refuses_bare_repo_with_disallowed_include() {
        let base = dunce::canonicalize(crate::shared::test_dir("bare-precheck")).unwrap();
        let bare = base.join("bare.git");
        std::fs::create_dir_all(bare.join("objects")).unwrap();
        std::fs::create_dir_all(bare.join("refs")).unwrap();
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(bare.join("config"), "[core]\n\tbare = true\n").unwrap();
        assert!(super::precheck_git_layout_in_scope(&base, &bare));

        std::fs::write(bare.join("config"), "[include]\n\tpath = ~otheruser/secret.gitconfig\n").unwrap();
        assert!(!super::precheck_git_layout_in_scope(&base, &bare));

        std::fs::write(bare.join("config"), "[include]\n\tpath = %(prefix)/etc/gitconfig\n").unwrap();
        assert!(!super::precheck_git_layout_in_scope(&base, &bare));

        let sub = bare.join("objects");
        assert!(!super::precheck_git_layout_in_scope(&base, &sub));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn precheck_refuses_out_of_scope_refs_link_and_preserves_trailing_space_in_gitdir() {
        let root = dunce::canonicalize(crate::shared::test_dir("precheck-scope-refs")).unwrap();
        let scope = root.join("scope");
        let outside = root.join("outside");
        std::fs::create_dir_all(&scope).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        // Trailing space in `gitdir:` must not be stripped (only CR/LF match Git).
        assert_eq!(super::strip_git_eol("gitdir: ./dir \r\n"), "gitdir: ./dir ");

        // An out-of-scope `refs` junction/symlink inside `.git` must fail closed.
        let repo = scope.join("repo");
        let git_dir = repo.join(".git");
        std::fs::create_dir_all(git_dir.join("objects")).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git_dir.join("config"), "[core]\n\tbare = false\n").unwrap();
        #[cfg(windows)]
        let linked = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .creation_flags(0x0800_0000)
                .args(["/c", "mklink", "/J", git_dir.join("refs").to_str().unwrap(), outside.to_str().unwrap()])
                .status()
                .is_ok_and(|s| s.success())
        };
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, git_dir.join("refs")).is_ok();
        if linked {
            assert!(!super::precheck_git_layout_in_scope(&scope, &repo));
        }

        // Remove junction before cleanup.
        let _ = std::fs::remove_dir(git_dir.join("refs"));
        let _ = std::fs::remove_file(git_dir.join("refs"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
