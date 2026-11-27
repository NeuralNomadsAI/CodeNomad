//! Host path resolution and Git common-directory / repository-root discovery.
use super::reject_network_path;
use std::path::{Path, PathBuf};
pub(super) fn head_cannot_name_repository(path: &Path) -> bool {
    use std::io::{ErrorKind, Read};
    match std::fs::symlink_metadata(path) {
        Err(error) => error.kind() == ErrorKind::NotFound,
        Ok(meta) if meta.is_dir() => true,
        // Keep links and ambiguous reads closed; Git resolves the external
        // target's actual common directory during the asynchronous admission.
        Ok(meta) if meta.is_file() && meta.len() <= 4096 => {
            let mut opts = std::fs::OpenOptions::new();
            opts.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.custom_flags(libc::O_NONBLOCK);
            }
            let Ok(file) = opts.open(path) else { return false };
            if !file.metadata().is_ok_and(|m| m.is_file() && m.len() <= 4096) {
                return false;
            }
            let mut head = Vec::new();
            file.take(4097).read_to_end(&mut head).is_ok()
                && head.len() <= 4096
                && !head.strip_prefix(b"ref:").is_some_and(|target| target.trim_ascii_start().starts_with(b"refs/"))
                && !head.get(..40).is_some_and(|oid| oid.iter().all(u8::is_ascii_hexdigit))
        }
        _ => false,
    }
}

/// `resolveDirectoryPath`: the real path, or the real nearest ancestor joined with the
/// missing components; `None` when an existing entry cannot be resolved.
pub fn resolve_directory(directory: &str) -> Option<PathBuf> {
    let trimmed = crate::shared::js_trim(directory);
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed;
    let style = crate::files::node_path::Style::host();
    let absolute = if style.is_absolute(raw) {
        style.normalize(raw)
    } else {
        style.join(&std::env::current_dir().ok()?.to_string_lossy(), raw)
    };
    let mut current = PathBuf::from(absolute);
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match dunce::canonicalize(&current) {
            Ok(real) => return Some(missing.iter().rev().fold(real, |p, c| p.join(c))),
            Err(_) => {
                if std::fs::symlink_metadata(&current).is_ok()
                    || std::fs::symlink_metadata(&current).err()?.kind() != std::io::ErrorKind::NotFound
                {
                    return None;
                }
                missing.push(current.file_name()?.to_owned());
                current = current.parent()?.to_path_buf();
            }
        }
    }
}
/// `isPathWithinWorktree` (host paths).
pub fn within(root: &Path, candidate: &Path) -> bool {
    let style = crate::files::node_path::Style::host();
    let relative = style.relative(&root.to_string_lossy(), &candidate.to_string_lossy());
    relative.is_empty()
        || relative != ".."
            && !relative.starts_with(&format!("..{}", std::path::MAIN_SEPARATOR))
            && !style.is_absolute(&relative)
}
/// `readGitCommonDirectory`: the canonical Git common directory, `None` when unreadable.
pub async fn common_directory(dir: &Path) -> Option<PathBuf> {
    read_common_directory_in_scope(Path::new(""), dir).await.ok().flatten()
}

pub(super) async fn read_common_directory_in_scope(scope: &Path, dir: &Path) -> Result<Option<PathBuf>, ()> {
    let pre_ok = tokio::task::spawn_blocking({
        let scope = scope.to_path_buf();
        let dir = dir.to_path_buf();
        move || crate::worktrees::precheck_git_layout_in_scope(&scope, &dir)
    })
    .await
    .map_err(|_| ())?;
    if !pre_ok {
        return Err(());
    }
    let out =
        crate::git::run_in_scope(dir, scope, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024)
            .await
            .map_err(|_| ())?;
    if out.not_a_repository() {
        return Ok(None);
    }
    let out = out.ok().map_err(|_| ())?;
    let trimmed = out.text().trim().to_owned();
    let scope_owned = scope.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if !scope_owned.as_os_str().is_empty() {
            match super::resolve_media_path_checked(&scope_owned, &trimmed).ok().flatten() {
                Some((p, a)) if p == a && p.is_dir() => Some(p),
                _ => None,
            }
        } else {
            dunce::canonicalize(trimmed).ok()
        }
    })
    .await
    .map_err(|_| ())?
    .map(Some)
    .ok_or(())
}

