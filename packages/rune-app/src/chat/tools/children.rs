use crate::{
    State,
    backend::Backend,
    content::{Part, Tool},
};
use codenomad_client::{Receiver, bounded, runtime};
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

pub(super) const STEP_LIMIT: usize = 200;
pub(super) const STEP_BYTES: usize = 2 << 20;
const CHILD_LIMIT: usize = 4;
const CHILD_DEPTH_LIMIT: u8 = 3;
type Steps = Vec<(String, Arc<Tool>)>;

#[derive(Clone, PartialEq)]
pub(super) struct ChildReport {
    pub row_id: String,
    pub child: String,
    pub state: String,
    pub created: u64,
    pub body: Option<String>,
    pub after_steps: usize,
}

#[derive(Clone, Default, PartialEq)]
pub(super) struct Snapshot {
    pub steps: Steps,
    pub reports: Vec<ChildReport>,
    pub count_truncated: bool,
    pub byte_truncated: bool,
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    entries: HashMap<String, Entry>,
}

struct Entry {
    parent: Option<String>,
    depth: u8,
    cards: HashMap<String, Weak<()>>,
    _cancel: codenomad_client::Sender<()>,
    result: Receiver<Option<Snapshot>>,
    snapshot: Option<Snapshot>,
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
        self.prune_orphans();
    }

    pub(super) fn lease(&self, id: &str, key: &str) -> Rc<()> {
        self.entries
            .get(id)
            .and_then(|entry| entry.cards.get(key))
            .and_then(Weak::upgrade)
            .unwrap_or_default()
    }

    pub(super) fn can_watch(&self, parent: Option<&str>, child: &str) -> bool {
        let Some(owner) = parent else {
            return true;
        };
        if owner == child {
            return false;
        }
        let Some(entry) = self.entries.get(owner) else {
            return false;
        };
        if entry.depth >= CHILD_DEPTH_LIMIT {
            return false;
        }
        let mut cursor = entry.parent.as_deref();
        for _ in 0..CHILD_DEPTH_LIMIT {
            let Some(ancestor) = cursor else {
                return true;
            };
            if ancestor == child {
                return false;
            }
            cursor = self.entries.get(ancestor).and_then(|e| e.parent.as_deref());
        }
        false
    }

    pub(super) fn demand(
        s: &mut State,
        parent: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let children = &mut s.transcript_display.children;
        children.prune();
        if let Some(entry) = children.entries.get_mut(id) {
            if visible {
                entry.cards.insert(key.into(), Rc::downgrade(lease));
            } else {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(id);
                    children.prune_orphans();
                }
            }
            return;
        }
        if !visible || children.entries.len() >= CHILD_LIMIT || !children.can_watch(parent, id) {
            return;
        }
        let depth = parent
            .and_then(|owner| children.entries.get(owner))
            .map_or(1, |entry| entry.depth + 1);
        let Some(backend) = children.backend.clone() else {
            return;
        };
        let Some(dirty) = backend.watch_child(id) else {
            return;
        };
        let (out, result) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        children.entries.insert(
            id.into(),
            Entry {
                parent: parent.map(str::to_owned),
                depth,
                cards: HashMap::from([(key.into(), Rc::downgrade(lease))]),
                _cancel: cancel,
                result,
                snapshot: None,
            },
        );
        let parent_id = parent.map(str::to_owned);
        let child = id.to_owned();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                loop {
                    let snapshot = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        let fetched = match parent_id.as_deref() {
                            Some(owner) => backend.child_page_for(owner, &child).await,
                            None => backend.child_page(&child).await,
                        };
                        fetched
                            .ok()
                            .map(|page| page.map_or_else(Snapshot::default, snapshot))
                    };
                    if out.send(snapshot).await.is_err() {
                        break;
                    }
                    wake();
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
                changed |= entry.snapshot.as_ref() != Some(&next);
                entry.snapshot = Some(next);
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
        self.prune_orphans();
        before != self.entries.len()
    }

    fn prune_orphans(&mut self) {
        for _ in 0..CHILD_DEPTH_LIMIT {
            let live: std::collections::HashSet<String> = self.entries.keys().cloned().collect();
            let before = self.entries.len();
            self.entries
                .retain(|_, entry| entry.parent.as_deref().is_none_or(|p| live.contains(p)));
            if self.entries.len() == before {
                break;
            }
        }
    }

    pub(super) fn snapshot(&self, id: &str) -> Option<&Snapshot> {
        self.entries.get(id)?.snapshot.as_ref()
    }

    pub(super) fn steps(&self, id: &str) -> &[(String, Arc<Tool>)] {
        self.snapshot(id)
            .map_or(&[], |snapshot| snapshot.steps.as_slice())
    }
}

fn snapshot(page: crate::history::Page) -> Snapshot {
    let mut remaining = STEP_BYTES;
    let mut report_bytes = STEP_BYTES;
    let mut tools = Vec::new();
    let mut reports = Vec::new();
    let mut total_tools = 0usize;
    let mut count_truncated = false;
    let mut byte_truncated = false;
    for row in page.rows.iter().rev() {
        for part in row.parts.iter().rev() {
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
                        after_steps: tools.len(),
                    });
                }
                _ => {}
            }
        }
        if count_truncated && reports.len() >= STEP_LIMIT {
            break;
        }
    }
    let tool_count = tools.len();
    tools.reverse();
    reports.reverse();
    for report in &mut reports {
        report.after_steps = tool_count.saturating_sub(report.after_steps);
    }
    Snapshot {
        steps: tools,
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
        let depth = parent
            .and_then(|owner| self.entries.get(owner))
            .map_or(1, |entry| entry.depth + 1);
        let lease = Rc::default();
        let (out, result) = bounded(1);
        out.try_send(Some(snapshot(page))).unwrap();
        let (cancel, _) = bounded(1);
        self.entries.insert(
            child.into(),
            Entry {
                parent: parent.map(str::to_owned),
                depth,
                cards: HashMap::from([("test".into(), Rc::downgrade(&lease))]),
                _cancel: cancel,
                result,
                snapshot: None,
            },
        );
        lease
    }
}
