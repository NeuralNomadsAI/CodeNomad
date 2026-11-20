//! `memory/project-identity.ts` with `forge/remote.ts` `parseRepositoryRemoteUrl`:
//! SHA-256 of `remote:<host/path>` (origin, else the first sorted remote) or of
//! `local:<physical shared repository root or folder>`. Host paths only: this backend
//! refuses WSL locations before they reach here.

use super::model::{Code, Result, fail};
use crate::shared::js_trim;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::LazyLock, time::Duration};
use tokio::process::Command;

fn identity(source: &str, value: &str) -> String {
    Sha256::digest(format!("{source}:{value}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// JS `encodeURIComponent`.
pub(super) fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `parseRepositoryRemoteUrl(url)` → `host/path`.
pub fn normalize_remote(url: &str) -> Option<String> {
    static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^(?:https?|ssh|git)://").unwrap());
    static SCP: LazyLock<regex::Regex> = LazyLock::new(|| {
        let s = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
        regex::Regex::new(&format!(
            r"^(?:[^@/{s}]+@)?([^:/{s}]+):([^/\n\r\x{{2028}}\x{{2029}}][^\n\r\x{{2028}}\x{{2029}}]*)$"
        ))
        .unwrap()
    });
    static HOST: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$").unwrap()
    });
    let trimmed = js_trim(url);
    let (host, port, raw) = if SCHEME.is_match(trimmed) {
        let parsed = reqwest::Url::parse(trimmed).ok()?;
        let host = parsed.host_str()?.to_lowercase();
        // `URL.port` drops default ports; identity keeps the written authority.
        let authority = trimmed.split('/').nth(2).unwrap_or_default();
        let authority = authority.rsplit('@').next().unwrap_or_default();
        let explicit = regex::Regex::new(r":([0-9]+)$").unwrap().captures(authority).map(|c| c[1].to_owned());
        let port =
            explicit.map(|p| p.trim_start_matches('0').to_owned()).map(|p| if p.is_empty() { "0".into() } else { p });
        (host, port.unwrap_or_default(), parsed.path().to_owned())
    } else if let Some(c) = SCP.captures(trimmed) {
        let host = c[1].to_owned();
        if host.len() == 1 && host.as_bytes()[0].is_ascii_alphabetic() {
            return None;
        }
        (host.to_lowercase(), String::new(), c[2].to_owned())
    } else {
        return None;
    };
    let bracket = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'));
    let valid_host = match bracket {
        Some(inner) => inner.parse::<std::net::Ipv6Addr>().is_ok(),
        None => HOST.is_match(&host),
    };
    if host.is_empty()
        || !valid_host
        || (!port.is_empty() && !(port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())))
        || raw.is_empty()
    {
        return None;
    }
    let mut segments: Vec<String> =
        raw.trim_matches('/').split('/').map(crate::shared::decode_component).collect::<Option<_>>()?;
    let last = segments.last_mut()?;
    if last.len() >= 4 && last.is_char_boundary(last.len() - 4) && last[last.len() - 4..].eq_ignore_ascii_case(".git") {
        last.truncate(last.len() - 4);
    }
    if segments.iter().any(|s| {
        s.is_empty()
            || s.bytes().all(|b| b == b'.')
            || s.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f || c == '/' || c == '\\')
    }) {
        return None;
    }
    let path = segments.iter().map(|s| encode_component(s)).collect::<Vec<_>>().join("/");
    Some(if port.is_empty() { format!("{host}/{path}") } else { format!("{host}:{port}/{path}") })
}

enum GitRead {
    Ok(String),
    NotRepository,
    Failed,
}

async fn git(directory: &Path, args: &[&str]) -> Result<GitRead> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(directory).args(args);
    super::git::clean(&mut cmd);
    cmd.env("LC_ALL", "C").env("LANGUAGE", "C");
    match super::git::execute(cmd, Duration::from_secs(10)).await {
        // `runWorktreeGit` drops one trailing line break.
        Ok(v) => {
            Ok(GitRead::Ok(v.strip_suffix('\n').map(|s| s.strip_suffix('\r').unwrap_or(s)).unwrap_or(&v).to_owned()))
        }
        Err(super::git::GitError::Missing) => Err(fail(Code::GitUnavailable, "Memory project Git is unavailable")),
        Err(super::git::GitError::Exit(128, stderr))
            if regex::Regex::new(
                r"(?m)^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)",
            )
            .unwrap()
            .is_match(&stderr) =>
        {
            Ok(GitRead::NotRepository)
        }
        Err(_) => Ok(GitRead::Failed),
    }
}

fn local(value: &Path) -> Result<String> {
    let resolved = dunce::canonicalize(value).map_err(|_| fail(Code::Unreadable, "Cannot resolve memory project"))?;
    let text = resolved.to_string_lossy().into_owned();
    if !resolved.is_absolute() || text.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
        return Err(fail(Code::Unreadable, "Invalid memory project path"));
    }
    Ok(identity("local", &if cfg!(windows) { text.to_lowercase() } else { text }))
}

/// `resolveMemoryProjectIdentity({ directory })` → the namespace hash.
pub async fn resolve(directory: &str) -> Result<String> {
    if directory.is_empty()
        || directory.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        || !Path::new(directory).is_absolute()
    {
        return Err(fail(Code::Invalid, "Invalid memory project directory"));
    }
    let dir = Path::new(directory);
    let unreadable = || fail(Code::Unreadable, "Cannot resolve memory project");
    let common = match git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await? {
        GitRead::Ok(v) => v,
        GitRead::NotRepository => return local(dir),
        GitRead::Failed => return Err(unreadable()),
    };
    if !Path::new(&common).is_absolute() || common.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
        return Err(fail(Code::Unreadable, "Invalid memory repository path"));
    }
    let GitRead::Ok(listed) = git(dir, &["remote"]).await? else { return Err(unreadable()) };
    let mut names: Vec<&str> =
        listed.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty()).collect();
    names.sort_by(|a, b| super::rules::js_cmp(a, b));
    let name = if names.contains(&"origin") { Some("origin") } else { names.first().copied() };
    if let Some(name) = name {
        let GitRead::Ok(url) = git(dir, &["remote", "get-url", "--", name]).await? else { return Err(unreadable()) };
        if let Some(normalized) = normalize_remote(&url) {
            return Ok(identity("remote", &normalized));
        }
    }
    // The shared repository, whichever linked checkout is active.
    let common_path = Path::new(&common);
    let base = common.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or_default();
    let root = if base == ".git" { common_path.parent().unwrap_or(common_path) } else { common_path };
    local(root)
}
