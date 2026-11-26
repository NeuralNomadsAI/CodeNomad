use crate::State;
use rune::{El, Tx};
use rune_theme_codenomad::layout::DrawnRect;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::{Rc, Weak},
};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Bookmark {
    Latest,
    Message { id: String, offset: f32 },
}

const ROTATION_VISIBLE_FLOOR: f32 = 24.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ScrollObserved {
    offset: f32,
    prev_offset: f32,
    max: f32,
    viewport_w: f32,
    viewport_h: f32,
    seq: u64,
    manual_seq: u64,
    ignore_manual_once: bool,
    ignore_remount_bottom: bool,
    pending_scroll_commit: bool,
}

impl ScrollObserved {
    fn at_bottom(self) -> bool {
        self.max <= 0.5 || self.offset >= self.max - 0.5
    }

    fn coasting(self) -> bool {
        self.seq > 1 && (self.offset - self.prev_offset).abs() > 0.5
    }

    fn user_moved_from(self, prev: Self) -> bool {
        prev.seq > 0
            && !prev.ignore_manual_once
            && !(prev.ignore_remount_bottom && self.at_bottom())
            && (self.viewport_w - prev.viewport_w).abs() <= 0.5
            && self.viewport_h <= prev.viewport_h + 0.5
            && (self.offset - prev.offset).abs() > 0.5
            && !(prev.at_bottom() && self.at_bottom())
            && !(self.max < prev.max - 0.5 && self.at_bottom())
            && !((self.max - prev.max).abs() > 0.5
                && ((self.offset - prev.offset) - (self.max - prev.max)).abs() <= 0.5)
    }

