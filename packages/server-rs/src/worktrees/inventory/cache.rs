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

struct ActiveFlight {
    id: Uuid,
    epoch: u64,
    sse_gen: u64,
    endpoint: Arc<crate::opencode::Endpoint>,
    read: InventoryRead,
}

pub struct EventEntry {
    at: Instant,
    value: Option<Arc<Catalogue>>,
    endpoint: Arc<crate::opencode::Endpoint>,
    loading: Option<ActiveFlight>,
}
type InventoryRead = Shared<BoxFuture<'static, Option<Arc<Catalogue>>>>;
pub type EventCache = std::sync::Mutex<InventoryCache>;

#[derive(Default)]
pub struct InventoryCache {
    serial: u64,
    reset: u64,
    changed: HashMap<String, u64>,
    sse_generation: HashMap<Uuid, u64>,
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
        let entry = self.entries.get(&(id, false))?;
        (Arc::ptr_eq(&entry.endpoint, endpoint) && entry.at.elapsed() < EVENT_STALE_LIMIT)
            .then_some(entry.value.as_ref()?)
            .map(Arc::clone)
    }

    pub(in crate::worktrees) fn cached_refreshed(
        &self,
        id: Uuid,
        endpoint: &Arc<crate::opencode::Endpoint>,
    ) -> Option<Arc<Catalogue>> {
        let entry = self.entries.get(&(id, true))?;
        (Arc::ptr_eq(&entry.endpoint, endpoint) && entry.at.elapsed() < EVENT_STALE_LIMIT)
            .then_some(entry.value.as_ref()?)
            .map(Arc::clone)
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

    fn sse_gen(&self, id: Uuid) -> u64 {
        self.sse_generation.get(&id).copied().unwrap_or(0)
    }

    fn invalidate_sse_if_changed(&mut self, id: Uuid, endpoint: &Arc<crate::opencode::Endpoint>, latest: &Catalogue) {
        let http_changed = self
            .entries
            .get(&(id, true))
            .filter(|e| Arc::ptr_eq(&e.endpoint, endpoint))
            .and_then(|e| e.value.as_ref())
            .is_some_and(|old| !old.same_snapshot(latest));
        let sse_entry = self.entries.get(&(id, false)).filter(|e| Arc::ptr_eq(&e.endpoint, endpoint));
        let sse_differs = sse_entry.and_then(|e| e.value.as_ref()).is_some_and(|old| !old.same_snapshot(latest));
        let sse_cold_flight = sse_entry.is_some_and(|e| e.loading.is_some() && e.value.is_none());
        if http_changed || sse_differs || sse_cold_flight {
            let generation = self.sse_generation.entry(id).or_insert(0);
            *generation = generation.wrapping_add(1);
            let sse_key = (id, false);
            if let Some(sse) = self.entries.get_mut(&sse_key) {
                sse.value = None;
                if sse.loading.is_none() {
                    self.entries.remove(&sse_key);
                }
            }
        }
    }

    fn store_entry(
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
        if refresh {
            self.invalidate_sse_if_changed(id, endpoint, &value);
        }
        let key = (id, refresh);
        if self.entries.len() >= EVENT_ENTRIES * 2 {
            self.entries.retain(|_, e| e.loading.is_some() || e.at.elapsed() < EVENT_STALE_LIMIT);
        }
        if let Some(entry) = self.entries.get_mut(&key) {
            if Arc::ptr_eq(&entry.endpoint, endpoint) {
                // Preserve an active `loading` flight only when it belongs to this same endpoint.
                if entry.loading.as_ref().is_some_and(|f| !Arc::ptr_eq(&f.endpoint, endpoint)) {
                    entry.loading = None;
                }
                entry.at = Instant::now();
                entry.value = Some(value);
            } else {
                // Never mix a new endpoint's snapshot with a retired endpoint's flight.
                *entry =
                    EventEntry { at: Instant::now(), value: Some(value), endpoint: endpoint.clone(), loading: None };
            }
        } else if self.entries.len() < EVENT_ENTRIES * 2 {
            self.entries.insert(
                key,
                EventEntry { at: Instant::now(), value: Some(value), endpoint: endpoint.clone(), loading: None },
            );
        }
    }
}

