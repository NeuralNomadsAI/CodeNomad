//! Session-owned transcript disclosure actions.
use crate::State;
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
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
    pub(super) children: super::tools::children::Children,
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

#[derive(Default)]
struct SessionDisplay {
    reading: super::reading::Reading,
    toggled: HashSet<String>,
    expansion: HashMap<String, bool>,
    revealed: HashMap<String, usize>,
    unwrapped: HashMap<String, BTreeSet<usize>>,
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
        self.usage_family.close();
        self.pictures.clear();
        self.receipts.suspend();
    }
    pub(super) fn reading_mut(&mut self) -> &mut super::reading::Reading {
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
            let next = self.saved.remove(session).unwrap_or_default();
            self.saved.insert(
                std::mem::replace(&mut self.session, session.into()),
                std::mem::replace(&mut self.active, next),
            );
            self.stream = StreamRender::default();
            self.live_ansi.get_mut().clear();
            self.children.clear();
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

    pub(super) fn live_ansi(&self, key: &str, source: &str, wrap: bool) -> rune::El {
        let mut cache = self.live_ansi.borrow_mut();
        let prior = cache
            .iter()
            .position(|(id, _)| id == key)
            .and_then(|index| cache.remove(index));
        if source.len() > 256 * 1024 {
            return rune_theme_codenomad::ansi::code(source, wrap);
        }
        let (id, mut stream) = prior.unwrap_or_else(|| (key.into(), Default::default()));
        let output = stream.code(source, wrap);
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
            return false;
        }
        if now < stream.due {
            tx.wake_at(stream.due);
            return false;
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
        let blocks = s
            .transcript_display
            .active
            .unwrapped
            .entry(key.into())
            .or_default();
        if !blocks.remove(&index) {
            blocks.insert(index);
        }
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
        s.revision += 1;
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
