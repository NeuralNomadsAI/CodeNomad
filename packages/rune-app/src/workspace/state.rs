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
    MAX_WINDOW_DEVICE_FILES, attachment_draft_admissible, bound, capture, confirm_unconfirmed,
    draft_changed, has_unconfirmed, note_unconfirmed, unconfirmed_drafts_full,
    window_inline_usage_without_history,
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
    mission_lifecycle: crate::missions::Lifecycle,
    mission_briefing: crate::missions::BriefingRequests,
    entries: Vec<Entry>,
    active: usize,
    next_key: u64,
    revision: u64,
    saved_at: u64,
    panel_widths: [Option<u16>; 2],
    file_wrap: Option<bool>,
    clock: f64,
    pub(super) persistence: Persistence,
    ready: bool,
    touched: bool,
    staged_revision: Option<u64>,
    closed: Vec<Workspace>,
    // Bounded in-memory lock registry across tabs (kept out of Snapshot to preserve the v1 client-state-codec schema).
    closed_unconfirmed: Vec<ClosedUnconfirmed>,
    memory_budget: super::memory_budget::Coordinator,
}
pub(super) const MAX_UNCONFIRMED_LOCKS: usize = super::MAX_DRAFTS;
struct ClosedUnconfirmed {
    backend_id: Option<String>,
    server_id: Option<String>,
    session_id: String,
    unconfirmed: crate::composer::UnconfirmedPrompt,
}
impl ClosedUnconfirmed {
    fn matches(&self, workspace: &Workspace, session_id: &str) -> bool {
        self.session_id == session_id
            && self.backend_id == workspace.backend_id
            && (self.backend_id.is_none() || self.server_id == workspace.server_id)
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
            persistence: Persistence::new(),
            ready: false,
            touched: false,
            staged_revision: None,
            closed: Vec::new(),
            closed_unconfirmed: Vec::new(),
            memory_budget: super::memory_budget::Coordinator::new(),
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
        Snapshot {
            revision: self.revision,
            saved_at: self.saved_at,
            panel_widths: self.panel_widths,
            file_wrap: self.file_wrap,
            tabs: refs
                .iter()
                .map(|e| {
                    let mut saved = e.saved.clone();
                    if let Tab::Workspace(w) = &mut saved {
                        // Persist only clears protecting against another restored occurrence's text.
                        for id in &e.cleared {
                            if refs.iter().any(|other| {
                                other.key != e.key && matches!(&other.saved, Tab::Workspace(old)
                                    if same_project(w, old) && old.drafts.get(id).is_some_and(|text| !text.is_empty()))
                            }) {
                                w.drafts.insert(id.clone(), String::new());
                            }
                        }
                    }
                    saved
                })
                .collect(),
            active,
        }
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
    if let Tab::Workspace(w) = &mut saved {
        w.drafts.retain(|id, text| {
            if text.is_empty() {
                cleared.insert(id.clone());
                false
            } else {
                true
            }
        });
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
pub fn unselect_missing(s: &mut State, id: &str) -> bool {
    if active_session(s) != Some(id) {
        return false;
    }
    capture(s);
    let stashed = s.temporary.stashed_for_snapshot();
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    if let Tab::Workspace(saved) = &mut ui.entries[ui.active].saved {
        saved.active_session_id = None;
        ui.changed();
        ui.stage_with_stashed(stashed);
        return true;
    }
    false
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
        item.blank_cleanup.clear();
        item.idle_markers.clear();
        let mut drafts = std::collections::BTreeMap::new();
        let mut attachment_drafts = std::collections::BTreeSet::new();
        let mut attachment_parts = std::collections::BTreeMap::new();
        item.cleared.clear();
        for w in ui.closed.iter().filter(|w| {
            same_folder(&w.folder, &project.path)
                && w.backend_id == backend_id
                && (backend_id.is_none() || w.server_id == l.server_id)
        }) {
            for (id, text) in &w.drafts {
                attachment_drafts.remove(id);
                attachment_parts.remove(id);
                if text.is_empty() {
                    drafts.remove(id);
                    item.cleared.insert(id.clone());
                } else {
                    drafts.insert(id.clone(), text.clone());
                    item.cleared.remove(id);
                }
            }
            attachment_drafts.extend(w.attachment_drafts.iter().cloned());
            for id in &w.attachment_drafts {
                attachment_parts.remove(id);
            }
            attachment_parts.extend(w.attachment_parts.clone());
        }
        item.pending_drafts = drafts
            .keys()
            .chain(item.cleared.iter())
            .chain(attachment_drafts.iter())
            .cloned()
            .collect();
        item.saved = Tab::Workspace(Workspace {
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
            drafts,
            attachment_drafts,
            attachment_parts,
            view: Default::default(),
        });
        item.live_drafts.clear();
    }
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
