use super::{Marker, owner};
use crate::{
    State,
    chat::{anchors, reader, search_hit::Landing},
    history::Page,
    transport::Command,
};
use codenomad_client::{
    Sender, bounded,
    timeline::{Admission, Jump},
};
use rune::Tx;

#[derive(Default)]
pub(super) struct Navigation {
    serial: u64,
    flight: Option<(Sender<()>, Marker)>,
    pub(super) align: Option<(String, String)>,
    pub(super) retry: Option<Marker>,
    pub(super) filtered: bool,
    filtered_by_rail: bool,
    pub(super) requested_active: Option<String>,
    pub(super) active: Option<String>,
    pub(super) active_version: Option<u64>,
    active_index: Option<(u64, usize)>,
    locked: bool,
    pub(super) last: super::view::Scroll,
    browse: bool,
}

pub(super) fn clear_browse(s: &mut State) {
    let t = owner(s);
    t.jump.browse = false;
    let mut scroll = t.scroll.get();
    scroll.rail_glide = None;
    scroll.rail_glide_interrupted = false;
    scroll.halt_rail_glide = false;
    t.scroll.set(scroll);
    t.jump.last.rail = scroll.rail;
}

pub(super) fn has_pending_or_locked(s: &State) -> bool {
    let j = &s.transcript_display.timeline.jump;
    j.flight.is_some() || j.locked || j.retry.is_some()
}

pub(super) fn cancel_rail_jump(s: &mut State, clear_locked: bool) -> bool {
    let j = &s.transcript_display.timeline.jump;
    let rail_jump = j.flight.as_ref().is_some_and(|(_, m)| !m.id.is_empty())
        || j.retry.as_ref().is_some_and(|m| !m.id.is_empty())
        || (clear_locked && j.locked && j.requested_active.is_some());
    if rail_jump {
        cancel_jump(s);
        true
    } else if j.filtered && j.filtered_by_rail {
        set_filtered(s, false);
        true
    } else {
        false
    }
}

impl Navigation {
    pub(super) fn has_flight(&self) -> bool {
        self.flight.is_some()
    }
}

#[cfg(test)]
impl Navigation {
    pub(super) fn is_browsing(&self) -> bool {
        self.browse
    }

    pub(super) fn is_locked(&self) -> bool {
        self.locked
    }
}

pub(crate) fn cancel_jump(s: &mut State) {
    set_filtered(s, false);
    let j = &mut owner(s).jump;
    j.serial = j.serial.wrapping_add(1);
    j.flight = None;
    j.align = None;
    j.retry = None;
    j.locked = false;
}

pub(crate) fn input_precedes_admission(s: &State, tx: &mut Tx) -> bool {
    let pending = s.paging || s.transcript_display.timeline.jump.flight.is_some();
    if pending && tx.input_waiting() {
        // Rune polls before dispatching queued input. Let that gesture own the next window.
        tx.wake_after(std::time::Duration::ZERO);
        return true;
    }
    false
}

pub(super) fn cancel_search(s: &mut State) {
    let jump = &owner(s).jump;
    if jump
        .flight
        .as_ref()
        .is_some_and(|(_, target)| target.id.is_empty())
        || jump
            .retry
            .as_ref()
            .is_some_and(|target| target.id.is_empty())
    {
        cancel_jump(s);
    } else if jump.locked && jump.requested_active.is_none() {
        let jump = &mut owner(s).jump;
        jump.locked = false;
        jump.active_version = None;
    }
    set_filtered(s, false);
}

pub(super) fn select(s: &mut State, id: &str, tx: &mut Tx) {
    let target = owner(s).markers.iter().find(|m| m.id == id).cloned();
    if let Some(target) = target {
        start(s, target, tx);
    }
}

pub(super) fn retry(s: &mut State, tx: &mut Tx) {
    if let Some(target) = owner(s).jump.retry.take() {
        if target.id.is_empty() {
            super::search::retry_selected(s, tx);
        } else {
            start(s, target, tx);
        }
    }
}

pub(super) fn seek_message(s: &mut State, message: &str, tx: &mut Tx) {
    start(
        s,
        Marker {
            id: String::new(),
            message: message.into(),
            kind: super::MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool: None,
            pending: false,
        },
        tx,
    );
}

