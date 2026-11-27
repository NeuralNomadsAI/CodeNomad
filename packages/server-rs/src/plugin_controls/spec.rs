//! Plugin package spec validation and identity normalization (`opencode/plugin-source-document.ts`,
//! `opencode/plugin-package-versions-contract.ts`, `opencode/integrations/recognition.ts`),
//! matching `npm-package-arg` 13.0.2 + `validate-npm-package-name` + `hosted-git-info`.

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
    Registry { name: Option<String> },
    Alias { name: Option<String>, target_name: String },
    Git { name: Option<String>, repository: String, is_file: bool },
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
        Some(ParsedSpec::Registry { .. }) | Some(ParsedSpec::Alias { .. }) => Ok(()),
        Some(ParsedSpec::Git { is_file: true, .. }) | Some(ParsedSpec::Local) => {
            Err((SpecErrorCode::LocalPath, "Local plugin paths are not accepted"))
        }
        Some(ParsedSpec::Git { is_file: false, .. }) => Ok(()),
        Some(ParsedSpec::Remote) => {
            Err((SpecErrorCode::InvalidSpec, "Only registry and Git plugin specs are accepted"))
        }
        None => Err((SpecErrorCode::InvalidSpec, "Plugin package spec is invalid")),
    }
}

/// Registry package name for integration catalog recognition (`registryPackageName` in `recognition.ts`).
pub(crate) fn registry_package_name(spec: &str) -> Option<String> {
    match parse_npa(spec)? {
        ParsedSpec::Alias { target_name, .. } => Some(target_name.to_ascii_lowercase()),
        ParsedSpec::Registry { name: Some(name) } => Some(name.to_ascii_lowercase()),
        _ => None,
    }
}

