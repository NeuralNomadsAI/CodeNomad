use crate::{
    State,
    content::{Part, PictureSource},
    history::Row,
};
use rune::{El, Image, col};
use rune_theme_codenomad::{layout::Layout, markdown};
use std::{
    borrow::Cow,
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    rc::Rc,
};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Candidate {
    pub(super) paths: Vec<String>,
    pub(super) source: PictureSource,
    pub(super) mime: String,
}

pub(super) struct Demand {
    key: String,
    source: PictureSource,
    mime: String,
    lease: Rc<()>,
}

#[derive(Default)]
pub(super) struct Plan {
    pub(super) images: HashMap<String, Image>,
    pub(super) demands: Vec<Demand>,
    pub(super) stamp: Vec<(String, Option<u64>)>,
    pub(super) has_local: bool,
}

/// Agents write Markdown images of files on their machine (`C:/…/image.png`, `/tmp/…`, `./out.png`).
/// The renderer cannot load such paths directly; it can reuse a completed tool image already held
/// by the same session.
pub(crate) fn local_image_path(src: &str) -> Option<String> {
    let value = src.trim();
    if value.is_empty()
        || value.starts_with("//")
        || value.starts_with('#')
        || starts_with_any_ascii_ci(value, &["http:", "https:", "data:", "blob:", "mailto:"])
    {
        return None;
    }
    if is_file_url(value) {
        return parse_file_url(value);
    }
    if has_uri_scheme(value) && !has_windows_drive_prefix(value) {
        return None;
    }
    Some(normalize_path(value))
}

fn parse_file_url(value: &str) -> Option<String> {
    let rest = value.get(5..)?;
    let without_suffix = rest.split(['?', '#']).next().unwrap_or(rest);
    let normalized = without_suffix.replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    if let Some(after_slashes) = normalized.strip_prefix("//") {
        let (raw_host, raw_path) = match after_slashes.find('/') {
            Some(pos) => (&after_slashes[..pos], &after_slashes[pos..]),
            None => (after_slashes, "/"),
        };
        if raw_host.len() == 2
            && raw_host.as_bytes()[0].is_ascii_alphabetic()
            && raw_host.as_bytes()[1] == b':'
        {
            let joined = format!("/{raw_host}{raw_path}");
            let path = decode_uri_component(&joined);
            return Some(strip_leading_drive_slash(&path).into_owned());
        }
        let path = decode_uri_component(raw_path);
        if !raw_host.is_empty() && !raw_host.eq_ignore_ascii_case("localhost") {
            if raw_host
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            {
                return None;
            }
            return Some(format!("//{raw_host}{path}"));
        }
        if path == "/" && raw_host.is_empty() && after_slashes.is_empty() {
            return None;
        }
        return Some(strip_leading_drive_slash(&path).into_owned());
    }
    let raw_path = if normalized.starts_with('/') {
        Cow::Borrowed(normalized.as_str())
    } else {
        Cow::Owned(format!("/{normalized}"))
    };
    let path = decode_uri_component(&raw_path);
    Some(strip_leading_drive_slash(&path).into_owned())
}

/// Whether a Markdown image source is a `file:` URL, whose path is already percent-decoded.
pub(crate) fn is_file_url(src: &str) -> bool {
    let value = src.trim();
    value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
}

fn starts_with_any_ascii_ci(value: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| {
        value
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    })
}

fn has_uri_scheme(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.first().is_none_or(|b| !b.is_ascii_alphabetic()) {
        return false;
    }
    for &byte in &bytes[1..] {
        if byte == b':' {
            return true;
        }
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')) {
            return false;
        }
    }
    false
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn strip_leading_drive_slash(path: &str) -> Cow<'_, str> {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        Cow::Borrowed(&path[1..])
    } else {
        Cow::Borrowed(path)
    }
}

fn normalize_path(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    replaced.trim_end_matches('/').to_owned()
}

fn windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/')
        || value.starts_with("//")
}

fn comparable(value: &str) -> String {
    let normalized = normalize_path(value);
    if windows_path(&normalized) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Exact `decodeURIComponent` behavior: returns the original string unchanged on malformed
/// percent-escapes or invalid UTF-8 sequences.
fn decode_uri_component(value: &str) -> Cow<'_, str> {
    if !value.contains('%') {
        return Cow::Borrowed(value);
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let Some(hi) = bytes.get(i + 1).copied().and_then(hex_value) else {
                return Cow::Borrowed(value);
            };
            let Some(lo) = bytes.get(i + 2).copied().and_then(hex_value) else {
                return Cow::Borrowed(value);
            };
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    match String::from_utf8(out) {
        Ok(decoded) => Cow::Owned(decoded),
        Err(_) => Cow::Borrowed(value),
    }
}

/// Matches the literal path against completed tool images, then (for a plain path written in
/// Markdown, never one already decoded from a `file:` URL) its percent-decoded form.
pub(super) fn match_local_image<'a>(
    candidates: &'a [Candidate],
    path: &str,
    decoded_fallback: bool,
) -> Option<&'a Candidate> {
    if let Some(found) = match_path(candidates, path) {
        return Some(found);
    }
    if decoded_fallback {
        let decoded = decode_uri_component(path);
        if decoded.as_ref() != path {
            return match_path(candidates, decoded.as_ref());
        }
    }
    None
}

