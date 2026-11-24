use crate::{
    State,
    backend::Backend,
    content::{Part, SubagentReport, Tool},
};
use codenomad_client::{Receiver, bounded, runtime};
use std::{
    collections::{HashMap, VecDeque},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

static CLIPBOARD_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn note_clipboard_write() {
    CLIPBOARD_EPOCH.fetch_add(1, Ordering::SeqCst);
}

pub(super) const STEP_LIMIT: usize = 200;
const CHILD_LIMIT: usize = 4;
const RETAINED_LIMIT: usize = 16;
const WAITING_LIMIT: usize = 32;
const STEP_BYTES: usize = 2 << 20;
const MAX_COPY_PAGES: usize = 64;
const MAX_COPY_BYTES: usize = 8 * 1024 * 1024;
const COPY_BUDGET: Duration = Duration::from_secs(30);
const MAX_PENDING_EVENTS: usize = 32;
const MAX_PENDING_BYTES: usize = 256 * 1024;
type Steps = Vec<(String, Arc<Tool>)>;
type ChildKey = (Option<String>, String);

fn child_key(parent: Option<&str>, id: &str) -> ChildKey {
    (parent.map(str::to_owned), id.to_owned())
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ReportCopyKey {
    pub key: String,
    pub parent: String,
    pub row_id: String,
    pub part_index: usize,
    pub child: String,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) enum CopyKey {
    Report(ReportCopyKey),
    Steps {
        key: String,
        parent: Option<String>,
        child: String,
    },
}

#[derive(Clone, PartialEq)]
pub(super) struct ChildReport {
    pub row_id: String,
    pub part_index: usize,
    pub report: Arc<SubagentReport>,
    pub truncated: bool,
}

type Reports = Vec<ChildReport>;

#[derive(Default, PartialEq)]
struct Snapshot {
    steps: Steps,
    steps_truncated: bool,
    steps_incomplete: bool,
    reports: Reports,
}

enum ChildUpdate {
    Loaded { snapshot: Snapshot, settled: bool },
    Settled,
    Unverified,
    Failed,
}

enum ReportCopy {
    Idle,
    Loading {
        key: CopyKey,
        epoch: u64,
        lease: Option<Weak<()>>,
        _cancel: codenomad_client::Sender<()>,
        rx: Receiver<Option<String>>,
    },
    #[allow(dead_code)]
    Ready {
        key: CopyKey,
        text: String,
    },
    Failed {
        key: CopyKey,
    },
}

impl Default for ReportCopy {
    fn default() -> Self {
        Self::Idle
    }
}

enum ReportExpand {
    Idle,
    Loading {
        key: ReportCopyKey,
        _cancel: codenomad_client::Sender<()>,
        rx: Receiver<Option<String>>,
    },
    Loaded {
        key: ReportCopyKey,
        text: String,
    },
    Failed {
        key: ReportCopyKey,
    },
}

impl Default for ReportExpand {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    entries: HashMap<ChildKey, Entry>,
    waiting: VecDeque<(ChildKey, String, Weak<()>)>,
    report_copy: ReportCopy,
    expanded_report: ReportExpand,
    pending_nav: Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)>,
}

struct Watcher {
    _cancel: codenomad_client::Sender<()>,
    retry: codenomad_client::Sender<()>,
    result: Receiver<ChildUpdate>,
}

enum WatchState {
    Active(Watcher),
    Dormant {
        _cancel: codenomad_client::Sender<()>,
        wake: Receiver<bool>,
    },
    Pending,
}

struct Entry {
    cards: HashMap<String, Weak<()>>,
    watch: WatchState,
    snapshot: Snapshot,
    load_error: bool,
    settled: bool,
}

impl Children {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = Some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.waiting.clear();
        self.report_copy = ReportCopy::Idle;
        self.expanded_report = ReportExpand::Idle;
        self.pending_nav = None;
    }

    pub(crate) fn cancel_copy(&mut self) {
        note_clipboard_write();
        self.report_copy = ReportCopy::Idle;
    }

    pub(super) fn take_ready_copy(&mut self, key: &CopyKey) -> Option<String> {
        match &self.report_copy {
            ReportCopy::Ready { key: current, .. } if current == key => {
                note_clipboard_write();
                match std::mem::take(&mut self.report_copy) {
                    ReportCopy::Ready { text, .. } => Some(text),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    pub(super) fn copy_failed(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Failed { key: current } if current == key)
    }

    pub(super) fn copy_ready(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Ready { key: current, .. } if current == key)
    }

    pub(super) fn loaded_report(&self, key: &ReportCopyKey) -> Option<&str> {
        match &self.expanded_report {
            ReportExpand::Loaded { key: current, text } if current == key => Some(text.as_str()),
            _ => None,
        }
    }

    pub(super) fn expand_failed(&self, key: &ReportCopyKey) -> bool {
        matches!(&self.expanded_report, ReportExpand::Failed { key: current } if current == key)
    }

    pub(super) fn release(s: &mut State, key: &str) {
        let prefix = format!("{key}-");
        let children = &mut s.transcript_display.children;
        children.entries.retain(|_, entry| {
            entry
                .cards
                .retain(|card, _| card != key && !card.starts_with(&prefix));
            !entry.cards.is_empty()
        });
        children
            .waiting
            .retain(|(_, card, _)| card != key && !card.starts_with(&prefix));
        let matches_card = |ui_key: &str| {
            ui_key
                .strip_prefix("copy-")
                .and_then(|rest| {
                    rest.strip_suffix("-output")
                        .or_else(|| rest.strip_suffix("-steps"))
                })
                .is_some_and(|card| card == key || card.starts_with(&prefix))
        };
        let clear_copy = match &children.report_copy {
            ReportCopy::Loading { key: current, .. }
            | ReportCopy::Ready { key: current, .. }
            | ReportCopy::Failed { key: current } => match current {
                CopyKey::Report(k) => matches_card(&k.key),
                CopyKey::Steps { key: k, .. } => matches_card(k),
            },
            ReportCopy::Idle => false,
        };
        if clear_copy {
            children.report_copy = ReportCopy::Idle;
        }
        let clear_expand = match &children.expanded_report {
            ReportExpand::Loading { key: current, .. }
            | ReportExpand::Loaded { key: current, .. }
            | ReportExpand::Failed { key: current } => matches_card(&current.key),
            ReportExpand::Idle => false,
        };
        if clear_expand {
            children.expanded_report = ReportExpand::Idle;
        }
        Self::promote_waiting(s);
    }

    fn card_lease(&self, ui_key: &str) -> Option<Weak<()>> {
        let card = ui_key.strip_prefix("copy-").and_then(|rest| {
            rest.strip_suffix("-output")
                .or_else(|| rest.strip_suffix("-steps"))
        })?;
        self.entries
            .values()
            .find_map(|entry| entry.cards.get(card).cloned())
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(_, wkey, _)| wkey == card)
                    .map(|(_, _, lease)| lease.clone())
            })
    }

    fn fetch_report(
        s: &State,
        key: &ReportCopyKey,
    ) -> Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)> {
        let backend = s.transcript_display.children.backend.clone()?;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let (parent, row_id, part_index, child) = (
            key.parent.clone(),
            key.row_id.clone(),
            key.part_index,
            key.child.clone(),
        );
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let body = with_timeout(COPY_BUDGET, async {
                    let _slot = reads.background(&cancelled).await?;
                    backend
                        .child_page(&parent)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|page| {
                            page.rows
                                .iter()
                                .find(|row| row.id == row_id)
                                .and_then(|row| {
                                    row.parts
                                        .get(part_index)
                                        .and_then(|part| match part {
                                            Part::SubagentReport(report)
                                                if report.child == child =>
                                            {
                                                Some(report.body.clone())
                                            }
                                            _ => None,
                                        })
                                        .or_else(|| {
                                            row.parts.iter().rev().find_map(|part| match part {
                                                Part::SubagentReport(report)
                                                    if report.child == child =>
                                                {
                                                    Some(report.body.clone())
                                                }
                                                _ => None,
                                            })
                                        })
                                })
                        })
                })
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
        Some((cancel, rx))
    }

    pub(super) fn copy_report(s: &mut State, key: ReportCopyKey) {
        let lease = s.transcript_display.children.card_lease(&key.key);
        let copy_key = CopyKey::Report(key.clone());
        let Some((cancel, rx)) = Self::fetch_report(s, &key) else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let epoch = CLIPBOARD_EPOCH.load(Ordering::SeqCst);
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            lease,
            _cancel: cancel,
            rx,
        };
    }

    pub(super) fn copy_steps(s: &mut State, key: String, parent: Option<String>, child: String) {
        let lease = s.transcript_display.children.card_lease(&key);
        let copy_key = CopyKey::Steps {
            key,
            parent: parent.clone(),
            child: child.clone(),
        };
        if matches!(&s.transcript_display.children.report_copy, ReportCopy::Loading { key: current, .. } if current == &copy_key)
        {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let epoch = CLIPBOARD_EPOCH.load(Ordering::SeqCst);
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            lease,
            _cancel: cancel,
            rx,
        };
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let expected_parent = parent.as_deref().unwrap_or(&backend.session);
                let body = with_timeout(
                    COPY_BUDGET,
                    copy_child_steps_bounded(&backend, &reads, &cancelled, &child, expected_parent),
                )
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn open_child(s: &mut State, parent: Option<&str>, child: &str, _tx: &mut rune::Tx) {
        if !crate::launcher::can_open_child_session(s) {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            return;
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        s.transcript_display.children.pending_nav = Some((cancel, rx));
        let expected_parent = parent.map_or_else(|| backend.session.clone(), str::to_owned);
        let child = child.to_owned();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                let target = matches!(
                    backend
                        .child_ownership_token(&child, &expected_parent)
                        .await,
                    Ok(Some(_))
                )
                .then_some(child);
                if out.send(target).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn expand_report(s: &mut State, key: ReportCopyKey) {
        if matches!(&s.transcript_display.children.expanded_report, ReportExpand::Loading { key: current, .. } if current == &key)
        {
            return;
        }
        let Some((cancel, rx)) = Self::fetch_report(s, &key) else {
            s.transcript_display.children.expanded_report = ReportExpand::Failed { key };
            return;
        };
        s.transcript_display.children.expanded_report = ReportExpand::Loading {
            key,
            _cancel: cancel,
            rx,
        };
    }

    pub(crate) fn poll_actions(s: &mut State, tx: &mut rune::Tx) -> bool {
        let mut changed = s.transcript_display.children.poll_copy(tx);
        let nav = match s.transcript_display.children.pending_nav.as_ref() {
            Some((_, rx)) => match rx.try_recv() {
                Ok(target) => Some(target),
                Err(error) if error.is_closed() => Some(None),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(target) = nav {
            s.transcript_display.children.pending_nav = None;
            if let Some(child_id) = target
                && crate::launcher::can_open_child_session(s)
            {
                crate::launcher::choose_child(s, child_id, tx);
                changed = true;
            }
        }
        changed
    }

    fn poll_copy(&mut self, tx: &mut rune::Tx) -> bool {
        let outcome = match &self.report_copy {
            ReportCopy::Loading {
                epoch, lease, rx, ..
            } => {
                if lease.as_ref().is_some_and(|w| w.strong_count() == 0)
                    || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != *epoch
                {
                    self.report_copy = ReportCopy::Idle;
                    return false;
                }
                match rx.try_recv() {
                    Ok(body) => Some(body),
                    Err(error) if error.is_closed() => Some(None),
                    Err(_) => return false,
                }
            }
            _ => return false,
        };
        let (key, epoch, lease) = match std::mem::take(&mut self.report_copy) {
            ReportCopy::Loading {
                key, epoch, lease, ..
            } => (key, epoch, lease),
            _ => return false,
        };
        if lease.as_ref().is_some_and(|w| w.strong_count() == 0)
            || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch
        {
            return false;
        }
        match outcome {
            Some(Some(text)) => {
                #[cfg(not(target_arch = "wasm32"))]
                {
                    note_clipboard_write();
                    tx.copy(text);
                }
                #[cfg(target_arch = "wasm32")]
                {
                    let _ = tx;
                    self.report_copy = ReportCopy::Ready { key, text };
                }
                true
            }
            _ => {
                self.report_copy = ReportCopy::Failed { key };
                true
            }
        }
    }

    pub(super) fn lease(&self, parent: Option<&str>, id: &str, key: &str) -> Rc<()> {
        let ck = child_key(parent, id);
        self.entries
            .get(&ck)
            .and_then(|entry| entry.cards.get(key))
            .and_then(Weak::upgrade)
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(wck, wkey, _)| *wck == ck && wkey == key)
                    .and_then(|(_, _, lease)| lease.upgrade())
            })
            .unwrap_or_default()
    }

    pub(super) fn demand(
        s: &mut State,
        parent: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let wake = s.wake.clone();
        let ck = child_key(parent, id);
        let children = &mut s.transcript_display.children;
        let freed = children.prune();
        if !visible {
            let mut removed = false;
            if let Some(entry) = children.entries.get_mut(&ck) {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(&ck);
                    removed = true;
                }
            }
            children
                .waiting
                .retain(|(wck, wkey, _)| !(*wck == ck && wkey == key));
            if freed || removed {
                Self::promote_waiting(s);
            }
            return;
        }
        let needs_watch = if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            Some(matches!(entry.watch, WatchState::Pending))
        } else {
            None
        };
        if let Some(needs_watch) = needs_watch {
            if needs_watch {
                if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                    children.enqueue_waiting(ck, key, lease);
                } else {
                    Self::start_entry(s, ck, key, lease);
                }
            } else if freed {
                Self::promote_waiting(s);
            }
            return;
        }
        if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
            children.enqueue_waiting(ck, key, lease);
            return;
        }
        Self::start_entry(s, ck, key, lease);
    }

    fn enqueue_waiting(&mut self, ck: ChildKey, key: &str, lease: &Rc<()>) {
        self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
        if let Some(existing) = self
            .waiting
            .iter_mut()
            .find(|(wck, wkey, _)| *wck == ck && wkey == key)
        {
            existing.2 = Rc::downgrade(lease);
        } else if self.waiting.len() < WAITING_LIMIT {
            self.waiting
                .push_back((ck, key.into(), Rc::downgrade(lease)));
        }
    }

    pub(super) fn retry(s: &mut State, parent: Option<&str>, id: &str) {
        let ck = child_key(parent, id);
        if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
            entry.load_error = false;
            if let WatchState::Active(watcher) = &entry.watch {
                let _ = watcher.retry.try_send(());
                return;
            }
            entry.watch = WatchState::Pending;
            if let Some((card, lease)) = entry
                .cards
                .iter()
                .find_map(|(k, w)| w.upgrade().map(|l| (k.clone(), l)))
            {
                Self::demand(s, parent, id, &card, &lease, true);
            }
        }
    }

    fn active_watchers(&self) -> usize {
        self.entries
            .values()
            .filter(|e| matches!(e.watch, WatchState::Active(_)))
            .count()
    }

    fn dormant_watch(&self, child: &str, wake: &codenomad_client::Wake) -> WatchState {
        let Some(backend) = self.backend.as_ref() else {
            return WatchState::Pending;
        };
        let Some((dirty, settlement)) = backend.watch_child(child) else {
            return WatchState::Pending;
        };
        let (out, wake_rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let wake = wake.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                if dirty.recv().await.is_ok() {
                    let (_, _, _, _, revoked) = settlement.take();
                    if out.send(revoked).await.is_ok() {
                        wake();
                    }
                }
            })
            .await;
        });
        WatchState::Dormant {
            _cancel: cancel,
            wake: wake_rx,
        }
    }

    fn demote_settled(&mut self, wake: &codenomad_client::Wake) -> bool {
        let candidate = self
            .entries
            .iter()
            .find(|(_, e)| matches!(e.watch, WatchState::Active(_)) && e.settled)
            .map(|(k, _)| k.clone());
        let Some(key) = candidate else {
            return false;
        };
        // Register the dormant SSE watch before dropping the active watcher so no wake is missed.
        let dormant = self.dormant_watch(&key.1, wake);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.watch = dormant;
            return true;
        }
        false
    }

    fn promote_waiting(s: &mut State) {
        let wake = s.wake.clone();
        loop {
            let next = loop {
                let Some((ck, key, weak)) = s.transcript_display.children.waiting.pop_front()
                else {
                    return;
                };
                if let Some(lease) = weak.upgrade() {
                    break (ck, key, lease);
                }
            };
            let (ck, key, lease) = next;
            let needs_start =
                if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
                    entry.cards.insert(key.clone(), Rc::downgrade(&lease));
                    matches!(entry.watch, WatchState::Pending)
                } else {
                    true
                };
            if !needs_start {
                continue;
            }
            let children = &mut s.transcript_display.children;
            if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                children
                    .waiting
                    .push_front((ck, key, Rc::downgrade(&lease)));
                return;
            }
            if !Self::start_entry(s, ck, &key, &lease) {
                break;
            }
        }
    }

    fn start_entry(s: &mut State, ck: ChildKey, key: &str, lease: &Rc<()>) -> bool {
        let children = &mut s.transcript_display.children;
        let Some(backend) = children.backend.clone() else {
            return false;
        };
        let Some((dirty, settlement)) = backend.watch_child(&ck.1) else {
            return false;
        };
        let (out, result) = bounded(2);
        let (cancel, cancelled) = bounded(1);
        let (retry, retry_rx) = bounded(1);
        let (expected_parent, child) = ck.clone();
        let watcher = Watcher {
            _cancel: cancel,
            retry,
            result,
        };
        if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            entry.watch = WatchState::Active(watcher);
            entry.load_error = false;
            entry.settled = false;
        } else {
            while children.entries.len() >= RETAINED_LIMIT {
                let evict = children
                    .entries
                    .iter()
                    .find(|(_, e)| !matches!(e.watch, WatchState::Active(_)))
                    .map(|(k, _)| k.clone());
                let Some(evict) = evict else {
                    break;
                };
                children.entries.remove(&evict);
            }
            children.entries.insert(
                ck,
                Entry {
                    cards: HashMap::from([(key.into(), Rc::downgrade(lease))]),
                    watch: WatchState::Active(watcher),
                    snapshot: Snapshot::default(),
                    load_error: false,
                    settled: false,
                },
            );
        }
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let mut owed_calls: HashMap<(Option<String>, String), (u8, Option<u64>)> =
                    HashMap::new();
                let mut frozen_ends: HashMap<(Option<String>, String), u64> = HashMap::new();
                let mut pending_events = Vec::new();
                let mut pending_bytes = 0usize;
                let mut execution_owed = 0u8;
                let mut last_exec_end: Option<u64> = None;
                let mut live_page: Option<crate::history::Page> = None;
                loop {
                    let (ended_calls, tool_events, exec_ended, exec_ended_at, revoked) =
                        settlement.take();
                    if revoked {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                    } else {
                        for end in ended_calls {
                            let key = (end.message, end.call);
                            if let Some(ts) = end.ended
                                && (frozen_ends.contains_key(&key) || frozen_ends.len() < 128)
                            {
                                frozen_ends.entry(key.clone()).or_insert(ts);
                            }
                            if owed_calls.contains_key(&key) || owed_calls.len() < 64 {
                                let entry = owed_calls.entry(key).or_insert((0, end.ended));
                                if entry.1.is_none() {
                                    entry.1 = end.ended;
                                }
                            }
                        }
                        if exec_ended {
                            execution_owed = 3;
                            last_exec_end =
                                exec_ended_at.or(Some(crate::platform::storage::unix_millis()));
                        }
                        if !tool_events.is_empty() {
                            let mut changed = false;
                            let mut overflowed = false;
                            for ev in tool_events {
                                let applied = live_page.as_mut().is_some_and(|page| {
                                    codenomad_client::content::apply_tool_event(
                                        &mut page.rows,
                                        ev.message.as_deref(),
                                        &ev.kind,
                                        &ev.data,
                                        ev.at,
                                    )
                                });
                                if applied {
                                    if live_page.as_ref().is_some_and(|page| {
                                        codenomad_client::history::check(&page.rows).is_err()
                                    }) {
                                        live_page = None;
                                        overflowed = true;
                                        break;
                                    }
                                    changed = true;
                                } else if pending_events.len() < MAX_PENDING_EVENTS
                                    && pending_bytes.saturating_add(ev.bytes) <= MAX_PENDING_BYTES
                                {
                                    pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                    pending_events.push((0, ev));
                                }
                            }
                            if !overflowed
                                && changed
                                && let Some(page) = live_page.as_ref()
                            {
                                let snap = snapshot_with_frozen(page.clone(), &frozen_ends);
                                if out
                                    .try_send(ChildUpdate::Loaded {
                                        snapshot: snap,
                                        settled: false,
                                    })
                                    .is_ok()
                                {
                                    wake();
                                }
                            }
                        }
                    }
                    let rev_before = settlement.revocation_gen();
                    let fetched = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        let parent_id = expected_parent.as_deref().unwrap_or(&backend.session);
                        backend.child_page_under(&child, parent_id).await
                    };
                    if settlement.revocation_gen() != rev_before {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                        let _ = dirty.try_recv();
                        continue;
                    }
                    let (update, last_settled, last_running, last_failed) = match fetched {
                        Ok(Some(mut page)) => {
                            owed_calls.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            frozen_ends.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            if execution_owed > 0 {
                                let turn_start = page
                                    .rows
                                    .iter()
                                    .rposition(|r| r.role == "user")
                                    .map_or(0, |idx| idx + 1);
                                if !page.running {
                                    for row in &page.rows[turn_start..] {
                                        for part in &row.parts {
                                            if let Part::Tool(tool) = part
                                                && matches!(
                                                    tool.status.as_str(),
                                                    "pending" | "streaming" | "running"
                                                )
                                            {
                                                let k = (Some(row.id.clone()), tool.id.clone());
                                                if let Some(ts) = last_exec_end
                                                    && tool.started.is_none_or(|start| start <= ts)
                                                    && (frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128)
                                                {
                                                    frozen_ends.entry(k.clone()).or_insert(ts);
                                                }
                                                if owed_calls.len() < 64 {
                                                    owed_calls
                                                        .entry(k)
                                                        .or_insert((0, last_exec_end));
                                                }
                                            }
                                        }
                                    }
                                    execution_owed = 0;
                                    last_exec_end = None;
                                } else {
                                    if let Some(ts) = last_exec_end {
                                        for row in &page.rows[turn_start..] {
                                            for part in &row.parts {
                                                if let Part::Tool(tool) = part
                                                    && matches!(
                                                        tool.status.as_str(),
                                                        "streaming" | "running"
                                                    )
                                                    && tool.started.is_some_and(|start| start <= ts)
                                                {
                                                    let k = (Some(row.id.clone()), tool.id.clone());
                                                    if frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128
                                                    {
                                                        frozen_ends.entry(k).or_insert(ts);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    execution_owed -= 1;
                                    if execution_owed == 0 {
                                        last_exec_end = None;
                                    }
                                }
                            }
                            if let Some(prior) = live_page.as_ref() {
                                let mut merged = page.rows.clone();
                                if codenomad_client::content::merge_page(&prior.rows, &mut merged)
                                    .is_ok()
                                {
                                    page.rows = merged;
                                }
                            }
                            if !pending_events.is_empty() {
                                let mut kept = Vec::new();
                                pending_bytes = 0;
                                for (age, ev) in pending_events.drain(..) {
                                    let applied = codenomad_client::content::apply_tool_event(
                                        &mut page.rows,
                                        ev.message.as_deref(),
                                        &ev.kind,
                                        &ev.data,
                                        ev.at,
                                    );
                                    if !applied && age < 2 {
                                        pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                        kept.push((age + 1, ev));
                                    }
                                }
                                pending_events = kept;
                                if codenomad_client::history::check(&page.rows).is_err() {
                                    live_page = None;
                                    pending_events.clear();
                                    pending_bytes = 0;
                                    continue;
                                }
                            }
                            let settled = !page.running
                                && owed_calls.is_empty()
                                && execution_owed == 0
                                && pending_events.is_empty();
                            let running = page.running;
                            live_page = Some(page.clone());
                            (
                                ChildUpdate::Loaded {
                                    snapshot: snapshot_with_frozen(page, &frozen_ends),
                                    settled,
                                },
                                settled,
                                running,
                                false,
                            )
                        }
                        Ok(None) => {
                            owed_calls.clear();
                            frozen_ends.clear();
                            pending_events.clear();
                            pending_bytes = 0;
                            execution_owed = 0;
                            last_exec_end = None;
                            live_page = None;
                            (
                                ChildUpdate::Loaded {
                                    snapshot: Snapshot::default(),
                                    settled: true,
                                },
                                true,
                                false,
                                false,
                            )
                        }
                        Err(_) => {
                            if execution_owed > 0 {
                                execution_owed -= 1;
                                if execution_owed == 0 {
                                    last_exec_end = None;
                                }
                            }
                            (ChildUpdate::Failed, false, false, true)
                        }
                    };
                    if out.send(update).await.is_err() {
                        break;
                    }
                    wake();
                    let mut max_attempt = 0u8;
                    owed_calls.retain(|_, (attempts, _)| {
                        *attempts = attempts.saturating_add(1);
                        if *attempts <= 3 {
                            max_attempt = max_attempt.max(*attempts);
                            true
                        } else {
                            false
                        }
                    });
                    if !owed_calls.is_empty() || execution_owed > 0 {
                        let step = max_attempt.max(1);
                        let delay = Duration::from_millis(100 * u64::from(step));
                        runtime::sleep(delay).await;
                        let _ = dirty.try_recv();
                        let _ = retry_rx.try_recv();
                        continue;
                    }
                    if !last_settled
                        && !last_running
                        && !last_failed
                        && pending_events.is_empty()
                        && live_page.is_some()
                    {
                        if out.send(ChildUpdate::Settled).await.is_err() {
                            break;
                        }
                        wake();
                    }
                    if !wait_wake(&dirty, &retry_rx).await {
                        break;
                    }
                    runtime::sleep(Duration::from_millis(100)).await;
                    let _ = dirty.try_recv();
                    let _ = retry_rx.try_recv();
                }
            })
            .await;
        });
        true
    }

    pub(crate) fn poll_and_promote(s: &mut State) -> bool {
        let changed = s.transcript_display.children.poll();
        Self::promote_waiting(s);
        changed
    }

    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = self.prune();
        let mut to_requeue: Vec<(ChildKey, String, Weak<()>)> = Vec::new();
        for (ck, entry) in self.entries.iter_mut() {
            match &mut entry.watch {
                WatchState::Active(watcher) => {
                    while let Ok(update) = watcher.result.try_recv() {
                        match update {
                            ChildUpdate::Loaded {
                                snapshot: next,
                                settled,
                            } => {
                                changed |= entry.load_error
                                    || entry.settled != settled
                                    || entry.snapshot != next;
                                entry.load_error = false;
                                entry.settled = settled;
                                entry.snapshot = next;
                            }
                            ChildUpdate::Settled => {
                                changed |= !entry.settled;
                                entry.settled = true;
                            }
                            ChildUpdate::Unverified => {
                                changed |= entry.load_error
                                    || entry.settled
                                    || entry.snapshot != Snapshot::default();
                                entry.snapshot = Snapshot::default();
                                entry.load_error = false;
                                entry.settled = false;
                            }
                            ChildUpdate::Failed => {
                                changed |= !entry.load_error;
                                entry.load_error = true;
                            }
                        }
                    }
                }
                WatchState::Dormant { wake, .. } => {
                    let triggered = match wake.try_recv() {
                        Ok(revoked) => Some(revoked),
                        Err(error) if error.is_closed() => Some(false),
                        Err(_) => None,
                    };
                    if let Some(revoked) = triggered {
                        if revoked {
                            changed |= entry.load_error || entry.snapshot != Snapshot::default();
                            entry.snapshot = Snapshot::default();
                            entry.load_error = false;
                        }
                        entry.settled = false;
                        entry.watch = WatchState::Pending;
                        if let Some((card, lease)) =
                            entry.cards.iter().find(|(_, w)| w.strong_count() > 0)
                        {
                            to_requeue.push((ck.clone(), card.clone(), lease.clone()));
                        }
                    }
                }
                WatchState::Pending => {}
            }
        }
        if !to_requeue.is_empty() {
            self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
            for (ck, card, lease) in to_requeue {
                if !self.waiting.iter().any(|(wck, _, _)| *wck == ck)
                    && self.waiting.len() < WAITING_LIMIT
                {
                    self.waiting.push_back((ck, card, lease));
                }
            }
        }
        let expand_outcome = match &self.expanded_report {
            ReportExpand::Loading { rx, .. } => match rx.try_recv() {
                Ok(body) => Some(body),
                Err(error) if error.is_closed() => Some(None),
                Err(_) => None,
            },
            _ => None,
        };
        if let Some(outcome) = expand_outcome
            && let ReportExpand::Loading { key, .. } = std::mem::take(&mut self.expanded_report)
        {
            self.expanded_report = match outcome {
                Some(text) => ReportExpand::Loaded { key, text },
                None => ReportExpand::Failed { key },
            };
            changed = true;
        }
        changed
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        let before = self.entries.len();
        self.entries.retain(|_, entry| {
            entry.cards.retain(|_, lease| lease.strong_count() > 0);
            !entry.cards.is_empty()
        });
        before != self.entries.len()
    }

    pub(super) fn steps(&self, parent: Option<&str>, id: &str) -> &[(String, Arc<Tool>)] {
        self.entries
            .get(&child_key(parent, id))
            .map_or(&[], |entry| entry.snapshot.steps.as_slice())
    }

    pub(super) fn steps_truncated(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.snapshot.steps_truncated)
    }

    pub(super) fn steps_incomplete(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.snapshot.steps_incomplete)
    }

    pub(super) fn load_error(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.load_error)
    }

    pub(super) fn reports(&self, parent: Option<&str>, id: &str) -> &[ChildReport] {
        self.entries
            .get(&child_key(parent, id))
            .map_or(&[], |entry| entry.snapshot.reports.as_slice())
    }
}

