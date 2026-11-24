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
type Steps = Vec<(String, Arc<Tool>)>;
pub(super) type ChildKey = (Option<String>, String);

#[derive(Clone, PartialEq)]
pub(super) struct ChildReport {
    pub row_id: String,
    pub child: String,
    pub state: String,
    pub created: u64,
    pub body: Option<String>,
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
    snapshots: VecDeque<(ChildKey, Snapshot)>,
    demands: HashMap<ChildKey, Demand>,
    in_flight: HashMap<ChildKey, InFlight>,
    next_seq: u64,
}

struct Demand {
    cards: HashMap<String, CardDemand>,
    dirty: bool,
    refused: bool,
    seq: u64,
}

struct CardDemand {
    lease: Weak<()>,
    visible: bool,
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
        let in_flight = &mut self.in_flight;
        self.demands.retain(|child_key, demand| {
            demand.cards.remove(key);
            if !demand
                .cards
                .values()
                .any(|c| c.visible && c.lease.strong_count() > 0)
                && in_flight.remove(child_key).is_some()
                && !demand.refused
            {
                demand.dirty = true;
            }
            !demand.cards.is_empty()
        });
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

    pub(super) fn demand(
        s: &mut State,
        chain: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let parent = chain.map(|c| split_chain(c).1);
        let child_key = (parent.map(str::to_owned), id.to_owned());
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        let children = &mut s.transcript_display.children;
        children.prune();
        let has_snapshot = children.has_snapshot(&child_key);
        if let Some(demand) = children.demands.get_mut(&child_key) {
            if visible {
                let is_new = !demand.cards.get(key).is_some_and(|c| c.visible);
                demand.cards.insert(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        visible: true,
                    },
                );
                if is_new && !demand.refused && !has_snapshot {
                    demand.dirty = true;
                }
            } else if let Some(card) = demand.cards.get_mut(key) {
                card.visible = false;
                if !demand
                    .cards
                    .values()
                    .any(|c| c.visible && c.lease.strong_count() > 0)
                    && children.in_flight.remove(&child_key).is_some()
                    && !demand.refused
                {
                    demand.dirty = true;
                }
            }
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
                cards: HashMap::from([(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        visible: true,
                    },
                )]),
                dirty: true,
                refused: false,
                seq,
            },
        );
        children.promote(&reads, &wake);
    }

    pub(super) fn set_card_visible(
        s: &mut State,
        parent: &str,
        id: &str,
        key: &str,
        visible: bool,
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
        if card.visible == visible {
            return;
        }
        card.visible = visible;
        if visible {
            if !demand.refused && !has_snapshot {
                demand.dirty = true;
            }
        } else if !demand
            .cards
            .values()
            .any(|c| c.visible && c.lease.strong_count() > 0)
            && children.in_flight.remove(&child_key).is_some()
            && !demand.refused
        {
            demand.dirty = true;
        }
        children.promote(&reads, &wake);
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
                    && demand
                        .cards
                        .values()
                        .any(|c| c.visible && c.lease.strong_count() > 0)
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
        if self.backend.is_none() {
            return;
        }
        self.ensure_events(wake);
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
                    demand.dirty = true;
                }
            } else if !ids.is_empty() {
                let set: HashSet<String> = ids.into_iter().collect();
                for ((_, child), demand) in &mut self.demands {
                    if !demand.refused && set.contains(child) {
                        demand.dirty = true;
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
                    }
                    changed |= self.store_snapshot(key, next);
                }
                FetchOutcome::Refused => {
                    if let Some(demand) = self.demands.get_mut(&key) {
                        demand.refused = true;
                        demand.dirty = false;
                    }
                    let before = self.snapshots.len();
                    self.snapshots.retain(|(k, _)| k != &key);
                    changed |= before != self.snapshots.len();
                }
                FetchOutcome::Failed => {}
            }
        }
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
            self.snapshots.pop_front();
        }
        self.snapshots.push_back((key, next));
        true
    }

    fn has_snapshot(&self, key: &ChildKey) -> bool {
        self.snapshots.iter().any(|(k, _)| k == key)
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        // Drop live demands on unmount while keeping retained snapshots in the bounded cache.
        let in_flight = &mut self.in_flight;
        self.demands.retain(|key, demand| {
            demand.cards.retain(|_, card| card.lease.strong_count() > 0);
            if !demand.cards.values().any(|c| c.visible)
                && in_flight.remove(key).is_some()
                && !demand.refused
            {
                demand.dirty = true;
            }
            !demand.cards.is_empty()
        });
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
                    let body = report_bytes.checked_sub(report.body.len()).map(|left| {
                        report_bytes = left;
                        report.body.clone()
                    });
                    reports.push(ChildReport {
                        row_id: row.id.clone(),
                        child: report.child.clone(),
                        state: report.state.clone(),
                        created: report.created,
                        body,
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
        let (out, result) = bounded(1);
        out.try_send(FetchOutcome::Snapshot(snapshot(page)))
            .unwrap();
        let (cancel, _) = bounded(1);
        self.demands.insert(
            key.clone(),
            Demand {
                cards: HashMap::from([(
                    "test".into(),
                    CardDemand {
                        lease: Rc::downgrade(&lease),
                        visible: true,
                    },
                )]),
                dirty: false,
                refused: false,
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
                cards: HashMap::from([(
                    "test".into(),
                    CardDemand {
                        lease: Rc::downgrade(&lease),
                        visible: true,
                    },
                )]),
                dirty: false,
                refused: false,
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

    pub(super) fn card_visible(
        &self,
        parent: Option<&str>,
        child: &str,
        key: &str,
    ) -> Option<bool> {
        self.demands
            .get(&(parent.map(str::to_owned), child.into()))
            .and_then(|d| d.cards.get(key))
            .map(|c| c.visible)
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
        page: Option<crate::history::Page>,
    ) {
        let (out, result) = bounded(1);
        let outcome = match page {
            Some(page) => FetchOutcome::Snapshot(snapshot(page)),
            None => FetchOutcome::Refused,
        };
        let _ = out.try_send(outcome);
        if let Some(flight) = self.in_flight.get_mut(key) {
            flight.result = result;
        }
    }
}
