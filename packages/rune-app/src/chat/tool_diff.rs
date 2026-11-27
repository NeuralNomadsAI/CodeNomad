use super::{actions::Display, document::TOOL_LIMIT};
use crate::{
    State,
    components::diff::{self, DiffMode, DiffState},
    content::Tool,
    screen,
    strings::{locale, t},
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, DrawnRect, Layout},
    markdown,
};
use std::{
    cell::Cell,
    collections::VecDeque,
    rc::{Rc, Weak},
    sync::Arc,
};

const RETAINED: usize = 32;

mod parse;
pub(super) use parse::is_hunk;
use parse::parse_patch;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ComposerCaretPins {
    pub(crate) inner: Option<(f32, f32)>,
    pub(crate) stack: Option<(f32, f32)>,
}

type DraftSig = (
    (usize, usize),
    (u64, usize),
    Option<(u64, Option<(usize, usize)>)>,
);

fn fnv1a_bytes(text: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325_u64;
    for &b in text.as_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn draft_sig(edit: &rune::TextEdit) -> DraftSig {
    let preedit = edit
        .preedit()
        .map(|(text, cursor)| (fnv1a_bytes(text) ^ (text.len() as u64), cursor));
    (
        (edit.anchor, edit.focus),
        (fnv1a_bytes(&edit.text), edit.text.len()),
        preedit,
    )
}

pub(crate) struct Preferences {
    mode: DiffMode,
    compact: bool,
    layout_epoch: u64,
    history_size: [f32; 2],
    history_epoch: u64,
    stack_size: [f32; 2],
    stack_scrolled: bool,
    reveal_focused_composer: bool,
    agent_panel_height: f32,
    multi_pending: bool,
    attachment_error_shown: bool,
    pending_content_size: [f32; 2],
    pending_fields_size: [f32; 2],
    composer_field_size: [f32; 2],
    composer_caret_epoch: u64,
    reveal_composer_caret: bool,
    pinned_caret: Option<(ComposerCaretPins, u64)>,
    last_draft_sig: Cell<Option<DraftSig>>,
    follow_stack_caret: Cell<Option<(DraftSig, f32)>>,
    stack_caret_fired_rev: Option<u64>,
    focused_agent_control: Option<String>,
    last_agent_focus: Cell<Option<(u64, Option<DraftSig>, Option<(i32, i32)>)>>,
    pub(crate) stack_scroll: Rc<Cell<(f32, f32)>>,
    pub(crate) composer_scroll: Rc<Cell<(f32, f32)>>,
    pub(crate) session_list_scroll: Rc<Cell<(f32, f32)>>,
    pub(crate) right_panel_status_scroll: Rc<Cell<(f32, f32)>>,
    pub(crate) hovered_other_scrollers: u8,
    pub(crate) composer_bounds: DrawnRect,
    pub(crate) history_bounds: DrawnRect,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: DiffMode::Split,
            compact: false,
            layout_epoch: 0,
            history_size: [0.0; 2],
            history_epoch: 0,
            stack_size: [0.0; 2],
            stack_scrolled: false,
            reveal_focused_composer: false,
            agent_panel_height: 0.0,
            multi_pending: false,
            attachment_error_shown: false,
            pending_content_size: [0.0; 2],
            pending_fields_size: [0.0; 2],
            composer_field_size: [0.0; 2],
            composer_caret_epoch: 0,
            reveal_composer_caret: false,
            pinned_caret: None,
            last_draft_sig: Cell::new(None),
            follow_stack_caret: Cell::new(None),
            stack_caret_fired_rev: None,
            focused_agent_control: None,
            last_agent_focus: Cell::new(None),
            stack_scroll: Rc::new(Cell::new((0.0, 0.0))),
            composer_scroll: Rc::new(Cell::new((0.0, 0.0))),
            session_list_scroll: Rc::new(Cell::new((0.0, 0.0))),
            right_panel_status_scroll: Rc::new(Cell::new((0.0, 0.0))),
            hovered_other_scrollers: 0,
            composer_bounds: DrawnRect::new([0.0; 4]),
            history_bounds: DrawnRect::new([0.0; 4]),
        }
    }
}

impl Preferences {
    fn effective_mode(&self, compact_split: bool) -> DiffMode {
        match (self.compact, compact_split) {
            (true, true) => DiffMode::Split,
            (true, false) => DiffMode::Unified,
            (false, _) => self.mode,
        }
    }

    pub(crate) fn layout(s: &mut State, width: f32) -> bool {
        let compact = width <= 640.0;
        if compact == s.tool_diff_preferences.compact {
            return false;
        }
        s.tool_diff_preferences.compact = compact;
        s.tool_diff_preferences.layout_epoch += 1;
        Self::sync(s);
        s.revision += 1;
        true
    }

    pub(crate) fn sync(s: &mut State) {
        let p = &s.tool_diff_preferences;
        s.transcript_display
            .sync_diff_modes(p.layout_epoch, |split| p.effective_mode(split));
    }

    pub(crate) fn history_width(&self) -> f32 {
        let [_, _, w, _] = self.history_bounds.get();
        if w.is_finite() && w > 0.0 {
            w
        } else if self.history_size[0].is_finite() && self.history_size[0] > 0.0 {
            self.history_size[0]
        } else {
            0.0
        }
    }

