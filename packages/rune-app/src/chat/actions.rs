//! Session-owned transcript disclosure actions.
use crate::State;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
};

const RENDER_INTERVAL: f64 = 0.2;

#[derive(Default)]
pub struct Display {
    workspace: Option<(String, String)>,
    session: String,
    active: SessionDisplay,
    saved: HashMap<String, SessionDisplay>,
    stream: StreamRender,
    live_ansi: RefCell<VecDeque<(String, rune_theme_codenomad::ansi::Stream)>>,
    pub(super) diffs: super::tool_diff::Cache,
    pub(crate) timeline: crate::timeline::Timeline,
    pub(crate) search_highlight: Option<super::search_hit::SearchHit>,
    pub(super) children: super::tools::children::Children,
    pub(super) task_deliveries: RefCell<super::tools::task::DeliveryCache>,
    pub(super) tool_clock: super::tools::duration::Clock,
    pub(crate) usage_family: super::usage::family::Totals,
    pub(super) pictures: super::media::Pictures,
    pub(crate) receipts: super::receipts::Receipts,
    pub(crate) messages: super::message_actions::Actions,
    focused_key: Option<String>,
    step_scroll: RefCell<HashMap<String, std::rc::Rc<std::cell::Cell<(bool, f32)>>>>,
    step_row_rects: RefCell<
        HashMap<String, Vec<(String, std::rc::Rc<rune_theme_codenomad::layout::DrawnRect>)>>,
    >,
    step_selected: HashMap<String, Vec<String>>,
}

#[derive(Default)]
struct StreamRender {
    version: u64,
    due: f64,
    pending: bool,
}

#[derive(Default)]
struct SessionDisplay {
    reading: super::reading::Reading,
    toggled: HashSet<String>,
    expansion: HashMap<String, bool>,
    revealed: HashMap<String, usize>,
    step_anchors: RefCell<(VecDeque<String>, HashMap<String, String>)>,
    search_revealed: VecDeque<String>,
    unwrapped: HashMap<String, BTreeSet<usize>>,
    diagram_sources: HashMap<String, BTreeSet<usize>>,
    diagram_search: (u64, HashMap<String, BTreeMap<usize, bool>>),
    execute_search: (u64, HashMap<String, bool>),
    compact_diffs: (u64, HashSet<String>),
}
impl Display {
    pub(crate) fn evict_rendered(&mut self) {
        self.suspend_rendered();
        self.receipts.clear();
    }
    pub(super) fn suspend_rendered(&mut self) {
        self.messages.suspend();
        self.diffs = Default::default();
        self.stream = StreamRender::default();
        self.live_ansi.get_mut().clear();
        self.children.clear();
        self.task_deliveries.get_mut().clear();
        self.tool_clock.reset();
        self.usage_family.close();
        self.pictures.clear();
        self.receipts.suspend();
        self.step_row_rects.get_mut().clear();
        self.step_selected.clear();
    }
    pub(crate) fn reading_mut(&mut self) -> &mut super::reading::Reading {
        &mut self.active.reading
    }
    pub(super) fn reading(&self) -> &super::reading::Reading {
        &self.active.reading
    }

    pub fn bind(&mut self, server: &str, workspace: &str, session: &str) {
        if !self
            .workspace
            .as_ref()
            .is_some_and(|(a, b)| a == server && b == workspace)
        {
            *self = Self {
                workspace: Some((server.into(), workspace.into())),
                session: session.into(),
                ..Self::default()
            };
        } else if self.session != session {
            self.messages = Default::default();
            self.timeline = Default::default();
            self.search_highlight = None;
            let next = self.saved.remove(session).unwrap_or_default();
            self.saved.insert(
                std::mem::replace(&mut self.session, session.into()),
                std::mem::replace(&mut self.active, next),
            );
            self.stream = StreamRender::default();
            self.live_ansi.get_mut().clear();
            self.children.clear();
            self.tool_clock.reset();
            self.usage_family.close();
            self.pictures.clear();
            self.receipts.clear();
            self.diffs = Default::default();
            self.step_row_rects.get_mut().clear();
            self.step_selected.clear();
        }
    }

