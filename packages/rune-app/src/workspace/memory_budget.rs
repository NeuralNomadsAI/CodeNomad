//! Global memory budget coordinator across active/inactive tabs and window caches.
use super::{Tab, cache::Cache, state::Ui};
use crate::State;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Pool {
    Transcript,
    Rendered,
    FilesAndGit,
    Missions,
    WindowCaches,
    ProtectedDrafts,
}

impl Pool {
    pub(crate) const COUNT: usize = 6;
    pub(crate) const ALL: [Self; Self::COUNT] = [
        Self::Transcript,
        Self::Rendered,
        Self::FilesAndGit,
        Self::Missions,
        Self::WindowCaches,
        Self::ProtectedDrafts,
    ];

    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Transcript => 0,
            Self::Rendered => 1,
            Self::FilesAndGit => 2,
            Self::Missions => 3,
            Self::WindowCaches => 4,
            Self::ProtectedDrafts => 5,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PoolUsage {
    by_pool: [usize; Pool::COUNT],
}

impl PoolUsage {
    pub(crate) fn add(&mut self, pool: Pool, bytes: usize) {
        let slot = &mut self.by_pool[pool.index()];
        *slot = slot.saturating_add(bytes);
    }

    pub(crate) fn get(&self, pool: Pool) -> usize {
        self.by_pool[pool.index()]
    }

    pub(crate) fn total(&self) -> usize {
        self.by_pool
            .iter()
            .fold(0usize, |total, &bytes| total.saturating_add(bytes))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub(crate) global_bytes: usize,
    pub(crate) inactive_history_bytes: usize,
    pub(crate) inactive_history_rows: usize,
}

impl Limits {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) const WASM: Self = Self {
        global_bytes: 96 * 1024 * 1024,
        inactive_history_bytes: 48 * 1024 * 1024,
        inactive_history_rows: 4 * crate::history::MAX_ROWS,
    };

    #[cfg(any(test, not(target_arch = "wasm32")))]
    pub(crate) const NATIVE: Self = Self {
        global_bytes: 256 * 1024 * 1024,
        // Matches Solid's inactive session transcript memory ceiling.
        inactive_history_bytes: 64 * 1024 * 1024,
        inactive_history_rows: 16 * crate::history::MAX_ROWS,
    };

    #[cfg(target_arch = "wasm32")]
    pub(crate) const DEFAULT: Self = Self::WASM;

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) const DEFAULT: Self = Self::NATIVE;
}

/// Lock-free per-pool byte ledger backed by RAII [`Reservation`] handles.
pub(crate) struct BudgetLedger {
    pools: [AtomicUsize; Pool::COUNT],
}

impl BudgetLedger {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            pools: std::array::from_fn(|_| AtomicUsize::new(0)),
        })
    }

    pub(crate) fn reserve(self: &Arc<Self>, pool: Pool, bytes: usize) -> Reservation {
        if bytes > 0 {
            self.add_bytes(pool, bytes);
        }
        Reservation {
            ledger: Arc::clone(self),
            pool,
            bytes,
        }
    }

    pub(crate) fn pool_bytes(&self, pool: Pool) -> usize {
        self.pools[pool.index()].load(Ordering::Relaxed)
    }

    pub(crate) fn total_bytes(&self) -> usize {
        Pool::ALL.iter().fold(0usize, |total, &pool| {
            total.saturating_add(self.pool_bytes(pool))
        })
    }

    fn add_bytes(&self, pool: Pool, delta: usize) {
        let slot = &self.pools[pool.index()];
        let _ = slot.try_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(current.saturating_add(delta))
        });
    }

    fn sub_bytes(&self, pool: Pool, delta: usize) {
        let slot = &self.pools[pool.index()];
        let _ = slot.try_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(current.saturating_sub(delta))
        });
    }
}

/// RAII accounting handle: resizing, releasing, or dropping updates [`BudgetLedger`] without leaks.
pub(crate) struct Reservation {
    ledger: Arc<BudgetLedger>,
    pool: Pool,
    bytes: usize,
}

impl Reservation {
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    #[cfg(test)]
    pub(crate) fn pool(&self) -> Pool {
        self.pool
    }

    pub(crate) fn resize(&mut self, next: usize) {
        if next > self.bytes {
            self.ledger.add_bytes(self.pool, next - self.bytes);
        } else if next < self.bytes {
            self.ledger.sub_bytes(self.pool, self.bytes - next);
        }
        self.bytes = next;
    }