    pub(crate) fn has_pending_resize(&self) -> bool {
        let [_, _, w, h] = self.history_bounds.get();
        valid_extent(w, h)
            && valid_extent(self.history_size[0], self.history_size[1])
            && ((self.history_size[0] - w).abs() > 0.5 || (self.history_size[1] - h).abs() > 0.5)
    }

    pub(crate) fn reset_history_size(&mut self) {
        self.history_size = [0.0; 2];
        self.stack_size = [0.0; 2];
        self.stack_scrolled = false;
        self.reveal_focused_composer = false;
        self.agent_panel_height = 0.0;
        self.multi_pending = false;
        self.attachment_error_shown = false;
        self.pending_content_size = [0.0; 2];
        self.pending_fields_size = [0.0; 2];
        self.composer_field_size = [0.0; 2];
        self.reveal_composer_caret = false;
        self.pinned_caret = None;
        self.last_draft_sig.set(None);
        self.follow_stack_caret.set(None);
        self.stack_caret_fired_rev = None;
        self.focused_agent_control = None;
        self.last_agent_focus.set(None);
        self.stack_scroll.set((0.0, 0.0));
        self.composer_scroll.set((0.0, 0.0));
        self.hovered_other_scrollers = 0;
        self.composer_bounds.set([0.0; 4]);
        self.history_bounds.set([0.0; 4]);
    }

    #[cfg(test)]
    pub(crate) fn focused_agent_control_key(&self) -> Option<&str> {
        self.focused_agent_control.as_deref()
    }

    pub(crate) fn sync_focused_agent_control(s: &mut State, focused: Option<&str>) -> bool {
        let next = if s.screen.is_launcher() {
            None
        } else {
            crate::agent::focused_control_key(s, focused).map(|(key, _)| key)
        };
        if s.tool_diff_preferences.focused_agent_control != next {
            s.tool_diff_preferences.focused_agent_control = next;
            s.revision += 1;
            true
        } else {
            false
        }
    }

    fn focused_agent_control(s: &State) -> Option<(String, Option<String>)> {
        crate::agent::focused_control_key(
            s,
            s.tool_diff_preferences.focused_agent_control.as_deref(),
        )
    }

    fn arm_composer_caret_reveal(&mut self) {
        self.composer_caret_epoch += 1;
        self.reveal_composer_caret = true;
    }

    fn reveal_composer_if_needed(&mut self, scroll_stack: bool, focused: bool) -> bool {
        let newly_scrolled = scroll_stack && !self.stack_scrolled;
        self.stack_scrolled = scroll_stack;
        if scroll_stack && focused && (self.reveal_focused_composer || newly_scrolled) {
            self.reveal_focused_composer = false;
            return true;
        }
        if !focused {
            self.reveal_focused_composer = false;
        }
        false
    }

    pub(crate) fn stack_layout(
        s: &mut State,
        [_, _, w, h]: [f32; 4],
        scroll_stack: bool,
        tx: &mut Tx,
    ) {
        if !valid_extent(w, h) {
            tx.live_only();
            return;
        }
        let p = &mut s.tool_diff_preferences;
        let [prev_w, prev_h] = p.stack_size;
        if (prev_w - w).abs() <= 0.5 && (prev_h - h).abs() <= 0.5 {
            if p.reveal_composer_if_needed(scroll_stack, s.draft.focused) {
                p.arm_composer_caret_reveal();
                s.revision += 1;
                tx.instant();
                tx.scroll_into_view("composer");
                return;
            }
            tx.live_only();
            return;
        }
        p.stack_size = [w, h];
        let shrank_h = prev_h > 0.0 && h < prev_h - 0.5;
        let shrank_w = prev_w > 0.0 && w < prev_w - 0.5;
        let changed_w = prev_w > 0.0 && (w - prev_w).abs() > 0.5;
        if (shrank_h || changed_w) && s.draft.focused {
            if scroll_stack {
                p.stack_scrolled = true;
                // Keep armed after width changes so composer_layout re-reveals if wrapped dock
                // chrome changes height on the following commit.
                p.reveal_focused_composer = changed_w;
                p.arm_composer_caret_reveal();
                s.revision += 1;
                tx.instant();
                tx.scroll_into_view("composer");
            } else if shrank_h || shrank_w {
                p.stack_scrolled = false;
                p.reveal_focused_composer = true;
                s.revision += 1;
            } else {
                p.stack_scrolled = false;
                tx.live_only();
            }
            return;
        }
        if shrank_h || changed_w {
            p.stack_scrolled = scroll_stack;
            if let Some((field_key, inner_scroll)) = Self::focused_agent_control(s) {
                tx.instant();
                tx.scroll_into_view(field_key);
                if scroll_stack && let Some(scroll_key) = inner_scroll {
                    tx.scroll_into_view(scroll_key);
                }
                return;
            }
        }
        let p = &mut s.tool_diff_preferences;
        if h > prev_h + 0.5 && w >= prev_w - 0.5 {
            p.reveal_focused_composer = false;
        }
        if p.reveal_composer_if_needed(scroll_stack, s.draft.focused) {
            p.arm_composer_caret_reveal();
            s.revision += 1;
            tx.instant();
            tx.scroll_into_view("composer");
            return;
        }
        tx.live_only();
    }

