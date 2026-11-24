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
const CHILD_LIMIT: usize = 4;
const STEP_BYTES: usize = 2 << 20;
type Steps = Vec<(String, Arc<Tool>)>;

#[derive(Clone, Default, PartialEq)]
pub(super) struct Snapshot {
    pub steps: Steps,
    pub truncated: bool,
    pub byte_truncated: bool,
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
        let Some(dirty) = backend.watch_child(id) else {
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
                snapshot: None,
            },
        );
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
                        backend
                            .child_page(&child)
                            .await
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
        before != self.entries.len()
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
    let mut tools = Vec::new();
    let mut count_truncated = false;
    let mut byte_truncated = false;
    for row in page.rows.iter().rev() {
        for part in row.parts.iter().rev() {
            let Part::Tool(tool) = part else {
                continue;
            };
            if tools.len() >= STEP_LIMIT {
                count_truncated = true;
                break;
            }
            let Some(left) = remaining.checked_sub(tool.retained_bytes()) else {
                byte_truncated = true;
                break;
            };
            remaining = left;
            tools.push((row.id.clone(), tool.clone()));
        }
        if count_truncated || byte_truncated {
            break;
        }
    }
    tools.reverse();
    Snapshot {
        steps: tools,
        truncated: page.older.is_some() || count_truncated || byte_truncated,
        byte_truncated,
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
                snapshot: None,
            },
        );
        lease
    }
}
