//! Session-owned transcript disclosure actions.
use crate::State;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
};

const RENDER_INTERVAL: f64 = 0.2;
const TASK_ANCHOR_LIMIT: usize = 64;

struct TaskStepsState {
    visible: Vec<String>,
    selected: Vec<String>,
    at_bottom: bool,
}

impl Default for TaskStepsState {
    fn default() -> Self {
        Self {
            visible: Vec::new(),
            selected: Vec::new(),
            at_bottom: true,
        }
    }
}

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
    pub(crate) pictures: super::media::Pictures,
    pub(crate) receipts: super::receipts::Receipts,
    pub(crate) messages: super::message_actions::Actions,
    pub(crate) queue: super::queue::Queue,
    focused_key: Option<String>,
    task_focus_pinned: std::cell::Cell<bool>,
    #[cfg(test)]
    pub(crate) task_row_builds: std::cell::Cell<usize>,
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
    expansion_serial: u64,
    expansion: HashMap<String, (u64, bool)>,
    group_search_collapsed: (u64, HashSet<String>),
    revealed: HashMap<String, usize>,
    task_revealed: HashMap<String, usize>,
    task_mount_gen: HashMap<String, u64>,
    task_anchors: VecDeque<(String, TaskStepsState)>,
    search_revealed: VecDeque<String>,
    unwrapped: HashMap<String, BTreeSet<usize>>,
    diagram_sources: HashMap<String, BTreeSet<usize>>,
    diagram_search: (u64, HashMap<String, BTreeMap<usize, bool>>),
    execute_search: (u64, HashMap<String, bool>),
    compact_diffs: (u64, HashSet<String>),
}
impl SessionDisplay {
    fn task_anchors_bytes(&self) -> usize {
        self.task_anchors
            .iter()
            .fold(0usize, |total, (key, state)| {
                total
                    .saturating_add(key.len())
                    .saturating_add(state.visible.iter().map(String::len).sum::<usize>())
                    .saturating_add(state.selected.iter().map(String::len).sum::<usize>())
            })
    }

    fn retained_bytes(&self) -> usize {
        let keys_len = |set: &HashSet<String>| set.iter().map(String::len).sum::<usize>();
        let map_keys_len =
            |keys: usize, bytes: usize| keys.saturating_mul(32).saturating_add(bytes);
        let mut total = keys_len(&self.toggled)
            .saturating_add(map_keys_len(
                self.expansion.len(),
                self.expansion.keys().map(String::len).sum(),
            ))
            .saturating_add(keys_len(&self.group_search_collapsed.1))
            .saturating_add(map_keys_len(
                self.revealed.len(),
                self.revealed.keys().map(String::len).sum(),
            ))
            .saturating_add(map_keys_len(
                self.task_revealed.len(),
                self.task_revealed.keys().map(String::len).sum(),
            ))
            .saturating_add(map_keys_len(
                self.task_mount_gen.len(),
                self.task_mount_gen.keys().map(String::len).sum(),
            ))
            .saturating_add(self.search_revealed.iter().map(String::len).sum::<usize>())
            .saturating_add(keys_len(&self.compact_diffs.1))
            .saturating_add(self.task_anchors_bytes());
        for (key, set) in &self.unwrapped {
            total = total
                .saturating_add(key.len())
                .saturating_add(set.len().saturating_mul(size_of::<usize>()));
        }
        for (key, set) in &self.diagram_sources {
            total = total
                .saturating_add(key.len())
                .saturating_add(set.len().saturating_mul(size_of::<usize>()));
        }
        total
    }
}

impl Display {
    pub(crate) fn evictable_rendered_bytes(&self, active_outline_ptr: Option<usize>) -> usize {
        let live_ansi: usize = self
            .live_ansi
            .borrow()
            .iter()
            .map(|(key, _)| key.len().saturating_add(1024))
            .sum();
        self.diffs
            .retained_bytes()
            .saturating_add(self.pictures.retained_bytes())
            .saturating_add(self.children.retained_bytes())
            .saturating_add(self.task_deliveries.borrow().retained_bytes())
            .saturating_add(live_ansi)
            .saturating_add(self.active.task_anchors_bytes())
            .saturating_add(self.saved_sessions_bytes())
            .saturating_add(self.timeline.evictable_outline_bytes(active_outline_ptr))
    }

