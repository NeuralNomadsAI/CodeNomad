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
    align: Option<(String, String)>,
    pub(super) retry: Option<Marker>,
    pub(super) filtered: bool,
    pub(super) requested_active: Option<String>,
    pub(super) active: Option<String>,
    locked: bool,
    last: super::view::Scroll,
    browse: bool,
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
    if let Some(row) = s.messages.iter().find(|row| row.id == target.message) {
        match locate(s, row, &target) {
            Landing::Visible(key, steps) => {
                settle(s, &target, (key, steps));
                apply_alignment(s, tx);
            }
            Landing::Filtered => refuse_filtered(s),
            Landing::Missing => owner(s).jump.retry = Some(target),
        }
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
    j.requested_active = (!target.id.is_empty()).then(|| target.id.clone());
    j.flight = Some((cancel, target));
    super::filters::reselect(s);
}

pub(super) fn refuse_filtered(s: &mut State) {
    s.transcript_display.search_highlight = None;
    set_filtered(s, true);
}

pub(super) fn set_filtered(s: &mut State, filtered: bool) {
    if std::mem::replace(&mut owner(s).jump.filtered, filtered) == filtered {
        return;
    }
    #[cfg(target_arch = "wasm32")]
    crate::platform::web_alert::history_filtered(filtered.then(|| {
        crate::strings::with_locale(crate::settings::locale(s), || {
            crate::strings::t("history.destinationFiltered")
        })
    }));
}

fn locate(s: &State, row: &crate::history::Row, m: &Marker) -> Landing {
    if !anchors::context_visible(s, &row.role) {
        return Landing::Filtered;
    }
    let steps = anchors::steps(s, &row.id);
    if m.id.is_empty() {
        return s
            .transcript_display
            .search_highlight
            .as_ref()
            .filter(|hit| hit.message == row.id)
            .map_or_else(
                || Landing::Visible(row.id.clone(), 0),
                |hit| hit.landing(s, row, steps),
            );
    }
    let Some(block) = anchors::blocks(row, steps, true).into_iter().find(|b| {
        b.marker.kind == m.kind
            && b.marker.ordinal == m.ordinal
            && b.marker.continued == m.continued
    }) else {
        return Landing::Missing;
    };
    if block
        .part
        .is_some_and(|i| !anchors::part_visible(s, row, i))
    {
        return Landing::Filtered;
    }
    let shown = steps.max(block.reveal);
    let key = match m.kind {
        super::MarkerKind::Reasoning => {
            let Some(key) = anchors::reasoning_key(row, shown, m.ordinal, m.continued) else {
                return Landing::Missing;
            };
            key
        }
        super::MarkerKind::Tool => block
            .part
            .and_then(|index| anchors::tool_group(s, row, shown, index))
            .unwrap_or(block.key),
        _ => block.key,
    };
    Landing::Visible(key, block.reveal)
}

fn settle(s: &mut State, m: &Marker, (key, steps): (String, usize)) {
    if steps > 0 {
        anchors::reveal_parts(s, &m.message, steps);
    }
    let t = owner(s);
    t.changed = true;
    t.jump.align = Some((m.message.clone(), key));
    t.jump.requested_active = (!m.id.is_empty()).then(|| m.id.clone());
    t.jump.locked = true;
    super::filters::reselect(s);
}

pub(crate) fn admit(s: &mut State, serial: u64, page: Page, admit: Admission) {
    admit_window(s, serial, page, || admit.accept());
}

pub(super) fn admit_window(s: &mut State, serial: u64, page: Page, accept: impl FnOnce() -> bool) {
    if !(super::demanded(s) || super::search::is_open(s))
        || owner(s).jump.serial != serial
        || gesture(s)
    {
        return;
    }
    let Some((_cancel, target)) = owner(s).jump.flight.take() else {
        return;
    };
    let landing = page
        .rows
        .iter()
        .find(|row| row.id == target.message)
        .map_or(Landing::Missing, |row| locate(s, row, &target));
    match landing {
        Landing::Visible(key, steps) if accept() => {
            reader::install_anchor(s, page);
            settle(s, &target, (key, steps));
        }
        Landing::Filtered => refuse_filtered(s),
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

fn gesture(s: &mut State) -> bool {
    let t = owner(s);
    let observed = t.scroll.get();
    let previous = std::mem::replace(&mut t.jump.last, observed);
    if previous.rail != observed.rail {
        t.jump.browse = true;
    }
    if previous.transcript != observed.transcript {
        cancel_jump(s);
        owner(s).jump.browse = false;
        true
    } else {
        false
    }
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
    match s
        .messages
        .iter()
        .find(|row| row.id == hit.message)
        .map_or(Landing::Missing, |row| {
            hit.landing(s, row, anchors::steps(s, &row.id))
        }) {
        Landing::Visible(key, steps) => {
            anchors::reveal_parts(s, &hit.message, steps);
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
    let moved = gesture(s);
    let aligned = apply_alignment(s, tx);
    if owner(s).jump.locked || owner(s).jump.flight.is_some() {
        return moved || aligned;
    }
    let bounds = s.tool_diff_preferences.history_bounds.get();
    let t = owner(s);
    t.jump.requested_active = t.reading_line.first(bounds);
    let marker = t
        .jump
        .requested_active
        .as_deref()
        .and_then(|id| super::filters::visible_id(t, id));
    if t.jump.active == marker {
        return moved || aligned;
    }
    t.jump.active = marker;
    if !t.jump.browse
        && let Some(active) = &t.jump.active
        && let Some(index) = t.markers.iter().position(|m| &m.id == active)
    {
        rune_theme_codenomad::timeline::reveal_when_outside(index, t.scroll.get().at, tx);
    }
    true
}
