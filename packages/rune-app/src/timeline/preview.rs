//! Hover/focus excerpts owned by the rail, never by the conversation reader.
use super::{Marker, MarkerKind, owner};
use crate::{State, content::Part, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    history::Result,
    timeline::{Excerpt, PREVIEW_BATCH},
};
use rune::{El, Tx};
use rune_theme_codenomad::timeline::preview as theme;
use std::{
    borrow::Cow,
    collections::{HashMap, VecDeque},
};

const FRESH_FOR: f64 = 30.0;
const DELAY: f64 = 0.08;
const CLOSE_DELAY: f64 = 0.16;
const MAX_UNITS: usize = 4096;

struct PreviewBounds(rune_theme_codenomad::layout::DrawnRect);

impl Default for PreviewBounds {
    fn default() -> Self {
        Self(rune_theme_codenomad::layout::DrawnRect::new([0.0; 4]))
    }
}

#[derive(Clone, Default)]
struct PreviewScroll(
    std::rc::Rc<std::cell::Cell<(rune_theme_codenomad::timeline::ScrollPosition, Option<f32>)>>,
);

#[derive(Default)]
pub(super) struct Previews {
    hover: Option<String>,
    focus: Option<String>,
    target: Option<String>,
    dismissed: Option<String>,
    opening: Option<(String, f64)>,
    closing: Option<f64>,
    over_preview: bool,
    bounds: PreviewBounds,
    scroll: PreviewScroll,
    placement: Option<(f32, f32, f32, [f32; 2])>,
    plan: Option<(usize, usize, u64, bool)>,
    wanted: Vec<String>,
    due: Option<f64>,
    flight: Option<(Sender<()>, Receiver<Result<Vec<Excerpt>>>)>,
    cache_scope: Option<u64>,
}

#[derive(Default)]
pub(crate) struct ExcerptCache {
    next_scope: u64,
    entries: HashMap<u64, HashMap<String, (Option<Excerpt>, f64)>>,
    order: VecDeque<(u64, String)>,
}

impl ExcerptCache {
    fn excerpt_bytes(entry: Option<&Excerpt>) -> usize {
        entry.map_or(0, |excerpt| {
            excerpt
                .text
                .len()
                .saturating_add(excerpt.id.len())
                .saturating_add(excerpt.tools.len())
                .saturating_add(64)
        })
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        self.entries.values().fold(0usize, |total, scope_map| {
            scope_map.iter().fold(total, |acc, (id, (excerpt, _))| {
                acc.saturating_add(id.len())
                    .saturating_add(Self::excerpt_bytes(excerpt.as_ref()))
            })
        })
    }

    pub(crate) fn evict_inactive_scopes(&mut self, active_scope: Option<u64>) -> usize {
        let before = self.retained_bytes();
        self.entries.retain(|scope, _| Some(*scope) == active_scope);
        self.order.retain(|(scope, _)| Some(*scope) == active_scope);
        before.saturating_sub(self.retained_bytes())
    }

    pub(crate) fn evict_oldest_except(
        &mut self,
        keep_scope: Option<u64>,
        keep_id: Option<&str>,
        bytes_to_free: usize,
    ) -> usize {
        if bytes_to_free == 0 || self.order.is_empty() {
            return 0;
        }
        let mut freed = 0usize;
        let mut kept = VecDeque::with_capacity(self.order.len());
        while let Some((scope, id)) = self.order.pop_front() {
            let protected = Some(scope) == keep_scope && keep_id == Some(id.as_str());
            if freed < bytes_to_free && !protected {
                if let Some(entries) = self.entries.get_mut(&scope) {
                    if let Some((excerpt, _)) = entries.remove(&id) {
                        freed = freed
                            .saturating_add(id.len())
                            .saturating_add(Self::excerpt_bytes(excerpt.as_ref()));
                    }
                    if entries.is_empty() {
                        self.entries.remove(&scope);
                    }
                }
            } else {
                kept.push_back((scope, id));
            }
        }
        self.order = kept;
        freed
    }

    #[cfg(test)]
    pub(crate) fn fixture_remember(&mut self, scope: u64, id: String, text: String, now: f64) {
        self.remember(
            scope,
            id.clone(),
            Some(Excerpt {
                id,
                text,
                tools: String::new(),
            }),
            now,
        );
    }

    fn scope(&mut self) -> u64 {
        let scope = self.next_scope;
        self.next_scope += 1;
        scope
    }

    fn get(&self, scope: Option<u64>, id: &str) -> Option<&(Option<Excerpt>, f64)> {
        self.entries.get(&scope?)?.get(id)
    }

