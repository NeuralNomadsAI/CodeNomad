//! Shared 10-second worktree inventory cache (TS `worktree-inventory.ts` & `manager.ts` parity).
//! HTTP reads (`http_entries`, refreshing on cold/invalidated/fresh scans) and SSE/receipt reads
//! (`sse_entries`, never refreshing or acquiring a new connection) stay strictly separated while
//! sharing one invalidation serial and lock order (`app.inner` before `app.linked_events`).
use super::{Catalogue, RootCheckout, catalogue_at_with_local, catalogue_in_at, probe_root_checkout};
use crate::{App, Error, Shared, Workspace, error};
use axum::{Json, http::StatusCode as Status};
use futures_util::future::{BoxFuture, FutureExt, Shared as SharedFuture};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

const EVENT_FRESH: Duration = Duration::from_secs(4);
const MAX_AGE: Duration = Duration::from_secs(10);
const MAX_ENTRIES: usize = 64;
const RESTART_LIMIT: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadMode {
    /// Display read (`GET /worktrees` without `fresh=true`): returns fresh (< 10 s) or
    /// expired/lazy-invalidated snapshot immediately while triggering at most one background
    /// refresh (subject to 10 s failure retry backoff). Blocks only when empty or after a
    /// blocking invalidation (`create`/`remove`/`place`/`git-init`).
    Cached,
    /// Authorization/read path: returns a non-expired, non-invalidated (< 10 s) snapshot;
    /// otherwise waits for a validated scan (coalescing concurrent callers and serializing
    /// behind any invalidated in-flight scan).
    Validated,
    /// Explicit fresh scan (`?fresh=true`, live-check mismatch): ignores any cached value and
    /// waits for a new scan (still serializing behind an invalidated in-flight scan).
    Fresh,
    /// Atomically claim the single miss-triggered refresh for `observed_generation`: returns a
    /// newer fresh snapshot or the already-refreshed generation without rescanning, or joins /
    /// starts a fresh scan and records `refreshed_on_miss = true` on publication.
    RefreshOnMiss(u64),
}

#[derive(Clone)]
pub(crate) enum HttpSnapshot {
    Git(Arc<Catalogue>),
    NonGit,
    MissingGit,
}

impl HttpSnapshot {
    fn same_snapshot(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Git(a), Self::Git(b)) => a.same_snapshot(b),
            (Self::NonGit, Self::NonGit) | (Self::MissingGit, Self::MissingGit) => true,
            _ => false,
        }
    }

    fn project(&self) -> Option<&str> {
        match self {
            Self::Git(cat) => Some(cat.project.as_str()),
            Self::NonGit | Self::MissingGit => None,
        }
    }

    pub(crate) fn catalogue(self) -> Option<Arc<Catalogue>> {
        match self {
            Self::Git(cat) => Some(cat),
            Self::NonGit | Self::MissingGit => None,
        }
    }
}

pub(crate) struct CachedHttp {
    pub snapshot: HttpSnapshot,
    pub from_cache: bool,
    pub refreshed_on_miss: bool,
    pub generation: u64,
}

type CachedError = (Status, Value);
type SseRead = SharedFuture<BoxFuture<'static, Option<Arc<Catalogue>>>>;
type HttpFlightSuccess = (HttpSnapshot, Option<Arc<crate::opencode::Endpoint>>, u64, bool);
type HttpFlightError = (CachedError, Option<Arc<crate::opencode::Endpoint>>);
type HttpScanOutcome =
    Result<(HttpSnapshot, Option<Arc<crate::opencode::Endpoint>>), (Error, Option<Arc<crate::opencode::Endpoint>>)>;
type HttpFlightResult = Option<Result<HttpFlightSuccess, HttpFlightError>>;
type HttpRead = SharedFuture<BoxFuture<'static, HttpFlightResult>>;

fn from_error(err: Error) -> CachedError {
    (err.0, err.1.0)
}

fn to_error((status, value): CachedError) -> Error {
    (status, Json(value))
}

struct SseFlight {
    id: Uuid,
    epoch: u64,
    sse_gen: u64,
    endpoint: Arc<crate::opencode::Endpoint>,
    read: SseRead,
}

struct SseEntry {
    at: Instant,
    value: Option<Arc<Catalogue>>,
    endpoint: Arc<crate::opencode::Endpoint>,
    loading: Option<SseFlight>,
}

struct HttpFlight {
    id: Uuid,
    epoch: u64,
    read: HttpRead,
}

