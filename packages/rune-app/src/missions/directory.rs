mod cleanups;
mod merge;
#[cfg(test)]
mod test_helpers;

use super::{
    cleanup::LiveFlag,
    detail::{Detail, read_window},
    observation::Observation,
};
use crate::platform::{self, reads::Reads};
#[cfg(test)]
use codenomad_client::missions::DirectoryRows;
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{Cleanup, DirectoryAuthExpired, DirectoryChanged, DirectoryPage, Summary, Window},
};
use rune::edit::TextEdit;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Summaries,
    Cleanups,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Refresh,
    ManualRefresh,
    More,
}

impl Read {
    fn is_refresh(self) -> bool {
        !matches!(self, Self::More)
    }
}

#[derive(Default)]
struct Lane {
    active: Option<(u64, Sender<()>)>,
    window: Option<Window>,
    failed: Option<Read>,
    owed: bool,
    owed_manual: bool,
    seen: HashSet<(String, Option<String>)>,
    seen_order: VecDeque<(String, Option<String>)>,
    tail_pos: HashMap<(String, Option<String>), usize>,
    tail_pinned_len: usize,
    prefix_len: usize,
    #[cfg(test)]
    tail_visits: usize,
}

struct Completion {
    kind: Kind,
    read: Read,
    serial: u64,
    page: Result<DirectoryPage>,
}

pub(super) type CleanupIdentity = (String, String, String, u64, bool, u64);

pub(super) fn cleanup_identity(row: &Cleanup) -> CleanupIdentity {
    (
        row.mission_id.clone(),
        row.deletion_id.clone(),
        row.request_id.clone(),
        row.expected_revision,
        row.delete_managed_sessions,
        row.created_at.to_bits(),
    )
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
    online: bool,
    refresh_due: Option<f64>,
    last_passive: Option<f64>,
    now: f64,
    pub(super) scope: std::rc::Rc<()>,
    pub(super) view_live: LiveFlag,
    pub(super) mounted_view_live: LiveFlag,
    pub(super) selection_live: LiveFlag,
    pub(super) mounted_selection_live: LiveFlag,
    pub(super) cleanup_view_live: LiveFlag,
    cleanup_tokens: HashMap<(String, String), LiveFlag>,
    remembered_document_pending: HashSet<CleanupIdentity>,
    remembered_document_order: VecDeque<CleanupIdentity>,
    settled_cleanups: HashMap<CleanupIdentity, Cleanup>,
    settled_cleanup_order: VecDeque<CleanupIdentity>,
    deleted_missions: HashSet<String>,
    deleted_missions_order: VecDeque<String>,
    cleanup_meta: HashMap<(String, String), (String, u64, bool, u64)>,
    pending_cleanup_set: HashSet<(String, String, String, u64, bool, u64)>,
    pending_cleanup_ids: HashSet<(String, String)>,
    dirty_cleanups: Vec<Cleanup>,
    dirty_cleanups_full: bool,
    observed_sync: Option<(u64, u64)>,
    retired_sync: Option<(u64, u64, bool)>,
    cleanups_gen: u64,
    cleanups_rc: std::cell::RefCell<Option<(u64, std::rc::Rc<Vec<Cleanup>>)>>,
    #[cfg(test)]
    pub(super) doc_cache_lookups: usize,
    supported: Option<bool>,
    capability: Option<Receiver<Option<bool>>>,
    probe_attempted: bool,
    auth_expired: Option<Backend>,
    lanes: [Lane; 2],
    pub(super) summaries: Vec<Summary>,
    pub(super) cleanups: Vec<Cleanup>,
    pub(super) filter: TextEdit,
    pub(crate) selected: Option<String>,
    pub(super) detail: Detail,
    pub(super) control_fields: super::control_fields::Fields,
    pub(super) observation: Observation,
}

const KINDS: [Kind; 2] = [Kind::Summaries, Kind::Cleanups];
const CLEANUP_DISPLAY_CAP: usize = 2_000;
const DELETED_MISSIONS_CAP: usize = 256;

