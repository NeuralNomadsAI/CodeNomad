//! Session-owned transcript disclosure actions.
use crate::State;
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
};

const RENDER_INTERVAL: f64 = 0.2;
const TASK_ANCHOR_LIMIT: usize = 32;

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
    pub(super) tool_clock: super::tools::duration::Clock,
    pub(crate) usage_family: super::usage::family::Totals,
    pub(super) pictures: super::media::Pictures,
    pub(crate) receipts: super::receipts::Receipts,
}

#[derive(Default)]
struct StreamRender {
    version: u64,
    due: f64,
    pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TaskStepsState {
    at_bottom: bool,
    visible: Vec<String>,
}

impl Default for TaskStepsState {
    fn default() -> Self {
        Self {
            at_bottom: true,
            visible: Vec::new(),
        }
    }
}

#[derive(Default)]
struct SessionDisplay {
    reading: super::reading::Reading,
    toggled: HashSet<String>,
    expansion: HashMap<String, bool>,
    revealed: HashMap<String, usize>,
    task_anchors: VecDeque<(String, TaskStepsState)>,
    unwrapped: HashMap<String, BTreeSet<usize>>,
    diagram_sources: HashMap<String, BTreeSet<usize>>,
    compact_diffs: (u64, HashSet<String>),
}
impl Display {
    pub(crate) fn evict_rendered(&mut self) {
        self.suspend_rendered();
        self.receipts.clear();
    }
    pub(super) fn suspend_rendered(&mut self) {
        self.diffs = Default::default();
        self.stream = StreamRender::default();
        self.live_ansi.get_mut().clear();
        self.children.clear();
        self.tool_clock = Default::default();
        self.usage_family.close();
        self.pictures.clear();
        self.receipts.suspend();
        self.active.task_anchors.clear();
    }
    pub(crate) fn reading_mut(&mut self) -> &mut super::reading::Reading {
        &mut self.active.reading
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
            self.timeline = Default::default();
            self.search_highlight = None;
            self.active.task_anchors.clear();
            let mut next = self.saved.remove(session).unwrap_or_default();
            next.task_anchors.clear();
            self.saved.insert(
                std::mem::replace(&mut self.session, session.into()),
                std::mem::replace(&mut self.active, next),
            );
            self.stream = StreamRender::default();
            self.live_ansi.get_mut().clear();
            self.children.clear();
            self.tool_clock = Default::default();
            self.usage_family.close();
            self.pictures.clear();
            self.receipts.clear();
            self.diffs = Default::default();
        }
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

    pub(super) fn task_anchors(&self, key: &str) -> &[String] {
        self.active
            .task_anchors
            .iter()
            .find(|(id, _)| id == key)
            .filter(|(_, state)| !state.at_bottom)
            .map_or(&[], |(_, state)| state.visible.as_slice())
    }

    pub(super) fn set_task_visible(&mut self, key: &str, visible: Vec<String>) {
        let state = self.task_steps_entry(key);
        state.visible = visible;
    }

    pub(super) fn set_task_at_bottom(&mut self, key: &str, at_bottom: bool) -> bool {
        let state = self.task_steps_entry(key);
        let returned_to_bottom = !state.at_bottom && at_bottom;
        state.at_bottom = at_bottom;
        returned_to_bottom
    }

    pub(super) fn clear_task_anchor(&mut self, key: &str) {
        self.active.task_anchors.retain(|(id, _)| id != key);
    }

    fn task_steps_entry(&mut self, key: &str) -> &mut TaskStepsState {
        if let Some(pos) = self
            .active
            .task_anchors
            .iter()
            .position(|(id, _)| id == key)
        {
            let entry = self.active.task_anchors.remove(pos).unwrap();
            self.active.task_anchors.push_back(entry);
        } else {
            if self.active.task_anchors.len() >= TASK_ANCHOR_LIMIT {
                self.active.task_anchors.pop_front();
            }
            self.active
                .task_anchors
                .push_back((key.into(), TaskStepsState::default()));
        }
        &mut self.active.task_anchors.back_mut().unwrap().1
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
        let timeline = crate::timeline::poll(s, tx)
            | crate::timeline::search::poll(s, now, tx)
            | s.transcript_display.tool_clock.poll(now, tx);
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

    pub(super) fn reveal_at_least(s: &mut State, key: &str, count: usize) {
        let steps = s
            .transcript_display
            .active
            .revealed
            .entry(key.into())
            .or_default();
        if *steps < count {
            *steps = count;
            s.revision += 1;
        }
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