struct HttpEntry {
    at: Instant,
    generation: u64,
    expired: bool,
    retry_at: Option<Instant>,
    require_validation: bool,
    refreshed_on_miss: bool,
    pending_refreshed_on_miss: bool,
    value: Option<HttpSnapshot>,
    endpoint: Option<Arc<crate::opencode::Endpoint>>,
    loading: Option<HttpFlight>,
}

pub type EventCache = std::sync::Mutex<InventoryCache>;

#[derive(Default)]
pub struct InventoryCache {
    serial: u64,
    reset: u64,
    next_generation: u64,
    changed: HashMap<String, u64>,
    sse_generation: HashMap<Uuid, u64>,
    sse_entries: HashMap<Uuid, SseEntry>,
    http_entries: HashMap<Uuid, HttpEntry>,
    #[cfg(test)]
    test_joins: usize,
    #[cfg(test)]
    test_wait_previous: usize,
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
        let entry = self.sse_entries.get(&id)?;
        (Arc::ptr_eq(&entry.endpoint, endpoint) && entry.at.elapsed() < MAX_AGE)
            .then_some(entry.value.as_ref()?)
            .map(Arc::clone)
    }

    #[cfg(test)]
    fn invalidate_project(&mut self, project: &str) {
        self.serial += 1;
        self.changed.insert(project.into(), self.serial);
        self.sse_entries
            .retain(|_, entry| entry.value.as_ref().is_some_and(|v| v.project != project) || entry.loading.is_some());
        for entry in self.sse_entries.values_mut() {
            if entry.value.as_ref().is_some_and(|v| v.project == project) {
                entry.value = None;
            }
        }
        for entry in self.http_entries.values_mut() {
            if entry.value.as_ref().and_then(HttpSnapshot::project) == Some(project) {
                entry.expired = true;
                entry.retry_at = None;
            }
        }
    }

    #[cfg(test)]
    pub(in crate::worktrees) fn advance_for_test(&mut self, by: Duration) {
        for entry in self.http_entries.values_mut() {
            if let Some(earlier) = entry.at.checked_sub(by) {
                entry.at = earlier;
            }
            if let Some(retry) = entry.retry_at {
                entry.retry_at = retry.checked_sub(by);
            }
        }
        for entry in self.sse_entries.values_mut() {
            if let Some(earlier) = entry.at.checked_sub(by) {
                entry.at = earlier;
            }
        }
    }

    fn sse_gen(&self, id: Uuid) -> u64 {
        self.sse_generation.get(&id).copied().unwrap_or(0)
    }

    fn invalidate_sse_for_http_change(
        &mut self,
        id: Uuid,
        endpoint: Option<&Arc<crate::opencode::Endpoint>>,
        latest: &HttpSnapshot,
    ) {
        let http_changed = self
            .http_entries
            .get(&id)
            .filter(|e| match (&e.endpoint, endpoint) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            })
            .and_then(|e| e.value.as_ref())
            .is_some_and(|old| !old.same_snapshot(latest));
        let sse_differs = self.sse_entries.get(&id).is_some_and(|e| match &e.value {
            Some(old) => match (latest, endpoint) {
                (HttpSnapshot::Git(cat), Some(ep)) if Arc::ptr_eq(&e.endpoint, ep) => !old.same_snapshot(cat),
                _ => true,
            },
            // A cold SSE flight already in progress may hold an older observation than this HTTP
            // publication; revoke it so it cannot commit stale data after HTTP succeeds.
            None => e.loading.is_some(),
        });
        if http_changed || sse_differs {
            let generation = self.sse_generation.entry(id).or_insert(0);
            *generation = generation.wrapping_add(1);
            if let Some(sse) = self.sse_entries.get_mut(&id) {
                sse.value = None;
                if sse.loading.is_none() {
                    self.sse_entries.remove(&id);
                }
            }
        }
    }

    fn evict_http_if_full(&mut self, keep: Uuid) {
        if self.http_entries.len() < MAX_ENTRIES {
            return;
        }
        self.http_entries.retain(|&k, e| k == keep || e.loading.is_some() || (!e.expired && e.at.elapsed() < MAX_AGE));
        let target = if self.http_entries.contains_key(&keep) { MAX_ENTRIES } else { MAX_ENTRIES - 1 };
        while self.http_entries.len() > target {
            let Some(oldest) = self
                .http_entries
                .iter()
                .filter(|&(&k, e)| k != keep && e.loading.is_none())
                .min_by_key(|(_, e)| e.at)
                .map(|(&k, _)| k)
            else {
                break;
            };
            self.http_entries.remove(&oldest);
        }
    }
}

