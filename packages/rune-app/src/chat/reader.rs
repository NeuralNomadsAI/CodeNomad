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
    saved_seq: u64,
    saved_offset: f32,
    saved_max: f32,
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

    pub(crate) fn has_sync_undo(&self) -> bool {
        self.sync_undo.is_some()
    }

    pub(crate) fn sync_undo_anchor(&self) -> Option<(u64, f32, f32, Bookmark)> {
        self.sync_undo.as_ref().map(|undo| {
            (
                undo.saved_seq,
                undo.saved_offset,
                undo.saved_max,
                undo.bookmark.clone(),
            )
        })
    }

    pub(crate) fn sync_undo_contains(
        &self,
        id: &str,
        queue_items: &[codenomad_client::inbox::QueuedPrompt],
    ) -> bool {
        self.sync_undo.as_ref().is_some_and(|undo| {
            undo.messages.iter().any(|row| row.id == id)
                || (!undo.history_detached && queue_items.iter().any(|item| item.id == id))
        })
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
        saved_bookmark: Option<Bookmark>,
        saved_scroll: (u64, f32, f32),
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
            bookmark: saved_bookmark.unwrap_or_else(|| self.bookmark.clone()),
            bookmark_width: self.bookmark_width,
            width_grew_while_deferred: self.width_grew_while_deferred,
            resume_manual_seq: self.resume_manual_seq,
            gap: self.gap,
            messages,
            can_older,
            history_detached,
            trimmed_older,
            trimmed_newer,
            saved_seq: saved_scroll.0,
            saved_offset: saved_scroll.1,
            saved_max: saved_scroll.2,
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
                if reading.awaiting_wheel_replay() {
                    self.deferred_sync = Some(DeferredSync {
                        last_clock: clock,
                        last_seq: scroll_seq,
                        ..deferred
                    });
                    return None;
                }
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

    pub(crate) fn defer_sync_until(&mut self, min_seq: u64) {
        if let Some(deferred) = &mut self.deferred_sync {
            deferred.min_seq = deferred.min_seq.max(min_seq);
            deferred.stage = 0;
        }
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

    pub(crate) fn is_hidden(&self) -> bool {
        self.hidden
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
        (messages, live_in_queue): (&[crate::history::Row], bool),
        revision: &mut u64,
        current_width: f32,
        history_bounds: [f32; 4],
        tx: &mut Tx,
    ) -> bool {
        if std::mem::take(&mut self.pending_scroll) {
            self.awaiting_manual_probe = ManualProbeWait::Idle;
            if reading.awaiting_wheel_replay() {
                self.reconciled_manual_scroll = false;
                self.bookmark_width = 0.0;
                self.width_grew_while_deferred = false;
                self.resume_manual_seq = None;
                return false;
            }
            let trimmed_laid_out = self
                .sync_undo
                .as_ref()
                .is_some_and(|undo| undo.saved_seq != reading.scroll_seq());
            let had_manual_scroll = std::mem::take(&mut self.reconciled_manual_scroll);
            if self.user_scrolled_while_resuming(reading) {
                if let Some(live) = reading.live_bookmark_fresh(history_bounds, self.gap) {
                    let live_valid = match &live {
                        Bookmark::Latest => !self.gap,
                        Bookmark::Message { id, .. } => {
                            messages.iter().any(|row| &row.id == id) || live_in_queue
                        }
                    };
                    if live_valid {
                        self.bookmark = live;
                        self.bookmark_width = 0.0;
                        self.width_grew_while_deferred = false;
                        self.resume_manual_seq = None;
                        *revision += 1;
                        reading.apply_restored(&self.bookmark, *revision, false);
                        reading.arm_frame_restore_for(&self.bookmark, true, trimmed_laid_out);
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
                reading.arm_frame_restore_for(&restore, had_manual_scroll, trimmed_laid_out);
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
    let live_in_queue = reader.pending_scroll
        && reader.user_scrolled_while_resuming(s.transcript_display.reading())
        && !reader.gap
        && s.transcript_display
            .reading()
            .live_bookmark_fresh(history_bounds, reader.gap)
            .is_some_and(|live| match live {
                Bookmark::Message { id, .. } => s
                    .transcript_display
                    .queue
                    .items()
                    .iter()
                    .any(|item| item.id == id),
                Bookmark::Latest => false,
            });
    reader.renderer_ready(
        s.transcript_display.reading_mut(),
        (&s.messages, live_in_queue),
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

pub(crate) enum Reconcile {
    Refetch,
    Keep,
    FallbackBookmark(Bookmark),
}

pub(crate) fn expire_sync_undo(s: &mut State, clock: f64) {
    let awaiting_replay = s.transcript_display.reading().awaiting_wheel_replay();
    let keep_probe = s.transcript_display.reading().keeps_sync_undo_alive();
    let keep_gesture = s
        .transcript_display
        .reading()
        .keeps_sync_undo_for_gesture(clock);
    let conversation_visible = crate::timeline::conversation_shown(s);
    if let Some(reader) = &mut s.reader
        && let Some(undo) = &mut reader.sync_undo
    {
        if undo.last_clock == Some(clock) {
            return;
        }
        if conversation_visible && (reader.pending_scroll || keep_gesture || awaiting_replay) {
            undo.last_clock = Some(clock);
            return;
        }
        if !keep_probe || undo.age >= 1 {
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
    s.transcript_display.reading_mut().clear_sync_undo_gesture();
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
        reader.discard_deferred_sync();
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

#[cfg(test)]
pub(crate) fn reconcile_bookmark(s: &mut State, page: &crate::history::Page) -> bool {
    matches!(reconcile_bookmark_for_sync(s, page), Reconcile::Refetch)
}

pub(crate) fn reconcile_bookmark_for_sync(s: &mut State, page: &crate::history::Page) -> Reconcile {
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
                Bookmark::Message { id, .. } => {
                    rows.iter().any(|row| &row.id == id)
                        || (page.newer.is_none()
                            && s.transcript_display
                                .queue
                                .items()
                                .iter()
                                .any(|item| &item.id == id))
                }
            };
            if live_valid {
                if let Some(reader) = &mut s.reader {
                    reader.bookmark = live;
                    reader.bookmark_width = 0.0;
                    reader.width_grew_while_deferred = false;
                    reader.resume_manual_seq = Some(reading.manual_scroll_seq());
                    reader.awaiting_manual_probe = ManualProbeWait::Idle;
                }
                return Reconcile::Keep;
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
                return Reconcile::Refetch;
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
            return Reconcile::Keep;
        }
        let displaced = std::mem::replace(&mut reader.bookmark, Bookmark::Latest);
        if !reader.awaiting_manual_probe() {
            s.transcript_display
                .reading_mut()
                .reset_to_latest(s.revision);
            reader.resume_manual_seq = Some(s.transcript_display.reading().manual_scroll_seq());
        }
        return Reconcile::FallbackBookmark(displaced);
    }
    Reconcile::Keep
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
    s.transcript_display.reading_mut().clear_sync_undo_gesture();
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
            None,
            (0, 0.0, 0.0),
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
            .arm_frame_restore_for(&Bookmark::Latest, false, false);
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
            None,
            (0, 0.0, 0.0),
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
            (0, 0.0, 0.0),
            None,
        );
        expire_sync_undo(s, 3.0);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_none(),
            "SyncUndo saved without a frame clock clears on the first frame without a probe"
        );
    }

    #[test]
    fn rail_threshold_dpr2_growth_without_height_change_unblocks_pending_scroll() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("dpr2-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Base", 0..32);
        let rows = s.messages.clone();
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        // Start just below the 420 px rail threshold at DPR 2 (839 physical px -> 419.5 logical px).
        let mut rt = Runtime::new(s, crate::view, (419.5, 480.0), Env::new(false, 2.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_none(),
            "rail must stay hidden at 419.5 px"
        );
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("dpr2-18", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let hist = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            rt.elements()
                .into_iter()
                .filter_map(|e| {
                    let k = e.key?;
                    k.starts_with("dpr2-").then_some((k, e.rect))
                })
                .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
                .map(|(k, _)| k)
        };
        assert_eq!(top_key(&rt).as_deref(), Some("dpr2-18"));

        // Suspend and resume while growing width 419.5 -> 420.0 px at DPR 2 with NO height change
        // (0.5 pt delta stays at Rune's on_layout MOVED deadband).
        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g = rt.state.reader.as_ref().unwrap().generation;
        rt.set_viewport((420.0, 480.0), 2.0);
        lane.events
            .try_send((
                g,
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
        assert!(
            rt.presented("timeline").is_some(),
            "419.5 -> 420.0 px growth at DPR 2 without height change must mount the timeline rail"
        );
        assert!(
            !rt.state.reader.as_ref().unwrap().has_pending_scroll(),
            "pending_scroll must not stay stuck blocked by rail_layout_pending after 419.5 -> 420.0 px growth"
        );
        assert!(
            !crate::timeline::rail_layout_pending(
                &rt.state,
                rt.state.tool_diff_preferences.history_width()
            ),
            "rail_layout_pending must settle once the rail mounts at 420.0 px"
        );
        assert_eq!(
            top_key(&rt).as_deref(),
            Some("dpr2-18"),
            "resumed bookmark must restore cleanly after 419.5 -> 420.0 px growth"
        );

        // Shrinking back 420.0 -> 419.5 px at DPR 2 with NO height change (and NO suspend)
        // must unmount the rail, and growing back 419.5 -> 420.0 px with NO height change and
        // NO suspend must remount it via the threshold probe.
        rt.set_viewport((419.5, 480.0), 2.0);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_none(),
            "420.0 -> 419.5 px shrink at DPR 2 without height change must unmount the timeline rail"
        );
        rt.set_viewport((420.0, 480.0), 2.0);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_some(),
            "419.5 -> 420.0 px growth at DPR 2 without height change or suspend must remount the timeline rail"
        );
    }

    #[test]
    fn consumption_frame_off_page_wheel_with_mounted_rail_at_844px() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rail844-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full40", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 390.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..25 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_some(),
            "precondition: timeline rail must be mounted at 844 px"
        );
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rail844-20", 0.0);
        });
        for _ in 0..25 {
            rt.frame(0.02);
        }
        let top_key = |rt: &Runtime<State>| -> Option<String> {
            let hist = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))?
                .rect;
            rt.elements()
                .into_iter()
                .filter_map(|e| {
                    let k = e.key?;
                    k.starts_with("rail844-").then_some((k, e.rect))
                })
                .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
                .map(|(k, _)| k)
        };
        assert_eq!(top_key(&rt).as_deref(), Some("rail844-20"));

        rt.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g_trim = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_some(),
            "rail must stay mounted after tab resume at 844 px"
        );
        lane.events
            .try_send((
                g_trim,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_26", 16..26),
                        older: Some(serde_json::json!("older-844")),
                        newer: Some(serde_json::json!("newer-844")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.frame(0.02);
        assert!(
            rt.state.reader.as_ref().unwrap().has_deferred_sync(),
            "trimmed ReaderSync must defer on first poll at 844 px"
        );
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let dest = top_key(&rt).expect("visible row after consumption-frame wheel at 844 px");
        let dest_idx: usize = dest.strip_prefix("rail844-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 16,
            "consumption-frame wheel with mounted rail at 844 px must roll back trimmed [16..26] and reach < rail844-16: got {dest}"
        );
        let g_retry = rt.state.reader.as_ref().unwrap().generation;
        assert!(
            g_retry > g_trim && rt.state.reader.as_ref().unwrap().blocks_send(),
            "off-page wheel at 844 px must bump generation and re-request around {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest.clone())),
            "reader must request Target::Around({dest})"
        );
        lane.events
            .try_send((
                g_retry,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("AroundDest844", 0..24),
                        older: None,
                        newer: Some(serde_json::json!("newer-844-2")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 2,
                },
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(
            !rt.state.reader.as_ref().unwrap().resume_pending
                && rt.state.messages[0].body.starts_with("AroundDest844"),
            "re-requested page around {dest} must install cleanly at 844 px"
        );
        assert_eq!(
            top_key(&rt).as_deref(),
            Some(dest.as_str()),
            "re-requested page must remain anchored on {dest}"
        );
    }

    #[test]
    fn sync_undo_survives_deferred_renderer_ready_until_probe_settles() {
        let msg = |id: &str| -> crate::history::Row {
            crate::Message {
                usage: None,
                id: id.into(),
                role: "assistant".into(),
                completed: true,
                body: format!("Row {id}"),
                parts: vec![],
            }
            .into()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = vec![msg("m-0"), msg("m-1")];
        let (mut reader, _lane) = Reader::open();
        let generation = reader.generation;
        let conn = reader.connection.load(SeqCst);
        let page = crate::history::Page {
            rows: vec![msg("m-1")],
            older: Some(serde_json::json!("older")),
            newer: None,
            running: false,
            user_file_references: false,
        };
        reader.last_taken = Some((generation, conn));
        reader.save_sync_undo(
            page,
            1,
            vec![msg("m-0"), msg("m-1")],
            false,
            false,
            true,
            false,
            None,
            (0, 0.0, 0.0),
            Some(1.0),
        );
        reader.pending_scroll = true;
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 390.0), Env::new(false, 1.0));
        rt.frame(0.02);
        let s = &mut rt.state;
        assert!(!s.transcript_display.reading().has_pending_restore_probe());

        // While renderer_ready is legitimately deferred (pending_scroll == true), distinct frames
        // must keep SyncUndo alive indefinitely (even past 4 frames) until renderer_ready runs.
        for step in 1..=6 {
            let clock = 1.0 + f64::from(step) * 0.016;
            expire_sync_undo(s, clock);
            assert!(
                s.reader.as_ref().unwrap().sync_undo.is_some(),
                "deferred frame {step} while pending_scroll is true must keep SyncUndo"
            );
        }

        // Once renderer_ready consumes pending_scroll and arms frame_restore, SyncUndo ages once
        // across the probe frame and clears on the following frame.
        s.reader.as_mut().unwrap().pending_scroll = false;
        s.transcript_display
            .reading_mut()
            .arm_frame_restore_for(&Bookmark::Latest, false, false);
        expire_sync_undo(s, 1.096);
        assert_eq!(
            s.reader.as_ref().unwrap().sync_undo.as_ref().unwrap().age,
            0,
            "same-frame poll after renderer_ready must not age SyncUndo"
        );
        expire_sync_undo(s, 1.112);
        assert_eq!(
            s.reader.as_ref().unwrap().sync_undo.as_ref().unwrap().age,
            1,
            "probe frame must keep SyncUndo alive at age 1"
        );
        expire_sync_undo(s, 1.128);
        assert!(
            s.reader.as_ref().unwrap().sync_undo.is_none(),
            "frame after probe must clear SyncUndo"
        );

        // Exercise the deferred pending_scroll fallback AFTER the trimmed page has already laid out
        // with zero overflow (cur.max == 0.0) while rail_layout_pending still defers renderer_ready.
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("defer-{i:02}"),
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
        let run_deferred_trimmed_wheel = |deltas: &[f32]| -> (usize, Option<Target>) {
            let mut s2 = init();
            s2.phase = Phase::Ready;
            s2.messages = make_rows("Full40", 0..40);
            let (reader2, lane2) = Reader::open();
            s2.reader = Some(reader2);
            let mut rt2 = Runtime::new(s2, crate::view, (320.0, 420.0), Env::new(false, 1.0));
            rt2.poll = Some(crate::poll);
            for _ in 0..20 {
                rt2.frame(0.02);
            }
            rt2.update(|_, tx| {
                tx.instant();
                tx.scroll_key_to("defer-20", 0.0);
            });
            for _ in 0..20 {
                rt2.frame(0.02);
            }
            rt2.update(|s, tx| {
                suspend(s);
                resume(s, tx);
            });
            let g2 = rt2.state.reader.as_ref().unwrap().generation;
            for _ in 0..10 {
                rt2.frame(0.02);
            }
            let saved_seq = rt2.state.transcript_display.reading().scroll_seq();
            // Resize 320 -> 844 px on the same frame ReaderSync is first deferred so that on the
            // next frame poll installs trimmed [18..22] (4 short rows, zero overflow at 844x390)
            // while wait_rail_layout keeps pending_scroll == true and Rune renders [18..22].
            lane2
                .events
                .try_send((
                    g2,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows: make_rows("Trim20", 20..21),
                            older: Some(serde_json::json!("older-defer")),
                            newer: Some(serde_json::json!("newer-defer")),
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
            rt2.set_viewport((844.0, 390.0), 1.0);
            rt2.frame(0.02);
            assert!(rt2.state.reader.as_ref().unwrap().has_deferred_sync());
            // Next frame consumes ReaderSync, installs [20..21], defers renderer_ready on rail
            // layout, and lays out the trimmed page (cur.seq > saved_seq, cur.max == 0.0).
            rt2.frame(0.02);
            assert!(
                rt2.state.reader.as_ref().unwrap().has_pending_scroll(),
                "rail layout must still defer renderer_ready after trimmed page installs"
            );
            assert!(
                rt2.state.reader.as_ref().unwrap().has_sync_undo(),
                "SyncUndo must remain armed while renderer_ready is deferred"
            );
            let (cur_seq, _cur_off, cur_max) =
                rt2.state.transcript_display.reading().scroll_snapshot();
            assert!(
                cur_seq > saved_seq,
                "trimmed page must have laid out before wheeling (cur_seq={cur_seq}, saved_seq={saved_seq})"
            );
            assert!(
                cur_max <= 0.5,
                "trimmed 1-row page at 844x390 must have no overflow (cur_max={cur_max})"
            );
            let h_rect = rt2
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
            for &dy in deltas {
                rt2.wheel_event(rune::WheelEvent::new(0.0, dy).at(wx, wy));
            }
            for _ in 0..30 {
                rt2.frame(0.02);
            }
            let hist = rt2
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let dest = rt2
                .elements()
                .into_iter()
                .filter_map(|e| {
                    let k = e.key?;
                    k.starts_with("defer-").then_some((k, e.rect))
                })
                .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
                .map(|(k, _)| k)
                .expect("visible row after deferred trimmed-layout wheel");
            let dest_idx: usize = dest.strip_prefix("defer-").unwrap().parse().unwrap();
            (dest_idx, lane2.demand.current().target)
        };

        let (single_idx, single_target) = run_deferred_trimmed_wheel(&[240.0]);
        let (double_idx, double_target) = run_deferred_trimmed_wheel(&[240.0, 240.0]);
        let (top_idx, _) = run_deferred_trimmed_wheel(&[10_000.0]);
        let (rebound_idx, rebound_target) = run_deferred_trimmed_wheel(&[10_000.0, -240.0]);
        // Also verify queuing the rebound delta on the probe-delivery frame (after the first
        // frame restores the cached anchor and queues wheel_restore_probe).
        let (probe_rebound_idx, probe_rebound_target) = {
            let mut s3 = init();
            s3.phase = Phase::Ready;
            s3.messages = make_rows("Full40", 0..40);
            let (reader3, lane3) = Reader::open();
            s3.reader = Some(reader3);
            let mut rt3 = Runtime::new(s3, crate::view, (320.0, 420.0), Env::new(false, 1.0));
            rt3.poll = Some(crate::poll);
            for _ in 0..20 {
                rt3.frame(0.02);
            }
            rt3.update(|_, tx| {
                tx.instant();
                tx.scroll_key_to("defer-20", 0.0);
            });
            for _ in 0..20 {
                rt3.frame(0.02);
            }
            rt3.update(|s, tx| {
                suspend(s);
                resume(s, tx);
            });
            let g3 = rt3.state.reader.as_ref().unwrap().generation;
            for _ in 0..10 {
                rt3.frame(0.02);
            }
            lane3
                .events
                .try_send((
                    g3,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows: make_rows("Trim20", 20..21),
                            older: Some(serde_json::json!("older-defer")),
                            newer: Some(serde_json::json!("newer-defer")),
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
            rt3.set_viewport((844.0, 390.0), 1.0);
            rt3.frame(0.02);
            rt3.frame(0.02);
            let h_rect = rt3
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
            rt3.wheel_event(rune::WheelEvent::new(0.0, 10_000.0).at(wx, wy));
            // Render one frame to restore cached anchor and queue wheel_restore_probe.
            rt3.frame(0.016);
            // Queue rebound delta on the probe-delivery frame.
            rt3.wheel_event(rune::WheelEvent::new(0.0, -240.0).at(wx, wy));
            for _ in 0..30 {
                rt3.frame(0.02);
            }
            let hist = rt3
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let dest = rt3
                .elements()
                .into_iter()
                .filter_map(|e| {
                    let k = e.key?;
                    k.starts_with("defer-").then_some((k, e.rect))
                })
                .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
                .map(|(k, _)| k)
                .expect("visible row after probe-frame rebound");
            let dest_idx: usize = dest.strip_prefix("defer-").unwrap().parse().unwrap();
            (dest_idx, lane3.demand.current().target)
        };
        assert!(
            single_idx < 20 && single_idx > 0,
            "single upward wheel after zero-overflow trimmed layout must roll back in pre-sync bookmark coordinates: got defer-{single_idx:02}"
        );
        assert!(
            double_idx < single_idx && double_idx > 0,
            "two same-frame upward wheels must both accumulate from pre-sync bookmark without jumping to top: single=defer-{single_idx:02}, double=defer-{double_idx:02}"
        );
        assert_eq!(
            top_idx, 0,
            "overshooting upward wheel must clamp to oldest cached row defer-00: got defer-{top_idx:02}"
        );
        assert!(
            rebound_idx > top_idx && rebound_idx < 20,
            "downward reversal after hitting cached top must move back without repaying discarded overshoot: top=defer-{top_idx:02}, rebound=defer-{rebound_idx:02}"
        );
        assert!(
            probe_rebound_idx > top_idx && probe_rebound_idx < 20,
            "downward reversal on the probe-delivery frame must not be overwritten by the queued top jump: top=defer-{top_idx:02}, probe_rebound=defer-{probe_rebound_idx:02}"
        );
        assert_eq!(
            single_target,
            Some(Target::Around(format!("defer-{single_idx:02}"))),
            "single rolled-back wheel must re-request Target::Around(dest)"
        );
        assert_eq!(
            double_target,
            Some(Target::Around(format!("defer-{double_idx:02}"))),
            "accumulated rolled-back wheel must re-request Target::Around(dest)"
        );
        assert_eq!(
            rebound_target,
            Some(Target::Around(format!("defer-{rebound_idx:02}"))),
            "rebound after overshoot must re-request Target::Around(dest)"
        );
        assert_eq!(
            probe_rebound_target,
            Some(Target::Around(format!("defer-{probe_rebound_idx:02}"))),
            "probe-frame rebound must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn deferred_direction_reversal_gesture_still_triggers_rollback() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rev-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full36", 0..36);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rev-20", 0.0);
        });
        for _ in 0..20 {
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
        // Older-side-only trim (newer: None) while rail mount defers renderer_ready.
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_36", 16..36),
                        older: Some(serde_json::json!("older-rev")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Single vertical gesture: non-trimmed downward delta first, then upward reversal past rev-16.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -80.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 640.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Moved),
        );
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
        );
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("rev-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after direction-reversal gesture");
        let dest_idx: usize = dest.strip_prefix("rev-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 16,
            "direction reversal in one vertical gesture must keep ownership and roll back < rev-16: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "direction-reversal rollback must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn widening_mounted_rail_does_not_stall_renderer_ready_or_drop_sync_undo() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("widen-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full40", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (800.0, 390.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_some(),
            "rail must be mounted at 800 px"
        );
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("widen-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_26", 16..26),
                        older: Some(serde_json::json!("older-widen")),
                        newer: Some(serde_json::json!("newer-widen")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        // Widen by > 40 px/frame across 6 consecutive frames while the rail is already mounted;
        // rail_layout_pending must stay false so renderer_ready settles immediately on consumption.
        rt.set_viewport((860.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.set_viewport((920.0, 390.0), 1.0);
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        for step in 0..6 {
            rt.set_viewport((980.0 + step as f32 * 60.0, 390.0), 1.0);
            rt.frame(0.02);
            let hw = rt.state.tool_diff_preferences.history_width();
            assert!(
                !crate::timeline::rail_layout_pending(&rt.state, hw),
                "widening an already-mounted rail must not report rail_layout_pending (step {step}, hw={hw})"
            );
        }
        for _ in 0..24 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("widen-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after widening mounted rail + upward wheel");
        let dest_idx: usize = dest.strip_prefix("widen-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 16,
            "widening mounted rail must keep SyncUndo working and reach < widen-16: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "rollback while widening mounted rail must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn cross_frame_direction_reversal_at_844px_keeps_rollback() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("xrev-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full36", 0..36);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 390.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert!(
            rt.presented("timeline").is_some(),
            "rail must be mounted at 844 px"
        );
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("xrev-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_36", 16..36),
                        older: Some(serde_json::json!("older-xrev")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.frame(0.016);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Send non-trimmed downward Began(-80) on the consumption frame and render it first.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -80.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.frame(0.016);
        assert!(
            rt.state.reader.as_ref().unwrap().has_sync_undo(),
            "SyncUndo must survive across rendered frames of an active phased vertical gesture"
        );
        // A horizontal-only sample (dx=10, dy=0) on its own frame must keep handler ownership.
        rt.wheel_event(
            rune::WheelEvent::new(10.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Moved),
        );
        rt.frame(0.016);
        assert!(
            rt.state.reader.as_ref().unwrap().has_sync_undo(),
            "horizontal-only sample inside claimed vertical gesture must keep SyncUndo armed"
        );
        // Now reverse upward with a nonzero Ended(0, 640) delta in the SAME gesture.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 640.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
        );
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("xrev-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after cross-frame direction reversal");
        let dest_idx: usize = dest.strip_prefix("xrev-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 16,
            "cross-frame reversal in one gesture must still roll back < xrev-16: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "cross-frame reversal rollback must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn missing_resume_anchor_fallback_preserves_presync_bookmark_for_rollback() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("miss-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full40", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("miss-20", 0.0);
        });
        for _ in 0..20 {
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
        let saved_seq = rt.state.transcript_display.reading().scroll_seq();
        // Backend falls back to Latest [30..40] (missing miss-20) while rail layout defers restore.
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Latest30_40", 30..40),
                        older: Some(serde_json::json!("older-miss")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.transcript_display.reading().scroll_seq() > saved_seq);

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, 240.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("miss-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after missing-anchor fallback wheel rollback");
        let dest_idx: usize = dest.strip_prefix("miss-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 20 && dest_idx > 0,
            "missing-anchor fallback rollback must wheel upward from pre-sync miss-20, not tail Latest: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "missing-anchor rollback must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn horizontal_pan_does_not_undo_trimmed_sync_or_steal_gesture() {
        let wide_code = format!("```txt\n{}\n```", "horizontal_scroll_segment_".repeat(12));
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    let body = if i == 20 {
                        wide_code.clone()
                    } else {
                        format!(
                            "{prefix} {i:02} line one.\nRow {i:02} line two.\nRow {i:02} line three."
                        )
                    };
                    crate::Message {
                        usage: None,
                        id: format!("hpan-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body,
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let run_wheel = |dx: f32, dy: f32| -> (usize, usize, Option<Target>, f32, f32) {
            let mut s = init();
            s.phase = Phase::Ready;
            s.messages = make_rows("Full40", 0..40);
            let (reader, lane) = Reader::open();
            s.reader = Some(reader);
            let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
            rt.poll = Some(crate::poll);
            for _ in 0..20 {
                rt.frame(0.02);
            }
            rt.update(|s, tx| {
                // Unwrap the wide code block so it mounts its real horizontal scroller (.scroll_x).
                crate::transcript_state::Display::toggle_code(s, "body-hpan-20", 0);
                tx.instant();
                tx.scroll_key_to("hpan-20", 0.0);
            });
            for _ in 0..20 {
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
            lane.events
                .try_send((
                    g,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows: make_rows("Trim18_22", 18..22),
                            older: Some(serde_json::json!("older-hpan")),
                            newer: Some(serde_json::json!("newer-hpan")),
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
            rt.set_viewport((844.0, 390.0), 1.0);
            rt.frame(0.02);
            assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
            rt.frame(0.02);
            assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
            assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
            assert_eq!(rt.state.messages.len(), 4);

            let find_code_el = |rt: &Runtime<State>| {
                rt.elements()
                    .into_iter()
                    .find(|e| {
                        e.text
                            .as_deref()
                            .is_some_and(|t| t.contains("horizontal_scroll_segment_"))
                            && e.visible[2] > 0.0
                            && e.visible[3] > 0.0
                    })
                    .expect("visible horizontally overflowing code scroller content in hpan-20")
            };
            let code_before = find_code_el(&rt);
            assert!(
                code_before.rect[2] > code_before.visible[2] + 20.0,
                "unwrapped code block must overflow horizontally: rect={:?} visible={:?}",
                code_before.rect,
                code_before.visible
            );
            let (wx, wy) = (
                code_before.visible[0] + code_before.visible[2] / 2.0,
                code_before.visible[1] + code_before.visible[3] / 2.0,
            );
            rt.wheel_event(rune::WheelEvent::new(dx, dy).at(wx, wy));
            for _ in 0..30 {
                rt.frame(0.02);
            }
            let code_after_x = rt
                .elements()
                .into_iter()
                .find(|e| {
                    e.text
                        .as_deref()
                        .is_some_and(|t| t.contains("horizontal_scroll_segment_"))
                })
                .map_or(code_before.rect[0], |e| e.rect[0]);
            let hist = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let dest = rt
                .elements()
                .into_iter()
                .filter_map(|e| {
                    let k = e.key?;
                    k.starts_with("hpan-").then_some((k, e.rect))
                })
                .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
                .map(|(k, _)| k)
                .expect("visible row after wheel");
            let dest_idx: usize = dest.strip_prefix("hpan-").unwrap().parse().unwrap();
            (
                rt.state.messages.len(),
                dest_idx,
                lane.demand.current().target,
                code_before.rect[0],
                code_after_x,
            )
        };

        // Horizontal-dominant pan (dx=-120, dy=5) over the unwrapped code scroller must NOT undo
        // the trimmed sync AND must actually scroll the code block horizontally.
        let (h_len, h_idx, h_target, code_before_x, code_after_x) = run_wheel(-120.0, 5.0);
        assert_eq!(
            h_len, 4,
            "horizontal-dominant pan must not roll back trimmed rows"
        );
        assert!(
            h_idx >= 18,
            "horizontal-dominant pan must stay on trimmed page >= hpan-18: got hpan-{h_idx:02}"
        );
        assert_eq!(
            h_target,
            Some(Target::Around("hpan-20".into())),
            "horizontal-dominant pan must not re-request an older target"
        );
        assert!(
            code_after_x < code_before_x - 20.0,
            "horizontal-dominant pan must actually advance the code block horizontal scroller: before={code_before_x} after={code_after_x}"
        );

        // On the exact same state, a vertical upward wheel (dx=0, dy=360) must still roll back.
        let (v_len, v_idx, v_target, _, _) = run_wheel(0.0, 360.0);
        assert_eq!(
            v_len, 40,
            "vertical upward wheel on the same state must restore cached rows"
        );
        assert!(
            v_idx < 18,
            "vertical upward wheel must roll back < hpan-18: got hpan-{v_idx:02}"
        );
        assert_eq!(
            v_target,
            Some(Target::Around(format!("hpan-{v_idx:02}"))),
            "vertical upward wheel rollback must re-request Target::Around(dest)"
        );

        // Fresh horizontal Began(120, 5) after an unended downward Began (e.g. focus loss before
        // Ended within 1s) must reset the vertical lock and NOT roll back the trimmed sync.
        let mut s2 = init();
        s2.phase = Phase::Ready;
        s2.messages = make_rows("Full40", 0..40);
        let (reader2, lane2) = Reader::open();
        s2.reader = Some(reader2);
        let mut rt2 = Runtime::new(s2, crate::view, (844.0, 390.0), Env::new(false, 1.0));
        rt2.poll = Some(crate::poll);
        for _ in 0..20 {
            rt2.frame(0.02);
        }
        rt2.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("hpan-20", 0.0);
        });
        for _ in 0..20 {
            rt2.frame(0.02);
        }
        rt2.update(|s, tx| {
            suspend(s);
            resume(s, tx);
        });
        let g2 = rt2.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt2.frame(0.02);
        }
        lane2
            .events
            .try_send((
                g2,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim18_40", 18..40),
                        older: Some(serde_json::json!("older-focus")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt2.frame(0.016);
        assert!(rt2.state.reader.as_ref().unwrap().has_deferred_sync());
        let h_rect = rt2
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Arm vertical gesture lock with downward Began(-80) on older-only trim, no Ended.
        rt2.wheel_event(
            rune::WheelEvent::new(0.0, -80.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt2.frame(0.016);
        assert!(rt2.state.reader.as_ref().unwrap().has_sync_undo());
        assert_eq!(rt2.state.messages.len(), 22);
        // Simulate a fresh horizontal gesture beginning within < 1s without prior Ended.
        rt2.wheel_event(
            rune::WheelEvent::new(120.0, 5.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt2.wheel_event(
            rune::WheelEvent::new(0.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
        );
        for _ in 0..20 {
            rt2.frame(0.02);
        }
        assert_eq!(
            rt2.state.messages.len(),
            22,
            "fresh horizontal Began after interrupted vertical gesture must not roll back SyncUndo"
        );
        assert_eq!(
            lane2.demand.current().target,
            Some(Target::Around("hpan-20".into())),
            "fresh horizontal Began must not re-request an older target"
        );
    }

    #[test]
    fn probe_delivery_frame_reversal_cancels_first_delta_while_sync_undo_armed() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("prev-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full36", 0..36);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("prev-20", 0.0);
        });
        for _ in 0..20 {
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
        // Older-only trim around prev-20, laid out on a viewport change so cur.seq != saved_seq.
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_36", 16..36),
                        older: Some(serde_json::json!("older-prev")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert_eq!(rt.state.messages.len(), 20);

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: start a phased downward scroll away from either edge (does not undo older-only trim).
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -80.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.frame(0.016);
        assert!(
            rt.state.reader.as_ref().unwrap().has_sync_undo(),
            "SyncUndo must remain armed while the downward replay probe is in flight"
        );
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe(),
            "first downward delta must mount the replay probe"
        );

        // Frame B (probe-delivery frame): equal-and-opposite upward reversal in the same gesture.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 80.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Moved),
        );
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
        );
        rt.frame(0.016);
        assert_eq!(
            rt.state.messages.len(),
            36,
            "upward reversal on probe-delivery frame must roll back older-only trim before replaying"
        );
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe(),
            "rollback reversal on probe-delivery frame must re-arm replay probe for [-80, +80]"
        );
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let anchor_row = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("prev-20"))
            .expect("prev-20 must remain visible after equal-and-opposite wheel deltas");
        let anchor_rel_y = anchor_row.rect[1] - hist[1];
        assert!(
            anchor_rel_y.abs() <= 1.0,
            "equal-and-opposite -80/+80 deltas across probe delivery must cancel out at prev-20 (y=0), got {anchor_rel_y}"
        );
    }

    #[test]
    fn horizontal_jitter_on_probe_delivery_frame_preserves_rebound_after_rollback() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("jreb-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full40", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("jreb-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim18_22", 18..22),
                        older: Some(serde_json::json!("older-jreb")),
                        newer: Some(serde_json::json!("newer-jreb")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: phased upward overshoot rolls back to cached 40 rows and mounts replay probe.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 10_000.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.frame(0.016);
        assert_eq!(rt.state.messages.len(), 40);
        assert!(!rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe(),
            "rollback must have a pending replay probe for the top jump"
        );

        // Frame B (probe-delivery frame): horizontal-only jitter sample followed by downward
        // rebound in the SAME phased gesture over plain transcript text.
        rt.wheel_event(
            rune::WheelEvent::new(10.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Moved),
        );
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -240.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Moved),
        );
        rt.wheel_event(
            rune::WheelEvent::new(0.0, 0.0)
                .at(wx, wy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
        );
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            final_offset > 100.0,
            "downward rebound after horizontal jitter on probe-delivery frame must not be overwritten by top jump: offset={final_offset}"
        );
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("jreb-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after jitter + rebound");
        let dest_idx: usize = dest.strip_prefix("jreb-").unwrap().parse().unwrap();
        assert!(
            dest_idx > 0 && dest_idx < 18,
            "rebound after horizontal jitter must land below jreb-00 and above trimmed page: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "rebound after horizontal jitter must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn unphased_wheel_reversal_on_probe_delivery_frame_keeps_rollback() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("uprev-{i:02}"),
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
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full36", 0..36);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("uprev-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_36", 16..36),
                        older: Some(serde_json::json!("older-uprev")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: unphased mouse-wheel step downward starts ReplayDeltas while SyncUndo stays armed.
        rt.wheel_event(rune::WheelEvent::new(0.0, -80.0).at(wx, wy));
        rt.frame(0.016);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Frame B (probe-delivery frame): unphased mouse-wheel step upward must still roll back
        // cached rows and compose on top of the first downward step instead of clamping to Trim16_36.
        rt.wheel_event(rune::WheelEvent::new(0.0, 640.0).at(wx, wy));
        rt.frame(0.016);
        assert_eq!(
            rt.state.messages.len(),
            36,
            "unphased upward wheel on probe-delivery frame must still restore cached rows"
        );
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let dest = rt
            .elements()
            .into_iter()
            .filter_map(|e| {
                let k = e.key?;
                k.starts_with("uprev-").then_some((k, e.rect))
            })
            .find(|(_, r)| r[3] > 0.0 && r[1] <= hist[1] + 0.5 && r[1] + r[3] > hist[1] + 0.5)
            .map(|(k, _)| k)
            .expect("visible row after unphased probe-delivery reversal");
        let dest_idx: usize = dest.strip_prefix("uprev-").unwrap().parse().unwrap();
        assert!(
            dest_idx < 16,
            "unphased reversal on probe-delivery frame must reach above trimmed edge uprev-16: got {dest}"
        );
        assert_eq!(
            lane.demand.current().target,
            Some(Target::Around(dest)),
            "unphased probe-delivery rollback must re-request Target::Around(dest)"
        );
    }

    #[test]
    fn resize_on_replay_delivery_frame_keeps_rolled_back_anchor_relative() {
        let long_sentence = "Wrapped transcript content that expands vertically when the viewport narrows significantly. ";
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rrep-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} {}", long_sentence.repeat(4)),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full40", 0..40);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rrep-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim19_22", 19..22),
                        older: Some(serde_json::json!("older-rrep")),
                        newer: Some(serde_json::json!("newer-rrep")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: upward wheel rolls back 40 rows at 844 px and mounts the replay probe.
        rt.wheel_event(rune::WheelEvent::new(0.0, 240.0).at(wx, wy));
        rt.frame(0.016);
        assert_eq!(rt.state.messages.len(), 40);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B delivers the replay probe, narrow the viewport (staying above the 420 px
        // rail threshold so history width changes once) so rows 0..20 rewrap substantially taller;
        // the replay must still land 240 px above rrep-20, not at a stale 844 px absolute offset.
        rt.set_viewport((480.0, 390.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let anchor_row = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rrep-20"))
            .expect(
                "rrep-20 must stay visible ~240 px below history top after replay-frame resize",
            );
        let anchor_rel_y = anchor_row.rect[1] - hist[1];
        assert!(
            (anchor_rel_y - 240.0).abs() <= 2.0,
            "replay-frame resize must anchor 240 px above rrep-20 in the new layout, got rel_y={anchor_rel_y}"
        );
    }

    #[test]
    fn shift_vertical_wheel_respects_rune_axis_turn_rules() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("shft-{i:02}"),
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
        let run_case = |ctrl: bool| -> (usize, Option<Target>, bool, bool) {
            let mut s = init();
            s.phase = Phase::Ready;
            s.messages = make_rows("Full40", 0..40);
            let (reader, lane) = Reader::open();
            s.reader = Some(reader);
            let (cmd_tx, cmd_rx) = codenomad_client::bounded(8);
            s.commands = Some(cmd_tx);
            let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
            rt.poll = Some(crate::poll);
            for _ in 0..20 {
                rt.frame(0.02);
            }
            rt.update(|_, tx| {
                tx.instant();
                tx.scroll_key_to("shft-20", 0.0);
            });
            for _ in 0..20 {
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
            lane.events
                .try_send((
                    g,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows: make_rows("Trim18_22", 18..22),
                            older: Some(serde_json::json!("older-shft")),
                            newer: Some(serde_json::json!("newer-shft")),
                            running: false,
                            user_file_references: false,
                        },
                        version: 1,
                    },
                ))
                .unwrap();
            rt.set_viewport((844.0, 390.0), 1.0);
            rt.frame(0.02);
            rt.frame(0.02);
            assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
            assert_eq!(rt.state.messages.len(), 4);
            assert!(rt.state.can_older);
            // Drain any setup commands before testing the Shift-wheel event.
            while cmd_rx.try_recv().is_ok() {}

            let h_rect = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some("history"))
                .unwrap()
                .rect;
            let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
            let mut ev = rune::WheelEvent::new(0.0, 360.0).at(wx, wy);
            ev.mods.shift = true;
            ev.mods.ctrl = ctrl;
            ev.precise = false;
            rt.wheel_event(ev);
            for _ in 0..30 {
                rt.frame(0.02);
            }
            let sent_page = cmd_rx.try_recv().is_ok();
            (
                rt.state.messages.len(),
                lane.demand.current().target,
                rt.state.paging,
                sent_page,
            )
        };

        // Notched Shift+wheel (without Ctrl) turns horizontal in Rune and must NOT undo trim
        // or request an older vertical page via timeline::observe_history_wheel.
        let (h_len, h_target, h_paging, h_sent_page) = run_case(false);
        assert_eq!(
            h_len, 4,
            "notched Shift+wheel must not roll back trimmed rows"
        );
        assert_eq!(
            h_target,
            Some(Target::Around("shft-20".into())),
            "notched Shift+wheel must not re-request an older target"
        );
        assert!(
            !h_paging && !h_sent_page,
            "notched Shift+wheel turned horizontal must not request Page(Before)"
        );

        // Ctrl+Shift+wheel stays vertical in Rune on every platform and MUST roll back trim.
        let (v_len, v_target, _, _) = run_case(true);
        assert_eq!(
            v_len, 40,
            "Ctrl+Shift vertical wheel must still roll back trimmed rows"
        );
        assert_ne!(
            v_target,
            Some(Target::Around("shft-20".into())),
            "Ctrl+Shift vertical wheel rollback must advance target above shft-20"
        );
    }

    #[test]
    fn resize_on_replay_delivery_frame_does_not_clamp_against_old_width() {
        let long_sentence = "Wrapped transcript content that expands vertically when the viewport narrows significantly. ";
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rclamp-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} {}", long_sentence.repeat(4)),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full20", 0..20);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 390.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rclamp-01", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, old_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            old_offset > 40.0 && old_offset < 260.0,
            "expected rclamp-01 near top at 844 px so upward delta would clamp at 844 px: {old_offset}"
        );
        rt.set_viewport((320.0, 420.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rclamp-01", 0.0);
        });
        for _ in 0..10 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim01_05", 1..5),
                        older: Some(serde_json::json!("older-rclamp")),
                        newer: Some(serde_json::json!("newer-rclamp")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Upward delta strictly larger than old_offset (would clamp to 0 at 844 px) but strictly
        // smaller than rclamp-01's offset once narrowed to 480 px.
        let upward_dy = old_offset + 40.0;
        rt.wheel_event(rune::WheelEvent::new(0.0, upward_dy).at(wx, wy));
        rt.frame(0.016);
        assert_eq!(rt.state.messages.len(), 20);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Narrow before Frame B delivers the replay probe so rclamp-00 expands taller.
        rt.set_viewport((480.0, 390.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            final_offset > 20.0,
            "narrowed replay must not clamp to 0 against old 844 px geometry: offset={final_offset}"
        );
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let anchor_row = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rclamp-01"))
            .expect("rclamp-01 must remain visible at upward_dy below history top");
        let anchor_rel_y = anchor_row.rect[1] - hist[1];
        assert!(
            (anchor_rel_y - upward_dy).abs() <= 2.0,
            "replay must place rclamp-01 at {upward_dy} px below top in 480 px layout, got {anchor_rel_y}"
        );
    }

    #[test]
    fn second_wheel_delta_on_resize_probe_frame_stays_keyed_to_anchor() {
        let long_sentence = "Wrapped transcript content that expands vertically when the viewport narrows significantly. ";
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("r2w-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} {}", long_sentence.repeat(4)),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full36", 0..36);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("r2w-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim16_36", 16..36),
                        older: Some(serde_json::json!("older-r2w")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + 40.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: downward wheel arms ReplayDeltas while SyncUndo stays armed.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: narrow viewport AND queue a second downward wheel on the delivery frame.
        rt.set_viewport((480.0, 390.0), 1.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let anchor_row = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("r2w-20"))
            .expect("r2w-20 must stay anchored at -80 px after resize + second downward wheel");
        let anchor_rel_y = anchor_row.rect[1] - hist[1];
        assert!(
            (anchor_rel_y - (-80.0)).abs() <= 2.0,
            "second downward wheel on resize probe frame must keep r2w-20 at -80 px, got {anchor_rel_y}"
        );
    }

    #[test]
    fn widening_on_replay_delivery_frame_preserves_top_clamped_rebound() {
        let long_sentence = "Wrapped transcript content that shrinks substantially vertically when the viewport widens significantly. ";
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rwide-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} {}", long_sentence.repeat(5)),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full20", 0..20);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (1200.0, 390.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rwide-01", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, wide_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();

        rt.set_viewport((480.0, 390.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rwide-01", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, narrow_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            narrow_offset > wide_offset + 80.0,
            "expected rwide-01 much lower at 480 px than 1200 px: narrow={narrow_offset}, wide={wide_offset}"
        );

        rt.set_viewport((320.0, 420.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rwide-01", 0.0);
        });
        for _ in 0..10 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim01_05", 1..5),
                        older: Some(serde_json::json!("older-rwide")),
                        newer: Some(serde_json::json!("newer-rwide")),
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((480.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + 40.0, h_rect[1] + h_rect[3] / 2.0);
        // Upward delta does NOT hit top at 480 px (narrow_offset - upward_dy > 0),
        // but DOES hit top at 1200 px (wide_offset - upward_dy < -40) so overshoot is discarded.
        let upward_dy = (wide_offset + narrow_offset) / 2.0;
        assert!(upward_dy > wide_offset + 40.0 && upward_dy < narrow_offset - 40.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, upward_dy).at(wx, wy));
        rt.frame(0.016);
        assert_eq!(rt.state.messages.len(), 20);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: widen to 1200 px and queue a 100 px downward rebound.
        rt.set_viewport((1200.0, 390.0), 1.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, -100.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            (final_offset - 100.0).abs() <= 3.0,
            "widened replay must clamp upward delta at top and rebound to 100 px, got {final_offset} (wide_offset={wide_offset}, upward_dy={upward_dy})"
        );
    }

    #[test]
    fn shortening_viewport_on_latest_replay_delivery_frame_measures_from_new_bottom() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rlat-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim26_30", 26..30),
                        older: Some(serde_json::json!("older-rlat")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        rt.wheel_event(rune::WheelEvent::new(0.0, 80.0).at(wx, wy));
        rt.frame(0.016);
        assert_eq!(rt.state.messages.len(), 30);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Shorten viewport height by 100 px at the same width on the delivery frame.
        rt.set_viewport((844.0, 360.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, final_max) = rt.state.transcript_display.reading().scroll_snapshot();
        let distance_from_bottom = final_max - final_offset;
        assert!(
            (distance_from_bottom - 80.0).abs() <= 2.0,
            "Latest replay after shortening viewport must land 80 px above new bottom, got {distance_from_bottom} (offset={final_offset}, max={final_max})"
        );
    }

    #[test]
    fn shortening_viewport_on_downward_replay_delivery_frame_clears_following_when_off_bottom() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rfol-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(old_max > 200.0);
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 40.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, start_offset, start_max) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            ((start_max - start_offset) - 40.0).abs() <= 2.0,
            "expected 40 px above bottom before suspend: offset={start_offset}, max={start_max}"
        );
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { .. }
            ),
            "off-bottom position before suspend must save Bookmark::Message"
        );
        // Move to narrow viewport while suspended so resuming at 844 px defers scroll for the rail.
        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_30", 15..30),
                        older: Some(serde_json::json!("older-rfol")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // 60 px downward would hit bottom in the 460 px viewport (40 px left),
        // but stays 80 px above bottom once the viewport shortens to 360 px (+100 px max).
        rt.wheel_event(rune::WheelEvent::new(0.0, -60.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        rt.set_viewport((844.0, 360.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, final_max) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            final_max - final_offset > 50.0,
            "downward replay in shortened viewport must stay off-bottom: offset={final_offset}, max={final_max}"
        );
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { .. }
            ),
            "switching away after off-bottom replay in shortened viewport must save reading position, not Latest: {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );
    }

    #[test]
    fn unphased_resize_replay_keeps_sync_undo_for_upward_reversal() {
        let long_sentence = "Wrapped transcript content that expands vertically when the viewport narrows significantly. ";
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rures-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} {}", long_sentence.repeat(4)),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rures-15", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_30", 15..30),
                        older: Some(serde_json::json!("older-rures")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + 40.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: unphased downward wheel arms ReplayDeltas while keeping SyncUndo.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Frame B: resize on replay delivery frame rearms resize replay; pending_scroll settles.
        rt.set_viewport((480.0, 390.0), 1.0);
        rt.frame(0.016);
        assert!(
            rt.state.reader.as_ref().unwrap().has_sync_undo(),
            "SyncUndo must survive first replay delivery while resize replay is pending"
        );

        // Frame C: unphased upward reversal while resize replay is pending must still roll back
        // the older-only trim and request an older target above rures-15.
        rt.wheel_event(rune::WheelEvent::new(0.0, 360.0).at(wx, wy));
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.messages.len(),
            30,
            "upward reversal during pending resize replay must roll back older-only trim"
        );
        let target = lane.demand.current().target;
        match target {
            Some(Target::Around(ref id)) => {
                let idx: usize = id.strip_prefix("rures-").unwrap().parse().unwrap();
                assert!(
                    idx < 15,
                    "rolled-back upward reversal must advance target above rures-15, got {id}"
                );
            }
            other => panic!("expected Target::Around above rures-15, got {other:?}"),
        }
    }

    #[test]
    fn window_blur_clears_vertical_wheel_lock_for_unphased_shift_wheel() {
        let wide_code = format!(
            "```text\n{}\n```",
            "blur_horizontal_segment_0123456789 ".repeat(14)
        );
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    let body = if i == 20 {
                        format!("{prefix} {i:02}\n{wide_code}")
                    } else {
                        format!("{prefix} {i:02} line one\nline two")
                    };
                    crate::Message {
                        usage: None,
                        id: format!("rblur-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body,
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            crate::transcript_state::Display::toggle_code(s, "body-rblur-20", 0);
            tx.instant();
            tx.scroll_key_to("rblur-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim18_30", 18..30),
                        older: Some(serde_json::json!("older-rblur")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert_eq!(rt.state.messages.len(), 12);

        let find_code_el = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|e| {
                    e.text
                        .as_deref()
                        .is_some_and(|t| t.contains("blur_horizontal_segment_"))
                        && e.visible[2] > 0.0
                        && e.visible[3] > 0.0
                })
                .expect("visible horizontally overflowing code block in rblur-20")
        };
        let code_before = find_code_el(&rt);
        assert!(
            code_before.rect[2] > code_before.visible[2] + 20.0,
            "unwrapped code block must overflow horizontally: rect={:?} visible={:?}",
            code_before.rect,
            code_before.visible
        );
        let (cx, cy) = (
            code_before.visible[0] + code_before.visible[2] / 2.0,
            code_before.visible[1] + code_before.visible[3] / 2.0,
        );

        // Start a phased downward gesture while SyncUndo is armed, then blur BEFORE Ended.
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -20.0)
                .at(cx, cy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.frame(0.016);
        rt.window_focus(false);
        rt.frame(0.02);
        rt.window_focus(true);
        rt.frame(0.02);

        // Re-locate the code block after the 20 px downward scroll and send an unphased (Moved)
        // Shift+wheel within 1 second.
        let code_before_shift = find_code_el(&rt);
        let (sx, sy) = (
            code_before_shift.visible[0] + code_before_shift.visible[2] / 2.0,
            code_before_shift.visible[1] + code_before_shift.visible[3] / 2.0,
        );
        let mut ev = rune::WheelEvent::new(0.0, -240.0)
            .at(sx, sy)
            .phase(rune_theme_codenomad::timeline::GesturePhase::Moved);
        ev.mods.shift = true;
        ev.precise = false;
        rt.wheel_event(ev);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.messages.len(),
            12,
            "Shift+wheel after blur must stay horizontal and not roll back trimmed rows"
        );
        let code_after = find_code_el(&rt);
        assert!(
            (code_after.rect[0] - code_before_shift.rect[0]).abs() > 10.0,
            "unphased Shift+wheel after window blur must horizontally scroll the code block: before_x={}, after_x={}",
            code_before_shift.rect[0],
            code_after.rect[0]
        );
    }

    #[test]
    fn shortening_viewport_on_replay_delivery_frame_preserves_queued_prompt_anchor() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rqan-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let tall_queued_text = (0..32)
            .map(|i| format!("Queued prompt line {i:02} kept attached at bottom of transcript"))
            .collect::<Vec<_>>()
            .join("\n");
        let queued_item = codenomad_client::inbox::QueuedPrompt {
            id: "rqan-queued".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: tall_queued_text,
            parts: vec![],
            created: Some(1),
            editable: true,
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full25", 0..25);
        s.transcript_display
            .queue
            .fixture_set(None, vec![queued_item]);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(old_max > 200.0);
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 40.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                &rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { id, .. } if id == "rqan-queued"
            ),
            "expected queued prompt bookmark before resume, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_25", 15..25),
                        older: Some(serde_json::json!("older-rqan")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // 60 px downward hits old max (40 px left at 460 px), then shortening by 100 px should
        // re-replay from the queued prompt anchor and land 80 px above the new bottom (not 100 px).
        rt.wheel_event(rune::WheelEvent::new(0.0, -60.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        rt.set_viewport((844.0, 360.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let (_, final_offset, final_max) = rt.state.transcript_display.reading().scroll_snapshot();
        let distance_from_bottom = final_max - final_offset;
        assert!(
            (distance_from_bottom - 80.0).abs() <= 3.0,
            "queued-prompt replay after shortening viewport must land 80 px above new bottom (not 100 px), got {distance_from_bottom} (offset={final_offset}, max={final_max})"
        );
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                &rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { id, .. } if id == "rqan-queued"
            ),
            "switching away after queued-prompt replay must keep queued prompt bookmark, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );
    }

    #[test]
    fn inbox_removal_on_replay_delivery_frame_replays_against_updated_layout() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rq2-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let queued_a = codenomad_client::inbox::QueuedPrompt {
            id: "rq2-a".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..18)
                .map(|i| format!("Queued prompt A line {i:02} above anchor B"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(1),
            editable: true,
        };
        let queued_b = codenomad_client::inbox::QueuedPrompt {
            id: "rq2-b".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..32)
                .map(|i| format!("Queued prompt B line {i:02} holding saved reading anchor"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(2),
            editable: true,
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full20", 0..20);
        s.transcript_display
            .queue
            .fixture_set(None, vec![queued_a, queued_b]);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(old_max > 300.0);
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 100.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        let saved_offset = match &rt.state.reader.as_ref().unwrap().bookmark {
            Bookmark::Message { id, offset } if id == "rq2-b" => *offset,
            other => panic!("expected queued prompt B bookmark before resume, got {other:?}"),
        };

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim10_20", 10..20),
                        older: Some(serde_json::json!("older-rq2")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: 40 px downward wheel arms ReplayDeltas from queued prompt B (100 px above bottom).
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: remove tall queued prompt A above B without changing viewport size.
        lane.events
            .try_send((
                g,
                0,
                Event::InboxDelta(codenomad_client::inbox::InboxDelta::Removed("rq2-a".into())),
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.transcript_display.queue.items().len(),
            1,
            "queued prompt A must be removed"
        );
        let (_, final_offset, final_max) = rt.state.transcript_display.reading().scroll_snapshot();
        let distance_from_bottom = final_max - final_offset;
        assert!(
            (distance_from_bottom - 60.0).abs() <= 3.0,
            "removing queued prompt A on replay frame must replay 40 px down from B (60 px above bottom), got {distance_from_bottom} (offset={final_offset}, max={final_max})"
        );
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row_b = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rq2-b"))
            .expect("queued prompt B must remain visible at saved_offset - 40");
        let rel_y = row_b.rect[1] - hist[1];
        assert!(
            (rel_y - (saved_offset - 40.0)).abs() <= 3.0,
            "queued prompt B must land at saved_offset - 40 ({}), got {rel_y}",
            saved_offset - 40.0
        );
    }

    #[test]
    fn pointer_leave_clears_vertical_wheel_lock_for_unphased_shift_wheel() {
        let wide_code = format!(
            "```text\n{}\n```",
            "leave_horizontal_segment_0123456789 ".repeat(14)
        );
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    let body = if i == 20 {
                        format!("{prefix} {i:02}\n{wide_code}")
                    } else {
                        format!("{prefix} {i:02} line one\nline two")
                    };
                    crate::Message {
                        usage: None,
                        id: format!("rpl-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body,
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| {
            crate::transcript_state::Display::toggle_code(s, "body-rpl-20", 0);
            tx.instant();
            tx.scroll_key_to("rpl-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim18_30", 18..30),
                        older: Some(serde_json::json!("older-rpl")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        assert_eq!(rt.state.messages.len(), 12);

        let find_code_el = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|e| {
                    e.text
                        .as_deref()
                        .is_some_and(|t| t.contains("leave_horizontal_segment_"))
                        && e.visible[2] > 0.0
                        && e.visible[3] > 0.0
                })
                .expect("visible horizontally overflowing code block in rpl-20")
        };
        let code_before = find_code_el(&rt);
        assert!(
            code_before.rect[2] > code_before.visible[2] + 20.0,
            "unwrapped code block must overflow horizontally: rect={:?} visible={:?}",
            code_before.rect,
            code_before.visible
        );
        let (cx, cy) = (
            code_before.visible[0] + code_before.visible[2] / 2.0,
            code_before.visible[1] + code_before.visible[3] / 2.0,
        );

        // Enter the window, start a phased vertical gesture while SyncUndo is armed, then leave
        // the focused window and return WITHOUT blurring or sending Ended.
        rt.pointer_move(cx, cy);
        rt.frame(0.016);
        rt.wheel_event(
            rune::WheelEvent::new(0.0, -20.0)
                .at(cx, cy)
                .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
        );
        rt.frame(0.016);
        rt.pointer_leave();
        rt.frame(0.02);

        let code_before_shift = find_code_el(&rt);
        let (sx, sy) = (
            code_before_shift.visible[0] + code_before_shift.visible[2] / 2.0,
            code_before_shift.visible[1] + code_before_shift.visible[3] / 2.0,
        );
        rt.pointer_move(sx, sy);
        rt.frame(0.02);

        // Within 1 second, send an unphased (Moved) Shift+wheel over the overflowing code block.
        let mut ev = rune::WheelEvent::new(0.0, -240.0)
            .at(sx, sy)
            .phase(rune_theme_codenomad::timeline::GesturePhase::Moved);
        ev.mods.shift = true;
        ev.precise = false;
        rt.wheel_event(ev);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.messages.len(),
            12,
            "Shift+wheel after pointer leave must stay horizontal and not roll back trimmed rows"
        );
        let code_after = find_code_el(&rt);
        assert!(
            (code_after.rect[0] - code_before_shift.rect[0]).abs() > 10.0,
            "unphased Shift+wheel after pointer leave must horizontally scroll the code block: before_x={}, after_x={}",
            code_before_shift.rect[0],
            code_after.rect[0]
        );
    }

    #[test]
    fn live_streaming_text_deltas_do_not_stall_wheel_replay() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rstrm-{i:02}"),
                        role: "assistant".into(),
                        completed: i != 29,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rstrm-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_30", 15..30),
                        older: Some(serde_json::json!("older-rstrm")),
                        newer: None,
                        running: true,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + 40.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: wheel down 40 px to arm ReplayDeltas from rstrm-20.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Deliver a live streaming Event::Text delta before EVERY single frame — replay must
        // execute immediately without waiting for a quiet frame.
        for tick in 0..10 {
            lane.events
                .try_send((
                    g,
                    0,
                    Event::Text(
                        "rstrm-29".into(),
                        crate::content::TextEvent::Delta {
                            ordinal: Some(0),
                            text: format!(" tok{tick}"),
                        },
                    ),
                ))
                .unwrap();
            rt.frame(0.016);
        }
        assert!(
            !rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe(),
            "continuous live text deltas must not keep wheel replay stalled indefinitely"
        );
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row20 = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rstrm-20"))
            .expect("rstrm-20 must remain visible after 40 px downward replay");
        let rel_y = row20.rect[1] - hist[1];
        assert!(
            (rel_y - (-40.0)).abs() <= 3.0,
            "wheel replay under continuous streaming deltas must land rstrm-20 at -40 px, got {rel_y}"
        );
    }

    #[test]
    fn touch_drag_before_replay_probe_frame_wins_over_queued_wheel_replay() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rtch-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rtch-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim12_30", 12..30),
                        older: Some(serde_json::json!("older-rtch")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (px, py) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: arm a 40 px downward wheel replay from rtch-20.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(px, py));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );
        let (_, offset_at_anchor, _) = rt.state.transcript_display.reading().scroll_snapshot();

        // Before Frame B: drag the transcript upward by 140 px with one finger and hold still.
        rt.touch(1, rune::TouchPhase::Started, px, py, 10.0);
        rt.touch(1, rune::TouchPhase::Moved, px, py + 140.0, 10.02);
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let (_, final_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            final_offset < offset_at_anchor - 80.0,
            "touch drag before replay probe frame must win over queued downward wheel replay: anchor={offset_at_anchor}, final={final_offset}"
        );
    }

    #[test]
    fn removing_anchored_queued_prompt_replays_accepted_wheel_from_surviving_neighbor() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rqvan-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let queued_a = codenomad_client::inbox::QueuedPrompt {
            id: "rqvan-a".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..18)
                .map(|i| format!("Queued prompt A line {i:02} at the reading line"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(1),
            editable: true,
        };
        let queued_b = codenomad_client::inbox::QueuedPrompt {
            id: "rqvan-b".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..36)
                .map(|i| format!("Queued prompt B line {i:02} long surviving neighbor below A"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(2),
            editable: true,
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full20", 0..20);
        s.transcript_display
            .queue
            .fixture_set(None, vec![queued_a, queued_b]);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rqvan-a", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                &rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { id, .. } if id == "rqvan-a"
            ),
            "expected queued prompt A bookmark before resume, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim10_20", 10..20),
                        older: Some(serde_json::json!("older-rqvan")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: wheel down 40 px to arm replay from queued prompt A.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: remove anchored queued prompt A remotely.
        lane.events
            .try_send((
                g,
                0,
                Event::InboxDelta(codenomad_client::inbox::InboxDelta::Removed(
                    "rqvan-a".into(),
                )),
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.state.transcript_display.queue.items().len(), 1);
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row_b = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rqvan-b"))
            .expect("surviving neighbor queued prompt B must be visible");
        let rel_y = row_b.rect[1] - hist[1];
        assert!(
            (rel_y - (-40.0)).abs() <= 3.0,
            "removing anchored queued prompt A must replay accepted 40 px downward wheel onto surviving neighbor B (-40 px), got {rel_y}"
        );
    }

    #[test]
    fn click_on_transcript_before_replay_probe_frame_preserves_accepted_wheel() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rclk-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rclk-20", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim12_30", 12..30),
                        older: Some(serde_json::json!("older-rclk")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (px, py) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: arm a 40 px downward wheel replay from rclk-20.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(px, py));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: click transcript whitespace without dragging.
        rt.pointer_down(px, py);
        rt.pointer_up(px, py);
        for _ in 0..15 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row20 = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rclk-20"))
            .expect("rclk-20 must remain visible after 40 px downward replay");
        let rel_y = row20.rect[1] - hist[1];
        assert!(
            (rel_y - (-40.0)).abs() <= 3.0,
            "plain click without drag before replay probe frame must not discard accepted 40 px wheel: got {rel_y}"
        );
    }

    #[test]
    fn appending_queued_prompt_on_replay_frame_replays_full_downward_wheel_past_old_bottom() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rqapp-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let queued_a = codenomad_client::inbox::QueuedPrompt {
            id: "rqapp-a".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..32)
                .map(|i| format!("Queued prompt A line {i:02} holding saved anchor"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(1),
            editable: true,
        };
        let queued_b = codenomad_client::inbox::QueuedPrompt {
            id: "rqapp-b".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..24)
                .map(|i| format!("Queued prompt B line {i:02} appended on replay frame"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(2),
            editable: true,
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full25", 0..25);
        s.transcript_display.queue.fixture_set(None, vec![queued_a]);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 40.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        let saved_offset = match &rt.state.reader.as_ref().unwrap().bookmark {
            Bookmark::Message { id, offset } if id == "rqapp-a" => *offset,
            other => panic!("expected queued prompt A bookmark before resume, got {other:?}"),
        };

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_25", 15..25),
                        older: Some(serde_json::json!("older-rqapp")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: wheel down 100 px (exceeds the 40 px remaining above old bottom).
        rt.wheel_event(rune::WheelEvent::new(0.0, -100.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: append tall queued prompt B below A so all 100 px fit.
        lane.events
            .try_send((
                g,
                0,
                Event::InboxDelta(codenomad_client::inbox::InboxDelta::Upsert(queued_b)),
            ))
            .unwrap();
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.state.transcript_display.queue.items().len(), 2);
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row_a = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rqapp-a"))
            .expect("queued prompt A must remain visible at saved_offset - 100");
        let rel_y = row_a.rect[1] - hist[1];
        assert!(
            (rel_y - (saved_offset - 100.0)).abs() <= 3.0,
            "appending queued prompt B on replay frame must replay full 100 px (saved_offset - 100 = {}), got {rel_y}",
            saved_offset - 100.0
        );
    }

    #[test]
    fn local_queue_removal_settling_on_replay_frame_retargets_accepted_wheel_to_neighbor() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rqloc-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let queued_a = codenomad_client::inbox::QueuedPrompt {
            id: "rqloc-a".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..18)
                .map(|i| format!("Queued prompt A line {i:02} canceled locally"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(1),
            editable: true,
        };
        let queued_b = codenomad_client::inbox::QueuedPrompt {
            id: "rqloc-b".into(),
            delivery: codenomad_client::prompt::Delivery::Queue,
            text: (0..36)
                .map(|i| format!("Queued prompt B line {i:02} surviving neighbor below A"))
                .collect::<Vec<_>>()
                .join("\n"),
            parts: vec![],
            created: Some(2),
            editable: true,
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full20", 0..20);
        s.transcript_display
            .queue
            .fixture_set(None, vec![queued_a, queued_b]);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rqloc-a", 0.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        assert!(
            matches!(
                &rt.state.reader.as_ref().unwrap().bookmark,
                Bookmark::Message { id, .. } if id == "rqloc-a"
            ),
            "expected queued prompt A bookmark before resume, got {:?}",
            rt.state.reader.as_ref().unwrap().bookmark
        );

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim10_20", 10..20),
                        older: Some(serde_json::json!("older-rqloc")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: wheel down 40 px to arm replay from queued prompt A.
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: settle local cancellation of A via chat::queue::poll (before any inbox delta).
        rt.state
            .transcript_display
            .queue
            .fixture_settle_remove("rqloc-a".into());
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(rt.state.transcript_display.queue.items().len(), 1);
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row_b = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rqloc-b"))
            .expect("surviving neighbor queued prompt B must be visible");
        let rel_y = row_b.rect[1] - hist[1];
        assert!(
            (rel_y - (-40.0)).abs() <= 3.0,
            "local queue removal settling on replay frame must replay accepted 40 px downward wheel onto B (-40 px), got {rel_y}"
        );
    }

    #[test]
    fn page_down_on_replay_probe_frame_wins_over_queued_wheel_replay() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            range
                .map(|i| {
                    crate::Message {
                        usage: None,
                        id: format!("rpgdn-{i:02}"),
                        role: "assistant".into(),
                        completed: true,
                        body: format!("{prefix} {i:02} line one\nline two\nline three"),
                        parts: vec![],
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = make_rows("Full30", 0..30);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (320.0, 420.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.on_key = Some(crate::shell::keys);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("rpgdn-16", 0.0);
        });
        for _ in 0..20 {
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
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim10_30", 10..30),
                        older: Some(serde_json::json!("older-rpgdn")),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 390.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        assert!(rt.state.reader.as_ref().unwrap().has_sync_undo());
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (px, py) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);

        // Frame A: arm a small 40 px downward wheel replay from rpgdn-16.
        rt.pointer_move(px, py);
        rt.wheel_event(rune::WheelEvent::new(0.0, -40.0).at(px, py));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );
        let (_, offset_at_anchor, _) = rt.state.transcript_display.reading().scroll_snapshot();

        // Before Frame B: press PageDown with pointer over transcript and no text field focused.
        rt.key(rune::KeyEvent {
            key: rune::Key::PageDown,
            mods: rune::Mods::default(),
        });
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let (_, final_offset, _) = rt.state.transcript_display.reading().scroll_snapshot();
        assert!(
            final_offset > offset_at_anchor + 150.0,
            "PageDown on replay probe frame must not be overwritten by 40 px wheel replay: anchor={offset_at_anchor}, final={final_offset}"
        );
    }

    #[test]
    fn streaming_growth_on_replay_frame_replays_full_downward_wheel_past_old_bottom() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            let end = range.end;
            range
                .map(|i| {
                    let last = i + 1 == end;
                    let body = if last {
                        (0..28)
                            .map(|line| format!("{prefix} final line {line:02}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        format!("{prefix} {i:02} line one\nline two\nline three")
                    };
                    let parts = if last {
                        vec![crate::content::Part::Text(crate::content::Text {
                            part_index: Some(0),
                            text: body.clone(),
                            provenance: crate::content::TextProvenance::Live,
                        })]
                    } else {
                        vec![]
                    };
                    crate::Message {
                        usage: None,
                        id: format!("rstgr-{i:02}"),
                        role: "assistant".into(),
                        completed: !last,
                        body,
                        parts,
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Streaming;
        s.messages = make_rows("Full25", 0..25);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 40.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        let saved_offset = match &rt.state.reader.as_ref().unwrap().bookmark {
            Bookmark::Message { id, offset } if id == "rstgr-24" => *offset,
            other => panic!("expected final streaming message bookmark, got {other:?}"),
        };

        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_25", 15..25),
                        older: Some(serde_json::json!("older-rstgr")),
                        newer: None,
                        running: true,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());

        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Frame A: wheel down 100 px (exceeds the 40 px remaining above old bottom).
        rt.wheel_event(rune::WheelEvent::new(0.0, -100.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );

        // Before Frame B: append streaming lines adding > 100 px to the final message.
        let chunk = (0..12)
            .map(|i| format!("\nstreamed growth line {i:02} expanding final message"))
            .collect::<String>();
        lane.events
            .try_send((
                g,
                0,
                Event::Text(
                    "rstgr-24".into(),
                    crate::content::TextEvent::Delta {
                        ordinal: Some(0),
                        text: chunk,
                    },
                ),
            ))
            .unwrap();
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let hist = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let row_last = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rstgr-24"))
            .expect("final streaming message must remain visible");
        let rel_y = row_last.rect[1] - hist[1];
        assert!(
            (rel_y - (saved_offset - 100.0)).abs() <= 3.0,
            "streaming growth on replay frame must apply full 100 px downward wheel (saved_offset - 100 = {}), got {rel_y}",
            saved_offset - 100.0
        );
    }

    #[test]
    fn continuous_streaming_while_clamped_at_bottom_does_not_stall_wheel_replay() {
        let make_rows = |prefix: &str, range: std::ops::Range<usize>| -> Vec<crate::history::Row> {
            let end = range.end;
            range
                .map(|i| {
                    let last = i + 1 == end;
                    let body = if last {
                        (0..28)
                            .map(|line| format!("{prefix} final line {line:02}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        format!("{prefix} {i:02} line one\nline two\nline three")
                    };
                    let parts = if last {
                        vec![crate::content::Part::Text(crate::content::Text {
                            part_index: Some(0),
                            text: body.clone(),
                            provenance: crate::content::TextProvenance::Live,
                        })]
                    } else {
                        vec![]
                    };
                    crate::Message {
                        usage: None,
                        id: format!("rstcl-{i:02}"),
                        role: "assistant".into(),
                        completed: !last,
                        body,
                        parts,
                    }
                    .into()
                })
                .collect()
        };
        let mut s = init();
        s.phase = Phase::Streaming;
        s.messages = make_rows("Full25", 0..25);
        let (reader, lane) = Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (844.0, 460.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (_, _, old_max) = rt.state.transcript_display.reading().scroll_snapshot();
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_to_y("history", old_max - 40.0);
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        rt.update(|s, _| suspend(s));
        rt.set_viewport((320.0, 460.0), 1.0);
        for _ in 0..5 {
            rt.frame(0.02);
        }
        rt.update(|s, tx| resume(s, tx));
        let g = rt.state.reader.as_ref().unwrap().generation;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        lane.events
            .try_send((
                g,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: make_rows("Trim15_25", 15..25),
                        older: Some(serde_json::json!("older-rstcl")),
                        newer: None,
                        running: true,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        rt.set_viewport((844.0, 460.0), 1.0);
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        rt.frame(0.02);
        assert!(rt.state.reader.as_ref().unwrap().has_pending_scroll());
        let h_rect = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect;
        let (wx, wy) = (h_rect[0] + h_rect[2] / 2.0, h_rect[1] + h_rect[3] / 2.0);
        // Wheel down 600 px so replay clamps even after one streaming growth chunk.
        rt.wheel_event(rune::WheelEvent::new(0.0, -600.0).at(wx, wy));
        rt.frame(0.016);
        assert!(
            rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe()
        );
        // Deliver a streaming delta on every single frame.
        for tick in 0..10 {
            lane.events
                .try_send((
                    g,
                    0,
                    Event::Text(
                        "rstcl-24".into(),
                        crate::content::TextEvent::Delta {
                            ordinal: Some(0),
                            text: format!("\nchunk {tick}"),
                        },
                    ),
                ))
                .unwrap();
            rt.frame(0.016);
        }
        assert!(
            !rt.state
                .transcript_display
                .reading()
                .has_pending_restore_probe(),
            "bounded clamp retry must not stall indefinitely under continuous streaming"
        );
    }
}
