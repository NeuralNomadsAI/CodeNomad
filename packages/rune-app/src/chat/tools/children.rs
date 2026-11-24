use crate::{
    State,
    backend::Backend,
    content::{Part, Tool},
};
use codenomad_client::{Receiver, Sender, bounded, runtime, stream::ChildInvalidations};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

pub(super) const STEP_LIMIT: usize = 200;
pub(super) const STEP_BYTES: usize = 2 << 20;
const FETCH_CONCURRENCY: usize = 4;
const SNAPSHOT_CACHE_LIMIT: usize = 32;
const SNAPSHOT_CACHE_HARD_LIMIT: usize = 64;
const REPORT_TRUNCATE_CAP: usize = 64 * 1024;
const MAX_REFUSAL_ATTEMPTS: u8 = 2;
type Steps = Vec<(String, Arc<Tool>)>;
pub(super) type ChildKey = (Option<String>, String);

#[derive(Clone, PartialEq)]
pub(super) struct ChildReport {
    pub row_id: String,
    pub child: String,
    pub state: String,
    pub created: u64,
    pub body: Option<String>,
    pub body_truncated: bool,
    pub ordinal: usize,
}

#[derive(Clone, Default, PartialEq)]
pub(super) struct Snapshot {
    pub steps: Steps,
    pub step_ordinals: Vec<usize>,
    pub reports: Vec<ChildReport>,
    pub count_truncated: bool,
    pub byte_truncated: bool,
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    events: Option<(ChildInvalidations, Sender<()>)>,
    tracked_ids: HashSet<String>,
    snapshots: VecDeque<(ChildKey, Snapshot)>,
    demands: HashMap<ChildKey, Demand>,
    in_flight: HashMap<ChildKey, InFlight>,
    next_seq: u64,
}

struct Demand {
    parent_key: Option<ChildKey>,
    cards: HashMap<String, CardDemand>,
    dirty: bool,
    refused: bool,
    refused_attempts: u8,
    failed: bool,
    seq: u64,
}

struct CardDemand {
    lease: Weak<()>,
    on_screen: bool,
    in_pane: bool,
}

impl CardDemand {
    fn is_visible(&self) -> bool {
        self.on_screen && self.in_pane && self.lease.strong_count() > 0
    }
}

struct InFlight {
    _cancel: Sender<()>,
    result: Receiver<FetchOutcome>,
}

enum FetchOutcome {
    Snapshot(Snapshot),
    Refused,
    Failed,
}