    fn remember(&mut self, scope: u64, id: String, entry: Option<Excerpt>, now: f64) {
        self.order
            .retain(|(owner, key)| *owner != scope || key != &id);
        self.order.push_back((scope, id.clone()));
        self.entries
            .entry(scope)
            .or_default()
            .insert(id, (entry, now));
        if self.order.len() > 512
            && let Some((scope, id)) = self.order.pop_front()
            && let Some(entries) = self.entries.get_mut(&scope)
        {
            entries.remove(&id);
            if entries.is_empty() {
                self.entries.remove(&scope);
            }
        }
    }
}

impl Previews {
    pub(super) fn cache_scope(&self) -> Option<u64> {
        self.cache_scope
    }

    pub(super) fn active_target(&self) -> Option<&str> {
        self.target.as_deref()
    }

    #[cfg(test)]
    pub(super) fn fixture_set_scope(&mut self, scope: u64, target: Option<String>) {
        self.cache_scope = Some(scope);
        self.target = target;
    }

    pub(super) fn hide(&mut self) {
        self.hover = None;
        self.focus = None;
        self.target = None;
        self.dismissed = None;
        self.opening = None;
        self.closing = None;
        self.over_preview = false;
        self.bounds.0.set([0.0; 4]);
        self.scroll.0.set(Default::default());
        self.placement = None;
        self.plan = None;
        self.wanted.clear();
        self.due = None;
        self.flight = None;
    }
}

pub(crate) fn window_layout(s: &mut State, size: [f32; 2]) -> bool {
    if s.window_size == size {
        return false;
    }
    s.window_size = size;
    (s.wake)();
    true
}

pub(crate) fn dismiss(s: &mut State) -> bool {
    let p = &mut owner(s).previews;
    let Some(target) = p
        .opening
        .take()
        .map(|(id, _)| id)
        .or_else(|| p.target.clone())
    else {
        return false;
    };
    p.target = None;
    p.dismissed = Some(target);
    p.over_preview = false;
    p.closing = None;
    p.bounds.0.set([0.0; 4]);
    p.scroll.0.set(Default::default());
    true
}

pub(super) fn marker(s: &State, index: usize, button: El) -> El {
    let timeline = &s.transcript_display.timeline;
    let id = timeline.markers[index].id.clone();
    let scope = s.input_scope.clone();
    let button = if timeline.previews.target.as_ref() == Some(&id)
        && let Some(text) = preview_text(s, &timeline.markers[index])
    {
        let button = button.described_by(theme::KEY);
        if timeline.jump.active.as_deref() == Some(id.as_str()) {
            button.description(format!(
                "{}. {}",
                crate::strings::t("messageTimeline.current"),
                theme::description(&text),
            ))
        } else {
            button
        }
    } else {
        button
    };
    // Rune delays only unpressed hover; a held touch cannot open an excerpt.
    theme::marker_hover(button).on_hover_change(move |s: &mut State, inside, _| {
        if !s.current_scope(&scope) {
            return;
        }
        let p = &mut owner(s).previews;
        if inside {
            p.hover = Some(id.clone());
            p.dismissed = None;
        } else if p.hover.as_ref() == Some(&id) {
            p.hover = None;
        } else {
            return;
        }
        // The hover action can arrive after this frame's poll on an idle web surface.
        (s.wake)();
    })
}

fn candidates(s: &State, visible: &[Marker], target: Option<&str>, now: f64) -> Vec<String> {
    let p = &s.transcript_display.timeline.previews;
    let center = visible.len() / 2;
    let mut nearby: Vec<_> = visible.iter().enumerate().collect();
    nearby.sort_by_key(|(i, _)| i.abs_diff(center));
    let missing = target
        .and_then(|id| visible.iter().find(|m| m.id == id))
        .into_iter()
        .chain(nearby.into_iter().map(|(_, marker)| marker));
    let mut ids = Vec::<&str>::new();
    let mut wanted = Vec::new();
    for marker in missing {
        if marker.kind == MarkerKind::Reasoning || ids.contains(&marker.message.as_str()) {
            continue;
        }
        if ids.len() == 96 {
            break;
        }
        ids.push(&marker.message);
        if s.rail_excerpts
            .get(p.cache_scope, marker.message.as_str())
            .is_some_and(|(_, at)| now - at < FRESH_FOR)
            || s.messages.iter().any(|row| row.id == marker.message)
        {
            continue;
        }
        wanted.push(marker.message.to_string());
        if wanted.len() == PREVIEW_BATCH {
            break;
        }
    }
    wanted
}

