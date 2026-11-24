use super::reading::{Bookmark, Reading};
use crate::{State, transport::Event};
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
    atomic::{AtomicU64, Ordering::SeqCst},
};

pub(crate) struct Reader {
    request: Demand,
    events: Receiver<(u64, u64, Event)>,
    connection: Arc<AtomicU64>,
    generation: u64,
    bookmark: Bookmark,
    bookmark_width: f32,
    width_grew_while_deferred: bool,
    resume_manual_seq: Option<u64>,
    reconciled_manual_scroll: bool,
    deferred_sync: Option<(u64, u64, Event, u8)>,
    awaiting_manual_probe: u8,
    hidden: bool,
    resume_pending: bool,
    pending_scroll: bool,
    gap: bool,
    parked: bool,
    activity: Option<(bool, u64)>,
    settling: bool,
}

impl Reader {
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
        (
            Self {
                request,
                events,
                connection: connection.clone(),
                generation: 0,
                bookmark: Bookmark::Latest,
                bookmark_width: 0.0,
                width_grew_while_deferred: false,
                resume_manual_seq: None,
                reconciled_manual_scroll: false,
                deferred_sync: None,
                awaiting_manual_probe: 0,
                hidden: false,
                resume_pending: false,
                pending_scroll: false,
                gap: false,
                parked: false,
                activity: None,
                settling: false,
            },
            ReadingLane {
                demand,
                events: out,
                connection,
            },
        )
    }

    fn drain(&self) {
        while self.events.try_recv().is_ok() {}
    }

    pub(crate) fn stop_content(&mut self) {
        self.hidden = true;
        self.pending_scroll = false;
        self.deferred_sync = None;
        self.awaiting_manual_probe = 0;
        self.generation = self.request.publish(None);
        self.drain();
    }

    pub(crate) fn take_next(
        &mut self,
        defer_sync: bool,
        reading: &Reading,
        history_bounds: [f32; 4],
    ) -> Option<Event> {
        if let Some((generation, connection, event, stage)) = self.deferred_sync.take() {
            if !self.hidden
                && generation == self.generation
                && connection == self.connection.load(SeqCst)
            {
                if !defer_sync || !self.resume_pending {
                    return Some(event);
                }
                let ready = reading.top_is_fresh()
                    || reading
                        .live_bookmark_fresh(history_bounds, self.gap)
                        .is_some();
                if ready || stage >= 3 {
                    return Some(event);
                }
                self.deferred_sync = Some((generation, connection, event, stage + 1));
                return None;
            }
        }
        while let Ok((generation, connection, event)) = self.events.try_recv() {
            if !self.hidden
                && generation == self.generation
                && connection == self.connection.load(SeqCst)
            {
                if defer_sync && self.resume_pending && matches!(event, Event::ReaderSync { .. }) {
                    self.deferred_sync = Some((generation, connection, event, 0));
                    return None;
                }
                return Some(event);
            }
        }
        None
    }

    pub(crate) fn has_deferred_sync(&self) -> bool {
        self.deferred_sync.is_some()
    }

    pub(crate) fn blocks_send(&self) -> bool {
        self.hidden || self.resume_pending || self.gap || self.parked || self.settling
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
        self.deferred_sync = None;
        self.awaiting_manual_probe = 0;
        self.resume_manual_seq = None;
        self.reconciled_manual_scroll = false;
        self.bookmark = current;
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
        self.gap = gap;
        self.parked = false;
        self.pending_scroll |= self.resume_pending;
        self.resume_pending = false;
    }

    pub(crate) fn failed(&mut self) {
        self.parked = true;
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

    fn reconnecting(&mut self, reading: &Reading, paging: bool, history_bounds: [f32; 4]) {
        self.activity = None;
        self.deferred_sync = None;
        if !self.hidden && (self.resume_pending || paging) {
            if self.resume_pending {
                let manual_seq = self.resume_manual_seq;
                self.resume(self.bookmark.clone());
                self.resume_manual_seq = manual_seq;
            } else {
                self.resume_watching(self.bookmark_at(reading, history_bounds), reading);
            }
        }
    }

    pub(crate) fn defers_scroll(&self) -> bool {
        self.resume_pending || self.pending_scroll || self.hidden
    }

    pub(crate) fn awaits_history_width(&self) -> bool {
        self.pending_scroll && self.bookmark_width > 0.0
    }

    pub(crate) fn take_manual_probe_wait(&mut self) -> bool {
        if self.awaiting_manual_probe == 1 {
            self.awaiting_manual_probe = 2;
            true
        } else {
            false
        }
    }

    pub(crate) fn awaiting_manual_probe(&self) -> bool {
        self.awaiting_manual_probe != 0
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
            let _ = std::mem::take(&mut self.awaiting_manual_probe);
            let had_manual_scroll = std::mem::take(&mut self.reconciled_manual_scroll);
            if self.user_scrolled_while_resuming(reading) {
                if let Some(live) = reading.live_bookmark_fresh(history_bounds, self.gap) {
                    let live_valid = match &live {
                        Bookmark::Latest => true,
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
            reading.arm_frame_restore_for(&self.bookmark, had_manual_scroll);
            reading.note_programmatic_scroll();
            Reading::restore(&self.bookmark, tx);
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

pub(crate) fn reconnecting(s: &mut State) {
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    if let Some(reader) = &mut s.reader {
        reader.reconnecting(s.transcript_display.reading_mut(), s.paging, history_bounds);
    }

    s.paging = false;
}

pub(crate) fn invalidate(s: &mut State) {
    s.transcript_display
        .reading_mut()
        .reset_to_latest(s.revision);
    if let Some(reader) = &mut s.reader {
        reader.bookmark = Bookmark::Latest;
        if !reader.hidden {
            reader.resume(Bookmark::Latest);
        }
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

pub(crate) fn reconcile_bookmark(s: &mut State, page: &crate::history::Page) -> bool {
    let rows = &page.rows;
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    let reading = s.transcript_display.reading();
    let user_scrolled = s.reader.as_ref().is_some_and(|reader| {
        reader.resume_pending && reader.user_scrolled_while_resuming(reading)
    });
    if user_scrolled {
        if let Some(reader) = &mut s.reader {
            reader.reconciled_manual_scroll = true;
        }
        let reading = s.transcript_display.reading();
        if let Some(live) = reading.live_bookmark_fresh(history_bounds, false) {
            let live_valid = match &live {
                Bookmark::Latest => true,
                Bookmark::Message { id, .. } => rows.iter().any(|row| &row.id == id),
            };
            if live_valid {
                if let Some(reader) = &mut s.reader {
                    reader.bookmark = live;
                    reader.bookmark_width = 0.0;
                    reader.width_grew_while_deferred = false;
                    reader.resume_manual_seq = None;
                    reader.awaiting_manual_probe = 0;
                }
                return false;
            }
            if let Bookmark::Message { id, .. } = &live {
                let live_pos = s.messages.iter().position(|row| &row.id == id);
                let first_pos = rows
                    .first()
                    .and_then(|first| s.messages.iter().position(|row| row.id == first.id));
                let last_pos = rows
                    .last()
                    .and_then(|last| s.messages.iter().position(|row| row.id == last.id));
                let outside_window = page.older.is_some()
                    || page.newer.is_some()
                    || live_pos.zip(first_pos).is_some_and(|(l, f)| l < f)
                    || live_pos.zip(last_pos).is_some_and(|(l, e)| l > e);
                if outside_window {
                    if let Some(reader) = &mut s.reader {
                        reader.bookmark_width = 0.0;
                        reader.width_grew_while_deferred = false;
                        reader.resume_watching(live, reading);
                    }
                    return true;
                }
            }
            if let Some(reader) = &mut s.reader {
                reader.resume_manual_seq = Some(reading.manual_scroll_seq());
                reader.awaiting_manual_probe = 0;
            }
        } else if let Some(reader) = &mut s.reader {
            reader.awaiting_manual_probe = 1;
        }
    }
    if let Some(reader) = &mut s.reader
        && reader.resume_pending
        && let Bookmark::Message { id, .. } = &reader.bookmark
        && !rows.iter().any(|row| &row.id == id)
    {
        reader.bookmark = Bookmark::Latest;
        if reader.awaiting_manual_probe == 0 {
            reader.resume_manual_seq = None;
            s.transcript_display
                .reading_mut()
                .reset_to_latest(s.revision);
        }
    }
    false
}

pub(crate) fn suspend(s: &mut State) {
    let width = s.tool_diff_preferences.history_width();
    let history_bounds = s.tool_diff_preferences.history_bounds.get();
    if let Some(reader) = &mut s.reader {
        reader.deferred_sync = None;
        let reading = s.transcript_display.reading();
        if !reader.defers_scroll()
            || (!reader.hidden && reader.user_scrolled_while_resuming(reading))
        {
            reader.bookmark = reader.bookmark_at(reading, history_bounds);
            reader.bookmark_width = width;
            reader.width_grew_while_deferred = false;
            reader.resume_manual_seq = None;
            reader.awaiting_manual_probe = 0;
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
        s.transcript_display.evict_rendered();
    }
}

pub(crate) fn resume(s: &mut State, tx: &mut Tx) {
    let reading_visible =
        !s.screen.is_launcher() && !crate::git::has_preview(s) && !crate::files::has_preview(s);
    if let Some(reader) = &mut s.reader {
        if reader.hidden {
            reader.resume_watching(reader.bookmark.clone(), s.transcript_display.reading());
            if reading_visible {
                let target = match &reader.bookmark {
                    Bookmark::Message { id, offset }
                        if s.messages.iter().any(|row| row.id == *id) =>
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
    let covered = crate::files::has_preview(s) || crate::git::has_preview(s);
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
        reader.deferred_sync = None;
        reader.awaiting_manual_probe = 0;
    } else {
        if let Some(reader) = &mut s.reader {
            reader.bookmark = Bookmark::Latest;
            reader.pending_scroll = false;
            reader.bookmark_width = 0.0;
            reader.width_grew_while_deferred = false;
            reader.resume_manual_seq = None;
            reader.deferred_sync = None;
            reader.awaiting_manual_probe = 0;
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
        s.history_error = false;
        s.paging = false;
        tx.instant();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Phase, init, poll_chat};
    use rune::{Env, Runtime};

    #[test]
    fn receipt_updates_the_bookmark_of_a_hidden_optimistic_row() {
        let mut state = init();
        let (mut reader, lane) = Reader::open();
        reader.resume(Bookmark::Message {
            id: "attempt".into(),
            offset: -15.0,
        });
        reader.stop_content();
        state.reader = Some(reader);
        settle_bookmark(&mut state, "attempt", Some("confirmed"));
        assert!(lane.demand.current().target.is_none());
        assert_eq!(
            state.reader.as_ref().unwrap().bookmark,
            Bookmark::Message {
                id: "confirmed".into(),
                offset: -15.0,
            }
        );
        settle_bookmark(&mut state, "confirmed", None);
        assert_eq!(state.reader.as_ref().unwrap().bookmark, Bookmark::Latest);
    }

    #[test]
    fn queued_content_cannot_reopen_admission_after_a_disconnect() {
        let mut state = init();
        let (reader, lane) = Reader::open();
        state.reader = Some(reader);
        let (out, incoming) = bounded(1);
        state.incoming = Some(incoming);
        lane.events
            .try_send((
                0,
                0,
                Event::Sync(crate::history::Page {
                    rows: vec![],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                }),
            ))
            .unwrap();
        lane.events.try_send((0, 0, Event::Done)).unwrap();
        lane.connection.store(1, SeqCst);
        out.try_send(Event::Reconnecting).unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.phase == Phase::Reconnecting);
        lane.events
            .try_send((
                0,
                1,
                Event::Sync(crate::history::Page {
                    rows: vec![],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                }),
            ))
            .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.phase == Phase::Ready);
    }

    #[test]
    fn a_page_queued_before_an_activity_change_cannot_reopen_admission() {
        for previous in [false, true] {
            let mut state = init();
            let (reader, lane) = Reader::open();
            state.reader = Some(reader);
            let (out, incoming) = bounded(2);
            state.incoming = Some(incoming);
            let queue_page = |running, version| {
                lane.events
                    .try_send((
                        0,
                        0,
                        Event::ReaderSync {
                            page: crate::history::Page {
                                rows: vec![],
                                older: None,
                                newer: None,
                                running,
                                user_file_references: false,
                            },
                            version,
                        },
                    ))
                    .unwrap();
            };
            queue_page(previous, 1);
            out.try_send(Event::ObservedRunning {
                running: !previous,
                version: 2,
            })
            .unwrap();
            assert!(poll_chat(&mut state, 8));
            assert!(state.phase == Phase::Streaming);
            assert!(state.reader.as_ref().unwrap().blocks_send());
            out.try_send(Event::ObservedRunning {
                running: false,
                version: 3,
            })
            .unwrap();
            queue_page(false, 3);
            assert!(poll_chat(&mut state, 8));
            assert!(state.phase == Phase::Ready);
            assert!(!state.reader.as_ref().unwrap().blocks_send());
        }
    }

    #[test]
    fn a_disconnect_reissues_an_uninstalled_around_snapshot() {
        let mut state = init();
        let (mut reader, lane) = Reader::open();
        reader.resume(Bookmark::Message {
            id: "saved-anchor".into(),
            offset: -17.0,
        });
        let previous = lane.demand.current();
        state.reader = Some(reader);
        let (out, incoming) = bounded(1);
        state.incoming = Some(incoming);
        lane.events
            .try_send((
                previous.generation,
                0,
                Event::Sync(crate::history::Page {
                    rows: vec![],
                    older: None,
                    newer: Some(serde_json::json!({"kind":"after"})),
                    running: false,
                    user_file_references: false,
                }),
            ))
            .unwrap();
        lane.connection.store(1, SeqCst);
        out.try_send(Event::Reconnecting).unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.reader.as_ref().unwrap().resume_pending);
        let resumed = lane.demand.current();
        assert_eq!(resumed.target, previous.target);
        assert_ne!(resumed.generation, previous.generation);
    }

    #[test]
    fn terminal_observation_settles_when_suspension_cancels_the_tail_read() {
        let mut state = init();
        let (reader, _lane) = Reader::open();
        state.reader = Some(reader);
        state.phase = Phase::Streaming;
        let (out, incoming) = bounded(1);
        state.incoming = Some(incoming);
        out.try_send(Event::ObservedRunning {
            running: false,
            version: 1,
        })
        .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(
            state.phase == Phase::Streaming,
            "visible tail still needs the content read"
        );
        assert!(state.reader.as_ref().unwrap().blocks_send());
        suspend(&mut state);
        assert!(
            state.phase == Phase::Ready,
            "hidden execution status settles without content"
        );
    }

    #[test]
    fn retry_keeps_the_original_anchor_even_without_cached_rows() {
        let mut state = init();
        let (mut reader, lane) = Reader::open();
        let anchor = Bookmark::Message {
            id: "saved-anchor".into(),
            offset: -17.0,
        };
        reader.resume(anchor.clone());
        let previous = lane.demand.current();
        reader.failed();
        state.reader = Some(reader);
        state.phase = Phase::Reconnecting;
        state.history_error = true;
        assert!(!state.can_older && state.messages.is_empty());
        let mut rt = Runtime::new(state, crate::view, (960.0, 760.0), Env::new(false, 1.0));
        rt.frame(0.02);
        let (x, y) = rt
            .find("older")
            .expect("Retry is available without an Older cursor");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert!(!rt.state.history_error);
        assert_eq!(rt.state.reader.as_ref().unwrap().bookmark, anchor);
        assert_eq!(lane.demand.current().target, previous.target);
        assert_ne!(lane.demand.current().generation, previous.generation);
    }

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
            "fast post-rotation resume must clamp huge-fast-resume near 24px visible: wide={wide:?}, history={history:?}"
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
            reconnecting(s);
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
        s.messages = (0..50)
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
        let window_15_30: Vec<_> = s.messages[15..=30].to_vec();
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
        // Step 1: scroll down from row-20 to row-31..=36 (outside [15..=30]) and settle so
        // reading.top records that out-of-window row.
        let mut settled_high = None;
        for _ in 0..24 {
            rt.wheel(hx, hy, -220.0);
            for _ in 0..15 {
                rt.frame(0.02);
            }
            if let Some(k) = top_key(&rt)
                && let Some(num) = k.strip_prefix("row-").and_then(|s| s.parse::<usize>().ok())
                && (31..=36).contains(&num)
            {
                settled_high = Some(k);
                break;
            }
        }
        let settled_high = settled_high.expect("first scroll must settle on row-31..=36");
        assert!(
            !window_15_30.iter().any(|r| r.id == settled_high),
            "first scroll must settle outside [15..=30], got {settled_high}"
        );
        // Step 2: wheel up once and step a single frame so the visible top row moves into
        // [15..=30] (!= row-20) while its on_drawn_layout_tx is still queued in frame.queue
        // (reading.top still holds settled_high, which is absent from [15..=30]).
        let mut target_in_window = None;
        for _ in 0..8 {
            rt.wheel(hx, hy, 360.0);
            rt.frame(0.02);
            if let Some(k) = top_key(&rt)
                && window_15_30.iter().any(|r| r.id == k)
                && k != "row-20"
            {
                target_in_window = Some(k);
                break;
            }
        }
        let target = target_in_window.expect("must reach a row inside [15..=30] != row-20");
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
        // Step 3: deliver ReaderSync [15..=30] immediately before the next frame drains Action::Layout.
        lane.events
            .try_send((
                resume_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: window_15_30,
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
    }
}
