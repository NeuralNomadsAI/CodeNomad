use super::reading::{Bookmark, Reading};
use crate::{
    State,
    transport::{Event, HistoryEdge},
};
use codenomad_client::{
    Receiver, bounded,
    recovery::{
        ReadingLane,
        demand::{self, Demand, Target},
    },
};
use rune::Tx;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
};

struct SyncUndo {
    generation: u64,
    connection: u64,
    page: crate::history::Page,
    version: u64,
    bookmark: Bookmark,
    bookmark_width: f32,
    width_grew_while_deferred: bool,
    resume_manual_seq: Option<u64>,
    gap: bool,
    messages: Vec<crate::history::Row>,
    can_older: bool,
    history_detached: bool,
    trimmed_older: bool,
    trimmed_newer: bool,
    age: u8,
    last_clock: Option<f64>,
}

struct DeferredSync {
    generation: u64,
    connection: u64,
    event: Event,
    stage: u8,
    min_seq: u64,
    last_clock: Option<f64>,
    last_seq: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum ManualProbeWait {
    Idle,
    Armed,
    Waiting {
        clock: f64,
        scroll_seq: u64,
        manual_seq: u64,
    },
    Settled(u64),
}

pub(crate) struct Reader {
    request: Demand,
    events: Receiver<(u64, u64, Event)>,
    connection: Arc<AtomicU64>,
    revoked: Arc<AtomicBool>,
    generation: u64,
    bookmark: Bookmark,
    bookmark_width: f32,
    width_grew_while_deferred: bool,
    resume_manual_seq: Option<u64>,
    reconciled_manual_scroll: bool,
    last_taken: Option<(u64, u64)>,
    deferred_sync: Option<DeferredSync>,
    sync_undo: Option<SyncUndo>,
    awaiting_manual_probe: ManualProbeWait,
    installed: bool,
    hidden: bool,
    resume_pending: bool,
    offline_send: bool,
    pending_scroll: bool,
    gap: bool,
    parked: bool,
    activity: Option<(bool, u64)>,
    settling: bool,
    settled_inbox: Vec<String>,
    settled_confirmations: Vec<String>,
}

impl Reader {
    #[cfg(test)]
    pub(crate) fn fixture_open() -> (Self, ReadingLane) {
        Self::open()
    }

    #[cfg(test)]
    pub(crate) fn bookmark(&self) -> &Bookmark {
        &self.bookmark
    }

    #[cfg(test)]
    pub(crate) fn open() -> (Self, ReadingLane) {
        Self::open_inner()
    }

    #[cfg(not(test))]
    pub(super) fn open() -> (Self, ReadingLane) {
        Self::open_inner()
    }

