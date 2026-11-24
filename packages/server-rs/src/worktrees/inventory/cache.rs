//! Shared registered-checkout inventory for event routing and receipt reads.
use super::{Catalogue, catalogue_in_at};
use crate::{App, Workspace};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub struct EventEntry {
    at: Instant,
    value: Option<Arc<Catalogue>>,
    endpoint: Arc<crate::opencode::Endpoint>,
    loading: Option<(Uuid, u64, InventoryRead)>,
}
type InventoryRead = Shared<BoxFuture<'static, Option<Arc<Catalogue>>>>;
pub type EventCache = std::sync::Mutex<InventoryCache>;

#[derive(Default)]
pub struct InventoryCache {
    serial: u64,
    reset: u64,
    changed: HashMap<String, u64>,
    /// Keyed by `(workspace_id, refreshed)` so SSE/receipt routing (`false`, no refresh) and
    /// history search (`true`, refreshes on cold/invalidated load) never mix entries or flights.
    entries: HashMap<(Uuid, bool), EventEntry>,
}

impl InventoryCache {
    pub(in crate::worktrees) fn stamp(&self) -> u64 {
        self.serial
    }

    pub(in crate::worktrees) fn valid(&self, stamp: u64, project: Option<&str>) -> bool {
        stamp >= self.reset
            && project.is_none_or(|project| self.changed.get(project).is_none_or(|&changed| stamp >= changed))
    }

    pub(in crate::worktrees) fn cached(
        &self,
        id: Uuid,
        endpoint: &Arc<crate::opencode::Endpoint>,
    ) -> Option<Arc<Catalogue>> {
        self.entries
            .get(&(id, false))
            .or_else(|| self.entries.get(&(id, true)))
            .filter(|e| Arc::ptr_eq(&e.endpoint, endpoint) && e.at.elapsed() < EVENT_STALE_LIMIT)?
            .value
            .clone()
    }

    #[cfg(test)]
    fn invalidate_project(&mut self, project: &str) {
        self.serial += 1;
        self.changed.insert(project.into(), self.serial);
        self.entries
            .retain(|_, entry| entry.value.as_ref().is_some_and(|v| v.project != project) || entry.loading.is_some());
        // Keep a pending flight for its waiters, without serving a superseded value.
        for entry in self.entries.values_mut() {
            if entry.value.as_ref().is_some_and(|v| v.project == project) {
                entry.value = None;
            }
        }
    }

    pub(in crate::worktrees) fn store_if_current(
        &mut self,
        id: Uuid,
        refresh: bool,
        endpoint: &Arc<crate::opencode::Endpoint>,
        revision: u64,
        value: Arc<Catalogue>,
    ) {
        if self.serial != revision {
            return;
        }
        let key = (id, refresh);
        if self.entries.len() >= EVENT_ENTRIES * 2 {
            self.entries.retain(|_, e| e.loading.is_some() || e.at.elapsed() < EVENT_STALE_LIMIT);
        }
        if self.entries.len() < EVENT_ENTRIES * 2 || self.entries.contains_key(&key) {
            self.entries.insert(
                key,
                EventEntry { at: Instant::now(), value: Some(value), endpoint: endpoint.clone(), loading: None },
            );
        }
    }
}
/// Event routing reuses an inventory for 4 s, then refreshes it in the
/// background while still serving it, up to the TS worktree cache TTL
/// (`WORKTREE_CACHE_TTL_MS`). A blocking refresh stalled the ordered event
/// bridge for 250–600 ms every 4 s. Invalidation always forces a fresh read,
/// and each lookup still rechecks identity and Git markers locally.
const EVENT_FRESH: Duration = Duration::from_secs(4);
const EVENT_STALE_LIMIT: Duration = Duration::from_secs(10);
const EVENT_ENTRIES: usize = 64;
/// Drops one workspace's inventory, or every one; a running refresh never stores after it.
fn drop_entries(app: &App, id: Option<Uuid>) {
    let mut cache = app.linked_events.lock().unwrap();
    match id {
        Some(id) => {
            cache.entries.remove(&(id, false));
            cache.entries.remove(&(id, true));
        }
        None => {
            cache.serial += 1;
            cache.reset = cache.serial;
            cache.changed.clear();
            cache.entries.clear();
        }
    }
}
pub fn invalidate(app: &App) {
    drop_entries(app, None)
}
pub(in crate::worktrees) fn revision(app: &App) -> u64 {
    app.linked_events.lock().unwrap().stamp()
}
pub fn forget(app: &App, id: Uuid) {
    drop_entries(app, Some(id))
}
pub async fn event_catalogue(app: &crate::Shared, w: &Workspace) -> Option<Arc<Catalogue>> {
    cached_catalogue(app, w, &app.native.endpoint()?, true, false).await
}

