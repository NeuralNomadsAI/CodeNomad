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

pub(crate) struct Reader {
    request: Demand,
    events: Receiver<(u64, Event)>,
    generation: u64,
    bookmark: Bookmark,
    hidden: bool,
    resume_pending: bool,
    pending_scroll: bool,
    gap: bool,
}

impl Reader {
    pub(super) fn open() -> (Self, ReadingLane) {
        let (request, demand) = demand::open();
        let (out, events) = bounded(8);
        (
            Self {
                request,
                events,
                generation: 0,
                bookmark: Bookmark::Latest,
                hidden: false,
                resume_pending: false,
                pending_scroll: false,
                gap: false,
            },
            ReadingLane {
                demand,
                events: out,
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
        while let Ok((generation, event)) = self.events.try_recv() {
            if !self.hidden && generation == self.generation {
                return Some(event);
            }
        }
        None
    }

    pub(crate) fn blocks_send(&self) -> bool {
        self.hidden || self.resume_pending || self.gap
    }

    pub(crate) fn needs_latest(&self) -> bool {
        self.gap || self.resume_pending
    }

    pub(crate) fn independent_status(&self) -> bool {
        self.hidden || self.gap || self.resume_pending
    }

    fn resume(&mut self, current: Bookmark) {
        let target = match &current {
            Bookmark::Latest => Target::Latest,
            Bookmark::Message { id, .. } => Target::Around(id.clone()),
        };
        self.hidden = false;
        self.resume_pending = true;
        self.pending_scroll = false;
        self.bookmark = current;
        self.generation = self.request.publish(Some(target));
    }

    pub(crate) fn install(&mut self, gap: bool) {
        self.gap = gap;
        self.pending_scroll |= self.resume_pending;
        self.resume_pending = false;
    }

    pub(crate) fn renderer_ready(&mut self, tx: &mut Tx) {
        if std::mem::take(&mut self.pending_scroll) {
            Reading::restore(&self.bookmark, tx);
        }
    }
}

pub(crate) fn suspend(s: &mut State, _tx: &mut Tx) {
    if let Some(reader) = &mut s.reader {
        reader.bookmark = s.transcript_display.reading_mut().bookmark();
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
