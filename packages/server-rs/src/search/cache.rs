//! Port of `filesystem/search-cache.ts`: one candidate list per root for a
//! single scope (`type\0lowercased query`), 30 s TTL, scans coalesced per
//! `root\0scope`, at most two scans at once (busy otherwise), and an
//! invalidation that keeps a running scan from filling the cache.
//!
//! The reference clears a root when a workspace on it is reserved or removed
//! (`manager.ts`). Here each scan and cache entry records the workspaces open
//! on its root (`owners`); a different set when it is read or filled means a
//! workspace was opened or closed there since, which clears it the same way.
use futures_util::future::{BoxFuture, FutureExt, Shared};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub const TTL_MS: u64 = 30_000;
const MAX_ACTIVE_SCANS: usize = 2;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub absolute_path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub modified_at: String,
}

pub type Entries = Arc<Vec<Entry>>;
type Scan = Shared<BoxFuture<'static, Result<Entries, String>>>;

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// `WorkspaceSearchBusyError`.
    Busy,
    /// Any other scan failure; the root's cache is cleared.
    Failed(String),
}
pub const BUSY_MESSAGE: &str = "File search is busy; retry after the current scans finish";

struct Cached {
    scope: String,
    expires_at: u64,
    owners: Vec<Uuid>,
    candidates: Entries,
}
struct Pending {
    root: PathBuf,
    valid: bool,
    owners: Vec<Uuid>,
    scan: Scan,
}
#[derive(Default)]
struct State {
    cache: HashMap<PathBuf, Cached>,
    pending: HashMap<(PathBuf, String), Pending>,
}

#[derive(Clone, Default)]
pub struct Cache(Arc<Mutex<State>>);

pub use crate::shared::now_ms;

impl Cache {
    /// `getWorkspaceCandidates`.
    pub fn get(&self, root: &Path, scope: &str, owners: &[Uuid], now: u64) -> Option<Entries> {
        let mut state = self.0.lock().unwrap();
        let cached = state.cache.get(root)?;
        if cached.scope != scope {
            return None;
        }
        if cached.expires_at <= now || cached.owners != owners {
            state.cache.remove(root);
            return None;
        }
        Some(cached.candidates.clone())
    }

    /// `refreshWorkspaceCandidates`: the builder runs detached from the caller,
    /// so a disconnected client neither cancels the scan nor leaks its slot.
    pub async fn refresh<F>(
        &self,
        root: &Path,
        scope: &str,
        owners: Vec<Uuid>,
        now: Option<u64>,
        builder: F,
    ) -> Result<Entries, Failure>
    where
        F: std::future::Future<Output = Result<Vec<Entry>, String>> + Send + 'static,
    {
        let key = (root.to_path_buf(), scope.to_owned());
        let scan = {
            let mut state = self.0.lock().unwrap();
            if let Some(pending) = state.pending.get(&key) {
                pending.scan.clone()
            } else {
                if state.pending.len() >= MAX_ACTIVE_SCANS {
                    return Err(Failure::Busy);
                }
                let this = self.clone();
                let finish_key = key.clone();
                let task = tokio::spawn(async move {
                    let result = builder.await.map(Arc::new);
                    let mut state = this.0.lock().unwrap();
                    if let Some(pending) = state.pending.remove(&finish_key) {
                        if let (Ok(candidates), true) = (&result, pending.valid) {
                            state.cache.insert(
                                finish_key.0.clone(),
                                Cached {
                                    scope: finish_key.1.clone(),
                                    expires_at: now.unwrap_or_else(now_ms) + TTL_MS,
                                    owners: pending.owners,
                                    candidates: candidates.clone(),
                                },
                            );
                        }
                    }
                    result
                });
                let scan = async move { task.await.unwrap_or_else(|e| Err(format!("File search failed: {e}"))) }
                    .boxed()
                    .shared();
                state
                    .pending
                    .insert(key, Pending { root: root.to_path_buf(), valid: true, owners, scan: scan.clone() });
                scan
            }
        };
        scan.await.map_err(Failure::Failed)
    }

    /// `clearWorkspaceSearchCache(root)`; `None` clears every root.
    pub fn clear(&self, root: Option<&Path>) {
        let mut state = self.0.lock().unwrap();
        for pending in state.pending.values_mut() {
            if root.is_none_or(|r| pending.root == r) {
                pending.valid = false;
            }
        }
        match root {
            None => state.cache.clear(),
            Some(r) => {
                state.cache.remove(r);
            }
        }
    }