    pub(crate) fn pending_content_layout(s: &mut State, [_, _, w, h]: [f32; 4], tx: &mut Tx) {
        if !valid_extent(w, h) {
            tx.live_only();
            return;
        }
        let p = &mut s.tool_diff_preferences;
        let [prev_w, prev_h] = p.pending_content_size;
        p.pending_content_size = [w, h];
        let resized = valid_extent(prev_w, prev_h);
        if resized && (h < prev_h - 0.5 || (w - prev_w).abs() > 0.5) {
            let stack_scrolled = p.stack_scrolled;
            if let Some((field_key, inner_scroll)) = Self::focused_agent_control(s) {
                tx.instant();
                tx.scroll_into_view(field_key);
                if stack_scrolled && let Some(scroll_key) = inner_scroll {
                    tx.scroll_into_view(scroll_key);
                }
                return;
            }
        }
        tx.live_only();
    }

    pub(crate) fn pending_fields_layout(s: &mut State, [_, _, w, h]: [f32; 4], tx: &mut Tx) {
        if !valid_extent(w, h) {
            tx.live_only();
            return;
        }
        let p = &mut s.tool_diff_preferences;
        let [prev_w, prev_h] = p.pending_fields_size;
        p.pending_fields_size = [w, h];
        let resized = valid_extent(prev_w, prev_h);
        if resized && ((h - prev_h).abs() > 0.5 || (w - prev_w).abs() > 0.5) {
            let stack_scrolled = p.stack_scrolled;
            if let Some((field_key, inner_scroll)) = Self::focused_agent_control(s) {
                tx.instant();
                tx.scroll_into_view(field_key);
                if stack_scrolled && let Some(scroll_key) = inner_scroll {
                    tx.scroll_into_view(scroll_key);
                }
                return;
            }
        }
        tx.live_only();
    }

    pub(crate) fn agent_panel_layout(
        s: &mut State,
        [_, _, w, h]: [f32; 4],
        scroll_stack: bool,
        tx: &mut Tx,
    ) {
        if !valid_extent(w, h) {
            tx.live_only();
            return;
        }
        let multi_pending = s.agent.as_ref().is_some_and(|a| a.ids().len() > 1);
        let p = &mut s.tool_diff_preferences;
        let prev_h = p.agent_panel_height;
        let prev_multi = p.multi_pending;
        p.agent_panel_height = h;
        p.multi_pending = multi_pending;
        let height_changed = prev_h > 0.0 && (h - prev_h).abs() > 0.5;
        let nav_changed = prev_h > 0.0 && multi_pending != prev_multi;
        if (height_changed || nav_changed) && scroll_stack {
            if s.draft.focused {
                p.stack_scrolled = true;
                p.reveal_focused_composer = false;
                p.arm_composer_caret_reveal();
                s.revision += 1;
                tx.instant();
                tx.scroll_into_view("composer");
                return;
            }
            if let Some((field_key, inner_scroll)) = Self::focused_agent_control(s) {
                tx.instant();
                tx.scroll_into_view(field_key);
                if let Some(scroll_key) = inner_scroll {
                    tx.scroll_into_view(scroll_key);
                }
                return;
            }
        }
        tx.live_only();
    }

    pub(crate) fn composer_layout(s: &mut State, scroll_stack: bool, tx: &mut Tx) {
        let p = &mut s.tool_diff_preferences;
        let error_changed = s.attachments.error != p.attachment_error_shown;
        p.attachment_error_shown = s.attachments.error;
        if error_changed && scroll_stack && s.draft.focused {
            p.reveal_focused_composer = true;
        }
        if p.reveal_composer_if_needed(scroll_stack, s.draft.focused) {
            p.arm_composer_caret_reveal();
            s.revision += 1;
            tx.instant();
            tx.scroll_into_view("composer");
            return;
        }
        tx.live_only();
    }

    pub(crate) fn composer_field_layout(s: &mut State, [_, _, w, h]: [f32; 4], tx: &mut Tx) {
        if !valid_extent(w, h) {
            tx.live_only();
            return;
        }
        let p = &mut s.tool_diff_preferences;
        let [prev_w, prev_h] = p.composer_field_size;
        p.composer_field_size = [w, h];
        if !s.draft.focused {
            p.reveal_composer_caret = false;
            p.follow_stack_caret.set(None);
            tx.live_only();
            return;
        }
        let resized = valid_extent(prev_w, prev_h);
        if resized && (h < prev_h - 0.5 || (w - prev_w).abs() > 0.5) {
            p.arm_composer_caret_reveal();
            s.revision += 1;
            return;
        }
        tx.live_only();
    }