impl Children {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = Some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.events = None;
        self.tracked_ids.clear();
        self.snapshots.clear();
        self.demands.clear();
        self.in_flight.clear();
        self.next_seq = 0;
    }

    pub(super) fn release(
        &mut self,
        key: &str,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) {
        self.demands.retain(|_, demand| {
            demand.cards.remove(key);
            !demand.cards.is_empty()
        });
        self.cancel_hidden_in_flight();
        self.trim_inactive_snapshots();
        self.promote(reads, wake);
    }

    pub(super) fn lease(&self, parent: Option<&str>, id: &str, key: &str) -> Rc<()> {
        let lookup = (parent.map(str::to_owned), id.to_owned());
        self.demands
            .get(&lookup)
            .and_then(|demand| demand.cards.get(key))
            .and_then(|card| card.lease.upgrade())
            .unwrap_or_default()
    }

    pub(super) fn can_watch(&self, chain: Option<&str>, child: &str) -> bool {
        let Some(chain) = chain else {
            return true;
        };
        if chain.split('>').any(|ancestor| ancestor == child) {
            return false;
        }
        let (grandparent, owner) = split_chain(chain);
        let parent_key = (grandparent.map(str::to_owned), owner.to_owned());
        self.has_snapshot(&parent_key)
    }

    pub(super) fn has_failed(&self, parent: Option<&str>, id: &str) -> bool {
        self.demands
            .get(&(parent.map(str::to_owned), id.to_owned()))
            .is_some_and(|demand| demand.failed)
    }

    pub(super) fn retry(s: &mut State, parent: Option<&str>, id: &str) {
        let child_key = (parent.map(str::to_owned), id.to_owned());
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        let children = &mut s.transcript_display.children;
        if let Some(demand) = children.demands.get_mut(&child_key) {
            demand.failed = false;
            demand.refused = false;
            demand.refused_attempts = 0;
            demand.dirty = true;
            children.promote(&reads, &wake);
            s.revision += 1;
        }
    }

    pub(super) fn demand(
        s: &mut State,
        chain: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let parent_key = chain.map(|c| {
            let (grandparent, owner) = split_chain(c);
            (grandparent.map(str::to_owned), owner.to_owned())
        });
        let parent = chain.map(|c| split_chain(c).1);
        let child_key = (parent.map(str::to_owned), id.to_owned());
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        let children = &mut s.transcript_display.children;
        children.prune();
        let has_snapshot = children.has_snapshot(&child_key);
        if let Some(demand) = children.demands.get_mut(&child_key) {
            if demand.parent_key.is_none() {
                demand.parent_key = parent_key;
            }
            if visible {
                let was_visible = demand.cards.get(key).is_some_and(CardDemand::is_visible);
                let prev_in_pane = demand.cards.get(key).map_or(true, |c| c.in_pane);
                demand.cards.insert(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        on_screen: true,
                        in_pane: prev_in_pane,
                    },
                );
                if !was_visible && prev_in_pane && !demand.refused && !has_snapshot {
                    demand.dirty = true;
                }
            } else if let Some(card) = demand.cards.get_mut(key) {
                card.on_screen = false;
            }
            children.cancel_hidden_in_flight();
            children.trim_inactive_snapshots();
            children.promote(&reads, &wake);
            return;
        }
        if !visible || !children.can_watch(chain, id) {
            return;
        }
        let seq = children.next_seq;
        children.next_seq = children.next_seq.wrapping_add(1);
        children.demands.insert(
            child_key,
            Demand {
                parent_key,
                cards: HashMap::from([(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        on_screen: true,
                        in_pane: true,
                    },
                )]),
                dirty: true,
                refused: false,
                refused_attempts: 0,
                failed: false,
                seq,
            },
        );
        children.promote(&reads, &wake);
    }

    pub(super) fn set_card_in_pane(
        s: &mut State,
        parent: &str,
        id: &str,
        key: &str,
        in_pane: bool,
    ) {
        let child_key = (Some(parent.to_owned()), id.to_owned());
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        let children = &mut s.transcript_display.children;
        let has_snapshot = children.has_snapshot(&child_key);
        let Some(demand) = children.demands.get_mut(&child_key) else {
            return;
        };
        let Some(card) = demand.cards.get_mut(key) else {
            return;
        };
        if card.in_pane == in_pane {
            return;
        }
        card.in_pane = in_pane;
        if in_pane && card.on_screen && !demand.refused && !has_snapshot {
            demand.dirty = true;
        }
        children.cancel_hidden_in_flight();
        children.trim_inactive_snapshots();
        children.promote(&reads, &wake);
    }

    fn demand_visible(&self, key: &ChildKey) -> bool {
        let mut cursor = Some(key);
        let mut depth = 0usize;
        while let Some(current) = cursor {
            if depth >= 32 {
                return false;
            }
            depth += 1;
            let Some(demand) = self.demands.get(current) else {
                return false;
            };
            if !demand.cards.values().any(CardDemand::is_visible) {
                return false;
            }
            cursor = demand.parent_key.as_ref();
        }
        true
    }

    fn cancel_hidden_in_flight(&mut self) {
        let hidden: Vec<ChildKey> = self
            .in_flight
            .keys()
            .filter(|key| !self.demand_visible(key))
            .cloned()
            .collect();
        for key in hidden {
            self.in_flight.remove(&key);
            if let Some(demand) = self.demands.get_mut(&key)
                && !demand.refused
            {
                demand.dirty = true;
            }
        }
    }

    fn sync_tracked(&mut self) {
        let Some((events, _)) = &self.events else {
            return;
        };
        let next: HashSet<String> = self.demands.keys().map(|(_, id)| id.clone()).collect();
        if next != self.tracked_ids {
            events.set_tracked(next.clone());
            self.tracked_ids = next;
        }
    }

    fn ensure_events(&mut self, wake: &rune::Waker) {
        if self.events.is_some() {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some((invalidations, rx)) = backend.watch_children() else {
            return;
        };
        let (cancel, cancelled) = bounded(1);
        let wake = wake.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                while rx.recv().await.is_ok() {
                    runtime::sleep(Duration::from_millis(100)).await;
                    let _ = rx.try_recv();
                    wake();
                }
            })
            .await;
        });
        self.events = Some((invalidations, cancel));
        self.tracked_ids.clear();
    }

    fn next_ready(&self) -> Vec<ChildKey> {
        let available = FETCH_CONCURRENCY.saturating_sub(self.in_flight.len());
        if available == 0 {
            return Vec::new();
        }
        let mut ready: Vec<(u64, ChildKey)> = self
            .demands
            .iter()
            .filter(|(key, demand)| {
                demand.dirty
                    && !demand.refused
                    && !self.in_flight.contains_key(*key)
                    && self.demand_visible(key)
            })
            .map(|(k, d)| (d.seq, k.clone()))
            .collect();
        ready.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        ready.into_iter().take(available).map(|(_, k)| k).collect()
    }

    fn mark_dispatched(&mut self, key: &ChildKey) {
        if let Some(demand) = self.demands.get_mut(key) {
            demand.dirty = false;
            demand.seq = self.next_seq;
            self.next_seq = self.next_seq.wrapping_add(1);
        }
    }

    fn promote(&mut self, reads: &crate::platform::reads::Reads, wake: &rune::Waker) {
        if self.demands.is_empty() {
            self.events = None;
            self.tracked_ids.clear();
            return;
        }
        if self.backend.is_none() {
            return;
        }
        self.ensure_events(wake);
        self.sync_tracked();
        let Some(backend) = self.backend.clone() else {
            return;
        };
        for key in self.next_ready() {
            self.mark_dispatched(&key);
            let (out, result) = bounded(1);
            let (cancel, cancelled) = bounded(1);
            self.in_flight.insert(
                key.clone(),
                InFlight {
                    _cancel: cancel,
                    result,
                },
            );
            let (parent_id, child) = key;
            let backend = backend.clone();
            let wake = wake.clone();
            let reads = reads.clone();
            crate::platform::spawn(async move {
                crate::platform::reads::cancellable(&cancelled, async {
                    let outcome = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            return;
                        };
                        let fetched = match parent_id.as_deref() {
                            Some(owner) => backend.child_page_for(owner, &child).await,
                            None => backend.child_page(&child).await,
                        };
                        match fetched {
                            Ok(Some(page)) => FetchOutcome::Snapshot(snapshot(page)),
                            Ok(None) => FetchOutcome::Refused,
                            Err(_) => FetchOutcome::Failed,
                        }
                    };
                    let _ = out.send(outcome).await;
                    wake();
                })
                .await;
            });
        }
    }

    pub(crate) fn poll(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) -> bool {
        let mut changed = self.prune();
        if let Some((events, _)) = &self.events {
            let (all, ids) = events.drain();
            if all {
                for demand in self.demands.values_mut() {
                    demand.refused = false;
                    demand.refused_attempts = 0;
                    demand.failed = false;
                    demand.dirty = true;
                }
            } else if !ids.is_empty() {
                let set: HashSet<String> = ids.into_iter().collect();
                for ((_, child), demand) in &mut self.demands {
                    if set.contains(child) {
                        if !demand.refused {
                            demand.dirty = true;
                        } else if demand.refused_attempts < MAX_REFUSAL_ATTEMPTS {
                            demand.refused = false;
                            demand.dirty = true;
                        }
                    }
                }
            }
        }
        let mut completed = Vec::new();
        for (key, flight) in &self.in_flight {
            if let Ok(outcome) = flight.result.try_recv() {
                completed.push((key.clone(), outcome));
            }
        }
        for (key, outcome) in completed {
            self.in_flight.remove(&key);
            match outcome {
                FetchOutcome::Snapshot(next) => {
                    if let Some(demand) = self.demands.get_mut(&key) {
                        demand.refused = false;
                        demand.refused_attempts = 0;
                        if demand.failed {
                            demand.failed = false;
                            changed = true;
                        }
                    }
                    changed |= self.store_snapshot(key, next);
                }
                FetchOutcome::Refused => {
                    if let Some(demand) = self.demands.get_mut(&key) {
                        demand.refused_attempts = demand.refused_attempts.saturating_add(1);
                        if demand.dirty && demand.refused_attempts < MAX_REFUSAL_ATTEMPTS {
                            demand.refused = false;
                        } else {
                            demand.refused = true;
                            demand.dirty = false;
                        }
                        if demand.failed {
                            demand.failed = false;
                            changed = true;
                        }
                    }
                    let before = self.snapshots.len();
                    self.snapshots.retain(|(k, _)| k != &key);
                    changed |= before != self.snapshots.len();
                }
                FetchOutcome::Failed => {
                    if let Some(demand) = self.demands.get_mut(&key)
                        && !demand.failed
                    {
                        demand.failed = true;
                        changed = true;
                    }
                }
            }
        }
        self.trim_inactive_snapshots();
        self.promote(reads, wake);
        changed
    }

    fn store_snapshot(&mut self, key: ChildKey, next: Snapshot) -> bool {
        if let Some(pos) = self.snapshots.iter().position(|(k, _)| k == &key) {
            let (_, prev) = self.snapshots.remove(pos).unwrap();
            let changed = prev != next;
            self.snapshots.push_back((key, next));
            return changed;
        }
        if self.snapshots.len() >= SNAPSHOT_CACHE_LIMIT {
            if let Some(pos) = self
                .snapshots
                .iter()
                .position(|(k, _)| !self.demand_visible(k))
            {
                self.snapshots.remove(pos);
            } else if self.snapshots.len() >= SNAPSHOT_CACHE_HARD_LIMIT {
                self.snapshots.pop_front();
            }
        }
        self.snapshots.push_back((key, next));
        true
    }

    fn trim_inactive_snapshots(&mut self) {
        while self.snapshots.len() > SNAPSHOT_CACHE_LIMIT {
            let Some(pos) = self
                .snapshots
                .iter()
                .position(|(k, _)| !self.demand_visible(k))
            else {
                break;
            };
            self.snapshots.remove(pos);
        }
    }

    fn has_snapshot(&self, key: &ChildKey) -> bool {
        self.snapshots.iter().any(|(k, _)| k == key)
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        // Drop live demands on unmount while keeping retained snapshots in the bounded cache.
        self.demands.retain(|_, demand| {
            demand.cards.retain(|_, card| card.lease.strong_count() > 0);
            !demand.cards.is_empty()
        });
        self.cancel_hidden_in_flight();
        self.trim_inactive_snapshots();
        false
    }

    pub(super) fn snapshot(&self, parent: Option<&str>, id: &str) -> Option<&Snapshot> {
        let lookup = (parent.map(str::to_owned), id.to_owned());
        self.snapshots
            .iter()
            .rev()
            .find(|(k, _)| k == &lookup)
            .map(|(_, snap)| snap)
    }

    pub(super) fn steps(&self, parent: Option<&str>, id: &str) -> &[(String, Arc<Tool>)] {
        self.snapshot(parent, id)
            .map_or(&[], |snapshot| snapshot.steps.as_slice())
    }
}

