use super::{Snapshot, Tab, Workspace, cache::Cache, persistence::Persistence};
use crate::{
    State,
    backend::Backend,
    catalog::{Project, Session},
    platform, strings,
};
use rune::{Cx, El, Tx, edit::TextEdit};

pub(super) struct Entry {
    key: String,
    saved: Tab,
    cache: Option<Cache>,
    project: Option<Project>,
    sessions: Vec<Session>,
    next: Option<String>,
    binding: Option<Backend>,
}
pub struct Ui {
    entries: Vec<Entry>,
    active: usize,
    next_key: u64,
    revision: u64,
    saved_at: u64,
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
            entries: vec![entry("tab-0".into(), Tab::Blank)],
            active: 0,
            next_key: 1,
            revision: 0,
            saved_at: 0,
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
            tabs: self.entries.iter().map(|e| e.saved.clone()).collect(),
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
    }
    pub(super) fn release_all(&self) {
        let records = self
            .entries
            .iter()
            .filter_map(|item| Some((item.binding.clone()?, item.project.as_ref()?.id.clone())))
            .collect();
        platform::release_records_on_exit(records);
    }
    fn stage(&mut self) {
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
fn entry(key: String, saved: Tab) -> Entry {
    Entry {
        key,
        saved,
        cache: None,
        project: None,
        sessions: Vec::new(),
        next: None,
        binding: None,
    }
}
fn busy(s: &State) -> bool {
    s.launcher.as_ref().is_some_and(|l| l.pending)
        || s.workspace.as_ref().is_some_and(|ui| !ui.ready)
}
pub fn input_ready(s: &State) -> bool {
    s.workspace.as_ref().is_none_or(|ui| ui.ready)
}
pub fn prepare_open(s: &mut State, tx: &mut Tx) {
    if s.workspace
        .as_ref()
        .is_some_and(|ui| matches!(ui.entries[ui.active].saved, Tab::Workspace(_)))
    {
        let folder = s
            .launcher
            .as_ref()
            .map(|l| l.folder.text.clone())
            .unwrap_or_default();
        new_tab(s, tx);
        if let Some(l) = &mut s.launcher {
            l.folder = TextEdit::new(folder);
        }
    }
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
        if owns_draft && saved.drafts.get(key).map(String::as_str) != Some(s.draft.text.as_str()) {
            saved.drafts.insert(key.into(), s.draft.text.clone());
            changed = true;
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
fn stash(s: &mut State) {
    capture(s);
    let cache = Cache::take(s);
    if let Some(ui) = &mut s.workspace {
        let entry = &mut ui.entries[ui.active];
        entry.cache = Some(cache);
        if let Some(l) = &s.launcher {
            entry.project = l.project.clone();
            entry.sessions = l.sessions.clone();
            entry.next = l.next.clone();
        }
    }
}
fn activate(s: &mut State, tx: &mut Tx) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let item = &mut ui.entries[ui.active];
    if let Some(l) = &mut s.launcher {
        l.project = item.project.clone();
        l.sessions = item.sessions.clone();
        l.next = item.next.clone();
        l.folder = TextEdit::new(match &item.saved {
            Tab::Workspace(w) => w.folder.as_str(),
            _ => "",
        });
        l.error = None;
        l.creation_uncertain = false;
    }
    if let Some(cache) = item.cache.take() {
        cache.apply(s);
    } else {
        s.launcher_visible = true;
        let restore = match &item.saved {
            Tab::Workspace(w) => Some(w.clone()),
            _ => None,
        };
        if let Some(saved) = restore {
            crate::launcher::restore(s, saved);
        }
    }
    tx.scroll_to_bottom_instant("history");
    tx.instant();
}
pub fn select(s: &mut State, id: &str, tx: &mut Tx) {
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
    if s.workspace.as_ref().is_some_and(|ui| ui.active == index) {
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
pub fn new_tab(s: &mut State, tx: &mut Tx) {
    if busy(s) || s.workspace.as_ref().is_none_or(|ui| ui.entries.len() >= 32) {
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
    if s.workspace.as_ref().is_some_and(|ui| ui.active == index)
        && crate::agent::navigation_blocked(s)
    {
        return;
    }
    stash(s);
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let removed = ui.entries.remove(index);
    if let Tab::Workspace(saved) = removed.saved {
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
    activate(s, tx);
    capture(s);
}
pub fn connected(s: &mut State) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    #[cfg(not(target_arch = "wasm32"))]
    let directory = s
        .launcher
        .as_ref()
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
    let (Some(ui), Some(l)) = (&mut s.workspace, &s.launcher) else {
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
    let occurrence = (0..32).find(|ordinal| !ui.entries.iter().any(|entry| {
        matches!(&entry.saved, Tab::Workspace(w) if w.folder == project.path && w.backend_id == backend_id && w.occurrence == *ordinal)
    })).unwrap_or(0);
    let item = &mut ui.entries[ui.active];
    if matches!(&item.saved, Tab::Workspace(w) if w.folder == project.path) {
        if let Tab::Workspace(w) = &mut item.saved {
            w.workspace_id = Some(project.id.clone());
        }
    } else {
        let drafts = ui
            .closed
            .iter()
            .rev()
            .find(|w| {
                w.folder == project.path
                    && w.backend_id == backend_id
                    && (backend_id.is_none() || w.server_id == l.server_id)
            })
            .map(|w| w.drafts.clone())
            .unwrap_or_default();
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
pub fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    ui.clock = now;
    let loading = ui.persistence.loading;
    let loaded = ui.persistence.poll_load();
    if let Some(saved) = loaded {
        ui.hydrate(saved);
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
                status: if index == ui.active && !s.launcher_visible {
                    super::cache::status(&s.phase, s.agent.as_ref())
                } else if let Some(cache) = &entry.cache {
                    cache.status()
                } else if entry.project.is_none() && matches!(entry.saved, Tab::Workspace(_)) {
                    Some(rune_theme_codenomad::tabs::Status::Unavailable)
                } else {
                    None
                },
                closable: !busy(s) && !(index == ui.active && crate::agent::navigation_blocked(s)),
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