    pub(crate) fn mark_search_revealed(&mut self, key: &str) {
        if key.is_empty() {
            return;
        }
        let entries = &mut self.active.search_revealed;
        if let Some(pos) = entries.iter().position(|existing| existing == key) {
            entries.remove(pos);
        } else if entries.len() >= 64 {
            entries.pop_front();
        }
        entries.push_back(key.into());
    }

    pub(super) fn search_revealed(&self, key: &str) -> bool {
        self.active
            .search_revealed
            .iter()
            .any(|existing| existing == key)
    }

    pub fn toggled(&self, key: &str) -> bool {
        self.active.toggled.contains(key)
    }

    pub(super) fn expanded(&self, key: &str, default: bool) -> bool {
        self.active.expansion.get(key).copied().unwrap_or(default)
    }

    pub(super) fn set_expanded(s: &mut State, key: &str, expanded: bool) {
        s.transcript_display
            .active
            .expansion
            .insert(key.into(), expanded);
        s.revision += 1;
    }

    pub(super) fn execute_search_expanded(&self, search_id: u64, key: &str, default: bool) -> bool {
        if self.active.execute_search.0 == search_id {
            self.active
                .execute_search
                .1
                .get(key)
                .copied()
                .unwrap_or(default)
        } else {
            default
        }
    }

    pub(super) fn set_execute_search_expanded(
        s: &mut State,
        search_id: u64,
        key: &str,
        expanded: bool,
    ) {
        let state = &mut s.transcript_display.active.execute_search;
        if state.0 != search_id {
            state.0 = search_id;
            state.1.clear();
        }
        state.1.insert(key.into(), expanded);
        s.revision += 1;
    }

    pub(super) fn compact_split(&self, epoch: u64, key: &str) -> bool {
        self.active.compact_diffs.0 == epoch && self.active.compact_diffs.1.contains(key)
    }

    pub(super) fn set_compact_split(&mut self, epoch: u64, key: &str, split: bool) {
        let (current, cards) = &mut self.active.compact_diffs;
        if *current != epoch {
            cards.clear();
            *current = epoch;
        }
        if split {
            cards.insert(key.into());
        } else {
            cards.remove(key);
        }
    }

    pub(super) fn sync_diff_modes(
        &mut self,
        epoch: u64,
        mode: impl Fn(bool) -> crate::components::diff::DiffMode,
    ) {
        let (current, cards) = &self.active.compact_diffs;
        self.diffs
            .sync(|key| mode(*current == epoch && cards.contains(key)));
    }

    pub fn steps(&self, key: &str) -> usize {
        self.active.revealed.get(key).copied().unwrap_or_default()
    }

    pub(super) fn step_anchor(&self, key: &str) -> Option<String> {
        self.active.step_anchors.borrow().1.get(key).cloned()
    }

    pub(super) fn focused_key(&self) -> Option<&str> {
        self.focused_key.as_deref()
    }

    pub(super) fn step_scroll_state(&self, key: &str) -> std::rc::Rc<std::cell::Cell<(bool, f32)>> {
        let mut map = self.step_scroll.borrow_mut();
        if map.len() >= 64 && !map.contains_key(key) {
            map.retain(|_, flag| std::rc::Rc::strong_count(flag) > 1);
        }
        map.entry(key.into())
            .or_insert_with(|| std::rc::Rc::new(std::cell::Cell::new((false, 1.0))))
            .clone()
    }

    pub(super) fn first_visible_step(&self, key: &str, pane: [f32; 4]) -> Option<String> {
        if pane[3] <= 0.0 {
            return None;
        }
        let top = pane[1];
        let bottom = pane[1] + pane[3];
        self.step_row_rects.borrow().get(key).and_then(|rows| {
            rows.iter()
                .find(|(_, rect)| {
                    let r = rect.get();
                    r[3] > 0.0 && r[1] + r[3] > top && r[1] < bottom
                })
                .map(|(anchor, _)| anchor.clone())
        })
    }