    pub(crate) fn retained_bytes(
        &self,
        seen_outlines: &mut std::collections::HashSet<usize>,
    ) -> usize {
        let live_ansi: usize = self
            .live_ansi
            .borrow()
            .iter()
            .map(|(key, _)| key.len().saturating_add(1024))
            .sum();
        self.diffs
            .retained_bytes()
            .saturating_add(self.pictures.retained_bytes())
            .saturating_add(self.children.retained_bytes())
            .saturating_add(self.task_deliveries.borrow().retained_bytes())
            .saturating_add(live_ansi)
            .saturating_add(self.active.retained_bytes())
            .saturating_add(self.saved_sessions_bytes())
            .saturating_add(self.timeline.outline_retained_bytes(seen_outlines))
    }

    pub(crate) fn saved_sessions_bytes(&self) -> usize {
        self.saved
            .iter()
            .map(|(id, session)| id.len().saturating_add(session.retained_bytes()))
            .sum()
    }

    pub(crate) fn evict_inactive_sessions(&mut self) -> usize {
        let freed = self.saved_sessions_bytes();
        self.saved.clear();
        freed
    }

    pub(crate) fn evict_rendered(&mut self) {
        self.suspend_rendered();
        self.receipts.clear();
        self.saved.clear();
        self.timeline.evict_inactive_outline();
    }
    pub(super) fn suspend_rendered(&mut self) {
        self.messages.suspend();
        self.queue.suspend();
        self.diffs = Default::default();
        self.stream = StreamRender::default();
        self.live_ansi.get_mut().clear();
        self.children.clear();
        self.task_deliveries.get_mut().clear();
        self.tool_clock.reset();
        self.usage_family.close();
        self.pictures.clear();
        self.receipts.suspend();
        self.active.task_anchors.clear();
        self.focused_key = None;
        self.task_focus_pinned.set(false);
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
            self.queue = Default::default();
            self.timeline = Default::default();
            self.search_highlight = None;
            let mut next = self.saved.remove(session).unwrap_or_default();
            next.reading.clear_row_guard();
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
            self.focused_key = None;
            self.task_focus_pinned.set(false);
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
        self.active
            .expansion
            .get(key)
            .map_or(default, |(_, expanded)| *expanded)
    }

    pub(super) fn group_expanded(&self, keys: &[String]) -> Option<bool> {
        keys.iter()
            .filter_map(|key| self.active.expansion.get(key).copied())
            .max_by_key(|(serial, _)| *serial)
            .map(|(_, expanded)| expanded)
    }

    pub(super) fn set_expanded(s: &mut State, key: &str, expanded: bool) {
        let active = &mut s.transcript_display.active;
        active.expansion_serial = active.expansion_serial.wrapping_add(1);
        let serial = active.expansion_serial;
        active.expansion.insert(key.into(), (serial, expanded));
        s.revision += 1;
    }

    pub(super) fn set_group_expanded(s: &mut State, keys: &[String], expanded: bool) {
        let active = &mut s.transcript_display.active;
        active.expansion_serial = active.expansion_serial.wrapping_add(1);
        let serial = active.expansion_serial;
        for key in keys {
            active.expansion.insert(key.clone(), (serial, expanded));
        }
        s.revision += 1;
    }

    pub(super) fn group_search_collapsed(&self, search_id: u64, keys: &[String]) -> bool {
        let (id, collapsed) = &self.active.group_search_collapsed;
        search_id != 0 && *id == search_id && keys.iter().any(|key| collapsed.contains(key))
    }

    pub(super) fn set_group_search_collapsed(
        s: &mut State,
        search_id: u64,
        keys: &[String],
        collapsed: bool,
    ) {
        let entry = &mut s.transcript_display.active.group_search_collapsed;
        if entry.0 != search_id {
            entry.0 = search_id;
            entry.1.clear();
        }
        if collapsed {
            for key in keys {
                entry.1.insert(key.clone());
            }
        } else {
            for key in keys {
                entry.1.remove(key);
            }
        }
        s.revision += 1;
    }

