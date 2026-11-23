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
    hidden: bool,
    resume_pending: bool,
    pending_scroll: bool,
    gap: bool,
    parked: bool,
    activity: Option<(bool, u64)>,
    settling: bool,
}

impl Reader {
    pub(super) fn open() -> (Self, ReadingLane) {
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
        self.generation = self.request.publish(None);
        self.drain();
    }

    pub(crate) fn next(&self) -> Option<Event> {
        while let Ok((generation, connection, event)) = self.events.try_recv() {
            if !self.hidden
                && generation == self.generation
                && connection == self.connection.load(SeqCst)
            {
                return Some(event);
            }
        }
        None
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

    pub(super) fn resume(&mut self, current: Bookmark) {
        let target = match &current {
            Bookmark::Latest => Target::Latest,
            Bookmark::Message { id, .. } => Target::Around(id.clone()),
        };
        self.hidden = false;
        self.parked = false;
        self.resume_pending = true;
        self.pending_scroll = false;
        self.bookmark = current;
        self.generation = self.request.publish(Some(target));
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

    pub(crate) fn observed_running(&mut self, running: bool, version: u64) {
        self.settling = !running && !self.independent_status() && self.running() == Some(true);
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

    fn reconnecting(&mut self, reading: &Reading, paging: bool) {
        self.activity = None;
        if !self.hidden && (self.resume_pending || paging) {
            self.resume(self.bookmark(reading));
        }
    }

    pub(crate) fn bookmark(&self, reading: &Reading) -> Bookmark {
        if self.resume_pending || self.pending_scroll || self.hidden {
            self.bookmark.clone()
        } else {
            reading.bookmark(self.gap)
        }
    }

    pub(crate) fn renderer_ready(&mut self, tx: &mut Tx) {
        if std::mem::take(&mut self.pending_scroll) {
            Reading::restore(&self.bookmark, tx);
        }
    }
}

pub(crate) fn reconnecting(s: &mut State) {
    if let Some(reader) = &mut s.reader {
        reader.reconnecting(s.transcript_display.reading_mut(), s.paging);
    }

    s.paging = false;
}

pub(crate) fn invalidate(s: &mut State) {
    *s.transcript_display.reading_mut() = Reading::default();
    if let Some(reader) = &mut s.reader {
        reader.bookmark = Bookmark::Latest;
        if !reader.hidden {
            reader.resume(Bookmark::Latest);
        }
    }
}

pub(crate) fn suspend(s: &mut State) {
    if let Some(reader) = &mut s.reader {
        reader.bookmark = reader.bookmark(s.transcript_display.reading_mut());
        reader.stop_content();
        if reader.running() == Some(false) && s.phase == crate::Phase::Streaming {
            s.phase = crate::Phase::Ready;
        }
        s.paging = false;
        s.transcript_display.evict_rendered();
    }
}

pub(crate) fn resume(s: &mut State, tx: &mut Tx) {
    if let Some(reader) = &mut s.reader {
        if reader.hidden {
            reader.resume(reader.bookmark.clone());
        }
    } else {
        tx.scroll_to_bottom_instant("history");
    }
}

pub(crate) fn latest(s: &mut State, tx: &mut Tx) {
    let covered = crate::files::has_preview(s) || crate::git::has_preview(s);
    if let Some(reader) = &mut s.reader
        && (reader.needs_latest() || s.history_error)
    {
        reader.resume(Bookmark::Latest);
        s.history_error = false;
        s.paging = false;
        tx.instant();
    } else if covered && let Some(reader) = &mut s.reader {
        reader.bookmark = Bookmark::Latest;
        reader.pending_scroll = true;
    } else {
        Reading::restore(&Bookmark::Latest, tx);
    }
}

pub(crate) fn retry(s: &mut State, tx: &mut Tx) {
    if let Some(reader) = &mut s.reader
        && reader.can_retry()
    {
        if !reader.resume_pending {
            reader.bookmark = s.transcript_display.reading_mut().bookmark(reader.gap);
        }
        reader.resume(reader.bookmark.clone());
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
}
