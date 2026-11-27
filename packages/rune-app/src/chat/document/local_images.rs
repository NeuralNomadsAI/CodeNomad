use crate::{
    State,
    chat::{media::LocalImageState, tools::duration::ActiveClip},
    content::{Part, PictureSource, Tool},
    history::Row,
};
use rune::{El, Image, col};
use rune_theme_codenomad::{
    layout::{DrawnRect, Layout},
    markdown,
};
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    rc::Rc,
    sync::Arc,
};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::chat) enum Conversation<'a> {
    Root,
    Child {
        parent: Option<&'a str>,
        id: &'a str,
    },
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct KnownPath {
    comparable: String,
    windows: bool,
}

impl KnownPath {
    fn new(raw: &str) -> Option<Self> {
        let comparable = comparable(raw);
        if comparable.is_empty() || has_parent_segment(&comparable) {
            return None;
        }
        let windows = windows_path(&comparable);
        Some(Self {
            comparable,
            windows,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Candidate {
    pub(super) paths: Vec<KnownPath>,
    pub(super) source: PictureSource,
    pub(super) mime: String,
}

#[derive(Debug, PartialEq, Eq)]
enum Match<'a> {
    Found(&'a Candidate),
    Ambiguous,
    Miss,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(super) enum SlotStamp {
    Ready(u64),
    Pending,
    Failed,
}

struct Slot {
    key: String,
    source: PictureSource,
    mime: String,
    lease: Rc<()>,
    drawn: Rc<DrawnRect>,
    label: String,
    image: Option<Image>,
}

pub(super) struct Plan {
    occurrences: HashMap<String, Vec<Option<Slot>>>,
    sentinel: Option<Image>,
    clip: ActiveClip,
    pub(super) stamp: Vec<(String, String, SlotStamp)>,
    pub(super) sentinel_ready: bool,
}

fn fallback_matcher(kept: HashMap<String, Vec<bool>>) -> impl Fn(&str, bool) -> Option<String> {
    let cursors: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    move |src: &str, liftable: bool| {
        let local = local_image_path(src)?;
        if !liftable {
            return Some(filename_label(&local));
        }
        let Some(entries) = kept.get(src) else {
            return Some(filename_label(&local));
        };
        let mut cursors = cursors.borrow_mut();
        let index = cursors.entry(src.to_owned()).or_insert(0);
        let kept_occurrence = entries.get(*index).copied().unwrap_or(false);
        *index += 1;
        if kept_occurrence {
            None
        } else {
            Some(filename_label(&local))
        }
    }
}

fn image_search_matcher(
    kept_meta: HashMap<String, Vec<markdown::ImageSearch>>,
) -> impl Fn(&str) -> markdown::ImageSearch {
    let cursors: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    move |src: &str| {
        let Some(entries) = kept_meta.get(src) else {
            return markdown::ImageSearch::Inline;
        };
        let mut cursors = cursors.borrow_mut();
        let index = cursors.entry(src.to_owned()).or_insert(0);
        let entry = entries.get(*index).cloned();
        *index += 1;
        entry.unwrap_or(markdown::ImageSearch::Inline)
    }
}

impl Plan {
    fn empty(clip: ActiveClip) -> Self {
        Self {
            occurrences: HashMap::new(),
            sentinel: None,
            clip,
            stamp: Vec::new(),
            sentinel_ready: false,
        }
    }

    pub(super) fn fallback_label(&self) -> impl Fn(&str, bool) -> Option<String> {
        let kept = self
            .occurrences
            .iter()
            .map(|(src, entries)| {
                (
                    src.clone(),
                    entries.iter().map(Option::is_some).collect::<Vec<_>>(),
                )
            })
            .collect();
        fallback_matcher(kept)
    }

    pub(super) fn image_search_text(&self) -> impl Fn(&str) -> markdown::ImageSearch {
        let kept_meta = self
            .occurrences
            .iter()
            .map(|(src, entries)| {
                let meta = entries
                    .iter()
                    .filter_map(Option::as_ref)
                    .map(|slot| {
                        if slot.image.is_some() {
                            markdown::ImageSearch::Hidden
                        } else {
                            markdown::ImageSearch::Fallback {
                                key: slot.key.clone(),
                                label: slot.label.clone(),
                            }
                        }
                    })
                    .collect::<Vec<_>>();
                (src.clone(), meta)
            })
            .collect();
        image_search_matcher(kept_meta)
    }

    #[allow(clippy::type_complexity)]
    pub(super) fn into_render(
        self,
        scope: Rc<()>,
        search_terms: Option<(Vec<String>, bool)>,
    ) -> (
        impl Fn(&str, bool) -> Option<String>,
        impl Fn(&str) -> markdown::ImageSearch,
        impl Fn(&str) -> Option<Image> + 'static,
        impl Fn(El, &markdown::ImageFrame<'_>, Option<&str>) -> El + 'static,
    ) {
        let mut kept: HashMap<String, Vec<bool>> = HashMap::with_capacity(self.occurrences.len());
        let mut kept_meta: HashMap<String, Vec<markdown::ImageSearch>> =
            HashMap::with_capacity(self.occurrences.len());
        let mut active_slots: HashMap<String, VecDeque<Slot>> = HashMap::new();
        for (src, entries) in self.occurrences {
            let mut flags = Vec::with_capacity(entries.len());
            let mut meta = Vec::new();
            for entry in entries {
                if let Some(slot) = entry {
                    flags.push(true);
                    meta.push(if slot.image.is_some() {
                        markdown::ImageSearch::Hidden
                    } else {
                        markdown::ImageSearch::Fallback {
                            key: slot.key.clone(),
                            label: slot.label.clone(),
                        }
                    });
                    active_slots.entry(src.clone()).or_default().push_back(slot);
                } else {
                    flags.push(false);
                }
            }
            kept.insert(src.clone(), flags);
            kept_meta.insert(src, meta);
        }
        let fallback = fallback_matcher(kept);
        let search_text = image_search_matcher(kept_meta);
        let slots = Rc::new(RefCell::new(active_slots));
        let lookup_slots = slots.clone();
        let sentinel = self.sentinel;
        let clip = self.clip;
        let images = move |src: &str| {
            let slots = lookup_slots.borrow();
            let slot = slots.get(src)?.front()?;
            slot.image.clone().or_else(|| sentinel.clone())
        };
        let frame =
            move |el: El, frame: &markdown::ImageFrame<'_>, active_slot_key: Option<&str>| {
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
                    let frame_query = search_terms.as_ref().map(|(terms, ranked)| {
                        rune_theme_codenomad::timeline::search::Query {
                            terms,
                            ranked: *ranked,
                            active: active_slot_key == Some(slot.key.as_str()),
                            claimed: None,
                        }
                    });
                    markdown::prose_fallback_text(&slot.label, frame_query)
                };
                let Slot {
                    key,
                    source,
                    mime,
                    lease,
                    drawn,
                    ..
                } = slot;
                let layout_drawn = drawn.clone();
                let layout_clip = clip.clone();
                let layout_scope = scope.clone();
                let layout_target = key.clone();
                let layout_source = source.clone();
                let layout_mime = mime.clone();
                let layout_lease = lease.clone();
                let visible_drawn = drawn.clone();
                let visible_clip = clip.clone();
                let scope = scope.clone();
                let target = key.clone();
                // Rune Kit stamps a positional `bN` key on the root element returned by `image_frame`.
                // Keep the source-scoped key and live clip-gate handlers on a child so Pictures
                // re-evaluates live image and pane clip geometry on every admission/reconnect and
                // replacing a failed source at the same path fires a fresh visibility event on screen.
                col().full_width().child(
                    content
                        .key(key)
                        .drawn_rect_into(&drawn)
                        .on_drawn_layout_tx(move |s: &mut State, _, tx| {
                            if s.current_scope(&layout_scope) {
                                let rect = layout_drawn.get();
                                if rect[2] > 0.0
                                    && rect[3] > 0.0
                                    && s.transcript_display.pictures.refresh_local_clip(
                                        &layout_target,
                                        &layout_source,
                                        &layout_mime,
                                        &layout_lease,
                                        &layout_drawn,
                                        &layout_clip,
                                        &s.transcript_display.tool_clock,
                                        s.tool_diff_preferences.history_bounds.get(),
                                    )
                                {
                                    tx.wake_after(std::time::Duration::ZERO);
                                }
                            }
                            tx.live_only();
                        })
                        .on_visible(move |s: &mut State, visible, tx| {
                            if s.current_scope(&scope)
                                && s.transcript_display.pictures.local_visibility(
                                    &target,
                                    &source,
                                    &mime,
                                    &lease,
                                    &visible_drawn,
                                    &visible_clip,
                                    &s.transcript_display.tool_clock,
                                    s.tool_diff_preferences.history_bounds.get(),
                                    visible,
                                )
                            {
                                tx.wake_after(std::time::Duration::ZERO);
                            }
                            tx.live_only();
                        }),
                )
            };
        (fallback, search_text, images, frame)
    }
}

/// Agents write Markdown images of files on their machine (`C:/…/image.png`, `/tmp/…`, `./out.png`).
/// The renderer cannot load such paths directly; it can reuse a completed tool image already held
/// by the same session.
pub(crate) fn local_image_path(src: &str) -> Option<String> {
    let cleaned_url = preprocess_whatwg_url(src);
    if cleaned_url.is_empty()
        || cleaned_url.starts_with("//")
        || cleaned_url.starts_with('#')
        || starts_with_any_ascii_ci(
            &cleaned_url,
            &["http:", "https:", "data:", "blob:", "mailto:"],
        )
    {
        return None;
    }
    if cleaned_url
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        return parse_file_url(&cleaned_url);
    }
    if has_uri_scheme(&cleaned_url) && !has_windows_drive_prefix(&cleaned_url) {
        return None;
    }
    Some(normalize_path(trim_whatwg_c0_space(src)))
}

fn trim_whatwg_c0_space(value: &str) -> &str {
    value.trim_matches(|c: char| c <= '\u{0020}')
}

fn preprocess_whatwg_url(value: &str) -> Cow<'_, str> {
    let trimmed = trim_whatwg_c0_space(value);
    if trimmed.contains(['\t', '\r', '\n']) {
        Cow::Owned(
            trimmed
                .chars()
                .filter(|c| !matches!(c, '\t' | '\r' | '\n'))
                .collect(),
        )
    } else {
        Cow::Borrowed(trimmed)
    }
}

fn parse_file_url(cleaned: &str) -> Option<String> {
    // Check double-dot segments independently on the WHATWG-preprocessed URL before URL parsing
    // collapses dot segments (including when later segments hold malformed `%ZZ` escapes).
    let raw_tail = cleaned
        .get(5..)?
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    if has_file_url_parent_segment(raw_tail) {
        return None;
    }
    let (host, raw_path) = codenomad_client::http::file_url_parts(cleaned)?;
    let path = decode_uri_component(&raw_path);
    if has_parent_segment(&path) {
        return None;
    }
    if let Some(host) = host {
        return Some(format!("//{host}{path}"));
    }
    Some(strip_leading_drive_slash(&path).into_owned())
}

fn has_file_url_parent_segment(raw_tail: &str) -> bool {
    let normalized = raw_tail.replace('\\', "/");
    normalized.split('/').any(|segment| {
        segment == ".."
            || segment.eq_ignore_ascii_case(".%2e")
            || segment.eq_ignore_ascii_case("%2e.")
            || segment.eq_ignore_ascii_case("%2e%2e")
            || decode_uri_component(segment) == ".."
    })
}

/// Whether a Markdown image source is a `file:` URL, whose path is already percent-decoded.
pub(crate) fn is_file_url(src: &str) -> bool {
    let cleaned = preprocess_whatwg_url(src);
    cleaned
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
        if bytes[2] == b':' && (bytes.len() == 3 || bytes[3] == b'/') {
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
    let unc = normalized.starts_with("//");
    let abs = !unc && normalized.starts_with('/');
    let rest = if unc {
        &normalized[2..]
    } else if abs {
        &normalized[1..]
    } else {
        normalized.as_str()
    };
    let mut out = String::with_capacity(normalized.len());
    if unc {
        out.push_str("//");
    } else if abs {
        out.push('/');
    }
    let mut has_segment = false;
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if has_segment {
            out.push('/');
        }
        has_segment = true;
        out.push_str(segment);
    }
    if !has_segment {
        return String::new();
    }
    if windows_path(&out) {
        out.to_lowercase()
    } else {
        out
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
    let available = |candidate: &'a Candidate| {
        (!matches!(candidate.source, PictureSource::Unavailable)).then_some(candidate)
    };
    match match_path(candidates, path) {
        Match::Found(candidate) => available(candidate),
        Match::Ambiguous => None,
        Match::Miss if decoded_fallback => {
            let decoded = decode_uri_component(path);
            if decoded.as_ref() != path {
                match match_path(candidates, decoded.as_ref()) {
                    Match::Found(candidate) => available(candidate),
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
    if target.starts_with('/') || windows_path(&target) {
        for candidate in candidates {
            if candidate
                .paths
                .iter()
                .any(|known| known.comparable == target)
            {
                return Match::Found(candidate);
            }
        }
        return Match::Miss;
    }
    let mut stripped = target.as_str();
    while let Some(rest) = stripped.strip_prefix("./") {
        stripped = rest;
    }
    if stripped.is_empty() || has_parent_segment(stripped) {
        return Match::Miss;
    }
    let rel = format!("/{stripped}");
    let rel_lower = rel.to_lowercase();
    let mut matched_paths: HashMap<&str, &'a Candidate> = HashMap::new();
    for candidate in candidates {
        let mut best: Option<&str> = None;
        for known in &candidate.paths {
            let mut known_key = known.comparable.as_str();
            while let Some(rest) = known_key.strip_prefix("./") {
                known_key = rest;
            }
            let exact = known_key == stripped;
            let suffix = if known.windows {
                known.comparable.ends_with(&rel_lower)
            } else {
                known.comparable.ends_with(&rel)
            };
            if (exact || suffix) && best.is_none_or(|prev| known_key.len() > prev.len()) {
                best = Some(known_key);
            }
        }
        if let Some(key) = best {
            matched_paths.entry(key).or_insert(candidate);
        }
    }
    match matched_paths.len() {
        0 => Match::Miss,
        1 => matched_paths
            .into_values()
            .next()
            .map_or(Match::Miss, Match::Found),
        _ => Match::Ambiguous,
    }
}

fn collect_tool_candidates(tool: &Tool, out: &mut Vec<Candidate>) {
    if tool.status != "completed" || tool.pictures.is_empty() {
        return;
    }
    let input_path = tool
        .input
        .get("filePath")
        .or_else(|| tool.input.get("path"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .and_then(KnownPath::new);
    let single = tool.pictures.len() == 1;
    for picture in &tool.pictures {
        let mut paths = Vec::new();
        if let Some(known) = picture
            .name
            .as_deref()
            .filter(|value| !value.is_empty())
            .and_then(KnownPath::new)
        {
            paths.push(known);
        }
        if single
            && let Some(path) = input_path.as_ref()
            && !paths.contains(path)
        {
            paths.push(path.clone());
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

pub(super) fn session_candidates(messages: &[Row]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for row in messages.iter().rev() {
        for part in row.parts.iter().rev() {
            if let Part::Tool(tool) = part {
                collect_tool_candidates(tool, &mut out);
            }
        }
    }
    out
}

fn child_candidates(steps: &[(String, Arc<Tool>)]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for (_, tool) in steps.iter().rev() {
        collect_tool_candidates(tool, &mut out);
    }
    out
}

fn image_stamp(image: &Image) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.id().hash(&mut hasher);
    hasher.finish()
}

pub(super) fn prepare(
    s: &State,
    group: &str,
    shown: &str,
    truncated: bool,
    conversation: Conversation<'_>,
) -> Plan {
    let clip = s.transcript_display.tool_clock.current_clip();
    if matches!(conversation, Conversation::None) {
        return Plan::empty(clip);
    }
    let lifted = markdown::prose_lifted_images(shown, truncated);
    if lifted.is_empty() {
        return Plan::empty(clip);
    }
    let local_occurrences: Vec<(String, String, String)> = lifted
        .into_iter()
        .filter_map(|item| {
            let local = local_image_path(&item.src)?;
            let label = if item.alt.trim().is_empty() {
                filename_label(&local)
            } else {
                item.alt
            };
            Some((item.src, local, label))
        })
        .collect();
    if local_occurrences.is_empty() {
        return Plan::empty(clip);
    }
    let candidates = match conversation {
        Conversation::Root => session_candidates(&s.messages),
        Conversation::Child { parent, id } => {
            child_candidates(s.transcript_display.children.verified_tools(parent, id))
        }
        Conversation::None => Vec::new(),
    };
    if candidates.is_empty() {
        return Plan::empty(clip);
    }
    let sentinel = s.transcript_display.pictures.blank_pixel(&s.wake);
    let mut plan = Plan {
        occurrences: HashMap::new(),
        sentinel_ready: sentinel.is_some(),
        sentinel,
        clip,
        stamp: Vec::new(),
    };
    let mut resolved: HashMap<String, Option<&Candidate>> = HashMap::new();
    for (index, (raw_src, local, label)) in local_occurrences.into_iter().enumerate() {
        let matched = *resolved
            .entry(raw_src.clone())
            .or_insert_with(|| match_local_image(&candidates, &local, !is_file_url(&raw_src)));
        let Some(matched) = matched else {
            plan.occurrences.entry(raw_src).or_default().push(None);
            continue;
        };
        let (key, lease, drawn, state) = s.transcript_display.pictures.local_slot(
            &format!("{group}-local-image-{index}"),
            &matched.source,
            &matched.mime,
        );
        match state {
            LocalImageState::Ready(image) => {
                plan.stamp.push((
                    raw_src.clone(),
                    key.clone(),
                    SlotStamp::Ready(image_stamp(&image)),
                ));
                plan.occurrences
                    .entry(raw_src)
                    .or_default()
                    .push(Some(Slot {
                        key,
                        source: matched.source.clone(),
                        mime: matched.mime.clone(),
                        lease,
                        drawn,
                        label,
                        image: Some(image),
                    }));
            }
            LocalImageState::Pending | LocalImageState::Failed => {
                let failed = matches!(state, LocalImageState::Failed);
                plan.stamp.push((
                    raw_src.clone(),
                    key.clone(),
                    if failed {
                        SlotStamp::Failed
                    } else {
                        SlotStamp::Pending
                    },
                ));
                if plan.sentinel_ready {
                    plan.occurrences
                        .entry(raw_src)
                        .or_default()
                        .push(Some(Slot {
                            key,
                            source: matched.source.clone(),
                            mime: matched.mime.clone(),
                            lease,
                            drawn,
                            label,
                            image: None,
                        }));
                } else {
                    // Wait for the web 1x1 sentinel microtask before lifting this slot into Block::Image.
                    plan.occurrences.entry(raw_src).or_default().push(None);
                }
            }
        }
    }
    plan
}
