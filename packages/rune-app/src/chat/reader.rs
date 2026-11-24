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

pub(crate) struct Reader {
    request: Demand,
    events: Receiver<(u64, u64, Event)>,
    connection: Arc<AtomicU64>,
    revoked: Arc<AtomicBool>,
    generation: u64,
    bookmark: Bookmark,
    installed: bool,
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
        let revoked = Arc::new(AtomicBool::new(false));
        (
            Self {
                request,
                events,
                connection: connection.clone(),
                revoked: revoked.clone(),
                generation: 0,
                bookmark: Bookmark::Latest,
                installed: false,
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
                revoked,
            },
        )
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn revoke(&self) {
        self.revoked.store(true, SeqCst);
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
        self.installed = true;
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

    fn reconnecting(&mut self, reading: &Reading, paging: bool) {
        self.activity = None;
        self.settling = false;
        if !self.hidden && (self.resume_pending || (paging && !self.has_visible_window())) {
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

    cancel_page(s);
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

pub(super) fn refresh_after_message_action(s: &mut State) {
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
        reader.resume(bookmark);
    } else {
        reader.bookmark = bookmark;
    }
}

pub(crate) fn reconcile_bookmark(s: &mut State, rows: &[crate::history::Row]) {
    if let Some(reader) = &mut s.reader
        && reader.resume_pending
        && let Bookmark::Message { id, .. } = &reader.bookmark
        && !rows.iter().any(|row| &row.id == id)
    {
        reader.bookmark = Bookmark::Latest;
    }
}

pub(crate) fn suspend(s: &mut State) {
    cancel_page(s);
    crate::timeline::suspend(s);
    crate::settings::transcript_filters::close(s);
    if let Some(reader) = &mut s.reader {
        reader.bookmark = reader.bookmark(s.transcript_display.reading_mut());
        reader.stop_content();
        if reader.running() == Some(false) && s.phase == crate::Phase::Streaming {
            s.phase = crate::Phase::Ready;
        }
        s.paging = false;
    }
    s.transcript_display.suspend_rendered();
}

pub(crate) fn resume(s: &mut State, tx: &mut Tx) {
    if let Some(reader) = &mut s.reader {
        if reader.hidden {
            reader.resume(reader.bookmark.clone());
        }
    } else {
        Reading::restore(&Bookmark::Latest, tx);
    }
}

pub(crate) fn latest(s: &mut State, tx: &mut Tx) {
    cancel_page(s);
    crate::timeline::cancel_jump(s);
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
mod tests;

mod pages;
pub(super) use pages::install_page;
pub(crate) use pages::{
    admit_page, announce_paging, cancel_page, install_anchor, older, oldest, request_page,
    set_timeline_position,
};
