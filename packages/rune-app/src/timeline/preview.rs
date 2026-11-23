//! Hover/focus excerpts owned by the rail, never by the conversation reader.
use super::{Marker, MarkerKind, owner};
use crate::{State, content::Part, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    history::Result,
    timeline::{Excerpt, PREVIEW_BATCH},
};
use rune::{El, Tx};
use std::{
    borrow::Cow,
    collections::{HashMap, VecDeque},
};

const CACHE: usize = 512;
const FRESH_FOR: f64 = 30.0;
const DELAY: f64 = 0.08;
const MAX_UNITS: usize = 4096;

#[derive(Default)]
pub(super) struct Previews {
    hover: Option<String>,
    focus: Option<String>,
    target: Option<String>,
    dismissed: Option<String>,
    placement: Option<(f32, [f32; 2])>,
    wanted: Vec<String>,
    due: Option<f64>,
    flight: Option<(Sender<()>, Receiver<Result<Vec<Excerpt>>>)>,
    cache: HashMap<String, (Option<Excerpt>, f64)>,
    order: VecDeque<String>,
}

impl Previews {
    pub(super) fn hide(&mut self) {
        self.hover = None;
        self.focus = None;
        self.target = None;
        self.dismissed = None;
        self.placement = None;
        self.wanted.clear();
        self.due = None;
        self.flight = None;
    }

    fn remember(&mut self, id: String, entry: Option<Excerpt>, now: f64) {
        self.order.retain(|key| key != &id);
        self.order.push_back(id.clone());
        self.cache.insert(id, (entry, now));
        if self.cache.len() > CACHE
            && let Some(oldest) = self.order.pop_front()
        {
            self.cache.remove(&oldest);
        }
    }
}

pub(crate) fn dismiss(s: &mut State) -> bool {
    let p = &mut owner(s).previews;
    let Some(target) = p.target.take() else {
        return false;
    };
    p.dismissed = Some(target);
    true
}

pub(super) fn marker(s: &State, index: usize, button: El) -> El {
    let timeline = &s.transcript_display.timeline;
    let id = timeline.markers[index].id.clone();
    let scope = s.input_scope.clone();
    let button = if timeline.previews.target.as_ref() == Some(&id) {
        button.described_by(rune_theme_codenomad::timeline::preview::KEY)
    } else {
        button
    };
    button.on_hover_change(move |s: &mut State, inside, _| {
        if !s.current_scope(&scope) {
            return;
        }
        let p = &mut owner(s).previews;
        if inside {
            p.hover = Some(id.clone());
            p.dismissed = None;
        } else if p.hover.as_ref() == Some(&id) {
            p.hover = None;
        }
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
    let mut wanted = Vec::<String>::new();
    for marker in missing {
        if marker.kind == MarkerKind::Reasoning
            || p.cache
                .get(marker.message.as_str())
                .is_some_and(|(_, at)| now - at < FRESH_FOR)
            || s.messages.iter().any(|row| row.id == marker.message)
            || wanted.contains(&marker.message)
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
    let placement = (position.offset[1], position.viewport);
    let range = rune_theme_codenomad::timeline::visible_markers(position, t.markers.len());
    let visible = &t.markers[range];
    let focus = tx
        .focused()
        .filter(|id| visible.iter().any(|m| m.id == *id))
        .map(str::to_owned);
    let p = &t.previews;
    let rail_scrolled = p.placement.is_some_and(|old| old != placement);
    let wanted_target = p
        .hover
        .as_deref()
        .filter(|id| visible.iter().any(|m| m.id == *id))
        .or(focus.as_deref());
    let target = if rail_scrolled {
        None
    } else {
        wanted_target
            .filter(|id| p.dismissed.as_deref() != Some(*id))
            .map(str::to_owned)
    };
    let mut changed = target != p.target;
    let wanted = candidates(s, visible, target.as_deref(), now);
    let backend = t.backend.clone().filter(|_| t.online);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let p = &mut owner(s).previews;
    p.placement = Some(placement);
    if rail_scrolled {
        p.dismissed = p.target.clone().or(focus.clone());
        p.hover = None;
    } else if p.focus != focus && p.hover.is_none() {
        p.dismissed = None;
    }
    p.focus = focus;
    p.target = target;
    if wanted != p.wanted {
        p.flight = None;
        p.wanted = wanted;
        p.due = (!p.wanted.is_empty()).then_some(now + DELAY);
    }
    if let Some(result) = p
        .flight
        .as_ref()
        .and_then(|(_, inbox)| inbox.try_recv().ok())
    {
        let mut entries: HashMap<_, _> = result
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        for id in p.wanted.clone() {
            let entry = entries.remove(&id);
            p.remember(id, entry, now);
        }
        p.flight = None;
        changed = true;
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

pub(crate) fn overlay(s: &State) -> Option<El> {
    if !super::demanded(s) {
        return None;
    }
    let t = &s.transcript_display.timeline;
    let id = t.previews.target.as_deref()?;
    let visible =
        rune_theme_codenomad::timeline::visible_markers(t.scroll.get().at, t.markers.len());
    let marker = t.markers[visible].iter().find(|m| m.id == id)?;
    let text: Cow<'_, str> = if let Some((block, row)) = resident(s, marker) {
        match block.part.and_then(|index| row.parts.get(index)) {
            Some(Part::Tool(call)) if !call.output.is_empty() => {
                format!("{}\n\n{}", excerpt_prefix(block.text), excerpt_prefix(&call.output)).into()
            }
            _ => excerpt_prefix(block.text).into(),
        }
    } else {
        let entry = t.previews.cache.get(&marker.message)?.0.as_ref()?;
        match marker.kind {
            MarkerKind::Tool => excerpt_prefix(&entry.tools),
            MarkerKind::Reasoning => return None,
            _ => excerpt_prefix(&entry.text),
        }
        .into()
    };
    (!text.is_empty()).then(|| rune_theme_codenomad::timeline::preview::surface(id, &text))
}