/// Normalized package identity keys (`name:<pkg>`, `git:<repo>`) matching `pluginPackageIdentities`.
pub(super) fn plugin_package_identities(spec: &str) -> Vec<String> {
    let Some(parsed) = parse_npa(spec) else { return Vec::new() };
    let mut keys = BTreeSet::new();
    match parsed {
        ParsedSpec::Registry { name } => {
            if let Some(name) = name {
                keys.insert(format!("name:{}", name.to_ascii_lowercase()));
            }
        }
        ParsedSpec::Alias { name, target_name } => {
            if let Some(name) = name {
                keys.insert(format!("name:{}", name.to_ascii_lowercase()));
            }
            keys.insert(format!("name:{}", target_name.to_ascii_lowercase()));
        }
        ParsedSpec::Git { name, repository, .. } => {
            if let Some(name) = name {
                keys.insert(format!("name:{}", name.to_ascii_lowercase()));
            }
            if !repository.is_empty() {
                keys.insert(format!("git:{}", repository.to_ascii_lowercase()));
            }
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
    starts_with_ignore_ascii_case(spec, "file:") || starts_with_ignore_ascii_case(spec, "git+file:")
}

fn starts_with_ignore_ascii_case(s: &str, prefix: &str) -> bool {
    s.as_bytes().get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn ends_with_ignore_ascii_case(s: &str, suffix: &str) -> bool {
    let n = s.len();
    let m = suffix.len();
    n >= m && s.as_bytes()[n - m..].eq_ignore_ascii_case(suffix.as_bytes())
}

fn is_file_type(s: &str) -> bool {
    ends_with_ignore_ascii_case(s, ".tgz")
        || ends_with_ignore_ascii_case(s, ".tar.gz")
        || ends_with_ignore_ascii_case(s, ".tar")
}

fn has_slashes(s: &str) -> bool {
    s.contains('/') || (cfg!(windows) && s.contains('\\'))
}

fn is_url_scheme(s: &str) -> bool {
    let rest = if starts_with_ignore_ascii_case(s, "git+") { &s[4..] } else { s };
    let Some(colon) = rest.find(':') else { return false };
    colon > 0 && rest.as_bytes()[..colon].iter().all(u8::is_ascii_alphabetic)
}

fn is_git_scp(s: &str) -> bool {
    let Some((user, after_at)) = s.split_once('@') else { return false };
    if user.is_empty() {
        return false;
    }
    let Some((host, path)) = after_at.split_once(':') else { return false };
    !host.is_empty() && !path.is_empty() && host.contains('.') && !host.contains(':')
}

fn is_file_spec(spec: &str) -> bool {
    if spec.is_empty() {
        return false;
    }
    if starts_with_ignore_ascii_case(spec, "file:") {
        return true;
    }
    let b = spec.as_bytes();
    if spec.starts_with('.') || spec.starts_with("~/") || spec.starts_with('/') {
        return true;
    }
    if cfg!(windows) && spec.starts_with('\\') {
        return true;
    }
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn is_alias_spec(spec: &str) -> bool {
    starts_with_ignore_ascii_case(spec, "npm:")
}

/// Port of `npa(arg)` (`npm-package-arg` 13.0.2 `lib/npa.js:23-114`).
fn parse_npa(arg: &str) -> Option<ParsedSpec> {
    parse_npa_depth(arg, 0)
}

fn parse_npa_depth(arg: &str, depth: u8) -> Option<ParsedSpec> {
    if arg.is_empty() || depth > 2 {
        return None;
    }
    let skip = arg.chars().next().map_or(0, char::len_utf8);
    let name_ends_at = arg[skip..].find('@').map(|i| i + skip);
    let name_part = name_ends_at.map_or(arg, |at| &arg[..at]);

    let (name, spec_owned): (Option<&str>, String) = if is_url_scheme(arg) {
        (None, arg.to_owned())
    } else if is_git_scp(arg) {
        (None, format!("git+ssh://{arg}"))
    } else if !name_part.starts_with('@') && (has_slashes(name_part) || is_file_type(name_part)) {
        (None, arg.to_owned())
    } else if let Some(at) = name_ends_at {
        let rest = &arg[at + 1..];
        (Some(name_part), if rest.is_empty() { "*".to_owned() } else { rest.to_owned() })
    } else if validate_package_name(arg) {
        (Some(arg), "*".to_owned())
    } else {
        (None, arg.to_owned())
    };

    resolve_npa(name, &spec_owned, depth)
}

fn resolve_npa(name: Option<&str>, spec: &str, depth: u8) -> Option<ParsedSpec> {
    let validated_name = match name {
        Some(n) => {
            if !validate_package_name(n) {
                return None;
            }
            Some(n.to_owned())
        }
        None => None,
    };

    if is_file_spec(spec) {
        return Some(ParsedSpec::Local);
    }
    if is_alias_spec(spec) {
        if depth > 0 {
            return None;
        }
        let sub = parse_npa_depth(&spec[4..], depth + 1)?;
        return match sub {
            ParsedSpec::Registry { name: Some(target_name) } => {
                Some(ParsedSpec::Alias { name: validated_name, target_name })
            }
            _ => None,
        };
    }

    if let Some((repository, committish)) = hosted_git_from_url(spec) {
        if !validate_git_committish(&committish) {
            return None;
        }
        return Some(ParsedSpec::Git { name: validated_name, repository, is_file: false });
    }

    if !spec.is_empty() && is_url_scheme(spec) {
        return from_url(validated_name, spec);
    }

    if !spec.is_empty() && (has_slashes(spec) || is_file_type(spec)) {
        return Some(ParsedSpec::Local);
    }

    from_registry(validated_name, spec)
}

/// Port of `setGitAttrs` (`npm-package-arg/lib/npa.js:212-253`).
fn validate_git_committish(committish: &str) -> bool {
    if committish.is_empty() {
        return true;
    }
    let mut has_committish = false;
    let mut has_range = false;
    let mut has_subdir = false;
    for part in committish.split("::") {
        if !part.contains(':') {
            if has_range || has_committish {
                return false;
            }
            has_committish = true;
            continue;
        }
        let Some((key, value)) = part.split_once(':') else { return false };
        match key {
            "semver" => {
                if has_committish || has_range || decode_uri_component_strict(value).is_none() {
                    return false;
                }
                has_range = true;
            }
            "path" => {
                if has_subdir {
                    return false;
                }
                has_subdir = true;
            }
            _ => {}
        }
    }
    true
}

/// Exact ECMAScript `decodeURIComponent` validation (rejects invalid `%` escapes or broken UTF-8).
fn decode_uri_component_strict(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_nibble(bytes[i + 1])?;
            let lo = hex_nibble(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Exact ECMAScript `encodeURIComponent(s) === s`.
fn is_uri_component_unencoded(s: &str) -> bool {
    s.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
    })
}

/// Port of `validate-npm-package-name` `validForOldPackages`.
fn validate_package_name(name: &str) -> bool {
    if name.is_empty()
        || name.starts_with('.')
        || name.starts_with('-')
        || name.starts_with('_')
        || name != crate::shared::js_trim(name)
        || name.eq_ignore_ascii_case("node_modules")
        || name.eq_ignore_ascii_case("favicon.ico")
    {
        return false;
    }
    if is_uri_component_unencoded(name) {
        return true;
    }
    if let Some(rest) = name.strip_prefix('@')
        && let Some((scope, pkg)) = rest.split_once('/')
        && !scope.is_empty()
        && !pkg.is_empty()
        && !pkg.contains('/')
        && !pkg.starts_with('.')
        && is_uri_component_unencoded(scope)
        && is_uri_component_unencoded(pkg)
    {
        return true;
    }
    false
}

/// Port of `fromRegistry` (`npm-package-arg/lib/npa.js:454-474`).
fn from_registry(name: Option<String>, raw_spec: &str) -> Option<ParsedSpec> {
    let spec = crate::shared::js_trim(raw_spec);
    if is_valid_semver_version(spec) || is_valid_semver_range(spec) || is_uri_component_unencoded(spec) {
        Some(ParsedSpec::Registry { name })
    } else {
        None
    }
}

fn is_valid_build_meta(build: &str) -> bool {
    !build.is_empty()
        && build.split('.').all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn is_valid_semver_version(spec: &str) -> bool {
    // `node-semver` `LOOSEPLAIN`: `[v=\s]*` (lowercase `v` and `=` only, never uppercase `V`).
    let s = spec.trim_start_matches(['v', '=']);
    let core = match s.split_once('+') {
        Some((c, build)) => {
            if !is_valid_build_meta(build) {
                return false;
            }
            c
        }
        None => s,
    };
    let (nums, pre) = core.split_once('-').unwrap_or((core, ""));
    let parts: Vec<&str> = nums.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    if core.contains('-') {
        if pre.is_empty() {
            return false;
        }
        for id in pre.split('.') {
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return false;
            }
        }
    }
    true
}

fn is_valid_semver_range(spec: &str) -> bool {
    let spec = crate::shared::js_trim(spec);
    if spec.is_empty() || spec == "*" {
        return true;
    }
    // `node-semver` loose mode splits on `||`, filters out invalid comparators within each branch,
    // and succeeds as long as at least one branch produces a non-empty comparator set (an empty
    // branch parses as `*`).
    spec.split("||").any(|raw_branch| {
        let branch = crate::shared::js_trim(raw_branch);
        if branch.is_empty() {
            return true;
        }
        let tokens: Vec<&str> = branch.split_whitespace().collect();
        let mut valid_any = false;
        let mut i = 0;
        while i < tokens.len() {
            let tok = tokens[i];
            if matches!(tok, ">" | ">=" | "<" | "<=" | "=" | "^" | "~" | "~>") {
                if i + 1 < tokens.len() && is_partial_version(tokens[i + 1]) {
                    valid_any = true;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if is_comparator(tok) {
                valid_any = true;
            }
            i += 1;
        }
        valid_any
    })
}

fn is_comparator(tok: &str) -> bool {
    if matches!(tok, "*" | "x" | "X") {
        return true;
    }
    let rest = tok
        .strip_prefix(">=")
        .or_else(|| tok.strip_prefix("<="))
        .or_else(|| tok.strip_prefix("~>"))
        .or_else(|| tok.strip_prefix('>'))
        .or_else(|| tok.strip_prefix('<'))
        .or_else(|| tok.strip_prefix('='))
        .or_else(|| tok.strip_prefix('^'))
        .or_else(|| tok.strip_prefix('~'))
        .unwrap_or(tok);
    is_partial_version(rest)
}

fn is_partial_version(s: &str) -> bool {
    // `node-semver` `XRANGEPLAINLOOSE`: `[v=\s]*` (lowercase `v` and `=` only, never uppercase `V`).
    let s = s.trim_start_matches(['v', '=']);
    let core = match s.split_once('+') {
        Some((c, build)) => {
            if !is_valid_build_meta(build) {
                return false;
            }
            c
        }
        None => s,
    };
    let (nums, pre) = core.split_once('-').unwrap_or((core, ""));
    let parts: Vec<&str> = nums.split('.').collect();
    if !(1..=3).contains(&parts.len()) {
        return false;
    }
    let mut saw_wild = false;
    for part in parts {
        if matches!(part, "*" | "x" | "X") {
            saw_wild = true;
        } else if saw_wild || part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    if core.contains('-') {
        if pre.is_empty() || saw_wild {
            return false;
        }
        for id in pre.split('.') {
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return false;
            }
        }
    }
    true
}

/// Port of `hosted-git-info` `fromUrl` returning `(shortcut_without_committish, committish)`.
fn hosted_git_from_url(spec: &str) -> Option<(String, String)> {
    if spec.is_empty() {
        return None;
    }
    let candidate = if is_github_shorthand(spec) { format!("github:{spec}") } else { correct_hosted_protocol(spec) };
    let (proto, after_proto) = candidate.split_once(':')?;
    let proto_lower = proto.to_ascii_lowercase();
    let proto_with_colon = format!("{proto_lower}:");

    // 1. Shortcut form: `github:user/repo#ref`, `gitlab:...`, `bitbucket:...`, `gist:...`, `sourcehut:...`
    if matches!(proto_lower.as_str(), "github" | "gitlab" | "bitbucket" | "gist" | "sourcehut") {
        let (path_and_auth, raw_hash) = after_proto.split_once('#').unwrap_or((after_proto, ""));
        // `new URL("github:foo/bar")` leaves `pathname = "foo/bar"` unless `//` follows `:` (rejected/host).
        if path_and_auth.starts_with("//") {
            return None;
        }
        let mut pathname = path_and_auth.strip_prefix('/').unwrap_or(path_and_auth);
        if let Some((_, rest)) = pathname.split_once('@') {
            pathname = rest;
        }
        let (user, mut project) = match pathname.rsplit_once('/') {
            Some((u, p)) => {
                let u_dec = decode_uri_component_strict(u)?;
                let p_dec = decode_uri_component_strict(p)?;
                (if u_dec.is_empty() { None } else { Some(u_dec) }, p_dec)
            }
            None => (None, decode_uri_component_strict(pathname)?),
        };
        if ends_with_ignore_ascii_case(&project, ".git") {
            project.truncate(project.len() - 4);
        }
        if project.is_empty() || (proto_lower != "gist" && user.is_none()) {
            return None;
        }
        let committish = decode_uri_component_strict(raw_hash)?;
        let shortcut = if proto_lower == "gist" {
            // `hosted-git-info` `hosts.gist.shortcuttemplate` omits owner: `gist:<project>`.
            format!("gist:{project}")
        } else {
            match user {
                Some(u) => format!("{proto_lower}:{u}/{project}"),
                None => format!("{proto_lower}:{project}"),
            }
        };
        return Some((shortcut, committish));
    }

    // 2. Domain URL form (including scp-style colon normalized to `/`).
    let normalized = correct_scp_url(&candidate);
    let parsed = reqwest::Url::parse(&normalized).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let bare_host = host.strip_prefix("www.").unwrap_or(&host);
    let host_key = match bare_host {
        "github.com" => "github",
        "gitlab.com" => "gitlab",
        "bitbucket.org" => "bitbucket",
        "gist.github.com" => "gist",
        "git.sr.ht" => "sourcehut",
        _ => return None,
    };
    let allowed = match host_key {
        "github" => {
            matches!(proto_with_colon.as_str(), "git:" | "http:" | "git+ssh:" | "git+https:" | "ssh:" | "https:")
        }
        "gitlab" | "bitbucket" => matches!(proto_with_colon.as_str(), "git+ssh:" | "git+https:" | "ssh:" | "https:"),
        "gist" => matches!(proto_with_colon.as_str(), "git:" | "git+ssh:" | "git+https:" | "ssh:" | "https:"),
        "sourcehut" => matches!(proto_with_colon.as_str(), "git+ssh:" | "https:"),
        _ => false,
    };
    if !allowed {
        return None;
    }

    let path = parsed.path().strip_prefix('/').unwrap_or(parsed.path());
    let raw_hash = parsed.fragment().unwrap_or("");
    let (user_raw, mut project_raw, committish_raw): (Option<String>, String, String) = match host_key {
        "github" => {
            let mut segs = path.splitn(4, '/');
            let user = segs.next().unwrap_or("");
            let project = segs.next().unwrap_or("");
            let kind = segs.next();
            let tree_ref = segs.next().unwrap_or("");
            if let Some(k) = kind
                && !k.is_empty()
                && k != "tree"
            {
                return None;
            }
            let comm = if kind.is_some_and(|k| !k.is_empty()) { tree_ref } else { raw_hash };
            (Some(user.to_owned()), project.to_owned(), comm.to_owned())
        }
        "bitbucket" => {
            let mut segs = path.splitn(4, '/');
            let user = segs.next().unwrap_or("");
            let project = segs.next().unwrap_or("");
            let aux = segs.next();
            if aux == Some("get") {
                return None;
            }
            (Some(user.to_owned()), project.to_owned(), raw_hash.to_owned())
        }
        "gitlab" => {
            if path.contains("/-/") || path.contains("/archive.tar.gz") {
                return None;
            }
            let (user, project) = path.rsplit_once('/')?;
            (Some(user.to_owned()), project.to_owned(), raw_hash.to_owned())
        }
        "gist" => {
            let mut segs = path.splitn(4, '/');
            let first = segs.next().unwrap_or("");
            let second = segs.next();
            let aux = segs.next();
            if aux == Some("raw") {
                return None;
            }
            match second.filter(|s| !s.is_empty()) {
                Some(p) => (Some(first.to_owned()), p.to_owned(), raw_hash.to_owned()),
                None if !first.is_empty() => (None, first.to_owned(), raw_hash.to_owned()),
                None => return None,
            }
        }
        "sourcehut" => {
            let mut segs = path.splitn(4, '/');
            let user = segs.next().unwrap_or("");
            let project = segs.next().unwrap_or("");
            let aux = segs.next();
            if aux.is_some_and(|a| !a.is_empty() && a != "tree") {
                return None;
            }
            (Some(user.to_owned()), project.to_owned(), raw_hash.to_owned())
        }
        _ => return None,
    };

    if ends_with_ignore_ascii_case(&project_raw, ".git") {
        project_raw.truncate(project_raw.len() - 4);
    }
    let project = decode_uri_component_strict(&project_raw)?;
    let user = match user_raw {
        Some(u) if !u.is_empty() => Some(decode_uri_component_strict(&u)?),
        Some(_) => return None,
        None => None,
    };
    if project.is_empty() {
        return None;
    }
    let committish = decode_uri_component_strict(&committish_raw)?;
    let shortcut = if host_key == "gist" {
        format!("gist:{project}")
    } else {
        match user {
            Some(u) => format!("{host_key}:{u}/{project}"),
            None => format!("{host_key}:{project}"),
        }
    };
    Some((shortcut, committish))
}

fn is_github_shorthand(arg: &str) -> bool {
    let first_hash = arg.find('#');
    let first_slash = arg.find('/');
    let second_slash = first_slash.and_then(|s| arg[s + 1..].find('/').map(|j| s + 1 + j));
    let first_colon = arg.find(':');
    let first_space = arg.find(char::is_whitespace);
    let first_at = arg.find('@');

    let space_only_after_hash = first_space.is_none_or(|s| first_hash.is_some_and(|h| s > h));
    let at_only_after_hash = first_at.is_none_or(|a| first_hash.is_some_and(|h| a > h));
    let colon_only_after_hash = first_colon.is_none_or(|c| first_hash.is_some_and(|h| c > h));
    let second_slash_only_after_hash = second_slash.is_none_or(|s| first_hash.is_some_and(|h| s > h));
    let has_slash = first_slash.is_some_and(|s| s > 0);
    let does_not_end_with_slash = match first_hash {
        Some(h) => h > 0 && arg.as_bytes()[h - 1] != b'/',
        None => !arg.ends_with('/'),
    };
    let does_not_start_with_dot = !arg.starts_with('.');

    space_only_after_hash
        && has_slash
        && does_not_end_with_slash
        && does_not_start_with_dot
        && at_only_after_hash
        && colon_only_after_hash
        && second_slash_only_after_hash
}

fn correct_hosted_protocol(arg: &str) -> String {
    let Some(first_colon) = arg.find(':') else { return arg.to_owned() };
    let proto = &arg[..=first_colon];
    if matches!(
        proto.to_ascii_lowercase().as_str(),
        "github:"
            | "gitlab:"
            | "bitbucket:"
            | "gist:"
            | "sourcehut:"
            | "http:"
            | "https:"
            | "git:"
            | "git+ssh:"
            | "git+https:"
            | "ssh:"
    ) {
        return arg.to_owned();
    }
    if let Some(first_at) = arg.find('@') {
        if first_at > first_colon {
            return format!("git+ssh://{arg}");
        }
        return arg.to_owned();
    }
    if arg[first_colon + 1..].starts_with("//") {
        return arg.to_owned();
    }
    format!("{}//{}", &arg[..=first_colon], &arg[first_colon + 1..])
}

fn correct_scp_url(giturl: &str) -> String {
    let prefix = giturl.find('#').map_or(giturl, |h| &giturl[..h]);
    let suffix = giturl.find('#').map_or("", |h| &giturl[h..]);
    let first_at = prefix.find('@');
    let last_colon = prefix.rfind(':');
    if let Some(lc) = last_colon
        && first_at.is_none_or(|fa| lc > fa)
    {
        let after = &prefix[lc + 1..];
        let is_port = after.starts_with("//")
            || after.split('/').next().is_some_and(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()));
        if !is_port {
            return format!("{}/{}{}", &prefix[..lc], after, suffix);
        }
    }
    giturl.to_owned()
}

/// Port of `fromURL` (`npm-package-arg/lib/npa.js:372-430`).
fn from_url(name: Option<String>, raw_spec: &str) -> Option<ParsedSpec> {
    if starts_with_ignore_ascii_case(raw_spec, "git+ssh://") {
        let rest = &raw_spec[10..];
        let (target, hash) = rest.split_once('#').unwrap_or((rest, ""));
        if let Some((host_part, path_part)) = target.split_once(':')
            && !host_part.is_empty()
            && !path_part.is_empty()
            && !is_port_number_suffix(path_part)
        {
            if !validate_git_committish(hash) {
                return None;
            }
            let repo = git_repository_identity(target)?;
            return Some(ParsedSpec::Git { name, repository: repo, is_file: false });
        }
    }

    let normalized = if starts_with_ignore_ascii_case(raw_spec, "git+file://") {
        raw_spec.replace('\\', "/")
    } else {
        raw_spec.to_owned()
    };
    let mut parsed = reqwest::Url::parse(&normalized).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    match scheme.as_str() {
        "git" | "git+http" | "git+https" | "git+rsync" | "git+ftp" | "git+file" | "git+ssh" => {
            let hash = parsed.fragment().unwrap_or("");
            if !validate_git_committish(hash) {
                return None;
            }
            let is_file = scheme == "git+file";
            parsed.set_fragment(None);
            let mut fetch_spec = parsed.to_string();
            if starts_with_ignore_ascii_case(&fetch_spec, "git+") {
                fetch_spec = fetch_spec[4..].to_owned();
            }
            let repo = git_repository_identity(&fetch_spec).unwrap_or_default();
            Some(ParsedSpec::Git { name, repository: repo, is_file })
        }
        "http" | "https" => Some(ParsedSpec::Remote),
        _ => None,
    }
}

fn is_port_number_suffix(after_colon: &str) -> bool {
    let digits = after_colon.split('/').next().unwrap_or("");
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Port of `gitRepositoryIdentity` (`plugin-source-document.ts:95-106`).
fn git_repository_identity(fetch_spec: &str) -> Option<String> {
    if fetch_spec.is_empty() {
        return None;
    }
    let spec = fetch_spec.split('#').next().unwrap_or(fetch_spec);
    if let Ok(url) = reqwest::Url::parse(spec)
        && let Some(host) = url.host_str()
    {
        let path = url.path().trim_end_matches('/');
        let path = strip_git_suffix(path);
        return Some(format!("{host}{path}"));
    }
    let without_user = spec.rsplit_once('@').map_or(spec, |(_, rest)| rest);
    if let Some((host, path)) = without_user.split_once(':')
        && !host.is_empty()
        && !host.contains('/')
    {
        let clean = strip_git_suffix(path.trim_start_matches('/'));
        return Some(format!("{host}/{clean}"));
    }
    Some(strip_git_suffix(spec).to_owned())
}

fn strip_git_suffix(s: &str) -> &str {
    if ends_with_ignore_ascii_case(s, ".git") { &s[..s.len() - 4] } else { s }
}
