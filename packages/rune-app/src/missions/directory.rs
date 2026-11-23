use crate::platform::{
    self,
    reads::{self, Reads},
};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{Cleanup, DirectoryPage, DirectoryRead, DirectoryRows, Summary, Window},
};
use rune::edit::TextEdit;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Summaries,
    Cleanups,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Refresh,
    More,
}

#[derive(Default)]
struct Lane {
    active: Option<(u64, Sender<()>)>,
    window: Option<Window>,
    failed: Option<Read>,
    owed: bool,
}

struct Completion {
    kind: Kind,
    read: Read,
    serial: u64,
    page: Result<DirectoryPage>,
}

pub(crate) struct Panel {
    backend: Backend,
    reads: Reads,
    wake: Wake,
    out: Sender<Completion>,
    incoming: Receiver<Completion>,
    project: Option<String>,
    serial: u64,
    visible: bool,
    lanes: [Lane; 2],
    pub(super) summaries: Vec<Summary>,
    pub(super) cleanups: Vec<Cleanup>,
    pub(super) filter: TextEdit,
    pub(super) selected: Option<String>,
}

const KINDS: [Kind; 2] = [Kind::Summaries, Kind::Cleanups];

impl Panel {
    pub(crate) fn new(backend: Backend, project: Option<String>, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(4);
        Self {
            backend,
            project,
            reads,
            wake,
            out,
            incoming,
            serial: 0,
            visible: false,
            lanes: Default::default(),
            summaries: vec![],
            cleanups: vec![],
            filter: TextEdit::new(""),
            selected: None,
        }
    }