    pub(super) fn set_step_row_rects(
        &self,
        key: &str,
        rows: Vec<(String, std::rc::Rc<rune_theme_codenomad::layout::DrawnRect>)>,
    ) {
        let mut map = self.step_row_rects.borrow_mut();
        if map.len() >= 64 && !map.contains_key(key) {
            map.clear();
        }
        map.insert(key.into(), rows);
    }

    pub(super) fn step_selected(&self, key: &str) -> &[String] {
        self.step_selected.get(key).map_or(&[], Vec::as_slice)
    }

    pub(super) fn set_step_selected(&mut self, key: &str, selected: Vec<String>) -> bool {
        if selected.is_empty() {
            return self.step_selected.remove(key).is_some();
        }
        if self
            .step_selected
            .get(key)
            .is_some_and(|cur| *cur == selected)
        {
            return false;
        }
        if self.step_selected.len() >= 64 && !self.step_selected.contains_key(key) {
            self.step_selected.clear();
        }
        self.step_selected.insert(key.into(), selected);
        true
    }

    pub(super) fn pin_step_anchor(&self, key: &str, anchor: String) {
        let mut anchors = self.active.step_anchors.borrow_mut();
        if !anchors.1.contains_key(key) {
            while anchors.1.len() >= 64 {
                if let Some(oldest) = anchors.0.pop_front() {
                    anchors.1.remove(&oldest);
                } else {
                    break;
                }
            }
            anchors.0.push_back(key.into());
        }
        anchors.1.insert(key.into(), anchor);
    }

    pub(super) fn unpin_step_anchor(&self, key: &str) {
        let mut anchors = self.active.step_anchors.borrow_mut();
        if anchors.1.remove(key).is_some() {
            anchors.0.retain(|k| k != key);
        }
    }

    pub(super) fn reveal_steps(s: &mut State, key: &str, anchor: Option<String>) {
        if let Some(anchor) = anchor {
            s.transcript_display.pin_step_anchor(key, anchor);
        }
        Self::reveal_next(s, key);
    }

    pub(super) fn clear_step_anchors(&mut self, prefix: &str) {
        let nested = format!("{prefix}-");
        let anchors = self.active.step_anchors.get_mut();
        anchors
            .1
            .retain(|key, _| key != prefix && !key.starts_with(&nested));
        anchors
            .0
            .retain(|key| key != prefix && !key.starts_with(&nested));
        self.step_scroll
            .get_mut()
            .retain(|key, _| key != prefix && !key.starts_with(&nested));
        self.step_row_rects
            .get_mut()
            .retain(|key, _| key != prefix && !key.starts_with(&nested));
        self.step_selected
            .retain(|key, _| key != prefix && !key.starts_with(&nested));
    }

    pub(super) fn live_ansi(
        &self,
        key: &str,
        source: &str,
        wrap: bool,
        query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
    ) -> rune::El {
        let mut cache = self.live_ansi.borrow_mut();
        let prior = cache
            .iter()
            .position(|(id, _)| id == key)
            .and_then(|index| cache.remove(index));
        if source.len() > 256 * 1024 {
            return rune_theme_codenomad::ansi::search_code(source, wrap, query);
        }
        let (id, mut stream) = prior.unwrap_or_else(|| (key.into(), Default::default()));
        let output = stream.code(source, wrap, query);
        if cache.len() == 4 {
            cache.pop_front();
        }
        cache.push_back((id, stream));
        output
    }

    pub fn stream_version(&self) -> u64 {
        self.stream.version
    }