pub(super) fn split_chain(chain: &str) -> (Option<&str>, &str) {
    match chain.rsplit_once('>') {
        Some((prefix, owner)) => (Some(prefix.rsplit('>').next().unwrap_or(prefix)), owner),
        None => (None, chain),
    }
}

fn snapshot(page: crate::history::Page) -> Snapshot {
    let mut remaining = STEP_BYTES;
    let mut report_bytes = STEP_BYTES;
    let mut tools = Vec::new();
    let mut step_ordinals = Vec::new();
    let mut reports = Vec::new();
    let mut total_tools = 0usize;
    let mut count_truncated = false;
    let mut byte_truncated = false;
    let mut reverse_ord = 0usize;
    for row in page.rows.iter().rev() {
        for part in row.parts.iter().rev() {
            reverse_ord += 1;
            match part {
                Part::Tool(tool) => {
                    if count_truncated {
                        continue;
                    }
                    total_tools += 1;
                    if total_tools > STEP_LIMIT {
                        count_truncated = true;
                        continue;
                    }
                    if byte_truncated {
                        continue;
                    }
                    let Some(left) = remaining.checked_sub(tool.retained_bytes()) else {
                        byte_truncated = true;
                        continue;
                    };
                    remaining = left;
                    tools.push((row.id.clone(), tool.clone()));
                    step_ordinals.push(reverse_ord);
                }
                Part::SubagentReport(report) if reports.len() < STEP_LIMIT => {
                    let (body, body_truncated) = if report.body.len() <= report_bytes {
                        report_bytes -= report.body.len();
                        (Some(report.body.clone()), false)
                    } else if report_bytes > 0 {
                        let cap = report_bytes.min(REPORT_TRUNCATE_CAP);
                        let prefix = truncate_utf8(&report.body, cap);
                        report_bytes -= prefix.len();
                        (Some(prefix.to_owned()), true)
                    } else {
                        (None, true)
                    };
                    reports.push(ChildReport {
                        row_id: row.id.clone(),
                        child: report.child.clone(),
                        state: report.state.clone(),
                        created: report.created,
                        body,
                        body_truncated,
                        ordinal: reverse_ord,
                    });
                }
                _ => {}
            }
        }
        if count_truncated && reports.len() >= STEP_LIMIT {
            break;
        }
    }
    let max_ord = reverse_ord + 1;
    tools.reverse();
    step_ordinals.reverse();
    for ord in &mut step_ordinals {
        *ord = max_ord - *ord;
    }
    reports.reverse();
    for report in &mut reports {
        report.ordinal = max_ord - report.ordinal;
    }
    Snapshot {
        steps: tools,
        step_ordinals,
        reports,
        count_truncated,
        byte_truncated,
    }
}