#[cfg(test)]
pub(super) fn pending_search(s: &mut State) -> bool {
    owner(s)
        .jump
        .flight
        .as_ref()
        .is_some_and(|(_, marker)| marker.id.is_empty())
}

fn start(s: &mut State, target: Marker, tx: &mut Tx) {
    gesture(s);
    reader::cancel_page(s);
    cancel_jump(s);
    let serial = owner(s).jump.serial;
    let visible = anchors::visible_rows(s);
    if let Some(index) = visible.iter().position(|row| row.id == target.message) {
        match locate(s, visible, index, !s.history_detached, &target) {
            JumpLanding::Visible(message, key, steps) => {
                owner(s).jump.browse = false;
                settle(s, &target, (message, key, steps));
                apply_alignment(s, tx);
            }
            JumpLanding::Filtered => refuse_filtered_with_origin(s, !target.id.is_empty()),
            JumpLanding::Missing => owner(s).jump.retry = Some(target),
        }
        return;
    }
    if s.messages.iter().any(|row| row.id == target.message) {
        refuse_filtered_with_origin(s, !target.id.is_empty());
        return;
    }
    let (cancel, cancelled) = bounded(1);
    let command = Command::Anchor(Jump {
        ticket: serial,
        message: target.message.clone(),
        cancelled: cancelled.clone(),
    });
    let Some(commands) = s.commands.clone().filter(|_| owner(s).online) else {
        owner(s).jump.retry = Some(target);
        return;
    };
    match commands.try_send(command) {
        Ok(()) => {}
        Err(error) if error.is_full() => {
            let command = error.into_inner();
            // A newer click owns the next write even while a superseded one drains.
            crate::platform::spawn(async move {
                crate::platform::reads::cancellable(&cancelled, commands.send(command)).await;
            });
        }
        Err(_) => {
            owner(s).jump.retry = Some(target);
            return;
        }
    }
    let j = &mut owner(s).jump;
    j.browse = false;
    j.requested_active = (!target.id.is_empty()).then(|| target.id.clone());
    j.flight = Some((cancel, target));
    super::filters::reselect(s);
}

pub(super) fn refuse_filtered(s: &mut State) {
    refuse_filtered_with_origin(s, false);
}

fn refuse_filtered_with_origin(s: &mut State, from_rail: bool) {
    s.transcript_display.search_highlight = None;
    owner(s).jump.filtered_by_rail = from_rail;
    set_filtered(s, true);
}

pub(super) fn set_filtered(s: &mut State, filtered: bool) {
    if !filtered {
        owner(s).jump.filtered_by_rail = false;
    }
    owner(s).jump.filtered = filtered;
}

enum JumpLanding {
    Visible(String, String, usize),
    Filtered,
    Missing,
}

fn locate(
    s: &State,
    rows: &[crate::history::Row],
    row_index: usize,
    at_tail: bool,
    m: &Marker,
) -> JumpLanding {
    let row = &rows[row_index];
    if !anchors::context_visible(s, &row.role) {
        return JumpLanding::Filtered;
    }
    let infer = if at_tail { rows } else { &[] };
    let steps = anchors::steps(s, &row.id);
    if m.id.is_empty() {
        return match s
            .transcript_display
            .search_highlight
            .as_ref()
            .filter(|hit| hit.message == row.id)
            .map_or_else(
                || Landing::Visible(row.id.clone(), 0),
                |hit| hit.landing(s, infer, row, steps),
            ) {
            Landing::Visible(key, reveal) => JumpLanding::Visible(row.id.clone(), key, reveal),
            Landing::Filtered => JumpLanding::Filtered,
            Landing::Missing => JumpLanding::Missing,
        };
    }
    let Some(block) = anchors::blocks(row, steps, true).into_iter().find(|b| {
        b.marker.kind == m.kind
            && b.marker.ordinal == m.ordinal
            && b.marker.continued == m.continued
    }) else {
        return JumpLanding::Missing;
    };
    if block
        .part
        .is_some_and(|i| !anchors::part_visible(s, infer, row, i))
    {
        return JumpLanding::Filtered;
    }
    let shown = steps.max(block.reveal);
    let (message, key) = match m.kind {
        super::MarkerKind::Reasoning => {
            let Some(key) = anchors::reasoning_key(row, shown, m.ordinal, m.continued) else {
                return JumpLanding::Missing;
            };
            block
                .part
                .and_then(|index| {
                    anchors::collapsed_group_target_at(s, rows, at_tail, row_index, shown, index)
                })
                .unwrap_or_else(|| (row.id.clone(), key))
        }
        super::MarkerKind::Tool => block
            .part
            .and_then(|index| {
                anchors::collapsed_group_target_at(s, rows, at_tail, row_index, shown, index)
            })
            .unwrap_or_else(|| (row.id.clone(), block.key)),
        _ => (row.id.clone(), block.key),
    };
    JumpLanding::Visible(message, key, block.reveal)
}