fn invalidate_mode(app: &App, blocking: bool) {
    let mut cache = app.linked_events.lock().unwrap();
    cache.serial += 1;
    cache.reset = cache.serial;
    cache.changed.clear();
    cache.sse_entries.retain(|_, entry| entry.loading.is_some());
    for entry in cache.sse_entries.values_mut() {
        entry.value = None;
    }
    for entry in cache.http_entries.values_mut() {
        entry.expired = true;
        entry.retry_at = None;
        if blocking {
            entry.require_validation = true;
        }
    }
}

/// Lazy invalidation (`worktree.updated`): retains the last HTTP display snapshot while fencing
/// running scans and forcing `Validated`/`Fresh` callers to reload (TS `worktree-inventory.ts:45-55`).
pub fn invalidate(app: &App) {
    invalidate_mode(app, false);
}

/// Blocking invalidation (`create`/`remove`/`place`/`git-init`): forces even `Cached` display
/// reads to wait for the post-mutation scan instead of returning a pre-mutation snapshot.
pub fn invalidate_blocking(app: &App) {
    invalidate_mode(app, true);
}

pub struct BlockingInvalidation<'a>(Option<&'a App>);

impl BlockingInvalidation<'_> {
    pub fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for BlockingInvalidation<'_> {
    fn drop(&mut self) {
        if let Some(app) = self.0 {
            invalidate_blocking(app);
        }
    }
}

pub fn blocking_invalidation(app: &App) -> BlockingInvalidation<'_> {
    BlockingInvalidation(Some(app))
}

pub(in crate::worktrees) fn revision(app: &App) -> u64 {
    app.linked_events.lock().unwrap().stamp()
}

pub(in crate::worktrees) fn event_revision(app: &App, workspace_id: Uuid) -> (u64, u64) {
    let cache = app.linked_events.lock().unwrap();
    (cache.stamp(), cache.sse_gen(workspace_id))
}

/// Emit `workspace.worktreesChanged` under `app.inner` only while the workspace is still alive,
/// matching `App::remove` so it can never trail `workspace.stopped`.
pub(crate) fn emit_worktrees_changed(app: &App, workspace_id: Uuid) {
    let workspaces = app.inner.lock().unwrap();
    if workspaces.workspaces.iter().any(|item| item.id == workspace_id) {
        app.emit(json!({"type":"workspace.worktreesChanged","workspaceId":workspace_id}));
    }
}

pub fn forget(app: &App, id: Uuid) {
    let mut cache = app.linked_events.lock().unwrap();
    cache.sse_entries.remove(&id);
    cache.http_entries.remove(&id);
    cache.sse_generation.remove(&id);
}

/// Drop guard that clears an in-flight HTTP scan if its caller is cancelled before completion.
struct HttpFlightGuard<'a> {
    app: &'a App,
    workspace_id: Uuid,
    flight_id: Uuid,
    committed: bool,
}

impl Drop for HttpFlightGuard<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut cache = self.app.linked_events.lock().unwrap();
        if let Some(entry) = cache.http_entries.get_mut(&self.workspace_id)
            && entry.loading.as_ref().is_some_and(|f| f.id == self.flight_id)
        {
            entry.loading = None;
            entry.pending_refreshed_on_miss = false;
            if entry.value.is_none() {
                cache.http_entries.remove(&self.workspace_id);
            }
        }
    }
}

async fn run_http_scan(
    app: &App,
    w: &Workspace,
    pinned_endpoint: Option<&Arc<crate::opencode::Endpoint>>,
) -> HttpScanOutcome {
    let started = Instant::now();
    let out = match probe_root_checkout(w).await {
        Err(err) => Err((err, None)),
        Ok(RootCheckout::NonGit | RootCheckout::FallbackNonGit) => Ok((HttpSnapshot::NonGit, None)),
        Ok(RootCheckout::MissingGit) => Ok((HttpSnapshot::MissingGit, None)),
        Ok(RootCheckout::Git(Err(err))) => Err((err, None)),
        Ok(RootCheckout::Git(Ok(local))) => {
            let endpoint = match pinned_endpoint {
                Some(ep) => {
                    if !app.native.current(ep) {
                        return Err((crate::opencode::upstream_error(), Some(Arc::clone(ep))));
                    }
                    Arc::clone(ep)
                }
                None => match app.native.acquire(tokio::time::Instant::now() + Duration::from_secs(12)).await {
                    Ok(ep) => ep,
                    Err(_) => return Err((crate::opencode::upstream_error(), None)),
                },
            };
            match catalogue_at_with_local(app, w, true, Some(&endpoint), Duration::from_secs(12), Some(*local)).await {
                Ok(cat) => Ok((HttpSnapshot::Git(Arc::new(cat)), Some(endpoint))),
                Err(err) => Err((err, Some(endpoint))),
            }
        }
    };
    crate::bench::trace_elapsed("http-worktree-inventory", started);
    out
}