    pub(crate) fn agent_focus_probe(
        s: &State,
        cx: &rune::Cx<State>,
        scroll_stack: bool,
    ) -> Option<El> {
        let p = &s.tool_diff_preferences;
        let Some((field_key, inner_scroll)) = Self::focused_agent_control(s) else {
            p.last_agent_focus.set(None);
            return None;
        };
        let key_hash = fnv1a_bytes(&field_key) ^ (field_key.len() as u64);
        let edit_sig = crate::agent::focused_field_edit(s).map(draft_sig);
        let field_layout = layout::layout_rect(cx, &field_key)
            .filter(|r| valid_extent(r[2], r[3]))
            .map(|r| (r[1].round() as i32, r[3].round() as i32));
        let sig = (key_hash, edit_sig, field_layout);
        if !scroll_stack && inner_scroll.is_none() {
            p.last_agent_focus.set(Some(sig));
            return None;
        }
        if p.last_agent_focus.get() == Some(sig) {
            return None;
        }
        let rect_inside = |child: [f32; 4], parent: [f32; 4]| -> bool {
            valid_extent(child[2], child[3])
                && valid_extent(parent[2], parent[3])
                && child[1] >= parent[1] - 0.5
                && child[1] + child[3] <= parent[1] + parent[3] + 0.5
        };
        let field_win = layout::window_layout(cx, &field_key);
        let scroll_win = inner_scroll
            .as_deref()
            .and_then(|scroll_key| layout::window_layout(cx, scroll_key));
        let stack_win = scroll_stack
            .then(|| layout::window_layout(cx, "session-stack"))
            .flatten();
        let in_inner = field_win.is_some_and(|fw| {
            inner_scroll.is_none() || scroll_win.is_some_and(|sw| rect_inside(fw, sw))
        });
        let in_stack = !scroll_stack
            || field_win.is_some_and(|fw| stack_win.is_some_and(|stw| rect_inside(fw, stw)));
        if in_inner && in_stack {
            p.last_agent_focus.set(Some(sig));
            return None;
        }
        let direct_stack_target = if scroll_stack
            && in_inner
            && !in_stack
            && let (Some(fw), Some(sw), Some(stw)) = (field_win, scroll_win, stack_win)
            && valid_extent(fw[2], fw[3])
            && valid_extent(sw[2], sw[3])
            && valid_extent(stw[2], stw[3])
            && sw[3] > stw[3] + 0.5
        {
            let (cur_y, cur_max) = p.stack_scroll.get();
            let delta = if fw[1] < stw[1] - 0.5 {
                fw[1] - stw[1]
            } else if fw[1] + fw[3] > stw[1] + stw[3] + 0.5 {
                (fw[1] + fw[3]) - (stw[1] + stw[3])
            } else {
                0.0
            };
            (delta.abs() > 0.5).then(|| (cur_y + delta).clamp(0.0, cur_max))
        } else {
            None
        };
        let mut probe_hash = key_hash;
        if let Some(((a, f), (th, tl), pre)) = edit_sig {
            probe_hash = probe_hash.rotate_left(7) ^ (a as u64);
            probe_hash = probe_hash.rotate_left(7) ^ (f as u64);
            probe_hash = probe_hash.rotate_left(7) ^ th ^ (tl as u64);
            if let Some((ph, pc)) = pre {
                probe_hash = probe_hash.rotate_left(7) ^ ph;
                if let Some((pa, pb)) = pc {
                    probe_hash = probe_hash.rotate_left(7) ^ (pa as u64) ^ ((pb as u64) << 16);
                }
            }
        }
        if let Some((ly, lh)) = field_layout {
            probe_hash =
                probe_hash.rotate_left(7) ^ (ly as u32 as u64) ^ ((lh as u32 as u64) << 32);
        }
        let probe_key = format!("agent-focus-{field_key}-{probe_hash:x}");
        Some(
            rune_theme_codenomad::layout::layout_probe(probe_key).on_layout_tx(
                move |s: &mut State, _, tx| {
                    if s.screen.is_launcher()
                        || Self::focused_agent_control(s).is_none_or(|(key, _)| key != field_key)
                    {
                        tx.live_only();
                        return;
                    }
                    s.tool_diff_preferences.last_agent_focus.set(Some(sig));
                    tx.instant();
                    tx.scroll_into_view(field_key.clone());
                    if let Some(target_y) = direct_stack_target {
                        tx.scroll_to_y("session-stack", target_y);
                    } else if scroll_stack && let Some(scroll_key) = inner_scroll.clone() {
                        tx.scroll_into_view(scroll_key);
                    }
                },
            ),
        )
    }

    pub(crate) fn watch_stack_wheel(&self, scroll_stack: bool, revision: u64) -> bool {
        scroll_stack
            && (self.follow_stack_caret.get().is_some()
                || self.stack_caret_fired_rev == Some(revision))
    }

    pub(crate) fn stack_wheel(s: &mut State, dy: f32, tx: &mut Tx) -> bool {
        if s.screen.is_launcher() || !dy.is_finite() || dy.abs() <= 0.001 {
            return false;
        }
        let p = &mut s.tool_diff_preferences;
        p.follow_stack_caret.set(None);
        if p.stack_caret_fired_rev == Some(s.revision) {
            let (cur_y, cur_max) = p.stack_scroll.get();
            let target = (cur_y - dy).clamp(0.0, cur_max);
            let moved = (target - cur_y).abs() > 0.5;
            p.stack_scroll.set((target, cur_max));
            p.pinned_caret = None;
            tx.instant();
            tx.scroll_to_y("session-stack", target);
            return moved;
        }
        false
    }