pub(super) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let now = tx.clock();
    let t = &s.transcript_display.timeline;
    let position = t.scroll.get().at;
    let placement = (
        position.offset[1],
        position.viewport[1],
        t.width,
        s.window_size,
    );
    let range = rune_theme_codenomad::timeline::visible_markers(position, t.markers.len());
    let plan = (range.start, range.end, t.version, t.online);
    let visible = &t.markers[range];
    let focus = tx
        .focused()
        .filter(|id| tx.focus_visible() && visible.iter().any(|m| m.id == *id))
        .map(str::to_owned);
    let p = &t.previews;
    let rail_scrolled = p.placement.is_some_and(|old| old != placement);
    let hovered = p
        .hover
        .as_deref()
        .filter(|id| visible.iter().any(|m| m.id == *id));
    let focus_moved = p.focus != focus;
    let keyboard_moved = focus_moved && focus.is_some();
    let wanted_target = if keyboard_moved {
        focus.as_deref()
    } else {
        hovered.or(focus.as_deref())
    };
    let requested = (!rail_scrolled)
        .then_some(wanted_target)
        .flatten()
        .filter(|id| focus_moved || p.dismissed.as_deref() != Some(*id))
        .map(str::to_owned);
    let pointer_target =
        requested.as_deref().is_some_and(|id| hovered == Some(id)) && !keyboard_moved;
    let requested_changed = requested.as_deref() != p.opening.as_ref().map(|(id, _)| id.as_str());
    let wanted = (p.plan != Some(plan) || requested_changed)
        .then(|| candidates(s, visible, requested.as_deref(), now));
    let backend = t.backend.clone().filter(|_| t.online);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let p = &mut s.transcript_display.timeline.previews;
    p.placement = Some(placement);
    p.plan = Some(plan);
    if rail_scrolled {
        p.dismissed = focus.clone().or_else(|| p.hover.clone());
        p.hover = None;
        p.over_preview = false;
    } else if focus_moved {
        p.dismissed = None;
        if keyboard_moved {
            p.hover = None;
        }
    }
    p.focus = focus;
    if requested_changed {
        p.opening = requested.map(|id| {
            (
                id,
                if pointer_target {
                    now
                } else {
                    now + theme::OPEN_DELAY.as_secs_f64()
                },
            )
        });
    }
    let old = p.target.clone();
    if rail_scrolled {
        p.target = None;
        p.closing = None;
    } else if let Some((id, at)) = &p.opening {
        p.closing = None;
        if now >= *at {
            if p.target.as_ref() != Some(id) {
                p.over_preview = false;
            }
            p.target = Some(id.clone());
        } else {
            tx.wake_at(*at);
        }
    } else if !p.over_preview && p.target.is_some() {
        let at = *p.closing.get_or_insert(now + CLOSE_DELAY);
        if now >= at {
            p.target = None;
            p.closing = None;
        } else {
            tx.wake_at(at);
        }
    } else {
        p.closing = None;
    }
    let mut changed = old != p.target;
    if changed {
        p.bounds.0.set([0.0; 4]);
        p.scroll.0.set(Default::default());
    }
    if let Some(wanted) = wanted
        && wanted != p.wanted
    {
        p.flight = None;
        p.wanted = wanted;
        p.due = (!p.wanted.is_empty()).then_some(now + DELAY);
    }
    if let Some(result) = p
        .flight
        .as_ref()
        .and_then(|(_, inbox)| inbox.try_recv().ok())
    {
        match result {
            Ok(entries) => {
                let scope = *p.cache_scope.get_or_insert_with(|| s.rail_excerpts.scope());
                let mut entries: HashMap<_, _> = entries
                    .into_iter()
                    .map(|entry| (entry.id.clone(), entry))
                    .collect();
                for id in p.wanted.clone() {
                    let entry = entries.remove(&id);
                    s.rail_excerpts.remember(scope, id, entry, now);
                }
                p.plan = None;
                changed = true;
                tx.wake_after(std::time::Duration::ZERO);
            }
            Err(_) => p.wanted.clear(), // Retry on a new demand; keep the last good excerpts.
        }
        p.flight = None;
    }
    if let (Some(due), Some(backend)) = (p.due, backend) {
        if now < due {
            tx.wake_at(due);
        } else {
            p.due = None;
            let ids = p.wanted.clone();
            let (signal, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            p.flight = Some((signal, inbox));
            platform::spawn(async move {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, backend.outline_previews(&ids)).await
                    && out.send(result).await.is_ok()
                {
                    wake();
                }
            });
        }
    }
    changed
}