async fn wait_wake(dirty: &Receiver<()>, retry: &Receiver<()>) -> bool {
    use std::{future::Future, task::Poll};
    let mut d = std::pin::pin!(dirty.recv());
    let mut r = std::pin::pin!(retry.recv());
    std::future::poll_fn(|cx| {
        if let Poll::Ready(res) = d.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        if let Poll::Ready(res) = r.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        Poll::Pending
    })
    .await
}

fn snapshot_with_frozen(
    page: crate::history::Page,
    frozen_ends: &HashMap<(Option<String>, String), u64>,
) -> Snapshot {
    let mut snap = snapshot(page);
    for ((msg, call), &ts) in frozen_ends {
        let target = if let Some(msg) = msg.as_deref() {
            snap.steps
                .iter_mut()
                .find(|(row_id, tool)| row_id == msg && tool.id == *call)
        } else {
            snap.steps
                .iter_mut()
                .rev()
                .find(|(_, tool)| tool.id == *call)
        };
        if let Some((_, tool)) = target
            && matches!(tool.status.as_str(), "streaming" | "running")
            && tool.ended.is_none()
            && tool.started.is_none_or(|start| start <= ts)
        {
            Arc::make_mut(tool).ended = Some(ts);
        }
    }
    snap
}

fn child_tool_settled(rows: &[crate::history::Row], message: Option<&str>, call: &str) -> bool {
    let tool = if let Some(msg) = message {
        rows.iter().find(|row| row.id == msg).and_then(|row| {
            row.parts.iter().find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
        })
    } else {
        rows.iter()
            .rev()
            .flat_map(|row| row.parts.iter().rev())
            .find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
    };
    tool.is_some_and(|tool| !matches!(tool.status.as_str(), "pending" | "streaming" | "running"))
}