    pub(crate) fn composer_caret_plan(
        s: &State,
        cx: &rune::Cx<State>,
        scroll_stack: bool,
    ) -> (ComposerCaretPins, Option<El>) {
        let p = &s.tool_diff_preferences;
        let held_pins = p
            .pinned_caret
            .and_then(|(pins, rev)| (rev == s.revision).then_some(pins))
            .unwrap_or_default();
        if !s.draft.focused {
            p.last_draft_sig.set(None);
            p.follow_stack_caret.set(None);
            return (held_pins, None);
        }
        // Keep Rune's caret_watch active while focused so caret geometry is fresh on resize and edits.
        let caret = layout::caret_rect(cx, "composer");
        let sig = draft_sig(&s.draft);
        let armed = p.reveal_composer_caret;
        let prev_sig = p.last_draft_sig.get();
        let sig_changed = prev_sig != Some(sig);
        let Some(caret) = caret else {
            let needs_reveal = match (
                layout::window_layout(cx, "composer"),
                layout::window_layout(cx, "session-stack"),
            ) {
                (Some(c), Some(s_rect))
                    if valid_extent(c[2], c[3]) && valid_extent(s_rect[2], s_rect[3]) =>
                {
                    c[1] >= s_rect[1] + s_rect[3] - 0.5 || c[1] + c[3] <= s_rect[1] + 0.5
                }
                _ => true,
            };
            if scroll_stack
                && needs_reveal
                && (armed || sig_changed || p.follow_stack_caret.get().is_some())
            {
                let probe = rune_theme_codenomad::layout::layout_probe("composer-focus-reveal")
                    .on_layout_tx(move |s: &mut State, _, tx| {
                        if s.screen.is_launcher() || !s.draft.focused {
                            tx.live_only();
                            return;
                        }
                        let p = &mut s.tool_diff_preferences;
                        p.arm_composer_caret_reveal();
                        s.revision += 1;
                        tx.instant();
                        tx.scroll_into_view("composer");
                    });
                return (held_pins, Some(probe));
            }
            return (held_pins, None);
        };
        if !scroll_stack {
            p.last_draft_sig.set(Some(sig));
            p.follow_stack_caret.set(None);
            if !armed {
                return (held_pins, None);
            }
        } else if !armed && !sig_changed && p.follow_stack_caret.get().is_none() {
            return (held_pins, None);
        }
        let Some(bounds) = layout::window_layout(cx, "composer") else {
            return (held_pins, None);
        };
        if !valid_extent(bounds[2], bounds[3]) {
            return (held_pins, None);
        }
        if sig_changed {
            p.last_draft_sig.set(Some(sig));
            if scroll_stack {
                p.follow_stack_caret.set(Some((sig, bounds[1])));
            } else {
                p.follow_stack_caret.set(None);
            }
        } else if let Some((_, armed_comp_y)) = p.follow_stack_caret.get()
            && (bounds[1] - armed_comp_y).abs() > 0.5
        {
            p.follow_stack_caret.set(None);
        }
        let following_stack = scroll_stack && p.follow_stack_caret.get().is_some();
        if !armed && !following_stack {
            return (held_pins, None);
        }
        let caret_h = caret[3].max(1.0);
        let rel_top = caret[1] - bounds[1];
        let view_h = bounds[3];
        let (scroll_y, scroll_max) = p.composer_scroll.get();
        let raw_inner = if armed {
            if rel_top + caret_h > view_h {
                rel_top + caret_h - view_h
            } else if rel_top < 0.0 {
                rel_top
            } else {
                0.0
            }
        } else {
            0.0
        };
        let need_inner = armed && scroll_max > 0.5 && raw_inner.abs() > 0.5;
        let actual_inner = if need_inner {
            (scroll_y + raw_inner).clamp(0.0, scroll_max) - scroll_y
        } else {
            0.0
        };
        let inner_pin = need_inner.then_some((
            (scroll_y + rel_top).clamp(0.0, (scroll_max + view_h - caret_h).max(0.0)),
            caret_h,
        ));
        let stack_win = scroll_stack
            .then(|| layout::window_layout(cx, "session-stack"))
            .flatten()
            .filter(|r| valid_extent(r[2], r[3]));
        let need_stack = stack_win.is_some_and(|s_rect| {
            let s_top = (caret[1] - actual_inner) - s_rect[1];
            let s_bottom = s_top + caret_h;
            s_top < -0.5 || s_bottom > s_rect[3] + 0.5
        });
        let stack_pin_y = (rel_top - actual_inner).clamp(0.0, (view_h - caret_h).max(0.0));
        let stack_pin = need_stack.then_some((stack_pin_y, caret_h));
        if !need_inner && !need_stack && !armed {
            return (held_pins, None);
        }
        let pins = ComposerCaretPins {
            inner: inner_pin.or(held_pins.inner),
            stack: stack_pin.or(held_pins.stack),
        };
        let epoch = p.composer_caret_epoch;
        let key = if armed {
            format!("composer-caret-{epoch}")
        } else {
            format!(
                "stack-caret-{}-{}-{}-{}-{}-{}",
                sig.0.0,
                sig.0.1,
                sig.1.0,
                sig.1.1,
                sig.2.map_or(0, |(h, _)| h),
                stack_pin_y.round() as i32
            )
        };
        let reveal_pins = ComposerCaretPins {
            inner: inner_pin,
            stack: stack_pin,
        };
        let mounted_comp_y = bounds[1];
        let mounted_stack_y = p.stack_scroll.get().0;
        let probe = rune_theme_codenomad::layout::layout_probe(key).on_layout_tx(
            move |s: &mut State, _, tx| {
                let p = &mut s.tool_diff_preferences;
                if s.screen.is_launcher()
                    || !s.draft.focused
                    || (armed && (p.composer_caret_epoch != epoch || !p.reveal_composer_caret))
                    || (!armed && p.follow_stack_caret.get().is_none())
                {
                    tx.live_only();
                    return;
                }
                if !armed {
                    let comp_drawn = p.composer_bounds.get();
                    let moved_comp =
                        comp_drawn[3] > 0.0 && (comp_drawn[1] - mounted_comp_y).abs() > 0.5;
                    let moved_stack = (p.stack_scroll.get().0 - mounted_stack_y).abs() > 0.5;
                    if moved_comp || moved_stack {
                        p.follow_stack_caret.set(None);
                        tx.live_only();
                        return;
                    }
                }
                if draft_sig(&s.draft) != sig {
                    p.reveal_composer_caret = false;
                    tx.live_only();
                    return;
                }
                p.reveal_composer_caret = false;
                if need_stack {
                    p.follow_stack_caret.set(None);
                }
                if need_inner || need_stack {
                    s.revision += 1;
                    s.tool_diff_preferences.pinned_caret = Some((reveal_pins, s.revision));
                    if need_stack {
                        s.tool_diff_preferences.stack_caret_fired_rev = Some(s.revision);
                    }
                    tx.instant();
                    if need_inner {
                        tx.scroll_into_view("composer-caret-pin");
                    }
                    if need_stack {
                        tx.scroll_into_view("stack-caret-pin");
                    }
                } else {
                    tx.live_only();
                }
            },
        );
        (pins, Some(probe))
    }