    /// Marks a root's running scans stale when its open workspaces changed.
    pub fn observe(&self, root: &Path, owners: &[Uuid]) {
        let mut state = self.0.lock().unwrap();
        for pending in state.pending.values_mut() {
            if pending.root == root && pending.owners != owners {
                pending.valid = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    fn entry(name: &str) -> Entry {
        Entry {
            name: name.into(),
            path: name.into(),
            absolute_path: format!("/tmp/{name}"),
            kind: "file",
            size: Some(1),
            modified_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }
    fn gated()
    -> (oneshot::Sender<Vec<Entry>>, impl std::future::Future<Output = Result<Vec<Entry>, String>> + Send + 'static)
    {
        let (tx, rx) = oneshot::channel();
        (tx, async move { Ok(rx.await.unwrap()) })
    }
    fn root(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[tokio::test]
    async fn coalesces_scans_bounds_parallel_io_and_does_not_refill_an_invalidated_cache() {
        let cache = Cache::default();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (release, gate) = gated();
        let gate = gate.shared();
        let build = |calls: Arc<std::sync::atomic::AtomicUsize>, gate: Shared<_>| async move {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            gate.await
        };
        let (c1, c2, c3) = (cache.clone(), cache.clone(), cache.clone());
        let (b1, b2, b3) = (
            build(calls.clone(), gate.clone()),
            build(calls.clone(), gate.clone()),
            build(calls.clone(), gate.clone()),
        );
        let first = tokio::spawn(async move { c1.refresh(&root("/workspace-one"), "a", vec![], None, b1).await });
        tokio::task::yield_now().await;
        let duplicate = tokio::spawn(async move { c2.refresh(&root("/workspace-one"), "a", vec![], None, b2).await });
        let second = tokio::spawn(async move { c3.refresh(&root("/workspace-two"), "b", vec![], None, b3).await });
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(cache.0.lock().unwrap().pending.len(), 2);
        assert_eq!(
            cache.refresh(&root("/workspace-three"), "c", vec![], None, async { Ok(vec![]) }).await,
            Err(Failure::Busy)
        );
        cache.clear(Some(&root("/workspace-one")));
        release.send(vec![entry("needle")]).unwrap();
        let (a, b, c) =
            (first.await.unwrap().unwrap(), duplicate.await.unwrap().unwrap(), second.await.unwrap().unwrap());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "the duplicate shares the scan");
        assert_eq!((a[0].name.as_str(), b[0].name.as_str(), c[0].name.as_str()), ("needle", "needle", "needle"));
        assert!(cache.get(&root("/workspace-one"), "a", &[], now_ms()).is_none());
        assert_eq!(cache.get(&root("/workspace-two"), "b", &[], now_ms()).unwrap()[0].name, "needle");
        let failed =
            cache.refresh(&root("/workspace-three"), "c", vec![], None, async { Err("disk".to_owned()) }).await;
        assert_eq!(failed, Err(Failure::Failed("disk".into())));
        let recovered =
            cache.refresh(&root("/workspace-three"), "c", vec![], None, async { Ok(vec![entry("recovered")]) }).await;
        assert_eq!(recovered.unwrap()[0].name, "recovered");
    }

    #[tokio::test]
    async fn a_rejected_extra_query_does_not_invalidate_the_successful_in_flight_scans() {
        let cache = Cache::default();
        let (release, gate) = gated();
        let gate = gate.shared();
        let (c1, c2, g1, g2) = (cache.clone(), cache.clone(), gate.clone(), gate.clone());
        let first = tokio::spawn(async move { c1.refresh(&root("/busy-root"), "file\0first", vec![], None, g1).await });
        let second =
            tokio::spawn(async move { c2.refresh(&root("/another-root"), "file\0second", vec![], None, g2).await });
        while cache.0.lock().unwrap().pending.len() < 2 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            cache.refresh(&root("/busy-root"), "all\0third", vec![], None, async { Ok(vec![]) }).await,
            Err(Failure::Busy)
        );
        release.send(vec![entry("needle")]).unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(cache.get(&root("/busy-root"), "file\0first", &[], now_ms()).unwrap()[0].name, "needle");
    }

    #[tokio::test]
    async fn expires_after_the_ttl_replaces_on_refresh_and_keeps_one_scope() {
        let cache = Cache::default();
        let w = root("/tmp/workspace");
        cache.refresh(&w, "query-a", vec![], Some(1_000), async { Ok(vec![entry("file-a")]) }).await.unwrap();
        assert_eq!(cache.get(&w, "query-a", &[], 1_000 + TTL_MS - 1).unwrap()[0].name, "file-a");
        assert!(cache.get(&w, "query-a", &[], 1_000 + TTL_MS + 1).is_none());
        cache.refresh(&w, "query-a", vec![], Some(5_000), async { Ok(vec![entry("file-a")]) }).await.unwrap();
        cache.refresh(&w, "query-a", vec![], Some(6_000), async { Ok(vec![entry("file-b")]) }).await.unwrap();
        assert_eq!(cache.get(&w, "query-a", &[], 6_001).unwrap()[0].name, "file-b");
        cache.refresh(&w, "query-b", vec![], Some(5_000), async { Ok(vec![entry("file-b")]) }).await.unwrap();
        assert!(cache.get(&w, "query-a", &[], 5_001).is_none(), "one scope per root");
        assert_eq!(cache.get(&w, "query-b", &[], 5_001).unwrap()[0].name, "file-b");
        cache.clear(Some(&w));
        assert!(cache.get(&w, "query-b", &[], 5_001).is_none());
    }

    #[tokio::test]
    async fn a_workspace_opened_or_closed_on_the_root_clears_it() {
        let cache = Cache::default();
        let (w, one, two) = (root("/tmp/owned"), Uuid::new_v4(), Uuid::new_v4());
        cache.refresh(&w, "s", vec![one], None, async { Ok(vec![entry("a")]) }).await.unwrap();
        assert!(cache.get(&w, "s", &[one], now_ms()).is_some());
        assert!(cache.get(&w, "s", &[one, two], now_ms()).is_none(), "reserved on the same root");
        let (release, gate) = gated();
        let (c, w2) = (cache.clone(), w.clone());
        let scan = tokio::spawn(async move { c.refresh(&w2, "s", vec![one], None, gate).await });
        while cache.0.lock().unwrap().pending.is_empty() {
            tokio::task::yield_now().await;
        }
        cache.observe(&w, &[]);
        release.send(vec![entry("late")]).unwrap();
        assert_eq!(scan.await.unwrap().unwrap()[0].name, "late");
        assert!(cache.get(&w, "s", &[one], now_ms()).is_none(), "a removal during the scan keeps it out");
    }
}
