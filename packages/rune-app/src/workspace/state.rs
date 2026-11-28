mod tabs;
use tabs::{activate, close_blocked};
pub use tabs::{
    active_project_title, can_close_active, can_new, can_switch_tabs, close, close_ordinary,
    new_tab, rename_tab, select, select_index, select_relative, tab_rename_seed,
};

mod blank_cleanup;
mod cleanup;
pub(crate) use cleanup::{remove_cleaned_session, session_cleanup_protected};
mod drafts;
mod idle_markers;
mod notification;
mod observation;
mod panel_state;
mod polling;
mod strip;
mod temporary;
pub(crate) use temporary::{
    StashedTemporary, TemporaryTabInfo, active_temporary_workspace, clear_temporary_mark,
    close_after_keep, detach_dead_temporary, detach_stopped_temporary, finish_discarded,
    has_temporary_tabs, reconcile_temporary_folders, restore_stashed, stash_for_discard,
    stashed_has_in_memory_state, temporary_tab_info,
};

pub(crate) use blank_cleanup::{
    abort_for_project as auto_cleanup_abort_for_project,
    abort_for_session as auto_cleanup_abort_for_session,
    abort_if_protected as auto_cleanup_abort_if_protected,
    is_deleting_session as auto_cleanup_is_deleting_session, schedule as schedule_blank_cleanup,
};
pub(crate) use drafts::{
    MAX_WINDOW_DEVICE_FILES, adopt_recovered_draft, attachment_draft_admissible, bound,
    bound_with_adopt, capture, check_restored_draft_sessions, confirm_unconfirmed, draft_changed,
    has_unconfirmed, note_restored_draft_sessions_present, note_session_deleted, note_unconfirmed,
    recover_missing_session_draft, resume_restored_draft_checks, session_deleted_hook,
    unconfirmed_drafts_full, window_inline_usage_without_history,
};
pub(crate) use notification::{
    Activation, can_switch_for_notification, check_notification, notification_target,
    observes_notification, open_notification, open_session_tab_target, owns_notification,
    switch_tab_for_child, workspace_notification,
};
#[cfg(target_arch = "wasm32")]
pub(crate) use observation::poll_cached_notifications;
pub(crate) use panel_state::event_workspace_id;
#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
pub(crate) use panel_state::set_files_tab;
pub use panel_state::{
    capture_files_mode, file_wrap, files_tab, panel_width, restore_files_mode, toggle_file_wrap,
};
pub(crate) use panel_state::{
    close_mission_reader, deliver_detached_events, detached_workspace_ids, has_detached_panels,
    has_unopened_detached_panels, mission_confirmation, mission_event, mission_has_reader,
    mission_observation_project, mission_panel, mission_reader, mission_supported,
    missions_composing, reconcile_detached_online, restore_mission_reader_focus, right_panel_tab,
    set_detached_online, set_right_panel_tab, stop_unlisted_detached, suspend_mission_briefing,
    suspend_missions,
};
pub use polling::{file_draft_status, poll, poll_file_drafts, status};
pub use strip::strip;

use super::{Snapshot, Tab, Workspace, cache::Cache, persistence::Persistence};
use crate::{
    State,
    backend::Backend,
    catalog::{Project, Session},
    platform,
};
use codenomad_client::same_server_path as same_folder;
use rune::{Tx, edit::TextEdit};
use std::collections::HashSet;