fn settle(s: &mut State, m: &Marker, (align_message, key, steps): (String, String, usize)) {
    if steps > 0 {
        anchors::reveal_parts(s, &m.message, steps);
    }
    if m.id.is_empty()
        && s.transcript_display
            .search_highlight
            .as_ref()
            .is_some_and(|hit| hit.message == m.message)
    {
        s.transcript_display.mark_search_revealed(&key);
    }
    let t = owner(s);
    t.changed = true;
    t.jump.align = Some((align_message, key));
    t.jump.requested_active = (!m.id.is_empty()).then(|| m.id.clone());
    t.jump.locked = true;
    super::filters::reselect(s);
}

pub(crate) fn admit(s: &mut State, serial: u64, page: Page, admit: Admission) {
    admit_window(s, serial, page, || admit.accept());
}

pub(super) fn admit_window(s: &mut State, serial: u64, page: Page, accept: impl FnOnce() -> bool) {
    let Some(is_search) = owner(s)
        .jump
        .flight
        .as_ref()
        .map(|(_, target)| target.id.is_empty())
    else {
        return;
    };
    let allowed = if is_search {
        super::conversation_shown(s)
            && (super::search::is_open(s) || crate::settings::show_timeline(s))
    } else {
        super::demanded(s)
    };
    if !allowed || owner(s).jump.serial != serial || gesture(s).0 {
        return;
    }
    let Some((_cancel, target)) = owner(s).jump.flight.take() else {
        return;
    };
    let visible = anchors::visible_slice(s, &page.rows);
    let landing = if let Some(index) = visible.iter().position(|row| row.id == target.message) {
        locate(s, visible, index, page.newer.is_none(), &target)
    } else if page.rows.iter().any(|row| row.id == target.message) {
        JumpLanding::Filtered
    } else {
        JumpLanding::Missing
    };
    match landing {
        JumpLanding::Visible(message, key, steps) if accept() => {
            reader::install_anchor(s, page);
            settle(s, &target, (message, key, steps));
        }
        JumpLanding::Filtered => refuse_filtered_with_origin(s, !target.id.is_empty()),
        _ => owner(s).jump.retry = Some(target),
    }
}

pub(crate) fn failed(s: &mut State, serial: u64) {
    let j = &mut owner(s).jump;
    if j.serial == serial
        && let Some((_, target)) = j.flight.take()
    {
        j.retry = Some(target);
    }
}

fn gesture(s: &mut State) -> (bool, bool) {
    let t = owner(s);
    let observed = t.scroll.get();
    let previous = std::mem::replace(&mut t.jump.last, observed);
    let rail_moved = previous.rail != observed.rail;
    let transcript_moved = previous.transcript != observed.transcript;
    let last_rail = observed.wheel_last_rail.unwrap_or(observed.last_hand_rail);
    let mut view_changed = false;
    if transcript_moved {
        let j = &owner(s).jump;
        view_changed = j.filtered || j.retry.is_some();
        cancel_jump(s);
    }
    if rail_moved && (!transcript_moved || last_rail) {
        owner(s).jump.browse = true;
    } else if transcript_moved {
        owner(s).jump.browse = false;
    }
    (transcript_moved, view_changed)
}

pub(super) fn hand_scrolled(s: &mut State, rail: bool) {
    if rail {
        owner(s).jump.browse = true;
    } else {
        cancel_jump(s);
        owner(s).jump.browse = false;
    }
}

