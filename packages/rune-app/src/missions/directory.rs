use super::{
    cleanup::LiveFlag,
    detail::{Detail, read_window},
    observation::Observation,
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{
        Cleanup, DirectoryAuthExpired, DirectoryChanged, DirectoryPage, DirectoryRows, Summary,
        Window,
    },
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
    More,
}

#[derive(Default)]
struct Lane {
    active: Option<(u64, Sender<()>)>,
    window: Option<Window>,
    failed: Option<Read>,
    owed: bool,
    seen: HashSet<(String, Option<String>)>,
    prefix_len: usize,
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
    pending_cleanup_set: HashSet<(String, String, String, u64, bool, u64, Option<bool>)>,
    cleanups_dirty: bool,
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
            cleanups_dirty: false,
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

    pub(crate) fn carry_document_pending_from(&mut self, old: &Self) {
        self.remembered_document_pending
            .clone_from(&old.remembered_document_pending);
        self.remembered_document_order
            .clone_from(&old.remembered_document_order);
        self.settled_cleanups.clone_from(&old.settled_cleanups);
        self.settled_cleanup_order
            .clone_from(&old.settled_cleanup_order);
        self.deleted_missions.clone_from(&old.deleted_missions);
        self.deleted_missions_order
            .clone_from(&old.deleted_missions_order);
    }

    pub(crate) fn take_cleanups_dirty(&mut self) -> bool {
        std::mem::take(&mut self.cleanups_dirty)
    }

    pub(super) fn has_pending_cleanups(&self) -> bool {
        if !self.pending_cleanup_set.is_empty() {
            return true;
        }
        self.cleanup_meta.is_empty() && self.cleanups.iter().any(Cleanup::is_pending)
    }

    pub(super) fn cleanups_rc(&self) -> std::rc::Rc<Vec<Cleanup>> {
        let mut cache = self.cleanups_rc.borrow_mut();
        if let Some((cached_gen, rc)) = cache.as_ref()
            && *cached_gen == self.cleanups_gen
            && rc.len() == self.cleanups.len()
        {
            return std::rc::Rc::clone(rc);
        }
        let rc = std::rc::Rc::new(self.cleanups.clone());
        *cache = Some((self.cleanups_gen, std::rc::Rc::clone(&rc)));
        rc
    }

    fn rebuild_cleanup_indices(&mut self) {
        self.cleanup_meta.clear();
        self.pending_cleanup_set.clear();
        for row in &self.cleanups {
            self.cleanup_meta.insert(
                (row.mission_id.clone(), row.deletion_id.clone()),
                (
                    row.request_id.clone(),
                    row.expected_revision,
                    row.delete_managed_sessions,
                    row.created_at.to_bits(),
                ),
            );
            if row.is_pending() {
                self.pending_cleanup_set.insert(pending_cleanup_tuple(row));
            }
        }
        self.cleanups_dirty = true;
        self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
    }

    fn remember_deleted_mission(&mut self, mission_id: &str) {
        if self.deleted_missions.contains(mission_id) {
            return;
        }
        while self.deleted_missions.len() >= DELETED_MISSIONS_CAP {
            let Some(evict) = self.deleted_missions_order.pop_front() else {
                break;
            };
            self.deleted_missions.remove(&evict);
        }
        let owned = mission_id.to_owned();
        self.deleted_missions_order.push_back(owned.clone());
        self.deleted_missions.insert(owned);
    }

    fn remember_settled_cleanup(&mut self, receipt: Cleanup) {
        if receipt.is_pending() {
            return;
        }
        let key = cleanup_identity(&receipt);
        if self.settled_cleanups.contains_key(&key) {
            self.settled_cleanups.insert(key, receipt);
            return;
        }
        while self.settled_cleanups.len() >= CLEANUP_DISPLAY_CAP {
            let Some(evict) = self.settled_cleanup_order.pop_front() else {
                break;
            };
            self.settled_cleanups.remove(&evict);
        }
        self.settled_cleanup_order.push_back(key.clone());
        self.settled_cleanups.insert(key, receipt);
    }