    pub(crate) fn history_layout(
        s: &mut State,
        [_, _, w, h]: [f32; 4],
        scroll_stack: bool,
        tx: &mut Tx,
    ) {
        let p = &mut s.tool_diff_preferences;
        let reveal_composer = p.reveal_composer_if_needed(scroll_stack, s.draft.focused);
        if !valid_extent(w, h) || p.history_size == [w, h] {
            if w.is_finite() && w > 0.0 && p.history_size[0] <= 0.0 {
                p.history_size[0] = w;
            }
            if reveal_composer {
                p.arm_composer_caret_reveal();
                s.revision += 1;
                tx.instant();
                tx.scroll_into_view("composer");
            } else {
                tx.live_only();
            }
        } else {
            let resized = valid_extent(p.history_size[0], p.history_size[1]);
            let width_changed = resized && (w - p.history_size[0]).abs() > 0.5;
            let width_grew = resized && w > p.history_size[0] + 0.5;
            p.history_size = [w, h];
            p.history_epoch += 1;
            s.revision += 1;
            if width_grew
                && let Some(reader) = &mut s.reader
                && reader.defers_scroll()
            {
                reader.note_width_growth();
            }
            if resized {
                crate::chat::reading::preserve_on_resize(s, tx, width_changed, width_grew);
            }
            if reveal_composer {
                s.tool_diff_preferences.arm_composer_caret_reveal();
                tx.instant();
                tx.scroll_into_view("composer");
            }
        }
    }
}

fn valid_extent(w: f32, h: f32) -> bool {
    w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0
}

fn intersects([x, y, w, h]: [f32; 4], [left, top, width, height]: [f32; 4]) -> bool {
    w > 0.0
        && h > 0.0
        && width > 0.0
        && height > 0.0
        && x < left + width
        && left < x + w
        && y < top + height
        && top < y + h
}

struct Entry {
    key: String,
    bounds: Weak<DrawnRect>,
    patch: String,
    file: String,
    state: DiffState,
    lines: usize,
}

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    detached: DiffState,
}

impl Cache {
    pub(super) fn retained_bytes(&self) -> usize {
        self.entries.iter().fold(0usize, |total, entry| {
            total
                .saturating_add(entry.key.len())
                .saturating_add(entry.patch.len())
                .saturating_add(entry.file.len())
                .saturating_add(entry.lines.saturating_mul(96))
        })
    }

    pub(super) fn sync(&mut self, mode: impl Fn(&str) -> DiffMode) {
        for entry in &mut self.entries {
            entry.state.set_mode(mode(&entry.key));
        }
    }

    fn read(&self, key: &str) -> &DiffState {
        self.entries
            .iter()
            .find(|entry| entry.key == key)
            .map_or(&self.detached, |entry| &entry.state)
    }

    fn edit(&mut self, key: &str) -> &mut DiffState {
        self.entries
            .iter_mut()
            .find(|entry| entry.key == key)
            .map_or(&mut self.detached, |entry| &mut entry.state)
    }