    fn user_scrolled_from(self, observed_offset: f32, observed_at_bottom: bool) -> bool {
        if self.seq == 0 {
            return false;
        }
        if observed_at_bottom && self.at_bottom() {
            return false;
        }
        (self.offset - observed_offset.min(self.max)).abs() > 0.5
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ResizeAnchor {
    id: String,
    offset: f32,
    height: Option<f32>,
    may_rescue: bool,
    rescued: bool,
    clamped: bool,
    settling: bool,
    observed: Option<(f32, bool)>,
    settle_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
enum FrameRestoreTarget {
    Offset,
    Anchor(String, f32),
    FromBottom,
}

#[derive(Clone, Debug, PartialEq)]
struct FrameRestore {
    epoch: u64,
    obs_offset: f32,
    obs_max: f32,
    obs_seq: u64,
    target: FrameRestoreTarget,
    probe_live: bool,
    handled: bool,
    checked: Cell<Option<Option<f32>>>,
}

pub(crate) struct Reading {
    scope: Rc<()>,
    following: bool,
    at_bottom: bool,
    top: Option<(String, f32, f32)>,
    top_manual_seq: u64,
    min_record_revision: u64,
    resize_anchor: Option<ResizeAnchor>,
    frame_restore_epoch: u64,
    frame_restore: Option<FrameRestore>,
    last_touch_probe_seq: Cell<u64>,
    scroll_state: Rc<Cell<ScrollObserved>>,
    live_rows: Rc<RefCell<HashMap<String, (Weak<()>, DrawnRect)>>>,
    passage: Option<Passage>,
    jump: Option<String>,
    lookup: Option<Jump>,
}

struct Passage {
    message: String,
    key: String,
    offset: f32,
    mode: Option<crate::settings::TranscriptRow>,
}

struct Jump {
    scope: std::rc::Rc<()>,
    position: Option<String>,
    result: codenomad_client::Receiver<Option<String>>,
}

impl Default for Reading {
    fn default() -> Self {
        Self {
            scope: Rc::new(()),
            following: true,
            at_bottom: true,
            top: None,
            top_manual_seq: 0,
            min_record_revision: 0,
            resize_anchor: None,
            frame_restore_epoch: 0,
            frame_restore: None,
            last_touch_probe_seq: Cell::new(0),
            scroll_state: Rc::new(Cell::new(ScrollObserved::default())),
            live_rows: Rc::new(RefCell::new(HashMap::new())),
            passage: None,
            jump: None,
            lookup: None,
        }
    }
}

impl Reading {
    pub(super) fn scope(&self) -> Rc<()> {
        self.scope.clone()
    }

    pub(super) fn same_scope(&self, scope: &Rc<()>) -> bool {
        Rc::ptr_eq(&self.scope, scope)
    }

    fn scroll_state(&self) -> Rc<Cell<ScrollObserved>> {
        self.scroll_state.clone()
    }

    pub(super) fn manual_scroll_seq(&self) -> u64 {
        self.scroll_state.get().manual_seq
    }

    pub(super) fn scroll_seq(&self) -> u64 {
        self.scroll_state.get().seq
    }

    pub(super) fn pending_scroll_commit(&self) -> bool {
        self.scroll_state.get().pending_scroll_commit
    }

    pub(super) fn has_pending_restore_probe(&self) -> bool {
        self.frame_restore.as_ref().is_some_and(|fr| {
            !fr.handled && fr.probe_live && matches!(fr.checked.get(), None | Some(Some(_)))
        })
    }

    pub(super) fn top_is_fresh(&self) -> bool {
        self.top_manual_seq == self.scroll_state.get().manual_seq
    }

    fn live_row_handle(&self, id: &str) -> (Rc<()>, DrawnRect) {
        let mut rows = self.live_rows.borrow_mut();
        if let Some((weak, live)) = rows.get(id)
            && let Some(alive) = weak.upgrade()
        {
            return (alive, live.clone());
        }
        if rows.len() > 64 {
            rows.retain(|_, (weak, _)| weak.strong_count() > 0);
        }
        let alive = Rc::new(());
        let live = DrawnRect::new([0.0; 4]);
        rows.insert(id.into(), (Rc::downgrade(&alive), live.clone()));
        (alive, live)
    }

    pub(crate) fn live_bookmark_fresh(
        &self,
        history_bounds: [f32; 4],
        gap: bool,
    ) -> Option<Bookmark> {
        if self.top_is_fresh() || self.resize_anchor.is_some() {
            let bookmark = self.bookmark(gap);
            if !gap || !matches!(bookmark, Bookmark::Latest) {
                return Some(bookmark);
            }
        }
        let cur = self.scroll_state.get();
        if cur.pending_scroll_commit {
            return None;
        }
        if !gap && cur.seq > 0 && cur.at_bottom() {
            return Some(Bookmark::Latest);
        }
        if history_bounds[3] > 0.0 && history_bounds[1].is_finite() {
            let rows = self.live_rows.borrow();
            let mut hit: Option<(String, f32)> = None;
            for (id, (weak, live)) in rows.iter() {
                if weak.strong_count() == 0 {
                    continue;
                }
                let rect = live.get();
                if Self::hits_probe(history_bounds[1], rect) {
                    let offset = rect[1] - history_bounds[1];
                    if hit.as_ref().is_none_or(|(_, best)| offset > *best) {
                        hit = Some((id.clone(), offset));
                    }
                }
            }
            if let Some((id, offset)) = hit {
                return Some(Bookmark::Message { id, offset });
            }
        }
        None
    }

    pub(crate) fn live_bookmark(&self, history_bounds: [f32; 4], gap: bool) -> Bookmark {
        self.live_bookmark_fresh(history_bounds, gap)
            .unwrap_or_else(|| self.bookmark(gap))
    }

    pub(super) fn arm_frame_restore(&mut self) {
        self.arm_frame_restore_target(FrameRestoreTarget::Offset, true);
    }

    pub(super) fn arm_frame_restore_for(&mut self, bookmark: &Bookmark, had_manual_scroll: bool) {
        let cur = self.scroll_state.get();
        let probe_live = !had_manual_scroll && self.top_is_fresh() && !cur.coasting();
        let target = match bookmark {
            Bookmark::Latest => FrameRestoreTarget::FromBottom,
            Bookmark::Message { id, offset } => FrameRestoreTarget::Anchor(id.clone(), *offset),
        };
        self.arm_frame_restore_target(target, probe_live);
    }

    fn arm_frame_restore_target(&mut self, target: FrameRestoreTarget, probe_live: bool) {
        let cur = self.scroll_state.get();
        if cur.seq > 0 {
            self.frame_restore_epoch += 1;
            self.frame_restore = Some(FrameRestore {
                epoch: self.frame_restore_epoch,
                obs_offset: cur.offset,
                obs_max: cur.max,
                obs_seq: cur.seq,
                target,
                probe_live,
                handled: false,
                checked: Cell::new(None),
            });
        } else {
            self.frame_restore = None;
        }
    }

    pub(crate) fn note_programmatic_scroll(&self) {
        let mut cur = self.scroll_state.get();
        cur.ignore_manual_once = true;
        self.scroll_state.set(cur);
    }

    pub(super) fn note_suspend_remount(&self) {
        let mut cur = self.scroll_state.get();
        cur.ignore_remount_bottom = true;
        self.scroll_state.set(cur);
    }

    fn bump_manual_scroll(&self) {
        let mut cur = self.scroll_state.get();
        cur.manual_seq += 1;
        cur.ignore_remount_bottom = false;
        self.scroll_state.set(cur);
    }

    pub(crate) fn note_pending_manual_scroll(&self) {
        let mut cur = self.scroll_state.get();
        cur.manual_seq += 1;
        cur.ignore_remount_bottom = false;
        cur.pending_scroll_commit = true;
        self.scroll_state.set(cur);
    }

    pub(super) fn reset_to_latest(&mut self, min_revision: u64) {
        self.following = true;
        self.at_bottom = true;
        self.top = None;
        self.passage = None;
        self.jump = None;
        self.top_manual_seq = self.scroll_state.get().manual_seq;
        self.min_record_revision = self.min_record_revision.max(min_revision);
        self.resize_anchor = None;
        self.frame_restore = None;
        self.note_programmatic_scroll();
    }

    pub(super) fn apply_restored(&mut self, bookmark: &Bookmark, revision: u64, width_grew: bool) {
        match bookmark {
            Bookmark::Latest => self.reset_to_latest(revision),
            Bookmark::Message { id, offset } => {
                if width_grew {
                    self.passage = None;
                }
                let prev_height = self
                    .top
                    .as_ref()
                    .filter(|(top_id, _, height)| top_id == id && *height > 0.0)
                    .map(|(_, _, height)| *height);
                self.following = false;
                self.top = Some((id.clone(), *offset, prev_height.unwrap_or(0.0)));
                self.top_manual_seq = self.scroll_state.get().manual_seq;
                self.min_record_revision = self.min_record_revision.max(revision);
                self.frame_restore = None;
                self.note_programmatic_scroll();
                self.resize_anchor = Some(ResizeAnchor {
                    id: id.clone(),
                    offset: *offset,
                    height: prev_height,
                    may_rescue: width_grew && *offset < 0.0,
                    rescued: false,
                    clamped: false,
                    settling: true,
                    observed: None,
                    settle_seq: Some(self.scroll_state.get().seq + 1),
                });
            }
        }
    }

    // Rune (`1d78d5688`, unchanged in `a1fbe7ff5`) suppresses `on_drawn_layout_tx` when a rebuilt
    // row keeps the same drawn rect; remove once `on_drawn_layout_tx` can re-fire on revision bumps.
    pub(super) fn rescue_target_if_evicted(
        &mut self,
        messages: &[crate::history::Row],
        history_bounds: [f32; 4],
    ) -> Option<Bookmark> {
        if !(history_bounds[3] > 0.0 && history_bounds[1].is_finite()) {
            return None;
        }
        let anchor = self.resize_anchor.as_mut()?;
        if !anchor.may_rescue || anchor.offset >= 0.0 || anchor.rescued || anchor.clamped {
            return None;
        }
        let anchor_pos = messages.iter().position(|row| row.id == anchor.id)?;
        let mut evicted_past_anchor = false;
        {
            let rows = self.live_rows.borrow();
            for (id, (weak, live)) in rows.iter() {
                if weak.strong_count() == 0 {
                    continue;
                }
                if !Self::hits_probe(history_bounds[1], live.get()) {
                    continue;
                }
                if id == &anchor.id {
                    return None;
                }
                if messages
                    .iter()
                    .position(|row| row.id == *id)
                    .is_some_and(|pos| pos > anchor_pos)
                {
                    evicted_past_anchor = true;
                }
            }
        }
        if !evicted_past_anchor {
            return None;
        }
        anchor.rescued = true;
        anchor.may_rescue = false;
        anchor.settling = false;
        anchor.settle_seq = None;
        anchor.observed = None;
        Some(Bookmark::Message {
            id: anchor.id.clone(),
            offset: 0.0,
        })
    }

    pub(super) fn hold(&mut self, message: String) {
        self.following = false;
        self.top = Some((message, 0.0, 0.0));
        self.top_manual_seq = self.scroll_state.get().manual_seq;
        self.resize_anchor = None;
        self.frame_restore = None;
    }
    pub(super) fn settle(&mut self, attempted: &str, confirmed: Option<&str>) {
        let mut live_rows = self.live_rows.borrow_mut();
        if let Some(entry) = live_rows.remove(attempted)
            && let Some(id) = confirmed
        {
            live_rows.insert(id.into(), entry);
        }
        drop(live_rows);
        if let Some((id, offset, height)) = &self.top
            && id == attempted
        {
            self.top = confirmed.map(|id| (id.into(), *offset, *height));
        }
        if let Some(anchor) = &self.resize_anchor
            && anchor.id == attempted
        {
            self.resize_anchor = confirmed.map(|id| ResizeAnchor {
                id: id.into(),
                offset: anchor.offset,
                height: anchor.height,
                may_rescue: anchor.may_rescue,
                rescued: anchor.rescued,
                clamped: anchor.clamped,
                settling: anchor.settling,
                observed: anchor.observed,
                settle_seq: anchor.settle_seq,
            });
        }
    }

    pub(crate) fn bookmark(&self, gap: bool) -> Bookmark {
        if gap || !self.following {
            if let Some(anchor) = &self.resize_anchor {
                return Bookmark::Message {
                    id: anchor.id.clone(),
                    offset: anchor.offset,
                };
            }
            if let Some((id, offset, _)) = &self.top {
                return Bookmark::Message {
                    id: id.clone(),
                    offset: *offset,
                };
            }
        }
        Bookmark::Latest
    }

    pub(crate) fn restore(bookmark: &Bookmark, tx: &mut Tx) {
        tx.instant();
        match bookmark {
            Bookmark::Latest => {
                tx.scroll_to_bottom_instant("history");
                // Also append to scroll_offsets so Latest beats an earlier same-frame scroll_key_to.
                tx.scroll_to_y("history", f32::MAX);
            }
            Bookmark::Message { id, offset } => tx.scroll_key_to(id, *offset),
        };
    }

    fn on_at_bottom(&mut self, at_bottom: bool, pending_resize: bool, gap: bool) {
        let seq = self.scroll_state.get().seq;
        if let Some(anchor) = &mut self.resize_anchor
            && anchor.settling
            && anchor.settle_seq.is_some_and(|limit| seq > limit)
        {
            anchor.settling = false;
            anchor.settle_seq = None;
        }
        let in_flight = self
            .resize_anchor
            .as_ref()
            .is_some_and(|anchor| anchor.rescued || anchor.settling);
        self.at_bottom = at_bottom;
        if !at_bottom {
            self.following = false;
            let keep_anchor = self
                .resize_anchor
                .as_ref()
                .is_some_and(|anchor| anchor.rescued || anchor.may_rescue);
            if !keep_anchor {
                self.resize_anchor = None;
            }
        } else if !pending_resize && !in_flight {
            self.following = true;
            if !gap {
                self.top_manual_seq = self.scroll_state.get().manual_seq;
            }
            self.resize_anchor = None;
        } else if !pending_resize
            && let Some(anchor) = &mut self.resize_anchor
            && anchor.settling
        {
            anchor.settling = false;
            anchor.settle_seq = None;
        }
    }

    fn arm_resize_anchor(&mut self, revision: u64, id: String, offset: f32, width_grew: bool) {
        self.min_record_revision = self.min_record_revision.max(revision);
        let cur = self.scroll_state.get();
        let keep_rescue = self
            .resize_anchor
            .as_ref()
            .is_some_and(|anchor| anchor.id == id && anchor.may_rescue);
        let keep_rescued = self
            .resize_anchor
            .as_ref()
            .is_some_and(|anchor| anchor.id == id && anchor.rescued);
        let height = self
            .resize_anchor
            .as_ref()
            .filter(|anchor| anchor.id == id)
            .and_then(|anchor| anchor.height)
            .or_else(|| {
                self.top
                    .as_ref()
                    .filter(|(top_id, _, height)| top_id == &id && *height > 0.0)
                    .map(|(_, _, height)| *height)
            });
        self.resize_anchor = Some(ResizeAnchor {
            id,
            offset,
            height,
            may_rescue: !keep_rescued && (width_grew || keep_rescue),
            rescued: keep_rescued,
            clamped: false,
            settling: false,
            observed: (!keep_rescued && cur.seq > 0)
                .then_some((cur.offset, self.at_bottom || cur.at_bottom())),
            settle_seq: None,
        });
    }

    pub(super) fn advance_row_guard(&mut self, revision: u64) {
        self.min_record_revision = self.min_record_revision.max(revision);
    }

    pub(super) fn clear_row_guard(&mut self) {
        self.scope = Rc::new(());
        self.min_record_revision = 0;
        self.frame_restore = None;
        self.live_rows.borrow_mut().clear();
    }

    fn hits_probe(top: f32, [_, y, _, height]: [f32; 4]) -> bool {
        let probe = top + 0.5;
        top.is_finite()
            && y.is_finite()
            && height.is_finite()
            && height > 0.0
            && y <= probe
            && y + height > probe
    }

    fn record_for_revision(
        &mut self,
        revision: u64,
        id: &str,
        top: f32,
        rect: [f32; 4],
        is_after_anchor: impl FnOnce(&str, &str) -> bool,
    ) -> Option<(String, f32)> {
        let cur = self.scroll_state.get();
        if let Some(anchor) = &self.resize_anchor
            && let Some((obs_offset, obs_at_bottom)) = anchor.observed
            && cur.user_scrolled_from(obs_offset, obs_at_bottom)
        {
            self.resize_anchor = None;
        }
        if let Some(anchor) = &mut self.resize_anchor
            && anchor.id == id
            && (!anchor.rescued || revision >= self.min_record_revision)
            && rect[3].is_finite()
            && rect[3] > 0.0
        {
            anchor.may_rescue = false;
            if revision >= self.min_record_revision {
                anchor.settling = false;
                anchor.settle_seq = None;
            }
            if anchor.offset < 0.0 {
                let target_visible = match anchor.height {
                    Some(prev_h) if rect[3] < prev_h - 0.5 => Some(
                        (prev_h + anchor.offset)
                            .max(0.0)
                            .min(ROTATION_VISIBLE_FLOOR),
                    ),
                    None if rect[3] + anchor.offset <= 0.5 => Some(ROTATION_VISIBLE_FLOOR),
                    _ => None,
                };
                let actual = rect[1] - top;
                if let Some(target_visible) = target_visible {
                    let floor = -(rect[3] - rect[3].min(target_visible)).max(0.0);
                    if anchor.offset < floor - 0.5 || anchor.rescued {
                        anchor.offset = floor;
                        anchor.height = Some(rect[3]);
                        anchor.rescued = false;
                        anchor.clamped = true;
                        anchor.observed = None;
                        if self.at_bottom && floor <= actual + 0.5 {
                            self.top = Some((id.into(), actual, rect[3]));
                            self.top_manual_seq = cur.manual_seq;
                            return None;
                        }
                        anchor.settling = true;
                        anchor.settle_seq = Some(cur.seq + 1);
                        self.top = Some((id.into(), floor, rect[3]));
                        self.top_manual_seq = cur.manual_seq;
                        return Some((id.into(), floor));
                    }
                } else if anchor.rescued {
                    let target = anchor.offset;
                    anchor.rescued = false;
                    anchor.clamped = true;
                    anchor.observed = None;
                    if self.at_bottom && target <= actual + 0.5 {
                        self.top = Some((id.into(), actual, rect[3]));
                        self.top_manual_seq = cur.manual_seq;
                        return None;
                    }
                    anchor.settling = true;
                    anchor.settle_seq = Some(cur.seq + 1);
                    return Some((id.into(), target));
                }
            }
        }
        if let Some(anchor) = &mut self.resize_anchor
            && anchor.may_rescue
            && anchor.id != id
            && anchor.offset < 0.0
            && !anchor.rescued
            && !anchor.clamped
            && Self::hits_probe(top, rect)
            && is_after_anchor(&anchor.id, id)
        {
            anchor.rescued = true;
            anchor.may_rescue = false;
            anchor.settling = false;
            anchor.settle_seq = None;
            anchor.observed = None;
            return Some((anchor.id.clone(), 0.0));
        }
        if revision < self.min_record_revision {
            return None;
        }
        if !Self::hits_probe(top, rect) {
            return None;
        }
        if let Some(anchor) = &mut self.resize_anchor {
            anchor.settling = false;
            anchor.settle_seq = None;
            if self.at_bottom {
                return None;
            }
        }
        self.resize_anchor = None;
        self.record(id, top, rect);
        None
    }

    fn record(&mut self, id: &str, top: f32, [_, y, _, height]: [f32; 4]) {
        if Self::hits_probe(top, [0.0, y, 0.0, height]) {
            self.top = Some((id.into(), y - top, height));
            self.top_manual_seq = self.scroll_state.get().manual_seq;
        }
        if self.jump.as_deref() == Some(id) && height > 0.0 && y <= top + 1.0 && y + height > top {
            self.jump = None;
        }
    }
}

pub(crate) fn passage_target(s: &State) -> Option<(String, f32)> {
    let reading = s.transcript_display.reading();
    if !reading.following
        && let (Some((message, _, _)), Some(passage)) = (&reading.top, &reading.passage)
        && *message == passage.message
        && passage
            .mode
            .is_none_or(|row| crate::settings::transcript_mode(s, row) != "hidden")
    {
        let group = matches!(
            passage.mode,
            Some(
                crate::settings::TranscriptRow::Tool(_)
                    | crate::settings::TranscriptRow::Thinking
                    | crate::settings::TranscriptRow::Groups
            )
        )
        .then(|| super::tool_groups::Groups::project(s).collapsed_anchor(s, message, &passage.key))
        .flatten();
        if let Some(anchor) = group {
            // Keep small reading offsets (within a header's height) intact so toggling groups
            // does not jump, but reset deep offsets inside a long collapsed fragment so the
            // short group header is never pushed off-screen above the viewport.
            let offset = if passage.offset < -24.0 {
                0.0
            } else {
                passage.offset
            };
            Some((anchor, offset))
        } else {
            Some((format!("{message}/{}", passage.key), passage.offset))
        }
    } else {
        None
    }
}

pub(crate) fn keep_passage(s: &State, tx: &mut Tx) {
    if s.reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::defers_scroll)
    {
        return;
    }
    if let Some((key, offset)) = passage_target(s) {
        s.transcript_display.reading().note_programmatic_scroll();
        tx.scroll_key_to(key, offset);
    }
}

pub(super) fn passage(
    s: &State,
    body: El,
    message: &str,
    key: String,
    mode: Option<crate::settings::TranscriptRow>,
    marker: Option<codenomad_client::timeline::Marker<'_>>,
) -> El {
    let scope = s.input_scope.clone();
    let message = message.to_owned();
    let body = body.key(key.clone());
    let observe = move |s: &mut State, [_, y, _, height]: [f32; 4], tx: &mut Tx| {
        if s.current_scope(&scope) {
            let [_, top, _, viewport] = s.tool_diff_preferences.history_bounds.get();
            let reading = s.transcript_display.reading_mut();
            if viewport > 0.0 && y <= top && y + height > top {
                reading.passage = Some(Passage {
                    message: message.clone(),
                    key: key.clone(),
                    offset: y - top,
                    mode,
                });
            } else if reading
                .passage
                .as_ref()
                .is_some_and(|old| old.message == message && old.key == key)
            {
                reading.passage = None;
            }
        }
        tx.live_only();
    };
    if let Some(marker) = marker {
        crate::timeline::watch_block(s, marker, body, observe)
    } else {
        body.on_drawn_layout_tx(observe)
    }
}
fn user_position(s: &State) -> Option<&str> {
    let reading = s.transcript_display.reading();
    reading.jump.as_deref().or_else(|| {
        (!reading.following || s.history_detached).then_some(reading.top.as_ref()?.0.as_str())
    })
}

fn user_target(s: &State, previous: bool) -> Option<String> {
    let current = user_position(s);
    let position = current.and_then(|id| s.messages.iter().position(|row| row.id == id));
    let rows = if previous {
        &s.messages[..position.unwrap_or(s.messages.len())]
    } else {
        &s.messages[position? + 1..]
    };
    let user = |row: &&crate::history::Row| row.role == "user";
    (if previous {
        rows.iter().rev().find(user)
    } else {
        rows.iter().find(user)
    })
    .map(|row| row.id.clone())
}

fn can_read(s: &State) -> bool {
    !s.screen.is_launcher()
        && !crate::git::has_preview(s)
        && !crate::files::has_preview(s)
        && !crate::workspace::mission_has_reader(s)
        && matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming)
}

fn outside_window(s: &State, previous: bool) -> bool {
    s.reader.is_some()
        && if previous {
            s.can_older
        } else {
            s.history_detached
        }
}

pub(crate) fn can_jump_user(s: &State, previous: bool) -> bool {
    can_read(s) && (user_target(s, previous).is_some() || outside_window(s, previous))
}

fn reveal(s: &mut State, id: String, tx: &mut Tx) {
    let reading = s.transcript_display.reading_mut();
    reading.jump = Some(id.clone());
    reading.resize_anchor = None;
    reading.frame_restore = None;
    if s.messages.iter().any(|row| row.id == id) {
        reading.note_programmatic_scroll();
        tx.scroll_key_to(id, 0.0);
        tx.instant();
    } else if let Some(reader) = &mut s.reader {
        reader.resume(Bookmark::Message { id, offset: 0.0 });
    }
}

pub(crate) fn jump_user(s: &mut State, previous: bool, tx: &mut Tx) -> bool {
    if !can_jump_user(s, previous) {
        return false;
    }
    s.transcript_display.reading_mut().lookup = None;
    if let Some(id) = user_target(s, previous) {
        reveal(s, id, tx);
        return true;
    }
    let Some(backend) = s.composer.picker.backend().cloned() else {
        return false;
    };
    let current = user_position(s).map(str::to_owned);
    let (send, recv) = codenomad_client::bounded(1);
    let wake = s.wake.clone();
    s.transcript_display.reading_mut().lookup = Some(Jump {
        scope: s.input_scope.clone(),
        position: current.clone(),
        result: recv,
    });
    crate::platform::spawn(async move {
        use codenomad_client::timeline::{Kind, OutlineRevision};
        let revision = OutlineRevision::default();
        let outline = codenomad_client::runtime::until_closed(
            &send,
            backend.read_outline_cached(&revision, None, None, |_| ()),
        )
        .await;
        let id = if let Some(Ok(outline)) = outline {
            let position = current
                .as_ref()
                .and_then(|id| outline.entries.iter().position(|row| &row.id == id));
            let entries = &outline.entries;
            if previous {
                entries[..position.unwrap_or(entries.len())]
                    .iter()
                    .rev()
                    .find(|row| row.kind == Kind::User)
            } else {
                position.and_then(|i| entries[i + 1..].iter().find(|row| row.kind == Kind::User))
            }
            .map(|row| row.id.clone())
        } else {
            None
        };
        if send.try_send(id).is_ok() {
            wake();
        }
    });
    true
}

pub(crate) fn poll_jump(s: &mut State, tx: &mut Tx) -> bool {
    let reading = s.transcript_display.reading_mut();
    let Some(id) = reading
        .lookup
        .as_ref()
        .and_then(|jump| jump.result.try_recv().ok())
    else {
        return false;
    };
    let Some(jump) = reading.lookup.take() else {
        return false;
    };
    if s.current_scope(&jump.scope)
        && user_position(s) == jump.position.as_deref()
        && can_read(s)
        && let Some(id) = id
    {
        reveal(s, id, tx);
        return true;
    }
    false
}

pub(crate) fn viewport(s: &State, history: El, scroll_stack: bool) -> El {
    let reading_scope = s.transcript_display.reading().scope();
    let wheel_scope = reading_scope.clone();
    let wheel_input_scope = s.input_scope.clone();
    let scroll_state = s.transcript_display.reading().scroll_state();
    let timeline_scroll = crate::timeline::observe_history_scroll(s);
    let layout_scope = s.input_scope.clone();
    let watch_wheel = s.transcript_display.reading().resize_anchor.is_some()
        || s.transcript_display
            .reading()
            .frame_restore
            .as_ref()
            .is_some_and(|fr| fr.checked.get() != Some(None))
        || s.reader.as_ref().is_some_and(|r| r.defers_scroll());
    let history = history
        .on_scroll_offset(move |at| {
            let prev = scroll_state.get();
            let mut next = ScrollObserved {
                offset: at.offset[1],
                prev_offset: prev.offset,
                max: at.max[1],
                viewport_w: at.viewport[0],
                viewport_h: at.viewport[1],
                seq: prev.seq + 1,
                manual_seq: prev.manual_seq,
                ignore_manual_once: false,
                ignore_remount_bottom: false,
                pending_scroll_commit: false,
            };
            if next.user_moved_from(prev) {
                next.manual_seq = prev.manual_seq + 1;
            }
            scroll_state.set(next);
            timeline_scroll(at);
        })
        .on_layout_tx(move |s: &mut State, rect, tx| {
            if !s.screen.is_launcher() {
                crate::chat::ToolDiffPreferences::history_layout(s, rect, scroll_stack, tx);
                if s.current_scope(&layout_scope)
                    && !s
                        .reader
                        .as_ref()
                        .is_some_and(crate::chat::reader::Reader::awaiting_manual_probe)
                    && s.reader
                        .as_ref()
                        .is_some_and(crate::chat::reader::Reader::has_pending_scroll)
                {
                    tx.wake_after(std::time::Duration::ZERO);
                }
            } else {
                tx.live_only();
            }
        })
        .on_at_bottom_if(move |s: &mut State, following| {
            if !s.screen.is_launcher() && s.transcript_display.reading().same_scope(&reading_scope)
            {
                let pending_resize = s.tool_diff_preferences.has_pending_resize()
                    || s.reader
                        .as_ref()
                        .is_some_and(crate::chat::reader::Reader::awaiting_manual_probe);
                let gap = s.history_detached
                    || s.reader
                        .as_ref()
                        .is_some_and(crate::chat::reader::Reader::has_gap);
                s.transcript_display
                    .reading_mut()
                    .on_at_bottom(following, pending_resize, gap);
            }
            false
        });
    history.on_wheel(move |s: &mut State, ev, tx| {
        let handled = if watch_wheel {
            handle_reading_wheel(s, &wheel_scope, &ev, tx)
        } else {
            false
        };
        crate::timeline::observe_history_wheel(s, &wheel_input_scope, &ev, tx, !handled);
        handled
    })
}

fn handle_reading_wheel(
    s: &mut State,
    wheel_scope: &Rc<()>,
    ev: &rune::WheelEvent,
    tx: &mut Tx,
) -> bool {
    if s.screen.is_launcher()
        || !s.transcript_display.reading().same_scope(&wheel_scope)
        || !ev.dy.is_finite()
        || ev.dy.abs() <= 0.001
    {
        return false;
    }
    let reading = s.transcript_display.reading_mut();
    if let Some(fr) = reading.frame_restore.as_mut()
        && reading.scroll_state.get().seq == fr.obs_seq
    {
        let obs_max = fr.obs_max;
        let obs_seq = fr.obs_seq;
        let target = (fr.obs_offset - ev.dy).clamp(0.0, obs_max);
        let delta = fr.obs_offset - target;
        let moved_history = delta.abs() > 0.5;
        if !moved_history && matches!(fr.target, FrameRestoreTarget::FromBottom) {
            return false;
        }
        let wants_older = ev.dy > 0.0;
        let wants_newer = ev.dy < 0.0;
        if moved_history
            && s.reader
                .as_ref()
                .is_some_and(|reader| reader.can_undo_sync(wants_older, wants_newer))
            && crate::chat::reader::undo_sync_for_manual_scroll(s, obs_seq + 1, tx)
        {
            let reading = s.transcript_display.reading_mut();
            if let Some(fr) = reading.frame_restore.as_mut() {
                fr.target = FrameRestoreTarget::Offset;
                fr.obs_offset = target;
                fr.handled = true;
                fr.checked.set(Some(None));
            }
            reading.resize_anchor = None;
            reading.bump_manual_scroll();
            let at_bottom = obs_max <= 0.5 || target >= obs_max - 0.5;
            reading.at_bottom = at_bottom;
            reading.following = at_bottom;
            s.revision += 1;
            s.transcript_display
                .reading_mut()
                .advance_row_guard(s.revision);
            tx.instant();
            tx.scroll_to_y("history", target);
            return true;
        }
        let reading = s.transcript_display.reading_mut();
        let fr = reading.frame_restore.as_mut().unwrap();
        fr.obs_offset = target;
        if matches!(fr.target, FrameRestoreTarget::FromBottom) {
            fr.probe_live = true;
            fr.handled = false;
            fr.checked.set(Some(Some(target)));
            reading.resize_anchor = None;
            reading.bump_manual_scroll();
            s.revision += 1;
            return true;
        }
        fr.handled = true;
        let anchor = match &mut fr.target {
            FrameRestoreTarget::Anchor(id, anchor_offset) => {
                *anchor_offset += delta;
                Some((id.clone(), *anchor_offset))
            }
            FrameRestoreTarget::Offset | FrameRestoreTarget::FromBottom => None,
        };
        reading.resize_anchor = None;
        if moved_history {
            reading.bump_manual_scroll();
        }
        let at_bottom = obs_max <= 0.5 || target >= obs_max - 0.5;
        reading.at_bottom = at_bottom;
        reading.following = at_bottom;
        s.revision += 1;
        s.transcript_display
            .reading_mut()
            .advance_row_guard(s.revision);
        tx.instant();
        if let Some((id, anchor_offset)) = anchor {
            tx.scroll_key_to(id, anchor_offset);
        } else {
            tx.scroll_to_y("history", target);
        }
        return moved_history;
    }
    let cur = reading.scroll_state.get();
    let target = (cur.offset - ev.dy).clamp(0.0, cur.max);
    if cur.seq > 0 && (target - cur.offset).abs() > 0.5 {
        reading.note_pending_manual_scroll();
        reading.resize_anchor = None;
        reading.frame_restore = None;
    }
    false
}

fn live_history_offset(cx: &rune::Cx<State>) -> Option<f32> {
    // Query all four layout subscriptions unconditionally so Rune registers them in one frame.
    let rows_unscrolled = rune_theme_codenomad::layout::layout_rect(cx, "rows");
    let rows_scrolled = rune_theme_codenomad::layout::window_layout(cx, "rows");
    let hist_unscrolled = rune_theme_codenomad::layout::layout_rect(cx, "history");
    let hist_scrolled = rune_theme_codenomad::layout::window_layout(cx, "history");
    let (Some(rows_unscrolled), Some(rows_scrolled), Some(hist_unscrolled), Some(hist_scrolled)) = (
        rows_unscrolled,
        rows_scrolled,
        hist_unscrolled,
        hist_scrolled,
    ) else {
        return None;
    };
    let live_offset =
        (rows_unscrolled[1] - rows_scrolled[1]) - (hist_unscrolled[1] - hist_scrolled[1]);
    live_offset.is_finite().then_some(live_offset)
}

pub(crate) fn probe_resuming_scroll(s: &State, cx: &rune::Cx<State>) {
    if s.screen.is_launcher()
        || !s
            .reader
            .as_ref()
            .is_some_and(crate::chat::reader::Reader::is_resuming)
    {
        return;
    }
    let reading = s.transcript_display.reading();
    let cur = reading.scroll_state.get();
    if cur.seq <= 1
        || cur.ignore_manual_once
        || cur.coasting()
        || reading.last_touch_probe_seq.get() == cur.seq
    {
        return;
    }
    let Some(live_offset) = live_history_offset(cx) else {
        return;
    };
    if (live_offset - cur.offset).abs() > 0.5 {
        reading.last_touch_probe_seq.set(cur.seq);
        reading.note_pending_manual_scroll();
    }
}

pub(crate) fn wheel_restore_probe(s: &State, cx: &rune::Cx<State>) -> Option<El> {
    let reading = s.transcript_display.reading();
    let fr = reading.frame_restore.as_ref()?;
    if fr.handled || !fr.probe_live {
        return None;
    }
    let target = match fr.checked.get() {
        Some(Some(target)) => target,
        Some(None) => return None,
        None => {
            if reading.scroll_state.get().seq != fr.obs_seq {
                fr.checked.set(Some(None));
                return None;
            }
            let live_offset = live_history_offset(cx)?;
            let detected = ((live_offset - fr.obs_offset).abs() > 0.5)
                .then(|| live_offset.clamp(0.0, fr.obs_max));
            fr.checked.set(Some(detected));
            detected?
        }
    };
    let obs_offset = fr.obs_offset;
    let max = fr.obs_max;
    let epoch = fr.epoch;
    let scope = reading.scope();
    Some(
        rune_theme_codenomad::layout::layout_probe(format!("reading-wheel-restore-{epoch}"))
            .on_layout_tx(move |s: &mut State, _, tx| {
                if s.screen.is_launcher() || !s.transcript_display.reading().same_scope(&scope) {
                    tx.live_only();
                    return;
                }
                let reading = s.transcript_display.reading_mut();
                if reading
                    .frame_restore
                    .as_ref()
                    .is_none_or(|cur| cur.epoch != epoch)
                {
                    tx.live_only();
                    return;
                }
                let fr = reading.frame_restore.take().unwrap();
                reading.resize_anchor = None;
                let cur = reading.scroll_state.get();
                let wants_older = target < obs_offset - 0.5;
                let wants_newer = target > obs_offset + 0.5;
                if s.reader
                    .as_ref()
                    .is_some_and(|reader| reader.can_undo_sync(wants_older, wants_newer))
                    && crate::chat::reader::undo_sync_for_manual_scroll(s, cur.seq + 1, tx)
                {
                    let reading = s.transcript_display.reading_mut();
                    reading.bump_manual_scroll();
                    let at_bottom = max <= 0.5 || target >= max - 0.5;
                    reading.at_bottom = at_bottom;
                    reading.following = at_bottom;
                    s.revision += 1;
                    s.transcript_display
                        .reading_mut()
                        .advance_row_guard(s.revision);
                    tx.instant();
                    tx.scroll_to_y("history", target);
                    return;
                }
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
                let reading = s.transcript_display.reading_mut();
                match fr.target {
                    FrameRestoreTarget::Anchor(id, anchor_offset) => {
                        let delta = obs_offset - target;
                        reading.bump_manual_scroll();
                        let at_bottom = max <= 0.5 || target >= max - 0.5;
                        reading.at_bottom = at_bottom;
                        reading.following = at_bottom;
                        s.revision += 1;
                        s.transcript_display
                            .reading_mut()
                            .advance_row_guard(s.revision);
                        tx.instant();
                        tx.scroll_key_to(id, anchor_offset + delta);
                    }
                    FrameRestoreTarget::FromBottom => {
                        let dest = (cur.max - (max - target).max(0.0)).clamp(0.0, cur.max);
                        if (cur.offset - dest).abs() <= 0.5 {
                            let at_bottom = cur.at_bottom();
                            reading.at_bottom = at_bottom;
                            reading.following = at_bottom;
                            tx.live_only();
                            return;
                        }
                        reading.bump_manual_scroll();
                        let at_bottom = cur.max <= 0.5 || dest >= cur.max - 0.5;
                        reading.at_bottom = at_bottom;
                        reading.following = at_bottom;
                        s.revision += 1;
                        s.transcript_display
                            .reading_mut()
                            .advance_row_guard(s.revision);
                        tx.instant();
                        tx.scroll_to_y("history", dest);
                    }
                    FrameRestoreTarget::Offset => {
                        if (cur.offset - target).abs() <= 0.5 {
                            let at_bottom = cur.at_bottom();
                            reading.at_bottom = at_bottom;
                            reading.following = at_bottom;
                            tx.live_only();
                            return;
                        }
                        let at_bottom = max <= 0.5 || target >= max - 0.5;
                        reading.at_bottom = at_bottom;
                        reading.following = at_bottom;
                        s.revision += 1;
                        s.transcript_display
                            .reading_mut()
                            .advance_row_guard(s.revision);
                        tx.instant();
                        tx.scroll_to_y("history", target);
                    }
                }
            }),
    )
}

pub(crate) fn preserve_on_resize(
    s: &mut State,
    tx: &mut Tx,
    width_changed: bool,
    width_grew: bool,
) {
    if s.messages.is_empty()
        || s.reader
            .as_ref()
            .is_some_and(|reader| reader.defers_scroll())
    {
        return;
    }
    let revision = s.revision;
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let reading = s.transcript_display.reading_mut();
    let bookmark = s.reader.as_ref().map_or_else(
        || reading.live_bookmark(history_bounds, false),
        |reader| reader.bookmark_at(reading, history_bounds),
    );
    match &bookmark {
        Bookmark::Latest => {}
        Bookmark::Message { id, offset } => {
            if reading.resize_anchor.is_some() && reading.at_bottom {
                let cur = reading.scroll_state.get();
                let user_scrolled = reading
                    .resize_anchor
                    .as_ref()
                    .and_then(|anchor| anchor.observed)
                    .is_some_and(|(obs_offset, obs_at_bottom)| {
                        cur.user_scrolled_from(obs_offset, obs_at_bottom)
                    });
                if user_scrolled {
                    reading.resize_anchor = None;
                    reading.frame_restore = None;
                    let at_bottom = cur.at_bottom();
                    reading.at_bottom = at_bottom;
                    reading.following = at_bottom;
                    return;
                }
                s.revision += 1;
                let next = s.revision;
                let reading = s.transcript_display.reading_mut();
                reading.arm_resize_anchor(next, id.clone(), *offset, width_grew);
                reading.arm_frame_restore();
                if let Some(anchor) = &mut reading.resize_anchor {
                    anchor.observed = None;
                    anchor.settling = true;
                    anchor.settle_seq = Some(cur.seq + 1);
                }
                reading.note_programmatic_scroll();
                tx.instant();
                Reading::restore(&bookmark, tx);
            } else if width_changed {
                reading.frame_restore = None;
                reading.arm_resize_anchor(revision, id.clone(), *offset, width_grew);
            } else if reading.at_bottom {
                reading.frame_restore = None;
                reading.arm_resize_anchor(revision, id.clone(), *offset, false);
            }
        }
    }
}

pub(crate) fn restore_position(s: &mut State, tx: &mut Tx) {
    tx.instant();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let reading = s.transcript_display.reading_mut();
    reading.frame_restore = None;
    reading.note_programmatic_scroll();
    let bookmark = s.reader.as_ref().map_or_else(
        || reading.live_bookmark(history_bounds, false),
        |reader| reader.bookmark_at(reading, history_bounds),
    );
    Reading::restore(&bookmark, tx);
}

pub(super) fn row(s: &State, id: String, view: El) -> El {
    let reading = s.transcript_display.reading();
    let reading_scope = reading.scope();
    let (row_alive, row_rect) = reading.live_row_handle(&id);
    let revision = s.revision;
    let scope = s.input_scope.clone();
    let lease = super::receipts::Receipts::lease(s, &id);
    let receipt = super::receipts::for_message(s, &id);
    view.drawn_rect_into(&row_rect)
        .children(receipt)
        .on_drawn_layout_tx(move |s: &mut State, rect, tx| {
            let _alive = &row_alive;
            if !s.screen.is_launcher() && s.transcript_display.reading().same_scope(&reading_scope)
            {
                let bounds = s.tool_diff_preferences.history_bounds.get();
                if s.current_scope(&scope) {
                    let visible = bounds[3] > 0.0
                        && rect[3] > 0.0
                        && rect[1] < bounds[1] + bounds[3]
                        && rect[1] + rect[3] > bounds[1];
                    if super::receipts::Receipts::demand(s, &id, visible, &lease) {
                        tx.wake_after(std::time::Duration::ZERO);
                    }
                }
                if bounds[3] > 0.0 {
                    let messages = &s.messages;
                    if let Some((anchor_id, offset)) = s
                        .transcript_display
                        .reading_mut()
                        .record_for_revision(revision, &id, bounds[1], rect, |anchor_id, row_id| {
                            let anchor_pos = messages.iter().position(|m| m.id == anchor_id);
                            let row_pos = messages.iter().position(|m| m.id == row_id);
                            matches!((anchor_pos, row_pos), (Some(a), Some(r)) if r > a)
                        })
                    {
                        s.revision += 1;
                        let next = s.revision;
                        let reading = s.transcript_display.reading_mut();
                        reading.advance_row_guard(next);
                        reading.note_programmatic_scroll();
                        tx.instant();
                        tx.scroll_key_to(anchor_id, offset);
                        return;
                    }
                }
            }
            tx.live_only();
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bookmark_captures_the_native_row_and_its_signed_viewport_offset() {
        let mut reading = Reading::default();
        reading.following = false;
        reading.record("previous", 100.0, [0.0, 30.0, 500.0, 60.0]);
        reading.record("anchor", 100.0, [0.0, 80.0, 500.0, 60.0]);
        reading.record("next", 100.0, [0.0, 140.0, 500.0, 60.0]);
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -20.0
            }
        );
        reading.following = true;
        assert_eq!(reading.bookmark(false), Bookmark::Latest);
        assert_eq!(
            reading.bookmark(true),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -20.0,
            }
        );
    }

