use crate::{
    State,
    backend::Backend,
    content::{Part, SubagentReport, Tool},
};
use codenomad_client::{Receiver, bounded, runtime};
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

pub(super) const STEP_LIMIT: usize = 200;
const CHILD_LIMIT: usize = 4;
const STEP_BYTES: usize = 2 << 20;
type Steps = Vec<(String, Arc<Tool>)>;

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
        key: String,
        _cancel: codenomad_client::Sender<()>,
        rx: Receiver<Option<String>>,
    },
    Ready {
        key: String,
        text: String,
    },
    Failed {
        key: String,
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
        self.report_copy = ReportCopy::Idle;
    }

    pub(crate) fn cancel_copy(&mut self) {
        self.report_copy = ReportCopy::Idle;
    }

    pub(super) fn take_ready_report(&mut self, key: &str) -> Option<String> {
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

    pub(super) fn copy_failed(&self, key: &str) -> bool {
        matches!(&self.report_copy, ReportCopy::Failed { key: current } if current == key)
    }

    pub(super) fn copy_ready(&self, key: &str) -> bool {
        matches!(&self.report_copy, ReportCopy::Ready { key: current, .. } if current == key)
    }

    pub(super) fn release(&mut self, key: &str) {
        let prefix = format!("{key}-");
        self.entries.retain(|_, entry| {
            entry
                .cards
                .retain(|card, _| card != key && !card.starts_with(&prefix));
            !entry.cards.is_empty()
        });
    }

    pub(super) fn copy_report(
        s: &mut State,
        key: &str,
        parent: &str,
        row_id: &str,
        part_index: usize,
        child: &str,
    ) {
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: key.into() };
            return;
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: key.into(),
            _cancel: cancel,
            rx,
        };
        let (parent, row_id, child) = (parent.to_owned(), row_id.to_owned(), child.to_owned());
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
            .unwrap_or_default()
    }

    pub(super) fn demand(s: &mut State, id: &str, key: &str, lease: &Rc<()>, visible: bool) {
        let children = &mut s.transcript_display.children;
        children.prune();
        if let Some(entry) = children.entries.get_mut(id) {
            if visible {
                entry.cards.insert(key.into(), Rc::downgrade(lease));
            } else {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(id);
                }
            }
            return;
        }
        if !visible || children.entries.len() >= CHILD_LIMIT {
            return;
        }
        let Some(backend) = children.backend.clone() else {
            return;
        };
        let Some((dirty, settlement)) = backend.watch_child(id) else {
            return;
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
                let mut execution_owed = 0u8;
                loop {
                    let (ended_calls, exec_ended) = settlement.take();
                    for end in ended_calls {
                        let key = (end.message, end.call);
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
                            for ((msg, call), (_, ended)) in &owed_calls {
                                let Some(ts) = *ended else {
                                    continue;
                                };
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
