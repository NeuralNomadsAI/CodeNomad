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

#[derive(Default)]
pub(super) struct Previews {
    hover: Option<String>,
    focus: Option<String>,
    target: Option<String>,
    dismissed: Option<String>,
    opening: Option<(String, f64)>,
    closing: Option<f64>,
    over_preview: bool,
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
    pub(super) fn hide(&mut self) {
        self.hover = None;
        self.focus = None;
        self.target = None;
        self.dismissed = None;
        self.opening = None;
        self.closing = None;
        self.over_preview = false;
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
    Some(
        rune_theme_codenomad::timeline::preview::surface(&id, &text, s.window_size)?
            .on_hover_change(move |s: &mut State, inside, _| {
                if s.current_scope(&scope) && owner(s).previews.target.as_ref() == Some(&id) {
                    owner(s).previews.over_preview = inside;
                    (s.wake)();
                }
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Cx, Env, Key, KeyEvent, Runtime};

    fn marker(i: usize, kind: MarkerKind) -> Marker {
        Marker {
            id: format!("marker-{i}"),
            message: format!("message-{i}"),
            kind,
            ordinal: 0,
            continued: false,
            tool: None,
        }
    }

    #[test]
    fn a_target_precedes_nearby_unique_messages_and_recent_absences_are_cached() {
        let mut s = crate::init();
        let markers = (0..40)
            .map(|i| marker(i, MarkerKind::Assistant))
            .collect::<Vec<_>>();
        let scope = s.rail_excerpts.scope();
        owner(&mut s).previews.cache_scope = Some(scope);
        s.rail_excerpts
            .remember(scope, "message-1".into(), None, 10.0);
        let mut visible = vec![
            marker(0, MarkerKind::Reasoning),
            marker(2, MarkerKind::Tool),
        ];
        visible.extend(markers);
        let ids = candidates(&s, &visible, Some("marker-39"), 20.0);
        assert_eq!(ids[0], "message-39");
        assert_eq!(ids.len(), PREVIEW_BATCH);
        assert!(!ids.contains(&"message-1".into()));
        assert!(candidates(&s, &visible[..4], None, 41.0).contains(&"message-1".into()));
    }

    fn runtime(text: String, size: (f32, f32)) -> Runtime<State> {
        fn view(s: &State, cx: &mut Cx<State>) -> El {
            rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx))
                .on_layout_tx(|s, [_, _, w, h], tx| {
                    if !window_layout(s, [w, h]) {
                        tx.live_only();
                    }
                })
        }
        let mut s = crate::init();
        let scope = s.rail_excerpts.scope();
        s.rail_excerpts.remember(
            scope,
            "message-0".into(),
            Some(Excerpt {
                id: "message-0".into(),
                text,
                tools: String::new(),
            }),
            0.0,
        );
        let t = owner(&mut s);
        t.width = size.0;
        t.previews.cache_scope = Some(scope);
        t.markers.push(marker(0, MarkerKind::Assistant));
        let mut rt = Runtime::new(s, view, size, Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.on_key = Some(crate::shell::keys);
        settle(&mut rt);
        rt
    }

    fn settle(rt: &mut Runtime<State>) {
        for _ in 0..30 {
            rt.frame(0.016);
        }
    }

    #[test]
    fn focused_marker_opens_and_escape_keeps_the_same_focus() {
        let mut rt = runtime("**Cached rail excerpt**".into(), (800., 600.));
        rt.update(|_, tx| tx.focus_when_shown("marker-0", true));
        settle(&mut rt);
        assert!(rt.find("timeline-peek").is_some());
        rt.key(KeyEvent {
            key: Key::Escape,
            mods: Default::default(),
        });
        for _ in 0..6 {
            rt.frame(0.016);
        }
        assert!(rt.find("timeline-peek").is_none());
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.key.as_deref() == Some("marker-0") && el.focused)
        );
        let (x, y) = rt.find("marker-0").unwrap();
        rt.pointer_move(x, y);
        for _ in 0..30 {
            rt.frame(0.016);
        }
        assert!(rt.find("timeline-peek").is_some());
        let (x, y) = rt.find("timeline-peek").unwrap();
        rt.pointer_move(x, y);
        for _ in 0..30 {
            rt.frame(0.016);
        }
        assert!(rt.find("timeline-peek").is_some());
        rt.key(KeyEvent {
            key: Key::Escape,
            mods: Default::default(),
        });
        rt.frame(0.016);
        assert!(rt.find("timeline-peek").is_none());
        let (x, y) = rt.find("marker-0").unwrap();
        rt.pointer_move(x, y);
        for _ in 0..30 {
            rt.frame(0.016);
        }
        assert!(rt.find("timeline-peek").is_some());
        rt.set_viewport((850., 600.), 1.);
        for _ in 0..30 {
            rt.frame(0.016);
        }
        assert!(rt.find("timeline-peek").is_none());
    }