    #[test]
    fn resize_guard_blocks_stale_rows_clamps_rotation_and_keeps_clamped_anchor() {
        let mut reading = Reading::default();
        reading.on_at_bottom(false, false, false);
        reading.record_for_revision(4, "anchor", 100.0, [0.0, 88.0, 360.0, 60.0], |_, _| false);
        reading.arm_resize_anchor(5, "anchor".into(), -12.0, false);
        // An off-probe overscan row at revision 5 must not admit stale revision 4 rows.
        assert_eq!(
            reading
                .record_for_revision(5, "overscan", 100.0, [0.0, 10.0, 720.0, 40.0], |_, _| true),
            None
        );
        assert_eq!(
            reading.record_for_revision(4, "drifted", 100.0, [0.0, 95.0, 720.0, 40.0], |_, _| true),
            None
        );
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -12.0,
            }
        );

        // First user scroll after a height-only resize must not be cancelled as a rescue
        // even when the unchanged anchored row never emitted a callback during the resize.
        assert_eq!(
            reading.record_for_revision(
                5,
                "passage-14",
                100.0,
                [0.0, 92.0, 360.0, 60.0],
                |_, _| true
            ),
            None
        );
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "passage-14".into(),
                offset: -8.0,
            }
        );

        // Growing the viewport clamps at bottom (pending_resize=true): keep original anchor
        // across a resize even if an earlier row lands at probe while at_bottom=true.
        reading.record_for_revision(5, "anchor", 100.0, [0.0, 88.0, 360.0, 60.0], |_, _| false);
        reading.arm_resize_anchor(6, "anchor".into(), -12.0, true);
        reading.on_at_bottom(true, true, false);
        assert_eq!(
            reading
                .record_for_revision(6, "earlier", 100.0, [0.0, 96.0, 720.0, 50.0], |_, _| false),
            None
        );
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -12.0,
            }
        );

        // Height-only resize with < 24px visible of the anchored row must not drift when row height is unchanged.
        reading.on_at_bottom(false, false, false);
        reading.record_for_revision(7, "shallow", 100.0, [0.0, 8.0, 390.0, 100.0], |_, _| false);
        reading.arm_resize_anchor(8, "shallow".into(), -92.0, false);
        reading.on_at_bottom(true, true, false);
        assert_eq!(
            reading
                .record_for_revision(8, "shallow", 100.0, [0.0, 8.0, 390.0, 100.0], |_, _| false),
            None
        );
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "shallow".into(),
                offset: -92.0,
            }
        );

        // An off-probe overscan row at the new revision must not clear resize_anchor before
        // the shortened anchored row delivers its drawn callback.
        reading.on_at_bottom(false, false, false);
        reading.record_for_revision(9, "long", 100.0, [0.0, -50.0, 320.0, 190.0], |_, _| false);
        reading.arm_resize_anchor(10, "long".into(), -150.0, true);
        assert_eq!(
            reading.record_for_revision(
                10,
                "overscan",
                100.0,
                [0.0, -240.0, 720.0, 40.0],
                |_, _| true
            ),
            None
        );
        assert_eq!(
            reading.record_for_revision(10, "long", 100.0, [0.0, -50.0, 720.0, 80.0], |_, _| false),
            Some(("long".into(), -56.0))
        );
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "long".into(),
                offset: -56.0,
            }
        );

        // If a very tall paragraph shortens out of overscan AND clamps at bottom on width growth,
        // rescue it even while at_bottom=true, keep rescued state across the jump away from bottom,
        // then clamp to -floor without letting a subsequent bottom clamp reset following=true.
        reading.on_at_bottom(false, false, false);
        reading.record_for_revision(11, "huge", 100.0, [0.0, -1070.0, 320.0, 1200.0], |_, _| {
            false
        });
        reading.arm_resize_anchor(12, "huge".into(), -1170.0, true);
        reading.on_at_bottom(true, true, false);
        assert_eq!(
            reading.record_for_revision(
                12,
                "tail-15",
                100.0,
                [0.0, 95.0, 844.0, 40.0],
                |anchor, row| anchor == "huge" && row == "tail-15"
            ),
            Some(("huge".into(), 0.0))
        );
        reading.advance_row_guard(13);
        // Moving up to huge:0.0 leaves bottom before huge delivers its drawn callback.
        reading.on_at_bottom(false, false, false);
        assert_eq!(
            reading
                .record_for_revision(13, "huge", 100.0, [0.0, 100.0, 844.0, 200.0], |_, _| false),
            Some(("huge".into(), -176.0))
        );
        reading.advance_row_guard(14);
        // Even if the clamp returns to bottom, settling protects following=false until the row commits.
        reading.on_at_bottom(true, false, false);
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "huge".into(),
                offset: -176.0,
            }
        );
        assert_eq!(
            reading
                .record_for_revision(14, "huge", 100.0, [0.0, -76.0, 844.0, 200.0], |_, _| false),
            None
        );

        // Reaching bottom outside a pending resize resumes following immediately.
        reading.on_at_bottom(true, false, false);
        assert_eq!(reading.bookmark(false), Bookmark::Latest);

        // Frame-1 width-growth eviction rescue also works when the first trailing row reports
        // with the prior tree's revision before the rebuilt tree deduplicates its rect.
        reading.on_at_bottom(false, false, false);
        reading.record_for_revision(15, "evicted", 100.0, [0.0, -476.0, 320.0, 500.0], |_, _| {
            false
        });
        reading.arm_resize_anchor(16, "evicted".into(), -576.0, true);
        assert_eq!(
            reading.record_for_revision(
                15,
                "after-evicted",
                100.0,
                [0.0, 90.0, 844.0, 60.0],
                |anchor, row| anchor == "evicted" && row == "after-evicted"
            ),
            Some(("evicted".into(), 0.0))
        );
    }

    #[test]
    fn pending_resize_detection_tracks_history_bounds_vs_committed_size() {
        let mut state = crate::init();
        let mut tx = Tx::default();
        state
            .tool_diff_preferences
            .history_bounds
            .set([0.0, 104.0, 390.0, 200.0]);
        crate::chat::ToolDiffPreferences::history_layout(
            &mut state,
            [0.0, 104.0, 390.0, 200.0],
            false,
            &mut tx,
        );
        assert!(!state.tool_diff_preferences.has_pending_resize());
        // Rune writes history_bounds before queuing AtBottom and Layout on a resize frame.
        state
            .tool_diff_preferences
            .history_bounds
            .set([0.0, 104.0, 390.0, 520.0]);
        assert!(state.tool_diff_preferences.has_pending_resize());
        // Transient zero/NaN extents do not clobber the committed size.
        crate::chat::ToolDiffPreferences::history_layout(
            &mut state,
            [0.0, 104.0, 390.0, 0.0],
            false,
            &mut tx,
        );
        crate::chat::ToolDiffPreferences::history_layout(
            &mut state,
            [0.0, 104.0, f32::NAN, 520.0],
            false,
            &mut tx,
        );
        assert!(state.tool_diff_preferences.has_pending_resize());
        crate::chat::ToolDiffPreferences::history_layout(
            &mut state,
            [0.0, 104.0, 390.0, 520.0],
            false,
            &mut tx,
        );
        assert!(!state.tool_diff_preferences.has_pending_resize());
        state.tool_diff_preferences.reset_history_size();
        assert!(!state.tool_diff_preferences.has_pending_resize());
    }

    #[test]
    fn same_width_restored_message_preserves_at_bottom_and_expires_settling() {
        let mut reading = Reading::default();
        reading.on_at_bottom(true, false, false);
        reading.apply_restored(
            &Bookmark::Message {
                id: "passage-28".into(),
                offset: -6.0,
            },
            3,
            false,
        );
        assert!(reading.at_bottom);
        assert!(!reading.following);
        assert!(reading.resize_anchor.is_some());
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "passage-28".into(),
                offset: -6.0,
            }
        );
        // When restore clamps at bottom without changing AtBottom, DrawnLayout clears settling
        // while keeping the anchor for a later shrink.
        assert_eq!(
            reading.record_for_revision(
                3,
                "passage-20",
                100.0,
                [0.0, 95.0, 390.0, 50.0],
                |_, _| { false }
            ),
            None
        );
        assert!(reading.resize_anchor.is_some());
        // Manual scroll away from bottom then clears the anchor cleanly.
        reading.on_at_bottom(false, false, false);
        assert!(reading.resize_anchor.is_none());
        // If restore stays off bottom without DrawnLayout firing, a later scroll advances seq
        // past settle_seq so reaching bottom resumes following.
        reading.apply_restored(
            &Bookmark::Message {
                id: "passage-12".into(),
                offset: -10.0,
            },
            4,
            false,
        );
        reading.scroll_state.set(ScrollObserved {
            offset: 500.0,
            max: 500.0,
            seq: 2,
            ..ScrollObserved::default()
        });
        reading.on_at_bottom(true, false, false);
        assert_eq!(reading.bookmark(false), Bookmark::Latest);
    }

    #[test]
    fn user_navigation_skips_answers_and_preserves_the_draft() {
        let mut s = crate::init();
        s.messages = [("a", "user"), ("b", "assistant"), ("c", "user")]
            .into_iter()
            .map(|(id, role)| {
                crate::Message {
                    id: id.into(),
                    role: role.into(),
                    body: id.into(),
                    completed: true,
                    parts: Vec::new(),
                    usage: None,
                }
                .into()
            })
            .collect();
        s.draft = rune::edit::TextEdit::new("draft");
        assert_eq!(user_target(&s, true).as_deref(), Some("c"));
        assert!(user_target(&s, false).is_none());
        let reading = s.transcript_display.reading_mut();
        reading.following = false;
        reading.top = Some(("b".into(), 0.0, 0.0));
        assert_eq!(user_target(&s, true).as_deref(), Some("a"));
        assert_eq!(user_target(&s, false).as_deref(), Some("c"));
        assert_eq!(s.draft.text, "draft");
    }

    #[test]
    fn collapsed_group_passage_target_resets_negative_offset_to_header_top() {
        use serde_json::json;
        let m1 = crate::history::decode_message(&json!({
            "id":"m1","type":"assistant","time":{"completed":1000},"content":[
                {"type":"reasoning","text":"First long thought"}
            ]
        }))
        .unwrap();
        let m2 = crate::history::decode_message(&json!({
            "id":"m2","type":"assistant","time":{"completed":2000},"content":[
                {"type":"reasoning","text":"Second long thought"}
            ]
        }))
        .unwrap();
        let mut s = crate::init();
        crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
        s.messages = vec![m1.into(), m2.into()];
        let reading = s.transcript_display.reading_mut();
        reading.following = false;
        reading.top = Some(("m2".into(), -300.0, 0.0));
        reading.passage = Some(Passage {
            message: "m2".into(),
            key: super::super::reasoning::block_key("m2", 0),
            offset: -300.0,
            mode: Some(crate::settings::TranscriptRow::Thinking),
        });
        assert_eq!(
            passage_target(&s),
            Some((
                format!("m1/{}", super::super::reasoning::block_key("m1", 0)),
                0.0
            ))
        );
    }
}
