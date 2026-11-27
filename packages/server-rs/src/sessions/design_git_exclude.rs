//! Local `.codenomad/design/` Git exclusion after creating or opening an Images conversation,
//! matching `packages/server/src/workspaces/design-git-exclude.ts` and `worktree-map.ts`.
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use regex::Regex;

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

static EXCLUDE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static NOT_REPO_RE: OnceLock<Regex> = OnceLock::new();

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = path.to_string_lossy().to_lowercase();
    let map = EXCLUDE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
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

fn parse_rev_parse(bytes: &[u8]) -> Option<(String, PathBuf, PathBuf)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
    let lines: Vec<&str> = trimmed.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.len() != 3 || lines.iter().any(|l| l.bytes().any(|b| b < 0x20 || b == 0x7f)) {
        return None;
    }
    let (prefix, common_raw, exclude_raw) = (lines[0], lines[1], lines[2]);
    if common_raw.is_empty() || exclude_raw.is_empty() {
        return None;
    }
    if !prefix.is_empty() {
        let body = prefix.strip_suffix('/')?;
        if body.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return None;
        }
    }
    Some((prefix.to_owned(), PathBuf::from(common_raw), PathBuf::from(exclude_raw)))
}

fn append_verified(dir: &Path, common_path: &Path, exclude_path: &Path, rule: &str) -> GitExclusion {
    if !std::fs::metadata(dir).is_ok_and(|m| m.is_dir()) {
        return GitExclusion::Unavailable;
    }
    let Ok(common_canon) = dunce::canonicalize(common_path) else {
        return GitExclusion::Unavailable;
    };
    let rel = match exclude_path.strip_prefix(common_path).or_else(|_| exclude_path.strip_prefix(&common_canon)) {
        Ok(r) => r.to_path_buf(),
        Err(_) => return GitExclusion::Unavailable,
    };
    let mut comps = rel.components();
    let (Some(Component::Normal(info_comp)), Some(Component::Normal(file_comp)), None) =
        (comps.next(), comps.next(), comps.next())
    else {
        return GitExclusion::Unavailable;
    };
    if info_comp != OsStr::new("info") || file_comp != OsStr::new("exclude") {
        return GitExclusion::Unavailable;
    }

    let lock = lock_for(&common_canon.join(info_comp).join(file_comp));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let Ok(common_dir) = cap_std::fs::Dir::open_ambient_dir(&common_canon, cap_std::ambient_authority()) else {
        return GitExclusion::Unavailable;
    };
    if let Err(err) = common_dir.create_dir(info_comp)
        && err.kind() != std::io::ErrorKind::AlreadyExists
    {
        return GitExclusion::Unavailable;
    }
    let Ok(info_meta) = common_dir.symlink_metadata(info_comp) else {
        return GitExclusion::Unavailable;
    };
    if !info_meta.is_dir() || info_meta.is_symlink() {
        return GitExclusion::Unavailable;
    }
    let Ok(info) = common_dir.open_dir(info_comp) else {
        return GitExclusion::Unavailable;
    };
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let expected_info_path = common_canon.join(info_comp);
        if dunce::canonicalize(&expected_info_path).ok().as_deref() != Some(expected_info_path.as_path()) {
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
        let expected_info_path = common_canon.join(info_comp);
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
    #[cfg(unix)]
    let add_nonblock = |opts: &mut cap_std::fs::OpenOptions| {
        use cap_std::fs::OpenOptionsExt;
        #[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
        const O_NONBLOCK: i32 = 0x0004;
        #[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd")))]
        const O_NONBLOCK: i32 = 0x0800;
        opts.custom_flags(O_NONBLOCK);
    };

    let mut existing = Vec::new();
    match info.symlink_metadata(file_comp) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(m) if m.is_file() && !m.is_symlink() => {
            let mut read_opts = cap_std::fs::OpenOptions::new();
            read_opts.read(true);
            #[cfg(unix)]
            add_nonblock(&mut read_opts);
            let Ok(mut reader) = info.open_with(file_comp, &read_opts) else {
                return GitExclusion::Unavailable;
            };
            if !reader.metadata().is_ok_and(|m| m.is_file()) {
                return GitExclusion::Unavailable;
            }
            if (&mut reader).take(EXCLUDE_READ_LIMIT as u64 + 1).read_to_end(&mut existing).is_err()
                || existing.len() > EXCLUDE_READ_LIMIT
            {
                return GitExclusion::Unavailable;
            }
        }
        _ => return GitExclusion::Unavailable,
    }

    let Some(addition) = format_append(&existing, rule) else {
        return GitExclusion::Excluded;
    };
    let mut append_opts = cap_std::fs::OpenOptions::new();
    append_opts.append(true).create(true);
    #[cfg(unix)]
    add_nonblock(&mut append_opts);
    let Ok(mut writer) = info.open_with(file_comp, &append_opts) else {
        return GitExclusion::Unavailable;
    };
    if !writer.metadata().is_ok_and(|m| m.is_file()) {
        return GitExclusion::Unavailable;
    }
    if writer.write_all(addition.as_bytes()).is_err() {
        return GitExclusion::Unavailable;
    }
    GitExclusion::Excluded
}

pub(super) async fn exclude_design_folder(dir: &Path, remaining: Duration) -> GitExclusion {
    let budget = remaining.min(GIT_TIMEOUT);
    if budget.is_zero() {
        return GitExclusion::Unavailable;
    }
    let git_out = tokio::time::timeout(
        budget,
        git::run(
            dir,
            &["rev-parse", "--show-prefix", "--path-format=absolute", "--git-common-dir", "--git-path", "info/exclude"],
            64 * 1024,
        ),
    )
    .await;
    let Ok(Ok(output)) = git_out else {
        return GitExclusion::Unavailable;
    };
    if output.code != 0 {
        let stderr = String::from_utf8_lossy(output.stderr());
        return if is_not_repository(output.code, &stderr) {
            GitExclusion::NotRepository
        } else {
            GitExclusion::Unavailable
        };
    }
    let Some((prefix, common_path, exclude_path)) = parse_rev_parse(&output.bytes) else {
        return GitExclusion::Unavailable;
    };
    let rule = design_exclude_rule(&prefix);
    let dir_owned = dir.to_path_buf();
    tokio::task::spawn_blocking(move || append_verified(&dir_owned, &common_path, &exclude_path, &rule))
        .await
        .unwrap_or(GitExclusion::Unavailable)
}
