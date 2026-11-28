//! Presentation and aggregation helpers for recent projects on the New tab home view.
//! Mirrors `packages/ui/src/lib/recent-folder-display.ts`.
use crate::{State, strings};
use codenomad_client::same_server_path;
use rune_theme_codenomad::catalogue;
use std::borrow::Cow;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RecentEntry {
    pub path: String,
    pub display_name: String,
    pub display_path: String,
    pub open_tab_key: Option<String>,
    pub project_id: Option<String>,
    pub open_elsewhere: bool,
    pub temporary: bool,
    pub last_accessed: Option<u64>,
}

fn looks_like_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        return true;
    }
    if let Some(rest) = value.strip_prefix("\\\\") {
        let mut parts = rest.split('\\');
        return parts.next().is_some_and(|s| !s.is_empty())
            && parts.next().is_some_and(|s| !s.is_empty());
    }
    false
}

pub(crate) fn split_folder_path(raw: &str) -> (Cow<'_, str>, &str) {
    if raw.is_empty() {
        return (Cow::Borrowed(""), "");
    }
    let is_windows = looks_like_windows_path(raw);
    let trimmed = raw.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return (Cow::Borrowed(raw), "");
    }
    if is_windows
        && trimmed.len() == 2
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && trimmed.as_bytes()[1] == b':'
    {
        // Normalize Windows drive roots like "C:/" or "C:\" to "C:\".
        return (Cow::Owned(format!("{trimmed}\\")), "");
    }
    let last_slash = trimmed.rfind('/');
    let last_backslash = is_windows.then(|| trimmed.rfind('\\')).flatten();
    let last_sep = match (last_slash, last_backslash) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    let Some(sep) = last_sep else {
        return (Cow::Borrowed(trimmed), "");
    };
    let base = &trimmed[sep + 1..];
    let dir = &trimmed[..sep];
    (
        Cow::Borrowed(if base.is_empty() { trimmed } else { base }),
        dir,
    )
}

pub(crate) fn project_display_name(path: &str, custom_name: Option<&str>) -> String {
    if let Some(name) = custom_name.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_owned();
    }
    split_folder_path(path).0.into_owned()
}

/// Abbreviates the user's home directory to `~` on macOS, Linux and Windows.
pub(crate) fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("/Users/") {
        return abbreviate_home(path, rest, '/');
    }
    if let Some(rest) = path.strip_prefix("/home/") {
        return abbreviate_home(path, rest, '/');
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 9 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        if let Some(rest) = path[2..].strip_prefix("\\Users\\") {
            return abbreviate_home(path, rest, '\\');
        }
        if let Some(rest) = path[2..].strip_prefix("/Users/") {
            return abbreviate_home(path, rest, '/');
        }
    }
    path.to_owned()
}

fn abbreviate_home(original: &str, after_users: &str, sep: char) -> String {
    if after_users.is_empty() || after_users.starts_with(sep) {
        return original.to_owned();
    }
    match after_users.find(sep) {
        Some(index) => format!("~{}", &after_users[index..]),
        None => "~".into(),
    }
}

fn strip_windows_extended_prefix(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
    {
        if rest.len() >= 4
            && rest[..3].eq_ignore_ascii_case("UNC")
            && matches!(rest.as_bytes()[3], b'\\' | b'/')
        {
            return Cow::Owned(format!(r"\\{}", &rest[4..]));
        }
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return Cow::Borrowed(rest);
        }
    }
    Cow::Borrowed(path)
}

fn push_lexical_segments<'a>(
    segments: impl Iterator<Item = &'a str>,
    lowercase: bool,
    out: &mut Vec<String>,
) {
    for part in segments {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(if lowercase {
            part.to_lowercase()
        } else {
            part.to_owned()
        });
    }
}

