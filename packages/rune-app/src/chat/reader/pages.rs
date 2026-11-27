//! Page gestures, admission and installation for the visible conversation.
use super::*;

pub(crate) fn older(s: &mut State) -> bool {
    let edge = s
        .transcript_display
        .timeline
        .page_retry
        .unwrap_or(HistoryEdge::Before);
    request_page(s, edge)
}

pub(crate) fn announce_paging(tx: &mut Tx) {
    rune_theme_codenomad::layout::announce_polite(
        tx,
        crate::strings::t("history.navigation.loading"),
    );
}

pub(crate) fn oldest(s: &mut State, tx: &mut Tx) {
    if s.phase.reconnecting() || s.phase == crate::Phase::Failed || s.stream_offline {
        return;
    }
    if s.can_older {
        cancel_page(s);
        if request_page(s, HistoryEdge::Oldest) {
            announce_paging(tx);
        }
    } else if !s.messages.is_empty() {
        cancel_page(s);
        crate::timeline::cancel_jump(s);
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    }
}

pub(crate) fn request_page(s: &mut State, edge: HistoryEdge) -> bool {
    if s.paging
        || s.stream_offline
        || !matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming) && s.reader.is_some()
        || !match edge {
            HistoryEdge::Before | HistoryEdge::Oldest => s.can_older,
            HistoryEdge::After => s.history_detached && s.reader.is_some(),
        }
    {
        return false;
    }
    crate::timeline::cancel_jump(s);
    let (signal, cancelled) = bounded(1);
    let Some(commands) = s.commands.clone() else {
        return false;
    };
    let command = crate::transport::Command::Page(edge, cancelled.clone());
    let queued = match commands.try_send(command) {
        Ok(()) => true,
        Err(error) if error.is_full() => {
            let command = error.into_inner();
            crate::platform::spawn(async move {
                crate::platform::reads::cancellable(&cancelled, commands.send(command)).await;
            });
            true
        }
        Err(_) => false,
    };
    if queued {
        let timeline = &mut s.transcript_display.timeline;
        timeline.page_retry = None;
        timeline.paging = Some((signal, edge));
        s.paging = true;
        s.history_error = false;
    }
    queued
}

pub(crate) fn cancel_page(s: &mut State) {
    let timeline = &mut s.transcript_display.timeline;
    timeline.page_retry = None;
    if timeline.paging.take().is_some() {
        s.paging = false;
    }
}

pub(crate) fn fail_pending_page(s: &mut State) {
    let timeline = &mut s.transcript_display.timeline;
    if let Some((_ticket, edge)) = timeline.paging.take() {
        s.paging = false;
        s.history_error = true;
        timeline.page_retry = Some(edge);
    }
}

pub(crate) fn admit_page(
    s: &mut State,
    cancelled: &Receiver<()>,
    admit: impl FnOnce() -> bool,
) -> Option<HistoryEdge> {
    if cancelled.is_closed() {
        return None;
    }
    let (_ticket, edge) = s.transcript_display.timeline.paging.take()?;
    s.paging = false;
    let accepted = admit();
    s.history_error = !accepted;
    s.transcript_display.timeline.page_retry = (!accepted).then_some(edge);
    accepted.then_some(edge)
}

pub(crate) fn install_page(s: &mut State, page: crate::history::Page, edge: Option<HistoryEdge>) {
    if !page.rows.is_empty() {
        let bookmark = match edge {
            Some(HistoryEdge::Oldest) => page.rows.first(),
            Some(HistoryEdge::After) => s.messages.last(),
            Some(HistoryEdge::Before) => s.messages.first(),
            None => None,
        }
        .filter(|anchor| page.rows.iter().any(|row| row.id == anchor.id))
        .map(|anchor| Bookmark::Message {
            id: anchor.id.clone(),
            offset: 0.0,
        });
        s.attachments.cancel();
        s.history_detached = page.newer.is_some();
        if let Some(reader) = &mut s.reader {
            reader.clear_sync_undo();
            reader.install(s.history_detached);
            if let Some(bookmark) = bookmark {
                reader.bookmark = bookmark;
                reader.pending_scroll = true;
            }
        }
        s.composer.clear_optimistic(None);
        s.messages = page.rows;
        if s.history_detached {
            s.transcript_display.tool_clock.pause();
        } else {
            s.transcript_display.tool_clock.resume();
        }
        crate::composer::reconcile(s);
    }
    s.can_older = page.older.is_some();
    s.history_error = false;
    s.paging = false;
    cancel_page(s);
    crate::timeline::structure_changed(s);
}

pub(crate) fn install_anchor(s: &mut State, page: crate::history::Page) {
    s.attachments.cancel();
    s.history_detached = page.newer.is_some();
    s.can_older = page.older.is_some();
    cancel_page(s);
    s.paging = false;
    s.history_error = false;
    if let Some(reader) = &mut s.reader {
        reader.clear_sync_undo();
        reader.drain();
        reader.resume_pending = false;
        reader.pending_scroll = false;
        reader.install(s.history_detached);
    }
    s.composer.clear_optimistic(None);
    s.messages = page.rows;
    crate::composer::reconcile(s);
    if s.history_detached {
        s.transcript_display.tool_clock.pause();
    } else {
        s.transcript_display.tool_clock.resume();
    }
}

pub(crate) fn set_timeline_position(s: &mut State, message: String) {
    s.transcript_display.reading_mut().hold(message);
}