    fn load(
        &mut self,
        key: &str,
        patch: &str,
        path: &str,
        bounds: &Rc<DrawnRect>,
        preferences: &Preferences,
        (mode, wrap): (DiffMode, bool),
    ) -> bool {
        let former = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .and_then(|index| self.entries.remove(index));
        if former
            .as_ref()
            .is_some_and(|entry| entry.patch == patch && entry.file == path)
        {
            self.entries.extend(former.map(|mut entry| {
                entry.bounds = Rc::downgrade(bounds);
                entry
            }));
            return false;
        }
        if self.entries.len() >= RETAINED {
            let Some(index) = self.entries.iter().position(|entry| {
                entry.bounds.upgrade().is_none_or(|bounds| {
                    !intersects(bounds.get(), preferences.history_bounds.get())
                })
            }) else {
                return false;
            };
            self.entries.remove(index);
        }
        let files = parse_patch(patch, path);
        let lines = files
            .iter()
            .filter(|file| !file.hunks.is_empty())
            .map(|file| {
                2 + file
                    .hunks
                    .iter()
                    .map(|hunk| 1 + hunk.lines.len())
                    .sum::<usize>()
            })
            .sum();
        let mut state = DiffState::new(files);
        state.set_mode(mode);
        state.set_wrap(wrap);
        self.entries.push_back(Entry {
            key: key.into(),
            bounds: Rc::downgrade(bounds),
            patch: patch.into(),
            file: path.into(),
            state,
            lines,
        });
        true
    }
}

pub(super) fn candidate(tool: &Tool, patch: &str) -> bool {
    tool.name == "edit"
        && matches!(tool.status.as_str(), "running" | "completed")
        && structured_candidate(patch)
}

pub(super) fn structured_candidate(patch: &str) -> bool {
    patch.encode_utf16().nth(TOOL_LIMIT).is_none() && patch.lines().any(is_hunk)
}

pub(super) fn body(
    s: &State,
    message: &str,
    key: &str,
    tool: &Arc<Tool>,
    patch: &str,
    path: &str,
    fallback: impl FnOnce() -> El,
) -> El {
    let path = &path[..path.floor_char_boundary(path.len().min(4096))];
    let entry = s
        .transcript_display
        .diffs
        .entries
        .iter()
        .find(|entry| entry.key == key && entry.patch == patch && entry.file == path);
    let bounds = entry
        .and_then(|entry| entry.bounds.upgrade())
        .unwrap_or_else(|| Rc::new(DrawnRect::new([0.0; 4])));
    let wrap_key = format!("{key}-wrap");
    let content = match entry {
        Some(entry) if entry.lines > 0 => view(
            s,
            key,
            entry,
            (tool.name != "apply_patch")
                .then(|| path.rsplit(['/', '\\']).next().unwrap_or_default()),
        ),
        _ => {
            let stamp = (
                Arc::as_ptr(tool) as usize,
                Rc::as_ptr(&s.input_scope) as usize,
                locale(),
                s.transcript_display.toggled(&wrap_key),
                s.transcript_display.steps(key),
            );
            markdown::hold_frame(format!("{key}-diff-fallback"), stamp, fallback)
        }
    };
    let scope = s.input_scope.clone();
    let message = message.to_owned();
    let key = key.to_owned();
    let patch = patch.to_owned();
    let path = path.to_owned();
    let tool = tool.clone();
    // The retry marker remounts on resize without moving the selected text's node.
    let retry = entry
        .is_none()
        .then_some(s.tool_diff_preferences.history_epoch);
    let card_key = format!(
        "{key}-card-{:p}-{:p}",
        Rc::as_ptr(&scope),
        Arc::as_ptr(&tool)
    );
    let drawn = bounds.clone();
    let admit = Rc::new(move |s: &mut State, tx: &mut Tx| {
        let wrap = !s.transcript_display.toggled(&wrap_key);
        let p = &s.tool_diff_preferences;
        let mode = p.effective_mode(s.transcript_display.compact_split(p.layout_epoch, &key));
        if intersects(bounds.get(), s.tool_diff_preferences.history_bounds.get())
            && s.current_scope(&scope)
            && s.messages.iter().find(|row| row.id == message).into_iter().flat_map(|row| &row.parts).any(|part|
                matches!(part, crate::content::Part::Tool(current) if Arc::ptr_eq(current, &tool)))
            && s.transcript_display
                .diffs
                .load(&key, &patch, &path, &bounds, p, (mode, wrap))
        {
            s.revision += 1;
        } else {
            tx.live_only();
        }
    });
    let enter = admit.clone();
    let retry_admit = admit.clone();
    col()
        .full_width()
        .key(card_key)
        .child(content)
        .children(retry.map(|epoch| {
            col()
                .key(format!("retry-{epoch}"))
                .on_drawn_layout_tx(move |s: &mut State, _, tx| retry_admit(s, tx))
        }))
        .drawn_rect_into(&drawn)
        .on_drawn_layout_tx(move |s: &mut State, _, tx| admit(s, tx))
        .on_visible(move |s: &mut State, visible, tx| {
            if visible {
                enter(s, tx)
            } else {
                tx.live_only()
            }
        })
}