    fn remember_document_pending(&mut self, key: CleanupIdentity) {
        self.remember_document_pending_batch(&[(key, Some(true))]);
    }

    fn remember_document_pending_batch(&mut self, updates: &[(CleanupIdentity, Option<bool>)]) {
        let mut to_add: Vec<&CleanupIdentity> = Vec::new();
        for (id, doc_pending) in updates {
            match doc_pending {
                Some(true) => {
                    #[cfg(test)]
                    {
                        self.doc_cache_lookups += 1;
                    }
                    if !self.remembered_document_pending.contains(id) {
                        to_add.push(id);
                    }
                }
                Some(false) => {
                    self.forget_document_pending(id);
                }
                None => {}
            }
        }
        if to_add.is_empty() {
            return;
        }
        // If evictions are needed, partition the queue once in O(N) so absent rows evict before
        // currently displayed rows, then evict each excess entry in O(1).
        if self.remembered_document_pending.len() + to_add.len() > CLEANUP_DISPLAY_CAP {
            let live: HashSet<CleanupIdentity> =
                self.cleanups.iter().map(cleanup_identity).collect();
            let mut absent = VecDeque::with_capacity(self.remembered_document_order.len());
            let mut present = VecDeque::new();
            while let Some(id) = self.remembered_document_order.pop_front() {
                #[cfg(test)]
                {
                    self.doc_cache_lookups += 1;
                }
                if live.contains(&id) {
                    present.push_back(id);
                } else {
                    absent.push_back(id);
                }
            }
            absent.extend(present);
            self.remembered_document_order = absent;
        }
        for id in to_add {
            if self.remembered_document_pending.contains(id) {
                continue;
            }
            while self.remembered_document_pending.len() >= CLEANUP_DISPLAY_CAP {
                let Some(evict) = self.remembered_document_order.pop_front() else {
                    break;
                };
                self.remembered_document_pending.remove(&evict);
            }
            self.remembered_document_order.push_back(id.clone());
            self.remembered_document_pending.insert(id.clone());
        }
    }