fn snapshot(page: crate::history::Page) -> Snapshot {
    let mut remaining = STEP_BYTES;
    let mut steps_truncated = false;
    let mut tools: Steps = Vec::new();
    for (row, tool) in page.rows.iter().rev().flat_map(|row| {
        row.parts.iter().rev().filter_map(move |part| match part {
            Part::Tool(tool) => Some((row, tool)),
            _ => None,
        })
    }) {
        if tools.len() >= STEP_LIMIT {
            steps_truncated = true;
            break;
        }
        let Some(next) = remaining.checked_sub(tool.retained_bytes()) else {
            steps_truncated = true;
            break;
        };
        remaining = next;
        tools.push((row.id.clone(), tool.clone()));
    }
    tools.reverse();
    let raw_reports: Vec<_> =
        page.rows
            .iter()
            .rev()
            .flat_map(|row| {
                row.parts.iter().enumerate().rev().filter_map(
                    move |(part_index, part)| match part {
                        Part::SubagentReport(report) => Some((row, part_index, report)),
                        _ => None,
                    },
                )
            })
            .take(STEP_LIMIT)
            .collect();
    // Shortest-first water-filling keeps short older reports intact even beside giant ones.
    let mut order: Vec<usize> = (0..raw_reports.len()).collect();
    order.sort_by_key(|&i| raw_reports[i].2.body.len());
    let mut caps = vec![0usize; raw_reports.len()];
    let mut report_bytes = STEP_BYTES;
    for (pos, &idx) in order.iter().enumerate() {
        let share = report_bytes / (order.len() - pos);
        let len = raw_reports[idx].2.body.len();
        let take = len.min(share);
        caps[idx] = take;
        report_bytes -= take;
    }
    let mut reports: Reports = raw_reports
        .into_iter()
        .enumerate()
        .map(|(idx, (row, part_index, report))| {
            let cap = caps[idx];
            let (body, truncated) = if report.body.len() <= cap {
                (report.body.clone(), false)
            } else {
                let end = report.body.floor_char_boundary(cap);
                (report.body[..end].to_owned(), true)
            };
            ChildReport {
                row_id: row.id.clone(),
                part_index,
                report: Arc::new(SubagentReport {
                    child: report.child.clone(),
                    state: report.state.clone(),
                    body,
                    created: report.created,
                }),
                truncated,
            }
        })
        .collect();
    reports.reverse();
    Snapshot {
        steps: tools,
        steps_truncated,
        steps_incomplete: steps_truncated || page.older.is_some(),
        reports,
    }
}