/// Exact normalized path match, or a unique relative suffix match against completed session tool
/// images (scanned newest first so re-read files resolve to their latest image).
fn match_path<'a>(candidates: &'a [Candidate], path: &str) -> Option<&'a Candidate> {
    let target = comparable(path);
    let relative = (!target.starts_with('/')
        && !windows_path(&target)
        && !target.starts_with("../"))
    .then(|| {
        let mut stripped = target.as_str();
        while let Some(rest) = stripped.strip_prefix("./") {
            stripped = rest;
        }
        (!stripped.is_empty() && !stripped.starts_with("../")).then(|| format!("/{stripped}"))
    })
    .flatten();
    let relative_lower = relative.as_deref().map(str::to_lowercase);
    let mut suffixes: HashMap<String, &'a Candidate> = HashMap::new();
    for candidate in candidates {
        for raw_known in &candidate.paths {
            let known = comparable(raw_known);
            if known == target {
                return Some(candidate);
            }
            if let Some(rel) = relative.as_deref()
                && !suffixes.contains_key(&known)
            {
                let matched = if windows_path(&known) {
                    known.ends_with(relative_lower.as_deref().unwrap_or(rel))
                } else {
                    known.ends_with(rel)
                };
                if matched {
                    suffixes.insert(known, candidate);
                }
            }
        }
    }
    (suffixes.len() == 1)
        .then(|| suffixes.into_values().next())
        .flatten()
}

pub(super) fn session_candidates(messages: &[Row]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for row in messages.iter().rev() {
        for part in row.parts.iter().rev() {
            let Part::Tool(tool) = part else {
                continue;
            };
            if tool.status != "completed" || tool.pictures.is_empty() {
                continue;
            }
            let input_path = tool
                .input
                .get("filePath")
                .or_else(|| tool.input.get("path"))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty());
            let single = tool.pictures.len() == 1;
            for picture in &tool.pictures {
                if matches!(picture.source, PictureSource::Unavailable) {
                    continue;
                }
                let mut paths = Vec::new();
                if let Some(name) = picture.name.as_deref().filter(|value| !value.is_empty()) {
                    paths.push(name.to_owned());
                }
                if single && let Some(path) = input_path {
                    paths.push(path.to_owned());
                }
                if !paths.is_empty() {
                    out.push(Candidate {
                        paths,
                        source: picture.source.clone(),
                        mime: picture.mime.clone(),
                    });
                }
            }
        }
    }
    out
}

fn markdown_local_sources(shown: &str) -> Vec<(String, String)> {
    markdown::prose_image_sources(shown)
        .into_iter()
        .filter_map(|dest_url| {
            let local = local_image_path(&dest_url)?;
            Some((dest_url, local))
        })
        .collect()
}

fn image_stamp(image: &Image) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.id().hash(&mut hasher);
    hasher.finish()
}

pub(super) fn prepare(s: &State, group: &str, shown: &str) -> Plan {
    let sources = markdown_local_sources(shown);
    if sources.is_empty() {
        return Plan::default();
    }
    let candidates = session_candidates(&s.messages);
    let mut plan = Plan {
        has_local: true,
        ..Plan::default()
    };
    if candidates.is_empty() {
        return plan;
    }
    for (index, (raw_src, local)) in sources.into_iter().enumerate() {
        let Some(matched) = match_local_image(&candidates, &local, !is_file_url(&raw_src)) else {
            continue;
        };
        let (key, lease, ready) = s.transcript_display.pictures.local_slot(
            &format!("{group}-local-image-{index}"),
            &matched.source,
            &matched.mime,
        );
        plan.stamp
            .push((raw_src.clone(), ready.as_ref().map(image_stamp)));
        if let Some(image) = ready {
            plan.images.insert(raw_src, image);
        }
        plan.demands.push(Demand {
            key,
            source: matched.source.clone(),
            mime: matched.mime.clone(),
            lease,
        });
    }
    plan
}

pub(super) fn attach(content: El, group: &str, scope: Rc<()>, demands: Vec<Demand>) -> El {
    if demands.is_empty() {
        return content;
    }
    let mut stamp = DefaultHasher::new();
    for demand in &demands {
        demand.key.hash(&mut stamp);
    }
    let demand_key = format!("{group}-local-images-{:x}", stamp.finish());
    col().full_width().child(content.key(demand_key).on_visible(
        move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                for demand in &demands {
                    s.transcript_display.pictures.local_visibility(
                        &demand.key,
                        &demand.source,
                        &demand.mime,
                        &demand.lease,
                        visible,
                    );
                }
                if visible {
                    tx.wake_after(std::time::Duration::ZERO);
                }
            }
            tx.live_only();
        },
    ))
}
