use super::{Snapshot, Tab, Workspace, cache::Cache, persistence::Persistence};
use crate::{
    State,
    backend::Backend,
    catalog::{Project, Session},
    platform, strings,
};
use codenomad_client::same_server_path as same_folder;
use rune::{Cx, El, Tx, edit::TextEdit};
use std::collections::HashSet;

pub(super) struct Entry {
    key: String,
    saved: Tab,
    cache: Option<Cache>,
    project: Option<Project>,
    sessions: Vec<Session>,
    next: Option<String>,
    visits: crate::launcher::Visits,
    wanted_panels: [Option<[bool; 2]>; 2],
    sidebar_edits: Option<(TextEdit, bool, TextEdit, bool)>,
    binding: Option<Backend>,
    cleared: HashSet<String>,
    pending_drafts: HashSet<String>,
}
pub struct Ui {
    pub(super) openings: super::opening::Openings,
    entries: Vec<Entry>,
    active: usize,
    next_key: u64,
    revision: u64,
    saved_at: u64,
    panel_widths: [Option<u16>; 2],
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
        let bytes = match super::encode(&self.snapshot()) {
            Ok(bytes) => bytes,
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
        project: None,
        sessions: Vec::new(),
        next: None,
        visits: Default::default(),
        wanted_panels: [None; 2],
        sidebar_edits: None,
        binding: None,
        cleared,
        pending_drafts: HashSet::new(),
    }
}
fn busy(s: &State) -> bool {
    s.screen.launcher().is_some_and(|l| l.pending)
        || s.workspace.as_ref().is_some_and(|ui| !ui.ready)
}
pub fn input_ready(s: &State) -> bool {
    s.workspace.as_ref().is_none_or(|ui| ui.ready)
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
pub fn capture(s: &mut State) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let Some(item) = ui.entries.get_mut(ui.active) else {
        return;
    };
    let mut changed = false;
    if let Tab::Workspace(saved) = &mut item.saved {
        let key = saved
            .active_session_id
            .as_deref()
            .unwrap_or("__no_session_draft__");
        let owns_draft = item.binding.as_ref().is_some_and(|b| {
            b.session == key || b.session.is_empty() && key == "__no_session_draft__"
        });
        if owns_draft {
            if s.draft.text.is_empty() {
                if saved.drafts.remove(key).is_some() {
                    item.cleared.insert(key.into());
                    changed = true;
                }
            } else if saved.drafts.get(key) != Some(&s.draft.text) {
                saved.drafts.insert(key.into(), s.draft.text.clone());
                item.cleared.remove(key);
                changed = true;
            }
        }
    }
    if changed {
        ui.changed();
    }
    ui.stage();
}
pub fn draft_changed(s: &mut State, _: &mut Tx) {
    capture(s);
}
pub fn panel_width(s: &mut State, index: usize, width: u16) {
    if let Some(ui) = &mut s.workspace
        && ui.panel_widths[index] != Some(width)
    {
        ui.panel_widths[index] = Some(width);
        ui.changed();
    }
}
fn stash(s: &mut State) {
    capture(s);
    if let Some(files) = &mut s.files {
        files.activate(false);
    }
    if let Some(git) = &mut s.git.owner {
        git.activate(false);
    }
    let cache = Cache::take(s);
    if let Some(ui) = &mut s.workspace {
        let entry = &mut ui.entries[ui.active];
        entry.cache = Some(cache);
        entry.wanted_panels = s.shell.wanted;
        if let Some(l) = s.screen.launcher_mut() {
            entry.project = l.project.clone();
            entry.sessions = l.sessions.clone();
            entry.next = l.next.clone();
            entry.visits = std::mem::take(&mut l.visits);
            entry.sidebar_edits = Some((
                std::mem::replace(&mut l.title, TextEdit::new("")),
                l.show_title,
                std::mem::replace(&mut l.search, TextEdit::new("")),
                l.show_search,
            ));
        }
    }
}
fn activate(s: &mut State, tx: &mut Tx) {
    s.shell.leave_project();
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let item = &mut ui.entries[ui.active];
    s.shell.wanted = item.wanted_panels;
    if let Some(l) = s.screen.launcher_mut() {
        l.project = item.project.clone();
        l.sessions = item.sessions.clone();
        l.next = item.next.clone();
        l.visits = std::mem::take(&mut item.visits);
        l.folder = TextEdit::new(match &item.saved {
            Tab::Workspace(w) => w.folder.as_str(),
            _ => "",
        });
        l.error = None;
        l.creation_uncertain = false;
        (l.title, l.show_title, l.search, l.show_search) = item
            .sidebar_edits
            .take()
            .unwrap_or_else(|| (TextEdit::new(""), false, TextEdit::new(""), false));
    }
    if let Some(cache) = item.cache.take() {
        cache.apply(s);
        s.renew_scope();
        if let Some(files) = &mut s.files {
            files.activate(true);
        }
        if let Some(git) = &mut s.git.owner {
            git.activate(true);
        }
    } else {
        let restore = match &item.saved {
            Tab::Workspace(w) => Some(w.clone()),
            _ => None,
        };
        s.show_launcher();
        if let Some(saved) = restore {
            crate::launcher::restore(s, saved);
        }
    }
    tx.scroll_to_bottom_instant("history");
    tx.instant();
}
pub fn select(s: &mut State, id: &str, tx: &mut Tx) {
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if s.workspace.as_ref().is_some_and(|ui| ui.active == index) {
        s.shell.leave_project();
        return;
    }
    if busy(s) {
        return;
    }
    stash(s);
    if let Some(ui) = &mut s.workspace {
        ui.active = index;
        ui.changed();
    }
    activate(s, tx);
    capture(s);
}
pub fn can_new(s: &State) -> bool {
    !busy(s)
        && s.workspace
            .as_ref()
            .is_some_and(|ui| ui.entries.len() < super::MAX_TABS)
}
pub fn new_tab(s: &mut State, tx: &mut Tx) {
    if !can_new(s) {
        return;
    }
    stash(s);
    if let Some(ui) = &mut s.workspace {
        ui.entries
            .push(entry(format!("tab-{}", ui.next_key), Tab::Blank));
        ui.next_key += 1;
        ui.active = ui.entries.len() - 1;
        ui.changed();
    }
    activate(s, tx);
    capture(s);
}
pub fn close(s: &mut State, id: &str, tx: &mut Tx) {
    crate::shell::Panels::dismiss_outside(s, tx);
    if busy(s) {
        return;
    }
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if close_blocked(s, index) {
        return;
    }
    let active = s.workspace.as_ref().is_some_and(|ui| ui.active == index);
    if active {
        stash(s);
    } else {
        capture(s);
    }
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let removed = ui.entries.remove(index);
    if let Tab::Workspace(mut saved) = removed.saved {
        // Undelivered copies still belong to their closed source.
        saved
            .drafts
            .retain(|id, _| !removed.pending_drafts.contains(id));
        // Clear authority belongs to this occurrence's live lifetime, outside text budgets.
        saved.drafts.extend(
            removed
                .cleared
                .into_iter()
                .filter(|id| !removed.pending_drafts.contains(id))
                .map(|id| (id, String::new())),
        );
        ui.closed.push(saved);
        if ui.closed.len() > 16 {
            ui.closed.remove(0);
        }
    }
    if let (Some(backend), Some(project)) = (removed.binding, removed.project) {
        platform::spawn(async move {
            let _ = backend.release_project(&project.id).await;
        });
    }
    if ui.entries.is_empty() {
        ui.entries
            .push(entry(format!("tab-{}", ui.next_key), Tab::Blank));
        ui.next_key += 1;
    }
    ui.active = if index < ui.active {
        ui.active - 1
    } else {
        ui.active.min(ui.entries.len() - 1)
    };
    ui.changed();
    if active {
        activate(s, tx);
    } else {
        tx.instant();
    }
    capture(s);
}
fn close_blocked(s: &State, index: usize) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    if ui.active == index {
        crate::agent::navigation_blocked(s)
    } else {
        ui.entries[index]
            .cache
            .as_ref()
            .is_some_and(Cache::navigation_blocked)
    }
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
        .or_else(|| {
            platform::setting("CODENOMAD_PROFILE").filter(|p| p.starts_with("trial-"))?;
            platform::setting("RUNE_STATE_DIR").map(std::path::PathBuf::from)
        });
    #[cfg(target_arch = "wasm32")]
    let directory = None;
    ui.persistence.start(directory, s.wake.clone());
    if ui.persistence.loading {
        ui.ready = false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !ui.persistence.loading && ui.persistence.store.is_none() && !ui.persistence.read_error {
        ui.ready = true;
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
        item.cleared.clear();
        for w in ui.closed.iter().filter(|w| {
            same_folder(&w.folder, &project.path)
                && w.backend_id == backend_id
                && (backend_id.is_none() || w.server_id == l.server_id)
        }) {
            for (id, text) in &w.drafts {
                if text.is_empty() {
                    drafts.remove(id);
                    item.cleared.insert(id.clone());
                } else {
                    drafts.insert(id.clone(), text.clone());
                    item.cleared.remove(id);
                }
            }
        }
        item.pending_drafts = drafts.keys().chain(item.cleared.iter()).cloned().collect();
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
        });
    }
    item.project = Some(project.clone());
    item.binding = l.connection.clone();
    ui.changed();
}
pub fn bound(s: &mut State, backend: &Backend) -> String {
    capture(s);
    let Some(ui) = &mut s.workspace else {
        return String::new();
    };
    deliver_draft(ui, &backend.session);
    let item = &mut ui.entries[ui.active];
    item.binding = Some(backend.clone());
    let Tab::Workspace(saved) = &mut item.saved else {
        return String::new();
    };
    saved.active_session_id = Some(backend.session.clone());
    let draft = saved
        .drafts
        .get(&backend.session)
        .cloned()
        .unwrap_or_default();
    ui.changed();
    draft
}
fn deliver_draft(ui: &mut Ui, id: &str) {
    let item = &ui.entries[ui.active];
    let Tab::Workspace(scope) = &item.saved else {
        return;
    };
    if !item.pending_drafts.contains(id) {
        return;
    }
    let scope = scope.clone();
    let current = ui
        .closed
        .iter()
        .rev()
        .filter(|w| same_project(&scope, w))
        .find_map(|w| w.drafts.get(id))
        .cloned();
    for (index, item) in ui.entries.iter_mut().enumerate() {
        if !matches!(&item.saved, Tab::Workspace(w) if same_project(&scope, w))
            || !item.pending_drafts.remove(id)
        {
            continue;
        }
        let Tab::Workspace(saved) = &mut item.saved else {
            continue;
        };
        saved.drafts.remove(id);
        item.cleared.remove(id);
        if index == ui.active {
            match &current {
                Some(text) if !text.is_empty() => {
                    saved.drafts.insert(id.into(), text.clone());
                }
                Some(_) => {
                    item.cleared.insert(id.into());
                }
                None => {}
            }
        }
    }
    for w in ui.closed.iter_mut().filter(|w| same_project(&scope, w)) {
        w.drafts.remove(id);
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
    let loaded = ui.persistence.poll_load();
    if let Some(saved) = loaded {
        ui.hydrate(saved);
        s.shell.restore_widths(ui.panel_widths);
    }
    let became_ready = loading && !ui.persistence.loading;
    if became_ready {
        ui.ready = true;
    }
    let active = Cache::take(s);
    let mut changed = false;
    for item in &mut ui.entries {
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            changed |= crate::poll_chat(s, 8);
            changed |= s.files.as_mut().is_some_and(|files| files.poll(now));
            changed |= crate::git::poll(s, now, tx);
            item.cache = Some(Cache::take(s));
        }
    }
    active.apply(s);
    ui.stage();
    let previous_error = ui.persistence.read_error || ui.persistence.write_error;
    let snapshot = ui.snapshot();
    ui.persistence.poll_save(&snapshot, now, tx, s.wake.clone());
    let error = ui.persistence.read_error || ui.persistence.write_error;
    s.workspace = Some(ui);
    if became_ready {
        activate(s, tx);
    }
    changed || became_ready || error != previous_error
}
pub fn status(s: &State) -> Option<&'static str> {
    let ui = s.workspace.as_ref()?;
    if ui.persistence.read_error {
        Some("rune.restore_error")
    } else if ui.persistence.write_error {
        Some("rune.save_error")
    } else {
        None
    }
}
pub fn strip(s: &State, cx: &mut Cx<State>) -> El {
    let Some(ui) = &s.workspace else {
        return rune::el();
    };
    let titles: Vec<_> = ui
        .entries
        .iter()
        .map(|e| match &e.saved {
            Tab::Blank => strings::t("instanceTabs.new.ariaLabel"),
            Tab::Workspace(w) => w.folder.as_str(),
        })
        .collect();
    let tabs: Vec<_> = ui
        .entries
        .iter()
        .zip(&titles)
        .enumerate()
        .map(
            |(index, (entry, title))| rune_theme_codenomad::tabs::ProjectTab {
                id: &entry.key,
                title,
                status: if index == ui.active && !s.screen.is_launcher() {
                    super::cache::status(&s.phase, s.agent.as_ref())
                } else if let Some(cache) = &entry.cache {
                    cache.status()
                } else if entry.project.is_none() && matches!(entry.saved, Tab::Workspace(_)) {
                    Some(rune_theme_codenomad::tabs::Status::Unavailable)
                } else {
                    None
                },
                closable: !busy(s) && !close_blocked(s, index),
            },
        )
        .collect();
    rune_theme_codenomad::tabs::strip(
        cx,
        strings::locale(),
        &tabs,
        ui.entries.get(ui.active).map(|e| e.key.as_str()),
        select,
        close,
        new_tab,
    )
}

#[cfg(test)]
mod tests;