pub(in crate::worktrees) fn store_if_current(
    app: &App,
    id: Uuid,
    refresh: bool,
    endpoint: &Arc<crate::opencode::Endpoint>,
    revision: u64,
    value: Arc<Catalogue>,
) {
    // Acquire `inner` (workspace inventory) before `linked_events` (matching `App::remove` ->
    // `forget`) so a concurrent close/forget can neither invert lock order nor leave post-forget
    // entries behind.
    let workspaces = app.inner.lock().unwrap();
    if !workspaces.workspaces.iter().any(|w| w.id == id) {
        return;
    }
    let mut cache = app.linked_events.lock().unwrap();
    if !app.native.current(endpoint) {
        return;
    }
    cache.store_entry(id, refresh, endpoint, revision, value);
}
/// Event routing reuses an inventory for 4 s, then refreshes it in the
/// background while still serving it, up to the TS worktree cache TTL
/// (`WORKTREE_CACHE_TTL_MS`). A blocking refresh stalled the ordered event
/// bridge for 250–600 ms every 4 s. Invalidation always forces a fresh read,
/// and each lookup still rechecks identity and Git markers locally.
const EVENT_FRESH: Duration = Duration::from_secs(4);
const EVENT_STALE_LIMIT: Duration = Duration::from_secs(10);
const EVENT_ENTRIES: usize = 64;
/// Drops one workspace's inventory, or invalidates every cached value while retaining active
/// `loading` flights so post-invalidation callers serialize behind them instead of launching
/// overlapping concurrent scans (TS `worktree-inventory.ts:45-54, 61-93`).
fn drop_entries(app: &App, id: Option<Uuid>) {
    let mut cache = app.linked_events.lock().unwrap();
    match id {
        Some(id) => {
            cache.entries.remove(&(id, false));
            cache.entries.remove(&(id, true));
            cache.sse_generation.remove(&id);
        }
        None => {
            cache.serial += 1;
            cache.reset = cache.serial;
            cache.changed.clear();
            cache.entries.retain(|_, entry| entry.loading.is_some());
            for entry in cache.entries.values_mut() {
                entry.value = None;
            }
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
    let mut sse_retries = 0usize;
    loop {
        enum Step {
            Hit(Option<Arc<Catalogue>>),
            WaitPrevious(InventoryRead),
            Join(u64, u64, InventoryRead),
        }
        let step = {
            let mut cache = app.linked_events.lock().unwrap();
            if !app.native.current(endpoint) {
                return None;
            }
            let epoch = cache.stamp();
            let sse_gen = if refresh_on_load { 0 } else { cache.sse_gen(w.id) };
            if cache.entries.get(&key).is_some_and(|e| !Arc::ptr_eq(&e.endpoint, endpoint)) {
                // `endpoint` is verified current above, so any entry bound to another endpoint is
                // retired: drop it wholesale so neither its snapshot nor its flight can leak to `endpoint`.
                cache.entries.remove(&key);
            }
            let mut background = None;
            if let Some(entry) = cache.entries.get_mut(&key) {
                if Arc::ptr_eq(&entry.endpoint, endpoint) {
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
            }
            if let Some(flight) = cache.entries.get(&key).and_then(|e| e.loading.as_ref())
                && Arc::ptr_eq(&flight.endpoint, endpoint)
            {
                if flight.epoch == epoch && (refresh_on_load || flight.sse_gen == sse_gen) {
                    if background.is_some() {
                        Step::Hit(background)
                    } else {
                        Step::Join(epoch, sse_gen, flight.read.clone())
                    }
                } else if background.is_some() {
                    Step::Hit(background)
                } else {
                    // Serialize behind the already-running invalidated flight on the SAME live
                    // endpoint before starting the next scan (TS `worktree-inventory.ts:61-93`).
                    Step::WaitPrevious(flight.read.clone())
                }
            } else {
                if cache.entries.len() >= EVENT_ENTRIES * 2 {
                    cache.entries.retain(|_, e| e.loading.is_some() || e.at.elapsed() < EVENT_STALE_LIMIT);
                }
                if cache.entries.len() >= EVENT_ENTRIES * 2 && !cache.entries.contains_key(&key) {
                    if let Some(oldest) = cache
                        .entries
                        .iter()
                        .filter(|(_, e)| e.loading.is_none())
                        .min_by_key(|(_, e)| e.at)
                        .map(|(&k, _)| k)
                    {
                        cache.entries.remove(&oldest);
                    }
                }
                let (done, receive) = tokio::sync::oneshot::channel();
                let loading = async move { receive.await.ok().flatten() }.boxed().shared();
                let flight = Uuid::new_v4();
                // Always register active `loading` flights so concurrent callers coalesce even
                // when the idle cache is full; idle retention stays bounded below on completion.
                let entry = cache.entries.entry(key).or_insert_with(|| EventEntry {
                    at: Instant::now(),
                    value: None,
                    endpoint: endpoint.clone(),
                    loading: None,
                });
                entry.loading = Some(ActiveFlight {
                    id: flight,
                    epoch,
                    sse_gen,
                    endpoint: endpoint.clone(),
                    read: loading.clone(),
                });
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
                    let owns_flight =
                        cache.entries.get(&key).and_then(|e| e.loading.as_ref()).is_some_and(|f| f.id == flight);
                    if !cache.valid(epoch, result.as_ref().map(|c| c.project.as_str()))
                        || (!refresh_on_load && cache.sse_gen(w.id) != sse_gen)
                        || !app.native.current(&endpoint)
                        || !owns_flight
                    {
                        if owns_flight {
                            if let Some(entry) = cache.entries.get_mut(&key) {
                                entry.loading = None;
                                if entry.value.is_none() {
                                    cache.entries.remove(&key);
                                }
                            }
                        }
                        return;
                    }
                    if let Some(res) = result.clone() {
                        if refresh_on_load {
                            cache.invalidate_sse_if_changed(w.id, &endpoint, &res);
                        }
                        if cache.entries.len() > EVENT_ENTRIES * 2 {
                            cache.entries.remove(&key);
                        } else {
                            cache.entries.insert(
                                key,
                                EventEntry { at: Instant::now(), value: Some(res), endpoint, loading: None },
                            );
                        }
                    } else if let Some(entry) = cache.entries.get_mut(&key) {
                        entry.loading = None;
                        if entry.value.is_none() {
                            cache.entries.remove(&key);
                        }
                    }
                    let _ = done.send(result);
                });
                if background.is_some() { Step::Hit(background) } else { Step::Join(epoch, sse_gen, loading) }
            }
        };
        match step {
            Step::Hit(val) => return val,
            Step::WaitPrevious(prev) => {
                tokio::select! {
                    biased;
                    _ = app.native.wait_retired(endpoint) => return None,
                    _ = prev => {}
                }
                continue;
            }
            Step::Join(epoch, sse_gen, loading) => {
                let result = loading.await;
                let cache = app.linked_events.lock().unwrap();
                if !app.native.current(endpoint) {
                    return None;
                }
                if !refresh_on_load && cache.sse_gen(w.id) != sse_gen && sse_retries < 4 {
                    drop(cache);
                    sse_retries += 1;
                    continue;
                }
                let result = result?;
                if cache.valid(epoch, Some(&result.project)) && (refresh_on_load || cache.sse_gen(w.id) == sse_gen) {
                    return Some(result);
                }
                return None;
            }
        }
    }
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
