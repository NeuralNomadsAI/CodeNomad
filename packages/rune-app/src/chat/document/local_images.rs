use crate::{
    State,
    content::{Part, PictureSource},
    history::Row,
};
use rune::{El, Image, text};
use rune_theme_codenomad::markdown;
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, VecDeque},
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

#[derive(Debug, PartialEq, Eq)]
enum Match<'a> {
    Found(&'a Candidate),
    Ambiguous,
    Miss,
}

pub(super) struct Slot {
    key: String,
    source: PictureSource,
    mime: String,
    lease: Rc<()>,
    fallback: String,
    image: Option<Image>,
}

#[derive(Default)]
pub(super) struct Plan {
    slots: HashMap<String, VecDeque<Slot>>,
    sentinel: Option<Image>,
    pub(super) stamp: Vec<(String, Option<u64>)>,
    pub(super) sentinel_ready: bool,
}

impl Plan {
    pub(super) fn fallback_label(&self, src: &str, liftable: bool) -> Option<String> {
        let local = local_image_path(src)?;
        if !liftable || !self.slots.contains_key(src) {
            return Some(filename_label(&local));
        }
        None
    }

    pub(super) fn into_render(
        self,
        scope: Rc<()>,
    ) -> (
        impl Fn(&str, bool) -> Option<String>,
        impl Fn(&str) -> Option<Image> + 'static,
        impl Fn(El, &markdown::ImageFrame<'_>) -> El + 'static,
    ) {
        let kept: std::collections::HashSet<String> = self.slots.keys().cloned().collect();
        let fallback = move |src: &str, liftable: bool| {
            let local = local_image_path(src)?;
            if !liftable || !kept.contains(src) {
                return Some(filename_label(&local));
            }
            None
        };
        let slots = Rc::new(RefCell::new(self.slots));
        let lookup_slots = slots.clone();
        let sentinel = self.sentinel;
        let images = move |src: &str| {
            let slots = lookup_slots.borrow();
            let slot = slots.get(src)?.front()?;
            slot.image.clone().or_else(|| sentinel.clone())
        };
        let frame = move |el: El, frame: &markdown::ImageFrame<'_>| {
            let slot = slots
                .borrow_mut()
                .get_mut(frame.src)
                .and_then(VecDeque::pop_front);
            let Some(slot) = slot else {
                return markdown::prose_image(el);
            };
            let content = if slot.image.is_some() {
                markdown::prose_image(el)
            } else {
                let label = if frame.alt.trim().is_empty() {
                    slot.fallback
                } else {
                    frame.alt.to_owned()
                };
                text(label)
            };
            let Slot {
                key,
                source,
                mime,
                lease,
                ..
            } = slot;
            let scope = scope.clone();
            let target = key.clone();
            content
                .key(key)
                .on_visible(move |s: &mut State, visible, tx| {
                    if s.current_scope(&scope) {
                        s.transcript_display
                            .pictures
                            .local_visibility(&target, &source, &mime, &lease, visible);
                        if visible {
                            tx.wake_after(std::time::Duration::ZERO);
                        }
                    }
                    tx.live_only();
                })
        };
        (fallback, images, frame)
    }
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
    // Reject traversal segments before the WHATWG parser normalizes dot segments away.
    let raw_tail = value
        .get(5..)?
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .replace('\\', "/");
    if has_parent_segment(&raw_tail) || has_parent_segment(&decode_uri_component(&raw_tail)) {
        return None;
    }
    let (host, raw_path) = codenomad_client::http::file_url_parts(value)?;
    let path = decode_uri_component(&raw_path);
    if has_parent_segment(&path) {
        return None;
    }
    if let Some(host) = host {
        return Some(format!("//{host}{path}"));
    }
    Some(strip_leading_drive_slash(&path).into_owned())
}

/// Whether a Markdown image source is a `file:` URL, whose path is already percent-decoded.
pub(crate) fn is_file_url(src: &str) -> bool {
    let value = src.trim();
    value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
}

fn filename_label(local: &str) -> String {
    local
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .unwrap_or(local)
        .to_owned()
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
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() {
        if bytes[2] == b':' {
            return Cow::Borrowed(&path[1..]);
        }
        if bytes[2] == b'|' && (bytes.len() == 3 || bytes[3] == b'/') {
            return Cow::Owned(format!("{}:{}", bytes[1] as char, &path[3..]));
        }
    }
    Cow::Borrowed(path)
}