    fn open_inner() -> (Self, ReadingLane) {
        let (request, demand) = demand::open();
        let (out, events) = bounded(8);
        let connection = Arc::new(AtomicU64::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        (
            Self {
                request,
                events,
                connection: connection.clone(),
                revoked: revoked.clone(),
                generation: 0,
                bookmark: Bookmark::Latest,
                bookmark_width: 0.0,
                width_grew_while_deferred: false,
                resume_manual_seq: None,
                reconciled_manual_scroll: false,
                last_taken: None,
                deferred_sync: None,
                sync_undo: None,
                awaiting_manual_probe: ManualProbeWait::Idle,
                installed: false,
                hidden: false,
                resume_pending: false,
                offline_send: false,
                pending_scroll: false,
                gap: false,
                parked: false,
                activity: None,
                settling: false,
                settled_inbox: Vec::new(),
                settled_confirmations: Vec::new(),
            },
            ReadingLane {
                demand,
                events: out,
                connection,
                on_session_deleted: None,
                revoked,
            },
        )
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn revoke(&self) {
        self.revoked.store(true, SeqCst);
    }

    fn record_settled_inbox(&mut self, event: &Event) {
        match event {
            Event::InboxDelta(codenomad_client::inbox::InboxDelta::Upsert(item)) => {
                self.settled_inbox.push(item.id.clone());
            }
            Event::InboxDelta(codenomad_client::inbox::InboxDelta::Delivery { id, .. })
            | Event::InboxDelta(codenomad_client::inbox::InboxDelta::Removed(id)) => {
                self.settled_inbox.push(id.clone());
            }
            Event::Inbox {
                items,
                authoritative: true,
                ..
            } => {
                for item in items {
                    self.settled_inbox.push(item.id.clone());
                }
            }
            Event::Message(m) => {
                if m.role == "user" {
                    self.settled_confirmations.push(m.id.clone());
                }
            }
            Event::History(messages) => {
                for m in messages {
                    if m.role == "user" {
                        self.settled_confirmations.push(m.id.clone());
                    }
                }
            }
            Event::Sync(page) | Event::ReaderSync { page, .. } => {
                for m in &page.rows {
                    if m.role == "user" {
                        self.settled_confirmations.push(m.id.clone());
                    }
                }
            }
            _ => {}
        }
    }

    fn discard_deferred_sync(&mut self) {
        if let Some(deferred) = self.deferred_sync.take() {
            self.record_settled_inbox(&deferred.event);
        }
    }

    fn drain(&mut self) {
        while let Ok((_, _, event)) = self.events.try_recv() {
            self.record_settled_inbox(&event);
        }
    }

    pub(crate) fn drain_settled_inbox(&mut self) -> Vec<String> {
        if self.hidden {
            self.drain();
        }
        std::mem::take(&mut self.settled_inbox)
    }

    pub(crate) fn drain_settled_confirmations(&mut self) -> Vec<String> {
        if self.hidden {
            self.drain();
        }
        std::mem::take(&mut self.settled_confirmations)
    }

    pub(crate) fn stop_content(&mut self) {
        self.hidden = true;
        self.pending_scroll = false;
        self.last_taken = None;
        self.discard_deferred_sync();
        self.sync_undo = None;
        self.awaiting_manual_probe = ManualProbeWait::Idle;
        self.generation = self.request.publish(None);
        self.drain();
    }

    pub(crate) fn clear_sync_undo(&mut self) {
        self.sync_undo = None;
    }

    pub(crate) fn is_resuming(&self) -> bool {
        !self.hidden && self.resume_pending
    }

    #[cfg(test)]
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn has_gap(&self) -> bool {
        self.gap
    }

    pub(crate) fn can_undo_sync(&self, wants_older: bool, wants_newer: bool) -> bool {
        self.sync_undo.as_ref().is_some_and(|undo| {
            (wants_older && undo.trimmed_older) || (wants_newer && undo.trimmed_newer)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn save_sync_undo(
        &mut self,
        page: crate::history::Page,
        version: u64,
        messages: Vec<crate::history::Row>,
        can_older: bool,
        history_detached: bool,
        trimmed_older: bool,
        trimmed_newer: bool,
        clock: Option<f64>,
    ) {
        let Some((generation, connection)) = self.last_taken else {
            return;
        };
        if generation != self.generation || connection != self.connection.load(SeqCst) {
            return;
        }
        self.sync_undo = Some(SyncUndo {
            generation,
            connection,
            page,
            version,
            bookmark: self.bookmark.clone(),
            bookmark_width: self.bookmark_width,
            width_grew_while_deferred: self.width_grew_while_deferred,
            resume_manual_seq: self.resume_manual_seq,
            gap: self.gap,
            messages,
            can_older,
            history_detached,
            trimmed_older,
            trimmed_newer,
            age: 0,
            last_clock: clock,
        });
    }

    pub(crate) fn take_next(
        &mut self,
        defer_sync: bool,
        reading: &Reading,
        history_bounds: [f32; 4],
        cached_gap: bool,
        clock: Option<f64>,
    ) -> Option<Event> {
        self.last_taken = None;
        if let Some(deferred) = self.deferred_sync.take() {
            if !self.hidden
                && deferred.generation == self.generation
                && deferred.connection == self.connection.load(SeqCst)
            {
                if !defer_sync || !self.resume_pending {
                    self.last_taken = Some((deferred.generation, deferred.connection));
                    return Some(deferred.event);
                }
                let scroll_seq = reading.scroll_seq();
                if clock.is_some()
                    && deferred.last_clock == clock
                    && scroll_seq == deferred.last_seq
                {
                    self.deferred_sync = Some(deferred);
                    return None;
                }
                let seq_ready = scroll_seq >= deferred.min_seq;
                let ready = seq_ready
                    && (reading.top_is_fresh()
                        || reading
                            .live_bookmark_fresh(history_bounds, cached_gap)
                            .is_some());
                if ready || deferred.stage >= 4 {
                    self.last_taken = Some((deferred.generation, deferred.connection));
                    return Some(deferred.event);
                }
                self.deferred_sync = Some(DeferredSync {
                    stage: deferred.stage + 1,
                    last_clock: clock,
                    last_seq: scroll_seq,
                    ..deferred
                });
                return None;
            }
            self.record_settled_inbox(&deferred.event);
        }
        while let Ok((generation, connection, event)) = self.events.try_recv() {
            if !self.hidden
                && generation == self.generation
                && connection == self.connection.load(SeqCst)
            {
                if defer_sync && self.resume_pending && matches!(event, Event::ReaderSync { .. }) {
                    self.deferred_sync = Some(DeferredSync {
                        generation,
                        connection,
                        event,
                        stage: 0,
                        min_seq: 0,
                        last_clock: clock,
                        last_seq: reading.scroll_seq(),
                    });
                    return None;
                }
                self.last_taken = Some((generation, connection));
                return Some(event);
            }
            self.record_settled_inbox(&event);
        }
        None
    }

    pub(crate) fn has_deferred_sync(&self) -> bool {
        self.deferred_sync.is_some()
    }

    pub(crate) fn blocks_send(&self) -> bool {
        self.blocks_send_while(false)
    }

    pub(crate) fn blocks_send_while(&self, stream_offline: bool) -> bool {
        self.hidden
            || self.gap
            || self.parked
            || self.settling
            || (self.resume_pending && (!self.installed || !(stream_offline && self.offline_send)))
    }

    pub(crate) fn has_visible_window(&self) -> bool {
        self.installed && !self.hidden && !self.resume_pending
    }

    pub(crate) fn needs_latest(&self) -> bool {
        self.gap || self.resume_pending
    }

    pub(crate) fn independent_status(&self) -> bool {
        self.hidden || self.gap || self.resume_pending
    }

    pub(crate) fn can_retry(&self) -> bool {
        !self.hidden && self.parked
    }

    pub(super) fn resume_from(
        &mut self,
        previous: &Self,
        reading: &Reading,
        current_width: f32,
        history_bounds: [f32; 4],
    ) {
        let (bookmark, manual_seq) = if previous.defers_scroll() {
            self.bookmark_width = previous.bookmark_width;
            self.width_grew_while_deferred = previous.width_grew_while_deferred
                || (previous.bookmark_width > 0.0
                    && current_width.is_finite()
                    && current_width > previous.bookmark_width + 0.5);
            (previous.bookmark.clone(), previous.resume_manual_seq)
        } else {
            self.bookmark_width = current_width;
            self.width_grew_while_deferred = false;
            (
                previous.bookmark_at(reading, history_bounds),
                Some(reading.manual_scroll_seq()),
            )
        };
        self.resume(bookmark);
        self.resume_manual_seq = manual_seq;
    }

    pub(super) fn resume(&mut self, current: Bookmark) {
        let target = match &current {
            Bookmark::Latest => Target::Latest,
            Bookmark::Message { id, .. } => Target::Around(id.clone()),
        };
        self.hidden = false;
        self.parked = false;
        self.resume_pending = true;
        self.pending_scroll = false;
        self.last_taken = None;
        self.discard_deferred_sync();
        self.sync_undo = None;
        self.awaiting_manual_probe = ManualProbeWait::Idle;
        self.resume_manual_seq = None;
        self.reconciled_manual_scroll = false;
        self.bookmark = current;
        self.drain();
        self.generation = self.request.publish(Some(target));
    }

    fn resume_watching(&mut self, current: Bookmark, reading: &Reading) {
        let manual_seq = reading.manual_scroll_seq();
        self.resume(current);
        self.resume_manual_seq = Some(manual_seq);
    }

    fn user_scrolled_while_resuming(&self, reading: &Reading) -> bool {
        self.resume_manual_seq
            .is_some_and(|seq| reading.manual_scroll_seq() != seq)
    }

    pub(crate) fn install(&mut self, gap: bool) {
        self.installed = true;
        self.gap = gap;
        self.parked = false;
        self.pending_scroll |= self.resume_pending;
        self.resume_pending = false;
        self.offline_send = false;
    }

    pub(crate) fn stream_reconnected(&mut self) {
        self.offline_send = false;
    }

    pub(crate) fn anchor_in_place(&mut self, bookmark: Bookmark) {
        self.bookmark = bookmark;
        self.bookmark_width = 0.0;
        self.width_grew_while_deferred = false;
        self.resume_manual_seq = None;
        self.reconciled_manual_scroll = false;
        self.awaiting_manual_probe = ManualProbeWait::Idle;
        self.pending_scroll = true;
    }

    pub(crate) fn failed(&mut self) {
        self.parked = true;
        self.offline_send = false;
    }

    pub(crate) fn observed_running(&mut self, running: bool, version: u64, was_streaming: bool) {
        self.settling = !running
            && !self.independent_status()
            && (was_streaming || self.settling || self.running() == Some(true));
        self.activity = Some((running, version));
    }

    pub(crate) fn running(&self) -> Option<bool> {
        self.activity.map(|(running, _)| running)
    }

    pub(crate) fn activity_after(&self, version: u64) -> bool {
        self.activity
            .is_some_and(|(_, observed)| observed > version)
    }

    pub(crate) fn sync_activity(&mut self, stale: bool) {
        self.settling = stale && !self.independent_status();
    }

    fn reconnecting(
        &mut self,
        reading: &Reading,
        paging: bool,
        history_bounds: [f32; 4],
        stream_lost: bool,
    ) {
        self.activity = None;
        self.settling = false;
        self.last_taken = None;
        self.discard_deferred_sync();
        self.sync_undo = None;
        if !self.hidden && (self.resume_pending || paging) {
            if self.resume_pending {
                let manual_seq = self.resume_manual_seq;
                self.resume(self.bookmark.clone());
                self.resume_manual_seq = manual_seq;
            } else {
                self.resume_watching(self.bookmark_at(reading, history_bounds), reading);
            }
        }
        if stream_lost {
            self.offline_send = true;
        }
    }

    pub(crate) fn defers_scroll(&self) -> bool {
        self.resume_pending || self.pending_scroll || self.hidden
    }

    pub(crate) fn has_pending_scroll(&self) -> bool {
        self.pending_scroll
    }

    pub(crate) fn awaits_history_width(&self) -> bool {
        self.pending_scroll && self.bookmark_width > 0.0
    }

    pub(super) fn take_manual_probe_wait(
        &mut self,
        clock: f64,
        scroll_seq: u64,
        manual_seq: u64,
        pending_manual_commit: bool,
    ) -> bool {
        match self.awaiting_manual_probe {
            ManualProbeWait::Armed => {
                self.awaiting_manual_probe = ManualProbeWait::Waiting {
                    clock,
                    scroll_seq,
                    manual_seq,
                };
                true
            }
            ManualProbeWait::Idle if pending_manual_commit => {
                self.awaiting_manual_probe = ManualProbeWait::Waiting {
                    clock,
                    scroll_seq,
                    manual_seq,
                };
                true
            }
            ManualProbeWait::Settled(settled_manual)
                if pending_manual_commit && manual_seq != settled_manual =>
            {
                self.awaiting_manual_probe = ManualProbeWait::Waiting {
                    clock,
                    scroll_seq,
                    manual_seq,
                };
                true
            }
            ManualProbeWait::Waiting {
                clock: armed_clock,
                scroll_seq: armed_seq,
                ..
            } if scroll_seq == armed_seq && clock == armed_clock => {
                self.awaiting_manual_probe = ManualProbeWait::Waiting {
                    clock,
                    scroll_seq,
                    manual_seq,
                };
                true
            }
            ManualProbeWait::Waiting {
                manual_seq: armed_manual,
                ..
            } => {
                if pending_manual_commit && manual_seq != armed_manual {
                    self.awaiting_manual_probe = ManualProbeWait::Waiting {
                        clock,
                        scroll_seq,
                        manual_seq,
                    };
                    true
                } else {
                    self.awaiting_manual_probe = if pending_manual_commit {
                        ManualProbeWait::Settled(armed_manual)
                    } else {
                        ManualProbeWait::Idle
                    };
                    false
                }
            }
            ManualProbeWait::Settled(_) if !pending_manual_commit => {
                self.awaiting_manual_probe = ManualProbeWait::Idle;
                false
            }
            ManualProbeWait::Idle | ManualProbeWait::Settled(_) => false,
        }
    }

    pub(crate) fn awaiting_manual_probe(&self) -> bool {
        matches!(
            self.awaiting_manual_probe,
            ManualProbeWait::Armed | ManualProbeWait::Waiting { .. }
        )
    }

    pub(crate) fn bookmark_at(&self, reading: &Reading, history_bounds: [f32; 4]) -> Bookmark {
        if self.defers_scroll() && (self.hidden || !self.user_scrolled_while_resuming(reading)) {
            self.bookmark.clone()
        } else {
            reading.live_bookmark(history_bounds, self.gap)
        }
    }

    pub(crate) fn note_width_growth(&mut self) {
        self.width_grew_while_deferred = true;
    }

    pub(super) fn renderer_ready(
        &mut self,
        reading: &mut Reading,
        messages: &[crate::history::Row],
        revision: &mut u64,
        current_width: f32,
        history_bounds: [f32; 4],
        tx: &mut Tx,
    ) -> bool {
        if std::mem::take(&mut self.pending_scroll) {
            self.awaiting_manual_probe = ManualProbeWait::Idle;
            let had_manual_scroll = std::mem::take(&mut self.reconciled_manual_scroll);
            if self.user_scrolled_while_resuming(reading) {
                if let Some(live) = reading.live_bookmark_fresh(history_bounds, self.gap) {
                    let live_valid = match &live {
                        Bookmark::Latest => !self.gap,
                        Bookmark::Message { id, .. } => messages.iter().any(|row| &row.id == id),
                    };
                    if live_valid {
                        self.bookmark = live;
                        self.bookmark_width = 0.0;
                        self.width_grew_while_deferred = false;
                        self.resume_manual_seq = None;
                        *revision += 1;
                        reading.apply_restored(&self.bookmark, *revision, false);
                        reading.arm_frame_restore_for(&self.bookmark, true);
                        reading.note_programmatic_scroll();
                        Reading::restore(&self.bookmark, tx);
                        return true;
                    }
                }
            }
            let width_grew = std::mem::take(&mut self.width_grew_while_deferred)
                || (self.bookmark_width > 0.0
                    && current_width.is_finite()
                    && current_width > self.bookmark_width + 0.5);
            self.bookmark_width = 0.0;
            self.resume_manual_seq = None;
            *revision += 1;
            reading.apply_restored(&self.bookmark, *revision, width_grew);
            let rescued = reading.rescue_target_if_evicted(messages, history_bounds);
            let restore = rescued.clone().unwrap_or_else(|| self.bookmark.clone());
            if rescued.is_none() {
                reading.arm_frame_restore_for(&restore, had_manual_scroll);
            }
            reading.note_programmatic_scroll();
            Reading::restore(&restore, tx);
            return true;
        }
        false
    }
}

pub(crate) fn renderer_ready(s: &mut State, tx: &mut Tx) -> bool {
    let current_width = s.tool_diff_preferences.history_width();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let Some(reader) = &mut s.reader else {
        return false;
    };
    reader.renderer_ready(
        s.transcript_display.reading_mut(),
        &s.messages,
        &mut s.revision,
        current_width,
        history_bounds,
        tx,
    )
}

pub(crate) fn reconnecting(s: &mut State, stream_lost: bool) {
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let preserve_historical_page =
        s.history_detached && s.transcript_display.timeline.paging.is_some();
    if let Some(reader) = &mut s.reader {
        reader.reconnecting(
            s.transcript_display.reading_mut(),
            s.paging && !preserve_historical_page,
            history_bounds,
            stream_lost,
        );
    }

    pages::fail_pending_page(s);
    s.paging = false;
}

pub(crate) fn invalidate(s: &mut State) {
    s.transcript_display
        .reading_mut()
        .reset_to_latest(s.revision);
    if let Some(reader) = &mut s.reader {
        reader.offline_send = false;
        reader.bookmark = Bookmark::Latest;
        if !reader.hidden {
            reader.resume(Bookmark::Latest);
        }
    }
}

pub(super) fn refresh_after_message_action(s: &mut State) {
    cancel_page(s);
    s.history_error = false;
    if let Some(reader) = &mut s.reader {
        reader.resume(Bookmark::Latest);
        s.paging = false;
    } else if let Some(command) = &s.commands {
        let _ = command.try_send(crate::transport::Command::Latest);
    }
}

pub(crate) fn settle_bookmark(s: &mut State, attempted: &str, confirmed: Option<&str>) {
    s.transcript_display
        .reading_mut()
        .settle(attempted, confirmed);
    let Some(reader) = &mut s.reader else { return };
    let Bookmark::Message { id, offset } = &reader.bookmark else {
        return;
    };
    if id != attempted {
        return;
    }
    let bookmark = confirmed.map_or(Bookmark::Latest, |id| Bookmark::Message {
        id: id.into(),
        offset: *offset,
    });
    if reader.resume_pending && !reader.hidden {
        let manual_seq = reader.resume_manual_seq;
        reader.resume(bookmark);
        reader.resume_manual_seq = manual_seq;
    } else {
        reader.bookmark = bookmark;
    }
}

pub(crate) fn take_manual_probe_wait(s: &mut State, tx: &Tx) -> bool {
    let reading = s.transcript_display.reading();
    let scroll_seq = reading.scroll_seq();
    let manual_seq = reading.manual_scroll_seq();
    let pending_commit = reading.pending_scroll_commit();
    let clock = tx.clock();
    s.reader.as_mut().is_some_and(|reader| {
        let pending_manual =
            reader.pending_scroll && pending_commit && reader.user_scrolled_while_resuming(reading);
        reader.take_manual_probe_wait(clock, scroll_seq, manual_seq, pending_manual)
    })
}

pub(crate) fn expire_sync_undo(s: &mut State, clock: f64) {
    let keep = s.transcript_display.reading().has_pending_restore_probe();
    if let Some(reader) = &mut s.reader
        && let Some(undo) = &mut reader.sync_undo
    {
        if undo.last_clock == Some(clock) {
            return;
        }
        if !keep || undo.age >= 1 {
            reader.sync_undo = None;
        } else {
            undo.age += 1;
            undo.last_clock = Some(clock);
        }
    }
}

pub(crate) fn undo_sync_for_manual_scroll(s: &mut State, min_scroll_seq: u64, tx: &mut Tx) -> bool {
    let Some(undo) = s.reader.as_mut().and_then(|reader| reader.sync_undo.take()) else {
        return false;
    };
    let manual_seq = s.transcript_display.reading().manual_scroll_seq();
    let scroll_seq = s.transcript_display.reading().scroll_seq();
    s.messages = undo.messages;
    s.can_older = undo.can_older;
    s.history_detached = undo.history_detached;
    crate::composer::reconcile(s);
    if let Some(reader) = &mut s.reader {
        reader.bookmark = undo.bookmark;
        reader.bookmark_width = undo.bookmark_width;
        reader.width_grew_while_deferred = undo.width_grew_while_deferred;
        reader.resume_manual_seq = Some(undo.resume_manual_seq.unwrap_or(manual_seq));
        reader.gap = undo.gap;
        reader.resume_pending = true;
        reader.pending_scroll = false;
        reader.reconciled_manual_scroll = false;
        reader.awaiting_manual_probe = ManualProbeWait::Idle;
        reader.deferred_sync = Some(DeferredSync {
            generation: undo.generation,
            connection: undo.connection,
            event: Event::ReaderSync {
                page: undo.page,
                version: undo.version,
            },
            stage: 0,
            min_seq: min_scroll_seq,
            last_clock: Some(tx.clock()),
            last_seq: scroll_seq,
        });
    }
    tx.wake_after(std::time::Duration::ZERO);
    true
}

pub(crate) fn reconcile_bookmark(s: &mut State, page: &crate::history::Page) -> bool {
    let rows = &page.rows;
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let cached_gap = s.history_detached || s.reader.as_ref().is_some_and(|reader| reader.gap);
    let reading = s.transcript_display.reading();
    let user_scrolled = s.reader.as_ref().is_some_and(|reader| {
        reader.resume_pending && reader.user_scrolled_while_resuming(reading)
    });
    if user_scrolled {
        if let Some(reader) = &mut s.reader {
            reader.reconciled_manual_scroll = true;
        }
        let reading = s.transcript_display.reading();
        if let Some(live) = reading.live_bookmark_fresh(history_bounds, cached_gap) {
            let live_valid = match &live {
                Bookmark::Latest => page.newer.is_none(),
                Bookmark::Message { id, .. } => rows.iter().any(|row| &row.id == id),
            };
            if live_valid {
                if let Some(reader) = &mut s.reader {
                    reader.bookmark = live;
                    reader.bookmark_width = 0.0;
                    reader.width_grew_while_deferred = false;
                    reader.resume_manual_seq = Some(reading.manual_scroll_seq());
                    reader.awaiting_manual_probe = ManualProbeWait::Idle;
                }
                return false;
            }
            let outside_window = match &live {
                Bookmark::Latest => page.newer.is_some(),
                Bookmark::Message { id, .. } => {
                    let live_pos = s.messages.iter().position(|row| &row.id == id);
                    let first_pos = rows
                        .first()
                        .and_then(|first| s.messages.iter().position(|row| row.id == first.id));
                    let last_pos = rows
                        .last()
                        .and_then(|last| s.messages.iter().position(|row| row.id == last.id));
                    match (live_pos, first_pos, last_pos) {
                        (Some(l), Some(f), _) if l < f => page.older.is_some(),
                        (Some(l), _, Some(e)) if l > e => page.newer.is_some(),
                        _ => page.older.is_some() || page.newer.is_some(),
                    }
                }
            };
            if outside_window {
                if let Some(reader) = &mut s.reader {
                    reader.bookmark_width = 0.0;
                    reader.width_grew_while_deferred = false;
                    reader.resume_watching(live, reading);
                }
                return true;
            }
            if let Some(reader) = &mut s.reader {
                reader.resume_manual_seq = Some(reading.manual_scroll_seq());
                reader.awaiting_manual_probe = ManualProbeWait::Idle;
            }
        } else if let Some(reader) = &mut s.reader {
            reader.awaiting_manual_probe = ManualProbeWait::Armed;
        }
    }
    if let Some(reader) = &mut s.reader
        && reader.resume_pending
        && let Bookmark::Message { id, .. } = &reader.bookmark
        && !rows.iter().any(|row| &row.id == id)
    {
        if page.newer.is_none()
            && s.transcript_display
                .queue
                .items()
                .iter()
                .any(|item| &item.id == id)
        {
            return false;
        }
        reader.bookmark = Bookmark::Latest;
        if !reader.awaiting_manual_probe() {
            s.transcript_display
                .reading_mut()
                .reset_to_latest(s.revision);
            reader.resume_manual_seq = Some(s.transcript_display.reading().manual_scroll_seq());
        }
    }
    false
}

pub(crate) fn preserve_anchor_on_displacement(
    s: &mut State,
    previous: &[crate::history::Row],
    next: &[crate::history::Row],
) {
    if previous.is_empty()
        || s.reader
            .as_ref()
            .is_none_or(|reader| reader.is_resuming() || reader.has_pending_scroll())
    {
        return;
    }
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let cached_gap = s.history_detached || s.reader.as_ref().is_some_and(|reader| reader.gap);
    let Bookmark::Message { id, offset } = s
        .transcript_display
        .reading()
        .live_bookmark(history_bounds, cached_gap)
    else {
        return;
    };
    let Some(next_pos) = next.iter().position(|row| row.id == id) else {
        return;
    };
    let prev_pos = previous.iter().position(|row| row.id == id);
    let prefix_changed = match prev_pos {
        Some(prev_pos) => {
            prev_pos != next_pos
                || previous[..prev_pos]
                    .iter()
                    .zip(&next[..next_pos])
                    .any(|(a, b)| a.id != b.id)
        }
        None => true,
    };
    let displaced = prefix_changed || !codenomad_client::history::order_consistent(previous, next);
    if displaced && let Some(reader) = &mut s.reader {
        reader.anchor_in_place(Bookmark::Message { id, offset });
    }
}

pub(crate) fn preserve_anchor_on_inbox_change(
    s: &mut State,
    next: &[codenomad_client::inbox::QueuedPrompt],
) {
    if s.history_detached
        || s.reader
            .as_ref()
            .is_none_or(|reader| reader.is_resuming() || reader.has_pending_scroll())
    {
        return;
    }
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let cached_gap = s.reader.as_ref().is_some_and(|reader| reader.gap);
    let Bookmark::Message { id, offset } = s
        .transcript_display
        .reading()
        .live_bookmark(history_bounds, cached_gap)
    else {
        return;
    };
    if next.iter().any(|item| item.id == id)
        && let Some(reader) = &mut s.reader
    {
        reader.anchor_in_place(Bookmark::Message { id, offset });
    }
}

pub(crate) fn reconcile_queued_bookmark(
    s: &mut State,
    items: &[codenomad_client::inbox::QueuedPrompt],
) {
    if let Some(reader) = &mut s.reader
        && !reader.resume_pending
        && reader.pending_scroll
        && let Bookmark::Message { id, .. } = &reader.bookmark
        && !s.messages.iter().any(|row| row.id == *id)
        && !items.iter().any(|item| item.id == *id)
    {
        reader.bookmark = Bookmark::Latest;
        if !reader.awaiting_manual_probe() {
            s.transcript_display
                .reading_mut()
                .reset_to_latest(s.revision);
            reader.resume_manual_seq = Some(s.transcript_display.reading().manual_scroll_seq());
        }
    }
}

pub(crate) fn suspend(s: &mut State) {
    let width = s.tool_diff_preferences.history_width();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    cancel_page(s);
    s.history_error = false;
    crate::timeline::suspend(s);
    crate::settings::transcript_filters::close(s);
    if let Some(reader) = &mut s.reader {
        reader.discard_deferred_sync();
        let reading = s.transcript_display.reading();
        if !reader.defers_scroll()
            || (!reader.hidden && reader.user_scrolled_while_resuming(reading))
        {
            reader.bookmark = reader.bookmark_at(reading, history_bounds);
            reader.bookmark_width = width;
            reader.width_grew_while_deferred = false;
            reader.resume_manual_seq = None;
            reader.awaiting_manual_probe = ManualProbeWait::Idle;
        } else if reader.bookmark_width > 0.0
            && width.is_finite()
            && width > reader.bookmark_width + 0.5
        {
            reader.width_grew_while_deferred = true;
        }
        reading.note_suspend_remount();
        reader.stop_content();
        if reader.running() == Some(false) && s.phase == crate::Phase::Streaming {
            s.phase = crate::Phase::Ready;
        }
        s.paging = false;
    }
    let _ = settle_discarded_inbox(s);
    s.transcript_display.suspend_rendered();
}

pub(crate) fn settle_discarded_inbox(s: &mut State) -> bool {
    let Some((inbox_ids, confirmation_ids)) = s.reader.as_mut().map(|reader| {
        (
            reader.drain_settled_inbox(),
            reader.drain_settled_confirmations(),
        )
    }) else {
        return false;
    };
    let mut changed = false;
    for id in inbox_ids {
        changed |= crate::composer::confirm_unconfirmed_id(s, &id);
        if s.composer.is_optimistic(&id) {
            s.composer.clear_optimistic(Some(&id));
            if let Some(index) = s.messages.iter().position(|row| row.id == id) {
                s.messages.remove(index);
                s.revision += 1;
                changed = true;
            }
        }
    }
    for id in confirmation_ids {
        changed |= crate::composer::confirm_unconfirmed_id(s, &id);
    }
    changed
}

pub(crate) fn resume(s: &mut State, tx: &mut Tx) {
    let reading_visible = !s.screen.is_launcher()
        && !crate::git::has_preview(s)
        && !crate::files::has_preview(s)
        && !crate::workspace::mission_has_reader(s);
    if let Some(reader) = &mut s.reader {
        if reader.hidden {
            reader.resume_watching(reader.bookmark.clone(), s.transcript_display.reading());
            if reading_visible {
                let target = match &reader.bookmark {
                    Bookmark::Message { id, offset }
                        if s.messages.iter().any(|row| row.id == *id)
                            || (!s.history_detached
                                && s.transcript_display
                                    .queue
                                    .items()
                                    .iter()
                                    .any(|item| item.id == *id)) =>
                    {
                        Bookmark::Message {
                            id: id.clone(),
                            offset: *offset,
                        }
                    }
                    _ => Bookmark::Latest,
                };
                s.transcript_display.reading().note_programmatic_scroll();
                Reading::restore(&target, tx);
            }
        }
    } else if reading_visible {
        Reading::restore(&Bookmark::Latest, tx);
    }
}

pub(crate) fn latest(s: &mut State, tx: &mut Tx) {
    s.transcript_display
        .reading_mut()
        .reset_to_latest(s.revision);
    cancel_page(s);
    crate::timeline::cancel_jump(s);
    let covered = crate::files::has_preview(s)
        || crate::git::has_preview(s)
        || crate::workspace::mission_has_reader(s);
    if let Some(reader) = &mut s.reader
        && (reader.needs_latest() || s.history_error)
    {
        reader.resume_watching(Bookmark::Latest, s.transcript_display.reading());
        s.history_error = false;
        s.paging = false;
        tx.instant();
    } else if covered && let Some(reader) = &mut s.reader {
        reader.bookmark = Bookmark::Latest;
        reader.pending_scroll = true;
        reader.bookmark_width = 0.0;
        reader.width_grew_while_deferred = false;
        reader.resume_manual_seq = None;
        reader.discard_deferred_sync();
        reader.sync_undo = None;
        reader.awaiting_manual_probe = ManualProbeWait::Idle;
    } else {
        if let Some(reader) = &mut s.reader {
            reader.bookmark = Bookmark::Latest;
            reader.pending_scroll = false;
            reader.bookmark_width = 0.0;
            reader.width_grew_while_deferred = false;
            reader.resume_manual_seq = None;
            reader.discard_deferred_sync();
            reader.sync_undo = None;
            reader.awaiting_manual_probe = ManualProbeWait::Idle;
        }
        Reading::restore(&Bookmark::Latest, tx);
    }
}

pub(crate) fn retry(s: &mut State, tx: &mut Tx) {
    let width = s.tool_diff_preferences.history_width();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    if let Some(reader) = &mut s.reader
        && reader.can_retry()
    {
        if reader.resume_pending {
            if reader.bookmark_width > 0.0
                && width.is_finite()
                && width > reader.bookmark_width + 0.5
            {
                reader.width_grew_while_deferred = true;
            }
            let manual_seq = reader.resume_manual_seq;
            reader.resume(reader.bookmark.clone());
            reader.resume_manual_seq = manual_seq;
        } else {
            reader.bookmark = s
                .transcript_display
                .reading()
                .live_bookmark(history_bounds, reader.gap);
            reader.bookmark_width = width;
            reader.width_grew_while_deferred = false;
            reader.resume_watching(reader.bookmark.clone(), s.transcript_display.reading());
        }
        cancel_page(s);
        s.history_error = false;
        s.paging = false;
        tx.instant();
    }
}

mod pages;
pub(crate) use pages::install_page;
pub(crate) use pages::{
    admit_page, announce_paging, cancel_page, fail_pending_page, install_anchor, older, oldest,
    request_page, set_timeline_position,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod resume_tests {
    use super::*;
    use crate::{Phase, init};
    use rune::{Env, Runtime};

    #[test]
    fn reconcile_and_latest_reset_reading_so_resize_stays_at_tail() {
        let mut state = init();
        state.phase = Phase::Ready;
        state.messages = (0..24)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("row-{i}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Reader passage {i} with wrapping text for narrow viewports."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let mut rt = Runtime::new(state, crate::view, (390.0, 844.0), Env::new(false, 1.0));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("row-8", -10.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(matches!(
            rt.state.transcript_display.reading_mut().bookmark(false),
            Bookmark::Message { .. }
        ));

        let (mut reader, lane) = Reader::open();
        reader.resume(Bookmark::Message {
            id: "missing-anchor".into(),
            offset: -10.0,
        });
        assert!(reader.defers_scroll());
        let missing_gen = reader.generation;
        rt.poll = Some(crate::poll);
        rt.state.reader = Some(reader);
        let rows = rt.state.messages.clone();
        // Deliver ReaderSync with missing anchor in the same frame as a resize:
        // reconcile_bookmark + install + renderer_ready must fall back to Latest and stay pinned.
        lane.events
            .try_send((
                missing_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: rows.clone(),
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((390.0, 514.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.state.reader.as_ref().unwrap().bookmark, Bookmark::Latest);
        assert_eq!(
            rt.state.transcript_display.reading_mut().bookmark(false),
            Bookmark::Latest
        );
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));

        // Tab resume race: cached history sits at bottom while resuming a saved mid-history bookmark.
        // Delivering ReaderSync in the same frame as a viewport resize must land on row-8, not Latest.
        let (mut reader, lane) = Reader::open();
        reader.resume(Bookmark::Message {
            id: "row-8".into(),
            offset: -10.0,
        });
        let resume_gen = reader.generation;
        rt.state.reader = Some(reader);
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 2,
                },
            ))
            .unwrap();
        rt.set_viewport((390.0, 844.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(false),
            "same-frame ReaderSync + resize must restore saved bookmark instead of jumping to Latest"
        );
        let history_y = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect[1];
        let row8_y = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("row-8"))
            .unwrap()
            .rect[1];
        assert!(
            ((row8_y - history_y) + 10.0).abs() <= 2.0,
            "same-frame ReaderSync + resize must preserve row-8 at -10, got {}",
            row8_y - history_y
        );

        // After invoking Latest, resizing stays pinned to tail.
        rt.state.reader = None;
        rt.update(|_, tx| {
            tx.scroll_key_to("row-8", -10.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(matches!(
            rt.state.transcript_display.reading_mut().bookmark(false),
            Bookmark::Message { .. }
        ));
        rt.update(|s, tx| latest(s, tx));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.transcript_display.reading_mut().bookmark(false),
            Bookmark::Latest
        );
        rt.set_viewport((390.0, 514.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    }

    #[test]
    fn rotation_during_pending_resume_rescues_and_clamps_shortened_paragraph() {
        let mut s = init();
        s.phase = Phase::Ready;
        for i in 0..8 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("lead-{i}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Lead passage {i}"),
                    parts: vec![],
                }
                .into(),
            );
        }
        s.messages.push(
            crate::Message {
                usage: None,
                id: "huge-resume".into(),
                role: "assistant".into(),
                completed: true,
                body:
                    "Very long wrapping paragraph suspended in portrait and resumed in landscape. "
                        .repeat(48),
                parts: vec![],
            }
            .into(),
        );
        for i in 0..40 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("tail-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Trailing passage {i} below huge-resume."),
                    parts: vec![],
                }
                .into(),
            );
        }
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = rune::Runtime::new(s, crate::view, (320.0, 720.0), rune::Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("huge-resume", 0.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let narrow = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-resume"))
            .unwrap()
            .rect;
        assert!(narrow[3] > 900.0, "got {}", narrow[3]);
        let deep = -(narrow[3] - 30.0);
        rt.update(move |_, tx| {
            tx.scroll_key_to("huge-resume", deep);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // Suspend in portrait, resume tab, rotate to landscape and let geometry settle BEFORE ReaderSync arrives.
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        assert!(rt.state.reader.as_ref().unwrap().defers_scroll());
        rt.set_viewport((844.0, 390.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // Now deliver ReaderSync after the rotated geometry has already settled.
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..45 {
            rt.frame(0.02);
        }
        let history = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let wide = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-resume"))
            .expect("rotated resumed huge-resume must be rescued into view")
            .rect;
        assert!(
            wide[1] < history[1] && ((wide[1] + wide[3]) - (history[1] + 24.0)).abs() <= 4.0,
            "resumed huge-resume after rotation while resume_pending must clamp near 24px visible: wide={wide:?}, history={history:?}"
        );
    }

    #[test]
    fn second_suspension_before_reader_sync_preserves_portrait_bookmark_width() {
        let mut s = init();
        s.phase = Phase::Ready;
        for i in 0..8 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("lead2-{i}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Lead passage {i}"),
                    parts: vec![],
                }
                .into(),
            );
        }
        s.messages.push(
            crate::Message {
                usage: None,
                id: "huge-double-suspend".into(),
                role: "assistant".into(),
                completed: true,
                body:
                    "Very long wrapping paragraph suspended twice across portrait and landscape. "
                        .repeat(48),
                parts: vec![],
            }
            .into(),
        );
        for i in 0..40 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("tail2-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Trailing passage {i} below huge-double-suspend."),
                    parts: vec![],
                }
                .into(),
            );
        }
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = rune::Runtime::new(s, crate::view, (320.0, 720.0), rune::Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("huge-double-suspend", 0.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let narrow = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-double-suspend"))
            .unwrap()
            .rect;
        assert!(narrow[3] > 900.0, "got {}", narrow[3]);
        let deep = -(narrow[3] - 30.0);
        rt.update(move |_, tx| {
            tx.scroll_key_to("huge-double-suspend", deep);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // First suspend in portrait, rotate to landscape, resume WITHOUT ReaderSync, then suspend a second time.
        rt.update(|s, _| suspend(s));
        rt.set_viewport((844.0, 390.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            resume(s, tx);
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..45 {
            rt.frame(0.02);
        }
        let history = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let wide = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-double-suspend"))
            .expect("second-suspended huge paragraph must still be rescued into view")
            .rect;
        assert!(
            wide[1] < history[1] && ((wide[1] + wide[3]) - (history[1] + 24.0)).abs() <= 4.0,
            "second suspension before ReaderSync must preserve portrait bookmark_width and clamp near 24px visible: wide={wide:?}, history={history:?}"
        );
    }

    #[test]
    fn same_width_height_grow_tab_resume_keeps_clamped_near_bottom_anchor() {
        let mut s = init();
        s.phase = Phase::Ready;
        for i in 0..36 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("passage-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Same-width tab resume passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into(),
            );
        }
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = rune::Runtime::new(s, crate::view, (390.0, 420.0), rune::Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("passage-28", -6.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        let before = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("passage-28"))
            .unwrap()
            .rect[1]
            - rt.elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect[1];
        assert!((before + 6.0).abs() <= 2.0, "got {before}");

        // Suspend on short viewport, grow HEIGHT ONLY (same width 390), resume and let cached view
        // settle at bottom before ReaderSync arrives.
        rt.update(|s, _| suspend(s));
        rt.set_viewport((390.0, 1100.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        // Shrink height back to 420: passage-28 must restore at -6.0 instead of staying at bottom.
        rt.set_viewport((390.0, 420.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let after = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("passage-28"))
            .expect("passage-28 must restore after same-width height-grow resume and shrink")
            .rect[1]
            - rt.elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect[1];
        assert!(
            (after - before).abs() <= 2.0,
            "same-width height-grow resume + shrink must restore passage-28 at {before}, got {after}"
        );
    }

    #[test]
    fn same_session_rebind_preserves_portrait_bookmark_width_and_rescues_paragraph() {
        let mut s = init();
        s.phase = Phase::Ready;
        for i in 0..8 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("rebind-lead-{i}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Lead passage {i}"),
                    parts: vec![],
                }
                .into(),
            );
        }
        s.messages.push(
            crate::Message {
                usage: None,
                id: "huge-rebind".into(),
                role: "assistant".into(),
                completed: true,
                body:
                    "Very long wrapping paragraph rebound onto a fresh Reader after portrait-to-landscape rotation. "
                        .repeat(48),
                parts: vec![],
            }
            .into(),
        );
        for i in 0..40 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("rebind-tail-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Trailing passage {i} below huge-rebind."),
                    parts: vec![],
                }
                .into(),
            );
        }
        let rows = s.messages.clone();
        let (reader, _lane1) = Reader::open();
        s.reader = Some(reader);
        let mut rt = rune::Runtime::new(s, crate::view, (320.0, 720.0), rune::Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("huge-rebind", 0.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let narrow = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-rebind"))
            .unwrap()
            .rect;
        assert!(narrow[3] > 900.0, "got {}", narrow[3]);
        let deep = -(narrow[3] - 30.0);
        rt.update(move |_, tx| {
            tx.scroll_key_to("huge-rebind", deep);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // Suspend + resume in portrait, rotate to landscape and let geometry settle BEFORE ReaderSync.
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        rt.set_viewport((844.0, 390.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // Recreate transport Reader for the SAME session via resume_from (mirroring transport::launch).
        let (mut next_reader, lane2) = Reader::open();
        rt.update(|s, _| {
            let width = s.tool_diff_preferences.history_width();
            let history_bounds = s.tool_diff_preferences.history_bounds.get();
            if let Some(previous) = &s.reader {
                next_reader.resume_from(
                    previous,
                    s.transcript_display.reading_mut(),
                    width,
                    history_bounds,
                );
            }
            s.reader = Some(next_reader);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        lane2
            .events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..45 {
            rt.frame(0.02);
        }
        let history = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let wide = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-rebind"))
            .expect("rebound Reader must preserve width growth and rescue huge-rebind")
            .rect;
        assert!(
            wide[1] < history[1] && ((wide[1] + wide[3]) - (history[1] + 24.0)).abs() <= 4.0,
            "same-session rebind after rotation must clamp huge-rebind near 24px visible: wide={wide:?}, history={history:?}"
        );
    }

    #[test]
    fn fast_tab_resume_after_rotation_waits_for_history_width_and_rescues_paragraph() {
        let mut s = init();
        s.phase = Phase::Ready;
        for i in 0..8 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("fast-lead-{i}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Lead passage {i}"),
                    parts: vec![],
                }
                .into(),
            );
        }
        s.messages.push(
            crate::Message {
                usage: None,
                id: "huge-fast-resume".into(),
                role: "assistant".into(),
                completed: true,
                body:
                    "Very long wrapping paragraph resumed before history remounts after portrait-to-landscape rotation. "
                        .repeat(48),
                parts: vec![],
            }
            .into(),
        );
        for i in 0..40 {
            s.messages.push(
                crate::Message {
                    usage: None,
                    id: format!("fast-tail-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Trailing passage {i} below huge-fast-resume."),
                    parts: vec![],
                }
                .into(),
            );
        }
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = rune::Runtime::new(s, crate::view, (320.0, 720.0), rune::Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.scroll_key_to("huge-fast-resume", 0.0);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let narrow = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-fast-resume"))
            .unwrap()
            .rect;
        assert!(narrow[3] > 900.0, "got {}", narrow[3]);
        let deep = -(narrow[3] - 30.0);
        rt.update(move |_, tx| {
            tx.scroll_key_to("huge-fast-resume", deep);
            tx.instant();
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }

        // Suspend into a blank/unmounted tab (resetting history_size/history_bounds to 0),
        // rotate to landscape, resume and deliver ReaderSync BEFORE the first remount frame.
        rt.update(|s, tx| {
            suspend(s);
            s.tool_diff_preferences.reset_history_size();
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        rt.set_viewport((844.0, 390.0), 1.0);
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..45 {
            rt.frame(0.02);
        }
        let history = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let wide = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("huge-fast-resume"))
            .expect(
                "fast post-rotation resume must wait for history width and rescue huge-fast-resume",
            )
            .rect;
        assert!(
            wide[1] < history[1] && ((wide[1] + wide[3]) - (history[1] + 24.0)).abs() <= 4.0,
            "fast post-rotation resume must rescue and clamp huge-fast-resume to ~24px visible: wide={wide:?}, history={history:?}"
        );
    }

    #[test]
    fn latest_clears_stale_pending_scroll_after_preview_closes() {
        let mut s = init();
        let (mut reader, _lane) = Reader::open();
        reader.bookmark = Bookmark::Message {
            id: "row-4".into(),
            offset: -10.0,
        };
        reader.pending_scroll = true;
        reader.bookmark_width = 320.0;
        reader.width_grew_while_deferred = true;
        s.reader = Some(reader);
        let mut tx = Tx::default();
        latest(&mut s, &mut tx);
        let reader = s.reader.as_ref().unwrap();
        assert_eq!(reader.bookmark, Bookmark::Latest);
        assert!(!reader.pending_scroll);
        assert!(!reader.awaits_history_width());
        assert!(!renderer_ready(&mut s, &mut tx));
    }

    #[test]
    fn manual_scroll_during_pending_resume_is_not_overwritten_by_reader_sync() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("cached-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Cached transcript passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("cached-20", -8.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        // Suspend at cached-20, then return to tab with cached transcript still visible.
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        // User manually scrolls upward in the cached transcript before ReaderSync arrives.
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        rt.wheel(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 420.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("cached-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let scrolled_top = top_key(&rt).expect("visible passage after manual scroll");
        assert_ne!(
            scrolled_top, "cached-20",
            "manual wheel before ReaderSync must move away from cached-20"
        );

        // Delayed ReaderSync arrives: must keep user's manual scroll instead of jumping back to cached-20.
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let after_sync = top_key(&rt).expect("visible passage after ReaderSync");
        assert_eq!(
            after_sync, scrolled_top,
            "delayed ReaderSync must preserve manual scroll made while resuming: expected {scrolled_top}, got {after_sync}"
        );
    }

    #[test]
    fn reconcile_restores_valid_bookmark_when_cached_scroll_target_missing() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("cached-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Cached transcript passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let all_rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("cached-20", -8.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        rt.wheel(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 420.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("cached-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let scrolled_top = top_key(&rt).expect("visible passage after manual scroll");
        assert_ne!(scrolled_top, "cached-20");

        // Deliver a page that keeps cached-20 (valid server bookmark) but omits scrolled_top.
        let filtered_rows: Vec<_> = all_rows
            .into_iter()
            .filter(|r| r.id != scrolled_top)
            .collect();
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: filtered_rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let after_sync = top_key(&rt).expect("visible passage after ReaderSync");
        assert_eq!(
            after_sync, "cached-20",
            "when cached manual-scroll target is absent from ReaderSync, valid bookmark cached-20 must be restored: got {after_sync}"
        );
    }

    #[test]
    fn reconnect_during_pending_resume_preserves_manual_scroll() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("cached-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Cached transcript passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("cached-20", -8.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        rt.wheel(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 420.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("cached-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let scrolled_top = top_key(&rt).expect("visible passage after manual scroll");
        assert_ne!(scrolled_top, "cached-20");

        // Trigger SSE reconnect before ReaderSync arrives; reconnect generation must still honor scrolled_top.
        rt.update(|s, _| {
            reconnecting(s, true);
        });
        let reconnect_gen = rt.state.reader.as_ref().unwrap().generation;
        lane.events
            .try_send((
                reconnect_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let after_sync = top_key(&rt).expect("visible passage after reconnect ReaderSync");
        assert_eq!(
            after_sync, scrolled_top,
            "SSE reconnect during pending resume must keep manual scroll {scrolled_top}: got {after_sync}"
        );
    }

    #[test]
    fn wheel_when_all_rows_fit_does_not_cancel_pending_resume() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..10)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("fit-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Short passage {i:02}."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (360.0, 260.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("fit-02", 0.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        // Suspend at fit-02, enlarge window so all 10 rows fit without overflow, then resume.
        rt.update(|s, _| {
            suspend(s);
        });
        rt.set_viewport((360.0, 1200.0), 1.0);
        rt.update(|s, tx| {
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        // Wheel over history while all rows fit (max == 0): must not cancel saved fit-02 bookmark.
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        rt.wheel(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, -240.0);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..25 {
            rt.frame(0.02);
        }
        // Shrink viewport back so overflow returns: saved fit-02 bookmark must be restored, not Latest.
        rt.set_viewport((360.0, 260.0), 1.0);
        for _ in 0..35 {
            rt.frame(0.02);
        }
        assert!(
            matches!(
                rt.state.transcript_display.reading().bookmark(false),
                Bookmark::Message { ref id, .. } if id == "fit-02"
            ),
            "non-moving wheel when all rows fit must not cancel saved bookmark fit-02: got {:?}",
            rt.state.transcript_display.reading().bookmark(false)
        );
    }

    #[test]
    fn restore_position_and_second_suspend_preserve_manual_scroll_during_pending_resume() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("cached-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Cached transcript passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("cached-20", -8.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        rt.wheel(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 420.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("cached-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let scrolled_top = top_key(&rt).expect("visible passage after manual scroll");
        assert_ne!(scrolled_top, "cached-20");

        // (a) Closing a Git diff preview while resume is still pending must restore scrolled_top, not cached-20.
        rt.update(|s, tx| {
            crate::chat::reading::restore_position(s, tx);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(scrolled_top.as_str()),
            "closing Git preview during pending resume must restore manual scroll {scrolled_top}"
        );

        // (b) Suspending and reopening the tab before ReaderSync must preserve scrolled_top across ReaderSync.
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let second_gen = rt.state.reader.as_ref().unwrap().generation;
        assert!(
            matches!(
                rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { ref id, .. } if id == &scrolled_top
            ),
            "second suspend after manual scroll must save {scrolled_top}, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );
        lane.events
            .try_send((
                second_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(scrolled_top.as_str()),
            "second resume ReaderSync must restore {scrolled_top}, not stale cached-20"
        );
    }

    #[test]
    fn same_frame_wheel_and_reader_sync_keeps_manual_wheel() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("cached-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Cached transcript passage {i:02} with steady lines."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("cached-20", -8.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        // Queue both wheel_event and ReaderSync for the EXACT same frame().
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 420.0).at(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0),
        );
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let h = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let probe = h[1] + 0.5;
        let landed = rt
            .elements()
            .into_iter()
            .find_map(|e| {
                let k = e.key?;
                (k.starts_with("cached-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
            .expect("visible passage after same-frame wheel + ReaderSync");
        assert_ne!(
            landed, "cached-20",
            "same-frame wheel_event must beat ReaderSync jump back to cached-20: landed={landed}"
        );
    }

    #[test]
    fn unprobed_manual_scroll_before_reader_sync_preserves_present_target() {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = (0..60)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("row-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("Transcript row {i:02} with steady lines for probe timing."),
                    parts: vec![],
                }
                .into()
            })
            .collect();
        let all_messages = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        // Bookmark row-20, suspend and reopen with delayed ReaderSync.
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("row-20", -6.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let resume_gen = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (hx, hy) = (hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0);
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("row-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        // Step 1: scroll down from row-20 past row-36 and settle so reading.top records an
        // out-of-window row far enough below row-20 for an unclamped ReaderSync window.
        let mut settled_high = None;
        for _ in 0..32 {
            rt.wheel(hx, hy, -220.0);
            for _ in 0..15 {
                rt.frame(0.02);
            }
            if let Some(k) = top_key(&rt)
                && let Some(num) = k.strip_prefix("row-").and_then(|s| s.parse::<usize>().ok())
                && (36..=48).contains(&num)
            {
                settled_high = Some((k, num));
                break;
            }
        }
        let (settled_high, settled_high_num) =
            settled_high.expect("first scroll must settle on row-36..=48");
        let sync_window: Vec<_> = all_messages[15..settled_high_num].to_vec();
        assert!(
            !sync_window.iter().any(|r| r.id == settled_high),
            "first scroll must settle outside sync window, got {settled_high}"
        );
        // Step 2: wheel up by more than the history viewport height in a single frame so the
        // visible top row moves well inside sync_window (!= row-20, with more than one viewport
        // of trailing rows before settled_high to avoid bottom clamping across system fonts)
        // while its on_drawn_layout_tx is still queued in frame.queue.
        let wheel_up = (hist[3] + 160.0).max(460.0);
        rt.wheel(hx, hy, wheel_up);
        rt.frame(0.02);
        let target = top_key(&rt).expect("visible row after single upward wheel");
        assert!(
            sync_window.iter().any(|r| r.id == target) && target != "row-20",
            "single upward wheel must reach a row inside sync_window != row-20: got {target}, settled={settled_high}"
        );
        assert_eq!(
            rt.state.transcript_display.reading().bookmark(false),
            Bookmark::Message {
                id: settled_high.clone(),
                offset: match rt.state.transcript_display.reading().bookmark(false) {
                    Bookmark::Message { offset, .. } => offset,
                    Bookmark::Latest => f32::NAN,
                },
            },
            "reading.top must still hold out-of-window {settled_high} before queued probe drains"
        );
        assert!(
            !rt.state.transcript_display.reading().top_is_fresh(),
            "reading.top must be marked stale while queued row probe has not drained"
        );
        // Step 3: deliver ReaderSync immediately before the next frame drains Action::Layout.
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: sync_window,
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let after = top_key(&rt).expect("visible row after ReaderSync");
        assert_eq!(
            after, target,
            "ReaderSync arriving before queued row probe must preserve {target} instead of reverting to row-20: got {after}"
        );
    }

    #[test]
    fn same_frame_reader_sync_preserves_pan_trimmed_wheel_multi_delta_suspend_and_tab_switch() {
        let make_rows = |range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("sync-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!(
                            "Row {i:02} line one.\nRow {i:02} line two.\nRow {i:02} line three."
                        ),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("sync-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let send_sync = |lane: &ReadingLane, gen_id: u64, rows: Vec<crate::history::Row>| {
            lane.events
                .try_send((
                    gen_id,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows,
                            older: None,
                            newer: None,
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
        };

        // (a) Same-frame wheel + trimmed ReaderSync [15..32]: must land on the newly scrolled row
        // (below 20), never clamped to the end of the trimmed page or reverted to sync-20.
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows(0..32);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g1 = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (hx, hy) = (hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, 120.0).at(hx, hy));
        send_sync(&lane, g1, make_rows(15..32));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().blocks_send(),
            "trimmed ReaderSync must complete installation"
        );
        assert_eq!(rt.state.messages.len(), 17);
        assert_eq!(rt.state.messages[0].id, "sync-15");
        assert!(!rt.state.messages.iter().any(|m| m.id == "sync-00"));
        let trimmed_top = top_key(&rt).expect("visible row after trimmed ReaderSync");
        let trimmed_idx: usize = trimmed_top.strip_prefix("sync-").unwrap().parse().unwrap();
        assert!(
            (15..20).contains(&trimmed_idx),
            "same-frame wheel + trimmed ReaderSync [15..32] must land above sync-20, not clamp to bottom: got {trimmed_top}"
        );

        // (b) Two wheel deltas of the same gesture + ReaderSync: both deltas must apply (~160px).
        rt.state.messages = make_rows(0..32);
        rt.state.revision += 1;
        for _ in 0..15 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        let sync20_y = |rt: &Runtime<State>| -> f32 {
            rt.elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("sync-20"))
                .expect("sync-20 mounted")
                .rect[1]
        };
        let before_y = sync20_y(&rt);
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g2 = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let tagged_rows = |prefix: &str,
                           range: std::ops::Range<usize>|
         -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("sync-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!(
                            "{prefix} {i:02} line one.\nRow {i:02} line two.\nRow {i:02} line three."
                        ),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        rt.wheel_event(rune::WheelEvent::new(0.0, 80.0).at(hx, hy));
        rt.wheel_event(rune::WheelEvent::new(0.0, 80.0).at(hx, hy));
        send_sync(&lane, g2, tagged_rows("SyncedB", 0..32));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().blocks_send()
                && rt.state.messages[0].body.starts_with("SyncedB"),
            "ReaderSync must be installed in multi-delta wheel case"
        );
        let after_y = sync20_y(&rt);
        assert!(
            (after_y - before_y - 160.0).abs() <= 4.0,
            "both wheel deltas (80 + 80 = 160 px) must apply with same-frame ReaderSync: before={before_y}, after={after_y}"
        );

        // (c) Same-frame touch pan + ReaderSync: pan must survive ReaderSync.
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g3 = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        rt.touch(7, rune::TouchPhase::Started, hx, hy, 2.0);
        rt.touch(7, rune::TouchPhase::Moved, hx, hy + 140.0, 2.02);
        rt.touch(7, rune::TouchPhase::Ended, hx, hy + 140.0, 2.18);
        send_sync(&lane, g3, tagged_rows("SyncedC", 0..32));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().blocks_send()
                && rt.state.messages[0].body.starts_with("SyncedC"),
            "ReaderSync must be installed in touch pan case"
        );
        let panned_top = top_key(&rt).expect("visible row after same-frame touch pan + ReaderSync");
        let panned_idx: usize = panned_top.strip_prefix("sync-").unwrap().parse().unwrap();
        assert!(
            panned_idx < 20,
            "same-frame touch pan + ReaderSync must move above sync-20: got {panned_top}"
        );

        // (d) 1-frame manual scroll during pending resume followed immediately by suspend()
        // before on_drawn_layout_tx drains must save the newly visible row, not the stale one.
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        rt.wheel(hx, hy, 260.0);
        rt.frame(0.02);
        let live_top = top_key(&rt).expect("visible row after 1 frame of wheel");
        assert_ne!(live_top, "sync-20");
        assert!(!rt.state.transcript_display.reading().top_is_fresh());
        rt.update(|s, _| {
            suspend(s);
        });
        assert!(
            matches!(
                &rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { id, .. } if id == &live_top
            ),
            "immediate suspend after 1-frame scroll must record live row {live_top}, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );

        // (e) Tab A's scroll_key_to followed in the same frame by Tab B's resume() must land Tab B
        // on Tab B's own bookmark, not Tab A's message key.
        rt.update(|s, tx| {
            s.reader.as_mut().unwrap().bookmark = Bookmark::Message {
                id: "sync-20".into(),
                offset: 0.0,
            };
            // Simulate Tab A poll-time Git close scroll queued earlier in the same frame.
            tx.instant();
            tx.scroll_key_to("sync-05", 0.0);
            // Then Tab B activates in the same frame.
            resume(s, tx);
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        assert_eq!(
            top_key(&rt).as_deref(),
            Some("sync-20"),
            "Tab B resume in the same frame must beat an earlier Tab A scroll_key_to"
        );
    }

    #[test]
    fn deferred_reader_sync_checks_connection_and_preserves_consumption_frame_gestures_and_out_of_page_scroll()
     {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("sync-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!(
                            "{prefix} {i:02} line one.\nRow {i:02} line two.\nRow {i:02} line three."
                        ),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let h = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            let probe = h[1] + 0.5;
            rt.elements().into_iter().find_map(|e| {
                let k = e.key?;
                (k.starts_with("sync-")
                    && e.rect[3] > 0.0
                    && e.rect[1] <= probe
                    && e.rect[1] + e.rect[3] > probe)
                    .then_some(k)
            })
        };
        let send_page = |lane: &ReadingLane,
                         gen_id: u64,
                         conn: u64,
                         rows: Vec<crate::history::Row>,
                         older: Option<serde_json::Value>| {
            lane.events
                .try_send((
                    gen_id,
                    conn,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows,
                            older,
                            newer: None,
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
        };

        // 1. A deferred ReaderSync must re-check connection on release and drop if invalidated
        // before ConnectionLost arrives.
        let mut s = init();
        s.phase = Phase::Reconnecting;
        s.messages = make_rows("Cached", 0..32);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g1 = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        send_page(&lane, g1, 0, make_rows("StaleConn", 0..32), None);
        rt.frame(0.02);
        assert!(
            rt.state.reader.as_ref().unwrap().has_deferred_sync(),
            "first poll must defer ReaderSync by one frame"
        );
        // Simulate transport invalidating the connection before ConnectionLost arrives.
        lane.connection.fetch_add(1, SeqCst);
        for _ in 0..15 {
            rt.frame(0.02);
        }
        assert!(
            rt.state.reader.as_ref().unwrap().blocks_send(),
            "deferred ReaderSync from invalidated connection must be rejected"
        );
        assert!(
            rt.state.messages[0].body.starts_with("Cached"),
            "stale deferred page must not overwrite cached rows"
        );

        // 2. Wheel arriving on the consumption frame (after ReaderSync was already deferred on frame 1)
        // must survive trimmed ReaderSync [15..32].
        let conn = lane.connection.load(SeqCst);
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (hx, hy) = (hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0);
        send_page(&lane, g1, conn, make_rows("TrimWheel", 15..32), None);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.wheel_event(rune::WheelEvent::new(0.0, 120.0).at(hx, hy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(!rt.state.reader.as_ref().unwrap().blocks_send());
        assert_eq!(rt.state.messages.len(), 17);
        assert_eq!(rt.state.messages[0].id, "sync-15");
        let after_wheel = top_key(&rt).expect("visible row after consumption-frame wheel");
        let wheel_idx: usize = after_wheel.strip_prefix("sync-").unwrap().parse().unwrap();
        assert!(
            (15..20).contains(&wheel_idx),
            "wheel on deferred consumption frame must beat jump back to sync-20: got {after_wheel}"
        );

        // 3. Zero-inertia touch pan right before the consumption frame (both steady viewport and
        // combined with a viewport shrink) must survive ReaderSync.
        for shrink in [false, true] {
            rt.set_viewport((390.0, 420.0), 1.0);
            rt.state.messages = make_rows("Cached", 0..32);
            rt.state.revision += 1;
            for _ in 0..20 {
                rt.frame(0.02);
            }
            rt.update(|_, tx| {
                tx.instant();
                tx.scroll_key_to("sync-20", 0.0);
            });
            for _ in 0..25 {
                rt.frame(0.02);
            }
            rt.update(|s, tx| {
                suspend(s);
                resume(s, tx);
            });
            let g_touch = rt.state.reader.as_ref().unwrap().generation;
            for _ in 0..10 {
                rt.frame(0.02);
            }
            let h_rect = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let (tx_x, tx_y) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
            send_page(&lane, g_touch, conn, make_rows("TouchSync", 0..32), None);
            rt.frame(0.02);
            assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
            // Hold after Moved > FLING_HOLD (0.2s) so velocity is 0 (no inertia).
            rt.touch(11, rune::TouchPhase::Started, tx_x, tx_y, 5.0);
            rt.touch(11, rune::TouchPhase::Moved, tx_x, tx_y + 140.0, 5.02);
            rt.touch(11, rune::TouchPhase::Ended, tx_x, tx_y + 140.0, 5.35);
            if shrink {
                rt.set_viewport((390.0, 260.0), 1.0);
            }
            for _ in 0..30 {
                rt.frame(0.02);
            }
            assert!(
                !rt.state.reader.as_ref().unwrap().blocks_send()
                    && rt.state.messages[0].body.starts_with("TouchSync"),
                "ReaderSync must install in consumption-frame touch case (shrink={shrink})"
            );
            let after_touch = top_key(&rt).expect("visible row after consumption-frame touch pan");
            let touch_idx: usize = after_touch.strip_prefix("sync-").unwrap().parse().unwrap();
            assert!(
                touch_idx < 20,
                "zero-inertia touch pan on consumption frame (shrink={shrink}) must beat jump back to sync-20: got {after_touch}"
            );
        }

        // 4. Manual scroll above the fetched window [15..32] (e.g. to sync-10) must not revert
        // to sync-20; it must keep sync-10 visible and re-request Target::Around(sync-10).
        rt.set_viewport((390.0, 420.0), 1.0);
        rt.state.messages = make_rows("Cached", 0..32);
        rt.state.revision += 1;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_out = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (ox, oy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        let mut target_above = None;
        for _ in 0..20 {
            rt.wheel(ox, oy, 220.0);
            for _ in 0..12 {
                rt.frame(0.02);
            }
            if let Some(k) = top_key(&rt)
                && let Some(idx) = k
                    .strip_prefix("sync-")
                    .and_then(|n| n.parse::<usize>().ok())
                && idx <= 11
            {
                target_above = Some(k);
                break;
            }
        }
        let target_above = target_above.expect("manual scroll must reach a row <= sync-11");
        send_page(
            &lane,
            g_out,
            conn,
            make_rows("Window15", 15..32),
            Some(serde_json::json!("older-cursor")),
        );
        for _ in 0..25 {
            rt.frame(0.02);
        }
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(target_above.as_str()),
            "out-of-window ReaderSync [15..32] must keep manual destination {target_above} instead of reverting to sync-20"
        );
        let g_retry = rt.state.reader.as_ref().unwrap().generation;
        assert!(
            g_retry > g_out && rt.state.reader.as_ref().unwrap().blocks_send(),
            "reader must bump generation and re-request around {target_above}"
        );
        let current = lane.demand.current();
        assert_eq!(current.generation, g_retry);
        assert_eq!(current.target, Some(Target::Around(target_above.clone())));
        send_page(&lane, g_retry, conn, make_rows("Around10", 0..20), None);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().blocks_send()
                && rt.state.messages.len() == 20
                && rt.state.messages[0].body.starts_with("Around10"),
            "re-requested page around {target_above} must install cleanly"
        );
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(target_above.as_str()),
            "re-requested page must stay anchored on {target_above}"
        );

        // 5. Consumption-frame wheel aiming outside a trimmed deferred ReaderSync [16..26]
        // must roll back the trimmed rows for 1 frame, land on the cached destination (<= sync-14),
        // and re-request Target::Around(dest).
        rt.set_viewport((390.0, 420.0), 1.0);
        rt.state.messages = make_rows("Full40", 0..40);
        rt.state.history_detached = false;
        rt.state.reader.as_mut().unwrap().gap = false;
        rt.state.revision += 1;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_trim = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g_trim,
                conn,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_26", 16..26),
                        older: Some(serde_json::json!("older-trim")),
                        newer: Some(serde_json::json!("newer-trim")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 11,
                },
            ))
            .unwrap();
        rt.frame(0.02);
        assert!(
            rt.state.reader.as_ref().unwrap().has_deferred_sync(),
            "trimmed ReaderSync must defer on first poll"
        );
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Queue two upward wheel_events (processed AFTER poll consumes ReaderSync [16..26])
        // on the consumption frame to reach well above sync-16.
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let trim_dest = top_key(&rt).expect("visible row after consumption-frame wheel");
        let trim_idx: usize = trim_dest.strip_prefix("sync-").unwrap().parse().unwrap();
        assert!(
            trim_idx < 16,
            "consumption-frame wheel past trimmed window [16..26] must reach cached row < sync-16: got {trim_dest}"
        );
        let g_trim_retry = rt.state.reader.as_ref().unwrap().generation;
        assert!(
            g_trim_retry > g_trim && rt.state.reader.as_ref().unwrap().blocks_send(),
            "rolled-back out-of-window wheel must bump generation and re-request around {trim_dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(trim_dest.clone())),
            "reader must request Target::Around({trim_dest})"
        );
        lane.events
            .try_send((
                g_trim_retry,
                conn,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("AroundTrimDest", 0..24),
                        older: None,
                        newer: Some(serde_json::json!("newer-trim-2")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 12,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        // Detached window (newer: Some) keeps gap == true and blocks_send() == true until Latest
        // (composer::actions::can_send).
        assert!(
            !rt.state.reader.as_ref().unwrap().resume_pending
                && rt.state.reader.as_ref().unwrap().gap
                && rt.state.reader.as_ref().unwrap().blocks_send()
                && rt.state.messages[0].body.starts_with("AroundTrimDest"),
            "re-requested detached page around {trim_dest} must install cleanly"
        );
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(trim_dest.as_str()),
            "re-requested page must remain anchored on {trim_dest}"
        );

        // 6a. FromBottom with short cached page (max == 0) + overflowing ReaderSync:
        // a consumption-frame wheel that cannot move the short cached page must NOT cancel
        // Reading::restore(&Bookmark::Latest) or jump to sync-00.
        rt.state.messages = make_rows("Short2", 0..2);
        rt.state.history_detached = false;
        rt.state.reader.as_mut().unwrap().gap = false;
        rt.state.revision += 1;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            latest(s, tx);
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_short = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        send_page(&lane, g_short, conn, make_rows("Overflow32", 0..32), None);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.wheel_event(rune::WheelEvent::new(0.0, 120.0).at(wx, wy));
        rt.wheel_event(rune::WheelEvent::new(0.0, -120.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().blocks_send()
                && rt.state.messages.len() == 32
                && rt.state.messages[0].body.starts_with("Overflow32"),
            "overflowing ReaderSync must install"
        );
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(true),
            "no-op consumption-frame wheel on short cached page must stay at Latest bottom, got top={:?}",
            top_key(&rt)
        );

        // 6b. FromBottom with overflowing cached page [0..20] + longer ReaderSync [0..36]:
        // a queued upward wheel_event on the consumption frame must step 120 px above the NEW
        // bottom rather than jumping to the old page's absolute offset.
        rt.state.messages = make_rows("Base20", 0..20);
        rt.state.history_detached = false;
        rt.state.reader.as_mut().unwrap().gap = false;
        rt.state.revision += 1;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            latest(s, tx);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_grow = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        send_page(&lane, g_grow, conn, make_rows("Grown36", 0..36), None);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.wheel_event(rune::WheelEvent::new(0.0, 120.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(false),
            "6b post-poll upward wheel_event must leave bottom: top={:?}",
            top_key(&rt)
        );
        let grown_top = top_key(&rt).expect("visible row after FromBottom upward wheel");
        let grown_idx: usize = grown_top.strip_prefix("sync-").unwrap().parse().unwrap();
        assert!(
            grown_idx >= 24,
            "FromBottom upward wheel_event on grown page [0..36] must land near the new bottom (not old absolute offset): got {grown_top}"
        );

        // 7. Detached cached window [10..40] (gap == true) scrolled to its bottom during
        // resume_pending + delayed detached ReaderSync [0..26] (newer: Some) must NOT collapse to
        // Bookmark::Latest or jump into [0..26]; it must preserve the bottom row and request
        // Target::Around(bottom_top).
        rt.state.messages = make_rows("Detached10_40", 10..40);
        rt.state.history_detached = true;
        rt.state.reader.as_mut().unwrap().gap = true;
        rt.state.revision += 1;
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("sync-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_det = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        for _ in 0..20 {
            rt.wheel(wx, wy, -280.0);
            for _ in 0..8 {
                rt.frame(0.02);
            }
            if rt.scroll_at_bottom("history") == Some(true) {
                break;
            }
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
        let det_bottom_top = top_key(&rt).expect("top row at bottom of detached cached window");
        let det_idx: usize = det_bottom_top
            .strip_prefix("sync-")
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            det_idx >= 28,
            "detached window bottom top row must be >= sync-28: got {det_bottom_top}"
        );
        lane.events
            .try_send((
                g_det,
                conn,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("DelayedDetached", 0..26),
                        older: None,
                        newer: Some(serde_json::json!("newer-det")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 13,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(det_bottom_top.as_str()),
            "delayed detached page [0..26] must not hijack bottom of detached cached window {det_bottom_top}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(det_bottom_top.clone())),
            "bottom of detached cached window must request Target::Around({det_bottom_top}), not Latest"
        );

        // 8. Zero-inertia touch pan concurrent with width rotation OR viewport height growth
        // during resume_pending must be detected and survive ReaderSync.
        for (start_size, next_size, label) in [
            ((320.0, 420.0), (844.0, 390.0), "rotation"),
            ((390.0, 260.0), (390.0, 460.0), "height-grow"),
        ] {
            rt.set_viewport(start_size, 1.0);
            rt.state.messages = make_rows("PrePanResize", 0..32);
            rt.state.history_detached = false;
            rt.state.reader.as_mut().unwrap().gap = false;
            rt.state.revision += 1;
            for _ in 0..20 {
                rt.frame(0.02);
            }
            rt.update(|_, tx| {
                tx.instant();
                tx.scroll_key_to("sync-20", 0.0);
            });
            for _ in 0..25 {
                rt.frame(0.02);
            }
            rt.update(|s, tx| {
                suspend(s);
                resume(s, tx);
            });
            let g_pan = rt.state.reader.as_ref().unwrap().generation;
            for _ in 0..10 {
                rt.frame(0.02);
            }
            let hr = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let (px, py) = (hr[0] + hr[2] / 2.0, hr[1] + hr[3] / 2.0);
            rt.touch(21, rune::TouchPhase::Started, px, py, 9.0);
            rt.touch(21, rune::TouchPhase::Moved, px, py + 140.0, 9.02);
            rt.touch(21, rune::TouchPhase::Ended, px, py + 140.0, 9.35);
            rt.set_viewport(next_size, 1.0);
            rt.frame(0.02);
            rt.frame(0.02);
            send_page(&lane, g_pan, conn, make_rows("PostPanResize", 0..32), None);
            for _ in 0..30 {
                rt.frame(0.02);
            }
            assert!(
                !rt.state.reader.as_ref().unwrap().blocks_send()
                    && rt.state.messages[0].body.starts_with("PostPanResize"),
                "ReaderSync must install after concurrent touch pan + {label}"
            );
            let pan_top = top_key(&rt).expect("visible row after concurrent pan + resize");
            let pan_idx: usize = pan_top.strip_prefix("sync-").unwrap().parse().unwrap();
            assert!(
                pan_idx < 20,
                "zero-inertia touch pan concurrent with {label} during resume_pending must not jump back to sync-20: got {pan_top}"
            );
        }
    }

    #[test]
    fn live_text_delta_after_trimmed_reader_sync_clears_sync_undo() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("delta-{i:02}"),
                        role: "assistant".into(),
                        completed: i != 20,
                        body: format!(
                            "{prefix} {i:02} line one.\nRow {i:02} line two.\nRow {i:02} line three."
                        ),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Streaming;
        s.messages = make_rows("Full", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("delta-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Send trimmed ReaderSync [16..26] (which records sync_undo), then a live Text delta
        // on delta-20 in the same consumption frame before the wheel handler runs.
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim", 16..26),
                        older: Some(serde_json::json!("older-delta")),
                        newer: Some(serde_json::json!("newer-delta")),
                        running: true,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        lane.events
            .try_send((
                g,
                0,
                Event::Text(
                    "delta-20".into(),
                    crate::content::TextEvent::Start { ordinal: Some(0) },
                ),
            ))
            .unwrap();
        lane.events
            .try_send((
                g,
                0,
                Event::Text(
                    "delta-20".into(),
                    crate::content::TextEvent::Delta {
                        ordinal: Some(0),
                        text: "STREAMED_TOKEN".into(),
                    },
                ),
            ))
            .unwrap();
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let row20 = rt
            .state
            .messages
            .iter()
            .find(|r| r.id == "delta-20")
            .expect("delta-20 must stay mounted in trimmed window");
        let has_token = row20.parts.iter().any(
            |p| matches!(p, crate::content::Part::Text(t) if t.text.contains("STREAMED_TOKEN")),
        );
        assert!(
            has_token,
            "live Text delta after trimmed ReaderSync must clear sync_undo and never be dropped by wheel rollback: parts={:?}",
            row20.parts
        );
    }

    #[test]
    fn manual_probe_wait_survives_same_frame_follow_up_poll() {
        let (mut reader, _lane) = Reader::open();
        reader.awaiting_manual_probe = ManualProbeWait::Armed;
        assert!(reader.take_manual_probe_wait(1.0, 5, 1, false));
        assert!(
            reader.take_manual_probe_wait(1.0, 5, 1, false),
            "same-frame follow-up poll at identical clock and scroll_seq must keep waiting"
        );
        assert!(
            !reader.take_manual_probe_wait(1.0, 6, 1, false),
            "advancing scroll_seq releases the wait immediately"
        );
        assert!(
            !reader.awaiting_manual_probe(),
            "released wait resets to Idle"
        );
        // Once released to Idle while layout still defers renderer_ready, a new wheel can re-arm.
        assert!(
            reader.take_manual_probe_wait(1.0, 6, 2, true),
            "a subsequent wheel after release must re-arm the wait"
        );
        assert!(!reader.take_manual_probe_wait(1.016, 7, 2, false));

        reader.awaiting_manual_probe = ManualProbeWait::Armed;
        assert!(reader.take_manual_probe_wait(2.0, 10, 3, false));
        assert!(
            !reader.take_manual_probe_wait(2.016, 10, 3, false),
            "next-frame clock releases the wait even when scroll_seq did not change"
        );

        // Post-reconcile wheel while pending_scroll is still deferred starts from Idle.
        reader.awaiting_manual_probe = ManualProbeWait::Idle;
        assert!(
            reader.take_manual_probe_wait(3.0, 12, 4, true),
            "pending manual scroll commit from Idle must defer renderer_ready in the same frame"
        );
        assert!(
            reader.take_manual_probe_wait(3.0, 12, 4, true),
            "repeated same-frame follow-up poll must keep waiting"
        );
        assert!(
            !reader.take_manual_probe_wait(3.016, 12, 4, true),
            "wait must stay bounded to one frame even if on_scroll_offset never arrives"
        );
        assert!(
            !reader.awaiting_manual_probe(),
            "settled wait no longer reports awaiting_manual_probe"
        );
        assert!(
            !reader.take_manual_probe_wait(3.032, 12, 4, true),
            "same manual_seq must not re-arm across subsequent frames"
        );
        // A newer wheel while layout still defers renderer_ready arms a fresh bounded wait.
        assert!(
            reader.take_manual_probe_wait(3.032, 12, 5, true),
            "a new wheel after a settled wait must re-arm for the new manual_seq"
        );
        assert!(!reader.take_manual_probe_wait(3.048, 12, 5, true));

        // Full reconcile_bookmark (including Latest fallback when bookmark vanished from page)
        // keeps resume_manual_seq so a post-reconcile wheel while pending_scroll is deferred
        // still arms take_manual_probe_wait.
        let mut s = crate::init();
        let (mut reader, _lane) = Reader::open();
        reader.resume_watching(
            Bookmark::Message {
                id: "missing-row".into(),
                offset: 0.0,
            },
            s.transcript_display.reading(),
        );
        let page = crate::history::Page {
            rows: vec![],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        };
        s.reader = Some(reader);
        assert!(!reconcile_bookmark(&mut s, &page));
        assert_eq!(s.reader.as_ref().unwrap().bookmark, Bookmark::Latest);
        s.reader.as_mut().unwrap().install(false);
        assert!(s.reader.as_ref().unwrap().has_pending_scroll());
        // Wheel arrives after Latest-fallback reconcile_bookmark before renderer_ready runs.
        s.transcript_display.reading().note_pending_manual_scroll();
        let scroll_seq = s.transcript_display.reading().scroll_seq();
        let manual_seq = s.transcript_display.reading().manual_scroll_seq();
        let pending = s.transcript_display.reading().pending_scroll_commit()
            && s.reader
                .as_ref()
                .unwrap()
                .user_scrolled_while_resuming(s.transcript_display.reading());
        assert!(pending);
        assert!(
            s.reader
                .as_mut()
                .unwrap()
                .take_manual_probe_wait(4.0, scroll_seq, manual_seq, pending)
        );
        assert!(
            !s.reader
                .as_mut()
                .unwrap()
                .take_manual_probe_wait(4.016, scroll_seq, manual_seq, pending)
        );
    }

    #[test]
    fn deferred_sync_and_sync_undo_survive_same_frame_follow_up_poll() {
        let mut s = crate::init();
        let (mut reader, lane) = Reader::open();
        reader.resume(Bookmark::Latest);
        let generation = reader.generation;
        let conn = reader.connection.load(SeqCst);
        let msg = |id: &str| {
            crate::Message {
                usage: None,
                id: id.into(),
                role: "assistant".into(),
                completed: true,
                body: id.into(),
                parts: vec![],
            }
            .into()
        };
        let page = crate::history::Page {
            rows: vec![msg("m-1")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        };
        lane.events
            .try_send((
                generation,
                conn,
                Event::ReaderSync {
                    page: page.clone(),
                    version: 1,
                },
            ))
            .unwrap();
        let reading = s.transcript_display.reading();
        // Initial poll defers ReaderSync on frame clock 1.0.
        assert!(
            reader
                .take_next(true, reading, [0.0; 4], false, Some(1.0))
                .is_none()
        );
        assert!(reader.has_deferred_sync());
        // Same-frame follow-up poll at clock 1.0 with unchanged scroll_seq must NOT consume or age
        // even when `reading` is already fresh.
        assert!(
            reader
                .take_next(true, reading, [0.0; 4], false, Some(1.0))
                .is_none()
        );
        assert_eq!(reader.deferred_sync.as_ref().unwrap().stage, 0);
        // Next frame at clock 1.016 releases the deferred ReaderSync.
        assert!(matches!(
            reader.take_next(true, reading, [0.0; 4], false, Some(1.016)),
            Some(Event::ReaderSync { .. })
        ));
        assert!(!reader.has_deferred_sync());

        // SyncUndo saved on frame clock 1.0 must survive a same-frame follow-up poll at 1.0
        // and only age once per distinct frame clock.
        reader.last_taken = Some((generation, conn));
        reader.save_sync_undo(
            page.clone(),
            1,
            vec![msg("m-0")],
            false,
            false,
            true,
            false,
            Some(1.0),
        );
        s.messages = vec![msg("m-0"), msg("m-1")];
        let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
        rt.frame(0.02);
        let s = &mut rt.state;
        assert!(s.transcript_display.reading().scroll_seq() > 0);
        s.reader = Some(reader);
        s.transcript_display
            .reading_mut()
            .arm_frame_restore_for(&Bookmark::Latest, false);
        assert!(s.transcript_display.reading().has_pending_restore_probe());
        expire_sync_undo(s, 1.0);
        assert_eq!(
            s.reader.as_ref().unwrap().sync_undo.as_ref().unwrap().age,
            0,
            "same-frame follow-up poll must not age or clear SyncUndo"
        );
        expire_sync_undo(s, 1.016);
        assert_eq!(
            s.reader.as_ref().unwrap().sync_undo.as_ref().unwrap().age,
            1,
            "first distinct frame ages SyncUndo from 0 to 1 while probe is pending"
        );
        expire_sync_undo(s, 1.016);
        assert_eq!(
            s.reader.as_ref().unwrap().sync_undo.as_ref().unwrap().age,
            1,
            "follow-up poll on frame 2 must not expire SyncUndo before frame 2 probes run"
        );
        expire_sync_undo(s, 1.032);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_none(),
            "third distinct frame expires SyncUndo"
        );

        // Without a pending restore probe, SyncUndo still survives the same frame clock and clears
        // on the next distinct frame (or immediately when saved without a clock).
        s.transcript_display.reading_mut().reset_to_latest(1);
        assert!(!s.transcript_display.reading().has_pending_restore_probe());
        s.reader.as_mut().unwrap().last_taken = Some((generation, conn));
        s.reader.as_mut().unwrap().save_sync_undo(
            page.clone(),
            2,
            vec![msg("m-0")],
            false,
            false,
            true,
            false,
            Some(2.0),
        );
        expire_sync_undo(s, 2.0);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_some(),
            "same-frame poll keeps SyncUndo even without a pending restore probe"
        );
        expire_sync_undo(s, 2.016);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_none(),
            "next distinct frame clears SyncUndo when no restore probe is pending"
        );
        s.reader.as_mut().unwrap().last_taken = Some((generation, conn));
        s.reader.as_mut().unwrap().save_sync_undo(
            page,
            3,
            vec![msg("m-0")],
            false,
            false,
            true,
            false,
            None,
        );
        expire_sync_undo(s, 3.0);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_none(),
            "SyncUndo saved without a frame clock clears on the first frame without a probe"
        );
    }
}