fn view(s: &State, key: &str, entry: &Entry, path: Option<&str>) -> El {
    let split = entry.state.mode() == DiffMode::Split;
    let wrapped = entry.state.wrap();
    let file = path
        .unwrap_or_default()
        .chars()
        .take(250)
        .collect::<String>();
    let title = if file.is_empty() {
        t("toolCall.diff.label").into()
    } else {
        catalogue::format(locale(), "toolCall.diff.label.withPath", &[("path", &file)])
    };
    let (read, write) = (key.to_owned(), key.to_owned());
    let mode_key = key.to_owned();
    let wrap_card = key.to_owned();
    let wrap_key = format!("{key}-wrap");
    let patch = entry.patch.clone();
    col()
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::action_row()
                .label(t("toolCall.diff.viewMode.ariaLabel"))
                .children(path.map(|_| text(title)))
                .child(
                    markdown::copy_button(
                        t("toolCall.diff.copyPatch"),
                        screen::action_tx(&s.input_scope, move |s, tx| {
                            s.transcript_display.children.cancel_copy();
                            tx.copy(patch.as_str());
                        }),
                    )
                    .key(format!("{key}-copy-patch")),
                )
                .child(
                    layout::button(
                        t(if split {
                            "toolCall.diff.switchToUnified"
                        } else {
                            "toolCall.diff.switchToSplit"
                        }),
                        false,
                        screen::action(&s.input_scope, move |s| {
                            let mode = if split {
                                DiffMode::Unified
                            } else {
                                DiffMode::Split
                            };
                            s.tool_diff_preferences.mode = mode;
                            if s.tool_diff_preferences.compact {
                                s.transcript_display.set_compact_split(
                                    s.tool_diff_preferences.layout_epoch,
                                    &mode_key,
                                    !split,
                                );
                            }
                            Preferences::sync(s);
                            s.revision += 1;
                        }),
                    )
                    .key(format!("{key}-mode"))
                    .checked(split),
                )
                .child(
                    layout::button(
                        t(if wrapped || split {
                            "toolCall.diff.disableWordWrap"
                        } else {
                            "toolCall.diff.enableWordWrap"
                        }),
                        split,
                        screen::action(&s.input_scope, move |s| {
                            Display::toggle(s, &wrap_key);
                            s.transcript_display
                                .diffs
                                .edit(&wrap_card)
                                .set_wrap(!wrapped);
                        }),
                    )
                    .key(format!("{key}-wrap"))
                    .checked(wrapped || split),
                ),
        )
        .child(crate::chat::reading::inner_diff_scroller(
            markdown::diff_pane(
                diff::view(
                    s,
                    format!("{key}-diff"),
                    move |s| s.transcript_display.diffs.read(&read),
                    move |s| s.transcript_display.diffs.edit(&write),
                    None,
                ),
                entry.lines,
            ),
            !wrapped,
            entry.lines > 30,
        ))
}

#[cfg(test)]
#[test]
fn admission_never_evicts_a_still_visible_diff() {
    let mut cache = Cache::default();
    let preferences = Preferences::default();
    preferences.history_bounds.set([0.0, 0.0, 100.0, 100.0]);
    let patch = "@@ -1 +1 @@\n-A\n+B";
    let cards: Vec<_> = (0..RETAINED)
        .map(|_| Rc::new(DrawnRect::new([5.0, 5.0, 10.0, 10.0])))
        .collect();
    for (i, visible) in cards.iter().enumerate() {
        assert!(cache.load(
            &i.to_string(),
            patch,
            "file.rs",
            visible,
            &preferences,
            (DiffMode::Split, true)
        ));
    }
    let next = Rc::new(DrawnRect::new([5.0, 5.0, 10.0, 10.0]));
    for _ in 0..3 {
        assert!(!cache.load(
            "next",
            patch,
            "file.rs",
            &next,
            &preferences,
            (DiffMode::Split, true)
        ));
        assert!(cache.entries.iter().any(|entry| entry.key == "0"));
    }
    cards[0].set([5.0, 150.0, 10.0, 10.0]);
    assert!(cache.load(
        "next",
        patch,
        "file.rs",
        &next,
        &preferences,
        (DiffMode::Split, true)
    ));
    assert!(!cache.entries.iter().any(|entry| entry.key == "0"));
    assert_eq!(cache.entries.len(), RETAINED);
}

#[cfg(test)]
#[test]
fn a_partial_parse_never_replaces_the_raw_patch() {
    for patch in [
        "@@ -1 +1 @@\n-A\n+B\n@@ -4294967296 +4294967296 @@\n-C\n+D",
        "@@ -1 +1 @@\n-A\n+B\n+C",
        "@@ -1,2 +1,2 @@\n-A\n+B",
    ] {
        assert!(parse_patch(patch, "file.rs").is_empty());
    }
    assert!(!parse_patch("@@ -1 +1 @@\n-A\n+B", "file.rs").is_empty());
}

#[cfg(test)]
#[test]
fn a_small_patch_with_expensive_word_pairing_stays_raw() {
    let patch = format!(
        "@@ -1,4 +1,4 @@\n{}{}",
        format!("-{}\n", "!".repeat(999)).repeat(4),
        format!("+{}\n", "?".repeat(999)).repeat(4)
    );
    assert!(patch.encode_utf16().count() < TOOL_LIMIT);
    assert!(parse_patch(&patch, "file.rs").is_empty());
}