pub(super) async fn shares_common_directory_in_scope(scope: &Path, left: &Path, right: &Path) -> Result<bool, ()> {
    let (a, b) =
        tokio::join!(read_common_directory_in_scope(scope, left), read_common_directory_in_scope(scope, right));
    let (a, b) = (a?, b?);
    Ok(a.is_some() && a == b)
}

#[cfg(test)]
pub(super) async fn shares_common_directory(left: &Path, right: &Path) -> Result<bool, ()> {
    shares_common_directory_in_scope(Path::new(""), left, right).await
}

fn read_small_text(path: &Path) -> Result<String, ()> {
    use std::io::Read;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK);
    }
    let file = opts.open(path).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return Err(());
    }
    let mut buf = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut buf).map_err(|_| ())?;
    if buf.len() > 64 * 1024 {
        return Err(());
    }
    String::from_utf8(buf).map_err(|_| ())
}

fn strip_eol(s: &str) -> &str {
    s.strip_suffix('\n').map_or(s, |r| r.strip_suffix('\r').unwrap_or(r))
}

fn valid_git_dir_entry(scope: &Path, path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if scope.as_os_str().is_empty() {
        return std::fs::metadata(path).is_ok();
    }
    if meta.is_dir() && !meta.file_type().is_symlink() && std::fs::read_link(path).is_err() {
        return true;
    }
    path.to_str()
        .is_some_and(|s| super::resolve_media_path_checked(scope, s).ok().flatten().is_some_and(|(p, a)| p == a))
}

/// Validates that a Git admin/common directory pair still contains `objects`, `refs`, and a
/// structurally valid `HEAD` (symlink to `refs/...`, `ref: refs/...`, or 40/64-hex OID).
pub(in crate::worktrees) fn valid_git_admin(admin: &Path, common: &Path) -> bool {
    valid_git_admin_in(Path::new(""), admin, common)
}