    pub(crate) fn show(&mut self, show: bool) {
        if self.visible == show {
            return;
        }
        self.visible = show;
        if show {
            self.refresh();
        } else {
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
                lane.owed = false;
            }
        }
    }

    pub(super) fn refresh(&mut self) {
        if self.visible {
            for kind in KINDS {
                if self.busy(kind) {
                    self.lanes[kind as usize].owed = true;
                } else {
                    self.start(kind, Read::Refresh);
                }
            }
        }
    }

    pub(super) fn more(&mut self, kind: Kind) {
        let lane = &self.lanes[kind as usize];
        if let Some(read) = lane.failed {
            self.start(kind, read);
        } else if self.has_more(kind) {
            self.start(kind, Read::More);
        }
    }

    pub(super) fn busy(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].active.is_some()
    }

    pub(super) fn failed(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].failed.is_some()
    }

    pub(super) fn loaded(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].window.is_some()
    }

    pub(super) fn has_more(&self, kind: Kind) -> bool {
        self.lanes[kind as usize]
            .window
            .as_ref()
            .is_some_and(|w| w.end < w.total)
    }

    fn start(&mut self, kind: Kind, read: Read) {
        if !self.visible || self.busy(kind) {
            return;
        }
        let lane = &mut self.lanes[kind as usize];
        let (offset, order) = match (read, &lane.window) {
            (Read::Refresh, _) => (0, None),
            (Read::More, Some(window)) if window.end < window.total => {
                (window.end, Some(window.order.as_str()))
            }
            _ => return,
        };
        let project = self.project.as_deref();
        let opened = match kind {
            Kind::Summaries => {
                self.backend
                    .mission_summaries(project, offset, order, lane.window.is_none())
            }
            Kind::Cleanups => self.backend.mission_cleanups(project, offset, order),
        };
        let Ok(opened) = opened else {
            lane.failed = Some(read);
            return;
        };
        self.serial = self.serial.wrapping_add(1);
        let serial = self.serial;
        let (cancel, cancelled) = bounded(1);
        lane.active = Some((serial, cancel));
        lane.failed = None;
        let reads = self.reads.clone();
        let out = self.out.clone();
        let wake = self.wake.clone();
        platform::spawn(async move {
            if let Some(page) = read_window(opened, &reads, &cancelled).await
                && out
                    .send(Completion {
                        kind,
                        read,
                        serial,
                        page,
                    })
                    .await
                    .is_ok()
            {
                wake();
            }
        });
    }

    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(done) = self.incoming.try_recv() {
            let lane = &mut self.lanes[done.kind as usize];
            if lane
                .active
                .as_ref()
                .is_none_or(|(serial, _)| *serial != done.serial)
            {
                continue;
            }
            lane.active = None;
            changed = true;
            let owed = std::mem::take(&mut lane.owed);
            if !done
                .page
                .is_ok_and(|page| self.accept(done.kind, done.read, page))
            {
                self.lanes[done.kind as usize].failed = Some(done.read);
            } else if owed {
                self.start(done.kind, Read::Refresh);
            }
        }
        changed
    }

    fn accept(&mut self, kind: Kind, read: Read, page: DirectoryPage) -> bool {
        if self
            .project
            .as_ref()
            .is_some_and(|project| project != &page.project_id)
        {
            return false;
        }
        let lane = &mut self.lanes[kind as usize];
        if read == Read::More
            && lane.window.as_ref().is_none_or(|w| {
                page.window.order != w.order
                    || page.window.offset != w.end
                    || page.window.total != w.total
            })
        {
            return false;
        }
        if read == Read::Refresh
            && lane.window.as_ref().is_some_and(|w| {
                w.order == page.window.order
                    && w.total == page.window.total
                    && w.end > page.window.end
            })
        {
            return true;
        }
        match (kind, page.rows) {
            (Kind::Summaries, DirectoryRows::Summaries(rows)) => {
                if read == Read::Refresh {
                    self.summaries = rows;
                } else {
                    if rows
                        .iter()
                        .any(|row| self.summaries.iter().any(|old| old.id == row.id))
                    {
                        return false;
                    }
                    self.summaries.extend(rows);
                }
                // A page that does not cover the directory cannot prove a selection is gone.
                if page.window.end == page.window.total
                    && self
                        .selected
                        .as_ref()
                        .is_some_and(|id| !self.summaries.iter().any(|row| &row.id == id))
                {
                    self.selected = None;
                }
            }
            (Kind::Cleanups, DirectoryRows::Cleanups(rows)) => {
                if read == Read::Refresh {
                    self.cleanups = rows;
                } else {
                    if rows.iter().any(|row| {
                        self.cleanups.iter().any(|old| {
                            old.mission_id == row.mission_id && old.deletion_id == row.deletion_id
                        })
                    }) {
                        return false;
                    }
                    self.cleanups.extend(rows);
                }
            }
            _ => return false,
        }
        self.project = Some(page.project_id);
        lane.window = Some(page.window);
        true
    }

    pub(super) fn select(&mut self, id: &str) {
        if self.summaries.iter().any(|row| row.id == id) {
            self.selected = Some(id.into());
        }
    }

    pub(super) fn shown_rows(&self) -> impl Iterator<Item = &Summary> {
        let filter = self.filter.text.trim().to_lowercase();
        self.summaries.iter().filter(move |row| {
            self.selected.as_deref() == Some(&row.id)
                || filter.is_empty()
                || title(row).to_lowercase().contains(&filter)
        })
    }
}

pub(super) fn title(row: &Summary) -> &str {
    row.title
        .as_deref()
        .filter(|text| !text.is_empty())
        .unwrap_or(&row.objective)
}

async fn read_window(
    mut read: DirectoryRead,
    reads: &Reads,
    cancelled: &Receiver<()>,
) -> Option<Result<DirectoryPage>> {
    loop {
        let permit = reads.background(cancelled).await?;
        let result = reads::cancellable(cancelled, read.read_next()).await?;
        drop(permit);
        match result {
            Ok(None) => {}
            Ok(Some(page)) => return Some(Ok(page)),
            Err(error) => return Some(Err(error)),
        }
    }
}

#[cfg(test)]
mod tests;