async fn with_timeout<T>(
    budget: Duration,
    fut: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    use std::{future::Future, task::Poll};
    let mut fut = std::pin::pin!(fut);
    let mut timer = std::pin::pin!(runtime::sleep(budget));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = fut.as_mut().poll(cx) {
            return Poll::Ready(value);
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

async fn copy_child_steps_bounded(
    backend: &Backend,
    reads: &crate::platform::reads::Reads,
    cancelled: &Receiver<()>,
    child: &str,
    expected_parent: &str,
) -> Option<String> {
    use std::{collections::HashSet, io};
    struct Limited(Vec<u8>, usize);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > self.1 {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let deadline = runtime::Instant::now() + COPY_BUDGET;
    let location = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()??
    };
    let mut out = Limited(Vec::new(), MAX_COPY_BYTES);
    io::Write::write_all(&mut out, b"[\n").ok()?;
    let mut count = 0usize;
    let mut seen_rows = HashSet::new();
    let mut cursor = Some(serde_json::json!({"kind": "oldest"}));
    let mut seen_cursors = HashSet::new();
    for _ in 0..MAX_COPY_PAGES {
        if runtime::Instant::now() >= deadline {
            return None;
        }
        let Some(request) = cursor.take() else {
            break;
        };
        if !seen_cursors.insert(request.to_string()) {
            return None;
        }
        let page = {
            let _slot = reads.background(cancelled).await?;
            backend.child_page_request(child, request).await.ok()?
        };
        for row in &page.rows {
            if !seen_rows.insert(row.id.clone()) {
                continue;
            }
            for part in &row.parts {
                let Part::Tool(tool) = part else {
                    continue;
                };
                if count > 0 {
                    io::Write::write_all(&mut out, b",\n").ok()?;
                }
                let mut state = serde_json::json!({
                    "status": tool.status,
                    "input": tool.input,
                    "output": tool.output,
                    "error": tool.error,
                    "metadata": tool.metadata,
                });
                if tool.started.is_some() || tool.ended.is_some() {
                    let mut time = serde_json::Map::new();
                    if let Some(start) = tool.started {
                        time.insert("start".into(), serde_json::json!(start));
                    }
                    if let Some(end) = tool.ended {
                        time.insert("end".into(), serde_json::json!(end));
                    }
                    state["time"] = serde_json::Value::Object(time);
                }
                let entry = serde_json::json!({
                    "type": "tool",
                    "id": tool.id,
                    "callID": tool.id,
                    "sessionID": child,
                    "messageID": row.id,
                    "tool": tool.name,
                    "state": state,
                });
                serde_json::to_writer_pretty(&mut out, &entry).ok()?;
                count += 1;
            }
        }
        cursor = page.newer;
    }
    if cursor.is_some() || runtime::Instant::now() >= deadline {
        return None;
    }
    io::Write::write_all(&mut out, if count > 0 { b"\n]" } else { b"]" }).ok()?;
    let still_owned = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()?
    };
    (still_owned == Some(location))
        .then(|| String::from_utf8(out.0).ok())
        .flatten()
}

#[cfg(test)]
impl Children {
    pub(super) fn install(&mut self, child: &str, page: crate::history::Page) -> Rc<()> {
        let lease = Rc::default();
        let (out, result) = bounded(1);
        out.try_send(ChildUpdate::Loaded {
            snapshot: snapshot(page),
            settled: true,
        })
        .unwrap();
        let (cancel, _) = bounded(1);
        let (retry, _) = bounded(1);
        self.entries.insert(
            child_key(None, child),
            Entry {
                cards: HashMap::from([("test".into(), Rc::downgrade(&lease))]),
                watch: WatchState::Active(Watcher {
                    _cancel: cancel,
                    retry,
                    result,
                }),
                snapshot: Snapshot::default(),
                load_error: false,
                settled: true,
            },
        );
        lease
    }
}