pub(in crate::worktrees) async fn receipt_catalogue(
    app: &crate::Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
) -> Option<Arc<Catalogue>> {
    cached_catalogue(app, w, endpoint, false, false).await
}

/// Shared 10-second validated inventory for history search (`query`/`ranked`), coalescing
/// concurrent loads and calling `worktree.refresh` on cold/invalidated scans (TS
/// `worktree-inventory.ts:13, 30-42, 69-93`).
pub(in crate::worktrees) async fn history_catalogue(
    app: &crate::Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
) -> Option<Arc<Catalogue>> {
    cached_catalogue(app, w, endpoint, false, true).await
}

async fn cached_catalogue(
    app: &crate::Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
    for_event: bool,
    refresh_on_load: bool,
) -> Option<Arc<Catalogue>> {
    let key = (w.id, refresh_on_load);
    let (epoch, loading) = {
        let mut cache = app.linked_events.lock().unwrap();
        if !app.native.current(endpoint) {
            return None;
        }
        let epoch = cache.stamp();
        if cache.entries.get(&key).is_some_and(|e| !Arc::ptr_eq(&e.endpoint, endpoint)) {
            cache.entries.remove(&key);
        }
        let mut background = None;
        if let Some(entry) = cache.entries.get_mut(&key) {
            let age = entry.at.elapsed();
            if age < if for_event { EVENT_FRESH } else { EVENT_STALE_LIMIT }
                && (entry.value.is_some() || entry.loading.is_none())
            {
                return entry.value.clone();
            }
            if for_event && age < EVENT_STALE_LIMIT {
                background = entry.value.clone();
            }
        }
        if cache.entries.len() >= EVENT_ENTRIES * 2 {
            cache.entries.retain(|_, e| e.loading.is_some() || e.at.elapsed() < EVENT_STALE_LIMIT);
        }
        let admitted = cache.entries.len() < EVENT_ENTRIES * 2 || cache.entries.contains_key(&key);
        let loading = cache
            .entries
            .get(&key)
            .and_then(|entry| {
                entry
                    .loading
                    .as_ref()
                    .filter(|(_, flight_epoch, _)| *flight_epoch == epoch)
                    .map(|(_, _, read)| read.clone())
            })
            .unwrap_or_else(|| {
                let (done, receive) = tokio::sync::oneshot::channel();
                let loading = async move { receive.await.ok().flatten() }.boxed().shared();
                let flight = Uuid::new_v4();
                if admitted {
                    let entry = cache.entries.entry(key).or_insert_with(|| EventEntry {
                        at: Instant::now(),
                        value: None,
                        endpoint: endpoint.clone(),
                        loading: None,
                    });
                    entry.loading = Some((flight, epoch, loading.clone()));
                }
                let (app, w, endpoint) = (app.clone(), w.clone(), endpoint.clone());
                tokio::spawn(async move {
                    let started = Instant::now();
                    // Pin SSE/receipt scans to the observed `endpoint` without re-acquiring, and
                    // call `catalogue_at(..., refresh=true)` for history search cold/invalidated loads.
                    let result = if refresh_on_load {
                        super::catalogue_at(&app, &w, true, Some(&endpoint), Duration::from_secs(12))
                            .await
                            .ok()
                            .map(Arc::new)
                    } else {
                        catalogue_in_at(&app, &w, false, false, Some(&endpoint), Duration::from_secs(12))
                            .await
                            .ok()
                            .map(Arc::new)
                    };
                    crate::bench::trace_elapsed("registered-catalogue", started);
                    let mut cache = app.linked_events.lock().unwrap();
                    let owns_flight = cache
                        .entries
                        .get(&key)
                        .and_then(|e| e.loading.as_ref())
                        .is_some_and(|(id, _, _)| *id == flight);
                    if !cache.valid(epoch, result.as_ref().map(|c| c.project.as_str()))
                        || !app.native.current(&endpoint)
                        || admitted && !owns_flight
                    {
                        if owns_flight {
                            cache.entries.remove(&key);
                        }
                        return;
                    }
                    if admitted {
                        if result.is_some() {
                            cache.entries.insert(
                                key,
                                EventEntry { at: Instant::now(), value: result.clone(), endpoint, loading: None },
                            );
                        } else {
                            cache.entries.remove(&key);
                        }
                    }
                    let _ = done.send(result);
                });
                loading
            });
        if background.is_some() {
            return background;
        }
        (epoch, loading)
    };
    let result = loading.await?;
    (app.native.current(endpoint) && app.linked_events.lock().unwrap().valid(epoch, Some(&result.project)))
        .then_some(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn invalidation_retires_only_the_project_read() {
        let mut cache = super::InventoryCache::default();
        let captured = cache.stamp();
        cache.invalidate_project("project_a");
        assert!(!cache.valid(captured, Some("project_a")));
        assert!(cache.valid(captured, Some("project_b")));
        assert!(cache.valid(cache.stamp(), Some("project_a")));
    }
}