fn finish_http_scan(
    app: &App,
    w: &Workspace,
    flight_id: Uuid,
    epoch: u64,
    outcome: HttpScanOutcome,
) -> HttpFlightResult {
    // Keep `workspaces` (`app.inner`) locked through `app.emit` (after dropping `cache`), matching
    // `App::remove` so `workspace.worktreesChanged` can never be emitted after `workspace.stopped`.
    let workspaces = app.inner.lock().unwrap();
    let alive = workspaces.workspaces.iter().any(|item| item.id == w.id);
    let mut cache = app.linked_events.lock().unwrap();
    if !alive {
        cache.http_entries.remove(&w.id);
        return Some(Err((from_error(error(Status::NOT_FOUND, "Workspace not found")), None)));
    }
    let owns_flight = cache.http_entries.get(&w.id).and_then(|e| e.loading.as_ref()).is_some_and(|f| f.id == flight_id);
    let (result, emit_changed) = match outcome {
        Ok((snapshot, endpoint)) => {
            let endpoint_current = endpoint.as_ref().is_none_or(|ep| app.native.current(ep));
            if !owns_flight || !endpoint_current || !cache.valid(epoch, snapshot.project()) {
                if owns_flight && let Some(entry) = cache.http_entries.get_mut(&w.id) {
                    entry.loading = None;
                    entry.pending_refreshed_on_miss = false;
                    if entry.value.is_none() {
                        cache.http_entries.remove(&w.id);
                    }
                }
                (None, false)
            } else {
                let changed = cache
                    .http_entries
                    .get(&w.id)
                    .and_then(|e| e.value.as_ref())
                    .is_some_and(|prev| !prev.same_snapshot(&snapshot));
                cache.invalidate_sse_for_http_change(w.id, endpoint.as_ref(), &snapshot);
                cache.next_generation = cache.next_generation.wrapping_add(1).max(1);
                let generation = cache.next_generation;
                let mut refreshed_on_miss = false;
                if let Some(entry) = cache.http_entries.get_mut(&w.id) {
                    refreshed_on_miss = entry.pending_refreshed_on_miss;
                    entry.pending_refreshed_on_miss = false;
                    entry.generation = generation;
                    entry.at = Instant::now();
                    entry.expired = false;
                    entry.retry_at = None;
                    entry.require_validation = false;
                    entry.refreshed_on_miss = refreshed_on_miss;
                    entry.value = Some(snapshot.clone());
                    entry.endpoint = endpoint.clone();
                    entry.loading = None;
                }
                cache.evict_http_if_full(w.id);
                (Some(Ok((snapshot, endpoint, generation, refreshed_on_miss))), changed)
            }
        }
        Err((err, endpoint)) => {
            let endpoint_current = endpoint.as_ref().is_none_or(|ep| app.native.current(ep));
            let valid = endpoint_current && cache.valid(epoch, None);
            if owns_flight && let Some(entry) = cache.http_entries.get_mut(&w.id) {
                entry.loading = None;
                entry.pending_refreshed_on_miss = false;
                if valid {
                    entry.retry_at = Some(Instant::now() + MAX_AGE);
                }
                if entry.value.is_none() {
                    cache.http_entries.remove(&w.id);
                }
            }
            if !valid { (None, false) } else { (Some(Err((from_error(err), endpoint))), false) }
        }
    };
    drop(cache);
    if emit_changed {
        app.emit(json!({"type":"workspace.worktreesChanged","workspaceId":w.id}));
    }
    drop(workspaces);
    result
}

