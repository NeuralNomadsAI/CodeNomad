//! Plugin package spec validation and identity normalization (`opencode/plugin-source-document.ts`
//! and `opencode/plugin-package-versions-contract.ts`, matching `npm-package-arg` for registry,
//! `npm:` alias, and remote Git specs).

use std::collections::BTreeSet;

pub(super) const PLUGIN_SOURCE_MAX_SPEC_LENGTH: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SpecErrorCode {
    InvalidSpec,
    LocalPath,
    PluginId,
}

impl SpecErrorCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSpec => "invalid-spec",
            Self::LocalPath => "local-path",
            Self::PluginId => "plugin-id",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ParsedSpec {
    Registry { name: String },
    Alias { name: String, target_name: String },
    Git { name: Option<String>, repository: String },
    Local,
    Remote,
}

/// Validates a plugin source spec exactly as OpenCode's `plugin add` does.
pub(super) fn validate_plugin_source_spec(spec: &str) -> Result<(), (SpecErrorCode, &'static str)> {
    if spec.is_empty()
        || spec.len() > PLUGIN_SOURCE_MAX_SPEC_LENGTH
        || spec != crate::shared::js_trim(spec)
        || !spec.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return Err((SpecErrorCode::InvalidSpec, "Plugin package spec is invalid"));
    }
    let lower = spec.to_ascii_lowercase();
    if lower.contains("{env:") || lower.contains("{file:") {
        return Err((SpecErrorCode::InvalidSpec, "Configuration variables are not accepted in a plugin spec"));
    }
    if spec.starts_with('-') || spec.contains('*') || spec.starts_with("opencode.") {
        return Err((SpecErrorCode::PluginId, "Plugin activation selectors are not package specs"));
    }
    if is_local_prefix(spec) {
        return Err((SpecErrorCode::LocalPath, "Local plugin paths are not accepted"));
    }
    match parse_npa(spec) {
        Some(ParsedSpec::Registry { .. }) | Some(ParsedSpec::Alias { .. }) | Some(ParsedSpec::Git { .. }) => Ok(()),
        Some(ParsedSpec::Local) => Err((SpecErrorCode::LocalPath, "Local plugin paths are not accepted")),
        Some(ParsedSpec::Remote) => {
            Err((SpecErrorCode::InvalidSpec, "Only registry and Git plugin specs are accepted"))
        }
        None => Err((SpecErrorCode::InvalidSpec, "Plugin package spec is invalid")),
    }
}

/// Normalized package identity keys (`name:<pkg>`, `git:<repo>`) matching `pluginPackageIdentities`.
pub(super) fn plugin_package_identities(spec: &str) -> Vec<String> {
    let Some(parsed) = parse_npa(spec) else { return Vec::new() };
    let mut keys = BTreeSet::new();
    match parsed {
        ParsedSpec::Registry { name } => {
            keys.insert(format!("name:{}", name.to_ascii_lowercase()));
        }
        ParsedSpec::Alias { name, target_name } => {
            keys.insert(format!("name:{}", name.to_ascii_lowercase()));
            keys.insert(format!("name:{}", target_name.to_ascii_lowercase()));
        }
        ParsedSpec::Git { name, repository } => {
            if let Some(name) = name {
                keys.insert(format!("name:{}", name.to_ascii_lowercase()));
            }
            keys.insert(format!("git:{}", repository.to_ascii_lowercase()));
        }
        ParsedSpec::Local | ParsedSpec::Remote => {}
    }
    keys.into_iter().collect()
}

/// `gitPluginRevision` (`plugin-package-versions-contract.ts`).
pub(super) fn git_plugin_revision<'a>(target: &str, version: Option<&'a str>) -> Option<&'a str> {
    let version = version?;
    if target.encode_utf16().count() > 4096 || !is_hex_revision(version) {
        return None;
    }
    matches!(parse_npa(target), Some(ParsedSpec::Git { .. })).then_some(version)
}

pub(super) fn is_hex_revision(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_local_prefix(spec: &str) -> bool {
    let b = spec.as_bytes();
    if spec.starts_with("./")
        || spec.starts_with(".\\")
        || spec.starts_with("../")
        || spec.starts_with("..\\")
        || spec.starts_with('/')
        || spec.starts_with('\\')
        || spec.starts_with('~')
    {
        return true;
    }
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\') {
        return true;
    }
    let lower = spec.to_ascii_lowercase();
    lower.starts_with("file:") || lower.starts_with("git+file:")
}