    #[test]
    fn touch_never_opens_and_a_clicked_marker_does_not_keep_the_preview() {
        let mut rt = runtime("Touch fixture".into(), (800., 600.));
        let (x, y) = rt.find("marker-0").unwrap();
        rt.touch(1, rune::TouchPhase::Started, x, y, 1.);
        for _ in 0..34 {
            rt.frame(0.016);
            assert!(rt.find("timeline-peek").is_none());
        }
        rt.touch(1, rune::TouchPhase::Ended, x, y, 1.54);
        settle(&mut rt);
        assert!(rt.find("timeline-peek").is_none());
        let mut rt = runtime("Click fixture".into(), (800., 600.));
        let (x, y) = rt.find("marker-0").unwrap();
        rt.pointer_move(x, y);
        settle(&mut rt);
        assert!(rt.find("timeline-peek").is_some());
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        // Hold the marker's non-keyboard focus even when the fixture cannot resolve its jump.
        rt.update(|_, tx| tx.focus_when_shown("marker-0", false));
        settle(&mut rt);
        rt.pointer_move(10., y);
        settle(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.key.as_deref() == Some("marker-0") && el.focused && !el.focus_visible)
        );
        assert!(rt.find("timeline-peek").is_none());
    }

    #[test]
    fn short_window_scrolls_and_exposes_the_complete_rendered_description() {
        let text = format!(
            "**Beginning** [link](https://example.invalid)\n\n{}Final `token`",
            "Line of text.\n\n".repeat(80)
        );
        let mut rt = runtime(text, (800., 290.));
        rt.update(|_, tx| tx.focus_when_shown("marker-0", true));
        settle(&mut rt);
        let key = rune_theme_codenomad::timeline::preview::KEY;
        let [x, y, w, h] = rt.presented(key).unwrap().0;
        assert!(y >= 0. && y + h <= 290. && h <= 258.);
        fn named<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
            if node["key"] == key {
                Some(node)
            } else {
                node["children"]
                    .as_array()?
                    .iter()
                    .find_map(|child| named(child, key))
            }
        }
        let tree = rt.accessibility_json();
        let button = named(&tree, "marker-0").unwrap();
        assert_eq!(
            button["description"],
            format!("Beginning link {}Final token", "Line of text. ".repeat(80))
        );
        let tail = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|el| {
                    el.path.contains(key)
                        && el
                            .text
                            .as_deref()
                            .is_some_and(|text| text.starts_with("Beginning"))
                })
                .map(|el| el.rect[1])
        };
        let before = tail(&rt).unwrap();
        rt.pointer_move(x + w / 2., y + h / 2.);
        rt.wheel(x + w / 2., y + h / 2., -3500.);
        settle(&mut rt);
        assert!(rt.find(key).is_some());
        assert!(tail(&rt).is_none_or(|y| y < before));
    }

    #[test]
    fn excerpt_limit_is_shared_by_tab_caches_but_not_between_windows() {
        let mut s = crate::init();
        let tab = s.rail_excerpts.scope();
        owner(&mut s).previews.cache_scope = Some(tab);
        for i in 0..512 {
            s.rail_excerpts
                .remember(tab, format!("message-{i}"), None, 0.);
        }
        let display = std::mem::take(&mut s.transcript_display);
        let other = s.rail_excerpts.scope();
        s.rail_excerpts
            .remember(other, "message-0".into(), None, 1.);
        s.transcript_display = display;
        assert_eq!(s.rail_excerpts.order.len(), 512);
        let restored = owner(&mut s).previews.cache_scope;
        assert!(s.rail_excerpts.get(restored, "message-0").is_none());
        assert!(s.rail_excerpts.get(Some(other), "message-0").is_some());
        assert!(crate::init().rail_excerpts.order.is_empty());
    }
}