pub(super) fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
impl Children {
    pub(super) fn install(&mut self, child: &str, page: crate::history::Page) -> Rc<()> {
        self.install_under(None, child, page)
    }

    pub(super) fn install_under(
        &mut self,
        parent: Option<&str>,
        child: &str,
        page: crate::history::Page,
    ) -> Rc<()> {
        let lease = Rc::default();
        let key = (parent.map(str::to_owned), child.into());
        let parent_key = parent.and_then(|p| self.demands.keys().find(|(_, id)| id == p).cloned());
        let (out, result) = bounded(1);
        out.try_send(FetchOutcome::Snapshot(snapshot(page)))
            .unwrap();
        let (cancel, _) = bounded(1);
        self.demands.insert(
            key.clone(),
            Demand {
                parent_key,
                cards: HashMap::from([(
                    "test".into(),
                    CardDemand {
                        lease: Rc::downgrade(&lease),
                        on_screen: true,
                        in_pane: true,
                    },
                )]),
                dirty: false,
                refused: false,
                refused_attempts: 0,
                failed: false,
                seq: 0,
            },
        );
        self.in_flight.insert(
            key,
            InFlight {
                _cancel: cancel,
                result,
            },
        );
        lease
    }

    pub(super) fn install_refused(&mut self, parent: Option<&str>, child: &str) -> Rc<()> {
        let lease = Rc::default();
        let key = (parent.map(str::to_owned), child.into());
        let (out, result) = bounded(1);
        out.try_send(FetchOutcome::Refused).unwrap();
        let (cancel, _) = bounded(1);
        self.demands.insert(
            key.clone(),
            Demand {
                parent_key: None,
                cards: HashMap::from([(
                    "test".into(),
                    CardDemand {
                        lease: Rc::downgrade(&lease),
                        on_screen: true,
                        in_pane: true,
                    },
                )]),
                dirty: false,
                refused: false,
                refused_attempts: 0,
                failed: false,
                seq: 0,
            },
        );
        self.in_flight.insert(
            key,
            InFlight {
                _cancel: cancel,
                result,
            },
        );
        lease
    }