pub(super) struct Entry {
    key: String,
    saved: Tab,
    cache: Option<Cache>,
    history_touched: u64,
    project: Option<Project>,
    sessions: Vec<Session>,
    listed_sessions: HashSet<String>,
    creation_uncertain: bool,
    creation_uncertain_linked: Option<String>,
    rebind_after_send: Option<String>,
    next: Option<String>,
    linked: crate::launcher::linked::Linked,
    consumed_cursors: HashSet<u64>,
    visits: crate::launcher::Visits,
    catalogue: catalogue::Refresh,
    blank_cleanup: blank_cleanup::Runner,
    idle_markers: idle_markers::Tracker,
    wanted_panels: [Option<[bool; 2]>; 2],
    sidebar_edits: Option<(TextEdit, bool, TextEdit, bool)>,
    binding: Option<Backend>,
    missions: Option<crate::missions::Panel>,
    cleared: HashSet<String>,
    pending_drafts: HashSet<String>,
    restored_drafts: std::collections::BTreeMap<String, drafts::DraftCopy>,
    derived_from: std::collections::BTreeMap<String, drafts::DraftCopy>,
    clear_authority: std::collections::BTreeMap<String, drafts::ClearAuthority>,
    superseded_on_delete: HashSet<String>,
    pending_deleted: std::collections::BTreeSet<String>,
    closing_deferred: bool,
    live_drafts: std::collections::BTreeMap<String, drafts::LiveDraft>,
    unmarked_by_registry: bool,
}
impl Entry {
    pub(in crate::workspace) fn key_str(&self) -> &str {
        &self.key
    }
    pub(in crate::workspace) fn saved_ref(&self) -> &Tab {
        &self.saved
    }
    pub(in crate::workspace) fn cache_ref(&self) -> Option<&Cache> {
        self.cache.as_ref()
    }
    pub(in crate::workspace) fn last_touched(&self) -> u64 {
        self.history_touched
    }
    pub(in crate::workspace) fn project_root(&self) -> Option<&str> {
        self.project
            .as_ref()
            .map(|project| project.path.as_str())
            .or_else(|| match &self.saved {
                Tab::Workspace(saved) if !saved.folder.is_empty() => Some(saved.folder.as_str()),
                _ => None,
            })
    }
    pub(in crate::workspace) fn binding_ref(&self) -> Option<&Backend> {
        self.binding.as_ref()
    }
    pub(in crate::workspace) fn missions_ref(&self) -> Option<&crate::missions::Panel> {
        self.missions.as_ref()
    }
    pub(in crate::workspace) fn live_drafts_bytes(
        &self,
        seen: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.live_drafts.values().fold(0usize, |total, draft| {
            total.saturating_add(draft.retained_bytes(seen))
        })
    }
    pub(in crate::workspace) fn inactive_secondary_bytes(
        &self,
        active_outline_ptr: Option<usize>,
    ) -> usize {
        let cache_secondary = self.cache.as_ref().map_or(0, |cache| {
            cache.evictable_secondary_bytes(active_outline_ptr)
        });
        let missions = self
            .missions
            .as_ref()
            .map_or(0, crate::missions::Panel::evictable_inactive_bytes);
        cache_secondary.saturating_add(missions)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProjectScope {
    pub(super) backend_id: Option<String>,
    pub(super) server_id: Option<String>,
    pub(super) folder: String,
}

impl ProjectScope {
    pub(super) fn from_workspace(w: &Workspace) -> Self {
        Self {
            backend_id: w.backend_id.clone(),
            server_id: if w.backend_id.is_some() {
                w.server_id.clone()
            } else {
                None
            },
            folder: w.folder.clone(),
        }
    }

    pub(super) fn matches(&self, w: &Workspace) -> bool {
        same_folder(&self.folder, &w.folder)
            && self.backend_id == w.backend_id
            && (self.backend_id.is_none() || self.server_id == w.server_id)
    }

    pub(super) fn same_scope(&self, other: &Self) -> bool {
        same_folder(&self.folder, &other.folder)
            && self.backend_id == other.backend_id
            && (self.backend_id.is_none() || self.server_id == other.server_id)
    }
}
pub(crate) fn active_workspace(s: &State) -> Option<(&str, &Workspace)> {
    let ui = s.workspace.as_ref()?;
    let entry = ui.entries.get(ui.active)?;
    let Tab::Workspace(saved) = &entry.saved else {
        return None;
    };
    Some((&entry.key, saved))
}

pub(crate) fn contains_project(s: &State, id: &str) -> bool {
    s.workspace.as_ref().is_some_and(|ui| {
        ui.entries.iter().any(|entry| {
            entry
                .project
                .as_ref()
                .is_some_and(|project| project.id == id)
        })
    })
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn revoke_cached_sessions(s: &mut State) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    for entry in &mut ui.entries {
        if let Some(cache) = &mut entry.cache {
            cache.revoke_pairing();
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn has_wake_lock_eligible_work(s: &State) -> bool {
    if !s.screen.is_launcher()
        && super::cache::has_wake_lock_eligible_work(&s.phase, s.agent.as_ref())
    {
        return true;
    }
    s.workspace.as_ref().is_some_and(|ui| {
        ui.entries.iter().any(|entry| {
            entry
                .cache
                .as_ref()
                .is_some_and(Cache::has_wake_lock_eligible_work)
        })
    })
}
pub struct Ui {
    pub(super) openings: super::opening::Openings,
    mission_lifecycle: Box<crate::missions::Lifecycle>,
    mission_briefing: Box<crate::missions::BriefingRequests>,
    entries: Vec<Entry>,
    active: usize,
    next_key: u64,
    revision: u64,
    saved_at: u64,
    panel_widths: [Option<u16>; 2],
    file_wrap: Option<bool>,
    clock: f64,
    pub(super) persistence: Box<Persistence>,
    ready: bool,
    touched: bool,
    staged_revision: Option<u64>,
    closed: Vec<Workspace>,
    closed_restored: Vec<HashSet<String>>,
    closed_derived_from: Vec<std::collections::BTreeMap<String, drafts::DraftCopy>>,
    // Per-closed-tab untouched unconfirmed attempt provenance (session_id -> attempt_id),
    // kept out of Snapshot to preserve the v1 codec while preventing late confirmations from
    // erasing independent closed drafts that happen to have identical text.
    closed_unconfirmed_attempts: Vec<std::collections::BTreeMap<String, String>>,
    closed_pending_deleted: Vec<(ProjectScope, String)>,
    deleted_sessions: (
        codenomad_client::Sender<(ProjectScope, String)>,
        codenomad_client::Receiver<(ProjectScope, String)>,
    ),
    restored_draft_presence_epoch: std::sync::Arc<std::sync::atomic::AtomicU64>,
    restored_draft_seen_present: Vec<(ProjectScope, String, u64)>,
    restored_draft_checked: Vec<(ProjectScope, String, drafts::RestoredProbeOutcome)>,
    restored_draft_in_flight: Vec<(ProjectScope, String, u64)>,
    restored_draft_targets: Vec<drafts::RestoredProbeTarget>,
    restored_draft_checks: (
        codenomad_client::Sender<drafts::RestoredProbeResult>,
        codenomad_client::Receiver<drafts::RestoredProbeResult>,
    ),
    // Bounded in-memory lock registry across tabs (kept out of Snapshot to preserve the v1 client-state-codec schema).
    closed_unconfirmed: Vec<ClosedUnconfirmed>,
    memory_budget: Box<super::memory_budget::Coordinator>,
}
pub(super) const MAX_UNCONFIRMED_LOCKS: usize = super::MAX_DRAFTS;
struct ClosedUnconfirmed {
    backend_id: Option<String>,
    server_id: Option<String>,
    folder: String,
    session_id: String,
    unconfirmed: crate::composer::UnconfirmedPrompt,
}
impl ClosedUnconfirmed {
    fn matches(&self, workspace: &Workspace, session_id: &str) -> bool {
        self.session_id == session_id
            && self.backend_id == workspace.backend_id
            && (self.backend_id.is_none() || self.server_id == workspace.server_id)
    }
    fn matches_project_scope(&self, scope: &ProjectScope) -> bool {
        same_folder(&self.folder, &scope.folder)
            && self.backend_id == scope.backend_id
            && (self.backend_id.is_none() || self.server_id == scope.server_id)
    }
}
impl Ui {
    pub(super) fn remember_closed_unconfirmed(
        &mut self,
        workspace: &Workspace,
        session_id: String,
        unconfirmed: crate::composer::UnconfirmedPrompt,
    ) {
        if let Some(existing) = self
            .closed_unconfirmed
            .iter_mut()
            .find(|item| item.matches(workspace, &session_id))
        {
            existing.folder = workspace.folder.clone();
            if existing.unconfirmed.id() == unconfirmed.id() {
                if existing.unconfirmed.is_edited() && !unconfirmed.is_edited() {
                    existing.unconfirmed = unconfirmed;
                }
            } else {
                existing.unconfirmed = unconfirmed;
            }
            return;
        }
        if self.closed_unconfirmed.len() >= MAX_UNCONFIRMED_LOCKS {
            return;
        }
        self.closed_unconfirmed.push(ClosedUnconfirmed {
            backend_id: workspace.backend_id.clone(),
            server_id: workspace.server_id.clone(),
            folder: workspace.folder.clone(),
            session_id,
            unconfirmed,
        });
    }
    pub(super) fn closed_unconfirmed_entry(
        &self,
        workspace: &Workspace,
        session_id: &str,
    ) -> Option<&crate::composer::UnconfirmedPrompt> {
        self.closed_unconfirmed
            .iter()
            .find(|item| item.matches(workspace, session_id))
            .map(|item| &item.unconfirmed)
    }
    pub(super) fn closed_unconfirmed_id(
        &self,
        workspace: &Workspace,
        session_id: &str,
    ) -> Option<&str> {
        self.closed_unconfirmed_entry(workspace, session_id)
            .map(crate::composer::UnconfirmedPrompt::id)
    }
    pub(super) fn closed_unconfirmed_count(&self) -> usize {
        self.closed_unconfirmed.len()
    }
    pub(super) fn has_closed_unconfirmed_for(
        &self,
        workspace: &Workspace,
        session_id: &str,
    ) -> bool {
        self.closed_unconfirmed
            .iter()
            .any(|item| item.matches(workspace, session_id))
    }
    pub(super) fn forget_closed_unconfirmed(
        &mut self,
        workspace: &Workspace,
        session_id: &str,
        attempt_id: &str,
    ) -> Option<crate::composer::UnconfirmedPrompt> {
        let mut removed = None;
        self.closed_unconfirmed.retain(|item| {
            if item.matches(workspace, session_id) && item.unconfirmed.id() == attempt_id {
                if removed.is_none() {
                    removed = Some(item.unconfirmed.clone());
                }
                false
            } else {
                true
            }
        });
        removed
    }
    pub(super) fn forget_closed_unconfirmed_session(
        &mut self,
        workspace: &Workspace,
        session_id: &str,
    ) {
        self.closed_unconfirmed
            .retain(|item| !item.matches(workspace, session_id));
    }
    pub(super) fn forget_closed_unconfirmed_for_scope(
        &mut self,
        scope: &ProjectScope,
        session_id: &str,
    ) {
        self.closed_unconfirmed.retain(|item| {
            !(item.session_id == session_id
                && item.backend_id == scope.backend_id
                && (item.backend_id.is_none() || item.server_id == scope.server_id))
        });
    }
    pub(super) fn forget_closed_unconfirmed_for_project_scope(&mut self, scope: &ProjectScope) {
        self.closed_unconfirmed
            .retain(|item| !item.matches_project_scope(scope));
    }
    pub(in crate::workspace) fn entries_slice(&self) -> &[Entry] {
        &self.entries
    }
    pub(in crate::workspace) fn active_tab_index(&self) -> usize {
        self.active
    }
    pub(in crate::workspace) fn entry_cache_mut(&mut self, index: usize) -> Option<&mut Cache> {
        self.entries.get_mut(index)?.cache.as_mut()
    }
    pub(in crate::workspace) fn evict_entry_secondary_caches(
        &mut self,
        index: usize,
        active_outline_ptr: Option<usize>,
    ) -> usize {
        let Some(entry) = self.entries.get_mut(index) else {
            return 0;
        };
        let mut freed = entry.cache.as_mut().map_or(0, |cache| {
            super::memory_budget::evict_cache_secondary(cache, active_outline_ptr)
        });
        if let Some(missions) = &mut entry.missions {
            freed = freed.saturating_add(missions.evict_inactive_caches());
        }
        freed
    }
    pub(in crate::workspace) fn evict_active_closed_mission_cache(&mut self) -> usize {
        self.entries
            .get_mut(self.active)
            .and_then(|entry| entry.missions.as_mut())
            .map_or(0, crate::missions::Panel::evict_closed_reader_cache)
    }
    pub(in crate::workspace) fn memory_budget_mut(
        &mut self,
    ) -> &mut super::memory_budget::Coordinator {
        &mut self.memory_budget
    }
    #[cfg(test)]
    pub(in crate::workspace) fn push_fixture_entry(
        &mut self,
        key: &str,
        touched: u64,
        cache: Cache,
        missions: Option<crate::missions::Panel>,
    ) {
        let mut item = entry(key.into(), Tab::Blank);
        item.history_touched = touched;
        item.cache = Some(cache);
        item.missions = missions;
        self.entries.push(item);
    }
    #[cfg(test)]
    pub(in crate::workspace) fn take_entry_cache(&mut self, index: usize) -> Option<Cache> {
        self.entries.get_mut(index)?.cache.take()
    }
    #[cfg(test)]
    pub(in crate::workspace) fn entry_missions_ref(
        &self,
        index: usize,
    ) -> Option<&crate::missions::Panel> {
        self.entries.get(index)?.missions.as_ref()
    }
    #[cfg(test)]
    pub(crate) fn mark_ready(&mut self) {
        self.ready = true;
    }
    #[cfg(test)]
    pub(crate) fn with_cached_git(&mut self, key: &str, f: impl FnOnce(&mut crate::git::Binding)) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key == key)
            && let Some(cache) = entry.cache.as_mut()
        {
            f(cache.git_mut());
        }
    }
    pub(crate) fn active_key(&self) -> &str {
        &self.entries[self.active].key
    }
    pub(crate) fn has_tab_key(&self, key: &str) -> bool {
        self.entries.iter().any(|entry| entry.key == key)
    }
    #[cfg(test)]
    pub(crate) fn fixture_ready(&mut self) {
        self.ready = true;
    }
    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn fixture_store(&mut self, store: crate::platform::storage::Store) {
        self.persistence.store = Some(store);
    }
    #[cfg(test)]
    pub(crate) fn fixture_hydrate(&mut self, saved: Snapshot) {
        self.hydrate(saved);
    }
    #[cfg(test)]
    pub(crate) fn active_index(&self) -> usize {
        self.active
    }
    pub(crate) fn tab_count(&self) -> usize {
        self.entries.len()
    }
    pub fn new() -> Self {
        Self {
            openings: Default::default(),
            mission_lifecycle: Default::default(),
            mission_briefing: Default::default(),
            entries: vec![entry("tab-0".into(), Tab::Blank)],
            active: 0,
            next_key: 1,
            revision: 0,
            saved_at: 0,
            panel_widths: [None; 2],
            file_wrap: None,
            clock: 0.0,
            persistence: Box::new(Persistence::new()),
            ready: false,
            touched: false,
            staged_revision: None,
            closed: Vec::new(),
            closed_restored: Vec::new(),
            closed_derived_from: Vec::new(),
            closed_unconfirmed_attempts: Vec::new(),
            closed_pending_deleted: Vec::new(),
            deleted_sessions: codenomad_client::bounded(256),
            restored_draft_presence_epoch: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                0,
            )),
            restored_draft_seen_present: Vec::new(),
            restored_draft_checked: Vec::new(),
            restored_draft_in_flight: Vec::new(),
            restored_draft_targets: Vec::new(),
            restored_draft_checks: codenomad_client::bounded(256),
            closed_unconfirmed: Vec::new(),
            memory_budget: Box::new(super::memory_budget::Coordinator::new()),
        }
    }
    fn changed(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.saved_at = platform::storage::unix_millis();
        self.touched = true;
        self.persistence.dirty(self.clock);
    }
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.snapshot_with_stashed(None)
    }
    pub(crate) fn snapshot_with_stashed(&self, stashed: Option<&StashedTemporary>) -> Snapshot {
        let mut refs: Vec<&Entry> = self.entries.iter().collect();
        let mut active = self.active;
        let mut stashed_idx: Option<usize> = None;
        if let Some(stashed) = stashed {
            if let Some(blank_key) = &stashed.created_blank_key
                && let Some(pos) = refs
                    .iter()
                    .position(|e| e.key == *blank_key && matches!(e.saved, Tab::Blank))
            {
                refs.remove(pos);
                if active > pos {
                    active -= 1;
                }
            }
            let insert_at = stashed.original_index.min(refs.len());
            refs.insert(insert_at, &stashed.entry);
            stashed_idx = Some(insert_at);
            if stashed.was_active {
                active = insert_at;
            } else if insert_at <= active {
                active += 1;
            }
        }
        let active = if refs.is_empty() {
            None
        } else {
            Some(active.min(refs.len() - 1))
        };
        let mut tabs: Vec<Tab> = refs.iter().map(|e| e.saved.clone()).collect();
        // Resync pending closed-draft projections across all matching tabs (open + stashed,
        // in refs order) for any session projected on the stashed temporary tab, updating both
        // snapshot drafts and snapshot-local provenance 1-to-1 so stale projections are dropped,
        // distinct sibling archives are never duplicated or lost, and derived/clear filtering uses
        // each redistributed bundle's true provenance.
        struct SnapshotProvenance {
            restored_drafts: std::collections::BTreeMap<String, drafts::DraftCopy>,
            derived_from: std::collections::BTreeMap<String, drafts::DraftCopy>,
            superseded_on_delete: HashSet<String>,
            cleared: HashSet<String>,
            clear_authority: std::collections::BTreeMap<String, drafts::ClearAuthority>,
        }
        let mut provenance_overrides: Vec<Option<SnapshotProvenance>> =
            (0..refs.len()).map(|_| None).collect();
        let mut resynced_projected: Vec<(ProjectScope, String, usize)> = Vec::new();
        if let Some(si) = stashed_idx
            && let Tab::Workspace(stashed_w) = &refs[si].saved
            && !refs[si].pending_drafts.is_empty()
        {
            let scope = ProjectScope::from_workspace(stashed_w);
            for id in &refs[si].pending_drafts {
                let pending_tabs: Vec<usize> = refs
                    .iter()
                    .enumerate()
                    .filter_map(|(idx, entry)| {
                        (entry.pending_drafts.contains(id)
                            && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
                        .then_some(idx)
                    })
                    .collect();
                for &idx in &pending_tabs {
                    if let Tab::Workspace(snap_w) = &mut tabs[idx] {
                        snap_w.drafts.remove(id);
                        snap_w.attachment_drafts.remove(id);
                        snap_w.attachment_parts.remove(id);
                    }
                    let prov =
                        provenance_overrides[idx].get_or_insert_with(|| SnapshotProvenance {
                            restored_drafts: refs[idx].restored_drafts.clone(),
                            derived_from: refs[idx].derived_from.clone(),
                            superseded_on_delete: refs[idx].superseded_on_delete.clone(),
                            cleared: refs[idx].cleared.clone(),
                            clear_authority: refs[idx].clear_authority.clone(),
                        });
                    prov.cleared.remove(id);
                    prov.clear_authority.remove(id);
                    prov.restored_drafts.remove(id);
                    prov.derived_from.remove(id);
                    prov.superseded_on_delete.remove(id);
                }
                let clear_authorities = drafts::collect_open_clear_authorities_for(
                    refs.iter()
                        .enumerate()
                        .filter(|(idx, _)| !pending_tabs.contains(idx))
                        .map(|(_, entry)| *entry),
                    &scope,
                    id,
                );
                let (bundles, explicitly_cleared) = drafts::collect_closed_bundles_for_recovery(
                    self,
                    &scope,
                    id,
                    &clear_authorities,
                );
                let mut placed = 0usize;
                if bundles.is_empty() {
                    if explicitly_cleared {
                        for &idx in &pending_tabs {
                            if let Some(prov) = provenance_overrides[idx].as_mut() {
                                prov.cleared.insert(id.clone());
                                prov.clear_authority
                                    .insert(id.clone(), drafts::ClearAuthority::Persisted);
                            }
                        }
                    }
                } else {
                    for (idx, bundle) in pending_tabs.into_iter().zip(bundles) {
                        let Tab::Workspace(snap_w) = &mut tabs[idx] else {
                            continue;
                        };
                        if let Some(text) = bundle.text.as_ref()
                            && !text.is_empty()
                        {
                            snap_w.drafts.insert(id.clone(), text.clone());
                        }
                        if bundle.attachment_draft || bundle.attachment_parts.is_some() {
                            snap_w.attachment_drafts.insert(id.clone());
                        }
                        if let Some(parts) = bundle.attachment_parts.as_ref() {
                            snap_w.attachment_parts.insert(id.clone(), parts.clone());
                        }
                        if let Some(prov) = provenance_overrides[idx].as_mut() {
                            if let Some(origin) = bundle.derived_from.as_ref() {
                                prov.derived_from.insert(id.clone(), origin.clone());
                            }
                            if bundle.from_restored
                                && let Some(copy) = drafts::DraftCopy::from_workspace(snap_w, id)
                            {
                                prov.restored_drafts.insert(id.clone(), copy.clone());
                                prov.derived_from.entry(id.clone()).or_insert(copy);
                            }
                        }
                        placed += 1;
                    }
                }
                resynced_projected.push((scope.clone(), id.clone(), placed));
            }
        }
        let restored_of = |idx: usize| -> &std::collections::BTreeMap<String, drafts::DraftCopy> {
            provenance_overrides[idx]
                .as_ref()
                .map_or(&refs[idx].restored_drafts, |p| &p.restored_drafts)
        };
        let derived_of = |idx: usize| -> &std::collections::BTreeMap<String, drafts::DraftCopy> {
            provenance_overrides[idx]
                .as_ref()
                .map_or(&refs[idx].derived_from, |p| &p.derived_from)
        };
        let superseded_of = |idx: usize| -> &HashSet<String> {
            provenance_overrides[idx]
                .as_ref()
                .map_or(&refs[idx].superseded_on_delete, |p| &p.superseded_on_delete)
        };
        let cleared_of = |idx: usize| -> &HashSet<String> {
            provenance_overrides[idx]
                .as_ref()
                .map_or(&refs[idx].cleared, |p| &p.cleared)
        };
        let clear_authority_of =
            |idx: usize| -> &std::collections::BTreeMap<String, drafts::ClearAuthority> {
                provenance_overrides[idx]
                    .as_ref()
                    .map_or(&refs[idx].clear_authority, |p| &p.clear_authority)
            };
        // Exclude restored copies already superseded by a closed sibling's clear authority
        // without changing the v1 snapshot schema.
        for (idx, tab) in tabs.iter_mut().enumerate().take(refs.len()) {
            if let Tab::Workspace(snap_w) = tab {
                let restored = restored_of(idx);
                for id in superseded_of(idx) {
                    if restored.contains_key(id) {
                        snap_w.drafts.remove(id);
                        snap_w.attachment_drafts.remove(id);
                        snap_w.attachment_parts.remove(id);
                    }
                }
            }
        }
        // Exclude untouched restored sibling copies already superseded by a derived non-restored
        // draft (edited or projected from an edit) in the same project without changing v1 JSON.
        for idx in 0..refs.len() {
            let Tab::Workspace(w) = &refs[idx].saved else {
                continue;
            };
            let restored = restored_of(idx);
            for (id, origin) in derived_of(idx) {
                if restored.contains_key(id) {
                    continue;
                }
                let has_saved_content = matches!(
                    &tabs[idx],
                    Tab::Workspace(cur)
                        if cur.drafts.get(id).is_some_and(|text| !text.is_empty())
                            || cur.attachment_drafts.contains(id)
                            || cur.attachment_parts.contains_key(id)
                );
                if !has_saved_content {
                    continue;
                }
                for (other_idx, other_tab) in tabs.iter_mut().enumerate().take(refs.len()) {
                    if other_idx == idx {
                        continue;
                    }
                    let Tab::Workspace(stale) = other_tab else {
                        continue;
                    };
                    if !same_project(w, stale) {
                        continue;
                    }
                    if restored_of(other_idx).get(id) == Some(origin) {
                        stale.drafts.remove(id);
                        stale.attachment_drafts.remove(id);
                        stale.attachment_parts.remove(id);
                    }
                }
            }
        }
        let mut emitted_tombstones: Vec<(usize, String, Vec<usize>)> = Vec::new();
        for idx in 0..refs.len() {
            let Tab::Workspace(w) = &refs[idx].saved else {
                continue;
            };
            let cleared = cleared_of(idx);
            for (id, auth) in clear_authority_of(idx) {
                let has_saved_content = matches!(
                    &tabs[idx],
                    Tab::Workspace(cur)
                        if cur.drafts.get(id).is_some_and(|text| !text.is_empty())
                            || cur.attachment_drafts.contains(id)
                            || cur.attachment_parts.contains_key(id)
                );
                if !cleared.contains(id) || has_saved_content {
                    continue;
                }
                let mut targeted = Vec::new();
                let mut has_independent = false;
                for (other_idx, other_tab) in tabs.iter().enumerate().take(refs.len()) {
                    if other_idx == idx {
                        continue;
                    }
                    let Tab::Workspace(old) = other_tab else {
                        continue;
                    };
                    if !same_project(w, old) {
                        continue;
                    }
                    let other_has_content = old.drafts.get(id).is_some_and(|text| !text.is_empty())
                        || old.attachment_drafts.contains(id)
                        || old.attachment_parts.contains_key(id);
                    if !other_has_content {
                        continue;
                    }
                    if auth.matches_restored(restored_of(other_idx).get(id)) {
                        targeted.push(other_idx);
                    } else {
                        has_independent = true;
                    }
                }
                if targeted.is_empty() {
                    continue;
                }
                let current_full = matches!(
                    &tabs[idx],
                    Tab::Workspace(current)
                        if !current.drafts.contains_key(id)
                            && current.drafts.len() >= super::MAX_DRAFTS
                );
                if has_independent || current_full {
                    // Prune only the superseded restored copies so neither an independent sibling
                    // edit nor per-tab MAX_DRAFTS shedding can defeat clear authority on restart.
                    for target_idx in targeted {
                        if let Tab::Workspace(stale) = &mut tabs[target_idx] {
                            stale.drafts.remove(id);
                            stale.attachment_drafts.remove(id);
                            stale.attachment_parts.remove(id);
                        }
                    }
                } else if let Tab::Workspace(current) = &mut tabs[idx] {
                    current.drafts.insert(id.clone(), String::new());
                    emitted_tombstones.push((idx, id.clone(), targeted));
                }
            }
        }
        let mut snap = Snapshot {
            revision: self.revision,
            saved_at: self.saved_at,
            panel_widths: self.panel_widths,
            file_wrap: self.file_wrap,
            tabs,
            active,
        };
        // If any persisted "" clear tombstone would trigger budget shedding (MAX_DRAFTS,
        // MAX_STRINGS, or MAX_BYTES), replace tombstones by directly pruning their targeted
        // sibling copies so shedding can never drop the tombstone while keeping the stale copy.
        if !emitted_tombstones.is_empty() && super::encode(&snap).is_err() {
            for (clear_idx, id, targeted) in emitted_tombstones {
                if let Tab::Workspace(current) = &mut snap.tabs[clear_idx]
                    && current.drafts.get(&id).is_some_and(String::is_empty)
                {
                    current.drafts.remove(&id);
                }
                for target_idx in targeted {
                    if let Tab::Workspace(stale) = &mut snap.tabs[target_idx] {
                        stale.drafts.remove(&id);
                        stale.attachment_drafts.remove(&id);
                        stale.attachment_parts.remove(&id);
                    }
                }
            }
        }
        // Persist closed drafts whose deletion recovery was deferred (e.g. temporary CSPRNG
        // outage) into available v1 snapshot slots (__no_session_draft__ and unoccupied sibling
        // session_id slots) without mutating live state, changing v1 JSON, or exceeding any
        // global v1 budget (so fallback projections never cause encode_for_save to evict an
        // existing persistable draft).
        // Limit: if CSPRNG fails and more closed drafts exist than available v1 slots or global
        // v1 budget allows, extra copies cannot be stored without substituting weak UUIDs or
        // changing the v1 schema.
        if !self.closed_pending_deleted.is_empty() {
            // Optional project names drop before drafts (matching save_snapshot.rs), so exclude
            // them while computing fallback draft budgets and restore as many as still fit in
            // reverse drop order (active tab first).
            let original_project_names: Vec<Option<String>> = snap
                .tabs
                .iter_mut()
                .map(|tab| match tab {
                    Tab::Workspace(w) => w.project_name.take(),
                    Tab::Blank => None,
                })
                .collect();
            let mut any_fallback_added = false;
            if let Ok(mut used_units) = super::snapshot_string_units(&snap)
                && used_units <= super::MAX_STRINGS
                && let Ok(encoded) = super::snapshot_bytes(&snap)
                && encoded.len() <= super::MAX_BYTES
            {
                let mut used_bytes = encoded.len();
                let tab_has_room = |w: &Workspace, extra: &[&str]| -> bool {
                    let mut keys: HashSet<&str> = w
                        .drafts
                        .keys()
                        .chain(w.attachment_drafts.iter())
                        .chain(w.attachment_parts.keys())
                        .map(String::as_str)
                        .collect();
                    for key in extra {
                        keys.insert(*key);
                    }
                    keys.len() <= super::MAX_DRAFTS
                };
                #[derive(Clone, Copy)]
                struct TabContainers {
                    drafts_empty: bool,
                    att_empty: bool,
                    parts_empty: bool,
                }
                struct BundleCost {
                    has_text: bool,
                    has_att: bool,
                    has_parts: bool,
                    valid: bool,
                    text_u16: usize,
                    text_json: usize,
                    parts_json: usize,
                }
                impl BundleCost {
                    fn from_bundle(b: &drafts::ClosedBundle) -> Self {
                        let text = b.text.as_deref().filter(|t| !t.is_empty());
                        let has_text = text.is_some();
                        let has_att = b.attachment_draft || b.attachment_parts.is_some();
                        let has_parts = b.attachment_parts.is_some();
                        let text_u16 = text.map_or(0, |t| t.encode_utf16().count());
                        let parts_valid = b.attachment_parts.as_ref().is_none_or(|p| p.valid());
                        let valid =
                            (has_text || has_att) && text_u16 <= super::MAX_DRAFT && parts_valid;
                        let text_json = text
                            .and_then(|t| serde_json::to_vec(t).ok().map(|v| v.len()))
                            .unwrap_or(0);
                        let parts_json = b
                            .attachment_parts
                            .as_ref()
                            .and_then(|p| serde_json::to_vec(&p.encode()).ok().map(|v| v.len()))
                            .unwrap_or(0);
                        Self {
                            has_text,
                            has_att,
                            has_parts,
                            valid,
                            text_u16,
                            text_json,
                            parts_json,
                        }
                    }
                    fn units(&self, key_u16: usize, key_valid: bool) -> Option<usize> {
                        if !self.valid || !key_valid {
                            return None;
                        }
                        let mut u = 0usize;
                        if self.has_text {
                            u = u.saturating_add(key_u16).saturating_add(self.text_u16);
                        }
                        if self.has_att {
                            u = u.saturating_add(key_u16);
                        }
                        Some(u)
                    }
                    fn bytes(&self, key_json: usize, c: TabContainers) -> usize {
                        let mut n = 0usize;
                        if self.has_text {
                            n = n
                                .saturating_add(key_json)
                                .saturating_add(1)
                                .saturating_add(self.text_json)
                                .saturating_add(usize::from(!c.drafts_empty));
                        }
                        if self.has_att {
                            n = n.saturating_add(key_json).saturating_add(if c.att_empty {
                                ",\"attachmentDrafts\":[]".len()
                            } else {
                                1
                            });
                        }
                        if self.has_parts {
                            n = n
                                .saturating_add(key_json)
                                .saturating_add(1)
                                .saturating_add(self.parts_json)
                                .saturating_add(if c.parts_empty {
                                    ",\"attachmentParts\":{}".len()
                                } else {
                                    1
                                });
                        }
                        n
                    }
                    fn apply_containers(&self, c: TabContainers) -> TabContainers {
                        TabContainers {
                            drafts_empty: c.drafts_empty && !self.has_text,
                            att_empty: c.att_empty && !self.has_att,
                            parts_empty: c.parts_empty && !self.has_parts,
                        }
                    }
                }
                // Exact maximum-cardinality, lexicographically smallest (newest-first) subset under a
                // single additive budget, given `(bundle_idx, weight)` sorted by ascending `bundle_idx`.
                fn best_subset_1d(
                    pool: &[(usize, usize)],
                    cap: usize,
                    budget: usize,
                ) -> Vec<usize> {
                    if cap == 0 || pool.is_empty() {
                        return Vec::new();
                    }
                    let mut weights: Vec<usize> = pool.iter().map(|&(_, w)| w).collect();
                    weights.sort_unstable();
                    let mut k_max = 0usize;
                    let mut sum = 0usize;
                    for w in weights.into_iter().take(cap) {
                        if sum.saturating_add(w) <= budget {
                            sum += w;
                            k_max += 1;
                        } else {
                            break;
                        }
                    }
                    if k_max == 0 {
                        return Vec::new();
                    }
                    let mut chosen = Vec::with_capacity(k_max);
                    let mut rem = budget;
                    let mut need = k_max;
                    for (pos, &(idx, w)) in pool.iter().enumerate() {
                        if need == 0 {
                            break;
                        }
                        if w > rem {
                            continue;
                        }
                        let after_need = need - 1;
                        let suffix = &pool[pos + 1..];
                        if suffix.len() < after_need {
                            continue;
                        }
                        if after_need == 0 {
                            chosen.push(idx);
                            break;
                        }
                        let mut tail: Vec<usize> = suffix.iter().map(|&(_, sw)| sw).collect();
                        tail.select_nth_unstable(after_need - 1);
                        let min_tail: usize = tail[..after_need]
                            .iter()
                            .copied()
                            .fold(0usize, usize::saturating_add);
                        if min_tail <= rem - w {
                            chosen.push(idx);
                            rem -= w;
                            need -= 1;
                        }
                    }
                    chosen
                }
                // Exact min-cost bipartite slot assignment with an exact surviving-tab quota
                // (Hungarian algorithm on an m x m matrix, m <= MAX_TABS = 32):
                // places `chosen` into `target_surv` surviving slots and `k - target_surv` deferred
                // slots while minimizing (exact JSON bytes, slot index).
                fn assign_slots_exact_surv(
                    chosen: &[usize],
                    slots: &[(usize, bool, TabContainers)],
                    costs: &[BundleCost],
                    ses_json: usize,
                    target_surv: usize,
                ) -> Option<(Vec<(usize, usize)>, usize)> {
                    let k = chosen.len();
                    let m = slots.len();
                    let surv_slots = slots.iter().filter(|s| !s.1).count();
                    let def_slots = m - surv_slots;
                    let target_def = k.checked_sub(target_surv)?;
                    if target_surv > surv_slots || target_def > def_slots {
                        return None;
                    }
                    if k == 0 {
                        return Some((Vec::new(), 0));
                    }
                    let extra_surv = surv_slots - target_surv;
                    const FORBIDDEN: i64 = 1i64 << 42;
                    let mut u = vec![0i64; m + 1];
                    let mut v = vec![0i64; m + 1];
                    let mut p = vec![0usize; m + 1];
                    let mut way = vec![0usize; m + 1];
                    for i in 1..=m {
                        p[0] = i;
                        let mut j0 = 0usize;
                        let mut minv = vec![i64::MAX; m + 1];
                        let mut used = vec![false; m + 1];
                        loop {
                            used[j0] = true;
                            let i0 = p[j0];
                            let mut delta = i64::MAX;
                            let mut j1 = 0usize;
                            for j in 1..=m {
                                if !used[j] {
                                    let (_, is_def, c) = slots[j - 1];
                                    let w = if i0 <= k {
                                        let b_cost =
                                            costs[chosen[i0 - 1]].bytes(ses_json, c) as i64;
                                        b_cost * 64 + (j - 1) as i64
                                    } else if i0 <= k + extra_surv {
                                        if is_def { FORBIDDEN } else { 0 }
                                    } else if is_def {
                                        0
                                    } else {
                                        FORBIDDEN
                                    };
                                    let cur = w - u[i0] - v[j];
                                    if cur < minv[j] {
                                        minv[j] = cur;
                                        way[j] = j0;
                                    }
                                    if minv[j] < delta {
                                        delta = minv[j];
                                        j1 = j;
                                    }
                                }
                            }
                            for j in 0..=m {
                                if used[j] {
                                    u[p[j]] += delta;
                                    v[j] -= delta;
                                } else {
                                    minv[j] -= delta;
                                }
                            }
                            j0 = j1;
                            if p[j0] == 0 {
                                break;
                            }
                        }
                        loop {
                            let j1 = way[j0];
                            p[j0] = p[j1];
                            j0 = j1;
                            if j0 == 0 {
                                break;
                            }
                        }
                    }
                    let mut assigns = Vec::with_capacity(k);
                    let mut total_bytes = 0usize;
                    for j in 1..=m {
                        if p[j] != 0 && p[j] <= k {
                            let bundle_idx = chosen[p[j] - 1];
                            let (tab_idx, _, c) = slots[j - 1];
                            total_bytes =
                                total_bytes.saturating_add(costs[bundle_idx].bytes(ses_json, c));
                            assigns.push((tab_idx, bundle_idx));
                        }
                    }
                    Some((assigns, total_bytes))
                }
                type BundleSig = (usize, bool, bool, bool, usize, usize);
                struct Exact2dCtx<'a> {
                    pool: &'a [usize],
                    ses_units: &'a [Option<usize>],
                    costs: &'a [BundleCost],
                    b_lb: &'a [usize],
                    slots: &'a [(usize, bool, TabContainers)],
                    ses_json: usize,
                    rem_u: usize,
                    rem_b: usize,
                    target_surv: usize,
                    min_u: &'a [Vec<usize>],
                    min_b: &'a [Vec<usize>],
                    lb_failed: Vec<Vec<Vec<(usize, usize)>>>,
                }
                impl Exact2dCtx<'_> {
                    fn dfs(
                        &mut self,
                        pos: usize,
                        need: usize,
                        cur_u: usize,
                        cur_b_lb: usize,
                        chosen: &mut Vec<usize>,
                        banned: &mut Vec<BundleSig>,
                    ) -> (
                        Option<(Vec<usize>, Vec<(usize, usize)>, usize, usize)>,
                        bool,
                    ) {
                        if need == 0 {
                            if let Some((assigns, total_b)) = assign_slots_exact_surv(
                                chosen,
                                self.slots,
                                self.costs,
                                self.ses_json,
                                self.target_surv,
                            ) && total_b <= self.rem_b
                            {
                                return (
                                    Some((chosen.clone(), assigns, cur_u, self.target_surv)),
                                    true,
                                );
                            }
                            return (None, true);
                        }
                        let n = self.pool.len();
                        if n - pos < need
                            || cur_u.saturating_add(self.min_u[pos][need]) > self.rem_u
                            || cur_b_lb.saturating_add(self.min_b[pos][need]) > self.rem_b
                        {
                            return (None, false);
                        }
                        if banned.is_empty()
                            && self.lb_failed[pos][need]
                                .iter()
                                .any(|&(fu, fb)| fu <= cur_u && fb <= cur_b_lb)
                        {
                            return (None, false);
                        }
                        let b_idx = self.pool[pos];
                        let u_cost = self.ses_units[b_idx].unwrap_or(usize::MAX);
                        let bc = &self.costs[b_idx];
                        let sig: BundleSig = (
                            u_cost,
                            bc.has_text,
                            bc.has_att,
                            bc.has_parts,
                            bc.text_json,
                            bc.parts_json,
                        );
                        let mut any_leaf = false;
                        let mut added_ban = false;
                        if !banned.contains(&sig) {
                            let nu = cur_u.saturating_add(u_cost);
                            let nb = cur_b_lb.saturating_add(self.b_lb[pos]);
                            if nu <= self.rem_u && nb <= self.rem_b {
                                chosen.push(b_idx);
                                let (found, leaf) =
                                    self.dfs(pos + 1, need - 1, nu, nb, chosen, banned);
                                if found.is_some() {
                                    return (found, true);
                                }
                                chosen.pop();
                                any_leaf |= leaf;
                            }
                            banned.push(sig);
                            added_ban = true;
                        }
                        let (found, leaf) =
                            self.dfs(pos + 1, need, cur_u, cur_b_lb, chosen, banned);
                        if added_ban {
                            banned.pop();
                        }
                        if found.is_some() {
                            return (found, true);
                        }
                        any_leaf |= leaf;
                        if !any_leaf && banned.is_empty() {
                            let list = &mut self.lb_failed[pos][need];
                            list.retain(|&(eu, eb)| !(eu >= cur_u && eb >= cur_b_lb));
                            list.push((cur_u, cur_b_lb));
                        }
                        (None, any_leaf)
                    }
                }
                let apply_bundle =
                    |snap: &mut Snapshot, dest: usize, key: &str, bundle: &drafts::ClosedBundle| {
                        let Tab::Workspace(w) = &mut snap.tabs[dest] else {
                            return;
                        };
                        if let Some(text) = &bundle.text
                            && !text.is_empty()
                        {
                            w.drafts.insert(key.into(), text.clone());
                        }
                        if bundle.attachment_draft || bundle.attachment_parts.is_some() {
                            w.attachment_drafts.insert(key.into());
                        }
                        if let Some(parts) = &bundle.attachment_parts {
                            w.attachment_parts.insert(key.into(), parts.clone());
                        }
                    };
                let local_u16 = super::NO_SESSION_DRAFT_ID.encode_utf16().count();
                let local_json = serde_json::to_vec(super::NO_SESSION_DRAFT_ID)
                    .map(|v| v.len())
                    .unwrap_or(usize::MAX);
                for (scope, id) in &self.closed_pending_deleted {
                    let clear_authorities =
                        drafts::collect_open_clear_authorities_for(refs.iter().copied(), scope, id);
                    let (closed_bundles, _) = drafts::collect_closed_bundles_for_recovery(
                        self,
                        scope,
                        id,
                        &clear_authorities,
                    );
                    if closed_bundles.is_empty() {
                        continue;
                    }
                    let projected_count = resynced_projected
                        .iter()
                        .find_map(|(s, k, count)| (s.same_scope(scope) && k == id).then_some(*count))
                        .unwrap_or_else(|| {
                            self.entries
                                .iter()
                                .filter(|entry| {
                                    entry.pending_drafts.contains(id)
                                        && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                                })
                                .count()
                        });
                    let no_session_free = !snap.tabs.iter().any(|tab| {
                        matches!(tab, Tab::Workspace(w) if scope.matches(w)
                        && (w.drafts.get(super::NO_SESSION_DRAFT_ID).is_some_and(|t| !t.is_empty())
                            || w.attachment_drafts.contains(super::NO_SESSION_DRAFT_ID)
                            || w.attachment_parts.contains_key(super::NO_SESSION_DRAFT_ID)))
                    });
                    let unprojected: Vec<_> =
                        closed_bundles.into_iter().skip(projected_count).collect();
                    if unprojected.is_empty() {
                        continue;
                    }
                    let rem_units = super::MAX_STRINGS.saturating_sub(used_units);
                    let rem_bytes = super::MAX_BYTES.saturating_sub(used_bytes);
                    let ses_u16 = id.encode_utf16().count();
                    let ses_valid = super::draft_id(id) && ses_u16 <= 256;
                    let ses_json = serde_json::to_vec(id)
                        .map(|v| v.len())
                        .unwrap_or(usize::MAX);
                    let costs: Vec<BundleCost> =
                        unprojected.iter().map(BundleCost::from_bundle).collect();
                    let local_units: Vec<Option<usize>> =
                        costs.iter().map(|c| c.units(local_u16, true)).collect();
                    let ses_units: Vec<Option<usize>> =
                        costs.iter().map(|c| c.units(ses_u16, ses_valid)).collect();
                    let tab_containers: Vec<Option<TabContainers>> = snap
                        .tabs
                        .iter()
                        .map(|tab| match tab {
                            Tab::Workspace(w) => Some(TabContainers {
                                drafts_empty: w.drafts.is_empty(),
                                att_empty: w.attachment_drafts.is_empty(),
                                parts_empty: w.attachment_parts.is_empty(),
                            }),
                            Tab::Blank => None,
                        })
                        .collect();
                    let can_host_session = |i: usize, extra_local: bool| -> bool {
                        matches!(
                            &snap.tabs[i],
                            Tab::Workspace(w)
                                if scope.matches(w)
                                    && !refs[i].cleared.contains(id)
                                    && !w.drafts.contains_key(id)
                                    && !w.attachment_drafts.contains(id)
                                    && !w.attachment_parts.contains_key(id)
                                    && if extra_local {
                                        tab_has_room(w, &[super::NO_SESSION_DRAFT_ID, id.as_str()])
                                    } else {
                                        tab_has_room(w, &[id.as_str()])
                                    }
                        )
                    };
                    // Maximize genuinely encodable preserved drafts across all `(no_session_dest,
                    // local_bundle_idx)` placements using exact precomputed UTF-16/byte costs, then
                    // break ties by surviving tabs, priority of kept bundles, local recovery slot
                    // usage, newest local bundle, and tab order; validate the winner once with full
                    // v1 `encode`.
                    #[derive(PartialEq, Eq, PartialOrd, Ord)]
                    struct FallbackRank {
                        kept: usize,
                        surviving: usize,
                        kept_priority: std::cmp::Reverse<Vec<usize>>,
                        used_no_session: bool,
                        newest_local: std::cmp::Reverse<usize>,
                        dest_surviving: bool,
                        dest_order: std::cmp::Reverse<usize>,
                    }
                    let mut candidates: Vec<(Option<usize>, Option<usize>)> = vec![(None, None)];
                    if no_session_free {
                        for (i, tab) in snap.tabs.iter().enumerate() {
                            if let Tab::Workspace(w) = tab
                                && scope.matches(w)
                                && !refs[i].cleared.contains(super::NO_SESSION_DRAFT_ID)
                                && tab_has_room(w, &[super::NO_SESSION_DRAFT_ID])
                            {
                                for bundle_idx in 0..unprojected.len() {
                                    if local_units[bundle_idx].is_some() {
                                        candidates.push((Some(i), Some(bundle_idx)));
                                    }
                                }
                            }
                        }
                    }
                    let mut best: Option<(
                        FallbackRank,
                        Option<(usize, usize)>,
                        Vec<(usize, usize)>,
                        usize,
                    )> = None;
                    for (no_session_dest, local_bundle_idx) in candidates {
                        let (local_u, local_b) =
                            if let (Some(dest), Some(lb)) = (no_session_dest, local_bundle_idx) {
                                let Some(lu) = local_units[lb] else {
                                    continue;
                                };
                                let Some(c) = tab_containers[dest] else {
                                    continue;
                                };
                                let lb_bytes = costs[lb].bytes(local_json, c);
                                if lu > rem_units || lb_bytes > rem_bytes {
                                    continue;
                                }
                                (lu, lb_bytes)
                            } else {
                                (0, 0)
                            };
                        let rem_u = rem_units - local_u;
                        let rem_b = rem_bytes - local_b;
                        let mut slots: Vec<(usize, bool, TabContainers)> = Vec::new();
                        let mut surviving_slots = 0usize;
                        for prefer_surviving in [true, false] {
                            for i in 0..snap.tabs.len() {
                                if refs[i].closing_deferred == prefer_surviving {
                                    continue;
                                }
                                let is_local_dest = no_session_dest == Some(i);
                                if !can_host_session(i, is_local_dest) {
                                    continue;
                                }
                                let Some(mut c) = tab_containers[i] else {
                                    continue;
                                };
                                if is_local_dest && let Some(lb) = local_bundle_idx {
                                    c = costs[lb].apply_containers(c);
                                }
                                slots.push((i, !prefer_surviving, c));
                                if prefer_surviving {
                                    surviving_slots += 1;
                                }
                            }
                        }
                        let pool: Vec<usize> = (0..unprojected.len())
                            .filter(|&b| local_bundle_idx != Some(b))
                            .filter(|&b| {
                                ses_units[b].is_some_and(|u| u <= rem_u)
                                    && slots
                                        .iter()
                                        .any(|&(_, _, c)| costs[b].bytes(ses_json, c) <= rem_b)
                            })
                            .collect();
                        let pool_u: Vec<(usize, usize)> = pool
                            .iter()
                            .filter_map(|&b| Some((b, ses_units[b]?)))
                            .collect();
                        let (chosen_ses, ses_assigns, ses_u, ses_surviving) = {
                            let cand_u = best_subset_1d(&pool_u, slots.len(), rem_u);
                            let cand_max_surv = cand_u.len().min(surviving_slots);
                            if let Some((assigns, total_b)) = assign_slots_exact_surv(
                                &cand_u,
                                &slots,
                                &costs,
                                ses_json,
                                cand_max_surv,
                            ) && total_b <= rem_b
                            {
                                let u_sum: usize = cand_u
                                    .iter()
                                    .filter_map(|&b| ses_units[b])
                                    .fold(0usize, usize::saturating_add);
                                (cand_u, assigns, u_sum, cand_max_surv)
                            } else if pool.is_empty() || slots.is_empty() {
                                (Vec::new(), Vec::new(), 0, 0)
                            } else {
                                let b_lb: Vec<usize> = pool
                                    .iter()
                                    .map(|&b| {
                                        slots
                                            .iter()
                                            .map(|&(_, _, c)| costs[b].bytes(ses_json, c))
                                            .min()
                                            .unwrap_or(usize::MAX)
                                    })
                                    .collect();
                                let mut sorted_b = b_lb.clone();
                                sorted_b.sort_unstable();
                                let mut k_b_max = 0usize;
                                let mut b_sum = 0usize;
                                for w in sorted_b.into_iter().take(slots.len()) {
                                    if b_sum.saturating_add(w) <= rem_b {
                                        b_sum += w;
                                        k_b_max += 1;
                                    } else {
                                        break;
                                    }
                                }
                                let k_upper = cand_u.len().min(k_b_max);
                                let n = pool.len();
                                let mut min_u = vec![vec![usize::MAX; k_upper + 1]; n + 1];
                                let mut min_b = vec![vec![usize::MAX; k_upper + 1]; n + 1];
                                for pos in 0..=n {
                                    min_u[pos][0] = 0;
                                    min_b[pos][0] = 0;
                                    let mut su: Vec<usize> =
                                        pool[pos..].iter().filter_map(|&b| ses_units[b]).collect();
                                    su.sort_unstable();
                                    let mut sb: Vec<usize> = b_lb[pos..].to_vec();
                                    sb.sort_unstable();
                                    let mut acc_u = 0usize;
                                    let mut acc_b = 0usize;
                                    for need in 1..=k_upper.min(n - pos) {
                                        acc_u = acc_u.saturating_add(su[need - 1]);
                                        acc_b = acc_b.saturating_add(sb[need - 1]);
                                        min_u[pos][need] = acc_u;
                                        min_b[pos][need] = acc_b;
                                    }
                                }
                                let def_slots = slots.len() - surviving_slots;
                                let mut found_exact = None;
                                for target_k in (1..=k_upper).rev() {
                                    let max_surv = target_k.min(surviving_slots);
                                    let min_surv = target_k.saturating_sub(def_slots);
                                    for target_surv in (min_surv..=max_surv).rev() {
                                        let mut ctx = Exact2dCtx {
                                            pool: &pool,
                                            ses_units: &ses_units,
                                            costs: &costs,
                                            b_lb: &b_lb,
                                            slots: &slots,
                                            ses_json,
                                            rem_u,
                                            rem_b,
                                            target_surv,
                                            min_u: &min_u,
                                            min_b: &min_b,
                                            lb_failed: vec![vec![Vec::new(); target_k + 1]; n + 1],
                                        };
                                        let mut chosen = Vec::with_capacity(target_k);
                                        let mut banned = Vec::new();
                                        if let (Some(res), _) =
                                            ctx.dfs(0, target_k, 0, 0, &mut chosen, &mut banned)
                                        {
                                            found_exact = Some(res);
                                            break;
                                        }
                                    }
                                    if found_exact.is_some() {
                                        break;
                                    }
                                }
                                found_exact.unwrap_or_else(|| (Vec::new(), Vec::new(), 0, 0))
                            }
                        };
                        let kept = usize::from(local_bundle_idx.is_some()) + chosen_ses.len();
                        if kept == 0 {
                            continue;
                        }
                        let mut kept_indices = chosen_ses;
                        if let Some(lb) = local_bundle_idx {
                            kept_indices.push(lb);
                            kept_indices.sort_unstable();
                        }
                        let surviving = ses_surviving
                            + usize::from(
                                no_session_dest.is_some_and(|i| !refs[i].closing_deferred),
                            );
                        let rank = FallbackRank {
                            kept,
                            surviving,
                            kept_priority: std::cmp::Reverse(kept_indices),
                            used_no_session: local_bundle_idx.is_some(),
                            newest_local: std::cmp::Reverse(local_bundle_idx.unwrap_or(usize::MAX)),
                            dest_surviving: no_session_dest
                                .is_some_and(|i| !refs[i].closing_deferred),
                            dest_order: std::cmp::Reverse(no_session_dest.unwrap_or(usize::MAX)),
                        };
                        if best
                            .as_ref()
                            .is_none_or(|(best_rank, ..)| rank > *best_rank)
                        {
                            best = Some((
                                rank,
                                no_session_dest.zip(local_bundle_idx),
                                ses_assigns,
                                local_u + ses_u,
                            ));
                        }
                    }
                    if let Some((_, local_assign, ses_assigns, delta_u)) = best {
                        let added = local_assign.is_some() || !ses_assigns.is_empty();
                        let mut cand = snap.clone();
                        if let Some((dest, lb)) = local_assign {
                            apply_bundle(
                                &mut cand,
                                dest,
                                super::NO_SESSION_DRAFT_ID,
                                &unprojected[lb],
                            );
                        }
                        for (dest, b) in ses_assigns {
                            apply_bundle(&mut cand, dest, id, &unprojected[b]);
                        }
                        if let Ok(encoded) = super::encode(&cand) {
                            snap = cand;
                            used_units += delta_u;
                            used_bytes = encoded.len();
                            any_fallback_added |= added;
                        }
                    }
                }
            }
            if !any_fallback_added {
                for (tab, name) in snap.tabs.iter_mut().zip(original_project_names) {
                    if let Tab::Workspace(w) = tab {
                        w.project_name = name;
                    }
                }
            } else {
                for index in super::project_name_drop_order(&snap).into_iter().rev() {
                    let Some(name) = original_project_names[index].as_ref() else {
                        continue;
                    };
                    if let Tab::Workspace(w) = &mut snap.tabs[index] {
                        w.project_name = Some(name.clone());
                    } else {
                        continue;
                    }
                    let fits = super::snapshot_string_units(&snap)
                        .is_ok_and(|u| u <= super::MAX_STRINGS)
                        && super::snapshot_bytes(&snap).is_ok_and(|b| b.len() <= super::MAX_BYTES);
                    if !fits && let Tab::Workspace(w) = &mut snap.tabs[index] {
                        w.project_name = None;
                    }
                }
            }
        }
        snap
    }
    fn hydrate(&mut self, saved: Snapshot) {
        if self.touched {
            self.persistence.read_error = true;
            return;
        }
        self.entries = saved
            .tabs
            .into_iter()
            .enumerate()
            .map(|(i, tab)| entry(format!("tab-{i}"), tab))
            .collect();
        if self.entries.is_empty() {
            self.entries.push(entry("tab-0".into(), Tab::Blank));
        }
        self.active = saved.active.unwrap_or(0).min(self.entries.len() - 1);
        self.next_key = self.entries.len() as u64;
        self.revision = saved.revision;
        self.saved_at = saved.saved_at;
        self.panel_widths = saved.panel_widths;
        self.file_wrap = saved.file_wrap;
    }
    pub(super) fn release_all_with_stashed(&self, stashed: Option<&StashedTemporary>) {
        let mut records: Vec<_> = self
            .entries
            .iter()
            .filter_map(|item| Some((item.binding.clone()?, item.project.as_ref()?.id.clone())))
            .collect();
        if let Some(stashed) = stashed {
            records.push((stashed.backend.clone(), stashed.project.id.clone()));
        }
        platform::release_records_on_exit(records, self.openings.clone());
    }
    pub(super) fn stage_with_stashed(&mut self, stashed: Option<&StashedTemporary>) {
        #[cfg(target_arch = "wasm32")]
        if let Some(store) = &self.persistence.store {
            store.watch_openings(self.openings.clone());
        }
        if self.persistence.read_error
            || !self.ready
            || (stashed.is_none() && self.staged_revision == Some(self.revision))
        {
            return;
        }
        let Some(store) = &self.persistence.store else {
            return;
        };
        let mut records: Vec<_> = self
            .entries
            .iter()
            .filter_map(|e| {
                Some((
                    e.binding.as_ref()?.base.clone(),
                    e.project.as_ref()?.id.clone(),
                ))
            })
            .collect();
        if let Some(stashed) = stashed {
            records.push((stashed.backend.base.clone(), stashed.project.id.clone()));
        }
        if self.persistence.suppresses_snapshot(self.revision) {
            store.stage(&[], &records);
            if stashed.is_none() {
                self.staged_revision = Some(self.revision);
            }
            return;
        }
        let bytes = match super::encode_for_save(&self.snapshot_with_stashed(stashed)) {
            Ok((bytes, partial)) => {
                self.persistence.partial = partial;
                bytes
            }
            Err(_) => {
                store.stage(&[], &[]);
                self.persistence.write_error = true;
                return;
            }
        };
        store.stage(&bytes, &records);
        if stashed.is_none() {
            self.staged_revision = Some(self.revision);
        }
    }
    pub(crate) fn persistence_store(&self) -> Option<platform::storage::Store> {
        self.persistence.store.clone()
    }
    pub(crate) fn is_primary_startup(&self) -> bool {
        self.ready && self.persistence.store.is_some()
    }
    #[cfg(test)]
    pub(crate) fn fixture_primary_store(&mut self, store: platform::storage::Store) {
        self.ready = true;
        self.persistence.store = Some(store);
    }
    #[cfg(test)]
    pub(crate) fn fixture_unreadable_restore(&mut self) {
        self.touched = false;
        self.persistence.restore_enabled = false;
        self.persistence.restore_read_error = true;
        self.persistence.read_error = true;
        self.persistence.file_draft_read_error = true;
    }
    #[cfg(test)]
    pub(crate) fn persistence_loading(&self) -> bool {
        self.persistence.loading
    }
    #[cfg(test)]
    pub(crate) fn workspace_revision(&self) -> u64 {
        self.revision
    }
    pub(crate) fn restore_enabled(&self) -> bool {
        self.persistence.restore_enabled
    }
    pub(crate) fn begin_startup_mutation(
        &mut self,
        documents: &crate::files::document::store::Store,
        outlines: &mut super::outlines::Cache,
        stashed: Option<&StashedTemporary>,
    ) {
        self.persistence
            .begin_startup_mutation(self.revision, documents, outlines);
        self.staged_revision = None;
        self.stage_with_stashed(stashed);
    }
    pub(crate) fn cancel_startup_mutation(
        &mut self,
        outlines: &mut super::outlines::Cache,
        stashed: Option<&StashedTemporary>,
    ) {
        self.persistence.cancel_startup_mutation(outlines);
        self.staged_revision = None;
        self.stage_with_stashed(stashed);
    }
    pub(crate) fn apply_restore_enabled(
        &mut self,
        enabled: bool,
        documents: &crate::files::document::store::Store,
        outlines: &mut super::outlines::Cache,
        wake: rune::Waker,
        stashed: Option<&StashedTemporary>,
    ) {
        if self
            .persistence
            .apply_restore_enabled(enabled, self.revision, documents, outlines, wake)
        {
            self.changed();
        }
        self.staged_revision = None;
        self.stage_with_stashed(stashed);
    }
    pub(crate) fn apply_startup_cleared(
        &mut self,
        outcome: platform::storage::ClearOutcome,
        documents: &crate::files::document::store::Store,
        outlines: &mut super::outlines::Cache,
        stashed: Option<&StashedTemporary>,
    ) {
        self.persistence
            .apply_cleared(outcome, self.revision, documents, outlines);
        self.staged_revision = None;
        self.stage_with_stashed(stashed);
    }
}
fn same_backend(a: &Workspace, b: &Workspace) -> bool {
    a.backend_id == b.backend_id && (a.backend_id.is_none() || a.server_id == b.server_id)
}
fn same_project(a: &Workspace, b: &Workspace) -> bool {
    same_folder(&a.folder, &b.folder) && same_backend(a, b)
}
fn entry(key: String, mut saved: Tab) -> Entry {
    let mut cleared = HashSet::new();
    let mut restored_drafts = std::collections::BTreeMap::new();
    let mut derived_from = std::collections::BTreeMap::new();
    let mut clear_authority = std::collections::BTreeMap::new();
    if let Tab::Workspace(w) = &mut saved {
        let attachment_drafts = &w.attachment_drafts;
        let attachment_parts = &w.attachment_parts;
        w.drafts.retain(|id, text| {
            if text.is_empty() {
                if !attachment_drafts.contains(id) && !attachment_parts.contains_key(id) {
                    cleared.insert(id.clone());
                    clear_authority.insert(id.clone(), drafts::ClearAuthority::Persisted);
                }
                false
            } else {
                true
            }
        });
        let keys: std::collections::BTreeSet<String> = w
            .drafts
            .keys()
            .chain(w.attachment_drafts.iter())
            .chain(w.attachment_parts.keys())
            .cloned()
            .collect();
        for id in keys {
            if let Some(copy) = drafts::DraftCopy::from_workspace(w, &id) {
                restored_drafts.insert(id.clone(), copy.clone());
                derived_from.insert(id, copy);
            }
        }
    }
    Entry {
        key,
        saved,
        cache: None,
        history_touched: 0,
        project: None,
        sessions: Vec::new(),
        listed_sessions: HashSet::new(),
        creation_uncertain: false,
        creation_uncertain_linked: None,
        rebind_after_send: None,
        next: None,
        linked: Default::default(),
        consumed_cursors: HashSet::new(),
        visits: Default::default(),
        catalogue: Default::default(),
        blank_cleanup: Default::default(),
        idle_markers: Default::default(),
        wanted_panels: [None; 2],
        sidebar_edits: None,
        binding: None,
        missions: None,
        cleared,
        pending_drafts: HashSet::new(),
        restored_drafts,
        derived_from,
        clear_authority,
        superseded_on_delete: HashSet::new(),
        pending_deleted: std::collections::BTreeSet::new(),
        closing_deferred: false,
        live_drafts: Default::default(),
        unmarked_by_registry: false,
    }
}
fn busy(s: &State) -> bool {
    s.status_permissions.settling()
        || s.transcript_display.messages.pending()
        || s.temporary.in_flight()
        || s.screen.launcher().is_some_and(|l| l.pending)
        || s.workspace.as_ref().is_some_and(|ui| !ui.ready)
}
pub fn input_ready(s: &State) -> bool {
    s.workspace.as_ref().is_none_or(|ui| ui.ready)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn native_window_store(s: &State) -> Option<platform::storage::Store> {
    s.workspace.as_ref()?.persistence.store.clone()
}
pub fn active_session(s: &State) -> Option<&str> {
    let ui = s.workspace.as_ref()?;
    match &ui.entries[ui.active].saved {
        Tab::Workspace(w) => w.active_session_id.as_deref(),
        Tab::Blank => None,
    }
}
pub fn unselect_session(s: &mut State, id: &str) -> bool {
    if active_session(s) != Some(id) {
        return false;
    }
    let stream_deleted = crate::chat::events::drain_outgoing_incoming_deleted(s);
    capture(s);
    drafts::drain_window_deleted_sessions(s);
    let was_pending_deleted = {
        let Some(ui) = &mut s.workspace else {
            return false;
        };
        let entry = &mut ui.entries[ui.active];
        let Tab::Workspace(saved) = &mut entry.saved else {
            return false;
        };
        saved.active_session_id = None;
        let pending = entry.pending_deleted.remove(id) || stream_deleted;
        ui.changed();
        ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
        pending
    };
    if was_pending_deleted {
        recover_missing_session_draft(s, id);
    }
    true
}
pub fn unselect_missing(s: &mut State, id: &str) -> bool {
    if active_session(s) != Some(id) {
        return false;
    }
    capture(s);
    let stashed = s.temporary.stashed_for_snapshot();
    {
        let Some(ui) = &mut s.workspace else {
            return false;
        };
        let entry = &mut ui.entries[ui.active];
        let Tab::Workspace(saved) = &mut entry.saved else {
            return false;
        };
        saved.active_session_id = None;
        entry.pending_deleted.remove(id);
        ui.changed();
        ui.stage_with_stashed(stashed);
    }
    recover_missing_session_draft(s, id);
    true
}
pub fn prepare_open(s: &mut State, tx: &mut Tx) -> bool {
    if busy(s) {
        return false;
    }
    if s.workspace
        .as_ref()
        .is_some_and(|ui| matches!(ui.entries[ui.active].saved, Tab::Workspace(_)))
    {
        if s.workspace
            .as_ref()
            .is_some_and(|ui| ui.entries.len() >= super::MAX_TABS)
        {
            return false;
        }
        let folder = s
            .screen
            .launcher()
            .map(|l| l.folder.text.clone())
            .unwrap_or_default();
        new_tab(s, tx);
        if let Some(l) = s.screen.launcher_mut() {
            l.folder = TextEdit::new(folder);
        }
    }
    true
}
pub fn connected(s: &mut State) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    if let Some(l) = s.screen.launcher_mut() {
        l.openings = ui.openings.clone();
    }
    #[cfg(not(target_arch = "wasm32"))]
    let directory = s
        .screen
        .launcher()
        .and_then(|l| l.state_directory())
        .or_else(platform::storage::configured_directory);
    #[cfg(target_arch = "wasm32")]
    let directory = None;
    ui.persistence
        .start(directory, &s.documents, s.wake.clone());
    if ui.persistence.loading {
        ui.ready = false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !ui.persistence.loading && ui.persistence.store.is_none() && !ui.persistence.read_error {
        ui.ready = true;
    }
}
pub(crate) fn renew_connection(s: &mut State) {
    let Some(current) = s.screen.launcher().and_then(|l| l.connection.as_ref()) else {
        return;
    };
    if let Some(ui) = &mut s.workspace {
        for (index, item) in ui.entries.iter_mut().enumerate() {
            if let Some(backend) = &mut item.binding
                && backend.base == current.base
                && backend.client.server_identity().is_some()
                && backend.client.server_identity() == current.client.server_identity()
            {
                backend.client = current.client.clone();
                backend.client_id.clone_from(&current.client_id);
                if index != ui.active
                    && item.cache.is_some()
                    && let Tab::Workspace(w) = &item.saved
                    && let Some(id) = &w.active_session_id
                {
                    item.rebind_after_send = Some(id.clone());
                }
            }
        }
    }
}
impl Drop for Ui {
    fn drop(&mut self) {
        self.openings.close();
        #[cfg(target_arch = "wasm32")]
        {
            if let Some(store) = &self.persistence.store {
                store.depart();
            }
            platform::storage::cancel_openings(&self.openings);
        }
    }
}
pub fn resume(s: &mut State, tx: &mut Tx) {
    if s.workspace
        .as_ref()
        .is_some_and(|ui| ui.ready && ui.entries[ui.active].project.is_none())
    {
        activate(s, tx);
    }
}
pub fn retry(s: &mut State, tx: &mut Tx) {
    if let Some(ui) = &mut s.workspace {
        ui.persistence.retry();
        ui.persistence.retry_file_drafts(s.wake.clone());
    }
    tx.wake_after(std::time::Duration::ZERO);
    connected(s);
    resume(s, tx);
}
pub fn opened(s: &mut State, project: &Project) {
    let (Some(ui), Some(l)) = (&mut s.workspace, s.screen.launcher()) else {
        return;
    };
    let backend_id = if l.local_connection() {
        None
    } else {
        Some(
            if cfg!(target_arch = "wasm32") {
                "web"
            } else {
                "external"
            }
            .to_string(),
        )
    };
    let occurrence = (0..super::MAX_TABS as u64).find(|ordinal| !ui.entries.iter().any(|entry| {
        matches!(&entry.saved, Tab::Workspace(w) if same_folder(&w.folder, &project.path) && w.backend_id == backend_id && (backend_id.is_none() || w.server_id == l.server_id) && w.occurrence == *ordinal)
    })).unwrap_or(0);
    let inherited_name = ui
        .entries
        .iter()
        .find_map(|entry| match &entry.saved {
            Tab::Workspace(w)
                if same_folder(&w.folder, &project.path)
                    && w.backend_id == backend_id
                    && (backend_id.is_none() || w.server_id == l.server_id) =>
            {
                w.project_name.clone()
            }
            _ => None,
        })
        .or_else(|| {
            ui.closed.iter().rev().find_map(|w| {
                (same_folder(&w.folder, &project.path)
                    && w.backend_id == backend_id
                    && (backend_id.is_none() || w.server_id == l.server_id))
                    .then(|| w.project_name.clone())
                    .flatten()
            })
        });
    let initial_name = inherited_name.or_else(|| {
        if project.temporary {
            let base = crate::shell::temporary::base_name();
            Some(temporary::next_temporary_name(ui, &base))
        } else {
            None
        }
    });
    let item = &mut ui.entries[ui.active];
    if matches!(&item.saved, Tab::Workspace(w) if same_folder(&w.folder, &project.path) && w.backend_id == backend_id && (backend_id.is_none() || w.server_id == l.server_id))
    {
        if let Tab::Workspace(w) = &mut item.saved {
            w.workspace_id = Some(project.id.clone());
            w.temporary = project.temporary;
            if w.temporary && w.project_name.is_none() {
                w.project_name = initial_name;
            }
        }
    } else {
        let reopen_scope = ProjectScope {
            backend_id: backend_id.clone(),
            server_id: if backend_id.is_some() {
                l.server_id.clone()
            } else {
                None
            },
            folder: project.path.clone(),
        };
        let closed_keys: std::collections::BTreeSet<String> = ui
            .closed
            .iter()
            .filter(|w| reopen_scope.matches(w))
            .flat_map(|w| {
                w.drafts
                    .keys()
                    .chain(w.attachment_drafts.iter())
                    .chain(w.attachment_parts.keys())
            })
            .cloned()
            .collect();
        let pending_keys: HashSet<String> = closed_keys.iter().cloned().collect();
        let reopened_workspace = Workspace {
            backend_id: backend_id.clone(),
            server_id: if backend_id.is_some() {
                l.server_id.clone()
            } else {
                None
            },
            folder: project.path.clone(),
            project_name: initial_name,
            temporary: project.temporary,
            occurrence,
            workspace_id: Some(project.id.clone()),
            active_session_id: None,
            drafts: std::collections::BTreeMap::new(),
            attachment_drafts: std::collections::BTreeSet::new(),
            attachment_parts: std::collections::BTreeMap::new(),
            view: Default::default(),
        };
        let pending_deleted: Vec<String> = ui
            .closed_pending_deleted
            .iter()
            .filter_map(|(scope, id)| scope.matches(&reopened_workspace).then(|| id.clone()))
            .collect();
        let item = &mut ui.entries[ui.active];
        item.blank_cleanup.clear();
        item.idle_markers.clear();
        item.cleared.clear();
        item.pending_drafts = pending_keys;
        item.restored_drafts.clear();
        item.derived_from.clear();
        item.clear_authority.clear();
        item.superseded_on_delete.clear();
        item.pending_deleted.extend(pending_deleted);
        item.saved = Tab::Workspace(reopened_workspace);
        item.live_drafts.clear();
        for id in &closed_keys {
            drafts::sync_pending_closed_projections(ui, &reopen_scope, id);
        }
    }
    let item = &mut ui.entries[ui.active];
    item.project = Some(project.clone());
    item.binding = l.connection.clone();
    if cfg!(target_os = "windows") {
        item.catalogue.schedule(ui.clock);
    }
    ui.changed();
    s.command_palette.dismiss();
    s.tab_rename.dismiss();
}

pub fn schedule_catalogue(s: &mut State) {
    let allow = cfg!(target_os = "windows")
        || cfg!(not(target_arch = "wasm32"))
            && s.screen
                .launcher()
                .is_some_and(|l| l.creation_uncertain_linked.is_some());
    if allow && let Some(ui) = &mut s.workspace {
        ui.entries[ui.active].catalogue.schedule(ui.clock);
    }
}

pub fn schedule_catalogue_refresh(s: &mut State) {
    if let Some(ui) = &mut s.workspace {
        ui.entries[ui.active].catalogue.schedule_urgent(ui.clock);
    }
    #[cfg(target_arch = "wasm32")]
    if let Some(l) = s.screen.launcher_mut() {
        l.linked.mark_reload();
    }
}
pub fn has_conversation_stream(s: &State) -> bool {
    s.incoming
        .as_ref()
        .is_some_and(|incoming| !incoming.is_closed())
        || s.workspace.as_ref().is_some_and(|ui| {
            ui.entries.iter().any(|entry| {
                entry
                    .cache
                    .as_ref()
                    .is_some_and(Cache::has_conversation_stream)
            })
        })
}

pub fn conversation_stream_clients(s: &State) -> Vec<(String, bool)> {
    let mut clients = Vec::new();
    if s.incoming
        .as_ref()
        .is_some_and(|incoming| !incoming.is_closed())
        && let Some(id) = &s.conversation_client_id
    {
        clients.push((id.clone(), s.conversation_stream_connected));
    }
    if let Some(ui) = &s.workspace {
        for entry in &ui.entries {
            if let Some(cache) = &entry.cache
                && cache.has_conversation_stream()
                && let Some(id) = cache.conversation_client_id()
                && !clients.iter().any(|(existing, _)| existing == id)
            {
                clients.push((id.to_owned(), cache.has_healthy_conversation_stream()));
            }
        }
    }
    clients
}

#[cfg(test)]
mod authentication_tests;
mod catalogue;
mod history_budget;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) use history_budget::evict_for_probe;
#[cfg(test)]
mod tests;
