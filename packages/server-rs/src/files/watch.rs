//! Watches of the files a client reads, reported as file events on the UI stream.
use crate::{Shared, Workspace};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

pub type Signal = (Uuid, String, Uuid);
type Tx = tokio::sync::mpsc::Sender<Signal>;
type TargetMap = Arc<Mutex<HashMap<PathBuf, TargetState>>>;

const MAX_WATCHES: usize = 256;

struct TargetState {
    identity: String,
    signals: Vec<Signal>,
}

pub struct Watches {
    tx: Tx,
    entries: VecDeque<Entry>,
    /// One shared OS watcher instance multiplexed across up to `MAX_WATCHES` observed paths so
    /// Linux inotify user instances stay at 1 instead of scaling with observed directories.
    watcher: Option<RecommendedWatcher>,
    /// Watched physical path -> tracked identity and active entry signals. Never held across
    /// `watcher.watch`/`unwatch` so the notify callback thread can never deadlock against registry
    /// mutations.
    targets: TargetMap,
}
struct Entry {
    key: Signal,
    root: PathBuf,
    target: PathBuf,
    identity: String,
}

fn dispatch_event(targets: &TargetMap, tx: &Tx, event: notify::Result<notify::Event>) {
    let signals: Vec<Signal> = match event {
        Err(_) => targets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .flat_map(|state| state.signals.iter().cloned())
            .collect(),
        Ok(event) => {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let map = targets.lock().unwrap_or_else(|e| e.into_inner());
            if event.need_rescan() || event.paths.is_empty() {
                map.values().flat_map(|state| state.signals.iter().cloned()).collect()
            } else {
                let mut matched = Vec::new();
                for path in &event.paths {
                    let simplified = dunce::simplified(path);
                    let parent = simplified.parent();
                    let mut hit = false;
                    // Exact match (events on the watched path itself) and direct child match
                    // (NonRecursive directory watches report `<dir>/<child>` on all platforms).
                    if let Some(state) = map.get(simplified) {
                        matched.extend(state.signals.iter().cloned());
                        hit = true;
                    }
                    if let Some(parent_path) = parent
                        && let Some(state) = map.get(parent_path)
                    {
                        matched.extend(state.signals.iter().cloned());
                        hit = true;
                    }
                    #[cfg(windows)]
                    if !hit {
                        let needle = simplified.to_string_lossy();
                        let parent_needle = parent.map(|p| p.to_string_lossy());
                        for (target, state) in map.iter() {
                            let candidate = target.to_string_lossy();
                            if candidate.eq_ignore_ascii_case(&needle)
                                || parent_needle.as_ref().is_some_and(|p| candidate.eq_ignore_ascii_case(p))
                            {
                                matched.extend(state.signals.iter().cloned());
                                hit = true;
                            }
                        }
                    }
                    if !hit {
                        // Coalesced directory notifications (e.g. macOS FSEvents) report an
                        // ancestor directory path rather than the individual watched path.
                        for (target, state) in map.iter() {
                            if target.starts_with(simplified) {
                                matched.extend(state.signals.iter().cloned());
                            }
                        }
                    }
                }
                matched
            }
        }
    };
    for signal in signals {
        let _ = tx.try_send(signal);
    }
}

impl Watches {
    pub fn new(tx: Tx) -> Self {
        Self { tx, entries: VecDeque::new(), watcher: None, targets: Arc::new(Mutex::new(HashMap::new())) }
    }

    fn ensure_watcher(&mut self) -> Option<&mut RecommendedWatcher> {
        if self.watcher.is_none() {
            let tx = self.tx.clone();
            let targets = self.targets.clone();
            let watcher = notify::recommended_watcher(move |event| dispatch_event(&targets, &tx, event)).ok()?;
            self.watcher = Some(watcher);
        }
        self.watcher.as_mut()
    }

