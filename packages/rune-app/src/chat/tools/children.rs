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
const CHILD_CACHE_LIMIT: usize = 16;
const CHILD_DEPTH_LIMIT: usize = 3;
type Steps = Vec<(String, Arc<Tool>)>;
type ChildKey = (Option<String>, String);

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
    entries: HashMap<ChildKey, Entry>,
}

struct Entry {
    cards: HashMap<String, CardDemand>,
    active: Option<ActiveWatch>,
    snapshot: Option<Snapshot>,
}

struct CardDemand {
    lease: Weak<()>,
    visible: bool,
}

struct ActiveWatch {
    _cancel: codenomad_client::Sender<()>,
    result: Receiver<Option<Snapshot>>,
}

impl Children {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = Some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(super) fn release(
        &mut self,
        key: &str,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) {
        self.entries.retain(|_, entry| {
            entry.cards.remove(key);
            !entry.cards.is_empty()
        });
        self.prune_orphans();
        self.promote(reads, wake);
    }

    pub(super) fn lease(&self, parent: Option<&str>, id: &str, key: &str) -> Rc<()> {
        let lookup = (parent.map(str::to_owned), id.to_owned());
        self.entries
            .get(&lookup)
            .and_then(|entry| entry.cards.get(key))
            .and_then(|demand| demand.lease.upgrade())
            .unwrap_or_default()
    }

    pub(super) fn can_watch(&self, chain: Option<&str>, child: &str) -> bool {
        let Some(chain) = chain else {
            return true;
        };
        let mut depth = 0usize;
        for ancestor in chain.split('>') {
            depth += 1;
            if ancestor == child || depth >= CHILD_DEPTH_LIMIT {
                return false;
            }
        }
        let (grandparent, owner) = split_chain(chain);
        let parent_key = (grandparent.map(str::to_owned), owner.to_owned());
        self.entries.contains_key(&parent_key)
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
        if let Some(entry) = children.entries.get_mut(&child_key) {
            if visible {
                entry.cards.insert(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        visible: true,
                    },
                );
            } else if let Some(demand) = entry.cards.get_mut(key) {
                demand.visible = false;
                if !entry
                    .cards
                    .values()
                    .any(|c| c.visible && c.lease.strong_count() > 0)
                {
                    entry.active = None;
                }
            }
            children.promote(&reads, &wake);
            return;
        }
        if !visible || !children.can_watch(chain, id) {
            return;
        }
        if children.entries.len() >= CHILD_CACHE_LIMIT {
            let evict = children
                .entries
                .iter()
                .find(|(_, entry)| {
                    entry.active.is_none() && !entry.cards.values().any(|c| c.visible)
                })
                .map(|(k, _)| k.clone());
            if let Some(evict) = evict {
                children.entries.remove(&evict);
                children.prune_orphans();
            } else {
                return;
            }
        }
        children.entries.insert(
            child_key,
            Entry {
                cards: HashMap::from([(
                    key.into(),
                    CardDemand {
                        lease: Rc::downgrade(lease),
                        visible: true,
                    },
                )]),
                active: None,
                snapshot: None,
            },
        );
        children.promote(&reads, &wake);
    }

    fn promote(&mut self, reads: &crate::platform::reads::Reads, wake: &rune::Waker) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let mut active_count = self.entries.values().filter(|e| e.active.is_some()).count();
        if active_count >= CHILD_LIMIT {
            return;
        }
        let mut waiting: Vec<ChildKey> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.active.is_none()
                    && entry
                        .cards
                        .values()
                        .any(|c| c.visible && c.lease.strong_count() > 0)
            })
            .map(|(k, _)| k.clone())
            .collect();
        waiting.sort();
        for key in waiting {
            if active_count >= CHILD_LIMIT {
                break;
            }
            let (parent_id, child) = key.clone();
            let Some(dirty) = backend.watch_child(&child) else {
                continue;
            };
            let (out, result) = bounded(1);
            let (cancel, cancelled) = bounded(1);
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.active = Some(ActiveWatch {
                    _cancel: cancel,
                    result,
                });
                active_count += 1;
            } else {
                continue;
            }
            let backend = backend.clone();
            let wake = wake.clone();
            let reads = reads.clone();
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
    }

    pub(crate) fn poll(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) -> bool {
        let mut changed = self.prune();
        for entry in self.entries.values_mut() {
            if let Some(active) = &mut entry.active
                && let Ok(Some(next)) = active.result.try_recv()
            {
                changed |= entry.snapshot.as_ref() != Some(&next);
                entry.snapshot = Some(next);
            }
        }
        self.promote(reads, wake);
        changed
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        let before = self.entries.len();
        self.entries.retain(|_, entry| {
            entry
                .cards
                .retain(|_, demand| demand.lease.strong_count() > 0);
            if !entry.cards.values().any(|c| c.visible) {
                entry.active = None;
            }
            !entry.cards.is_empty()
        });
        self.prune_orphans();
        before != self.entries.len()
    }

    fn prune_orphans(&mut self) {
        for _ in 0..CHILD_DEPTH_LIMIT {
            let live: std::collections::HashSet<String> = self
                .entries
                .keys()
                .map(|(_, child)| child.clone())
                .collect();
            let before = self.entries.len();
            self.entries
                .retain(|(parent, _), _| parent.as_deref().is_none_or(|p| live.contains(p)));
            if self.entries.len() == before {
                break;
            }
        }
    }

    pub(super) fn snapshot(&self, parent: Option<&str>, id: &str) -> Option<&Snapshot> {
        let lookup = (parent.map(str::to_owned), id.to_owned());
        self.entries.get(&lookup)?.snapshot.as_ref()
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
        let lease = Rc::default();
        let (out, result) = bounded(1);
        out.try_send(Some(snapshot(page))).unwrap();
        let (cancel, _) = bounded(1);
        self.entries.insert(
            (parent.map(str::to_owned), child.into()),
            Entry {
                cards: HashMap::from([(
                    "test".into(),
                    CardDemand {
                        lease: Rc::downgrade(&lease),
                        visible: true,
                    },
                )]),
                active: Some(ActiveWatch {
                    _cancel: cancel,
                    result,
                }),
                snapshot: None,
            },
        );
        lease
    }

    pub(super) fn has_demand(&self, parent: Option<&str>, child: &str) -> bool {
        self.entries
            .contains_key(&(parent.map(str::to_owned), child.into()))
    }
}
