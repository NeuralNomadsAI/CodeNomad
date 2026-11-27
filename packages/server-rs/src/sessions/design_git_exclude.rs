//! Local `.codenomad/design/` Git exclusion after creating or opening an Images conversation,
//! matching `packages/server/src/workspaces/design-git-exclude.ts` and `worktree-map.ts`.
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use regex::Regex;
use tokio::time::Instant;

use crate::git;

const DESIGN_EXCLUDE_ENTRY: &str = ".codenomad/design/";
const EXCLUDE_READ_LIMIT: usize = 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GitExclusion {
    Excluded,
    NotRepository,
    Unavailable,
}

impl GitExclusion {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Excluded => "excluded",
            Self::NotRepository => "not-repository",
            Self::Unavailable => "unavailable",
        }
    }
}

static EXCLUDE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
static NOT_REPO_RE: OnceLock<Regex> = OnceLock::new();

fn lock_for(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let key = path.to_string_lossy().to_lowercase();
    let map = EXCLUDE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(key).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

fn is_not_repository(code: i32, stderr: &str) -> bool {
    code == 128
        && NOT_REPO_RE
            .get_or_init(|| {
                Regex::new(
                    r"(?m)^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)",
                )
                .unwrap()
            })
            .is_match(stderr)
}

/// Anchored, glob-escaped rule for a Location at `prefix` (`rev-parse --show-prefix`) below
/// its worktree top, or `.codenomad/design/` at the worktree top.
pub(super) fn design_exclude_rule(prefix: &str) -> String {
    if prefix.is_empty() {
        return DESIGN_EXCLUDE_ENTRY.to_owned();
    }
    let mut out = String::with_capacity(prefix.len() + DESIGN_EXCLUDE_ENTRY.len() + 1);
    out.push('/');
    for ch in prefix.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push_str(DESIGN_EXCLUDE_ENTRY);
    out
}

/// A line as Git reads an exclude file: one trailing `\r` dropped, then trailing spaces
/// unless backslash-escaped (Git's `trim_trailing_spaces`); leading whitespace is preserved.
fn git_pattern_line(line: &str) -> &str {
    let value = line.strip_suffix('\r').unwrap_or(line);
    let bytes = value.as_bytes();
    let mut last_space: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' {
            if last_space.is_none() {
                last_space = Some(i);
            }
            i += 1;
            continue;
        }
        if bytes[i] == b'\\' {
            i += 1;
            if i >= bytes.len() {
                return value;
            }
        }
        last_space = None;
        i += 1;
    }
    match last_space {
        Some(idx) => &value[..idx],
        None => value,
    }
}

pub(super) fn git_exclude_patterns(existing: &[u8]) -> HashSet<String> {
    let text = String::from_utf8_lossy(existing);
    text.split('\n').map(git_pattern_line).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

fn format_append(existing: &[u8], rule: &str) -> Option<String> {
    let patterns = git_exclude_patterns(existing);
    if patterns.contains(rule) {
        return None;
    }
    let text = String::from_utf8_lossy(existing);
    let separator = if !text.is_empty() && !text.ends_with('\n') { "\n" } else { "" };
    let header = if text.contains("# codenomad") {
        ""
    } else if text.trim().is_empty() {
        "# codenomad\n"
    } else {
        "\n# codenomad\n"
    };
    Some(format!("{separator}{header}{rule}\n"))
}

fn parse_rev_parse(bytes: &[u8]) -> Option<(String, PathBuf)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
    let lines: Vec<&str> = trimmed.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.len() != 2 || lines.iter().any(|l| l.bytes().any(|b| b < 0x20 || b == 0x7f)) {
        return None;
    }
    let (prefix, common_raw) = (lines[0], lines[1]);
    if common_raw.is_empty() {
        return None;
    }
    if !prefix.is_empty() {
        let body = prefix.strip_suffix('/')?;
        if body.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return None;
        }
    }
    Some((prefix.to_owned(), PathBuf::from(common_raw)))
}

struct DropCancel(Arc<AtomicBool>);