pub(crate) fn restore_search(s: &mut State) {
    let Some(hit) = s.transcript_display.search_highlight.as_mut() else {
        return;
    };
    if !std::mem::take(&mut hit.restore_pending) {
        return;
    }
    let hit = hit.clone();
    let landing = {
        let visible = anchors::visible_rows(s);
        let infer = if s.history_detached { &[] } else { visible };
        if let Some(row) = visible.iter().find(|row| row.id == hit.message) {
            hit.landing(s, infer, row, anchors::steps(s, &row.id))
        } else if s.messages.iter().any(|row| row.id == hit.message) {
            Landing::Filtered
        } else {
            Landing::Missing
        }
    };
    match landing {
        Landing::Visible(key, steps) => {
            anchors::reveal_parts(s, &hit.message, steps);
            s.transcript_display.mark_search_revealed(&key);
            owner(s).jump.align = Some((hit.message, key));
        }
        Landing::Filtered => refuse_filtered(s),
        Landing::Missing => {}
    }
}

pub(super) fn apply_alignment(s: &mut State, tx: &mut Tx) -> bool {
    let Some((message, key)) = owner(s).jump.align.take() else {
        return false;
    };
    owner(s).keep_passage_deferred = None;
    tx.instant();
    tx.scroll_key_to(
        if key == message {
            key
        } else {
            format!("{message}/{key}")
        },
        0.0,
    );
    if s.transcript_display
        .search_highlight
        .as_ref()
        .is_some_and(|hit| hit.message == message)
    {
        tx.scroll_center_in_instant(&message, "history-search-match");
    }
    reader::set_timeline_position(s, message);
    true
}

pub(super) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let same_frame_wheel = {
        let t = owner(s);
        let mut scroll = t.scroll.get();
        let same_frame = scroll
            .wheel_pending_commit
            .is_some_and(|clock| clock == tx.clock() && tx.input_waiting());
        if !same_frame {
            scroll.wheel_pending_commit = None;
            scroll.rail_wheel.clear_frame();
            scroll.transcript_wheel_target = None;
            scroll.transcript_wheel_momentum = false;
            t.scroll.set(scroll);
        }
        same_frame
    };
    let (_, moved) = gesture(s);
    let mut halted = false;
    {
        let t = owner(s);
        let mut scroll = t.scroll.get();
        let mut dirty = !same_frame_wheel && scroll.wheel_last_rail.take().is_some();
        if scroll.halt_rail_glide {
            scroll.halt_rail_glide = false;
            scroll.rail_glide = None;
            scroll.rail_glide_interrupted = false;
            scroll.rail_glide_stalled_at = None;
            let at = scroll.at.offset[1];
            scroll.programmatic_rail = Some(at);
            dirty = true;
            rune_theme_codenomad::timeline::scroll_rail_to(at, tx);
            halted = true;
        }
        if dirty {
            t.scroll.set(scroll);
        }
    }
    let aligned = apply_alignment(s, tx);
    let rail_mounted = super::demanded(s) && !s.transcript_display.timeline.markers.is_empty();
    if !rail_mounted {
        return moved || halted || aligned;
    }
    let bounds = s.tool_diff_preferences.history_bounds.get();
    let t = owner(s);
    let active_changed = if t.jump.locked || t.jump.flight.is_some() {
        false
    } else {
        let next = t.reading_line.first(bounds);
        if next != t.jump.requested_active || t.jump.active_version != Some(t.version) {
            t.jump.requested_active = next;
            t.jump.active_version = Some(t.version);
            let marker = t
                .jump
                .requested_active
                .as_deref()
                .and_then(|id| super::filters::visible_id(t, id));
            let changed = t.jump.active != marker;
            t.jump.active = marker;
            changed
        } else {
            false
        }
    };
    moved || halted || aligned || active_changed
}

pub(crate) fn poll_reveal(s: &mut State, tx: &mut Tx, commit_pending: bool) {
    let rail_mounted = super::demanded(s) && !s.transcript_display.timeline.markers.is_empty();
    if !rail_mounted || s.transcript_display.timeline.jump.browse {
        return;
    }
    // Runs at the end of `crate::poll` once every subsystem's `changed` is known: defer reveal
    // whenever any subsystem will cause `crate::poll` to call `tx.instant()` (which snaps
    // `Tx::scroll_to` glides) or when queued native input is waiting.
    let _ = reveal_active(s, tx, commit_pending || tx.input_waiting());
}