fn excerpt_prefix(text: &str) -> &str {
    let text = &text[..text.floor_char_boundary(text.len().min(MAX_UNITS * 4))];
    let mut left = MAX_UNITS;
    let end: usize = text
        .chars()
        .scan((), |_, ch| {
            left = left.checked_sub(ch.len_utf16())?;
            Some(ch.len_utf8())
        })
        .sum();
    text[..end].trim()
}

pub(super) fn resident<'a>(
    s: &'a State,
    marker: &Marker,
) -> Option<(crate::chat::anchors::Block<'a>, &'a crate::history::Row)> {
    let row = s.messages.iter().find(|row| row.id == marker.message)?;
    let block = crate::chat::anchors::blocks(row, crate::chat::anchors::steps(s, &row.id), false)
        .into_iter()
        .find(|block| {
            block.marker.kind == marker.kind
                && block.marker.ordinal == marker.ordinal
                && block.marker.continued == marker.continued
        })?;
    Some((block, row))
}

fn preview_text<'a>(s: &'a State, marker: &Marker) -> Option<Cow<'a, str>> {
    let t = &s.transcript_display.timeline;
    let text: Cow<'a, str> = if let Some((block, row)) = resident(s, marker) {
        match block.part.and_then(|index| row.parts.get(index)) {
            Some(Part::Tool(call)) if !call.output.is_empty() => excerpt_prefix(&format!(
                "{}\n\n{}",
                excerpt_prefix(block.text),
                excerpt_prefix(&call.output)
            ))
            .to_owned()
            .into(),
            _ => excerpt_prefix(block.text).into(),
        }
    } else {
        let entry = s
            .rail_excerpts
            .get(t.previews.cache_scope, &marker.message)?
            .0
            .as_ref()?;
        match marker.kind {
            MarkerKind::Tool => excerpt_prefix(&entry.tools),
            MarkerKind::Reasoning => return None,
            _ => excerpt_prefix(&entry.text),
        }
        .into()
    };
    (!text.is_empty()).then_some(text)
}

pub(super) fn is_shown(s: &State) -> bool {
    s.transcript_display.timeline.previews.target.is_some()
}

#[cfg(test)]
pub(super) fn scroll_offset(s: &State) -> f32 {
    s.transcript_display
        .timeline
        .previews
        .scroll
        .0
        .get()
        .0
        .offset[1]
}

pub(super) fn covers_point(s: &State, x: f32, y: f32) -> bool {
    let t = &s.transcript_display.timeline;
    if !super::demanded(s) {
        return false;
    }
    let Some(id) = t.previews.target.as_deref() else {
        return false;
    };
    let visible =
        rune_theme_codenomad::timeline::visible_markers(t.scroll.get().at, t.markers.len());
    let Some(marker) = t.markers[visible].iter().find(|m| m.id == id) else {
        return false;
    };
    if preview_text(s, marker).is_none() {
        return false;
    }
    let [rx, ry, rw, rh] = t.previews.bounds.0.get();
    rw > 0.0 && rh > 0.0 && x >= rx && x <= rx + rw && y >= ry && y <= ry + rh
}

pub(super) fn forward_wheel(s: &State, x: f32, y: f32, dy: f32, tx: &mut Tx) -> bool {
    if !covers_point(s, x, y) {
        return false;
    }
    let scroll = &s.transcript_display.timeline.previews.scroll.0;
    let (pos, target) = scroll.get();
    if dy != 0.0 && pos.max[1] > 0.0 {
        let next = (target.unwrap_or(pos.offset[1]) - dy).clamp(0.0, pos.max[1].max(0.0));
        scroll.set((pos, Some(next)));
        tx.scroll_to_instant(theme::KEY, pos.offset[0], next);
    }
    true
}

pub(crate) fn overlay(s: &State) -> Option<El> {
    if !super::demanded(s) {
        return None;
    }
    let t = &s.transcript_display.timeline;
    let id = t.previews.target.as_deref()?;
    let visible =
        rune_theme_codenomad::timeline::visible_markers(t.scroll.get().at, t.markers.len());
    let marker = t.markers[visible].iter().find(|m| m.id == id)?;
    let text = preview_text(s, marker)?;
    let id = id.to_owned();
    let scope = s.input_scope.clone();
    let scroll = t.previews.scroll.0.clone();
    Some(
        rune_theme_codenomad::timeline::preview::surface(&id, &text, s.window_size, move |at| {
            scroll.set((at, None));
        })?
        .drawn_rect_into(&t.previews.bounds.0)
        .on_hover_change(move |s: &mut State, inside, _| {
            if s.current_scope(&scope) && owner(s).previews.target.as_ref() == Some(&id) {
                owner(s).previews.over_preview = inside;
                (s.wake)();
            }
        }),
    )
}

#[cfg(test)]
mod tests;