impl Drop for DropCancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn verify_exclude_handle(
    info: &cap_std::fs::Dir,
    expected_info_path: &Path,
    file_comp: &OsStr,
    file: &cap_std::fs::File,
) -> bool {
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let _ = expected_info_path;
        let Ok(link_meta) = info.symlink_metadata(file_comp) else {
            return false;
        };
        !link_meta.is_symlink()
            && link_meta.is_file()
            && meta.nlink() == 1
            && link_meta.nlink() == 1
            && link_meta.dev() == meta.dev()
            && link_meta.ino() == meta.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            GetFileInformationByHandle, GetFinalPathNameByHandleW,
        };
        let _ = info;
        let handle = file.as_raw_handle();
        let mut info_rec: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle, &mut info_rec) } == 0 {
            return false;
        }
        if (info_rec.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || (info_rec.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
            || info_rec.nNumberOfLinks != 1
        {
            return false;
        }
        let len = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
        if len == 0 {
            return false;
        }
        let mut buf = vec![0u16; len as usize];
        let written = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), len, 0) };
        if written == 0 || written as usize >= buf.len() {
            return false;
        }
        let actual =
            dunce::simplified(Path::new(&std::ffi::OsString::from_wide(&buf[..written as usize]))).to_path_buf();
        actual == expected_info_path.join(file_comp)
    }
}

fn open_verified_exclude(
    info: &cap_std::fs::Dir,
    expected_info_path: &Path,
    file_comp: &OsStr,
    writable: bool,
) -> Result<cap_std::fs::File, std::io::Error> {
    let mut opts = cap_std::fs::OpenOptions::new();
    opts.read(true);
    if writable {
        opts.append(true).create(true);
    }
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = info.open_with(file_comp, &opts)?;
    if !verify_exclude_handle(info, expected_info_path, file_comp, &file) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "exclude handle verification failed"));
    }
    Ok(file)
}

fn validate_exclude_target(scope: &Path, common_path: &Path) -> Option<PathBuf> {
    if !scope.as_os_str().is_empty() {
        let raw = common_path.to_str()?;
        crate::worktrees::ownership::resolve_media_path_checked(scope, raw)
            .ok()
            .flatten()
            .and_then(|(p, a)| (p == a).then_some(p))
    } else {
        dunce::canonicalize(common_path).ok()
    }
}

fn dir_live_in_scope(scope: &Path, path: &Path) -> bool {
    if !scope.as_os_str().is_empty() {
        path.to_str().is_some_and(|s| {
            crate::worktrees::ownership::resolve_media_path_checked(scope, s)
                .ok()
                .flatten()
                .is_some_and(|(p, a)| p == a && p == path)
        })
    } else {
        std::fs::metadata(path).is_ok_and(|m| m.is_dir())
    }
}

fn append_verified(
    dir: &Path,
    scope: &Path,
    common_canon: &Path,
    rule: &str,
    aborted: &(dyn Fn() -> bool + Send + Sync),
) -> GitExclusion {
    if aborted() || !dir_live_in_scope(scope, dir) || !dir_live_in_scope(scope, common_canon) {
        return GitExclusion::Unavailable;
    }
    let info_comp = OsStr::new("info");
    let file_comp = OsStr::new("exclude");
    let expected_info_path = common_canon.join(info_comp);

    let Ok(common_dir) = cap_std::fs::Dir::open_ambient_dir(common_canon, cap_std::ambient_authority()) else {
        return GitExclusion::Unavailable;
    };
    if aborted() {
        return GitExclusion::Unavailable;
    }
    if let Err(err) = common_dir.create_dir(info_comp)
        && err.kind() != std::io::ErrorKind::AlreadyExists
    {
        return GitExclusion::Unavailable;
    }
    let Ok(info_meta) = common_dir.symlink_metadata(info_comp) else {
        return GitExclusion::Unavailable;
    };
    if !info_meta.is_dir() || info_meta.is_symlink() || std::fs::read_link(&expected_info_path).is_ok() {
        return GitExclusion::Unavailable;
    }
    let Ok(info) = common_dir.open_dir(info_comp) else {
        return GitExclusion::Unavailable;
    };
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if !dir_live_in_scope(scope, &expected_info_path) {
            return GitExclusion::Unavailable;
        }
        let Ok(opened_meta) = info.dir_metadata() else {
            return GitExclusion::Unavailable;
        };
        if opened_meta.dev() != info_meta.dev() || opened_meta.ino() != info_meta.ino() {
            return GitExclusion::Unavailable;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let handle = info.as_raw_handle();
        let len = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
        if len == 0 {
            return GitExclusion::Unavailable;
        }
        let mut buf = vec![0u16; len as usize];
        let written = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), len, 0) };
        if written == 0 || written as usize >= buf.len() {
            return GitExclusion::Unavailable;
        }
        let actual =
            dunce::simplified(Path::new(&std::ffi::OsString::from_wide(&buf[..written as usize]))).to_path_buf();
        if actual != expected_info_path {
            return GitExclusion::Unavailable;
        }
    }

    if aborted() {
        return GitExclusion::Unavailable;
    }
    let (mut file, writable) = match open_verified_exclude(&info, &expected_info_path, file_comp, true) {
        Ok(file) => (file, true),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            let Ok(ro) = open_verified_exclude(&info, &expected_info_path, file_comp, false) else {
                return GitExclusion::Unavailable;
            };
            (ro, false)
        }
        Err(_) => return GitExclusion::Unavailable,
    };

    let mut existing = Vec::new();
    if (&mut file).take(EXCLUDE_READ_LIMIT as u64 + 1).read_to_end(&mut existing).is_err()
        || existing.len() > EXCLUDE_READ_LIMIT
    {
        return GitExclusion::Unavailable;
    }

    let Some(addition) = format_append(&existing, rule) else {
        return GitExclusion::Excluded;
    };
    if !writable || aborted() {
        return GitExclusion::Unavailable;
    }
    if !verify_exclude_handle(&info, &expected_info_path, file_comp, &file) || aborted() {
        return GitExclusion::Unavailable;
    }
    if file.write_all(addition.as_bytes()).is_err() {
        return GitExclusion::Unavailable;
    }
    GitExclusion::Excluded
}