    pub(super) fn card_search_expanded(&self, search_id: u64, key: &str, default: bool) -> bool {
        if search_id != 0 && self.active.execute_search.0 == search_id {
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

    pub(super) fn set_card_search_expanded(
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

    pub(super) fn execute_search_expanded(&self, search_id: u64, key: &str, default: bool) -> bool {
        self.card_search_expanded(search_id, key, default)
    }

    pub(super) fn set_execute_search_expanded(
        s: &mut State,
        search_id: u64,
        key: &str,
        expanded: bool,
    ) {
        Self::set_card_search_expanded(s, search_id, key, expanded);
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

    pub(super) fn focused_key(&self) -> Option<&str> {
        self.focused_key.as_deref()
    }

    pub(super) fn mark_task_focus_pinned(&self) {
        self.task_focus_pinned.set(true);
    }

    pub(super) fn task_anchors(&self, key: &str) -> &[String] {
        self.active
            .task_anchors
            .iter()
            .find(|(id, _)| id == key)
            .filter(|(_, state)| !state.at_bottom)
            .map_or(&[], |(_, state)| state.visible.as_slice())
    }

    pub(super) fn task_selected(&self, key: &str) -> &[String] {
        self.active
            .task_anchors
            .iter()
            .find(|(id, _)| id == key)
            .map_or(&[], |(_, state)| state.selected.as_slice())
    }

    pub(super) fn task_revealed(&self, key: &str) -> usize {
        self.active.task_revealed.get(key).copied().unwrap_or(0)
    }

    pub(super) fn task_mount_gen(&self, key: &str) -> u64 {
        self.active.task_mount_gen.get(key).copied().unwrap_or(0)
    }

    pub(super) fn set_task_visible(&mut self, key: &str, visible: Vec<String>) {
        let state = self.task_steps_entry(key);
        state.visible = visible;
    }

    pub(super) fn set_task_selected(&mut self, key: &str, selected: Vec<String>) -> bool {
        if !selected.is_empty() {
            let child_marker = format!("{key}-");
            for (other_key, other) in &mut self.active.task_anchors {
                if other_key != key
                    && !other_key.contains(&child_marker)
                    && !key.contains(&format!("{other_key}-"))
                {
                    other.selected.clear();
                }
            }
        }
        let state = self.task_steps_entry(key);
        let released = !state.selected.is_empty() && selected.is_empty() && state.at_bottom;
        state.selected = selected;
        released
    }

    pub(super) fn set_task_at_bottom(&mut self, key: &str, at_bottom: bool) -> bool {
        let state = self.task_steps_entry(key);
        let returned_to_bottom = !state.at_bottom && at_bottom;
        state.at_bottom = at_bottom;
        returned_to_bottom
    }

    pub(super) fn reveal_task_at_least(s: &mut State, key: &str, count: usize) {
        let entry = s
            .transcript_display
            .active
            .task_revealed
            .entry(key.into())
            .or_default();
        *entry = (*entry).max(count);
        s.revision += 1;
    }

    fn task_steps_entry(&mut self, key: &str) -> &mut TaskStepsState {
        if let Some(pos) = self
            .active
            .task_anchors
            .iter()
            .position(|(id, _)| id == key)
        {
            if let Some(entry) = self.active.task_anchors.remove(pos) {
                self.active.task_anchors.push_back(entry);
            }
        } else {
            if self.active.task_anchors.len() >= TASK_ANCHOR_LIMIT {
                let evict = self
                    .active
                    .task_anchors
                    .iter()
                    .position(|(_, state)| state.selected.is_empty())
                    .unwrap_or(0);
                self.active.task_anchors.remove(evict);
            }
            self.active
                .task_anchors
                .push_back((key.into(), TaskStepsState::default()));
        }
        &mut self
            .active
            .task_anchors
            .back_mut()
            .expect("entry pushed above")
            .1
    }

    pub(super) fn clear_step_anchors(&mut self, prefix: &str) {
        let nested = format!("{prefix}-");
        let pane = format!("{prefix}-task-steps");
        let pane_nested = format!("{pane}-");
        self.active.task_anchors.retain(|(key, _)| {
            key != prefix
                && !key.starts_with(&nested)
                && key != &pane
                && !key.contains(&pane_nested)
        });
        let mount_gen = self.active.task_mount_gen.entry(pane.clone()).or_default();
        *mount_gen = mount_gen.wrapping_add(1);
        if self
            .focused_key
            .as_deref()
            .is_some_and(|key| key.contains(&pane_nested) || key.ends_with(&pane))
        {
            self.focused_key = None;
            self.task_focus_pinned.set(false);
        }
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
        let mut focus_released = false;
        if s.transcript_display.focused_key != next_focus {
            s.transcript_display.focused_key = next_focus;
            if s.transcript_display.task_focus_pinned.replace(false) {
                s.revision += 1;
                focus_released = true;
            }
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
            | clock
            | focus_released;
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