fn parse_npa(spec: &str) -> Option<ParsedSpec> {
    if spec.is_empty() || spec.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return None;
    }
    if is_local_prefix(spec) {
        return Some(ParsedSpec::Local);
    }
    if let Some(git) = parse_git_spec(spec, None) {
        return Some(git);
    }
    if is_http_url(spec) {
        return Some(ParsedSpec::Remote);
    }

    // Split optional `name@spec` where scoped names start with `@scope/pkg`.
    let (name_part, spec_part) = split_name_and_spec(spec);
    if !is_valid_npm_name(name_part) {
        return None;
    }
    match spec_part {
        None => Some(ParsedSpec::Registry { name: name_part.to_owned() }),
        Some(raw) => {
            if is_local_prefix(raw) {
                return Some(ParsedSpec::Local);
            }
            if let Some(rest) = raw.strip_prefix("npm:") {
                let sub = parse_npa(rest)?;
                return match sub {
                    ParsedSpec::Registry { name: target_name } => {
                        Some(ParsedSpec::Alias { name: name_part.to_owned(), target_name })
                    }
                    _ => None,
                };
            }
            if let Some(git) = parse_git_spec(raw, Some(name_part.to_owned())) {
                return Some(git);
            }
            if is_http_url(raw) {
                return Some(ParsedSpec::Remote);
            }
            if is_valid_registry_spec(raw) { Some(ParsedSpec::Registry { name: name_part.to_owned() }) } else { None }
        }
    }
}

fn split_name_and_spec(spec: &str) -> (&str, Option<&str>) {
    let search_from = if spec.starts_with('@') {
        match spec.find('/') {
            Some(slash) => slash + 1,
            None => return (spec, None),
        }
    } else {
        0
    };
    match spec[search_from..].find('@') {
        Some(rel) => {
            let at = search_from + rel;
            (&spec[..at], Some(&spec[at + 1..]))
        }
        None => (spec, None),
    }
}

fn is_valid_npm_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 || name != name.trim() {
        return false;
    }
    if let Some(rest) = name.strip_prefix('@') {
        let Some((scope, pkg)) = rest.split_once('/') else { return false };
        !pkg.contains('/') && is_valid_npm_segment(scope) && is_valid_npm_segment(pkg)
    } else {
        !name.contains('/') && is_valid_npm_segment(name)
    }
}

fn is_valid_npm_segment(seg: &str) -> bool {
    if seg.is_empty() || seg.starts_with('.') || seg.starts_with('_') {
        return false;
    }
    seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn is_valid_registry_spec(raw: &str) -> bool {
    if raw.is_empty() {
        return true;
    }
    if is_semver_range(raw) {
        return true;
    }
    // Dist-tag: non-empty, no whitespace, URL-safe (no `/`, `:`, `?`, `#`, `\`, or quotes).
    !raw.bytes().any(|b| b <= 0x20 || b >= 0x7f || matches!(b, b'/' | b'\\' | b':' | b'?' | b'#' | b'"' | b'\''))
}

fn is_semver_range(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.split("||").all(|branch| {
        let branch = branch.trim();
        if branch.is_empty() {
            return false;
        }
        // Handle hyphen ranges `1.0.0 - 2.0.0` or space-separated comparators `>=1 <2`.
        let tokens: Vec<&str> = branch.split(' ').filter(|t| !t.is_empty()).collect();
        if tokens.is_empty() {
            return false;
        }
        tokens.iter().all(|tok| *tok == "-" || is_semver_comparator(tok))
    })
}

fn is_semver_comparator(token: &str) -> bool {
    let rest = token
        .strip_prefix(">=")
        .or_else(|| token.strip_prefix("<="))
        .or_else(|| token.strip_prefix('>'))
        .or_else(|| token.strip_prefix('<'))
        .or_else(|| token.strip_prefix('='))
        .or_else(|| token.strip_prefix('^'))
        .or_else(|| token.strip_prefix('~'))
        .unwrap_or(token);
    let rest = rest.strip_prefix('v').or_else(|| rest.strip_prefix('V')).unwrap_or(rest);
    if rest.is_empty() {
        return false;
    }
    let (core, suffix) = match rest.find(['-', '+']) {
        Some(idx) => (&rest[..idx], Some(&rest[idx..])),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return false;
    }
    if !parts.iter().all(|p| !p.is_empty() && (*p == "x" || *p == "X" || p.bytes().all(|b| b.is_ascii_digit()))) {
        return false;
    }
    match suffix {
        None => true,
        Some(s) => s.len() > 1 && s[1..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'+')),
    }
}