    fn detach_keys(&mut self, removed: Vec<(PathBuf, Signal)>) {
        if removed.is_empty() {
            return;
        }
        let mut unwatch = Vec::new();
        {
            let mut map = self.targets.lock().unwrap_or_else(|e| e.into_inner());
            for (target, key) in removed {
                let empty = if let Some(state) = map.get_mut(&target) {
                    state.signals.retain(|existing| existing != &key);
                    state.signals.is_empty()
                } else {
                    false
                };
                if empty {
                    map.remove(&target);
                    unwatch.push(target);
                }
            }
        }
        if let Some(watcher) = self.watcher.as_mut() {
            for target in unwatch {
                let _ = watcher.unwatch(&target);
            }
        }
    }

    fn clear_all(&mut self) {
        self.entries.clear();
        self.targets.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.watcher = None;
    }

    pub fn forget(&mut self, id: Uuid) {
        let mut removed = Vec::new();
        self.entries.retain(|e| {
            if e.key.0 == id {
                removed.push((e.target.clone(), e.key.clone()));
                false
            } else {
                true
            }
        });
        self.detach_keys(removed);
    }

    pub fn forget_under(&mut self, checkout: &Path) {
        let mut removed = Vec::new();
        self.entries.retain(|e| {
            if e.root.starts_with(checkout) || e.target.starts_with(checkout) {
                removed.push((e.target.clone(), e.key.clone()));
                false
            } else {
                true
            }
        });
        self.detach_keys(removed);
    }
}
pub fn observe(app: &Shared, w: &Workspace, logical: &str, target: &Path) {
    let Ok(identity) = crate::files::host_identity(target) else { return };
    let normalized = dunce::simplified(target).to_path_buf();
    let mut registry = app.file_watches.lock().unwrap();
    if let Some(index) = registry.entries.iter().position(|e| e.key.0 == w.id && e.root == w.path && e.key.1 == logical)
    {
        let previous = registry.entries.remove(index).unwrap();
        if previous.target == normalized && previous.identity == identity {
            registry.entries.push_back(previous);
            return;
        }
        registry.detach_keys(vec![(previous.target, previous.key)]);
    }
    if registry.entries.len() == MAX_WATCHES
        && let Some(evicted) = registry.entries.pop_front()
    {
        registry.detach_keys(vec![(evicted.target, evicted.key)]);
    }
    let key = (w.id, logical.to_owned(), Uuid::new_v4());
    let (needs_watch, prev_identity) = {
        let mut map = registry.targets.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&normalized) {
            Some(state) => {
                let prev =
                    (state.identity != identity).then(|| std::mem::replace(&mut state.identity, identity.clone()));
                state.signals.push(key.clone());
                (prev.is_some(), prev)
            }
            None => {
                map.insert(normalized.clone(), TargetState { identity: identity.clone(), signals: vec![key.clone()] });
                (true, None)
            }
        }
    };
    if needs_watch {
        let watched = registry
            .ensure_watcher()
            .is_some_and(|watcher| watcher.watch(&normalized, RecursiveMode::NonRecursive).is_ok());
        if !watched {
            if let Some(prev) = prev_identity {
                let mut map = registry.targets.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = map.get_mut(&normalized) {
                    state.identity = prev;
                }
            }
            registry.detach_keys(vec![(normalized, key)]);
            return;
        }
    }
    registry.entries.push_back(Entry { key, root: w.path.clone(), target: normalized, identity });
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
            let mut stale = Vec::new();
            for key in pending {
                let Some(i) = registry.entries.iter().position(|e| e.key == key) else { continue };
                let entry = &registry.entries[i];
                let current = entry.root.join(&key.1);
                let stable = dunce::canonicalize(&current).ok().as_ref() == Some(&entry.target)
                    && crate::files::host_identity(&current).ok().as_ref() == Some(&entry.identity);
                batches.entry(key.0).or_default().push(json!({"directory":entry.root,"path":key.1}));
                if !stable {
                    let removed = registry.entries.remove(i).unwrap();
                    stale.push((removed.target, removed.key));
                }
            }
            registry.detach_keys(stale);
        }
        for (id, changes) in batches {
            let live = app.inner.lock().unwrap();
            if live.workspaces.iter().any(|w| w.id == id) {
                app.emit(json!({"type":"workspace.filesChanged","workspaceId":id,"changes":changes}));
            }
        }
    }
    app.file_watches.lock().unwrap().clear_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{App, auth, opencode::Native, settings};
    use serde_json::Value;
    use tokio_util::sync::CancellationToken;

    fn test_app(root: &Path) -> (Shared, tokio::sync::mpsc::Receiver<Signal>) {
        let auth = auth::Auth::new(auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let settings =
            settings::Settings::new(settings::document::Location::resolve(root.join("config.yaml").to_str().unwrap()));
        let app = Arc::new(App::new(
            auth,
            0,
            root.to_path_buf(),
            root.to_path_buf(),
            true,
            settings,
            Value::Null,
            Native::test_connection("127.0.0.1:0".parse().unwrap()),
            PathBuf::new(),
            None,
            Watches::new(tx),
            None,
        ));
        (app, rx)
    }

    fn test_workspace(path: PathBuf) -> Workspace {
        let id = Uuid::new_v4();
        Workspace {
            id,
            request_id: None,
            location: json!({"directory": path}),
            path,
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            temporary: None,
        }
    }

    async fn wait_file_change(app: &Shared, sub: &crate::events::Sub, ws_id: Uuid, logical: &str) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            while let crate::events::Next::Frame(frame) = app.events.pop(sub) {
                if let Ok(event) = serde_json::from_str::<Value>(&frame)
                    && event["type"] == "workspace.filesChanged"
                    && event["workspaceId"] == ws_id.to_string()
                    && event["changes"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|c| c["path"].as_str() == Some(logical)))
                {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        false
    }

    #[tokio::test]
    async fn shared_watcher_reports_child_changes_in_listed_directories_and_survives_sibling_unwatch() {
        let dir = crate::shared::test_dir("watch-shared-dirs");
        let dir_canon = dunce::canonicalize(&dir).unwrap();
        let dir_a = dir_canon.join("nested_a");
        let dir_b = dir_canon.join("nested_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let (app, rx) = test_app(&dir_canon);
        let ws_a = test_workspace(dir_canon.clone());
        let ws_b = test_workspace(dir_canon.clone());
        app.inner.lock().unwrap().workspaces.push(ws_a.clone());
        app.inner.lock().unwrap().workspaces.push(ws_b.clone());

        let stop = CancellationToken::new();
        let runner = tokio::spawn(run(app.clone(), rx, stop.clone()));
        let sub = app.events.subscribe();

        // Mirror `files::list`: observe the listed directories themselves (NonRecursive).
        observe(&app, &ws_a, "nested_a", &dir_a);
        observe(&app, &ws_b, "nested_b", &dir_b);
        {
            let reg = app.file_watches.lock().unwrap();
            assert!(reg.watcher.is_some(), "single shared watcher should be initialized");
            assert_eq!(reg.entries.len(), 2);
            assert_eq!(reg.targets.lock().unwrap().len(), 2);
        }

        // Creating a child file inside a watched directory must emit workspace.filesChanged
        // for that listed directory (as checked by `bench/files.mjs`).
        std::fs::write(dir_a.join("watch.txt"), "hello").unwrap();
        assert!(
            wait_file_change(&app, &sub, ws_a.id, "nested_a").await,
            "child creation inside watched directory must emit workspace.filesChanged"
        );

        // Forgetting ws_a unwatches nested_a while keeping nested_b live on the same shared watcher.
        app.file_watches.lock().unwrap().forget(ws_a.id);
        {
            let reg = app.file_watches.lock().unwrap();
            assert_eq!(reg.entries.len(), 1);
            assert_eq!(reg.targets.lock().unwrap().len(), 1);
        }

        std::fs::write(dir_b.join("watch.txt"), "v2-updated").unwrap();
        assert!(
            wait_file_change(&app, &sub, ws_b.id, "nested_b").await,
            "remaining sibling directory watch must still emit workspace.filesChanged"
        );

        stop.cancel();
        runner.await.unwrap();
        {
            let reg = app.file_watches.lock().unwrap();
            assert!(reg.entries.is_empty());
            assert!(reg.targets.lock().unwrap().is_empty());
            assert!(reg.watcher.is_none());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shared_watcher_rearms_when_shared_directory_identity_changes() {
        let dir = crate::shared::test_dir("watch-rearm");
        let dir_canon = dunce::canonicalize(&dir).unwrap();
        let watched = dir_canon.join("replaceable");
        let displaced = dir_canon.join("replaceable-old");
        std::fs::create_dir_all(&watched).unwrap();

        let (app, rx) = test_app(&dir_canon);
        let ws1 = test_workspace(dir_canon.clone());
        let ws2 = test_workspace(dir_canon.clone());
        app.inner.lock().unwrap().workspaces.push(ws1.clone());
        app.inner.lock().unwrap().workspaces.push(ws2.clone());

        let stop = CancellationToken::new();
        let runner = tokio::spawn(run(app.clone(), rx, stop.clone()));
        let sub = app.events.subscribe();

        observe(&app, &ws1, "replaceable", &watched);
        let old_identity = crate::files::host_identity(&watched).unwrap();

        // Keep the old directory alive under a different name so the recreated directory is
        // guaranteed to have a distinct physical identity (inode / MFT file index).
        std::fs::rename(&watched, &displaced).unwrap();
        std::fs::create_dir_all(&watched).unwrap();
        let new_identity = crate::files::host_identity(&watched).unwrap();
        assert_ne!(old_identity, new_identity);

        observe(&app, &ws2, "replaceable", &watched);
        {
            let reg = app.file_watches.lock().unwrap();
            let targets = reg.targets.lock().unwrap();
            assert_eq!(targets.get(&watched).map(|s| s.identity.as_str()), Some(new_identity.as_str()));
        }
        app.file_watches.lock().unwrap().forget(ws1.id);

        std::fs::write(watched.join("after.txt"), "ok").unwrap();
        assert!(
            wait_file_change(&app, &sub, ws2.id, "replaceable").await,
            "shared directory watch must continue firing after identity replacement"
        );

        stop.cancel();
        runner.await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shared_watcher_refcounts_duplicate_targets_and_evicts_at_cap() {
        let dir = crate::shared::test_dir("watch-cap");
        let dir_canon = dunce::canonicalize(&dir).unwrap();
        let (app, _rx) = test_app(&dir_canon);
        let ws1 = test_workspace(dir_canon.clone());
        let ws2 = test_workspace(dir_canon.clone());

        let shared_dir = dir_canon.join("shared");
        std::fs::create_dir_all(&shared_dir).unwrap();
        observe(&app, &ws1, "shared", &shared_dir);
        observe(&app, &ws2, "shared", &shared_dir);
        {
            let reg = app.file_watches.lock().unwrap();
            assert_eq!(reg.entries.len(), 2);
            let targets = reg.targets.lock().unwrap();
            assert_eq!(targets.len(), 1);
            assert_eq!(targets.get(&shared_dir).map(|s| s.signals.len()), Some(2));
        }
        app.file_watches.lock().unwrap().forget(ws1.id);
        {
            let reg = app.file_watches.lock().unwrap();
            assert_eq!(reg.entries.len(), 1);
            let targets = reg.targets.lock().unwrap();
            assert_eq!(targets.get(&shared_dir).map(|s| s.signals.len()), Some(1));
        }

        // Fill past MAX_WATCHES and verify entries + target map stay bounded cleanly.
        for i in 0..=MAX_WATCHES {
            let sub = dir_canon.join(format!("d-{i}"));
            std::fs::create_dir_all(&sub).unwrap();
            observe(&app, &ws2, &format!("d-{i}"), &sub);
        }
        {
            let reg = app.file_watches.lock().unwrap();
            assert_eq!(reg.entries.len(), MAX_WATCHES);
            let targets = reg.targets.lock().unwrap();
            assert_eq!(targets.len(), MAX_WATCHES);
            assert!(!targets.contains_key(&shared_dir), "oldest entry must be evicted and unwatched");
        }

        app.file_watches.lock().unwrap().forget_under(&dir_canon);
        {
            let reg = app.file_watches.lock().unwrap();
            assert!(reg.entries.is_empty());
            assert!(reg.targets.lock().unwrap().is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
