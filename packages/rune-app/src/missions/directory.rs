use super::{
    detail::{Detail, read_window},
    observation::Observation,
    reader::Reader,
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
    pub(super) reads: Reads,
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
    pub(super) control_fields: super::control_fields::Fields,
    pub(super) observation: Observation,
    pub(super) reader: Reader,
    pub(super) calendars: super::calendars::Calendars,
    reader_suspended: bool,
}

const KINDS: [Kind; 2] = [Kind::Summaries, Kind::Cleanups];

impl Panel {
    pub(crate) fn is_composing(&self) -> bool {
        self.filter.is_composing() || self.calendars.is_composing()
    }

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
            control_fields: Default::default(),
            observation: Observation::default(),
            reader: Reader::default(),
            calendars: super::calendars::Calendars::default(),
            reader_suspended: false,
        }
    }

    pub(super) fn wake(&self) {
        (self.wake)();
    }

    pub(crate) fn same_workspace(&self, backend: &Backend) -> bool {
        self.backend.base == backend.base && self.backend.workspace == backend.workspace
    }

    /// Rebinds the authenticated HTTP client after sign-in while preserving the selected Mission
    /// and any open Mission reader so the user returns to their reading state and revalidates it.
    pub(crate) fn rebind(&mut self, backend: Backend) {
        self.backend = backend;
        self.cancel_probe();
        for lane in &mut self.lanes {
            if let Some((_, cancel)) = lane.active.take() {
                cancel.close();
            }
            lane.owed = false;
        }
        self.control_fields.cancel();
        self.observation.cancel();
        self.detail.cancel();
        self.detail.clear_lookup_cache();
        self.reader.invalidate();
        self.calendars.reset_for_rebind();
        if self.visible || self.reader.is_open() {
            self.refresh();
        }
        (self.wake)();
    }

    pub(crate) fn has_reader(&self) -> bool {
        self.reader.is_open()
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        self.evictable_inactive_bytes()
            .saturating_add(self.summaries.len().saturating_mul(256))
            .saturating_add(self.cleanups.len().saturating_mul(128))
            .saturating_add(self.calendars.retained_bytes())
    }

    pub(crate) fn evictable_inactive_bytes(&self) -> usize {
        self.reader
            .retained_bytes()
            .saturating_add(self.detail.retained_bytes())
    }

    pub(crate) fn evict_inactive_caches(&mut self) -> usize {
        self.reader
            .evict_cache()
            .saturating_add(self.detail.evict_snapshot())
    }

    pub(crate) fn evict_closed_reader_cache(&mut self) -> usize {
        if self.reader.is_open() {
            0
        } else {
            self.reader.evict_cache()
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture_cache_body(&mut self, mission_id: &str, text: String) {
        self.reader.fixture_cache_body(mission_id, text);
    }

    #[cfg(test)]
    pub(crate) fn fixture_add_summaries(&mut self, count: usize) {
        for index in 0..count {
            self.summaries.push(Summary {
                id: format!("mission-{index}"),
                title: Some(format!("Mission {index}")),
                objective: "Fixture".into(),
                status: codenomad_client::missions::Status::Active,
                run_state: None,
                coordinator_session_id: "ses_fixture".into(),
                actor_count: 1,
                updated_at: 0.0,
                revision: 0,
                finish_sequence: None,
                task_count: None,
            });
        }
    }

    pub(crate) fn close_reader(&mut self) -> Option<String> {
        let back = self.reader.take_return_focus();
        self.reader.close();
        self.detail.cancel_lookup();
        self.reader_suspended = false;
        if !self.visible {
            self.refresh_due = None;
            self.detail.cancel();
        }
        back
    }

    pub(crate) fn suspend(&mut self) {
        self.reader_suspended = self.reader.is_open();
        self.show(false);
        self.refresh_due = None;
        self.detail.cancel();
        self.reader.suspend();
        self.calendars.cancel();
        self.cancel_probe();
    }

    pub(crate) fn take_reader_auth_expired(&mut self) -> Option<Backend> {
        self.reader
            .take_auth_expired()
            .or_else(|| self.detail.take_auth_expired())
            .or_else(|| self.calendars.take_auth_expired())
    }

    #[cfg(test)]
    pub(crate) fn fixture_ready_with_lookup(
        &mut self,
        header: codenomad_client::missions::MapHeader,
        task_id: &str,
        task_key: &str,
    ) {
        self.supported = Some(true);
        self.probe_attempted = true;
        self.visible = true;
        self.project = Some(header.root.project_id().to_owned());
        self.selected = Some(header.root.id.clone());
        self.detail
            .fixture_snapshot_and_lookup(header, task_id.to_owned(), task_key.to_owned());
    }

    pub(crate) fn take_reader_copy(&mut self) -> Option<String> {
        self.reader.take_ready_copy()
    }

    pub(crate) fn take_reader_focus_close(&mut self) -> bool {
        self.reader.take_focus_close()
    }

    pub(super) fn toggle_overview(&mut self, id: &str) -> bool {
        if self.reader.is_overview_open(id) {
            self.reader.close();
            self.detail.cancel_lookup();
            false
        } else {
            if self.selected.as_deref() != Some(id) {
                self.select(id);
            }
            self.reader.open_overview(id.to_owned());
            (self.wake)();
            true
        }
    }

    pub(super) fn toggle_task(&mut self, mission_id: &str, task_id: &str, task_key: &str) -> bool {
        if self.reader.is_task_open(mission_id, task_id) {
            self.reader.close();
            self.detail.cancel_lookup();
            false
        } else {
            if self.selected.as_deref() != Some(mission_id) {
                self.select(mission_id);
            }
            self.reader.open_task(
                mission_id.to_owned(),
                task_id.to_owned(),
                task_key.to_owned(),
            );
            (self.wake)();
            true
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
            if !self.reader.is_open() {
                self.refresh_due = None;
                self.detail.cancel();
            }
            self.control_fields.cancel();
            self.observation.cancel();
            self.calendars.cancel();
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
            self.calendars
                .refresh(&self.backend, &self.reads, &self.wake);
            for kind in KINDS {
                if self.busy(kind) {
                    self.lanes[kind as usize].owed = true;
                } else {
                    self.start(kind, Read::Refresh);
                }
            }
        } else if self.reader.is_open() {
            self.detail.refresh();
        }
    }

    pub(super) fn refresh_calendars(&mut self) {
        self.calendars
            .retry_refresh(&self.backend, &self.reads, &self.wake);
    }

    pub(super) fn toggle_calendar_pause(&mut self, id: &str) {
        self.calendars.toggle_pause(id, &self.backend, &self.wake);
    }

    pub(super) fn save_calendar_editor(&mut self) {
        self.calendars.save_editor(&self.backend, &self.wake);
    }

    pub(crate) fn confirm_calendar_delete(&mut self, accept: bool) {
        self.calendars
            .confirm_delete(accept, &self.backend, &self.wake);
    }

    pub(crate) fn invalidate(&mut self, change: Option<(&str, u64)>, now: f64) {
        if let Some((id, revision)) = change {
            if self.selected.as_deref() == Some(id)
                || self.reader.target().is_some_and(|t| t.mission_id() == id)
            {
                self.detail.observe(id, revision);
            }
            if self.selected.as_deref() == Some(id) {
                self.observation.observe(revision);
            }
        } else {
            // A reconnect retires publication authority while keeping the display.
            self.detail.cancel();
            self.observation.cancel();
            self.calendars.on_reconnect();
            self.reader.invalidate();
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
            }
        }
        if (self.visible || self.reader.is_open()) && self.refresh_due.is_none() {
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
        if self.reader_suspended && self.reader.is_open() {
            self.reader_suspended = false;
            self.detail.refresh();
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
        } else if self.reader.is_open()
            && let Some(project) = self
                .project
                .as_deref()
                .or_else(|| {
                    self.detail
                        .snapshot
                        .as_ref()
                        .map(|s| s.header.root.project_id())
                })
                .map(str::to_owned)
            && let Some(target_id) = self.reader.target().map(|t| t.mission_id().to_owned())
        {
            let revision = self
                .summaries
                .iter()
                .find(|row| row.id == target_id)
                .map(|row| row.revision);
            let floor = self.detail.revision_floor(&target_id, revision);
            changed |= self.detail.poll(
                &self.backend,
                &project,
                &target_id,
                floor,
                &self.reads,
                &self.wake,
            );
        } else if self.selected.is_none() {
            self.detail.clear();
            self.observation = Observation::default();
            self.reader.follow_selection(None);
        }
        // Resolve or dispatch pending off-page task lookups AFTER detail.poll() so a lookup queued
        // behind Refresh/More/Attention starts in the same cycle once detail settles.
        let mut started_lookup = false;
        if let Some((mid, tkey)) = self
            .reader
            .pending_lookup()
            .map(|(m, k)| (m.to_owned(), k.to_owned()))
            && let Some((found, exhausted)) = self
                .detail
                .snapshot
                .as_ref()
                .filter(|s| s.header.root.id == mid)
                .map(|s| {
                    (
                        s.tasks
                            .find_by_key(&tkey)
                            .map(|t| (t.id.clone(), t.key.clone())),
                        s.tasks.len() >= s.header.tasks.page.total,
                    )
                })
        {
            if let Some((tid, key)) = found {
                self.reader.resolve_lookup(mid, tid, key);
                changed = true;
            } else if self.detail.take_lookup_failed("", &tkey) {
                self.reader.fail_lookup_error(tkey);
                changed = true;
            } else if exhausted || self.detail.lookup_settled("", &tkey) {
                self.reader.fail_lookup(tkey);
                changed = true;
            } else if !self.detail.busy() {
                self.detail.lookup_task(None, Some(&tkey));
                started_lookup = true;
            }
        }
        if let Some(super::reader::ReaderTarget::Task {
            mission_id,
            task_id,
            task_key,
        }) = self.reader.target().cloned()
            && let Some((found, has_more)) = self
                .detail
                .snapshot
                .as_ref()
                .filter(|s| s.header.root.id == mission_id)
                .map(|s| {
                    (
                        s.tasks
                            .find_by_id_or_key(&task_id, &task_key)
                            .map(|t| (t.id.clone(), t.key.clone())),
                        s.tasks.len() < s.header.tasks.page.total,
                    )
                })
        {
            if let Some((id, key)) = found {
                self.reader.bind_task_identity(&mission_id, &id, &key);
                self.reader.clear_lookup_error();
            } else if self.detail.take_lookup_failed(&task_id, &task_key) {
                self.reader.fail_lookup_error(task_key);
                changed = true;
            } else if !self.detail.busy()
                && self.reader.lookup_failed().is_none()
                && !self.detail.lookup_settled(&task_id, &task_key)
                && has_more
            {
                self.detail.lookup_task(
                    (!task_id.is_empty()).then_some(task_id.as_str()),
                    (!task_key.is_empty()).then_some(task_key.as_str()),
                );
                started_lookup = true;
            }
        }
        if started_lookup
            && let Some(snapshot) = &self.detail.snapshot
            && let Some(project) = self
                .project
                .as_deref()
                .or(Some(snapshot.header.root.project_id()))
                .map(str::to_owned)
        {
            let target_id = snapshot.header.root.id.clone();
            changed |= self.detail.poll(
                &self.backend,
                &project,
                &target_id,
                None,
                &self.reads,
                &self.wake,
            );
        }
        let reader_project = self.project.as_deref().or_else(|| {
            self.detail
                .snapshot
                .as_ref()
                .map(|s| s.header.root.project_id())
        });
        changed |= self.reader.poll(
            &self.backend,
            reader_project,
            self.detail.snapshot.as_ref(),
            &self.reads,
            &self.wake,
        );
        let (cal_changed, cal_mutated) =
            self.calendars.poll(&self.backend, &self.reads, &self.wake);
        changed |= cal_changed;
        if cal_mutated && self.visible {
            for kind in KINDS {
                if self.busy(kind) {
                    self.lanes[kind as usize].owed = true;
                } else {
                    self.start(kind, Read::Refresh);
                }
            }
        }
        changed | self.poll_control_fields()
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
                    self.reader.follow_selection(None);
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
            self.control_fields.cancel();
            self.detail.clear();
            self.observation = Observation::default();
            self.selected = Some(id.into());
            self.reader.follow_selection(Some(id));
        }
    }

    pub(crate) fn has_eye_trigger(&self, key: &str) -> bool {
        if let Some(mission_id) = key.strip_prefix("mission-row-eye-") {
            self.shown_rows().any(|row| row.id == mission_id)
        } else if let Some(task_id) = key.strip_prefix("mission-task-eye-") {
            self.detail
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.tasks.find_by_id_or_key(task_id, "").is_some())
        } else {
            false
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
        self.suspend();
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