    pub(crate) fn release(&mut self) {
        let held = std::mem::take(&mut self.bytes);
        if held > 0 {
            self.ledger.sub_bytes(self.pool, held);
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.release();
    }
}

/// Window-owned coordinator holding the live ledger and synchronized pool reservations.
pub(crate) struct Coordinator {
    ledger: Arc<BudgetLedger>,
    measured: [Reservation; Pool::COUNT],
}

impl Coordinator {
    pub(crate) fn new() -> Self {
        let ledger = BudgetLedger::new();
        let measured = Pool::ALL.map(|pool| ledger.reserve(pool, 0));
        Self { ledger, measured }
    }

    pub(crate) fn sync(&mut self, usage: PoolUsage) {
        for pool in Pool::ALL {
            self.measured[pool.index()].resize(usage.get(pool));
        }
    }

    pub(crate) fn total_bytes(&self) -> usize {
        self.ledger.total_bytes()
    }

    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        for reservation in &mut self.measured {
            reservation.release();
        }
    }

    #[cfg(test)]
    pub(crate) fn ledger(&self) -> &Arc<BudgetLedger> {
        &self.ledger
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Evictable {
    pub(crate) id: usize,
    pub(crate) tier: u8,
    pub(crate) last_used: u64,
    pub(crate) bytes: usize,
    pub(crate) protected: bool,
}

/// Selects the deterministic LRU prefix of unprotected candidates needed to meet `limit_bytes`.
pub(crate) fn plan_evictions(
    total_bytes: usize,
    limit_bytes: usize,
    candidates: &[Evictable],
) -> Vec<usize> {
    if total_bytes <= limit_bytes {
        return Vec::new();
    }
    let mut order: Vec<Evictable> = candidates
        .iter()
        .copied()
        .filter(|candidate| !candidate.protected && candidate.bytes > 0)
        .collect();
    order.sort_unstable_by_key(|candidate| (candidate.tier, candidate.last_used, candidate.id));
    let mut remaining = total_bytes;
    let mut selected = Vec::new();
    for candidate in order {
        if remaining <= limit_bytes {
            break;
        }
        selected.push(candidate.id);
        remaining = remaining.saturating_sub(candidate.bytes);
    }
    selected
}

pub(crate) fn measure(s: &State) -> PoolUsage {
    let mut usage = PoolUsage::default();
    let mut seen_draft_arcs = std::collections::HashSet::new();
    let mut seen_file_drafts = std::collections::HashSet::new();
    let mut seen_outlines = std::collections::HashSet::new();
    // Active tab live state.
    usage.add(
        Pool::Transcript,
        crate::history::retained_bytes(&s.messages),
    );
    usage.add(
        Pool::Rendered,
        s.transcript_display.retained_bytes(&mut seen_outlines),
    );
    if let Some(files) = &s.files {
        usage.add(
            Pool::FilesAndGit,
            files.retained_bytes(&mut seen_file_drafts),
        );
    }
    usage.add(Pool::FilesAndGit, s.git.retained_bytes());
    usage.add(Pool::ProtectedDrafts, s.draft.text.len());
    usage.add(
        Pool::ProtectedDrafts,
        s.composer.draft.retained_bytes(&mut seen_draft_arcs),
    );
    if let Some(recall) = &s.composer.recall {
        usage.add(
            Pool::ProtectedDrafts,
            recall.retained_bytes(&mut seen_draft_arcs),
        );
    }
    usage.add(Pool::ProtectedDrafts, s.git.draft_bytes());

    // Per-tab entries (active tab's missions + inactive tabs' caches & drafts).
    // Measure tab Timelines before `saved_outlines` so outlines still held by a Timeline
    // remain accounted under `Pool::Rendered` even if removed from `saved_outlines`.
    if let Some(ui) = &s.workspace {
        for (index, entry) in ui.entries_slice().iter().enumerate() {
            if let Some(missions) = entry.missions_ref() {
                usage.add(Pool::Missions, missions.retained_bytes());
            }
            usage.add(
                Pool::ProtectedDrafts,
                entry.live_drafts_bytes(&mut seen_draft_arcs),
            );
            if index == ui.active_tab_index() {
                continue;
            }
            if let Some(cache) = entry.cache_ref() {
                let (_, transcript_bytes) = cache.history_weight();
                usage.add(Pool::Transcript, transcript_bytes);
                usage.add(Pool::Rendered, cache.rendered_bytes(&mut seen_outlines));
                usage.add(
                    Pool::FilesAndGit,
                    cache.files_and_git_bytes(&mut seen_file_drafts),
                );
                usage.add(
                    Pool::ProtectedDrafts,
                    cache.draft_bytes(&mut seen_draft_arcs),
                );
            }
        }
    }

    // Window-global caches and protected file drafts.
    usage.add(Pool::WindowCaches, s.rail_excerpts.retained_bytes());
    usage.add(
        Pool::WindowCaches,
        s.prompt_history.retained_bytes_dedup(&mut seen_draft_arcs),
    );
    usage.add(
        Pool::WindowCaches,
        s.saved_outlines.retained_bytes(&mut seen_outlines),
    );
    usage.add(Pool::ProtectedDrafts, s.documents.retained_bytes());
    usage
}

pub(crate) fn enforce(s: &mut State) {
    let _ = enforce_with_recall(s, Limits::DEFAULT, None);
}

#[cfg(test)]
pub(crate) fn enforce_with(s: &mut State, limits: Limits) -> PoolUsage {
    enforce_with_recall(s, limits, None)
}

pub(crate) fn enforce_with_recall(
    s: &mut State,
    limits: Limits,
    protected_recall_id: Option<i64>,
) -> PoolUsage {
    if let Some(ui) = &mut s.workspace {
        trim_inactive_history(
            ui,
            limits.inactive_history_rows,
            limits.inactive_history_bytes,
        );
    }
    let usage = measure(s);
    let total = sync_and_total(s, usage);
    if total <= limits.global_bytes {
        return usage;
    }

    let active_excerpt_scope = s.transcript_display.timeline.excerpt_scope();
    let active_excerpt_target = s
        .transcript_display
        .timeline
        .excerpt_target_message()
        .map(str::to_owned);
    let mut protected_recall_ids = Vec::with_capacity(2);
    if let Some(id) = s
        .composer
        .recall
        .as_ref()
        .map(crate::composer::recall::Recall::id)
    {
        protected_recall_ids.push(id);
    }
    if let Some(id) = protected_recall_id
        && !protected_recall_ids.contains(&id)
    {
        protected_recall_ids.push(id);
    }
    let (active_tab_key, active_session_id, active_backend, active_project_root) =
        active_tab_identity(s);

    // Tier 0: inactive window-global secondary caches (hover excerpts of inactive scopes,
    // oldest persisted outline seeds outside the active session).
    let mut remaining = total;
    if remaining > limits.global_bytes {
        let freed = s.rail_excerpts.evict_inactive_scopes(active_excerpt_scope);
        remaining = remaining.saturating_sub(freed);
    }
    if remaining > limits.global_bytes {
        let _ = s.saved_outlines.evict_under_pressure(
            remaining.saturating_sub(limits.global_bytes),
            active_backend.as_ref(),
            active_project_root.as_deref(),
        );
        remaining = sync_and_total(s, measure(s));
    }

    // Tier 1: inactive tabs' reloadable secondary caches (files, git diffs/history, missions,
    // inactive rendered/session display caches) in deterministic LRU order.
    // Re-plan after re-measuring so an `Arc<Outline>` shared across multiple inactive tabs
    // releases its allocation once all inactive holders are visited before Tier 2 runs.
    let active_outline_ptr = s.transcript_display.timeline.outline_ptr();
    let mut tier1_visited = std::collections::HashSet::new();
    while remaining > limits.global_bytes {
        let planned = {
            let Some(ui) = &s.workspace else { break };
            let candidates: Vec<Evictable> = ui
                .entries_slice()
                .iter()
                .enumerate()
                .filter(|(index, _)| {
                    *index != ui.active_tab_index() && !tier1_visited.contains(index)
                })
                .map(|(index, entry)| Evictable {
                    id: index,
                    tier: 1,
                    last_used: entry.last_touched(),
                    bytes: entry.inactive_secondary_bytes(active_outline_ptr),
                    protected: false,
                })
                .collect();
            plan_evictions(remaining, limits.global_bytes, &candidates)
        };
        if planned.is_empty() {
            break;
        }
        if let Some(ui) = &mut s.workspace {
            for index in planned {
                tier1_visited.insert(index);
                let _ = ui.evict_entry_secondary_caches(index, active_outline_ptr);
            }
        }
        remaining = sync_and_total(s, measure(s));
    }

    // Tier 2: inactive unprotected tabs' transcript histories in deterministic LRU order.
    if remaining > limits.global_bytes
        && let Some(ui) = &mut s.workspace
    {
        let candidates: Vec<Evictable> = ui
            .entries_slice()
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != ui.active_tab_index())
            .filter_map(|(index, entry)| {
                let cache = entry.cache_ref()?;
                let (rows, bytes) = cache.history_weight();
                let weight =
                    bytes.saturating_add(cache.evictable_rendered_bytes(active_outline_ptr));
                (rows > 0 || weight > 0).then_some(Evictable {
                    id: index,
                    tier: 2,
                    last_used: entry.last_touched(),
                    bytes: weight,
                    protected: cache.history_protected(),
                })
            })
            .collect();
        for index in plan_evictions(remaining, limits.global_bytes, &candidates) {
            if let Some(cache) = ui.entry_cache_mut(index) {
                let (_, bytes) = cache.history_weight();
                let weight =
                    bytes.saturating_add(cache.evictable_rendered_bytes(active_outline_ptr));
                cache.evict_history();
                remaining = remaining.saturating_sub(weight);
            }
            if remaining <= limits.global_bytes {
                break;
            }
        }
        remaining = sync_and_total(s, measure(s));
    }

    // Tier 3: window-global recall & non-visible active-tab caches (never touches active
    // transcript, visible previews, or any unsaved draft).
    if remaining > limits.global_bytes {
        let _ = s.prompt_history.evict_under_pressure(
            remaining.saturating_sub(limits.global_bytes),
            active_tab_key.as_deref(),
            active_session_id.as_deref(),
            &protected_recall_ids,
        );
        remaining = sync_and_total(s, measure(s));
    }
    if remaining > limits.global_bytes {
        let freed = s.rail_excerpts.evict_oldest_except(
            active_excerpt_scope,
            active_excerpt_target.as_deref(),
            remaining.saturating_sub(limits.global_bytes),
        );
        remaining = remaining.saturating_sub(freed);
    }
    if remaining > limits.global_bytes {
        let freed = s.transcript_display.evict_inactive_sessions();
        remaining = remaining.saturating_sub(freed);
    }
    if remaining > limits.global_bytes
        && let Some(files) = &mut s.files
    {
        let freed = files.evict_cached_worktrees();
        remaining = remaining.saturating_sub(freed);
    }
    if remaining > limits.global_bytes
        && let Some(ui) = &mut s.workspace
    {
        let _ = ui.evict_active_closed_mission_cache();
    }

    let final_usage = measure(s);
    let _ = sync_and_total(s, final_usage);
    final_usage
}

pub(super) fn trim_inactive_history(ui: &mut Ui, max_rows: usize, max_bytes: usize) {
    let mut order = Vec::new();
    let mut rows = 0usize;
    let mut bytes = 0usize;
    for (index, entry) in ui.entries_slice().iter().enumerate() {
        if index == ui.active_tab_index() {
            continue;
        }
        if let Some(cache) = entry.cache_ref() {
            let (count, weight) = cache.history_weight();
            rows = rows.saturating_add(count);
            bytes = bytes.saturating_add(weight);
            if count > 0 && !cache.history_protected() {
                order.push((entry.last_touched(), index, count, weight));
            }
        }
    }
    order.sort_unstable();
    for (_, index, count, weight) in order {
        if rows <= max_rows && bytes <= max_bytes {
            break;
        }
        if let Some(cache) = ui.entry_cache_mut(index) {
            cache.evict_history();
            rows = rows.saturating_sub(count);
            bytes = bytes.saturating_sub(weight);
        }
    }
}

fn sync_and_total(s: &mut State, usage: PoolUsage) -> usize {
    if let Some(ui) = &mut s.workspace {
        ui.memory_budget_mut().sync(usage);
        ui.memory_budget_mut().total_bytes()
    } else {
        usage.total()
    }
}

fn active_tab_identity(
    s: &State,
) -> (
    Option<String>,
    Option<String>,
    Option<crate::backend::Backend>,
    Option<String>,
) {
    let Some(ui) = &s.workspace else {
        return (None, None, None, None);
    };
    let Some(entry) = ui.entries_slice().get(ui.active_tab_index()) else {
        return (None, None, None, None);
    };
    let session = match entry.saved_ref() {
        Tab::Workspace(saved) => saved.active_session_id.clone(),
        Tab::Blank => None,
    };
    let project_root = entry.project_root().map(str::to_owned);
    let backend = entry.binding_ref().cloned().or_else(|| {
        s.screen
            .launcher()
            .and_then(|launcher| launcher.connection.clone())
    });
    (
        Some(entry.key_str().to_owned()),
        session,
        backend,
        project_root,
    )
}

pub(super) fn evict_cache_secondary(cache: &mut Cache, active_outline_ptr: Option<usize>) -> usize {
    cache.evict_secondary_caches(active_outline_ptr)
}
