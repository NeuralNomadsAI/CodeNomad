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
        files::host_identity(path).ok()
    }
}

fn config_stamp(path: &Path) -> Option<Option<ConfigStamp>> {
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
            match dunce::canonicalize(path) {
                Ok(real) => match std::fs::metadata(&real) {
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
        opts.custom_flags(libc::O_NONBLOCK);
    }
    let file = opts.open(path).map_err(|_| native_error())?;
    let meta = file.metadata().map_err(|_| native_error())?;
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

impl Physical {
    fn live(&self) -> bool {
        let canonical = |path: &Path| dunce::canonicalize(path).ok().as_deref() == Some(path);
        canonical(&self.root)
            && canonical(&self.admin)
            && canonical(&self.common)
            && identity(&self.root).ok().as_ref() == Some(&self.root_id)
            && identity(&self.admin).ok().as_ref() == Some(&self.admin_id)
            && identity(&self.common).ok().as_ref() == Some(&self.common_id)
            && super::ownership::valid_git_admin(&self.admin, &self.common)
            && config_stamp(&self.common.join("config")).as_ref() == Some(&self.stamp[0])
            && config_stamp(&self.admin.join("config.worktree")).as_ref() == Some(&self.stamp[1])
            && match (&self.marker, &self.backlink, &self.common_marker) {
                (Some(marker), Some(backlink), Some(common_marker)) => {
                    linked_markers(&self.root, &self.admin, &self.common)
                        .is_ok_and(|[m, b, c]| &m == marker && &b == backlink && &c == common_marker)
                }
                (Some(marker), None, None) => {
                    separate_marker(&self.root, &self.common).is_ok_and(|m| &m == marker)
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
    fn live_for(&self, opened: &Path) -> bool {
        self.live()
            && dunce::canonicalize(opened).ok().as_deref() == Some(opened)
            && ancestor_markers(opened, &self.root).as_ref() == Some(&self.ancestors)
    }
}
/// The checkout's `.git`, its `gitdir:` admin directory, or an administrative backlink
/// (`gitdir` / `commondir`) is missing (`ENOENT`, TS `readCheckoutIdentity` / `native-worktrees.ts:135-150`).
fn git_layout_gone(root: &Path) -> bool {
    let marker = root.join(".git");
    match std::fs::symlink_metadata(&marker) {
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        Ok(meta) if meta.is_file() => {
            small(&marker).ok().and_then(|bytes| String::from_utf8(bytes).ok()).is_some_and(|text| {
                text.lines().find_map(|line| line.strip_prefix("gitdir:")).is_some_and(|dir| {
                    let dir = Path::new(dir.trim());
                    let dir = if dir.is_absolute() { dir.to_path_buf() } else { root.join(dir) };
                    if std::fs::symlink_metadata(&dir).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
                        return true;
                    }
                    // A linked worktree whose `admin/gitdir` backlink or `admin/commondir` disappeared
                    // mid-removal is gone (TS `readCheckoutIdentity` throws ENOENT).
                    let is_linked = dir.parent().and_then(|p| p.file_name()).is_some_and(|n| n == "worktrees");
                    is_linked
                        && (std::fs::symlink_metadata(dir.join("gitdir"))
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                            || std::fs::symlink_metadata(dir.join("commondir"))
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

fn linked_markers(root: &Path, admin: &Path, common: &Path) -> Result<[Vec<u8>; 3], Error> {
    if admin.parent() != Some(common.join("worktrees").as_path()) {
        return Err(conflict("Foreign worktree administration"));
    }
    let marker = small(&root.join(".git"))?;
    let gitdir = std::str::from_utf8(&marker)
        .ok()
        .and_then(|text| text.trim_end().strip_prefix("gitdir: "))
        .filter(|path| !path.is_empty())
        .ok_or_else(native_error)?;
    if dunce::canonicalize(root.join(gitdir)).ok().as_deref() != Some(admin) {
        return Err(conflict("Git worktree marker changed"));
    }
    let backlink = small(&admin.join("gitdir"))?;
    let text = std::str::from_utf8(&backlink).map_err(|_| native_error())?.trim_end();
    if dunce::canonicalize(admin.join(text)).ok().as_ref() != Some(&root.join(".git")) {
        return Err(conflict("Foreign Git backlink"));
    }
    let common_marker = small(&admin.join("commondir"))?;
    let text = std::str::from_utf8(&common_marker).map_err(|_| native_error())?.trim_end();
    if dunce::canonicalize(admin.join(text)).ok().as_deref() != Some(common) {
        return Err(conflict("Foreign Git common directory"));
    }
    Ok([marker, backlink, common_marker])
}

fn separate_marker(root: &Path, common: &Path) -> Result<Vec<u8>, Error> {
    let dot_git = root.join(".git");
    if std::fs::symlink_metadata(&dot_git).is_ok_and(|meta| meta.file_type().is_symlink())
        && std::fs::metadata(&dot_git).is_ok_and(|meta| meta.is_dir())
        && dunce::canonicalize(&dot_git).ok().as_deref() == Some(common)
    {
        return Ok(Vec::new());
    }
    let marker = small(&dot_git)?;
    let gitdir = std::str::from_utf8(&marker)
        .ok()
        .and_then(|text| text.trim_end().strip_prefix("gitdir: "))
        .filter(|path| !path.is_empty())
        .ok_or_else(native_error)?;
    if dunce::canonicalize(root.join(gitdir)).ok().as_deref() != Some(common) {
        return Err(conflict("External Git directory is unavailable"));
    }
    Ok(marker)
}

fn pre_config_stamps(path: &Path) -> Option<(PathBuf, PathBuf, [Option<ConfigStamp>; 2])> {
    let mut cur = dunce::canonicalize(path).ok()?;
    loop {
        let marker = cur.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Ok(meta) if meta.is_dir() => {
                let common = dunce::canonicalize(&marker).ok()?;
                let s0 = config_stamp(&common.join("config"))?;
                let s1 = config_stamp(&common.join("config.worktree"))?;
                return Some((common.clone(), common, [s0, s1]));
            }
            Ok(meta) if meta.is_file() => {
                let bytes = small(&marker).ok()?;
                let gitdir = std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(|t| t.trim_end().strip_prefix("gitdir: "))
                    .filter(|s| !s.is_empty())?;
                let admin_path = if Path::new(gitdir).is_absolute() {
                    if !is_local_git_target(gitdir) {
                        return None;
                    }
                    PathBuf::from(gitdir)
                } else {
                    cur.join(gitdir)
                };
                let admin = dunce::canonicalize(&admin_path).ok()?;
                let common = if let Ok(cb) = small(&admin.join("commondir")) {
                    let ct = std::str::from_utf8(&cb).ok()?.trim_end();
                    let common_path = if Path::new(ct).is_absolute() {
                        if !is_local_git_target(ct) {
                            return None;
                        }
                        PathBuf::from(ct)
                    } else {
                        admin.join(ct)
                    };
                    dunce::canonicalize(&common_path).ok()?
                } else {
                    admin.clone()
                };
                let s0 = config_stamp(&common.join("config"))?;
                let s1 = config_stamp(&admin.join("config.worktree"))?;
                return Some((common, admin, [s0, s1]));
            }
            _ => {}
        }
        if !cur.pop() {
            return None;
        }
    }
}

pub(crate) enum RootCheckout {
    Git(Result<Box<Physical>, Error>),
    /// Confirmed non-Git directory (`git rev-parse` exited 128 with `"not a git repository"`).
    NonGit,
    /// Non-ENOENT `rev-parse` failure: display falls back to `isGitRepo: false`, while authority checks fail closed.
    FallbackNonGit,
    MissingGit,
}

async fn parse_checkout(
    opened: PathBuf,
    text: String,
    pre: Option<(PathBuf, PathBuf, [Option<ConfigStamp>; 2])>,
) -> Result<Physical, Error> {
    tokio::task::spawn_blocking(move || {
        let mut lines = text.lines();
        let root = lines.next().and_then(physical).ok_or_else(native_error)?;
        let admin = lines.next().and_then(physical).ok_or_else(native_error)?;
        let common = lines.next().and_then(physical).ok_or_else(native_error)?;
        if lines.next().is_some() {
            return Err(native_error());
        }
        let (marker, backlink, common_marker) = if admin == common {
            if common != root.join(".git") {
                (Some(separate_marker(&root, &common)?), None, None)
            } else {
                (None, None, None)
            }
        } else {
            let [marker, backlink, common_marker] = linked_markers(&root, &admin, &common)?;
            (Some(marker), Some(backlink), Some(common_marker))
        };
        let stamp = [
            config_stamp(&common.join("config")).ok_or_else(native_error)?,
            config_stamp(&admin.join("config.worktree")).ok_or_else(native_error)?,
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
        let opened = dunce::canonicalize(&opened).map_err(|_| native_error())?;
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
pub(crate) async fn probe_root_checkout(workspace: &Workspace) -> Result<RootCheckout, Error> {
    let path = workspace.path.clone();
    let (canonical_ok, pre) = tokio::task::spawn_blocking(move || {
        let ok = dunce::canonicalize(&path).ok().as_ref() == Some(&path);
        let pre = ok.then(|| pre_config_stamps(&path)).flatten();
        (ok, pre)
    })
    .await
    .unwrap_or((false, None));
    if !canonical_ok {
        crate::bench::route_trace(format_args!("root-proof canonical path changed"));
        return Err(super::probe_error());
    }
    let args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"];
    match crate::git::run(&workspace.path, &args, 128 * 1024).await {
        Ok(out) if out.code == 0 => {
            Ok(RootCheckout::Git(parse_checkout(workspace.path.clone(), out.text(), pre).await.map(Box::new)))
        }
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
    // Capture config stamps BEFORE `git rev-parse` (TS `git-worktrees.ts:92-135`) so a mid-probe
    // config edit cannot pair an old `rev-parse` root with a newly written config stamp.
    let pre = tokio::task::spawn_blocking({
        let path = path.to_path_buf();
        move || pre_config_stamps(&path)
    })
    .await
    .ok()
    .flatten();
    let text =
        git(path, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).await?;
    parse_checkout(path.to_path_buf(), text, pre).await
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
        self.projected_link.as_ref().is_none_or(|link| dunce::canonicalize(&link.0).ok().as_ref() == Some(&link.1))
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
    pub(super) fn owns_path(&self, dir: &Path) -> bool {
        self.path == dir
            && !self.nested_missing
            && self.projected_link.is_none()
            && self.identity.is_some()
            && self.layout.live()
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
            && self.layout.live()
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
            return dir.starts_with(target)
                && self.layout.live()
                && target_layout.live()
                && dunce::canonicalize(link_path).ok().as_ref() == Some(target)
                && identity(target).ok().as_deref() == Some(target_id.as_str());
        }
        let project_missing = self.nested_missing
            || std::fs::symlink_metadata(&self.path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        // Exact prefix match prevents cross-workspace matches on case-sensitive NTFS when
        // projected `Projet` is absent while a distinct sibling `projet` exists.
        let within = dir.starts_with(&self.path) && (!project_missing || dir.starts_with(self.registered()));
        within
            && self.layout.live()
            && self.link_live()
            && if project_missing {
                std::fs::symlink_metadata(&self.path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            } else {
                self.identity.is_some() && identity(&self.path).ok() == self.identity
            }
    }
    pub(super) fn contains_receipt_location(&self, dir: &Path) -> bool {
        super::ownership::within(&self.path, dir)
            && self.layout.live()
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
        self.trees.iter().find(|t| t.registered() == path && t.layout.live())
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
        self.get("root").is_ok_and(|root| root.layout.live_for(opened))
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
    let local = match prechecked_local {
        Some(local) => local,
        None => checkout(&w.path).await?,
    };
    let main_raw = here["project"]["canonical"].as_str().map(str::to_owned).ok_or_else(native_error)?;
    let here_dir_raw = here["directory"].as_str().map(str::to_owned);
    let project_dir_raw = here["project"]["directory"].as_str().map(str::to_owned);
    let (main_path, here_dir, project_dir) = tokio::task::spawn_blocking(move || {
        (physical(&main_raw), here_dir_raw.as_deref().and_then(physical), project_dir_raw.as_deref().and_then(physical))
    })
    .await
    .map_err(|_| native_error())?;
    let main_path = main_path.ok_or_else(native_error)?;
    let main = if main_path == local.root { local.clone() } else { checkout(&main_path).await? };
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
        let ok = local.live_for(&opened_path) && main.live();
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
    // Snapshot effective Git config with `--includes` when `include.path` is present so mid-scan
    // edits inside included config files are detected before publication (TS `git-worktrees.ts:104-135`).
    let effective_config = crate::git::run(&local.root, &["config", "--null", "--list", "--includes"], 4 << 20)
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
    let annotations =
        crate::git::run(&main.root, &["worktree", "list", "--porcelain", "-z"], 4 << 20).await?.ok()?.text();
    let scope_for_resolve = app.scope.clone();
    let candidates = tokio::task::spawn_blocking(move || {
        let snapshot: HashMap<PathBuf, String> = annotations
            .split("\0\0")
            .filter_map(|s| Some((physical(s.split('\0').next()?.strip_prefix("worktree ")?)?, s.to_owned())))
            .collect();
        let mut seen = HashSet::new();
        let mut resolved = Vec::new();
        for service_root in service_roots {
            let Some(root) = physical(&service_root) else { continue };
            if scoped && !root.starts_with(&scope_for_resolve) || !seen.insert(root.clone()) {
                continue;
            }
            let Some(meta) = snapshot.get(&root).cloned() else { continue };
            resolved.push((service_root, root, meta));
        }
        resolved
    })
    .await
    .map_err(|_| native_error())?;
    let mut verified_roots = Vec::new();
    for (service_root, root, meta) in candidates {
        let check = if root == local.root {
            local.clone()
        } else if root == main.root {
            main.clone()
        } else {
            match checkout(&root).await {
                Ok(check) => check,
                // Reference `listNativeWorktrees`: a registration whose Git layout
                // is gone (removal or prune in progress, interrupted removal) is no
                // longer a checkout and is omitted rather than failing the list.
                Err(_)
                    if tokio::task::spawn_blocking({
                        let root = root.clone();
                        move || git_layout_gone(&root)
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
            let repo_layouts = repo_layouts.clone();
            match tokio::task::spawn_blocking(
                move || -> Result<
                    Option<(Physical, PathBuf, Option<String>, Option<Box<(PathBuf, PathBuf, Physical, String)>>, bool)>,
                    Error,
                > {
                    if !check.live() {
                        // A layout that vanished mid-scan is omitted; a config change rejects the
                        // whole scan rather than publishing a partial inventory (TS `git-worktrees.ts:128-135`).
                        return if git_layout_gone(&root) { Ok(None) } else { Err(config_changed_error()) };
                    }
                    let (tree_path, id, projected_link, nested_missing) = match dunce::canonicalize(&projected) {
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
        let current_config = crate::git::run(&local.root, &["config", "--null", "--list", "--includes"], 4 << 20)
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
    let all_live =
        tokio::task::spawn_blocking(move || layouts.iter().all(Physical::live)).await.map_err(|_| native_error())?;
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
}