#[cfg(test)]
pub(super) async fn exclude_design_folder(dir: &Path, remaining: Duration) -> GitExclusion {
    exclude_design_folder_cancellable(dir, Path::new(""), Instant::now() + remaining, Arc::new(|| true)).await
}

pub(super) async fn exclude_design_folder_cancellable(
    dir: &Path,
    scope: &Path,
    deadline: Instant,
    still_valid: Arc<dyn Fn() -> bool + Send + Sync>,
) -> GitExclusion {
    let dropped = Arc::new(AtomicBool::new(false));
    let _drop_cancel = DropCancel(Arc::clone(&dropped));
    let budget = deadline.saturating_duration_since(Instant::now()).min(GIT_TIMEOUT);
    if budget.is_zero() || !still_valid() {
        return GitExclusion::Unavailable;
    }
    if !scope.as_os_str().is_empty() {
        let dir_check = dir.to_path_buf();
        let scope_check = scope.to_path_buf();
        let layout_ok = tokio::task::spawn_blocking(move || {
            crate::worktrees::precheck_git_layout_in_scope(&scope_check, &dir_check)
        })
        .await
        .unwrap_or(false);
        if !layout_ok {
            return GitExclusion::Unavailable;
        }
    }
    let git_out = tokio::time::timeout(
        budget,
        git::run_in_scope(
            dir,
            scope,
            &["rev-parse", "--show-prefix", "--path-format=absolute", "--git-common-dir"],
            64 * 1024,
        ),
    )
    .await;
    let Ok(Ok(output)) = git_out else {
        return GitExclusion::Unavailable;
    };
    if !still_valid() || Instant::now() >= deadline {
        return GitExclusion::Unavailable;
    }
    if output.code != 0 {
        let stderr = String::from_utf8_lossy(output.stderr());
        return if is_not_repository(output.code, &stderr) {
            GitExclusion::NotRepository
        } else {
            GitExclusion::Unavailable
        };
    }
    let Some((prefix, common_path)) = parse_rev_parse(&output.bytes) else {
        return GitExclusion::Unavailable;
    };
    let scope_validate = scope.to_path_buf();
    let Some(common_canon) =
        tokio::task::spawn_blocking(move || validate_exclude_target(&scope_validate, &common_path))
            .await
            .ok()
            .flatten()
    else {
        return GitExclusion::Unavailable;
    };
    if !still_valid() || Instant::now() >= deadline {
        return GitExclusion::Unavailable;
    }

    // Acquire per-file serialization asynchronously so cancellation drops the waiter
    // before spawning any blocking write worker.
    let lock = lock_for(&common_canon.join("info").join("exclude"));
    let Ok(file_guard) = tokio::time::timeout_at(deadline, lock.lock_owned()).await else {
        return GitExclusion::Unavailable;
    };
    if !still_valid() || Instant::now() >= deadline {
        return GitExclusion::Unavailable;
    }

    let rule = design_exclude_rule(&prefix);
    let dir_owned = dir.to_path_buf();
    let scope_owned = scope.to_path_buf();
    let dropped_worker = Arc::clone(&dropped);
    let valid_worker = Arc::clone(&still_valid);
    tokio::task::spawn_blocking(move || {
        let _guard = file_guard;
        let aborted = || dropped_worker.load(Ordering::Acquire) || !valid_worker() || Instant::now() >= deadline;
        append_verified(&dir_owned, &scope_owned, &common_canon, &rule, &aborted)
    })
    .await
    .unwrap_or(GitExclusion::Unavailable)
}