fn normalize_path(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    replaced.trim_end_matches('/').to_owned()
}

fn has_parent_segment(normalized: &str) -> bool {
    normalized.split('/').any(|segment| segment == "..")
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
/// Markdown, never one already decoded from a `file:` URL, and never after an ambiguous match)
/// its percent-decoded form.
pub(super) fn match_local_image<'a>(
    candidates: &'a [Candidate],
    path: &str,
    decoded_fallback: bool,
) -> Option<&'a Candidate> {
    match match_path(candidates, path) {
        Match::Found(candidate) => Some(candidate),
        Match::Ambiguous => None,
        Match::Miss if decoded_fallback => {
            let decoded = decode_uri_component(path);
            if decoded.as_ref() != path {
                match match_path(candidates, decoded.as_ref()) {
                    Match::Found(candidate) => Some(candidate),
                    Match::Ambiguous | Match::Miss => None,
                }
            } else {
                None
            }
        }
        Match::Miss => None,
    }
}

/// Exact normalized path match, or a unique relative suffix match against completed session tool
/// images (scanned newest first so re-read files resolve to their latest image).
fn match_path<'a>(candidates: &'a [Candidate], path: &str) -> Match<'a> {
    let target = comparable(path);
    if target.is_empty() || has_parent_segment(&target) {
        return Match::Miss;
    }
    let relative = (!target.starts_with('/') && !windows_path(&target))
        .then(|| {
            let mut stripped = target.as_str();
            while let Some(rest) = stripped.strip_prefix("./") {
                stripped = rest;
            }
            (!stripped.is_empty() && !has_parent_segment(stripped)).then(|| format!("/{stripped}"))
        })
        .flatten();
    let relative_lower = relative.as_deref().map(str::to_lowercase);
    let mut suffixes: HashMap<String, &'a Candidate> = HashMap::new();
    for candidate in candidates {
        for raw_known in &candidate.paths {
            let known = comparable(raw_known);
            if known.is_empty() || has_parent_segment(&known) {
                continue;
            }
            if known == target {
                return Match::Found(candidate);
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
    match suffixes.len() {
        0 => Match::Miss,
        1 => suffixes
            .into_values()
            .next()
            .map_or(Match::Miss, Match::Found),
        _ => Match::Ambiguous,
    }
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

fn image_stamp(image: &Image) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.id().hash(&mut hasher);
    hasher.finish()
}

pub(super) fn prepare(s: &State, group: &str, shown: &str, truncated: bool) -> Plan {
    let lifted = markdown::prose_lifted_images(shown, truncated);
    if lifted.is_empty() {
        return Plan::default();
    }
    let local_occurrences: Vec<(String, String)> = lifted
        .into_iter()
        .filter_map(|raw| {
            let local = local_image_path(&raw)?;
            Some((raw, local))
        })
        .collect();
    if local_occurrences.is_empty() {
        return Plan::default();
    }
    let candidates = session_candidates(&s.messages);
    if candidates.is_empty() {
        return Plan::default();
    }
    let sentinel = s.transcript_display.pictures.blank_pixel(&s.wake);
    let mut plan = Plan {
        sentinel_ready: sentinel.is_some(),
        sentinel,
        ..Plan::default()
    };
    for (index, (raw_src, local)) in local_occurrences.into_iter().enumerate() {
        let Some(matched) = match_local_image(&candidates, &local, !is_file_url(&raw_src)) else {
            continue;
        };
        let (key, lease, ready) = s.transcript_display.pictures.local_slot(
            &format!("{group}-local-image-{index}"),
            &matched.source,
            &matched.mime,
        );
        if ready.is_none() && !plan.sentinel_ready {
            // Wait for the web 1x1 sentinel microtask before lifting this slot into Block::Image.
            continue;
        }
        plan.stamp
            .push((raw_src.clone(), ready.as_ref().map(image_stamp)));
        plan.slots.entry(raw_src).or_default().push_back(Slot {
            key,
            source: matched.source.clone(),
            mime: matched.mime.clone(),
            lease,
            fallback: filename_label(&local),
            image: ready,
        });
    }
    plan
}