fn halt_obsolete_glide(
    t: &mut super::Timeline,
    at: rune_theme_codenomad::timeline::ScrollPosition,
    tx: &mut Tx,
) {
    let mut scroll = t.scroll.get();
    let Some(old_aim) = scroll.rail_glide else {
        return;
    };
    let clamped = old_aim.clamp(0.0, at.max[1].max(0.0));
    if (at.offset[1] - clamped).abs() <= 0.5 {
        scroll.rail_glide = None;
        scroll.rail_glide_interrupted = false;
        scroll.rail_glide_stalled_at = None;
        scroll.halt_rail_glide = false;
        t.scroll.set(scroll);
        return;
    }
    if tx.input_waiting() {
        tx.wake_after(std::time::Duration::ZERO);
        return;
    }
    scroll.rail_glide = None;
    scroll.rail_glide_interrupted = false;
    scroll.rail_glide_stalled_at = None;
    scroll.halt_rail_glide = false;
    scroll.programmatic_rail = Some(at.offset[1]);
    t.scroll.set(scroll);
    rune_theme_codenomad::timeline::scroll_rail_to(at.offset[1], tx);
}

const RAIL_GLIDE_WATCHDOG: std::time::Duration = std::time::Duration::from_millis(50);

pub(super) fn reveal_active(s: &mut State, tx: &mut Tx, input_waiting: bool) -> bool {
    let t = owner(s);
    let at = t.scroll.get().at;
    let index = match t.jump.active.as_deref() {
        None => {
            t.jump.active_index = None;
            halt_obsolete_glide(t, at, tx);
            return false;
        }
        Some(active) => {
            let cached = t
                .jump
                .active_index
                .filter(|&(version, idx)| {
                    version == t.version && t.markers.get(idx).is_some_and(|m| m.id == active)
                })
                .map(|(_, idx)| idx);
            let Some(idx) = cached.or_else(|| t.markers.iter().position(|m| m.id == active)) else {
                t.jump.active_index = None;
                halt_obsolete_glide(t, at, tx);
                return false;
            };
            t.jump.active_index = Some((t.version, idx));
            idx
        }
    };
    let Some(target) = rune_theme_codenomad::timeline::reveal_target(index, at) else {
        halt_obsolete_glide(t, at, tx);
        return false;
    };
    let mut current = t.scroll.get();
    if current
        .rail_glide
        .is_some_and(|aim| (aim - target).abs() <= 0.5)
    {
        if (at.offset[1] - current.rail_glide_last).abs() > 0.01 {
            current.rail_glide_last = at.offset[1];
            current.rail_glide_stalled_at = None;
            t.scroll.set(current);
            tx.wake_after(RAIL_GLIDE_WATCHDOG);
            return false;
        }
        let now = tx.clock();
        if current
            .rail_glide_stalled_at
            .is_none_or(|stalled_at| stalled_at == now)
        {
            current.rail_glide_stalled_at = Some(now);
            t.scroll.set(current);
            tx.wake_after(RAIL_GLIDE_WATCHDOG);
            return false;
        }
    }
    // Defer reveal while queued native input is waiting or a poll commit is pending; glide rather
    // than jumping so concurrent touch pans (`TouchEffect::Pan`) and `WheelOwner::Vertical` bursts
    // preserve `by_hand` and transition cleanly into `browse` instead of being overwritten. Under
    // `reduced_motion`, Rune 1d78d5688 converts glides to instant jumps.
    if input_waiting {
        tx.wake_after(std::time::Duration::ZERO);
        return false;
    }
    rune_theme_codenomad::timeline::glide_rail_to(target, tx);
    let mut scroll = t.scroll.get();
    scroll.programmatic_rail = Some(target);
    scroll.rail_glide = Some(target);
    scroll.rail_glide_last = at.offset[1];
    scroll.rail_glide_stalled_at = None;
    scroll.rail_glide_interrupted = false;
    scroll.halt_rail_glide = false;
    t.scroll.set(scroll);
    tx.wake_after(RAIL_GLIDE_WATCHDOG);
    true
}
