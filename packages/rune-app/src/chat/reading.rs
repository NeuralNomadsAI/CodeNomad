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
    last_resize_seq: u64,
    last_direct_seq: u64,
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

#[derive(Clone, Copy, Debug, PartialEq)]
enum ReplayDelta {
    Vertical(f32),
    Diagonal {
        dy: f32,
        confirmed: bool,
        token: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum FrameRestoreTarget {
    Offset,
    Anchor(String, f32),
    FromBottom,
    ReplayDeltas {
        anchor: Bookmark,
        deltas: Vec<ReplayDelta>,
        restored_anchor: bool,
        anchor_retargeted: bool,
        content_clamped_retried: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PostProbe {
    clock: f64,
}

fn replay_deltas_checked(start: f32, max: f32, deltas: &[f32]) -> (f32, bool) {
    let mut dest = start.clamp(0.0, max);
    let mut clamped = (dest - start).abs() > 0.5;
    for &dy in deltas {
        let raw = dest - dy;
        let next = raw.clamp(0.0, max);
        if (next - raw).abs() > 0.5 {
            clamped = true;
        }
        dest = next;
    }
    (dest, clamped)
}

pub(crate) const HOVER_SESSION_LIST: u8 = 1 << 0;
pub(crate) const HOVER_RIGHT_PANEL: u8 = 1 << 1;
pub(crate) const HOVER_COMPOSER: u8 = 1 << 2;
pub(crate) const HOVER_TIMELINE: u8 = 1 << 3;
pub(crate) const HOVER_SEARCH_BODY: u8 = 1 << 4;
pub(crate) const HOVER_MODEL_LIST: u8 = 1 << 5;
pub(crate) const HOVER_PENDING_FIELDS: u8 = 1 << 6;
pub(crate) const HOVER_SESSION_STACK: u8 = 1 << 7;

pub(crate) fn track_other_scroller_hover(el: El, bit: u8) -> El {
    el.on_hover_change(move |s: &mut State, hovered, tx| {
        if hovered {
            s.tool_diff_preferences.hovered_other_scrollers |= bit;
        } else {
            s.tool_diff_preferences.hovered_other_scrollers &= !bit;
        }
        tx.live_only();
    })
}

#[derive(Clone)]
pub(crate) struct InnerScrollRegion {
    pos: std::sync::Arc<[std::sync::atomic::AtomicU32; 4]>,
    has_horizontal_child: bool,
}

impl InnerScrollRegion {
    fn load(&self) -> ([f32; 2], [f32; 2]) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            [
                f32::from_bits(self.pos[0].load(Relaxed)),
                f32::from_bits(self.pos[1].load(Relaxed)),
            ],
            [
                f32::from_bits(self.pos[2].load(Relaxed)),
                f32::from_bits(self.pos[3].load(Relaxed)),
            ],
        )
    }

    fn can_scroll(&self, dx: f32, dy: f32) -> (bool, bool) {
        let (offset, max) = self.load();
        let can_x = self.has_horizontal_child
            || (dx > 0.0 && offset[0] > 0.5)
            || (dx < 0.0 && offset[0] + 0.5 < max[0]);
        let can_y = (dy > 0.0 && offset[1] > 0.5) || (dy < 0.0 && offset[1] + 0.5 < max[1]);
        (can_x, can_y)
    }
}

pub(crate) fn inner_scroller(el: El, has_horizontal_child: bool) -> El {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
    let pos = Arc::new([
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
    ]);
    let watch = pos.clone();
    let region = InnerScrollRegion {
        pos,
        has_horizontal_child,
    };
    let wheel = region.clone();
    el.on_scroll_offset(move |at| {
        watch[0].store(at.offset[0].to_bits(), Relaxed);
        watch[1].store(at.offset[1].to_bits(), Relaxed);
        watch[2].store(at.max[0].to_bits(), Relaxed);
        watch[3].store(at.max[1].to_bits(), Relaxed);
    })
    .data(region)
    .on_wheel(move |s: &mut State, ev, tx| {
        if !ev.touch && !s.screen.is_launcher() {
            let (dx, dy) = effective_wheel_delta(&ev);
            let (can_x, can_y) = wheel.can_scroll(dx, dy);
            s.transcript_display
                .reading_mut()
                .note_inner_wheel(tx.clock(), can_x, can_y);
        }
        false
    })
}

pub(crate) fn inner_diff_scroller(el: El, can_x: bool, can_y: bool) -> El {
    el.on_wheel(move |s: &mut State, ev, tx| {
        if !ev.touch && !s.screen.is_launcher() {
            let (dx, dy) = effective_wheel_delta(&ev);
            s.transcript_display.reading_mut().note_inner_wheel(
                tx.clock(),
                can_x && dx.abs() > 0.001,
                can_y && dy.abs() > 0.001,
            );
        }
        false
    })
}

#[derive(Clone, Debug, PartialEq)]
struct FrameRestore {
    epoch: u64,
    obs_offset: f32,
    obs_max: f32,
    obs_seq: u64,
    direct_seq: u64,
    queue_layout_seq: u64,
    content_layout_seq: u64,
    target: FrameRestoreTarget,
    probe_live: bool,
    probe_ready: Option<f32>,
    input_poll_clock: Option<f64>,
    defer_for_input_clock: Option<f64>,
    superseded_by_key: bool,
    had_press_defer: bool,
    diagonal_fallback_base_offset: Option<f32>,
    handled: bool,
    post_probe: Option<PostProbe>,
    checked: Cell<Option<Option<f32>>>,
}

const SYNC_UNDO_GESTURE_IDLE_SECS: f64 = 1.0;

pub(crate) struct Reading {
    scope: Rc<()>,
    following: bool,
    at_bottom: bool,
    top: Option<(String, f32, f32)>,
    top_manual_seq: u64,
    min_record_revision: u64,
    queue_layout_seq: u64,
    content_layout_seq: u64,
    resize_anchor: Option<ResizeAnchor>,
    frame_restore_epoch: u64,
    diagonal_token: u64,
    frame_restore: Option<FrameRestore>,
    phased_wheel_active: bool,
    phased_vertical_claimed_clock: Option<f64>,
    inner_wheel_can_scroll: Option<(f64, bool, bool)>,
    paging_key_clock: Option<f64>,
    history_hovered: bool,
    sync_undo_gesture_clock: Option<f64>,
    sync_undo_gesture_moved: bool,
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
            queue_layout_seq: 0,
            content_layout_seq: 0,
            resize_anchor: None,
            frame_restore_epoch: 0,
            diagonal_token: 0,
            frame_restore: None,
            phased_wheel_active: false,
            phased_vertical_claimed_clock: None,
            inner_wheel_can_scroll: None,
            paging_key_clock: None,
            history_hovered: false,
            sync_undo_gesture_clock: None,
            sync_undo_gesture_moved: false,
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

    pub(crate) fn scroll_snapshot(&self) -> (u64, f32, f32) {
        let cur = self.scroll_state.get();
        (cur.seq, cur.offset, cur.max)
    }

    pub(super) fn pending_scroll_commit(&self) -> bool {
        self.scroll_state.get().pending_scroll_commit
    }

    pub(crate) fn queue_replay_replacement(
        &self,
        old_items: &[codenomad_client::inbox::QueuedPrompt],
        next_items: &[codenomad_client::inbox::QueuedPrompt],
    ) -> Option<Bookmark> {
        let Some(FrameRestore {
            target:
                FrameRestoreTarget::ReplayDeltas {
                    anchor: Bookmark::Message { id, .. },
                    ..
                },
            ..
        }) = self.frame_restore.as_ref()
        else {
            return None;
        };
        let idx = old_items.iter().position(|item| item.id == *id)?;
        if next_items.iter().any(|item| item.id == *id) {
            return None;
        }
        Some(
            old_items[idx + 1..]
                .iter()
                .find(|item| next_items.iter().any(|cand| cand.id == item.id))
                .map_or(Bookmark::Latest, |item| Bookmark::Message {
                    id: item.id.clone(),
                    offset: 0.0,
                }),
        )
    }

    pub(crate) fn note_queue_layout_change(&mut self, replacement: Option<Bookmark>) {
        self.queue_layout_seq = self.queue_layout_seq.wrapping_add(1);
        if let Some(next_anchor) = replacement
            && let Some(fr) = self.frame_restore.as_mut()
            && let FrameRestoreTarget::ReplayDeltas {
                anchor,
                anchor_retargeted,
                ..
            } = &mut fr.target
        {
            *anchor = next_anchor;
            *anchor_retargeted = true;
        }
    }

    pub(crate) fn note_content_layout_change(&mut self) {
        self.content_layout_seq = self.content_layout_seq.wrapping_add(1);
    }

    fn on_history_input_pending(&mut self, clock: f64, supersede: bool, from_press: bool) -> bool {
        if let Some(fr) = self.frame_restore.as_mut()
            && !fr.handled
            && fr.probe_live
            && matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
        {
            fr.defer_for_input_clock = Some(clock);
            if supersede {
                fr.superseded_by_key = true;
            }
            if from_press {
                fr.had_press_defer = true;
            }
            return true;
        }
        false
    }

    fn live_row_offset(&self, id: &str, history_top: f32) -> Option<f32> {
        if !history_top.is_finite() {
            return None;
        }
        let rows = self.live_rows.borrow();
        let (weak, live) = rows.get(id)?;
        if weak.strong_count() == 0 {
            return None;
        }
        let rect = live.get();
        (rect[3] > 0.0 && rect[1].is_finite()).then_some(rect[1] - history_top)
    }

    #[cfg(test)]
    pub(super) fn has_pending_restore_probe(&self) -> bool {
        self.frame_restore.as_ref().is_some_and(|fr| {
            !fr.handled && fr.probe_live && matches!(fr.checked.get(), None | Some(Some(_)))
        })
    }

    fn frame_restore_matches(&self, fr: &FrameRestore, clock: f64) -> bool {
        let cur_seq = self.scroll_state.get().seq;
        if cur_seq == fr.obs_seq {
            return true;
        }
        if !fr.handled
            && fr.probe_live
            && matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
        {
            return true;
        }
        fr.post_probe.as_ref().is_some_and(|p| p.clock == clock) && cur_seq == fr.obs_seq + 1
    }

    fn pending_resize_wheel_replay(&self) -> bool {
        let cur = self.scroll_state.get();
        self.frame_restore.as_ref().is_some_and(|fr| {
            fr.handled
                && !fr.probe_live
                && fr.post_probe.is_some()
                && matches!(
                    &fr.target,
                    FrameRestoreTarget::ReplayDeltas { deltas, .. } if !deltas.is_empty()
                )
                && cur.last_resize_seq == cur.seq
                && cur.seq == fr.obs_seq + 1
        })
    }

    pub(super) fn keeps_sync_undo_alive(&self) -> bool {
        self.pending_resize_wheel_replay()
            || self.frame_restore.as_ref().is_some_and(|fr| {
                !fr.handled
                    || (matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
                        && self.scroll_state.get().seq == fr.obs_seq)
            })
    }

    pub(super) fn awaiting_wheel_replay(&self) -> bool {
        self.pending_resize_wheel_replay()
            || self.frame_restore.as_ref().is_some_and(|fr| {
                !fr.handled
                    && fr.probe_live
                    && matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
            })
    }

    fn begin_wheel_gesture(&mut self) {
        self.phased_wheel_active = true;
        self.phased_vertical_claimed_clock = None;
        self.sync_undo_gesture_clock = None;
        self.sync_undo_gesture_moved = false;
    }

    pub(crate) fn end_wheel_gesture(&mut self) {
        self.phased_wheel_active = false;
        self.phased_vertical_claimed_clock = None;
        self.sync_undo_gesture_clock = None;
        self.sync_undo_gesture_moved = false;
    }

    fn claim_vertical_wheel_gesture(&mut self, clock: f64) {
        if self.phased_wheel_active {
            self.phased_vertical_claimed_clock = Some(clock);
        }
    }

    fn arm_sync_undo_gesture(&mut self, clock: f64, moved: bool) {
        if self.phased_wheel_active {
            self.phased_vertical_claimed_clock = Some(clock);
            self.sync_undo_gesture_clock = Some(clock);
            self.sync_undo_gesture_moved |= moved;
        }
    }

    pub(super) fn clear_sync_undo_gesture(&mut self) {
        self.sync_undo_gesture_clock = None;
        self.sync_undo_gesture_moved = false;
    }

    fn vertical_wheel_gesture_claimed(&self, clock: f64) -> bool {
        self.phased_vertical_claimed_clock.is_some_and(|at| {
            clock.is_finite() && at.is_finite() && (clock - at) < SYNC_UNDO_GESTURE_IDLE_SECS
        })
    }

    fn note_inner_wheel(&mut self, clock: f64, can_x: bool, can_y: bool) {
        match self.inner_wheel_can_scroll {
            Some((at, x, y)) if at == clock => {
                self.inner_wheel_can_scroll = Some((clock, x || can_x, y || can_y));
            }
            _ => {
                self.inner_wheel_can_scroll = Some((clock, can_x, can_y));
            }
        }
    }

    fn take_inner_wheel(&mut self, clock: f64) -> (bool, bool) {
        match self.inner_wheel_can_scroll.take() {
            Some((at, x, y)) if at == clock => (x, y),
            _ => (false, false),
        }
    }

    fn sync_undo_gesture_active(&self) -> bool {
        self.sync_undo_gesture_clock.is_some()
    }

    pub(super) fn keeps_sync_undo_for_gesture(&self, clock: f64) -> bool {
        self.sync_undo_gesture_clock.is_some_and(|at| {
            clock.is_finite() && at.is_finite() && (clock - at) < SYNC_UNDO_GESTURE_IDLE_SECS
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

    pub(super) fn arm_frame_restore_for(
        &mut self,
        bookmark: &Bookmark,
        had_manual_scroll: bool,
        trimmed_laid_out: bool,
    ) {
        let cur = self.scroll_state.get();
        if trimmed_laid_out {
            if cur.seq > 0 {
                self.frame_restore_epoch += 1;
                self.frame_restore = Some(FrameRestore {
                    epoch: self.frame_restore_epoch,
                    obs_offset: cur.offset,
                    obs_max: cur.max,
                    obs_seq: cur.seq,
                    direct_seq: cur.last_direct_seq,
                    queue_layout_seq: self.queue_layout_seq,
                    content_layout_seq: self.content_layout_seq,
                    target: FrameRestoreTarget::ReplayDeltas {
                        anchor: bookmark.clone(),
                        deltas: Vec::new(),
                        restored_anchor: false,
                        anchor_retargeted: false,
                        content_clamped_retried: false,
                    },
                    probe_live: false,
                    probe_ready: None,
                    input_poll_clock: None,
                    defer_for_input_clock: None,
                    superseded_by_key: false,
                    had_press_defer: false,
                    diagonal_fallback_base_offset: None,
                    handled: true,
                    post_probe: None,
                    checked: Cell::new(Some(None)),
                });
            } else {
                self.frame_restore = None;
            }
            return;
        }
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
                direct_seq: cur.last_direct_seq,
                queue_layout_seq: self.queue_layout_seq,
                content_layout_seq: self.content_layout_seq,
                target,
                probe_live,
                probe_ready: None,
                input_poll_clock: None,
                defer_for_input_clock: None,
                superseded_by_key: false,
                had_press_defer: false,
                diagonal_fallback_base_offset: None,
                handled: false,
                post_probe: None,
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
        self.end_wheel_gesture();
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
        self.end_wheel_gesture();
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
    let press_scope = reading_scope.clone();
    let hover_scope = reading_scope.clone();
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
        || s.reader
            .as_ref()
            .is_some_and(|r| r.defers_scroll() || r.has_sync_undo());
    let history = history
        .on_scroll_offset(move |at| {
            let prev = scroll_state.get();
            let resized = prev.seq > 0
                && ((at.viewport[0] - prev.viewport_w).abs() > 0.5
                    || (at.viewport[1] - prev.viewport_h).abs() > 0.5);
            let direct = matches!(
                at.source,
                rune_theme_codenomad::timeline::ScrollSource::Direct
                    | rune_theme_codenomad::timeline::ScrollSource::Momentum
                    | rune_theme_codenomad::timeline::ScrollSource::EdgeReturn
            );
            let next_seq = prev.seq + 1;
            let mut next = ScrollObserved {
                offset: at.offset[1],
                prev_offset: prev.offset,
                max: at.max[1],
                viewport_w: at.viewport[0],
                viewport_h: at.viewport[1],
                seq: next_seq,
                last_resize_seq: if resized {
                    next_seq
                } else {
                    prev.last_resize_seq
                },
                last_direct_seq: if direct {
                    next_seq
                } else {
                    prev.last_direct_seq
                },
                manual_seq: prev.manual_seq,
                ignore_manual_once: false,
                ignore_remount_bottom: false,
                pending_scroll_commit: false,
            };
            if next.user_moved_from(prev)
                || (at.source == rune_theme_codenomad::timeline::ScrollSource::Direct
                    && (next.offset - prev.offset).abs() > 0.5)
            {
                next.manual_seq = prev.manual_seq + 1;
            }
            scroll_state.set(next);
            timeline_scroll(at);
        })
        .on_any_press(move |s: &mut State, _btn, pt, tx| {
            if !s.screen.is_launcher() && s.transcript_display.reading().same_scope(&press_scope) {
                let bounds = s.tool_diff_preferences.history_bounds.get();
                let inside = bounds[2] > 0.0
                    && bounds[3] > 0.0
                    && pt.window_x >= bounds[0]
                    && pt.window_x <= bounds[0] + bounds[2]
                    && pt.window_y >= bounds[1]
                    && pt.window_y <= bounds[1] + bounds[3];
                if inside
                    && s.transcript_display.reading_mut().on_history_input_pending(
                        tx.clock(),
                        false,
                        true,
                    )
                {
                    tx.wake_after(std::time::Duration::ZERO);
                }
            }
            tx.live_only();
        })
        .on_hover_change(move |s: &mut State, inside, tx| {
            if !s.screen.is_launcher() && s.transcript_display.reading().same_scope(&hover_scope) {
                s.transcript_display.reading_mut().history_hovered = inside;
            }
            tx.live_only();
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
        let same_scope =
            !s.screen.is_launcher() && s.transcript_display.reading().same_scope(&wheel_scope);
        let inner_can_scroll = if same_scope {
            s.transcript_display
                .reading_mut()
                .take_inner_wheel(tx.clock())
        } else {
            (false, false)
        };
        if same_scope && ev.phase == rune_theme_codenomad::timeline::GesturePhase::Began {
            s.transcript_display.reading_mut().begin_wheel_gesture();
        }
        let handled = if watch_wheel {
            handle_reading_wheel(s, &wheel_scope, &ev, inner_can_scroll, tx)
        } else {
            false
        };
        if same_scope && ev.phase == rune_theme_codenomad::timeline::GesturePhase::Ended {
            s.transcript_display.reading_mut().end_wheel_gesture();
        }
        crate::timeline::observe_history_wheel(s, &wheel_input_scope, &ev, tx, !handled);
        handled
    })
}

pub(crate) fn note_history_paging_key(s: &mut State, event: &rune::KeyEvent, tx: &mut Tx) {
    let has_project = s.screen.launcher().is_some_and(|l| l.project.is_some());
    if s.screen.is_launcher()
        || !crate::timeline::conversation_shown(s)
        || (has_project && s.shell.has_floating())
        || event.mods.cmd
        || event.mods.alt
        || event.mods.ctrl
    {
        return;
    }
    let history_focused = tx.focused() == Some("history");
    let paging = match &event.key {
        rune::Key::PageUp | rune::Key::PageDown | rune::Key::Home | rune::Key::End => true,
        rune::Key::Up | rune::Key::Down => history_focused && !event.mods.shift,
        rune::Key::Text(text) => history_focused && text == " ",
        _ => false,
    };
    if !paging {
        return;
    }
    let session_list_pageable = has_project
        && s.shell.visible(0)
        && s.tool_diff_preferences.session_list_scroll.get().1 > 0.5;
    let session_list_before_history_pageable = session_list_pageable && s.shell.docked_left();
    let right_panel_pageable = has_project
        && s.shell.visible(1)
        && match crate::workspace::right_panel_tab(s) {
            crate::workspace::RightPanelTab::Status => {
                s.tool_diff_preferences.right_panel_status_scroll.get().1 > 0.5
            }
            _ => true,
        };
    let composer_pageable = s.tool_diff_preferences.composer_scroll.get().1 > 0.5;
    let stack_pageable = s.tool_diff_preferences.stack_scroll.get().1 > 0.5;
    let focused_in_history = history_focused || tx.focus_within("history");
    let focused_in_other_scroller = !focused_in_history
        && ((tx.focus_within("session-list") && session_list_pageable)
            || (tx.focus_within("right-panel") && right_panel_pageable)
            || tx.focus_within("history-search-body")
            || tx.focus_within("model-list")
            || tx.focus_within("pending-fields")
            || tx.focus_within(rune_theme_codenomad::timeline::VIEWPORT)
            || (tx.focus_within("composer") && composer_pageable)
            || (tx.focus_within("session-stack") && stack_pageable));
    let hovered_bits = s.tool_diff_preferences.hovered_other_scrollers;
    let hovered_in_other_scroller = !s.transcript_display.reading().history_hovered
        && ((hovered_bits & HOVER_SESSION_LIST != 0 && session_list_pageable)
            || (hovered_bits & HOVER_RIGHT_PANEL != 0 && right_panel_pageable)
            || (hovered_bits & HOVER_SEARCH_BODY != 0 && crate::timeline::search::is_open(s))
            || (hovered_bits & HOVER_MODEL_LIST != 0
                && s.agent.as_ref().is_some_and(|a| a.picker))
            || (hovered_bits & HOVER_PENDING_FIELDS != 0
                && s.agent
                    .as_ref()
                    .is_some_and(|a| !a.permissions.is_empty() || !a.forms.is_empty()))
            || (hovered_bits & HOVER_TIMELINE != 0 && crate::timeline::rail_pageable(s))
            || (hovered_bits & HOVER_COMPOSER != 0 && composer_pageable)
            || (hovered_bits & HOVER_SESSION_STACK != 0 && stack_pageable));
    let history_pageable = s.transcript_display.reading().scroll_state.get().max > 0.5;
    let tree_fallback_is_history =
        history_pageable && !session_list_before_history_pageable && !stack_pageable;
    let targets_history = focused_in_history
        || (!focused_in_other_scroller
            && (s.transcript_display.reading().history_hovered
                || (!hovered_in_other_scroller && tree_fallback_is_history)));
    let clock = tx.clock();
    let reading = s.transcript_display.reading_mut();
    if targets_history {
        reading.paging_key_clock = Some(clock);
        reading.clear_sync_undo_gesture();
        if reading.on_history_input_pending(clock, true, false) {
            tx.wake_after(std::time::Duration::ZERO);
        }
        if let Some(reader) = &mut s.reader {
            reader.clear_sync_undo();
        }
    } else if reading.on_history_input_pending(clock, false, false) {
        tx.wake_after(std::time::Duration::ZERO);
    }
}

fn replay_anchor_present(s: &State, anchor: &Bookmark) -> bool {
    match anchor {
        Bookmark::Latest => !s.history_detached,
        Bookmark::Message { id, .. } => {
            s.messages.iter().any(|row| row.id == *id)
                || (!s.history_detached
                    && s.transcript_display
                        .queue
                        .items()
                        .iter()
                        .any(|item| item.id == *id))
        }
    }
}

fn effective_wheel_delta_for(ev: &rune::WheelEvent, shift_turns_wheel: bool) -> (f32, f32) {
    if ev.mods.shift
        && !ev.mods.ctrl
        && ev.dx == 0.0
        && ev.dy != 0.0
        && (shift_turns_wheel || !ev.precise)
    {
        (ev.dy, 0.0)
    } else {
        (ev.dx, ev.dy)
    }
}

pub(crate) fn effective_wheel_delta(ev: &rune::WheelEvent) -> (f32, f32) {
    const SHIFT_TURNS_WHEEL: bool = !cfg!(target_os = "macos");
    effective_wheel_delta_for(ev, SHIFT_TURNS_WHEEL)
}

fn handle_reading_wheel(
    s: &mut State,
    wheel_scope: &Rc<()>,
    ev: &rune::WheelEvent,
    (inner_can_x, inner_can_y): (bool, bool),
    tx: &mut Tx,
) -> bool {
    if s.screen.is_launcher()
        || !s.transcript_display.reading().same_scope(&wheel_scope)
        || !ev.dy.is_finite()
        || !ev.dx.is_finite()
    {
        return false;
    }
    let (dx, dy) = effective_wheel_delta(ev);
    let ended = ev.phase == rune_theme_codenomad::timeline::GesturePhase::Ended;
    let clock = tx.clock();
    if s.transcript_display.reading().paging_key_clock == Some(clock)
        || s.transcript_display
            .reading()
            .frame_restore
            .as_ref()
            .is_some_and(|fr| fr.superseded_by_key)
    {
        return false;
    }
    let vertical_locked = s
        .transcript_display
        .reading()
        .vertical_wheel_gesture_claimed(clock);
    let has_sync_undo_now = s
        .reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::has_sync_undo);
    let active_frame_restore = s
        .transcript_display
        .reading()
        .frame_restore
        .as_ref()
        .is_some_and(|fr| {
            s.transcript_display
                .reading()
                .frame_restore_matches(fr, clock)
        });
    if dy.abs() <= 0.001 {
        if !ended && vertical_locked && (has_sync_undo_now || active_frame_restore) {
            let reading = s.transcript_display.reading_mut();
            reading.claim_vertical_wheel_gesture(clock);
            if has_sync_undo_now {
                reading.arm_sync_undo_gesture(clock, false);
            }
            return true;
        }
        return false;
    }
    if !vertical_locked && dx.abs() > dy.abs() {
        if active_frame_restore {
            let cur_offset = s.transcript_display.reading().scroll_state.get().offset;
            let history_bounds = s.tool_diff_preferences.history_bounds.get();
            let reading = s.transcript_display.reading_mut();
            let pick_token = if let Some(fr) = reading.frame_restore.as_mut()
                && !fr.handled
                && fr.probe_live
                && let FrameRestoreTarget::ReplayDeltas { deltas, .. } = &mut fr.target
            {
                if fr.diagonal_fallback_base_offset.is_none() {
                    fr.diagonal_fallback_base_offset = Some(cur_offset);
                }
                reading.diagonal_token = reading.diagonal_token.wrapping_add(1);
                let token = reading.diagonal_token;
                deltas.push(ReplayDelta::Diagonal {
                    dy,
                    confirmed: false,
                    token,
                });
                fr.defer_for_input_clock = Some(clock);
                tx.wake_after(std::time::Duration::ZERO);
                Some(token)
            } else {
                None
            };
            if let Some(token) = pick_token
                && history_bounds[2] > 0.0
                && history_bounds[3] > 0.0
            {
                let scope = wheel_scope.clone();
                let inner_can_consume = inner_can_x || inner_can_y;
                tx.element_at_in(
                    "history",
                    history_bounds[0] + ev.x,
                    history_bounds[1] + ev.y,
                    move |s: &mut State, picked, tx| {
                        let over_inner_scroller = inner_can_consume
                            || picked.as_ref().is_some_and(|p| {
                                p.data::<InnerScrollRegion>().is_some_and(|r| {
                                    let (cx, cy) = r.can_scroll(dx, dy);
                                    cx || cy
                                }) || p.path().split('/').any(|seg| seg == "scroll")
                            });
                        if !over_inner_scroller
                            && !s.screen.is_launcher()
                            && s.transcript_display.reading().same_scope(&scope)
                            && let Some(fr) =
                                s.transcript_display.reading_mut().frame_restore.as_mut()
                            && !fr.handled
                            && fr.probe_live
                            && let FrameRestoreTarget::ReplayDeltas { deltas, .. } = &mut fr.target
                            && let Some(ReplayDelta::Diagonal { confirmed, .. }) =
                                deltas.iter_mut().find(|d| {
                                    matches!(d, ReplayDelta::Diagonal { token: t, .. } if *t == token)
                                })
                        {
                            *confirmed = true;
                        }
                        tx.live_only();
                    },
                );
            }
        }
        return false;
    }
    let fresh_or_unphased = ev.phase != rune_theme_codenomad::timeline::GesturePhase::Moved;
    if inner_can_y && (!vertical_locked || fresh_or_unphased) {
        return false;
    }
    if active_frame_restore {
        let cur_seq = s.transcript_display.reading().scroll_state.get().seq;
        let is_replay = s
            .transcript_display
            .reading()
            .frame_restore
            .as_ref()
            .is_some_and(|fr| matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. }));
        if is_replay {
            let (obs_offset, obs_max, post_probe) = {
                let fr = s
                    .transcript_display
                    .reading()
                    .frame_restore
                    .as_ref()
                    .unwrap();
                let post_probe = fr.handled
                    && !fr.probe_live
                    && matches!(
                        &fr.target,
                        FrameRestoreTarget::ReplayDeltas { deltas, .. } if !deltas.is_empty()
                    );
                (fr.obs_offset, fr.obs_max, post_probe)
            };
            let wants_older = ev.dy > 0.0;
            let wants_newer = ev.dy < 0.0;
            let undo_bookmark = s
                .reader
                .as_ref()
                .and_then(crate::chat::reader::Reader::sync_undo_anchor)
                .map(|(_, _, _, bookmark)| bookmark);
            let undid = s
                .reader
                .as_ref()
                .is_some_and(|reader| reader.can_undo_sync(wants_older, wants_newer))
                && crate::chat::reader::undo_sync_for_manual_scroll(s, cur_seq + 2, tx);
            let pending_scroll = s
                .reader
                .as_ref()
                .is_some_and(crate::chat::reader::Reader::has_pending_scroll);
            let has_sync_undo = s
                .reader
                .as_ref()
                .is_some_and(crate::chat::reader::Reader::has_sync_undo);
            let anchor_valid = if undid {
                s.transcript_display
                    .reading()
                    .frame_restore
                    .as_ref()
                    .is_some_and(|fr| match &fr.target {
                        FrameRestoreTarget::ReplayDeltas { anchor, .. } => {
                            replay_anchor_present(s, anchor)
                        }
                        _ => false,
                    })
            } else {
                true
            };
            let reading = s.transcript_display.reading_mut();
            let Some(fr) = reading.frame_restore.as_mut() else {
                return true;
            };
            let FrameRestoreTarget::ReplayDeltas {
                anchor,
                deltas,
                restored_anchor,
                anchor_retargeted,
                content_clamped_retried,
            } = &mut fr.target
            else {
                return true;
            };
            if undid {
                if (deltas.is_empty() || !anchor_valid)
                    && let Some(bookmark) = undo_bookmark
                {
                    *anchor = bookmark;
                }
                *restored_anchor = false;
                *anchor_retargeted = false;
                *content_clamped_retried = false;
            }
            if post_probe && !undid {
                deltas.push(ReplayDelta::Vertical(ev.dy));
                let next_dest = (obs_offset - ev.dy).clamp(0.0, obs_max);
                let moved_history = (obs_offset - next_dest).abs() > 0.5;
                let pin_bottom = matches!(anchor, Bookmark::Latest)
                    && obs_max > 0.5
                    && next_dest >= obs_max - 0.5;
                fr.obs_offset = next_dest;
                fr.obs_seq = cur_seq;
                reading.resize_anchor = None;
                reading.claim_vertical_wheel_gesture(clock);
                if has_sync_undo {
                    reading.arm_sync_undo_gesture(clock, moved_history);
                }
                if moved_history {
                    if pending_scroll {
                        reading.note_pending_manual_scroll();
                    } else {
                        reading.bump_manual_scroll();
                    }
                    reading.note_programmatic_scroll();
                }
                let at_bottom = pin_bottom || obs_max <= 0.5 || next_dest >= obs_max - 0.5;
                reading.at_bottom = at_bottom;
                reading.following = at_bottom;
                s.revision += 1;
                s.transcript_display
                    .reading_mut()
                    .advance_row_guard(s.revision);
                if pin_bottom {
                    Reading::restore(&Bookmark::Latest, tx);
                } else {
                    tx.instant();
                    tx.scroll_to_y("history", next_dest);
                }
                return true;
            }
            let skip_bottom_noop =
                !undid && deltas.is_empty() && matches!(anchor, Bookmark::Latest) && ev.dy < 0.0;
            if skip_bottom_noop {
                reading.claim_vertical_wheel_gesture(clock);
                if has_sync_undo {
                    reading.arm_sync_undo_gesture(clock, false);
                }
                return true;
            }
            deltas.push(ReplayDelta::Vertical(ev.dy));
            let restore_now = if !*restored_anchor {
                *restored_anchor = true;
                *anchor_retargeted = false;
                Some(anchor.clone())
            } else {
                None
            };
            if restore_now.is_some() {
                let cur = reading.scroll_state.get();
                reading.frame_restore_epoch += 1;
                fr.epoch = reading.frame_restore_epoch;
                fr.obs_seq = cur_seq;
                fr.direct_seq = cur.last_direct_seq;
                fr.queue_layout_seq = reading.queue_layout_seq;
                fr.content_layout_seq = reading.content_layout_seq;
                fr.probe_ready = None;
                fr.input_poll_clock = None;
                fr.defer_for_input_clock = None;
                fr.superseded_by_key = false;
                fr.had_press_defer = false;
                fr.diagonal_fallback_base_offset = None;
                *content_clamped_retried = false;
            }
            fr.post_probe = None;
            fr.probe_live = true;
            fr.handled = false;
            fr.checked.set(Some(Some(0.0)));
            reading.resize_anchor = None;
            reading.claim_vertical_wheel_gesture(clock);
            if has_sync_undo {
                reading.arm_sync_undo_gesture(clock, true);
            }
            if undid || !pending_scroll {
                reading.bump_manual_scroll();
            } else {
                reading.note_pending_manual_scroll();
            }
            s.revision += 1;
            if let Some(anchor) = restore_now {
                tx.instant();
                Reading::restore(&anchor, tx);
            }
            return true;
        }
        let reading = s.transcript_display.reading_mut();
        let fr = reading.frame_restore.as_mut().unwrap();
        fr.obs_seq = cur_seq;
        let obs_max = fr.obs_max;
        let obs_seq = fr.obs_seq;
        let target = (fr.obs_offset - ev.dy).clamp(0.0, obs_max);
        let delta = fr.obs_offset - target;
        let moved_history = delta.abs() > 0.5;
        let has_sync_undo = s
            .reader
            .as_ref()
            .is_some_and(crate::chat::reader::Reader::has_sync_undo);
        if !moved_history && matches!(fr.target, FrameRestoreTarget::FromBottom) {
            if has_sync_undo {
                s.transcript_display
                    .reading_mut()
                    .arm_sync_undo_gesture(clock, false);
            } else if !ended && vertical_locked {
                s.transcript_display
                    .reading_mut()
                    .claim_vertical_wheel_gesture(clock);
            }
            return has_sync_undo || (!ended && vertical_locked);
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
            reading.claim_vertical_wheel_gesture(clock);
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
        let pending_scroll = s
            .reader
            .as_ref()
            .is_some_and(crate::chat::reader::Reader::has_pending_scroll);
        let reading = s.transcript_display.reading_mut();
        if moved_history || has_sync_undo || (!ended && vertical_locked) {
            reading.claim_vertical_wheel_gesture(clock);
        }
        if has_sync_undo {
            reading.arm_sync_undo_gesture(clock, moved_history);
        }
        let fr = reading.frame_restore.as_mut().unwrap();
        fr.obs_offset = target;
        if matches!(fr.target, FrameRestoreTarget::FromBottom) {
            fr.probe_live = true;
            fr.handled = false;
            fr.checked.set(Some(Some(target)));
            reading.resize_anchor = None;
            if pending_scroll {
                reading.note_pending_manual_scroll();
            } else {
                reading.bump_manual_scroll();
            }
            s.revision += 1;
            return true;
        }
        fr.handled = true;
        let anchor = match &mut fr.target {
            FrameRestoreTarget::Anchor(id, anchor_offset) => {
                *anchor_offset += delta;
                Some((id.clone(), *anchor_offset))
            }
            FrameRestoreTarget::ReplayDeltas { .. }
            | FrameRestoreTarget::Offset
            | FrameRestoreTarget::FromBottom => None,
        };
        reading.resize_anchor = None;
        if moved_history {
            if pending_scroll {
                reading.note_pending_manual_scroll();
            } else {
                reading.bump_manual_scroll();
            }
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
        return moved_history || has_sync_undo || (!ended && vertical_locked);
    }
    let cur = s.transcript_display.reading().scroll_state.get();
    if let Some((saved_seq, _saved_offset, _saved_max, bookmark)) = s
        .reader
        .as_ref()
        .and_then(crate::chat::reader::Reader::sync_undo_anchor)
    {
        let pending_scroll = s
            .reader
            .as_ref()
            .is_some_and(crate::chat::reader::Reader::has_pending_scroll);
        let wants_older = ev.dy > 0.0;
        let wants_newer = ev.dy < 0.0;
        if cur.seq > 0 && cur.seq == saved_seq {
            let target = (cur.offset - ev.dy).clamp(0.0, cur.max);
            let delta = cur.offset - target;
            let moved_history = delta.abs() > 0.5;
            if !moved_history {
                // Claim the gesture while sync_undo is armed so a later reversal in the same
                // vertical gesture still enters handle_reading_wheel instead of Rune's scroller.
                s.transcript_display
                    .reading_mut()
                    .arm_sync_undo_gesture(tx.clock(), false);
                return true;
            }
            let undid = s
                .reader
                .as_ref()
                .is_some_and(|reader| reader.can_undo_sync(wants_older, wants_newer))
                && crate::chat::reader::undo_sync_for_manual_scroll(s, cur.seq + 1, tx);
            let (fr_target, scroll_anchor) = if undid {
                (FrameRestoreTarget::Offset, None)
            } else {
                match bookmark {
                    Bookmark::Message { id, offset } => {
                        let next_offset = offset + delta;
                        (
                            FrameRestoreTarget::Anchor(id.clone(), next_offset),
                            Some((id, next_offset)),
                        )
                    }
                    Bookmark::Latest => (FrameRestoreTarget::FromBottom, None),
                }
            };
            let reading = s.transcript_display.reading_mut();
            reading.claim_vertical_wheel_gesture(clock);
            if !undid {
                reading.arm_sync_undo_gesture(clock, true);
            }
            reading.frame_restore_epoch += 1;
            let from_bottom = matches!(fr_target, FrameRestoreTarget::FromBottom);
            reading.frame_restore = Some(FrameRestore {
                epoch: reading.frame_restore_epoch,
                obs_offset: target,
                obs_max: cur.max,
                obs_seq: cur.seq,
                direct_seq: cur.last_direct_seq,
                queue_layout_seq: reading.queue_layout_seq,
                content_layout_seq: reading.content_layout_seq,
                target: fr_target,
                probe_live: from_bottom,
                probe_ready: None,
                input_poll_clock: None,
                defer_for_input_clock: None,
                superseded_by_key: false,
                had_press_defer: false,
                diagonal_fallback_base_offset: None,
                handled: !from_bottom,
                post_probe: None,
                checked: Cell::new(if from_bottom {
                    Some(Some(target))
                } else {
                    Some(None)
                }),
            });
            reading.resize_anchor = None;
            if undid || !pending_scroll {
                reading.bump_manual_scroll();
            } else {
                reading.note_pending_manual_scroll();
            }
            if from_bottom {
                s.revision += 1;
                return true;
            }
            let at_bottom = cur.max <= 0.5 || target >= cur.max - 0.5;
            reading.at_bottom = at_bottom;
            reading.following = at_bottom;
            s.revision += 1;
            s.transcript_display
                .reading_mut()
                .advance_row_guard(s.revision);
            tx.instant();
            if let Some((id, anchor_offset)) = scroll_anchor {
                tx.scroll_key_to(id, anchor_offset);
            } else {
                tx.scroll_to_y("history", target);
            }
            return true;
        }
        // The trimmed page has already laid out (cur.seq != saved_seq), so cur.offset/cur.max are
        // in the trimmed coordinate space. Restore the pre-sync anchor (or the live scrolled row
        // from an earlier frame of this same gesture) and replay wheel deltas against the real
        // laid-out extent so clamping and reversals match Rune's scroller.
        let anchor = if s.transcript_display.reading().sync_undo_gesture_moved {
            let history_bounds = s.tool_diff_preferences.history_bounds.get();
            let cached_gap = s.history_detached
                || s.reader
                    .as_ref()
                    .is_some_and(crate::chat::reader::Reader::has_gap);
            s.transcript_display
                .reading()
                .live_bookmark_fresh(history_bounds, cached_gap)
                .filter(|live| match live {
                    Bookmark::Latest => s
                        .reader
                        .as_ref()
                        .is_some_and(|reader| !reader.can_undo_sync(false, true)),
                    Bookmark::Message { id, .. } => s.reader.as_ref().is_some_and(|reader| {
                        reader.sync_undo_contains(id, s.transcript_display.queue.items())
                    }),
                })
                .unwrap_or(bookmark)
        } else {
            bookmark
        };
        let undid = s
            .reader
            .as_ref()
            .is_some_and(|reader| reader.can_undo_sync(wants_older, wants_newer))
            && crate::chat::reader::undo_sync_for_manual_scroll(s, cur.seq + 2, tx);
        let skip_bottom_noop = !undid && matches!(anchor, Bookmark::Latest) && ev.dy < 0.0;
        let reading = s.transcript_display.reading_mut();
        reading.frame_restore_epoch += 1;
        if skip_bottom_noop {
            reading.arm_sync_undo_gesture(tx.clock(), false);
            reading.frame_restore = Some(FrameRestore {
                epoch: reading.frame_restore_epoch,
                obs_offset: 0.0,
                obs_max: 0.0,
                obs_seq: cur.seq,
                direct_seq: cur.last_direct_seq,
                queue_layout_seq: reading.queue_layout_seq,
                content_layout_seq: reading.content_layout_seq,
                target: FrameRestoreTarget::ReplayDeltas {
                    anchor,
                    deltas: Vec::new(),
                    restored_anchor: false,
                    anchor_retargeted: false,
                    content_clamped_retried: false,
                },
                probe_live: false,
                probe_ready: None,
                input_poll_clock: None,
                defer_for_input_clock: None,
                superseded_by_key: false,
                had_press_defer: false,
                diagonal_fallback_base_offset: None,
                handled: true,
                post_probe: None,
                checked: Cell::new(Some(None)),
            });
            return true;
        }
        reading.claim_vertical_wheel_gesture(clock);
        if !undid {
            reading.arm_sync_undo_gesture(clock, true);
        }
        reading.frame_restore = Some(FrameRestore {
            epoch: reading.frame_restore_epoch,
            obs_offset: 0.0,
            obs_max: 0.0,
            obs_seq: cur.seq,
            direct_seq: cur.last_direct_seq,
            queue_layout_seq: reading.queue_layout_seq,
            content_layout_seq: reading.content_layout_seq,
            target: FrameRestoreTarget::ReplayDeltas {
                anchor: anchor.clone(),
                deltas: vec![ReplayDelta::Vertical(ev.dy)],
                restored_anchor: true,
                anchor_retargeted: false,
                content_clamped_retried: false,
            },
            probe_live: true,
            probe_ready: None,
            input_poll_clock: None,
            defer_for_input_clock: None,
            superseded_by_key: false,
            had_press_defer: false,
            diagonal_fallback_base_offset: None,
            handled: false,
            post_probe: None,
            checked: Cell::new(Some(Some(0.0))),
        });
        reading.resize_anchor = None;
        if undid || !pending_scroll {
            reading.bump_manual_scroll();
        } else {
            reading.note_pending_manual_scroll();
        }
        s.revision += 1;
        tx.instant();
        Reading::restore(&anchor, tx);
        return true;
    }
    let target = (cur.offset - ev.dy).clamp(0.0, cur.max);
    if cur.seq > 0 && (target - cur.offset).abs() > 0.5 {
        let reading = s.transcript_display.reading_mut();
        reading.note_pending_manual_scroll();
        reading.resize_anchor = None;
        reading.frame_restore = None;
    }
    false
}

fn live_history_metrics(cx: &rune::Cx<State>) -> Option<(f32, f32)> {
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
    let live_max = ((rows_unscrolled[1] + rows_unscrolled[3])
        - (hist_unscrolled[1] + hist_unscrolled[3]))
        .max(0.0);
    (live_offset.is_finite() && live_max.is_finite()).then_some((live_offset, live_max))
}

fn live_history_offset(cx: &rune::Cx<State>) -> Option<f32> {
    live_history_metrics(cx).map(|(offset, _)| offset)
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
    let Some((live_offset, live_max)) = live_history_metrics(cx) else {
        return;
    };
    let live_at_bottom = live_max <= 0.5 || live_offset >= live_max - 0.5;
    if live_at_bottom && (cur.at_bottom() || cur.offset > live_max + 0.5) {
        return;
    }
    if (live_offset - cur.offset).abs() > 0.5 {
        reading.last_touch_probe_seq.set(cur.seq);
        reading.note_pending_manual_scroll();
    }
}

fn fallback_replay_anchor(s: &State, missing: &Bookmark) -> Option<Bookmark> {
    let reading = s.transcript_display.reading();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let vanished_y = match missing {
        Bookmark::Message { id, offset } => {
            let rows = reading.live_rows.borrow();
            rows.get(id)
                .and_then(|(weak, live)| {
                    (weak.strong_count() > 0)
                        .then(|| live.get())
                        .and_then(|r| (r[3] > 0.0 && r[1].is_finite()).then_some(r[1]))
                })
                .or_else(|| {
                    (history_bounds[3] > 0.0 && history_bounds[1].is_finite())
                        .then_some(history_bounds[1] + *offset)
                })
        }
        Bookmark::Latest => None,
    };
    if let Some(target_y) = vanished_y {
        let rows = reading.live_rows.borrow();
        let mut next_below: Option<(String, f32)> = None;
        let mut prev_above: Option<(String, f32)> = None;
        for (id, (weak, live)) in rows.iter() {
            if weak.strong_count() == 0 {
                continue;
            }
            let alive = s.messages.iter().any(|row| row.id == *id)
                || (!s.history_detached
                    && s.transcript_display
                        .queue
                        .items()
                        .iter()
                        .any(|item| item.id == *id));
            if !alive {
                continue;
            }
            let rect = live.get();
            if rect[3] <= 0.0 || !rect[1].is_finite() {
                continue;
            }
            if rect[1] >= target_y - 0.5 {
                if next_below.as_ref().is_none_or(|(_, best)| rect[1] < *best) {
                    next_below = Some((id.clone(), rect[1]));
                }
            } else if prev_above.as_ref().is_none_or(|(_, best)| rect[1] > *best) {
                prev_above = Some((id.clone(), rect[1]));
            }
        }
        if let Some((id, _)) = next_below {
            return Some(Bookmark::Message { id, offset: 0.0 });
        }
        if !s.history_detached {
            return Some(Bookmark::Latest);
        }
        if let Some((id, _)) = prev_above {
            return Some(Bookmark::Message { id, offset: 0.0 });
        }
    }
    if !s.history_detached {
        Some(Bookmark::Latest)
    } else {
        s.messages.last().map(|row| Bookmark::Message {
            id: row.id.clone(),
            offset: 0.0,
        })
    }
}

pub(crate) fn wheel_restore_probe(s: &State, cx: &rune::Cx<State>) -> Option<El> {
    let reading = s.transcript_display.reading();
    let fr = reading.frame_restore.as_ref()?;
    if fr.handled || !fr.probe_live || fr.probe_ready.is_some() {
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
    let epoch = fr.epoch;
    let scope = reading.scope();
    let is_replay = matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. });
    Some(
        rune_theme_codenomad::layout::layout_probe(format!("reading-wheel-restore-{epoch}"))
            .on_layout_tx(move |s: &mut State, _, tx| {
                if s.screen.is_launcher() || !s.transcript_display.reading().same_scope(&scope) {
                    tx.live_only();
                    return;
                }
                let reading = s.transcript_display.reading_mut();
                let Some(fr) = reading.frame_restore.as_mut() else {
                    tx.live_only();
                    return;
                };
                if fr.epoch != epoch || fr.handled || !fr.probe_live {
                    tx.live_only();
                    return;
                }
                fr.probe_ready = Some(target);
                if is_replay {
                    tx.request_poll();
                    tx.live_only();
                } else if !flush_wheel_replay(s, tx) {
                    tx.live_only();
                }
            }),
    )
}

pub(crate) fn flush_wheel_replay(s: &mut State, tx: &mut Tx) -> bool {
    if s.screen.is_launcher() {
        return false;
    }
    let (target, superseded, fallback_base, include_unconfirmed) = {
        let reading = s.transcript_display.reading_mut();
        let cur = reading.scroll_state.get();
        let Some(fr) = reading.frame_restore.as_mut() else {
            return false;
        };
        if fr.handled || !fr.probe_live {
            return false;
        }
        let Some(target) = fr.probe_ready else {
            return false;
        };
        let is_replay = matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. });
        if is_replay {
            if let Some(defer_clock) = fr.defer_for_input_clock {
                if defer_clock == tx.clock() && tx.input_waiting() {
                    tx.wake_after(std::time::Duration::ZERO);
                    return false;
                }
                fr.defer_for_input_clock = None;
                if cur.last_direct_seq == fr.direct_seq {
                    fr.had_press_defer = false;
                    if let FrameRestoreTarget::ReplayDeltas { deltas, .. } = &mut fr.target {
                        deltas.retain(|d| {
                            !matches!(
                                d,
                                ReplayDelta::Diagonal {
                                    confirmed: false,
                                    ..
                                }
                            )
                        });
                    }
                    fr.diagonal_fallback_base_offset = None;
                }
            }
            if cur.last_direct_seq == fr.direct_seq
                && !fr.superseded_by_key
                && tx.input_waiting()
                && fr.input_poll_clock != Some(tx.clock())
            {
                fr.input_poll_clock = Some(tx.clock());
                tx.request_poll();
                return false;
            }
        }
        let direct_moved = is_replay && cur.last_direct_seq != fr.direct_seq;
        let (fallback_base, include_unconfirmed) = if direct_moved
            && !fr.superseded_by_key
            && !fr.had_press_defer
            && let FrameRestoreTarget::ReplayDeltas { deltas, .. } = &fr.target
        {
            let matches_deltas = |base: f32, list: &[f32]| -> bool {
                if list.is_empty() {
                    return false;
                }
                let expected = replay_deltas_checked(base, cur.max, list).0;
                let moved = cur.offset - base;
                let want = expected - base;
                (cur.offset - expected).abs() <= 1.0
                    || (want.abs() > 0.5
                        && moved.abs() > 0.5
                        && moved.signum() == want.signum()
                        && moved.abs() <= want.abs() + 1.0)
            };
            let confirmed_diags: Vec<f32> = deltas
                .iter()
                .filter_map(|d| match *d {
                    ReplayDelta::Diagonal {
                        dy,
                        confirmed: true,
                        ..
                    } => Some(dy),
                    _ => None,
                })
                .collect();
            let all_diags: Vec<f32> = deltas
                .iter()
                .filter_map(|d| match *d {
                    ReplayDelta::Diagonal { dy, .. } => Some(dy),
                    ReplayDelta::Vertical(_) => None,
                })
                .collect();
            if let Some(base) = fr.diagonal_fallback_base_offset {
                if !confirmed_diags.is_empty()
                    && (cur.offset - replay_deltas_checked(base, cur.max, &confirmed_diags).0).abs()
                        <= 1.0
                {
                    (Some(base), false)
                } else if matches_deltas(base, &all_diags) {
                    (Some(base), true)
                } else {
                    (None, false)
                }
            } else {
                (None, false)
            }
        } else {
            (None, false)
        };
        let superseded =
            is_replay && (fr.superseded_by_key || (direct_moved && fallback_base.is_none()));
        (target, superseded, fallback_base, include_unconfirmed)
    };
    let reading = s.transcript_display.reading_mut();
    let fr = reading.frame_restore.take().unwrap();
    let obs_offset = fr.obs_offset;
    let max = fr.obs_max;
    let cur = reading.scroll_state.get();
    if superseded {
        return false;
    }
    reading.resize_anchor = None;
    let wants_older = target < obs_offset - 0.5;
    let wants_newer = target > obs_offset + 0.5;
    if !matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
        && s.reader
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
        return true;
    }
    let keep_replay_undo = matches!(fr.target, FrameRestoreTarget::ReplayDeltas { .. })
        || s.transcript_display.reading().sync_undo_gesture_active();
    if !keep_replay_undo && let Some(reader) = &mut s.reader {
        reader.clear_sync_undo();
    }
    let pending_scroll = s
        .reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::has_pending_scroll);
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    match fr.target {
        FrameRestoreTarget::Anchor(id, anchor_offset) => {
            let reading = s.transcript_display.reading_mut();
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
            true
        }
        FrameRestoreTarget::ReplayDeltas {
            anchor,
            deltas,
            anchor_retargeted,
            content_clamped_retried,
            ..
        } => {
            let resolved_raw: Vec<f32> = deltas
                .into_iter()
                .filter_map(|d| match d {
                    ReplayDelta::Vertical(dy) => Some(dy),
                    ReplayDelta::Diagonal { dy, confirmed, .. } => {
                        (confirmed || include_unconfirmed).then_some(dy)
                    }
                })
                .collect();
            let deltas: Vec<ReplayDelta> = resolved_raw
                .iter()
                .copied()
                .map(ReplayDelta::Vertical)
                .collect();
            let queue_layout_seq = s.transcript_display.reading().queue_layout_seq;
            let content_layout_seq = s.transcript_display.reading().content_layout_seq;
            let anchor_present = replay_anchor_present(s, &anchor);
            let queue_changed = fr.queue_layout_seq != queue_layout_seq;
            let content_changed = fr.content_layout_seq != content_layout_seq;
            let start = match &anchor {
                Bookmark::Latest => cur.max,
                Bookmark::Message { .. } => fallback_base.unwrap_or(cur.offset),
            };
            let (dest, clamped) = replay_deltas_checked(start, cur.max, &resolved_raw);
            let needs_rearm = anchor_retargeted || !anchor_present || queue_changed;
            let retry_for_content_clamp =
                !needs_rearm && clamped && content_changed && !content_clamped_retried;
            if needs_rearm || retry_for_content_clamp {
                let next_anchor = if anchor_present {
                    Some(anchor)
                } else {
                    fallback_replay_anchor(s, &anchor)
                };
                if let Some(next_anchor) = next_anchor {
                    let reading = s.transcript_display.reading_mut();
                    reading.frame_restore_epoch += 1;
                    reading.frame_restore = Some(FrameRestore {
                        epoch: reading.frame_restore_epoch,
                        obs_offset: 0.0,
                        obs_max: 0.0,
                        obs_seq: cur.seq,
                        direct_seq: cur.last_direct_seq,
                        queue_layout_seq,
                        content_layout_seq,
                        target: FrameRestoreTarget::ReplayDeltas {
                            anchor: next_anchor.clone(),
                            deltas,
                            restored_anchor: true,
                            anchor_retargeted: false,
                            content_clamped_retried: retry_for_content_clamp,
                        },
                        probe_live: true,
                        probe_ready: None,
                        input_poll_clock: None,
                        defer_for_input_clock: None,
                        superseded_by_key: false,
                        had_press_defer: false,
                        diagonal_fallback_base_offset: None,
                        handled: false,
                        post_probe: None,
                        checked: Cell::new(Some(Some(0.0))),
                    });
                    let at_bottom = cur.at_bottom();
                    reading.at_bottom = at_bottom;
                    reading.following = at_bottom;
                    s.revision += 1;
                    let rev = s.revision;
                    let reading = s.transcript_display.reading_mut();
                    reading.advance_row_guard(rev);
                    reading.note_programmatic_scroll();
                    if let Some(reader) = &mut s.reader {
                        reader.defer_sync_until(cur.seq + 2);
                    }
                    Reading::restore(&next_anchor, tx);
                    return true;
                }
                return false;
            }
            let anchor_key_target = match &anchor {
                Bookmark::Message { id, offset } => {
                    let anchor_y = s
                        .transcript_display
                        .reading()
                        .live_row_offset(id, history_bounds[1])
                        .unwrap_or_else(|| *offset - (cur.offset - start));
                    Some((id.clone(), anchor_y))
                }
                Bookmark::Latest => None,
            };
            let reading = s.transcript_display.reading_mut();
            let pin_bottom =
                matches!(anchor, Bookmark::Latest) && cur.max > 0.5 && dest >= cur.max - 0.5;
            let probe = PostProbe { clock: tx.clock() };
            if (cur.offset - dest).abs() <= 0.5 {
                let at_bottom = pin_bottom || cur.at_bottom();
                reading.at_bottom = at_bottom;
                reading.following = at_bottom;
                reading.frame_restore_epoch += 1;
                reading.frame_restore = Some(FrameRestore {
                    epoch: reading.frame_restore_epoch,
                    obs_offset: dest,
                    obs_max: cur.max,
                    obs_seq: cur.seq,
                    direct_seq: cur.last_direct_seq,
                    queue_layout_seq,
                    content_layout_seq,
                    target: FrameRestoreTarget::ReplayDeltas {
                        anchor,
                        deltas,
                        restored_anchor: false,
                        anchor_retargeted: false,
                        content_clamped_retried: false,
                    },
                    probe_live: false,
                    probe_ready: None,
                    input_poll_clock: None,
                    defer_for_input_clock: None,
                    superseded_by_key: false,
                    had_press_defer: false,
                    diagonal_fallback_base_offset: None,
                    handled: true,
                    post_probe: Some(probe),
                    checked: Cell::new(Some(None)),
                });
                if pin_bottom {
                    Reading::restore(&Bookmark::Latest, tx);
                    return true;
                }
                return false;
            }
            if pending_scroll {
                reading.note_pending_manual_scroll();
            } else {
                reading.bump_manual_scroll();
            }
            reading.note_programmatic_scroll();
            let at_bottom = pin_bottom || cur.max <= 0.5 || dest >= cur.max - 0.5;
            reading.at_bottom = at_bottom;
            reading.following = at_bottom;
            s.revision += 1;
            let reading = s.transcript_display.reading_mut();
            reading.advance_row_guard(s.revision);
            reading.frame_restore_epoch += 1;
            reading.frame_restore = Some(FrameRestore {
                epoch: reading.frame_restore_epoch,
                obs_offset: dest,
                obs_max: cur.max,
                obs_seq: cur.seq,
                direct_seq: cur.last_direct_seq,
                queue_layout_seq,
                content_layout_seq,
                target: FrameRestoreTarget::ReplayDeltas {
                    anchor,
                    deltas,
                    restored_anchor: false,
                    anchor_retargeted: false,
                    content_clamped_retried: false,
                },
                probe_live: false,
                probe_ready: None,
                input_poll_clock: None,
                defer_for_input_clock: None,
                superseded_by_key: false,
                had_press_defer: false,
                diagonal_fallback_base_offset: None,
                handled: true,
                post_probe: Some(probe),
                checked: Cell::new(Some(None)),
            });
            if let Some(reader) = &mut s.reader {
                reader.defer_sync_until(cur.seq + 1);
            }
            if pin_bottom {
                Reading::restore(&Bookmark::Latest, tx);
            } else if dest <= 0.5 {
                tx.instant();
                tx.scroll_to_y("history", 0.0);
            } else if let Some((id, anchor_y)) = anchor_key_target {
                tx.instant();
                tx.scroll_key_to(id, anchor_y + (cur.offset - dest));
            } else {
                tx.instant();
                tx.scroll_to_y("history", dest);
            }
            true
        }
        FrameRestoreTarget::FromBottom => {
            let reading = s.transcript_display.reading_mut();
            let from_bottom = (max - target).max(0.0);
            let dest = (cur.max - from_bottom).clamp(0.0, cur.max);
            if (cur.offset - dest).abs() <= 0.5 {
                let at_bottom = cur.at_bottom();
                reading.at_bottom = at_bottom;
                reading.following = at_bottom;
                return false;
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
            true
        }
        FrameRestoreTarget::Offset => {
            let reading = s.transcript_display.reading_mut();
            if (cur.offset - target).abs() <= 0.5 {
                let at_bottom = cur.at_bottom();
                reading.at_bottom = at_bottom;
                reading.following = at_bottom;
                return false;
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
            true
        }
    }
}

pub(crate) fn rearm_replay_on_layout_change(s: &mut State, tx: &mut Tx) -> bool {
    if s.messages.is_empty()
        || s.reader
            .as_ref()
            .is_some_and(crate::chat::reader::Reader::is_hidden)
        || !s.transcript_display.reading().pending_resize_wheel_replay()
    {
        return false;
    }
    let cur = s.transcript_display.reading().scroll_state.get();
    let next_anchor = s
        .transcript_display
        .reading()
        .frame_restore
        .as_ref()
        .and_then(|fr| match &fr.target {
            FrameRestoreTarget::ReplayDeltas { anchor, .. } => {
                if replay_anchor_present(s, anchor) {
                    Some(anchor.clone())
                } else {
                    fallback_replay_anchor(s, anchor)
                }
            }
            _ => None,
        });
    let Some(next_anchor) = next_anchor else {
        s.transcript_display.reading_mut().frame_restore = None;
        return false;
    };
    let anchor = {
        let reading = s.transcript_display.reading_mut();
        let Some(fr) = reading.frame_restore.as_mut() else {
            return false;
        };
        let FrameRestoreTarget::ReplayDeltas {
            anchor,
            restored_anchor,
            anchor_retargeted,
            content_clamped_retried,
            ..
        } = &mut fr.target
        else {
            return false;
        };
        *anchor = next_anchor;
        *restored_anchor = true;
        *anchor_retargeted = false;
        *content_clamped_retried = false;
        reading.frame_restore_epoch += 1;
        fr.epoch = reading.frame_restore_epoch;
        fr.obs_seq = cur.seq;
        fr.direct_seq = cur.last_direct_seq;
        fr.queue_layout_seq = reading.queue_layout_seq;
        fr.content_layout_seq = reading.content_layout_seq;
        fr.probe_live = true;
        fr.probe_ready = None;
        fr.input_poll_clock = None;
        fr.defer_for_input_clock = None;
        fr.superseded_by_key = false;
        fr.had_press_defer = false;
        fr.diagonal_fallback_base_offset = None;
        fr.handled = false;
        fr.post_probe = None;
        fr.checked.set(Some(Some(0.0)));
        reading.resize_anchor = None;
        let at_bottom = cur.at_bottom();
        reading.at_bottom = at_bottom;
        reading.following = at_bottom;
        anchor.clone()
    };
    s.revision += 1;
    let rev = s.revision;
    let reading = s.transcript_display.reading_mut();
    reading.advance_row_guard(rev);
    reading.note_programmatic_scroll();
    if let Some(reader) = &mut s.reader {
        reader.defer_sync_until(cur.seq + 2);
    }
    Reading::restore(&anchor, tx);
    true
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
            .is_some_and(crate::chat::reader::Reader::is_hidden)
    {
        return;
    }
    if rearm_replay_on_layout_change(s, tx) {
        return;
    }
    if s.transcript_display.reading().awaiting_wheel_replay() {
        return;
    }
    if s.reader
        .as_ref()
        .is_some_and(|reader| reader.defers_scroll())
    {
        return;
    }
    let keep_sync_undo = s
        .reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::has_sync_undo)
        && s.transcript_display.reading().frame_restore.is_some();
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
                if !keep_sync_undo {
                    reading.arm_frame_restore();
                }
                if let Some(anchor) = &mut reading.resize_anchor {
                    anchor.observed = None;
                    anchor.settling = true;
                    anchor.settle_seq = Some(cur.seq + 1);
                }
                reading.note_programmatic_scroll();
                tx.instant();
                Reading::restore(&bookmark, tx);
            } else if width_changed {
                if !keep_sync_undo {
                    reading.frame_restore = None;
                }
                reading.arm_resize_anchor(revision, id.clone(), *offset, width_grew);
            } else if reading.at_bottom {
                if !keep_sync_undo {
                    reading.frame_restore = None;
                }
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

    #[test]
    fn effective_wheel_delta_matches_rune_shift_rules() {
        let mut shift_precise = rune::WheelEvent::new(0.0, 240.0);
        shift_precise.mods.shift = true;
        shift_precise.precise = true;
        // On macOS (shift_turns_wheel == false), Shift + precise trackpad stays vertical.
        assert_eq!(
            effective_wheel_delta_for(&shift_precise, false),
            (0.0, 240.0)
        );
        // On non-macOS (shift_turns_wheel == true), Shift + vertical wheel turns horizontal.
        assert_eq!(
            effective_wheel_delta_for(&shift_precise, true),
            (240.0, 0.0)
        );

        let mut shift_notched = rune::WheelEvent::new(0.0, 240.0);
        shift_notched.mods.shift = true;
        shift_notched.precise = false;
        // Notched mouse wheel + Shift turns horizontal on every platform.
        assert_eq!(
            effective_wheel_delta_for(&shift_notched, false),
            (240.0, 0.0)
        );
        assert_eq!(
            effective_wheel_delta_for(&shift_notched, true),
            (240.0, 0.0)
        );

        let mut ctrl_shift = rune::WheelEvent::new(0.0, 240.0);
        ctrl_shift.mods.shift = true;
        ctrl_shift.mods.ctrl = true;
        // Ctrl + Shift stays vertical on every platform.
        assert_eq!(effective_wheel_delta_for(&ctrl_shift, false), (0.0, 240.0));
        assert_eq!(effective_wheel_delta_for(&ctrl_shift, true), (0.0, 240.0));
    }
}
