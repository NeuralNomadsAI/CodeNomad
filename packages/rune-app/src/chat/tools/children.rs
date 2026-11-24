use crate::{
    State,
    backend::Backend,
    content::{Part, SubagentReport, Tool},
};
use codenomad_client::{Receiver, bounded, runtime};
use std::{
    collections::{HashMap, VecDeque},
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

pub(super) const STEP_LIMIT: usize = 200;
const CHILD_LIMIT: usize = 4;
const WAITING_LIMIT: usize = 32;
const STEP_BYTES: usize = 2 << 20;
type Steps = Vec<(String, Arc<Tool>)>;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ReportCopyKey {
    pub key: String,
    pub parent: String,
    pub row_id: String,
    pub part_index: usize,
    pub child: String,
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
    reports: Reports,
}

enum ReportCopy {
    Idle,
    Loading {
        key: ReportCopyKey,
        _cancel: codenomad_client::Sender<()>,
        rx: Receiver<Option<String>>,
    },
    #[allow(dead_code)]
    Ready {
        key: ReportCopyKey,
        text: String,
    },
    Failed {
        key: ReportCopyKey,
    },
}

impl Default for ReportCopy {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    entries: HashMap<String, Entry>,
    waiting: VecDeque<(String, String, Weak<()>)>,
    report_copy: ReportCopy,
}

struct Entry {
    cards: HashMap<String, Weak<()>>,
    _cancel: codenomad_client::Sender<()>,
    result: Receiver<Option<Snapshot>>,
    snapshot: Snapshot,
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
    }

    pub(crate) fn cancel_copy(&mut self) {
        self.report_copy = ReportCopy::Idle;
    }

    pub(super) fn take_ready_report(&mut self, key: &ReportCopyKey) -> Option<String> {
        match &self.report_copy {
            ReportCopy::Ready { key: current, .. } if current == key => {
                match std::mem::take(&mut self.report_copy) {
                    ReportCopy::Ready { text, .. } => Some(text),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    pub(super) fn copy_failed(&self, key: &ReportCopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Failed { key: current } if current == key)
    }

    pub(super) fn copy_ready(&self, key: &ReportCopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Ready { key: current, .. } if current == key)
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
        Self::promote_waiting(s);
    }

    pub(super) fn copy_report(s: &mut State, key: ReportCopyKey) {
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key };
            return;
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let (parent, row_id, part_index, child) = (
            key.parent.clone(),
            key.row_id.clone(),
            key.part_index,
            key.child.clone(),
        );
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key,
            _cancel: cancel,
            rx,
        };
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                let body = backend
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
                                        Part::SubagentReport(report) if report.child == child => {
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
                    });
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(crate) fn poll_copy(&mut self, tx: &mut rune::Tx) -> bool {
        let outcome = match &self.report_copy {
            ReportCopy::Loading { rx, .. } => match rx.try_recv() {
                Ok(body) => Some(body),
                Err(error) if error.is_closed() => Some(None),
                Err(_) => return false,
            },
            _ => return false,
        };
        let key = match std::mem::take(&mut self.report_copy) {
            ReportCopy::Loading { key, .. } => key,
            _ => return false,
        };
        match outcome {
            Some(Some(text)) => {
                #[cfg(not(target_arch = "wasm32"))]
                {
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

    pub(super) fn lease(&self, id: &str, key: &str) -> Rc<()> {
        self.entries
            .get(id)
            .and_then(|entry| entry.cards.get(key))
            .and_then(Weak::upgrade)
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(wid, wkey, _)| wid == id && wkey == key)
                    .and_then(|(_, _, lease)| lease.upgrade())
            })
            .unwrap_or_default()
    }

    pub(super) fn demand(s: &mut State, id: &str, key: &str, lease: &Rc<()>, visible: bool) {
        let children = &mut s.transcript_display.children;
        let freed = children.prune();
        if !visible {
            let mut removed = false;
            if let Some(entry) = children.entries.get_mut(id) {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(id);
                    removed = true;
                }
            }
            children
                .waiting
                .retain(|(wid, wkey, _)| !(wid == id && wkey == key));
            if freed || removed {
                Self::promote_waiting(s);
            }
            return;
        }
        if let Some(entry) = children.entries.get_mut(id) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            if freed {
                Self::promote_waiting(s);
            }
            return;
        }
        if children.entries.len() >= CHILD_LIMIT {
            children.waiting.retain(|(_, _, w)| w.strong_count() > 0);
            if let Some(existing) = children
                .waiting
                .iter_mut()
                .find(|(wid, wkey, _)| wid == id && wkey == key)
            {
                existing.2 = Rc::downgrade(lease);
            } else if children.waiting.len() < WAITING_LIMIT {
                children
                    .waiting
                    .push_back((id.into(), key.into(), Rc::downgrade(lease)));
            }
            return;
        }
        Self::start_entry(s, id, key, lease);
    }

    fn promote_waiting(s: &mut State) {
        while s.transcript_display.children.entries.len() < CHILD_LIMIT {
            let next = loop {
                let Some((id, key, weak)) = s.transcript_display.children.waiting.pop_front()
                else {
                    return;
                };
                if let Some(lease) = weak.upgrade() {
                    break (id, key, lease);
                }
            };
            let (id, key, lease) = next;
            if let Some(entry) = s.transcript_display.children.entries.get_mut(&id) {
                entry.cards.insert(key, Rc::downgrade(&lease));
            } else if !Self::start_entry(s, &id, &key, &lease) {
                break;
            }
        }
    }

    fn start_entry(s: &mut State, id: &str, key: &str, lease: &Rc<()>) -> bool {
        let children = &mut s.transcript_display.children;
        let Some(backend) = children.backend.clone() else {
            return false;
        };
        let Some((dirty, settlement)) = backend.watch_child(id) else {
            return false;
        };
        let (out, result) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        children.entries.insert(
            id.into(),
            Entry {
                cards: HashMap::from([(key.into(), Rc::downgrade(lease))]),
                _cancel: cancel,
                result,
                snapshot: Snapshot::default(),
            },
        );
        let child = id.to_owned();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let mut owed_calls: HashMap<(Option<String>, String), (u8, Option<u64>)> =
                    HashMap::new();
                let mut frozen_ends: HashMap<(Option<String>, String), u64> = HashMap::new();
                let mut execution_owed = 0u8;
                loop {
                    let (ended_calls, exec_ended) = settlement.take();
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
                    }
                    let fetched = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        backend.child_page(&child).await
                    };
                    let snap = match fetched {
                        Ok(Some(page)) => {
                            owed_calls.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            frozen_ends.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            if execution_owed > 0 {
                                if !page.running {
                                    let turn_start = page
                                        .rows
                                        .iter()
                                        .rposition(|r| r.role == "user")
                                        .map_or(0, |idx| idx + 1);
                                    for row in &page.rows[turn_start..] {
                                        for part in &row.parts {
                                            if let Part::Tool(tool) = part
                                                && matches!(
                                                    tool.status.as_str(),
                                                    "pending" | "streaming" | "running"
                                                )
                                                && owed_calls.len() < 64
                                            {
                                                owed_calls
                                                    .entry((Some(row.id.clone()), tool.id.clone()))
                                                    .or_insert((0, None));
                                            }
                                        }
                                    }
                                    execution_owed = 0;
                                } else {
                                    execution_owed -= 1;
                                }
                            }
                            let mut snap = snapshot(page);
                            for ((msg, call), &ts) in &frozen_ends {
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
                                {
                                    Arc::make_mut(tool).ended = Some(ts);
                                }
                            }
                            Some(snap)
                        }
                        Ok(None) => {
                            owed_calls.clear();
                            frozen_ends.clear();
                            execution_owed = 0;
                            Some(Snapshot::default())
                        }
                        Err(_) => {
                            if execution_owed > 0 {
                                execution_owed -= 1;
                            }
                            None
                        }
                    };
                    if out.send(snap).await.is_err() {
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
                        continue;
                    }
                    if dirty.recv().await.is_err() {
                        break;
                    }
                    runtime::sleep(Duration::from_millis(100)).await;
                    let _ = dirty.try_recv();
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
        for entry in self.entries.values_mut() {
            if let Ok(Some(next)) = entry.result.try_recv() {
                changed |= entry.snapshot != next;
                entry.snapshot = next;
            }
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

    pub(super) fn steps(&self, id: &str) -> &[(String, Arc<Tool>)] {
        self.entries
            .get(id)
            .map_or(&[], |entry| entry.snapshot.steps.as_slice())
    }

    pub(super) fn steps_truncated(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|entry| entry.snapshot.steps_truncated)
    }

    pub(super) fn reports(&self, id: &str) -> &[ChildReport] {
        self.entries
            .get(id)
            .map_or(&[], |entry| entry.snapshot.reports.as_slice())
    }
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
        reports,
    }
}

#[cfg(test)]
impl Children {
    pub(super) fn install(&mut self, child: &str, page: crate::history::Page) -> Rc<()> {
        let lease = Rc::default();
        let (out, result) = bounded(1);
        out.try_send(Some(snapshot(page))).unwrap();
        let (cancel, _) = bounded(1);
        self.entries.insert(
            child.into(),
            Entry {
                cards: HashMap::from([("test".into(), Rc::downgrade(&lease))]),
                _cancel: cancel,
                result,
                snapshot: Snapshot::default(),
            },
        );
        lease
    }
}