fn is_http_url(spec: &str) -> bool {
    let lower = spec.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn parse_git_spec(raw: &str, name: Option<String>) -> Option<ParsedSpec> {
    if raw.bytes().any(|b| b <= 0x20 || b >= 0x7f) {
        return None;
    }
    let without_hash = raw.split('#').next().unwrap_or(raw);
    let lower = without_hash.to_ascii_lowercase();

    // Local git+file: rejected as Local.
    if lower.starts_with("git+file:") {
        return Some(ParsedSpec::Local);
    }

    // Hosted shortcuts: `github:user/repo`, `gitlab:user/repo`, `bitbucket:user/repo`.
    for (prefix, host_key) in [("github:", "github"), ("gitlab:", "gitlab"), ("bitbucket:", "bitbucket")] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let orig = &without_hash[prefix.len()..];
            let _ = rest;
            let (owner, repo) = split_owner_repo(orig)?;
            return Some(ParsedSpec::Git { name, repository: format!("{host_key}:{owner}/{repo}") });
        }
    }

    // Bare GitHub shorthand: `user/repo` (no `@` prefix, no scheme, exactly two valid segments).
    if !without_hash.starts_with('@')
        && !without_hash.contains(':')
        && !without_hash.contains('\\')
        && let Some((owner, repo)) = split_owner_repo(without_hash)
        && !owner.starts_with('.')
        && !repo.starts_with('.')
    {
        return Some(ParsedSpec::Git { name, repository: format!("github:{owner}/{repo}") });
    }

    // Explicit git transport URLs (`git+https://`, `git+http://`, `git+ssh://`, `git://`, `ssh://`).
    let stripped_git_plus =
        if lower.starts_with("git+https://") || lower.starts_with("git+http://") || lower.starts_with("git+ssh://") {
            Some(&without_hash[4..])
        } else if lower.starts_with("git://") || lower.starts_with("ssh://") {
            Some(without_hash)
        } else {
            None
        };

    if let Some(inner) = stripped_git_plus {
        let repo = normalize_git_url(inner)?;
        return Some(ParsedSpec::Git { name, repository: repo });
    }

    // Plain `https://github.com/user/repo[.git]` (hosted Git URLs without tarball extension).
    if lower.starts_with("https://") || lower.starts_with("http://") {
        if let Some(repo) = parse_hosted_http_git(without_hash) {
            return Some(ParsedSpec::Git { name, repository: repo });
        }
        return None;
    }

    // Scp-like `git@host:owner/repo[.git]`.
    if let Some(repo) = parse_scp_git(without_hash) {
        return Some(ParsedSpec::Git { name, repository: repo });
    }

    None
}

fn split_owner_repo(input: &str) -> Option<(&str, &str)> {
    let trimmed = input.trim_matches('/');
    let (owner, repo) = trimmed.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    let repo = strip_git_suffix(repo);
    if repo.is_empty() || !is_git_segment(owner) || !is_git_segment(repo) {
        return None;
    }
    Some((owner, repo))
}

fn is_git_segment(seg: &str) -> bool {
    !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn strip_git_suffix(s: &str) -> &str {
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".git") { &s[..s.len() - 4] } else { s }
}

fn hosted_key(host: &str) -> Option<&'static str> {
    match host.to_ascii_lowercase().as_str() {
        "github.com" => Some("github"),
        "gitlab.com" => Some("gitlab"),
        "bitbucket.org" => Some("bitbucket"),
        _ => None,
    }
}

fn parse_hosted_http_git(url_str: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url_str).ok()?;
    let host = parsed.host_str()?;
    let key = hosted_key(host)?;
    let path = parsed.path().trim_matches('/');
    let (owner, repo) = split_owner_repo(path)?;
    Some(format!("{key}:{owner}/{repo}"))
}

fn normalize_git_url(url_str: &str) -> Option<String> {
    if let Ok(parsed) = reqwest::Url::parse(url_str)
        && let Some(host) = parsed.host_str()
    {
        let path = parsed.path().trim_end_matches('/');
        let path = strip_git_suffix(path);
        if path.is_empty() || path == "/" {
            return None;
        }
        if let Some(key) = hosted_key(host)
            && let Some((owner, repo)) = split_owner_repo(path)
        {
            return Some(format!("{key}:{owner}/{repo}"));
        }
        return Some(format!("{}{}", host.to_ascii_lowercase(), path));
    }
    // `git+ssh://git@example.com:a/b.git` (scp-like path after `ssh://` fails standard URL port parsing).
    let after_scheme = url_str.split_once("://").map(|(_, rest)| rest).unwrap_or(url_str);
    parse_scp_git(after_scheme)
}

fn parse_scp_git(raw: &str) -> Option<String> {
    let without_user = raw.rsplit_once('@').map_or(raw, |(_, rest)| rest);
    let (host, path) = without_user.split_once(':')?;
    if host.is_empty()
        || path.is_empty()
        || host.contains('/')
        || !host.contains('.')
        || !host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
    {
        return None;
    }
    let clean_path = strip_git_suffix(path.trim_start_matches('/').trim_end_matches('/'));
    if clean_path.is_empty() {
        return None;
    }
    if let Some(key) = hosted_key(host)
        && let Some((owner, repo)) = split_owner_repo(clean_path)
    {
        return Some(format!("{key}:{owner}/{repo}"));
    }
    Some(format!("{}/{}", host.to_ascii_lowercase(), clean_path))
}