impl Panel {
    pub(crate) fn is_composing(&self) -> bool {
        self.filter.is_composing()
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
            online: true,
            refresh_due: None,
            last_passive: None,
            now: 0.0,
            scope: std::rc::Rc::new(()),
            view_live: LiveFlag::new(false),
            mounted_view_live: LiveFlag::new(false),
            selection_live: LiveFlag::new(false),
            mounted_selection_live: LiveFlag::new(false),
            cleanup_view_live: LiveFlag::new(false),
            cleanup_tokens: HashMap::new(),
            remembered_document_pending: HashSet::new(),
            remembered_document_order: VecDeque::new(),
            settled_cleanups: HashMap::new(),
            settled_cleanup_order: VecDeque::new(),
            deleted_missions: HashSet::new(),
            deleted_missions_order: VecDeque::new(),
            cleanup_meta: HashMap::new(),
            pending_cleanup_set: HashSet::new(),
            pending_cleanup_ids: HashSet::new(),
            dirty_cleanups: Vec::new(),
            dirty_cleanups_full: false,
            observed_sync: None,
            retired_sync: None,
            cleanups_gen: 0,
            cleanups_rc: std::cell::RefCell::new(None),
            #[cfg(test)]
            doc_cache_lookups: 0,
            supported: None,
            capability: None,
            probe_attempted: false,
            auth_expired: None,
            lanes: Default::default(),
            summaries: vec![],
            cleanups: vec![],
            filter: TextEdit::new(""),
            selected: None,
            detail: Detail::default(),
            control_fields: Default::default(),
            observation: Observation::default(),
        }
    }

    pub(crate) fn show(&mut self, show: bool) {
        if self.visible == show {
            return;
        }
        self.visible = show;
        self.view_live.revoke();
        self.mounted_view_live.revoke();
        self.selection_live.revoke();
        self.mounted_selection_live.revoke();
        self.cleanup_view_live.revoke();
        self.revoke_all_cleanup_tokens();
        if show {
            self.view_live = LiveFlag::new(self.online);
            self.mounted_view_live = LiveFlag::new(true);
            self.selection_live = LiveFlag::new(self.online);
            self.mounted_selection_live = LiveFlag::new(true);
            self.cleanup_view_live = LiveFlag::new(self.online && !self.cleanups_unavailable());
            self.refresh();
        } else {
            self.refresh_due = None;
            self.detail.cancel();
            self.control_fields.cancel();
            self.observation.cancel();
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
                lane.owed = false;
            }
        }
    }

    pub(crate) fn online(&self) -> bool {
        self.online
    }

    pub(super) fn cleanups_unavailable(&self) -> bool {
        self.lanes[Kind::Cleanups as usize].failed.is_some()
    }

    pub(crate) fn set_online(&mut self, online: bool) {
        if self.online == online {
            return;
        }
        self.online = online;
        self.observation.set_online(online);
        if !online {
            self.view_live.revoke();
            self.selection_live.revoke();
            self.cleanup_view_live.revoke();
            self.revoke_all_cleanup_tokens();
        } else if self.visible {
            if !self.view_live.is_live() {
                self.view_live = LiveFlag::new(true);
            }
            if !self.selection_live.is_live() {
                self.selection_live = LiveFlag::new(true);
            }
            if !self.cleanup_view_live.is_live() && !self.cleanups_unavailable() {
                self.cleanup_view_live = LiveFlag::new(true);
            }
            (self.wake)();
        }
    }

    pub(super) fn cancel_lane(&mut self, kind: Kind) {
        self.serial = self.serial.wrapping_add(1);
        let lane = &mut self.lanes[kind as usize];
        if let Some((_, cancel)) = lane.active.take() {
            cancel.close();
        }
    }

    pub(super) fn forget_deleted_mission(&mut self, mission_id: &str) {
        self.cancel_lane(Kind::Summaries);
        self.remember_deleted_mission(mission_id);
        let lane = &mut self.lanes[Kind::Summaries as usize];
        let mut removed_in_prefix = 0usize;
        let mut removed_in_tail = false;
        let mut idx = 0usize;
        self.summaries.retain(|row| {
            let keep = row.id != mission_id;
            if !keep {
                if idx < lane.prefix_len {
                    removed_in_prefix += 1;
                } else {
                    removed_in_tail = true;
                }
            }
            idx += 1;
            keep
        });
        lane.prefix_len = lane.prefix_len.saturating_sub(removed_in_prefix);
        if removed_in_tail {
            lane.tail_pos.clear();
            lane.tail_pinned_len = 0;
            for (rel, row) in self.summaries[lane.prefix_len..].iter().enumerate() {
                lane.tail_pos.insert((row.id.clone(), None), rel);
            }
        }
        if self.selected.as_deref() == Some(mission_id) {
            self.selection_live.revoke();
            self.mounted_selection_live.revoke();
            if self.visible {
                self.mounted_selection_live = LiveFlag::new(true);
                if self.online {
                    self.selection_live = LiveFlag::new(true);
                }
            }
            self.control_fields.cancel();
            self.detail.clear();
            self.observation = Observation::new(self.online);
            self.selected = None;
        }
    }

    pub(super) fn refresh(&mut self) {
        self.refresh_with(Read::Refresh);
    }

    pub(super) fn refresh_manual(&mut self) {
        self.refresh_with(Read::ManualRefresh);
    }

    fn refresh_with(&mut self, read: Read) {
        if self.visible {
            self.detail.refresh();
            self.observation.refresh();
            for kind in KINDS {
                if self.busy(kind) {
                    let lane = &mut self.lanes[kind as usize];
                    lane.owed = true;
                    if read == Read::ManualRefresh {
                        lane.owed_manual = true;
                    }
                } else {
                    self.start(kind, read);
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
            self.view_live.revoke();
            self.selection_live.revoke();
            self.cleanup_view_live.revoke();
            self.revoke_all_cleanup_tokens();
            if self.visible {
                self.view_live = LiveFlag::new(true);
                self.selection_live = LiveFlag::new(true);
                if !self.cleanups_unavailable() {
                    self.cleanup_view_live = LiveFlag::new(true);
                }
            }
            self.online = true;
            self.detail.cancel();
            self.observation.cancel();
            self.observation.set_online(true);
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

    pub(crate) fn same_workspace_target(&self, backend: &Backend) -> bool {
        self.backend.workspace == backend.workspace
            && self.backend.client.server_identity().is_some()
            && self.backend.client.server_identity() == backend.client.server_identity()
    }

    pub(crate) fn supported(&self) -> bool {
        self.supported == Some(true)
    }

    pub(crate) fn project(&self) -> Option<&str> {
        self.project.as_deref()
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
        self.loaded(kind)
            && !self.failed(kind)
            && !self.busy(kind)
            && self.lanes[kind as usize]
                .window
                .as_ref()
                .is_some_and(|w| w.end == w.total)
    }

    pub(crate) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }

    fn start(&mut self, kind: Kind, read: Read) {
        if !self.visible || self.busy(kind) {
            return;
        }
        let lane = &mut self.lanes[kind as usize];
        let (offset, order) = match (read, &lane.window) {
            (Read::Refresh | Read::ManualRefresh, _) => (0, None),
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
            let owed_manual = std::mem::take(&mut lane.owed_manual);
            let next_owed = if owed_manual {
                Read::ManualRefresh
            } else {
                Read::Refresh
            };
            let keep_failed_more = done.read.is_refresh() && lane.failed == Some(Read::More);
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
                    if done.kind == Kind::Cleanups
                        && lane.failed.is_none()
                        && self.visible
                        && self.online
                        && !self.cleanup_view_live.is_live()
                    {
                        self.cleanup_view_live = LiveFlag::new(true);
                    }
                    if owed {
                        self.start(done.kind, next_owed);
                    }
                }
                Err(error) if error.is::<DirectoryAuthExpired>() => {
                    self.lanes[done.kind as usize].failed = Some(done.read);
                    if done.kind == Kind::Cleanups {
                        self.cleanup_view_live.revoke();
                        self.revoke_all_cleanup_tokens();
                    }
                    self.auth_expired = Some(self.backend.clone());
                }
                Err(error) if error.is::<DirectoryChanged>() => {
                    self.lanes[done.kind as usize].failed = Some(Read::Refresh);
                    if done.kind == Kind::Cleanups {
                        self.cleanup_view_live.revoke();
                        self.revoke_all_cleanup_tokens();
                    }
                    if owed {
                        self.start(done.kind, next_owed);
                    }
                }
                _ => {
                    self.lanes[done.kind as usize].failed = Some(done.read);
                    if done.kind == Kind::Cleanups {
                        self.cleanup_view_live.revoke();
                        self.revoke_all_cleanup_tokens();
                    }
                    if owed {
                        self.start(done.kind, next_owed);
                    }
                }
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
            let header = self.detail.snapshot.as_ref().map(|s| &s.header);
            changed |= self.observation.settle(floor, header, self.now, &self.wake);
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
            self.observation = Observation::new(self.online);
        }
        changed |= self.poll_control_fields();
        if self.detail.take_auth_expired()
            || self.observation.take_auth_expired()
            || self.control_fields.take_auth_expired()
        {
            self.auth_expired = Some(self.backend.clone());
            changed = true;
        }
        changed
    }

    pub(super) fn select(&mut self, id: &str) {
        if self.selected.as_deref() != Some(id) && self.summaries.iter().any(|row| row.id == id) {
            self.selection_live.revoke();
            self.mounted_selection_live.revoke();
            if self.visible {
                self.mounted_selection_live = LiveFlag::new(true);
                if self.online {
                    self.selection_live = LiveFlag::new(true);
                }
            }
            self.control_fields.cancel();
            self.detail.clear();
            self.observation = Observation::new(self.online);
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

#[cfg(test)]
mod tests;
