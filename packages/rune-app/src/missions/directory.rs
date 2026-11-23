use super::{
    detail::{Detail, read_window},
    observation::Observation,
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{Cleanup, DirectoryChanged, DirectoryPage, DirectoryRows, Summary, Window},
};
use rune::edit::TextEdit;
use std::collections::HashSet;

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
    seen: HashSet<(String, Option<String>)>,
}

struct Completion {
    kind: Kind,
    read: Read,
    serial: u64,
    page: Result<DirectoryPage>,
}

pub(crate) struct Panel {
    pub(super) backend: Backend,
    reads: Reads,
    pub(super) wake: Wake,
    out: Sender<Completion>,
    incoming: Receiver<Completion>,
    project: Option<String>,
    serial: u64,
    visible: bool,
    refresh_due: Option<f64>,
    last_passive: Option<f64>,
    now: f64,
    pub(super) scope: std::rc::Rc<()>,
    supported: Option<bool>,
    capability: Option<Receiver<Option<bool>>>,
    probe_attempted: bool,
    lanes: [Lane; 2],
    pub(super) summaries: Vec<Summary>,
    pub(super) cleanups: Vec<Cleanup>,
    pub(super) filter: TextEdit,
    pub(crate) selected: Option<String>,
    pub(super) detail: Detail,
    pub(super) observation: Observation,
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
            refresh_due: None,
            last_passive: None,
            now: 0.0,
            scope: std::rc::Rc::new(()),
            supported: None,
            capability: None,
            probe_attempted: false,
            lanes: Default::default(),
            summaries: vec![],
            cleanups: vec![],
            filter: TextEdit::new(""),
            selected: None,
            detail: Detail::default(),
            observation: Observation::default(),
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
            self.refresh_due = None;
            self.detail.cancel();
            self.observation.cancel();
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
            self.detail.refresh();
            self.observation.refresh();
            for kind in KINDS {
                if self.busy(kind) {
                    self.lanes[kind as usize].owed = true;
                } else {
                    self.start(kind, Read::Refresh);
                }
            }
        }
    }

    pub(crate) fn invalidate(&mut self, change: Option<(&str, u64)>, now: f64) {
        if let Some((id, revision)) = change {
            if self.selected.as_deref() == Some(id) {
                self.detail.observe(id, revision);
                self.observation.observe(revision);
            }
        } else {
            // A reconnect retires publication authority while keeping the display.
            self.detail.cancel();
            self.observation.cancel();
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
            }
        }
        if self.visible && self.refresh_due.is_none() {
            self.refresh_due = Some(self.last_passive.map_or(now, |last| now.max(last + 1.5)));
            (self.wake)();
        }
    }

    pub(crate) fn refresh_when_due(&mut self, now: f64, tx: &mut rune::Tx) {
        self.now = now;
        self.observation.schedule(now, tx);
        if let Some(due) = self.refresh_due {
            if due > now {
                tx.wake_at(due);
            } else {
                self.refresh_due = None;
                self.last_passive = Some(now);
                self.refresh();
            }
        }
    }

    pub(crate) fn activity_changed(&mut self, now: f64) {
        if self.visible && self.selected.is_some() {
            self.observation.invalidate(now);
            (self.wake)();
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

    pub(crate) fn matches(&self, backend: &Backend) -> bool {
        self.backend.workspace == backend.workspace
            && self.backend.base == backend.base
            && self.backend.client.same_connection(&backend.client)
    }

    pub(crate) fn supported(&self) -> bool {
        self.supported == Some(true)
    }

    pub(crate) fn probe(&mut self) {
        if self.supported.is_some() || self.probe_attempted {
            return;
        }
        self.probe_attempted = true;
        let backend = self.backend.clone();
        let (out, incoming) = bounded(1);
        self.capability = Some(incoming);
        let wake = self.wake.clone();
        let reads = self.reads.clone();
        platform::spawn(async move {
            let query = async || {
                let (_cancel, cancelled) = bounded(1);
                let _permit = reads.background(&cancelled).await?;
                let response = backend
                    .client
                    .get(format!("{}api/meta", backend.base))
                    .send()
                    .await
                    .ok()?
                    .error_for_status()
                    .ok()?;
                let value = codenomad_client::backend::read_json(response).await.ok()?;
                Some(
                    value["capabilities"]
                        .as_array()?
                        .iter()
                        .any(|value| value == "missions"),
                )
            };
            let check = async {
                // Like Solid, give the failed initial metadata flight one recovery read.
                match query().await {
                    None => query().await,
                    result => result,
                }
            };
            if let Some(supported) = codenomad_client::runtime::until_closed(&out, check).await
                && out.send(supported).await.is_ok()
            {
                wake();
            }
        });
    }

    pub(crate) fn cancel_probe(&mut self) {
        self.capability = None;
        self.probe_attempted = false;
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

    pub(super) fn covered(&self, kind: Kind) -> bool {
        self.loaded(kind) && !self.has_more(kind) && !self.failed(kind) && !self.busy(kind)
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
        if let Some(supported) = self.capability.as_ref().and_then(|r| r.try_recv().ok()) {
            self.capability = None;
            self.supported = supported;
            changed = self.supported();
        }
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
            let keep_failed_more = done.read == Read::Refresh && lane.failed == Some(Read::More);
            let order = keep_failed_more
                .then(|| lane.window.as_ref().map(|w| w.order.clone()))
                .flatten();
            let outcome = done
                .page
                .map(|page| self.accept(done.kind, done.read, page));
            match outcome {
                Ok(true) => {
                    let lane = &mut self.lanes[done.kind as usize];
                    lane.failed = order.map(|order| {
                        if lane
                            .window
                            .as_ref()
                            .is_some_and(|window| window.order == order)
                        {
                            Read::More
                        } else {
                            Read::Refresh
                        }
                    });
                    if owed {
                        self.start(done.kind, Read::Refresh);
                    }
                }
                Err(error) if error.is::<DirectoryChanged>() => {
                    self.lanes[done.kind as usize].failed = Some(Read::Refresh);
                }
                _ => self.lanes[done.kind as usize].failed = Some(done.read),
            }
        }
        if self.visible
            && let (Some(project), Some(id)) = (&self.project, &self.selected)
        {
            let revision = self
                .summaries
                .iter()
                .find(|row| row.id == *id)
                .map(|row| row.revision);
            let floor = self.detail.revision_floor(id, revision);
            changed |= self.observation.settle(floor, self.now, &self.wake);
            changed |= self.detail.poll(
                &self.backend,
                project,
                id,
                revision.max(self.observation.revision()),
                &self.reads,
                &self.wake,
            );
            if let Some(snapshot) = &self.detail.snapshot {
                changed |= self.observation.poll(
                    &self.backend,
                    project,
                    id,
                    snapshot.header.root.revision,
                    &self.reads,
                    &self.wake,
                );
            }
        } else if self.selected.is_none() {
            self.detail.clear();
            self.observation = Observation::default();
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
                if !merge(&mut self.summaries, lane, read, &page.window, rows, |row| {
                    (row.id.clone(), None)
                }) {
                    return false;
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
                if rows.iter().any(|row| {
                    self.cleanups.iter().any(|old| {
                        old.mission_id == row.mission_id
                            && old.deletion_id == row.deletion_id
                            && (old.request_id != row.request_id
                                || old.expected_revision != row.expected_revision
                                || old.delete_managed_sessions != row.delete_managed_sessions)
                    })
                }) || !merge(&mut self.cleanups, lane, read, &page.window, rows, |row| {
                    (row.mission_id.clone(), Some(row.deletion_id.clone()))
                }) {
                    return false;
                }
            }
            _ => return false,
        }
        self.project = Some(page.project_id);
        lane.window = Some(page.window);
        true
    }

    pub(super) fn select(&mut self, id: &str) {
        if self.selected.as_deref() != Some(id) && self.summaries.iter().any(|row| row.id == id) {
            self.detail.clear();
            self.observation = Observation::default();
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

impl Drop for Panel {
    fn drop(&mut self) {
        self.show(false);
    }
}

fn merge<T>(
    display: &mut Vec<T>,
    lane: &mut Lane,
    read: Read,
    window: &Window,
    rows: Vec<T>,
    key: impl Fn(&T) -> (String, Option<String>),
) -> bool {
    if read == Read::Refresh {
        lane.seen.clear();
    } else if rows.iter().any(|row| lane.seen.contains(&key(row))) {
        return false;
    }
    // Current-order rows are a prefix; keep the previous snapshot's unvisited rows after it.
    let previous = std::mem::take(display);
    let prefix = lane.seen.len();
    lane.seen.extend(rows.iter().map(&key));
    let mut previous = previous.into_iter();
    display.extend(previous.by_ref().take(prefix));
    display.extend(rows);
    if window.end != window.total {
        display.extend(previous.filter(|row| !lane.seen.contains(&key(row))));
    }
    true
}

#[cfg(test)]
mod tests;