/// Canonical lexical key for deduplicating recent project paths regardless of slash style,
/// trailing separators, Windows extended prefixes, dot segments, or drive/case spelling.
pub(crate) fn canonical_recent_path_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let stripped = strip_windows_extended_prefix(trimmed);
    let s = stripped.as_ref();
    let bytes = s.as_bytes();

    // Windows drive path (e.g. "D:\CodeNomad", "d:/codenomad/", "D:")
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || matches!(bytes[2], b'\\' | b'/'))
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = if bytes.len() > 2 { &s[3..] } else { "" };
        let mut parts = Vec::new();
        push_lexical_segments(rest.split(['/', '\\']), true, &mut parts);
        return if parts.is_empty() {
            format!("{drive}:/")
        } else {
            format!("{drive}:/{}", parts.join("/"))
        };
    }

    // Windows UNC path (e.g. "\\Server\Share\Project")
    if let Some(rest) = s.strip_prefix(r"\\") {
        let mut raw_parts = rest.split(['/', '\\']).filter(|p| !p.is_empty());
        if let (Some(server), Some(share)) = (raw_parts.next(), raw_parts.next()) {
            let mut parts = Vec::new();
            push_lexical_segments(raw_parts, true, &mut parts);
            let head = format!("//{}/{}", server.to_lowercase(), share.to_lowercase());
            return if parts.is_empty() {
                head
            } else {
                format!("{head}/{}", parts.join("/"))
            };
        }
    }

    // POSIX absolute path (preserves case and literal backslashes, normalizes slashes and dot segments).
    if let Some(after_slash) = s.strip_prefix('/') {
        let double_slash_root = after_slash.starts_with('/') && !after_slash.starts_with("//");
        let rest = if double_slash_root {
            &after_slash[1..]
        } else {
            after_slash
        };
        let mut parts = Vec::new();
        push_lexical_segments(rest.split('/'), false, &mut parts);
        let prefix = if double_slash_root { "//" } else { "/" };
        return if parts.is_empty() {
            prefix.to_owned()
        } else {
            format!("{prefix}{}", parts.join("/"))
        };
    }

    s.trim_end_matches(['/', '\\']).to_owned()
}

pub(crate) fn same_recent_path(left: &str, right: &str) -> bool {
    if same_server_path(left, right) {
        return true;
    }
    let a = canonical_recent_path_key(left);
    let b = canonical_recent_path_key(right);
    !a.is_empty() && a == b
}

