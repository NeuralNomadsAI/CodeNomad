use super::{Marker, owner};
use crate::{
    State,
    chat::{anchors, reader},
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
    pub(super) active: Option<String>,
    locked: bool,
    last: super::view::Scroll,
    browse: bool,
}

impl Navigation {
    pub(super) fn unlock(&mut self) {
        self.locked = false;
    }
}

pub(crate) fn cancel_jump(s: &mut State) {
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
        if let Some(block) = locate(s, row, &target) {
            settle(s, &target, block);
            apply_alignment(s, tx);
        } else {
            owner(s).jump.retry = Some(target);
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
    j.active = Some(target.id.clone());
    j.flight = Some((cancel, target));
}

fn locate(s: &State, row: &crate::history::Row, m: &Marker) -> Option<(String, usize)> {
    if m.id.is_empty() {
        return s
            .transcript_display
            .search_highlight
            .as_ref()
            .filter(|hit| hit.message == row.id)
            .and_then(|hit| hit.block(row, anchors::steps(s, &row.id)))
            .or_else(|| Some((row.id.clone(), 0)));
    }
    let steps = anchors::steps(s, &row.id);
    let block = anchors::blocks(row, steps, true).into_iter().find(|b| {
        b.marker.kind == m.kind
            && b.marker.ordinal == m.ordinal
            && b.marker.continued == m.continued
    })?;
    let shown = steps.max(block.reveal);
    let key = match m.kind {
        super::MarkerKind::Reasoning => anchors::reasoning_key(row, shown, m.ordinal, m.continued)?,
        super::MarkerKind::Tool => block
            .part
            .and_then(|index| anchors::tool_group(s, row, shown, index))
            .unwrap_or(block.key),
        _ => block.key,
    };
    Some((key, block.reveal))
}

fn settle(s: &mut State, m: &Marker, (key, steps): (String, usize)) {
    if steps > 0 {
        anchors::reveal_parts(s, &m.message, steps);
    }
    let t = owner(s);
    t.changed = true;
    t.jump.align = Some((m.message.clone(), key));
    t.jump.active = (!m.id.is_empty()).then(|| m.id.clone());
    t.jump.locked = true;
}

pub(crate) fn admit(s: &mut State, serial: u64, page: Page, admit: Admission) {
    if !(super::demanded(s) || super::search::is_open(s))
        || owner(s).jump.serial != serial
        || gesture(s)
    {
        return;
    }
    let Some((_cancel, target)) = owner(s).jump.flight.take() else {
        return;
    };
    let Some(block) = page
        .rows
        .iter()
        .find(|row| row.id == target.message)
        .and_then(|row| locate(s, row, &target))
    else {
        owner(s).jump.retry = Some(target);
        return;
    };
    if admit.accept() {
        reader::install_anchor(s, page);
        settle(s, &target, block);
    } else {
        owner(s).jump.retry = Some(target);
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
    if let Some((key, steps)) = s
        .messages
        .iter()
        .find(|row| row.id == hit.message)
        .and_then(|row| hit.block(row, anchors::steps(s, &row.id)))
    {
        anchors::reveal_parts(s, &hit.message, steps);
        owner(s).jump.align = Some((hit.message, key));
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
    let marker = t
        .reading_line
        .first(bounds)
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