    fn forget_document_pending(&mut self, key: &CleanupIdentity) {
        if self.remembered_document_pending.remove(key) {
            self.remembered_document_order.retain(|id| id != key);
        }
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

    fn cancel_lane(&mut self, kind: Kind) {
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
        let mut idx = 0usize;
        self.summaries.retain(|row| {
            let keep = row.id != mission_id;
            if !keep && idx < lane.prefix_len {
                removed_in_prefix += 1;
            }
            idx += 1;
            keep
        });
        lane.prefix_len = lane.prefix_len.saturating_sub(removed_in_prefix);
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

    pub(super) fn adopt_settled_cleanup(&mut self, mut receipt: Cleanup) {
        self.cancel_lane(Kind::Cleanups);
        let key = cleanup_identity(&receipt);
        match receipt.document_pending {
            Some(false) => {
                self.forget_document_pending(&key);
            }
            Some(true) => {
                self.remember_document_pending(key);
            }
            None => {
                if self.remembered_document_pending.contains(&key)
                    || self.cleanups.iter().any(|row| {
                        cleanup_identity(row) == key && row.document_pending == Some(true)
                    })
                {
                    receipt.document_pending = Some(true);
                    self.remember_document_pending(key);
                }
            }
        }
        let row_id = (receipt.mission_id.clone(), receipt.deletion_id.clone());
        let new_meta = (
            receipt.request_id.clone(),
            receipt.expected_revision,
            receipt.delete_managed_sessions,
            receipt.created_at.to_bits(),
        );
        if let Some(existing) = self.cleanups.iter_mut().find(|row| {
            row.mission_id == receipt.mission_id && row.deletion_id == receipt.deletion_id
        }) {
            if existing.is_pending() {
                let old_tuple = pending_cleanup_tuple(existing);
                self.pending_cleanup_set.remove(&old_tuple);
            }
            *existing = receipt.clone();
            if existing.is_pending() {
                let new_tuple = pending_cleanup_tuple(existing);
                self.pending_cleanup_set.insert(new_tuple);
            }
            self.cleanup_meta.insert(row_id, new_meta);
        } else {
            self.cleanups.insert(0, receipt.clone());
            self.lanes[Kind::Cleanups as usize].prefix_len = 0;
            self.cleanup_meta.insert(row_id, new_meta);
            if receipt.is_pending() {
                self.pending_cleanup_set
                    .insert(pending_cleanup_tuple(&receipt));
            }
            let lane_seen = &mut self.lanes[Kind::Cleanups as usize].seen;
            // Cap only off-page adopted rows without evicting index 0 or legitimately
            // paged current-order rows; order changes cap unvisited tails in merge_filtered.
            let max_rows = CLEANUP_DISPLAY_CAP.max(lane_seen.len().saturating_add(1));
            while self.cleanups.len() > max_rows {
                let row_key =
                    |row: &Cleanup| (row.mission_id.clone(), Some(row.deletion_id.clone()));
                let tail = &self.cleanups[1..];
                let Some(rel) = tail
                    .iter()
                    .rposition(|row| !row.is_pending() && !lane_seen.contains(&row_key(row)))
                    .or_else(|| {
                        tail.iter()
                            .rposition(|row| !lane_seen.contains(&row_key(row)))
                    })
                else {
                    break;
                };
                let evicted = self.cleanups.remove(rel + 1);
                self.cleanup_meta
                    .remove(&(evicted.mission_id.clone(), evicted.deletion_id.clone()));
                if evicted.is_pending() {
                    self.pending_cleanup_set
                        .remove(&pending_cleanup_tuple(&evicted));
                }
            }
        }
        self.cleanups_dirty = true;
        self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
        if !receipt.is_pending() {
            self.remember_settled_cleanup(receipt.clone());
            if let Some(token) = self
                .cleanup_tokens
                .remove(&(receipt.mission_id, receipt.deletion_id))
            {
                token.revoke();
            }
        }
    }

    pub(super) fn mark_cleanup_document_pending(&mut self, key: &CleanupIdentity) {
        let newly_pending = !self.remembered_document_pending.contains(key);
        self.remember_document_pending(key.clone());
        if newly_pending
            && let Some(token) = self.cleanup_tokens.remove(&(key.0.clone(), key.1.clone()))
        {
            token.revoke();
        }
        let mut updated = false;
        for row in &mut self.cleanups {
            if cleanup_identity(row) == *key && row.document_pending.is_none() {
                if row.is_pending() {
                    self.pending_cleanup_set.remove(&pending_cleanup_tuple(row));
                }
                row.document_pending = Some(true);
                if row.is_pending() {
                    self.pending_cleanup_set.insert(pending_cleanup_tuple(row));
                }
                updated = true;
            }
        }
        if updated {
            self.cleanups_dirty = true;
            self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
        }
    }

    #[cfg(test)]
    pub(super) fn cleanup_token_count(&self) -> usize {
        self.cleanup_tokens.len()
    }

    pub(super) fn cleanup_row_live(&mut self, mission_id: &str, deletion_id: &str) -> LiveFlag {
        let key = (mission_id.to_owned(), deletion_id.to_owned());
        if let Some(token) = self.cleanup_tokens.get(&key) {
            return token.clone();
        }
        if self.cleanup_tokens.len() >= 64 {
            self.cleanup_tokens.retain(|(m, d), token| {
                let alive = self
                    .cleanups
                    .iter()
                    .any(|row| row.is_pending() && row.mission_id == *m && row.deletion_id == *d);
                if !alive {
                    token.revoke();
                }
                alive
            });
            while self.cleanup_tokens.len() >= 64 {
                let Some(evict) = self.cleanup_tokens.keys().next().cloned() else {
                    break;
                };
                if let Some(token) = self.cleanup_tokens.remove(&evict) {
                    token.revoke();
                }
            }
        }
        let token = LiveFlag::new(true);
        self.cleanup_tokens.insert(key, token.clone());
        token
    }

    fn revoke_all_cleanup_tokens(&mut self) {
        for (_, token) in self.cleanup_tokens.drain() {
            token.revoke();
        }
    }

    fn sync_cleanup_tokens(&mut self, covered: bool) {
        self.cleanup_tokens.retain(|(m, d), token| {
            let keep = if self.cleanup_meta.contains_key(&(m.clone(), d.clone())) {
                self.pending_cleanup_set
                    .iter()
                    .any(|(del, mid, _, _, _, _, _)| mid == m && del == d)
            } else {
                !covered
            };
            if !keep {
                token.revoke();
            }
            keep
        });
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

    #[cfg(test)]
    pub(crate) fn refresh_for_test(&mut self) {
        self.refresh();
    }

    #[cfg(test)]
    pub(crate) fn load_more_cleanups_for_test(&mut self) {
        self.start(Kind::Cleanups, Read::More);
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
                    if done.kind == Kind::Cleanups
                        && lane.failed.is_none()
                        && self.visible
                        && self.online
                        && !self.cleanup_view_live.is_live()
                    {
                        self.cleanup_view_live = LiveFlag::new(true);
                    }
                    if owed {
                        self.start(done.kind, Read::Refresh);
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
                        self.start(done.kind, Read::Refresh);
                    }
                }
                _ => {
                    self.lanes[done.kind as usize].failed = Some(done.read);
                    if done.kind == Kind::Cleanups {
                        self.cleanup_view_live.revoke();
                        self.revoke_all_cleanup_tokens();
                    }
                    if owed {
                        self.start(done.kind, Read::Refresh);
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

    fn accept(&mut self, kind: Kind, read: Read, page: DirectoryPage) -> bool {
        if self
            .project
            .as_ref()
            .is_some_and(|project| project != &page.project_id)
        {
            return false;
        }
        if kind == Kind::Cleanups && self.cleanup_meta.is_empty() && !self.cleanups.is_empty() {
            self.rebuild_cleanup_indices();
        }
        if read == Read::More
            && self.lanes[kind as usize].window.as_ref().is_none_or(|w| {
                page.window.order != w.order
                    || page.window.offset != w.end
                    || page.window.total != w.total
            })
        {
            return false;
        }
        if read == Read::Refresh
            && self.lanes[kind as usize].window.as_ref().is_some_and(|w| {
                w.order == page.window.order
                    && w.total == page.window.total
                    && w.end > page.window.end
            })
        {
            return true;
        }
        match (kind, page.rows) {
            (Kind::Summaries, DirectoryRows::Summaries(rows)) => {
                let lane = &mut self.lanes[kind as usize];
                if !merge_filtered(
                    &mut self.summaries,
                    lane,
                    read,
                    &page.window,
                    rows,
                    None,
                    |row| (row.id.clone(), None),
                    |row| !self.deleted_missions.contains(&row.id),
                ) {
                    return false;
                }
                if page.window.end == page.window.total && !self.deleted_missions.is_empty() {
                    let seen = &lane.seen;
                    self.deleted_missions
                        .retain(|id| seen.contains(&(id.clone(), None)));
                    self.deleted_missions_order
                        .retain(|id| self.deleted_missions.contains(id));
                }
                // A page that does not cover the directory cannot prove a selection is gone.
                if page.window.end == page.window.total
                    && self
                        .selected
                        .as_ref()
                        .is_some_and(|id| !self.summaries.iter().any(|row| &row.id == id))
                {
                    self.selection_live.revoke();
                    self.mounted_selection_live.revoke();
                    if self.visible {
                        self.mounted_selection_live = LiveFlag::new(true);
                        if self.online {
                            self.selection_live = LiveFlag::new(true);
                        }
                    }
                    self.selected = None;
                }
            }
            (Kind::Cleanups, DirectoryRows::Cleanups(mut rows)) => {
                for row in &mut rows {
                    let id = cleanup_identity(row);
                    if row.is_pending()
                        && let Some(settled) = self.settled_cleanups.get(&id)
                    {
                        *row = settled.clone();
                        continue;
                    }
                    if row.document_pending.is_none()
                        && self.remembered_document_pending.contains(&id)
                    {
                        row.document_pending = Some(true);
                    }
                }
                let contradictory = rows.iter().any(|row| {
                    self.cleanup_meta
                        .get(&(row.mission_id.clone(), row.deletion_id.clone()))
                        .is_some_and(|(req, rev, del_ses, created_at_bits)| {
                            req != &row.request_id
                                || *rev != row.expected_revision
                                || *del_ses != row.delete_managed_sessions
                                || *created_at_bits != row.created_at.to_bits()
                        })
                });
                let doc_updates: Vec<(CleanupIdentity, Option<bool>)> = rows
                    .iter()
                    .map(|row| (cleanup_identity(row), row.document_pending))
                    .collect();
                let incoming_meta: Vec<((String, String), (String, u64, bool, u64))> = rows
                    .iter()
                    .map(|row| {
                        (
                            (row.mission_id.clone(), row.deletion_id.clone()),
                            (
                                row.request_id.clone(),
                                row.expected_revision,
                                row.delete_managed_sessions,
                                row.created_at.to_bits(),
                            ),
                        )
                    })
                    .collect();
                let incoming_pending: Vec<_> = rows
                    .iter()
                    .filter(|row| row.is_pending())
                    .map(pending_cleanup_tuple)
                    .collect();
                if contradictory {
                    self.cleanup_view_live.revoke();
                    self.revoke_all_cleanup_tokens();
                    return false;
                }
                let lane = &mut self.lanes[kind as usize];
                let had_tail = self.cleanups.len() > lane.prefix_len;
                let before_len = self.cleanups.len();
                if !merge_filtered(
                    &mut self.cleanups,
                    lane,
                    read,
                    &page.window,
                    rows,
                    Some(CLEANUP_DISPLAY_CAP),
                    |row| (row.mission_id.clone(), Some(row.deletion_id.clone())),
                    |_| true,
                ) {
                    return false;
                }
                let covered = page.window.end == page.window.total;
                let trimmed = self.cleanups.len() < before_len
                    || (had_tail && self.cleanups.len() == CLEANUP_DISPLAY_CAP);
                self.project = Some(page.project_id);
                lane.window = Some(page.window);
                if read == Read::Refresh || (covered && had_tail) || trimmed {
                    self.rebuild_cleanup_indices();
                } else {
                    for (k, meta) in incoming_meta {
                        self.cleanup_meta.insert(k, meta);
                    }
                    for tuple in incoming_pending {
                        self.pending_cleanup_set.insert(tuple);
                    }
                    self.cleanups_dirty = true;
                    self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
                }
                for (id, doc_pending) in &doc_updates {
                    if *doc_pending == Some(true)
                        && !self.remembered_document_pending.contains(id)
                        && let Some(token) =
                            self.cleanup_tokens.remove(&(id.0.clone(), id.1.clone()))
                    {
                        token.revoke();
                    }
                }
                self.remember_document_pending_batch(&doc_updates);
                self.sync_cleanup_tokens(covered);
                return true;
            }
            _ => return false,
        }
        self.project = Some(page.project_id);
        self.lanes[kind as usize].window = Some(page.window);
        true
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

    #[cfg(test)]
    pub(crate) fn seed_summary_for_test(&mut self, id: &str) {
        self.summaries.push(Summary {
            id: id.into(),
            title: Some(id.into()),
            objective: id.into(),
            status: codenomad_client::missions::Status::Active,
            run_state: None,
            coordinator_session_id: "ses_c".into(),
            actor_count: 1,
            updated_at: 1.0,
            revision: 7,
            finish_sequence: None,
            task_count: None,
        });
        self.select(id);
    }

    #[cfg(test)]
    pub(crate) fn has_summary_for_test(&self, id: &str) -> bool {
        self.summaries.iter().any(|row| row.id == id)
    }

    #[cfg(test)]
    pub(crate) fn has_settled_cleanup_for_test(&self, deletion_id: &str) -> bool {
        self.cleanups
            .iter()
            .any(|row| row.deletion_id == deletion_id && !row.is_pending())
    }

    #[cfg(test)]
    pub(super) fn cleanup_seen_count(&self) -> usize {
        self.lanes[Kind::Cleanups as usize].seen.len()
    }

    #[cfg(test)]
    pub(super) fn accept_more_cleanups_for_test(
        &mut self,
        order: &str,
        offset: u64,
        total: u64,
        rows: Vec<Cleanup>,
    ) -> bool {
        let end = offset + rows.len() as u64;
        self.accept(
            Kind::Cleanups,
            if offset == 0 {
                Read::Refresh
            } else {
                Read::More
            },
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: order.into(),
                    offset,
                    end,
                    total,
                },
                rows: DirectoryRows::Cleanups(rows),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn accept_cleanups_for_test(&mut self, rows: Vec<Cleanup>) -> bool {
        let len = rows.len() as u64;
        self.accept(
            Kind::Cleanups,
            Read::Refresh,
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: "test-order".into(),
                    offset: 0,
                    end: len,
                    total: len,
                },
                rows: DirectoryRows::Cleanups(rows),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn accept_summaries_for_test(&mut self, rows: Vec<Summary>) -> bool {
        let len = rows.len() as u64;
        self.accept(
            Kind::Summaries,
            Read::Refresh,
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: "test-order".into(),
                    offset: 0,
                    end: len,
                    total: len,
                },
                rows: DirectoryRows::Summaries(rows),
            },
        )
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

fn pending_cleanup_tuple(row: &Cleanup) -> (String, String, String, u64, bool, u64, Option<bool>) {
    (
        row.deletion_id.clone(),
        row.mission_id.clone(),
        row.request_id.clone(),
        row.expected_revision,
        row.delete_managed_sessions,
        row.created_at.to_bits(),
        row.document_pending,
    )
}

impl Drop for Panel {
    fn drop(&mut self) {
        self.show(false);
    }
}

fn merge_filtered<T>(
    display: &mut Vec<T>,
    lane: &mut Lane,
    read: Read,
    window: &Window,
    rows: Vec<T>,
    cap: Option<usize>,
    key: impl Fn(&T) -> (String, Option<String>),
    keep: impl Fn(&T) -> bool,
) -> bool {
    if read == Read::Refresh {
        lane.seen.clear();
        lane.prefix_len = 0;
    } else if rows.iter().any(|row| lane.seen.contains(&key(row))) {
        return false;
    }
    let incoming_keys: Vec<(String, Option<String>)> = rows.iter().map(&key).collect();
    let kept: Vec<T> = rows.into_iter().filter(&keep).collect();
    if read == Read::More && lane.prefix_len > 0 && lane.prefix_len <= display.len() {
        // Fast path: display[..lane.prefix_len] is already the contiguous current-order prefix.
        let tail = display.split_off(lane.prefix_len);
        lane.seen.extend(incoming_keys);
        display.extend(kept);
        lane.prefix_len = display.len();
        if window.end != window.total && !tail.is_empty() {
            let remaining = cap.map_or(usize::MAX, |max_len| max_len.saturating_sub(display.len()));
            display.extend(
                tail.into_iter()
                    .filter(|row| keep(row) && !lane.seen.contains(&key(row)))
                    .take(remaining),
            );
        }
        return true;
    }
    // Current-order rows stay a contiguous prefix; keep unvisited rows (including adopted
    // off-page receipts and previous-order tail rows) after it and deduplicate on arrival.
    let previous = std::mem::take(display);
    let mut prefix_rows = Vec::with_capacity(lane.seen.len().min(previous.len()));
    let mut tail_rows = Vec::new();
    for row in previous {
        if !keep(&row) {
            continue;
        }
        if lane.seen.contains(&key(&row)) {
            prefix_rows.push(row);
        } else {
            tail_rows.push(row);
        }
    }
    lane.seen.extend(incoming_keys);
    display.extend(prefix_rows);
    display.extend(kept);
    lane.prefix_len = display.len();
    if window.end != window.total {
        let remaining = cap.map_or(usize::MAX, |max_len| max_len.saturating_sub(display.len()));
        display.extend(
            tail_rows
                .into_iter()
                .filter(|row| !lane.seen.contains(&key(row)))
                .take(remaining),
        );
    }
    true
}

#[cfg(test)]
mod tests;