    pub fn poll(s: &mut State, changed: bool, now: f64, tx: &mut rune::Tx) -> bool {
        let next_focus = tx.focused().map(str::to_owned);
        let focus_changed = s.transcript_display.focused_key != next_focus;
        if focus_changed {
            s.transcript_display.focused_key = next_focus;
        }
        let clock = if !s.history_detached
            && matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming)
        {
            let bounds = s.tool_diff_preferences.history_bounds.get();
            s.transcript_display.tool_clock.poll(now, bounds, tx)
        } else {
            s.transcript_display.tool_clock.pause();
            false
        };
        let timeline = crate::timeline::poll(s, tx)
            | crate::timeline::search::poll(s, now, tx)
            | super::tools::children::Children::poll_actions(s, tx)
            | clock;
        let stream = &mut s.transcript_display.stream;
        if changed {
            stream.pending = s.messages.last().is_some_and(|row| {
                !row.completed
                    && row.parts.iter().any(|part| {
                        matches!(part, crate::content::Part::Text(t)
                    if t.provenance != crate::content::TextProvenance::Closed
                    && t.text.encode_utf16().nth(super::document::TOOL_LIMIT).is_some())
                            || matches!(part, crate::content::Part::Reasoning(t)
                            if t.provenance != crate::content::TextProvenance::Closed
                                && t.units > super::document::TOOL_LIMIT)
                    })
            });
        }
        if !stream.pending {
            return timeline;
        }
        if now < stream.due {
            tx.wake_at(stream.due);
            return timeline;
        }
        stream.pending = false;
        stream.due = now + RENDER_INTERVAL;
        stream.version += 1;
        s.revision += 1;
        true
    }

    pub fn unwrapped(&self, key: &str) -> BTreeSet<usize> {
        self.active.unwrapped.get(key).cloned().unwrap_or_default()
    }

    pub fn toggle_code(s: &mut State, key: &str, index: usize) {
        toggle_index(&mut s.transcript_display.active.unwrapped, key, index);
        s.revision += 1;
    }

    pub(super) fn diagram_sources(&self, key: &str) -> BTreeSet<usize> {
        self.active
            .diagram_sources
            .get(key)
            .cloned()
            .unwrap_or_default()
    }

    pub(super) fn toggle_diagram_source(s: &mut State, key: &str, index: usize) {
        toggle_index(&mut s.transcript_display.active.diagram_sources, key, index);
        s.revision += 1;
    }

    pub(super) fn diagram_search_overrides(
        &self,
        search_id: u64,
        key: &str,
    ) -> BTreeMap<usize, bool> {
        if search_id == 0 || self.active.diagram_search.0 != search_id {
            return BTreeMap::new();
        }
        self.active
            .diagram_search
            .1
            .get(key)
            .cloned()
            .unwrap_or_default()
    }

    pub(super) fn set_diagram_search_override(
        s: &mut State,
        search_id: u64,
        key: &str,
        index: usize,
        source_only: bool,
    ) {
        let entry = &mut s.transcript_display.active.diagram_search;
        if entry.0 != search_id {
            entry.0 = search_id;
            entry.1.clear();
        }
        entry
            .1
            .entry(key.into())
            .or_default()
            .insert(index, source_only);
        s.revision += 1;
    }

    pub fn toggle(s: &mut State, key: &str) {
        let toggled = &mut s.transcript_display.active.toggled;
        if !toggled.remove(key) {
            toggled.insert(key.into());
        }
        s.revision += 1;
    }

    pub fn reveal_next(s: &mut State, key: &str) {
        let steps = s
            .transcript_display
            .active
            .revealed
            .entry(key.into())
            .or_default();
        *steps = steps.saturating_add(1);
        if key.starts_with("parts-gap-") {
            crate::timeline::structure_changed(s);
        }
        s.revision += 1;
    }
}

fn toggle_index(groups: &mut HashMap<String, BTreeSet<usize>>, key: &str, index: usize) {
    let indices = groups.entry(key.into()).or_default();
    if !indices.remove(&index) {
        indices.insert(index);
    }
}

#[cfg(test)]
#[test]
fn disclosure_survives_session_switch_and_never_crosses_workspaces() {
    let mut s = crate::init();
    let key = "message";
    s.transcript_display.bind("server", "project", "a");
    Display::reveal_next(&mut s, key);
    Display::toggle(&mut s, key);
    s.transcript_display.bind("server", "project", "b");
    assert_eq!(s.transcript_display.steps(key), 0);
    assert!(!s.transcript_display.toggled(key));
    s.transcript_display.bind("server", "project", "a");
    assert_eq!(s.transcript_display.steps(key), 1);
    assert!(s.transcript_display.toggled(key));
    s.transcript_display.bind("other", "project", "a");
    assert_eq!(s.transcript_display.steps(key), 0);
}