    pub(super) fn has_demand(&self, parent: Option<&str>, child: &str) -> bool {
        self.demands
            .contains_key(&(parent.map(str::to_owned), child.into()))
    }

    pub(super) fn is_refused(&self, parent: Option<&str>, child: &str) -> bool {
        self.demands
            .get(&(parent.map(str::to_owned), child.into()))
            .is_some_and(|d| d.refused)
    }

    pub(super) fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    pub(super) fn snapshot_count(&self) -> usize {
        self.snapshots.len()
    }

    pub(super) fn has_events_watcher(&self) -> bool {
        self.events.is_some()
    }

    pub(super) fn card_visible(
        &self,
        parent: Option<&str>,
        child: &str,
        key: &str,
    ) -> Option<bool> {
        let child_key = (parent.map(str::to_owned), child.into());
        let demand = self.demands.get(&child_key)?;
        let card = demand.cards.get(key)?;
        Some(card.is_visible() && self.demand_visible(&child_key))
    }

    pub(super) fn dispatch_test_slots(&mut self) -> Vec<ChildKey> {
        let ready = self.next_ready();
        for key in &ready {
            self.mark_dispatched(key);
            let (_, result) = bounded(1);
            let (cancel, _) = bounded(1);
            self.in_flight.insert(
                key.clone(),
                InFlight {
                    _cancel: cancel,
                    result,
                },
            );
        }
        ready
    }

    pub(super) fn complete_test_slot(
        &mut self,
        key: &ChildKey,
        outcome: Result<Option<crate::history::Page>, ()>,
    ) {
        let (out, result) = bounded(1);
        let outcome = match outcome {
            Ok(Some(page)) => FetchOutcome::Snapshot(snapshot(page)),
            Ok(None) => FetchOutcome::Refused,
            Err(()) => FetchOutcome::Failed,
        };
        let _ = out.try_send(outcome);
        if let Some(flight) = self.in_flight.get_mut(key) {
            flight.result = result;
        }
    }

    pub(super) fn notify_test_invalidation(&mut self, child: Option<&str>) {
        match child {
            None => {
                for demand in self.demands.values_mut() {
                    demand.refused = false;
                    demand.refused_attempts = 0;
                    demand.failed = false;
                    demand.dirty = true;
                }
            }
            Some(target) => {
                for ((_, id), demand) in &mut self.demands {
                    if id == target {
                        if !demand.refused {
                            demand.dirty = true;
                        } else if demand.refused_attempts < MAX_REFUSAL_ATTEMPTS {
                            demand.refused = false;
                            demand.dirty = true;
                        }
                    }
                }
            }
        }
    }
}