pub(in crate::worktrees) async fn http_list(
    app: &Shared,
    w: &Workspace,
    mode: ReadMode,
) -> Result<HttpSnapshot, Error> {
    if mode == ReadMode::Cached {
        let cached = {
            let workspaces = app.inner.lock().unwrap();
            if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                return Err(error(Status::NOT_FOUND, "Workspace not found"));
            }
            let mut cache = app.linked_events.lock().unwrap();
            if let Some(entry) = cache.http_entries.get_mut(&w.id)
                && entry.endpoint.as_ref().is_some_and(|ep| !app.native.current(ep))
            {
                entry.value = None;
                entry.endpoint = None;
                entry.expired = true;
                entry.retry_at = None;
                if entry.loading.is_none() {
                    cache.http_entries.remove(&w.id);
                }
            }
            let epoch = cache.stamp();
            let now = Instant::now();
            if let Some(entry) = cache.http_entries.get(&w.id)
                && let Some(val) = &entry.value
                && !entry.require_validation
            {
                let fresh = !entry.expired && entry.at.elapsed() < MAX_AGE;
                let display = val.clone();
                if !fresh {
                    let can_retry = entry.retry_at.is_none_or(|t| t <= now);
                    if entry.loading.is_none() && can_retry {
                        let (done, receive) = tokio::sync::oneshot::channel();
                        let read = async move { receive.await.ok().flatten() }.boxed().shared();
                        let flight_id = Uuid::new_v4();
                        if let Some(e) = cache.http_entries.get_mut(&w.id) {
                            e.pending_refreshed_on_miss = false;
                            e.loading = Some(HttpFlight { id: flight_id, epoch, read });
                        }
                        let (shared, w_owned) = (app.clone(), w.clone());
                        tokio::spawn(async move {
                            let mut guard =
                                HttpFlightGuard { app: &shared, workspace_id: w_owned.id, flight_id, committed: false };
                            let outcome = run_http_scan(&shared, &w_owned, None).await;
                            guard.committed = true;
                            let res = finish_http_scan(&shared, &w_owned, flight_id, epoch, outcome);
                            let retry = res.is_none();
                            let _ = done.send(res);
                            if retry {
                                // An invalidation or endpoint rotation overtook the passive
                                // refresh: follow up immediately without waiting for another
                                // display request; passive follow-ups are not capped by the
                                // strict-read restart budget (TS `worktree-inventory.ts:61-78`).
                                let _ =
                                    Box::pin(http_read_core(&shared, &w_owned, ReadMode::Validated, None, usize::MAX))
                                        .await;
                            }
                        });
                    }
                }
                Some(display)
            } else {
                None
            }
        };
        if let Some(display) = cached {
            return Ok(display);
        }
    }
    Box::pin(http_read_core(app, w, mode, None, RESTART_LIMIT)).await.map(|hit| hit.snapshot)
}

pub(crate) async fn http_read(app: &App, w: &Workspace, mode: ReadMode) -> Result<CachedHttp, Error> {
    Box::pin(http_read_core(app, w, mode, None, RESTART_LIMIT)).await
}

pub(in crate::worktrees) async fn media_http_read(
    app: &App,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
    mode: ReadMode,
) -> Result<CachedHttp, Error> {
    Box::pin(http_read_core(app, w, mode, Some(endpoint), RESTART_LIMIT)).await
}