fn path_hash(path: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    let key = canonical_recent_path_key(path);
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Stable action-menu key derived from a folder path so list reordering never retargets another row.
pub(crate) fn path_menu_key(path: &str) -> String {
    format!("recent-actions-{:016x}", path_hash(path))
}

/// Stable primary row key for recent folders without a server project id.
pub(crate) fn recent_row_key(path: &str) -> String {
    format!("recent-project-{:016x}", path_hash(path))
}

/// Stable OPEN-badge button key derived from a folder path.
pub(crate) fn open_badge_key(path: &str) -> String {
    format!("recent-open-{:016x}", path_hash(path))
}

pub(crate) fn format_relative_time(timestamp_ms: u64, now_ms: u64) -> String {
    let elapsed_secs = now_ms.saturating_sub(timestamp_ms) / 1000;
    let minutes = elapsed_secs / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    let locale = strings::locale();
    if days > 0 {
        let count = days.to_string();
        catalogue::format(locale, "time.relative.daysAgoShort", &[("count", &count)])
    } else if hours > 0 {
        let count = hours.to_string();
        catalogue::format(locale, "time.relative.hoursAgoShort", &[("count", &count)])
    } else if minutes > 0 {
        let count = minutes.to_string();
        catalogue::format(
            locale,
            "time.relative.minutesAgoShort",
            &[("count", &count)],
        )
    } else {
        strings::t("time.relative.justNow").to_owned()
    }
}

pub(crate) fn format_item_count(count: usize) -> String {
    let key = if count == 1 {
        "newTab.items.one"
    } else {
        "newTab.items.other"
    };
    let rendered = count.to_string();
    catalogue::format(strings::locale(), key, &[("count", &rendered)])
}

/// Formats the bottom version pill like Solid's `VersionPill`: `App <v> · UI <v> (<source>)`.
pub(crate) fn format_version_pill(meta: &super::VersionMeta) -> Option<String> {
    let locale = strings::locale();
    let mut parts = Vec::new();
    if let Some(version) = meta.server_version.as_deref() {
        parts.push(catalogue::format(
            locale,
            "versionPill.appWithVersion",
            &[("version", version)],
        ));
    }
    if meta.ui_version.is_some() || meta.ui_source.is_some() {
        let mut ui = match meta.ui_version.as_deref() {
            Some(version) => {
                catalogue::format(locale, "versionPill.uiWithVersion", &[("version", version)])
            }
            None => strings::t("versionPill.ui").to_owned(),
        };
        if let Some(source) = meta.ui_source.as_deref() {
            ui.push_str(&catalogue::format(
                locale,
                "versionPill.source",
                &[("source", source)],
            ));
        }
        parts.push(ui);
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

pub(crate) fn now_epoch_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now().max(0.0) as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

pub(crate) fn collect_recent_entries(s: &State) -> Vec<RecentEntry> {
    let Some(l) = s.screen.launcher() else {
        return Vec::new();
    };
    let settings_recents = crate::settings::recent_folders(s);
    let workspace_recents = crate::workspace::workspace_recent_folders(s);

    let mut entries: Vec<RecentEntry> = Vec::new();
    let resolve_name = |path: &str, ws_name: Option<&str>, saved_name: Option<&str>| -> String {
        let local = l
            .custom_names
            .iter()
            .find(|(p, _)| same_recent_path(p, path))
            .map(|(_, name)| name.as_str());
        project_display_name(path, local.or(ws_name).or(saved_name))
    };

    let mut upsert = |path: &str,
                      ws_name: Option<&str>,
                      saved_name: Option<&str>,
                      temporary: bool,
                      open_tab_key: Option<String>,
                      project_id: Option<String>,
                      last_accessed: Option<u64>| {
        let path = path.trim();
        if path.is_empty()
            || l.removed_recents
                .iter()
                .any(|removed| same_recent_path(removed, path))
        {
            return;
        }
        if let Some(existing) = entries
            .iter_mut()
            .find(|entry| same_recent_path(&entry.path, path))
        {
            if existing.open_tab_key.is_none() {
                existing.open_tab_key = open_tab_key;
            }
            if existing.project_id.is_none() {
                existing.project_id = project_id;
            }
            existing.last_accessed = match (existing.last_accessed, last_accessed) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            if ws_name.is_some() || saved_name.is_some() {
                existing.display_name = resolve_name(&existing.path, ws_name, saved_name);
            }
            existing.temporary |= temporary;
            return;
        }
        entries.push(RecentEntry {
            path: path.to_owned(),
            display_name: resolve_name(path, ws_name, saved_name),
            display_path: display_path(path),
            open_tab_key,
            project_id,
            open_elsewhere: false,
            temporary,
            last_accessed,
        });
    };

    // 1. Server-persisted recent folders (authoritative order, timestamps, and projectName).
    for (path, last_accessed, saved_name) in &settings_recents {
        let open_tab = crate::workspace::open_tab_for_folder(s, path);
        let ws_name = workspace_recents
            .iter()
            .find(|(f, _, _, _)| same_recent_path(f, path))
            .and_then(|(_, name, _, _)| name.as_deref());
        let project = l.projects.iter().find(|p| same_recent_path(&p.path, path));
        upsert(
            path,
            ws_name,
            saved_name.as_deref(),
            project.is_some_and(|p| p.temporary),
            open_tab,
            project.map(|p| p.id.clone()),
            *last_accessed,
        );
    }

    // 2. Open and recently closed workspace tabs in this window.
    for (folder, name, temporary, open_tab_key) in &workspace_recents {
        if *temporary && open_tab_key.is_none() {
            continue;
        }
        let project_id = l
            .projects
            .iter()
            .find(|p| same_recent_path(&p.path, folder))
            .map(|p| p.id.clone());
        upsert(
            folder,
            name.as_deref(),
            None,
            *temporary,
            open_tab_key.clone(),
            project_id,
            None,
        );
    }

    for entry in &mut entries {
        entry.open_elsewhere = entry.open_tab_key.is_none() && entry.project_id.is_some();
    }

    // Sort newest-accessed entries first; entries without a timestamp preserve insertion order.
    entries.sort_by(|a, b| match (a.last_accessed, b.last_accessed) {
        (Some(ta), Some(tb)) => tb.cmp(&ta),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    entries
}