/// Scope-bounded variant of [`valid_git_admin`] that never follows `objects`/`refs` links outside `scope`.
pub(in crate::worktrees) fn valid_git_admin_in(scope: &Path, admin: &Path, common: &Path) -> bool {
    if !valid_git_dir_entry(scope, &common.join("objects")) || !valid_git_dir_entry(scope, &common.join("refs")) {
        return false;
    }
    let head_path = admin.join("HEAD");
    let Ok(head_meta) = std::fs::symlink_metadata(&head_path) else {
        return false;
    };
    if head_meta.file_type().is_symlink() {
        std::fs::read_link(&head_path)
            .ok()
            .and_then(|target| target.to_str().map(|s| !s.contains('\\') && s.starts_with("refs/")))
            .unwrap_or(false)
    } else if head_meta.is_file() && head_meta.len() <= 4096 {
        let Ok(content) = read_small_text(&head_path) else {
            return false;
        };
        let content = strip_eol(&content);
        content.strip_prefix("ref:").is_some_and(|rest| rest.trim_start().starts_with("refs/"))
            || (matches!(content.len(), 40 | 64) && content.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    } else {
        false
    }
}

/// Filesystem-only strict Git discovery mirroring TS `discoverCheckoutCommonDirectory`.
/// Returns `Ok(None)` when absence of a checkout is verified, and `Err(())` on any
/// ambiguous layout (incomplete `.git`, bare/separate markers, or Git env overrides).
fn strict_discover_common_directory(dir: &Path) -> Result<Option<PathBuf>, ()> {
    use std::io::ErrorKind;
    const DISCOVERY_ENV: &[&str] = &[
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_OBJECT_DIRECTORY",
    ];
    if DISCOVERY_ENV.iter().any(|key| std::env::var_os(key).is_some()) {
        return Err(());
    }
    let read_small = read_small_text;
    let mut current = dunce::canonicalize(dir).map_err(|_| ())?;
    let info = std::fs::metadata(&current).map_err(|_| ())?;
    if !info.is_dir() {
        return Err(());
    }
    #[cfg(unix)]
    let device = {
        use std::os::unix::fs::MetadataExt;
        info.dev()
    };
    let root = loop {
        if current.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(".git")) {
            return Err(());
        }
        match std::fs::symlink_metadata(current.join(".git")) {
            Ok(_) => break current,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        for entry in ["HEAD", "commondir"] {
            match std::fs::symlink_metadata(current.join(entry)) {
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                _ => return Err(()),
            }
        }
        let Some(parent) = current.parent() else { return Ok(None) };
        if parent == current {
            return Ok(None);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if std::fs::metadata(parent).map_err(|_| ())?.dev() != device {
                return Ok(None);
            }
        }
        current = parent.to_path_buf();
    };
    let entry = root.join(".git");
    let entry_meta = std::fs::symlink_metadata(&entry).map_err(|_| ())?;
    if entry_meta.file_type().is_symlink() {
        let link_target = std::fs::read_link(&entry).map_err(|_| ())?;
        reject_network_path(&link_target.to_string_lossy(), &link_target)?;
    }
    let git_dir = if std::fs::metadata(&entry).map_err(|_| ())?.is_dir() {
        entry
    } else {
        let text = read_small(&entry)?;
        let target = strip_eol(&text).strip_prefix("gitdir: ").ok_or(())?;
        let p = Path::new(target);
        let candidate = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
        reject_network_path(target, &candidate)?;
        candidate
    };
    let common_rel = match std::fs::symlink_metadata(git_dir.join("commondir")) {
        Err(error) if error.kind() == ErrorKind::NotFound => ".".to_owned(),
        Ok(_) => strip_eol(&read_small(&git_dir.join("commondir"))?).to_owned(),
        Err(_) => return Err(()),
    };
    let resolved_git = dunce::canonicalize(&git_dir).map_err(|_| ())?;
    let common_raw =
        if Path::new(&common_rel).is_absolute() { PathBuf::from(&common_rel) } else { git_dir.join(&common_rel) };
    reject_network_path(&common_rel, &common_raw)?;
    let resolved_common = dunce::canonicalize(&common_raw).map_err(|_| ())?;
    if resolved_git != resolved_common {
        let backlink = read_small(&resolved_git.join("gitdir"))?;
        let backlink = strip_eol(&backlink);
        let back_path =
            if Path::new(backlink).is_absolute() { PathBuf::from(backlink) } else { resolved_git.join(backlink) };
        reject_network_path(backlink, &back_path)?;
        let back_parent = back_path.parent().ok_or(())?;
        dunce::canonicalize(back_parent).map_err(|_| ())?;
    }
    if !valid_git_admin(&resolved_git, &resolved_common) {
        return Err(());
    }
    Ok(Some(resolved_common))
}

pub(super) async fn strict_common_directory(dir: &Path) -> Result<Option<PathBuf>, ()> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || strict_discover_common_directory(&dir)).await.map_err(|_| ())?
}

pub(super) async fn shares_common_directory_strict(left: &Path, right: &Path) -> Result<bool, ()> {
    let (left, right) = (left.to_path_buf(), right.to_path_buf());
    tokio::task::spawn_blocking(move || {
        let a = strict_discover_common_directory(&left)?;
        let b = strict_discover_common_directory(&right)?;
        Ok(a.is_some() && a == b)
    })
    .await
    .map_err(|_| ())?
}
pub(super) async fn repository_root_in_scope(scope: &Path, root: &Path) -> PathBuf {
    let pre_ok = tokio::task::spawn_blocking({
        let scope = scope.to_path_buf();
        let root = root.to_path_buf();
        move || crate::worktrees::precheck_git_layout_in_scope(&scope, &root)
    })
    .await
    .unwrap_or(false);
    if !pre_ok {
        return root.to_path_buf();
    }
    match crate::git::run_in_scope(root, scope, &["rev-parse", "--show-toplevel"], 16 * 1024)
        .await
        .ok()
        .and_then(|o| o.ok().ok())
    {
        Some(o) => {
            let trimmed = o.text().trim().to_owned();
            let fallback = root.to_path_buf();
            let scope_owned = scope.to_path_buf();
            tokio::task::spawn_blocking(move || {
                if !scope_owned.as_os_str().is_empty() {
                    match super::resolve_media_path_checked(&scope_owned, &trimmed).ok().flatten() {
                        Some((p, a)) if p == a && p.is_dir() => p,
                        _ => fallback,
                    }
                } else {
                    dunce::canonicalize(trimmed).unwrap_or(fallback)
                }
            })
            .await
            .unwrap_or_else(|_| root.to_path_buf())
        }
        None => root.to_path_buf(),
    }
}
