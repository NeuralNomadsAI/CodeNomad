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
        self.hidden || self.resume_pending || self.gap || self.parked
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

    fn resume(&mut self, current: Bookmark) {
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

    pub(crate) fn renderer_ready(&mut self, tx: &mut Tx) {
        if std::mem::take(&mut self.pending_scroll) {
            Reading::restore(&self.bookmark, tx);
        }
    }
}

pub(crate) fn suspend(s: &mut State, _tx: &mut Tx) {
    if let Some(reader) = &mut s.reader {
        if !reader.resume_pending && !reader.hidden {
            reader.bookmark = s.transcript_display.reading_mut().bookmark(reader.gap);
        }
        reader.stop_content();
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
    if let Some(reader) = &mut s.reader
        && (reader.needs_latest() || s.history_error)
    {
        reader.resume(Bookmark::Latest);
        s.history_error = false;
        s.paging = false;
        tx.instant();
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
                }),
            ))
            .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.phase == Phase::Ready);
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
        state.phase = Phase::Ready;
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
