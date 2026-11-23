use super::{
    document::{editor::Editor, store::Store},
    reader::Reader,
    request::Read,
    state::Tree,
};
use crate::platform::{self, collation::Collation, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake, backend::Backend, bounded, files::Entry, history::Result,
    transport::WorkspaceEvent,
};
use std::collections::BTreeSet;
pub(super) mod entry_create;

type Changes = Option<BTreeSet<(String, String)>>;

pub struct Row {
    pub entry: Entry,
    pub parent: String,
    pub depth: usize,
    pub expanded: Option<bool>,
    pub busy: bool,
}
pub struct Ui {
    pub reading: crate::chat::reading::Position,
    pub reader_close: crate::window_control::WindowCloseState,
    pub presentation: super::presentation::Presentation,
    pub document: Editor,
    pub(super) create: entry_create::Create,
    pub reader: Reader,
    pub tree: Tree,
    pub rows: Vec<Row>,
    pub panel: bool,
    pub(super) shell_managed: bool,
    workspace_visible: bool,
    pub host_width: Option<f32>,
    backend: Backend,
    reads: Reads,
    collation: std::result::Result<Collation, String>,
    incoming: Receiver<(Read, Result<Vec<Entry>>)>,
    out: Sender<(Read, Result<Vec<Entry>>)>,
    wake: Wake,
    active: bool,
    online: bool,
    due: Option<f64>,
    clock: f64,
    last_passive: Option<f64>,
    pending: Option<(f64, Changes)>,
    pub stopped: bool,
}
impl Ui {
    pub fn new(backend: Backend, directory: String, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(16);
        Self {
            reading: Default::default(),
            reader_close: Default::default(),
            presentation: super::presentation::Presentation::new(wake.clone()),
            document: Editor::new(
                backend.clone(),
                Store::default(),
                backend.workspace.clone(),
                wake.clone(),
            ),
            reader: Reader::new(backend.clone(), reads.clone(), wake.clone()),
            create: Default::default(),
            tree: Tree::new(directory),
            rows: vec![],
            panel: false,
            shell_managed: false,
            workspace_visible: false,
            host_width: None,
            backend,
            reads,
            collation: Collation::try_default(),
            incoming,
            out,
            wake,
            active: true,
            online: false,
            due: None,
            clock: 0.0,
            last_passive: None,
            pending: None,
            stopped: false,
        }
    }
    pub fn activate(&mut self, active: bool) {
        self.active = active;
        if !active {
            self.host_width = None;
            if !self.create.pending {
                self.create.form = None;
            }
        }
        self.document.activate(active);
        self.reader.activate(active);
        self.demand();
    }
    pub fn show(&mut self, show: bool) {
        if self.panel == show {
            return;
        }
        self.panel = show;
        if !self.shell_managed && !show && !self.create.pending {
            self.create.form = None;
        }
        self.demand();
    }
    pub(super) fn set_workspace_visible(&mut self, visible: bool) {
        if self.workspace_visible != visible {
            self.workspace_visible = visible;
            self.demand();
        }
    }
    fn tree_visible(&self) -> bool {
        if self.shell_managed {
            self.workspace_visible
        } else {
            self.drawer().pinned
        }
    }
    pub fn browse(&mut self, directory: String) {
        if self.tree.directory() != directory {
            if !self.create.pending {
                self.create.form = None;
            }
            self.close_reader();
            self.tree.switch(directory);
            self.demand();
        }
    }
    pub fn drawer(&self) -> super::layout::Drawer {
        super::layout::resolve(self.host_width.unwrap_or(0.0), self.panel)
    }
    pub fn resize(&mut self, width: f32, tx: &mut rune::Tx) {
        if !width.is_finite() || width < 0.0 || self.host_width == Some(width) {
            return;
        }
        let was_pinned = self.drawer().pinned;
        self.host_width = Some(width);
        if !self.shell_managed
            && was_pinned
            && !self.drawer().pinned
            && tx.focused().is_some_and(|key| {
                key.starts_with("file-row-")
                    || key.starts_with("file-eye-")
                    || key.starts_with("file-retry-")
                    || key.starts_with("file-create-")
                    || key.starts_with("file-new")
            })
        {
            tx.focus("files-toggle", true);
        }
        self.demand();
    }
    pub fn online(&mut self, online: bool) {
        self.document.online(online && !self.stopped);
        self.reader.online(online && !self.stopped);
        if online && !self.online {
            self.tree.invalidate_all();
            self.pending = None;
        }
        self.online = online;
        self.demand();
    }
    fn demand(&mut self) {
        self.tree
            .activate(self.active && self.tree_visible() && self.online);
        self.due = Some(0.0);
        self.snapshot();
    }
    pub fn event(&mut self, event: WorkspaceEvent) {
        match event {
            WorkspaceEvent::FilesChanged {
                workspace_id,
                changes,
            } if workspace_id == self.backend.workspace && !self.stopped && !changes.is_empty() => {
                let due = self
                    .last_passive
                    .map_or(self.clock + 0.1, |last| (last + 5.0).max(self.clock + 0.1));
                let (_, pending) = self
                    .pending
                    .get_or_insert_with(|| (due, Some(BTreeSet::new())));
                if let Some(paths) = pending {
                    paths.extend(
                        changes
                            .into_iter()
                            .map(|change| (change.directory, change.path)),
                    );
                    if paths.len() > 1024 {
                        *pending = None;
                    }
                }
            }
            WorkspaceEvent::Stopped { workspace_id } if workspace_id == self.backend.workspace => {
                self.tree.close();
                self.document.close();
                self.reader.close();
                self.pending = None;
                self.stopped = true;
                self.snapshot();
            }
            _ => {}
        }
    }
    pub(super) fn listing_errors(
        &self,
    ) -> impl Iterator<Item = (&str, &codenomad_client::history::Error)> {
        self.tree.errors().iter().filter_map(|(path, error)| {
            self.listing_visible(path).then_some((path.as_str(), error))
        })
    }
    fn listing_visible(&self, path: &str) -> bool {
        path == "."
            || self
                .rows
                .iter()
                .any(|row| row.expanded.is_some() && row.entry.path == path)
    }
    pub(super) fn retry_listing(&mut self, directory: &str, path: &str) {
        if !self.stopped
            && directory == self.tree.directory()
            && self.listing_visible(path)
            && self.tree.errors().contains_key(path)
        {
            self.refresh(Some(path));
        }
    }
    pub fn refresh(&mut self, path: Option<&str>) {
        if let Some(path) = path {
            if let Some(read) = self.tree.load(path, true) {
                self.launch(vec![read]);
            }
        } else {
            self.tree.refresh(true);
            self.reader.refresh();
            self.due = Some(0.0);
        }
    }
    pub fn select(&mut self, path: String, toggle: bool) {
        self.tree.select(path.clone());
        if toggle {
            let requests = self.tree.toggle(&path);
            self.launch(requests);
        }
    }
    pub(super) fn sync_tree_focus(&mut self, tx: &mut rune::Tx) -> bool {
        if self.stopped || !self.active || !self.tree_visible() {
            return false;
        }
        // Rune polls before input and has no element focus callback. Read the resulting
        // focus once on the next frame, leaving Tab order and scrolling to Rune.
        if tx.input_waiting() {
            tx.wake_after(std::time::Duration::ZERO);
        }
        let Some(path) = tx.focused().and_then(|key| key.strip_prefix("file-row-")) else {
            return false;
        };
        if self.tree.selected() == Some(path) || !self.rows.iter().any(|row| row.entry.path == path)
        {
            return false;
        }
        self.tree.select(path.into());
        true
    }
    pub fn navigate(&mut self, path: &str, key: &rune::Key, rtl: bool, tx: &mut rune::Tx) -> bool {
        use rune::Key;
        let Some(index) = self.rows.iter().position(|row| row.entry.path == path) else {
            return false;
        };
        let row = &self.rows[index];
        let next = match key {
            Key::Enter => {
                self.select(path.into(), row.expanded.is_some());
                return true;
            }
            Key::Text(key) if key == " " => {
                self.select(path.into(), row.expanded.is_some());
                return true;
            }
            Key::Down => Some(
                self.rows[(index + 1).min(self.rows.len() - 1)]
                    .entry
                    .path
                    .clone(),
            ),
            Key::Up => Some(self.rows[index.saturating_sub(1)].entry.path.clone()),
            Key::Home => self.rows.first().map(|row| row.entry.path.clone()),
            Key::End => self.rows.last().map(|row| row.entry.path.clone()),
            key if *key == if rtl { Key::Left } else { Key::Right } => {
                match row.expanded {
                    Some(false) => self.select(path.into(), true),
                    Some(true) => {
                        if let Some(child) = self
                            .rows
                            .get(index + 1)
                            .filter(|child| child.parent == path)
                        {
                            self.focus_row(child.entry.path.clone(), tx);
                        }
                    }
                    None => return false,
                }
                return true;
            }
            key if *key == if rtl { Key::Right } else { Key::Left } => {
                if row.expanded == Some(true) {
                    self.select(path.into(), true);
                } else if row.parent != "." {
                    self.focus_row(row.parent.clone(), tx);
                }
                return true;
            }
            _ => return false,
        };
        if let Some(path) = next {
            self.focus_row(path, tx);
        }
        true
    }
    fn focus_row(&mut self, path: String, tx: &mut rune::Tx) {
        let key = format!("file-row-{path}");
        tx.focus(&key, true);
        tx.scroll_into_view_in("workspace-tree-scroll", key);
        self.tree.select(path);
    }
    pub(super) fn previews(&self, path: &str) -> bool {
        self.reader
            .target()
            .is_some_and(|target| target.directory == self.tree.directory() && target.path == path)
    }
    pub(super) fn toggle_preview(&mut self, directory: &str, path: &str, tx: &mut rune::Tx) {
        if self.stopped || self.tree.directory() != directory {
            return;
        }
        if self.previews(path) {
            self.close_reader();
            self.reading.restore(tx);
        } else {
            self.open(path.into());
        }
    }
    pub fn open(&mut self, path: String) {
        if !self.stopped {
            self.reader_close = Default::default();
            self.presentation.reset();
            self.document
                .open(self.tree.directory().into(), path.clone());
            self.reader.open(self.tree.directory().into(), path);
        }
    }
    pub fn reader_link(&self, target: &str, tx: &mut rune::Tx) {
        if let Some(url) = self.backend.file_link(target) {
            let _ = tx.open_url(&url);
        }
    }
    pub fn close_reader(&mut self) {
        self.presentation.reset();
        self.document.close();
        self.reader.close();
    }
    pub fn with_documents(mut self, store: Store, instance: String) -> Self {
        self.document = Editor::new(self.backend.clone(), store, instance, self.wake.clone());
        self
    }
    pub fn save_document(&mut self, scope: u64) {
        self.document.save(scope, &mut self.reader);
    }
    pub fn refresh_document(&mut self, scope: u64) {
        self.document.refresh(scope, &mut self.reader);
    }
    pub fn confirm_document(&mut self, id: u64, accepted: bool) {
        self.document.confirm(id, accepted, &mut self.reader);
    }
    pub fn poll(&mut self, now: f64) -> bool {
        self.clock = now;
        let mut changed = self.poll_create();
        if self.document.take_write() && !self.stopped {
            self.tree.invalidate_all();
            self.pending = None;
            self.due = Some(0.0);
            changed = true;
        }
        if self.pending.as_ref().is_some_and(|(due, _)| now >= *due) {
            if let Some((_, changes)) = self.pending.take() {
                let mut reader_changed = changes.is_none();
                if let Some(changes) = changes {
                    for (directory, path) in changes {
                        reader_changed |= self.reader.target().is_some_and(|target| {
                            codenomad_client::same_server_path(&directory, &target.directory)
                        });
                        self.tree.invalidate(&directory, Some(&path));
                    }
                } else {
                    self.tree.invalidate_all();
                }
                self.last_passive = Some(now);
                self.due = Some(now + 0.1);
                if reader_changed {
                    self.reader.invalidate();
                }
            }
        }
        for _ in 0..8 {
            let Ok((read, result)) = self.incoming.try_recv() else {
                break;
            };
            let collation = &self.collation;
            changed |= self.tree.complete(read, result, |entries| match collation {
                Ok(collation) => collation.sort_files(entries),
                Err(error) => Err(error.clone()),
            });
        }
        if !self.incoming.is_empty() {
            (self.wake)();
        }
        if self.active
            && self.tree_visible()
            && self.online
            && self.due.is_some_and(|due| now >= due)
        {
            self.due = None;
            let requests = self.tree.take_refresh();
            changed |= !requests.is_empty();
            self.launch(requests);
        }
        if changed {
            self.snapshot();
            self.due.get_or_insert(now + 0.1);
        }
        if self
            .reader
            .target()
            .is_some_and(|target| target.directory != self.tree.directory())
        {
            self.reader.close();
            self.document.close();
            changed = true;
        }
        self.reader
            .activate(self.active && !self.document.writing());
        changed |= self.reader.poll(now);
        changed |= self.document.poll(&mut self.reader);
        changed |= self
            .presentation
            .sync(&self.reader, self.document.revision());
        changed
    }
    fn launch(&mut self, requests: Vec<Read>) {
        for read in requests {
            let (backend, reads, out, wake) = (
                self.backend.clone(),
                self.reads.clone(),
                self.out.clone(),
                self.wake.clone(),
            );
            platform::spawn(async move {
                if let Some(result) = read.fetch(&backend, &reads).await {
                    if out.send((read, result)).await.is_ok() {
                        wake();
                    }
                }
            });
        }
        self.snapshot();
    }
    fn snapshot(&mut self) {
        self.rows = self
            .tree
            .rows()
            .into_iter()
            .map(|row| Row {
                entry: row.entry.clone(),
                parent: row.parent.into(),
                depth: row.depth,
                expanded: row.expanded,
                busy: self.tree.busy(&row.entry.path),
            })
            .collect();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
