//! Watches of the files a client reads, reported as file events on the UI stream.
use crate::{Shared, Workspace};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub type Signal = (Uuid, String, Uuid);
type Tx = tokio::sync::mpsc::Sender<Signal>;
pub struct Watches {
    tx: Tx,
    entries: VecDeque<Entry>,
}
struct Entry {
    key: Signal,
    root: PathBuf,
    target: PathBuf,
    identity: String,
    _watcher: RecommendedWatcher,
}
impl Watches {
    pub fn new(tx: Tx) -> Self {
        Self { tx, entries: VecDeque::new() }
    }
    pub fn forget(&mut self, id: Uuid) {
        self.entries.retain(|e| e.key.0 != id);
    }
    pub fn forget_under(&mut self, checkout: &Path) {
        self.entries.retain(|e| !e.root.starts_with(checkout) && !e.target.starts_with(checkout));
    }
}
pub fn observe(app: &Shared, w: &Workspace, logical: &str, target: &Path) {
    let Ok(identity) = crate::files::host_identity(target) else { return };
    let mut registry = app.file_watches.lock().unwrap();
    if let Some(index) = registry.entries.iter().position(|e| e.key.0 == w.id && e.root == w.path && e.key.1 == logical)
    {
        let previous = registry.entries.remove(index).unwrap();
        if previous.target == target && previous.identity == identity {
            registry.entries.push_back(previous);
            return;
        }
    }
    if registry.entries.len() == 256 {
        registry.entries.pop_front();
    }
    let key = (w.id, logical.to_owned(), Uuid::new_v4());
    let (tx, signal) = (registry.tx.clone(), key.clone());
    let Ok(mut watcher) = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_err() || event.is_ok_and(|e| !matches!(e.kind, EventKind::Access(_))) {
            let _ = tx.try_send(signal.clone());
        }
    }) else {
        return;
    };
    if watcher.watch(target, RecursiveMode::NonRecursive).is_ok() {
        registry.entries.push_back(Entry {
            key,
            root: w.path.clone(),
            target: target.into(),
            identity,
            _watcher: watcher,
        });
    }
}
pub async fn run(app: Shared, mut rx: tokio::sync::mpsc::Receiver<Signal>, stop: tokio_util::sync::CancellationToken) {
    loop {
        let first = tokio::select! {_=stop.cancelled()=>break,value=rx.recv()=>value};
        let Some(first) = first else { break };
        tokio::select! {_=stop.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(100))=>{}}
        let mut pending = std::collections::HashSet::from([first]);
        for _ in 0..512 {
            if let Ok(value) = rx.try_recv() {
                pending.insert(value);
            } else {
                break;
            }
        }
        let mut batches: HashMap<Uuid, Vec<_>> = HashMap::new();
        {
            let mut registry = app.file_watches.lock().unwrap();
            for key in pending {
                let Some(i) = registry.entries.iter().position(|e| e.key == key) else { continue };
                let entry = &registry.entries[i];
                let current = entry.root.join(&key.1);
                let stable = dunce::canonicalize(&current).ok().as_ref() == Some(&entry.target)
                    && crate::files::host_identity(&current).ok().as_ref() == Some(&entry.identity);
                batches.entry(key.0).or_default().push(json!({"directory":entry.root,"path":key.1}));
                if !stable {
                    registry.entries.remove(i);
                }
            }
        }
        for (id, changes) in batches {
            let live = app.inner.lock().unwrap();
            if live.workspaces.iter().any(|w| w.id == id) {
                app.emit(json!({"type":"workspace.filesChanged","workspaceId":id,"changes":changes}));
            }
        }
    }
    app.file_watches.lock().unwrap().entries.clear();
}