async fn http_read_core(
    app: &App,
    w: &Workspace,
    mode: ReadMode,
    pinned_endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    max_restarts: usize,
) -> Result<CachedHttp, Error> {
    let mut restarts = 0usize;
    let mut wait_turns = 0usize;
    let max_wait_turns = max_restarts.saturating_mul(2).saturating_add(2);
    loop {
        enum Step {
            VerifyRoot(CachedHttp),
            WaitPrevious(HttpRead),
            Join(u64, HttpRead),
            RunInline { flight_id: Uuid, epoch: u64, done: tokio::sync::oneshot::Sender<HttpFlightResult> },
        }
        let step = {
            let workspaces = app.inner.lock().unwrap();
            if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                return Err(error(Status::NOT_FOUND, "Workspace not found"));
            }
            let mut cache = app.linked_events.lock().unwrap();
            if let Some(ep) = pinned_endpoint
                && !app.native.current(ep)
            {
                return Err(crate::opencode::upstream_error());
            }
            // Drop stale snapshot tied to a retired native endpoint.
            if let Some(entry) = cache.http_entries.get_mut(&w.id)
                && entry.endpoint.as_ref().is_some_and(|ep| !app.native.current(ep))
            {
                entry.value = None;
                entry.endpoint = None;
                entry.expired = true;
                entry.retry_at = None;
                if entry.loading.is_none() {
                    cache.http_entries.remove(&w.id);
                }
            }
            let epoch = cache.stamp();
            let now = Instant::now();
            let mut verified_hit = None;
            if let Some(entry) = cache.http_entries.get(&w.id)
                && let Some(val) = &entry.value
                && pinned_endpoint.is_none_or(|ep| entry.endpoint.as_ref().is_none_or(|cur| Arc::ptr_eq(cur, ep)))
            {
                let fresh = !entry.expired && !entry.require_validation && entry.at.elapsed() < MAX_AGE;
                let return_fresh = match mode {
                    ReadMode::Cached | ReadMode::Validated => fresh,
                    ReadMode::Fresh => false,
                    ReadMode::RefreshOnMiss(obs_gen) => {
                        fresh && (entry.generation != obs_gen || entry.refreshed_on_miss)
                    }
                };
                if return_fresh {
                    let hit = CachedHttp {
                        snapshot: val.clone(),
                        from_cache: true,
                        refreshed_on_miss: entry.refreshed_on_miss,
                        generation: entry.generation,
                    };
                    if mode == ReadMode::Cached || !matches!(hit.snapshot, HttpSnapshot::Git(_)) {
                        return Ok(hit);
                    }
                    verified_hit = Some(hit);
                } else if mode == ReadMode::Cached && !entry.require_validation {
                    return Ok(CachedHttp {
                        snapshot: val.clone(),
                        from_cache: true,
                        refreshed_on_miss: entry.refreshed_on_miss,
                        generation: entry.generation,
                    });
                }
            }
            if let Some(hit) = verified_hit {
                Step::VerifyRoot(hit)
            } else if let Some(entry) = cache.http_entries.get_mut(&w.id)
                && let Some(flight) = entry.loading.as_ref()
            {
                if flight.epoch == epoch {
                    let read = flight.read.clone();
                    if matches!(mode, ReadMode::RefreshOnMiss(_)) {
                        entry.pending_refreshed_on_miss = true;
                    }
                    #[cfg(test)]
                    {
                        cache.test_joins += 1;
                    }
                    Step::Join(epoch, read)
                } else {
                    // Serialize behind the invalidated in-flight scan (TS `worktree-inventory.ts:61-93`).
                    let read = flight.read.clone();
                    #[cfg(test)]
                    {
                        cache.test_wait_previous += 1;
                    }
                    Step::WaitPrevious(read)
                }
            } else {
                cache.evict_http_if_full(w.id);
                let (done, receive) = tokio::sync::oneshot::channel();
                let read = async move { receive.await.ok().flatten() }.boxed().shared();
                let flight_id = Uuid::new_v4();
                let entry = cache.http_entries.entry(w.id).or_insert_with(|| HttpEntry {
                    at: now,
                    generation: 0,
                    expired: true,
                    retry_at: None,
                    require_validation: false,
                    refreshed_on_miss: false,
                    pending_refreshed_on_miss: false,
                    value: None,
                    endpoint: None,
                    loading: None,
                });
                entry.pending_refreshed_on_miss = matches!(mode, ReadMode::RefreshOnMiss(_));
                entry.loading = Some(HttpFlight { id: flight_id, epoch, read });
                Step::RunInline { flight_id, epoch, done }
            }
        };
        match step {
            Step::VerifyRoot(candidate) => {
                let root_live = if let HttpSnapshot::Git(cat) = &candidate.snapshot {
                    let cat = Arc::clone(cat);
                    let opened = w.path.clone();
                    tokio::task::spawn_blocking(move || cat.root_live_for(&opened)).await.unwrap_or(false)
                } else {
                    true
                };
                // Re-acquire locks in canonical order (`app.inner` -> `app.linked_events`) after
                // the disk check so a concurrent forget, invalidation, newer publication or
                // endpoint retirement cannot be overtaken by a stale cached snapshot.
                let workspaces = app.inner.lock().unwrap();
                if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                    return Err(error(Status::NOT_FOUND, "Workspace not found"));
                }
                let mut cache = app.linked_events.lock().unwrap();
                if pinned_endpoint.is_some_and(|ep| !app.native.current(ep)) {
                    return Err(crate::opencode::upstream_error());
                }
                let still_current = cache.http_entries.get(&w.id).is_some_and(|entry| {
                    entry.generation == candidate.generation
                        && !entry.expired
                        && !entry.require_validation
                        && entry.at.elapsed() < MAX_AGE
                        && entry.endpoint.as_ref().is_none_or(|ep| app.native.current(ep))
                });
                if root_live && still_current {
                    return Ok(candidate);
                }
                if !root_live
                    && let Some(entry) = cache.http_entries.get_mut(&w.id)
                    && entry.generation == candidate.generation
                {
                    entry.expired = true;
                    entry.require_validation = true;
                }
                drop(cache);
                drop(workspaces);
                restarts += 1;
                if restarts > max_restarts {
                    return Err(crate::opencode::upstream_error());
                }
                continue;
            }
            Step::WaitPrevious(prev) => {
                wait_turns += 1;
                if wait_turns > max_wait_turns {
                    return Err(crate::opencode::upstream_error());
                }
                if let Some(ep) = pinned_endpoint {
                    tokio::select! {
                        biased;
                        _ = app.native.wait_retired(ep) => return Err(crate::opencode::upstream_error()),
                        _ = prev => {}
                    }
                } else {
                    let _ = prev.await;
                }
                continue;
            }
            Step::Join(epoch, loading) => {
                let outcome = if let Some(ep) = pinned_endpoint {
                    tokio::select! {
                        biased;
                        _ = app.native.wait_retired(ep) => return Err(crate::opencode::upstream_error()),
                        res = loading => res,
                    }
                } else {
                    loading.await
                };
                let workspaces = app.inner.lock().unwrap();
                if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                    return Err(error(Status::NOT_FOUND, "Workspace not found"));
                }
                let cache = app.linked_events.lock().unwrap();
                if let Some(ep) = pinned_endpoint
                    && !app.native.current(ep)
                {
                    return Err(crate::opencode::upstream_error());
                }
                match outcome {
                    Some(Ok((snapshot, ep, generation, refreshed_on_miss)))
                        if ep.as_ref().is_none_or(|e| app.native.current(e))
                            && cache.valid(epoch, snapshot.project()) =>
                    {
                        return Ok(CachedHttp { snapshot, from_cache: false, refreshed_on_miss, generation });
                    }
                    Some(Err((err, ep)))
                        if ep.as_ref().is_none_or(|e| app.native.current(e)) && cache.valid(epoch, None) =>
                    {
                        return Err(to_error(err));
                    }
                    _ => {
                        drop(cache);
                        drop(workspaces);
                        restarts += 1;
                        if restarts > max_restarts {
                            return Err(crate::opencode::upstream_error());
                        }
                        continue;
                    }
                }
            }
            Step::RunInline { flight_id, epoch, done } => {
                let mut guard = HttpFlightGuard { app, workspace_id: w.id, flight_id, committed: false };
                let outcome = Box::pin(run_http_scan(app, w, pinned_endpoint)).await;
                guard.committed = true;
                let res = finish_http_scan(app, w, flight_id, epoch, outcome);
                let _ = done.send(res.clone());
                match res {
                    Some(Ok((snapshot, _, generation, refreshed_on_miss))) => {
                        return Ok(CachedHttp { snapshot, from_cache: false, refreshed_on_miss, generation });
                    }
                    Some(Err((err, _))) => return Err(to_error(err)),
                    None => {
                        restarts += 1;
                        if restarts > max_restarts {
                            return Err(crate::opencode::upstream_error());
                        }
                        continue;
                    }
                }
            }
        }
    }
}

