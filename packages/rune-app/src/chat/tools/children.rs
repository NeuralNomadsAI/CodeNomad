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
    pub report: Arc<SubagentReport>,
    pub truncated: bool,
}

type Reports = Vec<ChildReport>;

#[derive(Default, PartialEq)]
struct Snapshot {
    steps: Steps,
    reports: Reports,
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    entries: HashMap<String, Entry>,
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
    }

    pub(super) fn release(&mut self, key: &str) {
        self.entries.retain(|_, entry| {
            entry.cards.remove(key);
            !entry.cards.is_empty()
        });
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
        let Some((dirty, terminal)) = backend.watch_child(id) else {
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
            use std::sync::atomic::Ordering::SeqCst;
            crate::platform::reads::cancellable(&cancelled, async {
                let mut settlement_retries = 0u8;
                loop {
                    let saw_terminal = terminal.swap(false, SeqCst);
                    if saw_terminal {
                        settlement_retries = 3;
                    }
                    let snapshot = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        backend
                            .child_page(&child)
                            .await
                            .ok()
                            .map(|page| page.map_or_else(Snapshot::default, snapshot))
                    };
                    let still_running = snapshot.as_ref().is_some_and(|snap| {
                        snap.steps
                            .iter()
                            .any(|(_, t)| matches!(t.status.as_str(), "streaming" | "running"))
                    });
                    if out.send(snapshot).await.is_err() {
                        break;
                    }
                    wake();
                    if still_running && settlement_retries > 0 {
                        settlement_retries -= 1;
                        let delay = Duration::from_millis(100 * u64::from(3 - settlement_retries));
                        runtime::sleep(delay).await;
                        let _ = dirty.try_recv();
                        continue;
                    }
                    settlement_retries = 0;
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

    pub(super) fn reports(&self, id: &str) -> &[ChildReport] {
        self.entries
            .get(id)
            .map_or(&[], |entry| entry.snapshot.reports.as_slice())
    }
}

fn snapshot(page: crate::history::Page) -> Snapshot {
    let mut remaining = STEP_BYTES;
    let mut tools: Steps = page
        .rows
        .iter()
        .rev()
        .flat_map(|row| {
            row.parts.iter().rev().filter_map(move |part| match part {
                Part::Tool(tool) => Some((row, tool)),
                _ => None,
            })
        })
        .take(STEP_LIMIT)
        .map_while(|(row, tool)| {
            remaining = remaining.checked_sub(tool.retained_bytes())?;
            Some((row.id.clone(), tool.clone()))
        })
        .collect();
    tools.reverse();
    let raw_reports: Vec<_> = page
        .rows
        .iter()
        .rev()
        .flat_map(|row| {
            row.parts.iter().rev().filter_map(move |part| match part {
                Part::SubagentReport(report) => Some((row, report)),
                _ => None,
            })
        })
        .take(STEP_LIMIT)
        .collect();
    // Shortest-first water-filling keeps short older reports intact even beside giant ones.
    let mut order: Vec<usize> = (0..raw_reports.len()).collect();
    order.sort_by_key(|&i| raw_reports[i].1.body.len());
    let mut caps = vec![0usize; raw_reports.len()];
    let mut report_bytes = STEP_BYTES;
    for (pos, &idx) in order.iter().enumerate() {
        let share = report_bytes / (order.len() - pos);
        let len = raw_reports[idx].1.body.len();
        let take = len.min(share);
        caps[idx] = take;
        report_bytes -= take;
    }
    let mut reports: Reports = raw_reports
        .into_iter()
        .enumerate()
        .map(|(idx, (row, report))| {
            let cap = caps[idx];
            let (body, truncated) = if report.body.len() <= cap {
                (report.body.clone(), false)
            } else {
                let end = report.body.floor_char_boundary(cap);
                (report.body[..end].to_owned(), true)
            };
            ChildReport {
                row_id: row.id.clone(),
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
