mod tabs;
use tabs::{activate, close_blocked};
pub use tabs::{can_new, close, new_tab, select};

mod drafts;
mod panel_state;
mod strip;

pub use drafts::{attachment_draft_admissible, bound, capture, draft_changed};
#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
pub(crate) use panel_state::set_files_tab;
pub use panel_state::{
    capture_files_mode, file_wrap, files_tab, panel_width, restore_files_mode, toggle_file_wrap,
};
pub(crate) use panel_state::{
    mission_event, mission_panel, mission_supported, right_panel_tab, set_right_panel_tab,
    suspend_missions,
};
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
    next: Option<String>,
    linked: crate::launcher::linked::Linked,
    consumed_cursors: HashSet<u64>,
    visits: crate::launcher::Visits,
    catalogue: catalogue::Refresh,
    wanted_panels: [Option<[bool; 2]>; 2],
    sidebar_edits: Option<(TextEdit, bool, TextEdit, bool)>,
    binding: Option<Backend>,
    missions: Option<crate::missions::Panel>,
    cleared: HashSet<String>,
    pending_drafts: HashSet<String>,
    live_drafts: std::collections::BTreeMap<String, drafts::LiveDraft>,
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn active_workspace(s: &State) -> Option<(&str, &Workspace)> {
    let ui = s.workspace.as_ref()?;
    let entry = &ui.entries[ui.active];
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
pub struct Ui {
    pub(super) openings: super::opening::Openings,
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
}
impl Ui {
    pub(crate) fn active_key(&self) -> &str {
        &self.entries[self.active].key
    }
    pub fn new() -> Self {
        Self {
            openings: Default::default(),
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
        }
    }
    fn changed(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.saved_at = platform::storage::unix_millis();
        self.touched = true;
        self.persistence.dirty(self.clock);
    }
    pub(crate) fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            saved_at: self.saved_at,
            panel_widths: self.panel_widths,
            file_wrap: self.file_wrap,
            tabs: self.entries.iter().map(|e| {
                let mut saved = e.saved.clone();
                if let Tab::Workspace(w) = &mut saved {
                    // Persist only clears protecting against another restored occurrence's text.
                    for id in &e.cleared {
                        if self.entries.iter().any(|other| {
                            other.key != e.key && matches!(&other.saved, Tab::Workspace(old)
                                if same_project(w, old) && old.drafts.get(id).is_some_and(|text| !text.is_empty()))
                        }) {
                            w.drafts.insert(id.clone(), String::new());
                        }
                    }
                }
                saved
            }).collect(),
            active: Some(self.active),
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
    pub(super) fn release_all(&self) {
        let records = self
            .entries
            .iter()
            .filter_map(|item| Some((item.binding.clone()?, item.project.as_ref()?.id.clone())))
            .collect();
        platform::release_records_on_exit(records, self.openings.clone());
    }
    fn stage(&mut self) {
        #[cfg(target_arch = "wasm32")]
        if let Some(store) = &self.persistence.store {
            store.watch_openings(self.openings.clone());
        }
        if self.persistence.read_error || !self.ready || self.staged_revision == Some(self.revision)
        {
            return;
        }
        let Some(store) = &self.persistence.store else {
            return;
        };
        let bytes = match super::encode_for_save(&self.snapshot()) {
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
        let records: Vec<_> = self
            .entries
            .iter()
            .filter_map(|e| {
                Some((
                    e.binding.as_ref()?.base.clone(),
                    e.project.as_ref()?.id.clone(),
                ))
            })
            .collect();
        store.stage(&bytes, &records);
        self.staged_revision = Some(self.revision);
    }
}
fn same_project(a: &Workspace, b: &Workspace) -> bool {
    same_folder(&a.folder, &b.folder)
        && a.backend_id == b.backend_id
        && (a.backend_id.is_none() || a.server_id == b.server_id)
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
        next: None,
        linked: Default::default(),
        consumed_cursors: HashSet::new(),
        visits: Default::default(),
        catalogue: Default::default(),
        wanted_panels: [None; 2],
        sidebar_edits: None,
        binding: None,
        missions: None,
        cleared,
        pending_drafts: HashSet::new(),
        live_drafts: Default::default(),
    }
}
fn busy(s: &State) -> bool {
    s.screen.launcher().is_some_and(|l| l.pending)
        || s.workspace.as_ref().is_some_and(|ui| !ui.ready)
}
pub fn input_ready(s: &State) -> bool {
    s.workspace.as_ref().is_none_or(|ui| ui.ready)
}

#[cfg(target_os = "windows")]
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
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    if let Tab::Workspace(saved) = &mut ui.entries[ui.active].saved {
        saved.active_session_id = None;
        ui.changed();
        ui.stage();
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
        for item in &mut ui.entries {
            if let Some(backend) = &mut item.binding
                && backend.base == current.base
                && backend.client.server_identity().is_some()
                && backend.client.server_identity() == current.client.server_identity()
            {
                backend.client = current.client.clone();
                backend.client_id.clone_from(&current.client_id);
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
    let item = &mut ui.entries[ui.active];
    if matches!(&item.saved, Tab::Workspace(w) if same_folder(&w.folder, &project.path) && w.backend_id == backend_id && (backend_id.is_none() || w.server_id == l.server_id))
    {
        if let Tab::Workspace(w) = &mut item.saved {
            w.workspace_id = Some(project.id.clone());
        }
    } else {
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
}

pub fn schedule_catalogue(s: &mut State) {
    if cfg!(target_os = "windows")
        && let Some(ui) = &mut s.workspace
    {
        ui.entries[ui.active].catalogue.schedule(ui.clock);
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

pub fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    ui.clock = now;
    let loading = ui.persistence.loading;
    if let Some((saved, drafts)) = ui.persistence.poll_load() {
        ui.persistence.file_draft_read_error = match drafts {
            Ok(Some(bytes)) => !s.documents.hydrate_file_drafts(&bytes),
            Ok(None) => false,
            Err(_) => true,
        };
        s.documents
            .block_file_draft_updates(ui.persistence.file_draft_read_error);
        if let Some(saved) = saved {
            ui.hydrate(saved);
            s.shell.restore_widths(ui.panel_widths);
            s.shell.file_wrap = ui.file_wrap.unwrap_or(false);
        }
    }
    let became_ready = loading && !ui.persistence.loading;
    if let Some(store) = &ui.persistence.store {
        s.saved_outlines.poll(store, s.wake.clone());
    }
    if became_ready {
        ui.ready = true;
        #[cfg(target_arch = "wasm32")]
        if let Some(wrap) = platform::storage::browser_file_wrap() {
            s.shell.file_wrap = wrap;
        }
    }
    let active = Cache::take(s);
    let mut changed = ui.persistence.poll_file_draft_retry(&s.documents);
    let mut drafts_changed = false;
    for item in &mut ui.entries {
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            let awaiting_prompt = s.composer.pending();
            let uncertain_prompt = s.composer.unconfirmed_id().is_some();
            changed |= crate::chat::events::poll_hidden_chat(s, 8);
            if awaiting_prompt && !s.composer.pending()
                || uncertain_prompt && s.composer.unconfirmed_id().is_none()
            {
                drafts_changed |= drafts::capture_draft(item, s);
            }
            changed |= s.files.as_mut().is_some_and(|files| files.poll(now));
            changed |= crate::git::poll(s, now, tx);
            item.cache = Some(Cache::take(s));
        }
    }
    active.apply(s);
    changed |= crate::timeline::sync_outline_mutation(s);
    changed |= panel_state::poll_missions(&mut ui, s, tx);
    if drafts_changed {
        ui.changed();
    }
    ui.stage();
    let previous_error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.file_draft_error,
        ui.persistence.partial,
    );
    let snapshot = ui.snapshot();
    ui.persistence.poll_save(&snapshot, now, tx, s.wake.clone());
    #[cfg(target_arch = "wasm32")]
    ui.persistence.poll_file_drafts(&s.documents);
    let error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.file_draft_error,
        ui.persistence.partial,
    );
    s.workspace = Some(ui);
    if became_ready {
        resume(s, tx);
    }
    if changed {
        history_budget::enforce(s);
    }
    changed |= catalogue::poll(s, now, tx);
    changed || became_ready || error != previous_error
}
pub fn status(s: &State) -> Option<&'static str> {
    let ui = s.workspace.as_ref()?;
    if ui.persistence.read_error {
        Some("rune.restore_error")
    } else if ui.persistence.write_error || ui.persistence.partial || ui.has_unsaved_large_drafts()
    {
        Some("rune.save_error")
    } else if ui.persistence.file_draft_error
        || ui.persistence.file_draft_read_error
        || s.documents.has_unretained_file_drafts()
    {
        Some("filesPanel.draftLimit")
    } else {
        None
    }
}

#[cfg(test)]
mod authentication_tests;
mod catalogue;
mod history_budget;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) use history_budget::evict_for_probe;
#[cfg(test)]
mod tests;