/// Shared 10-second validated inventory for history search (`query`/`ranked`), sharing the HTTP
/// cache while staying pinned to the caller's `endpoint`.
pub(in crate::worktrees) async fn history_catalogue(
    app: &Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
) -> Option<Arc<Catalogue>> {
    Box::pin(http_read_core(app, w, ReadMode::Validated, Some(endpoint), RESTART_LIMIT))
        .await
        .ok()
        .and_then(|hit| hit.snapshot.catalogue())
}

#[cfg(test)]
pub async fn event_catalogue(app: &Shared, w: &Workspace) -> Option<Arc<Catalogue>> {
    sse_catalogue(app, w, &app.native.endpoint()?, true).await
}

pub async fn event_catalogue_at(
    app: &Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
) -> Option<Arc<Catalogue>> {
    sse_catalogue(app, w, endpoint, true).await
}

pub(in crate::worktrees) async fn receipt_catalogue(
    app: &Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
) -> Option<Arc<Catalogue>> {
    sse_catalogue(app, w, endpoint, false).await
}

async fn sse_catalogue(
    app: &Shared,
    w: &Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
    for_event: bool,
) -> Option<Arc<Catalogue>> {
    loop {
        enum Step {
            Hit(Option<Arc<Catalogue>>),
            WaitPrevious(SseRead),
            Join(u64, u64, SseRead),
        }
        let step = {
            let workspaces = app.inner.lock().unwrap();
            if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                return None;
            }
            let mut cache = app.linked_events.lock().unwrap();
            if !app.native.current(endpoint) {
                return None;
            }
            let epoch = cache.stamp();
            let sse_gen = cache.sse_gen(w.id);
            if cache.sse_entries.get(&w.id).is_some_and(|e| !Arc::ptr_eq(&e.endpoint, endpoint)) {
                cache.sse_entries.remove(&w.id);
            }
            let mut background = None;
            if let Some(entry) = cache.sse_entries.get_mut(&w.id)
                && Arc::ptr_eq(&entry.endpoint, endpoint)
            {
                let age = entry.at.elapsed();
                if age < if for_event { EVENT_FRESH } else { MAX_AGE }
                    && (entry.value.is_some() || entry.loading.is_none())
                {
                    return entry.value.clone();
                }
                if for_event && age < MAX_AGE {
                    background = entry.value.clone();
                }
            }
            if let Some(flight) = cache.sse_entries.get(&w.id).and_then(|e| e.loading.as_ref())
                && Arc::ptr_eq(&flight.endpoint, endpoint)
            {
                if flight.epoch == epoch && flight.sse_gen == sse_gen {
                    if background.is_some() {
                        Step::Hit(background)
                    } else {
                        Step::Join(epoch, sse_gen, flight.read.clone())
                    }
                } else if background.is_some() {
                    Step::Hit(background)
                } else {
                    Step::WaitPrevious(flight.read.clone())
                }
            } else {
                if cache.sse_entries.len() >= MAX_ENTRIES {
                    cache.sse_entries.retain(|_, e| e.loading.is_some() || e.at.elapsed() < MAX_AGE);
                }
                if cache.sse_entries.len() >= MAX_ENTRIES
                    && !cache.sse_entries.contains_key(&w.id)
                    && let Some(oldest) = cache
                        .sse_entries
                        .iter()
                        .filter(|(_, e)| e.loading.is_none())
                        .min_by_key(|(_, e)| e.at)
                        .map(|(&k, _)| k)
                {
                    cache.sse_entries.remove(&oldest);
                }
                let (done, receive) = tokio::sync::oneshot::channel();
                let loading = async move { receive.await.ok().flatten() }.boxed().shared();
                let flight = Uuid::new_v4();
                let entry = cache.sse_entries.entry(w.id).or_insert_with(|| SseEntry {
                    at: Instant::now(),
                    value: None,
                    endpoint: endpoint.clone(),
                    loading: None,
                });
                entry.loading =
                    Some(SseFlight { id: flight, epoch, sse_gen, endpoint: endpoint.clone(), read: loading.clone() });
                let (app, w, endpoint) = (app.clone(), w.clone(), endpoint.clone());
                tokio::spawn(async move {
                    let started = Instant::now();
                    let result =
                        catalogue_in_at(&app, &w, false, false, Some(&endpoint), Duration::from_secs(12), None)
                            .await
                            .ok()
                            .map(Arc::new);
                    crate::bench::trace_elapsed("registered-catalogue", started);
                    let mut cache = app.linked_events.lock().unwrap();
                    let owns_flight =
                        cache.sse_entries.get(&w.id).and_then(|e| e.loading.as_ref()).is_some_and(|f| f.id == flight);
                    if !cache.valid(epoch, result.as_ref().map(|c| c.project.as_str()))
                        || cache.sse_gen(w.id) != sse_gen
                        || !app.native.current(&endpoint)
                        || !owns_flight
                    {
                        if owns_flight && let Some(entry) = cache.sse_entries.get_mut(&w.id) {
                            entry.loading = None;
                            if entry.value.is_none() {
                                cache.sse_entries.remove(&w.id);
                            }
                        }
                        return;
                    }
                    if let Some(res) = result.clone() {
                        if cache.sse_entries.len() > MAX_ENTRIES {
                            cache.sse_entries.remove(&w.id);
                        } else {
                            cache.sse_entries.insert(
                                w.id,
                                SseEntry { at: Instant::now(), value: Some(res), endpoint, loading: None },
                            );
                        }
                    } else if let Some(entry) = cache.sse_entries.get_mut(&w.id) {
                        entry.loading = None;
                        if entry.value.is_none() {
                            cache.sse_entries.remove(&w.id);
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
                let workspaces = app.inner.lock().unwrap();
                if !workspaces.workspaces.iter().any(|item| item.id == w.id) {
                    return None;
                }
                let cache = app.linked_events.lock().unwrap();
                if !app.native.current(endpoint) {
                    return None;
                }
                if cache.sse_gen(w.id) != sse_gen {
                    drop(cache);
                    drop(workspaces);
                    continue;
                }
                let result = result?;
                if cache.valid(epoch, Some(&result.project)) {
                    return Some(result);
                }
                return None;
            }
        }
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod cache_tests;

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
