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

type Changes = Option<BTreeSet<(String, String)>>;

pub struct Row {
    pub entry: Entry,
    pub parent: String,
    pub depth: usize,
    pub expanded: Option<bool>,
    pub busy: bool,
}
pub struct Ui {
    pub reader_close: crate::window_control::WindowCloseState,
    pub(super) pictures: Box<super::markdown_images::Pictures>,
    pub presentation: Box<super::presentation::Presentation>,
    pub document: Box<Editor>,
    pub reader: Box<Reader>,
    pub tree: Box<Tree>,
    pub rows: Vec<Row>,
    pub panel: bool,
    pub(super) shell_managed: bool,
    pub(super) tree_scroll: rune_theme_codenomad::git_panel::ScrollBookmark,
    pub(super) local: bool,
    pub(super) actions: Box<super::view::Actions>,
    pub host_width: Option<f32>,
    pub(super) reader_width: Option<f32>,
    pub(super) backend: Backend,
    reads: Reads,
    collation: std::result::Result<Collation, String>,
    incoming: Receiver<(Read, Result<Vec<Entry>>)>,
    out: Sender<(Read, Result<Vec<Entry>>)>,
    pub(super) wake: Wake,
    active: bool,
    online: bool,
    due: Option<f64>,
    clock: f64,
    last_passive: Option<f64>,
    pending: Option<(f64, Changes)>,
    session_preview: bool,
    pub stopped: bool,
}
impl Ui {
    pub(crate) fn workspace_id(&self) -> &str {
        &self.backend.workspace
    }

    pub(crate) fn retained_bytes(
        &self,
        seen_file_drafts: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.reader
            .retained_bytes()
            .saturating_add(self.presentation.retained_bytes())
            .saturating_add(self.document.clean_retained_bytes(seen_file_drafts))
            .saturating_add(self.pictures.retained_bytes())
            .saturating_add(self.tree.retained_bytes())
            .saturating_add(self.rows.len().saturating_mul(size_of::<Row>()))
    }

    pub(crate) fn evictable_inactive_bytes(&self) -> usize {
        let reader = if self.document.has_unsaved_edits() {
            0
        } else {
            self.reader
                .retained_bytes()
                .saturating_add(self.document.clean_evictable_bytes())
        };
        reader
            .saturating_add(self.presentation.retained_bytes())
            .saturating_add(self.pictures.retained_bytes())
            .saturating_add(self.tree.retained_bytes())
            .saturating_add(self.rows.len().saturating_mul(size_of::<Row>()))
    }

    pub(crate) fn evict_cached_worktrees(&mut self) -> usize {
        self.tree.evict_cached_worktrees()
    }

    pub(crate) fn evict_inactive_caches(&mut self) -> usize {
        let mut freed = self.pictures.evict();
        freed = freed.saturating_add(self.presentation.evict_image(self.wake.clone()));
        freed = freed.saturating_add(self.tree.evict_listings());
        freed = freed.saturating_add(self.rows.len().saturating_mul(size_of::<Row>()));
        self.rows.clear();
        if !self.document.has_unsaved_edits() {
            freed = freed.saturating_add(self.document.evict_clean_buffers());
            freed = freed.saturating_add(self.reader.evict_preview());
        }
        freed
    }

    pub(crate) fn uses_connection(&self, backend: &Backend) -> bool {
        self.backend.client.same_connection(&backend.client)
    }

    pub(crate) fn same_server_identity(&self, backend: &Backend) -> bool {
        let previous = self.backend.client.server_identity();
        previous.is_some() && previous == backend.client.server_identity()
    }

    pub fn new(backend: Backend, directory: String, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(16);
        Self {
            reader_close: Default::default(),
            pictures: Box::new(super::markdown_images::Pictures::new(wake.clone())),
            presentation: Box::new(super::presentation::Presentation::new(wake.clone())),
            document: Box::new(Editor::new(
                backend.clone(),
                Store::default(),
                backend.workspace.clone(),
                wake.clone(),
            )),
            reader: Box::new(Reader::new(backend.clone(), reads.clone(), wake.clone())),
            tree: Box::new(Tree::new(directory)),
            rows: vec![],
            panel: false,
            shell_managed: false,
            tree_scroll: Default::default(),
            local: false,
            actions: Default::default(),
            host_width: None,
            reader_width: None,
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
            session_preview: false,
            stopped: false,
        }
    }
    pub(super) fn with_shell(mut self, local: bool) -> Self {
        self.shell_managed = true;
        self.local = local;
        self
    }
    pub(super) fn tree_visible(&self) -> bool {
        if self.shell_managed {
            self.panel
        } else {
            self.drawer().pinned
        }
    }
    pub(super) fn actions_ready(&self) -> bool {
        self.tree_visible() && self.active && self.online && !self.stopped
    }
    pub fn activate(&mut self, active: bool) {
        self.active = active;
        if !active {
            self.host_width = None;
            self.reader_width = None;
            self.tree_scroll.retain_for_remount();
            self.pictures.suspend();
            self.actions.revoke();
        }
        self.document.activate(active);
        self.reader.activate(active);
        self.demand();
    }
    pub fn show(&mut self, show: bool) {
        if self.panel == show {
            return;
        }
        if !show {
            self.tree_scroll.retain_for_remount();
        }
        self.panel = show;
        self.demand();
    }
    pub fn browse(&mut self, directory: String) {
        if self.tree.directory() != directory {
            self.actions.revoke();
            self.tree_scroll = Default::default();
            if !self.session_preview() {
                self.close_reader();
            }
            self.tree.switch(directory);
            self.demand();
        }
    }

    pub(crate) fn session_preview(&self) -> bool {
        self.session_preview && self.reader.target().is_some()
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
            })
        {
            tx.focus("files-toggle", true);
        }
        self.demand();
    }
    pub fn detach_session(&mut self) {
        self.close_reader();
        self.backend.session.clear();
    }
    pub fn rebind_session(&mut self, backend: &Backend) {
        let renewed = !self.uses_connection(backend);
        self.close_reader();
        self.backend = backend.clone();
        self.reader.rebind_session(backend);
        self.document.rebind_session(backend);
        if !backend.session.is_empty() {
            self.online(false);
        }
        if renewed {
            self.actions.revoke();
            self.tree.invalidate_all();
            self.pending = None;
            self.demand();
        }
    }
    pub fn online(&mut self, online: bool) {
        if !online {
            self.pictures.suspend();
        }
        self.document.online(online && !self.stopped);
        self.reader.online(online && !self.stopped);
        if online && !self.online {
            self.tree.invalidate_all();
            self.pending = None;
        }
        if !online && self.online {
            self.actions.revoke();
        }
        self.online = online;
        self.demand();
    }
    fn demand(&mut self) {
        self.tree.activate(self.actions_ready());
        self.due = Some(0.0);
        self.snapshot();
    }
    pub fn event(&mut self, event: WorkspaceEvent) {
        match event {
            WorkspaceEvent::SessionMoved {
                workspace_id,
                session_id,
            } if workspace_id == self.backend.workspace && session_id == self.backend.session => {
                self.close_reader();
            }
            WorkspaceEvent::NativeFilesystemChanged { workspace_id }
            | WorkspaceEvent::WorktreesChanged { workspace_id }
                if workspace_id == self.backend.workspace && !self.stopped =>
            {
                let due = self
                    .last_passive
                    .map_or(self.clock + 0.1, |last| (last + 5.0).max(self.clock + 0.1));
                let (_, pending) = self.pending.get_or_insert_with(|| (due, None));
                *pending = None;
            }
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
            WorkspaceEvent::Stopped { workspace_id, .. }
                if workspace_id == self.backend.workspace =>
            {
                self.pictures.suspend();
                self.tree.close();
                self.document.close();
                self.reader.close();
                self.pending = None;
                self.stopped = true;
                self.actions.revoke();
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
    pub(super) fn toggle_preview(&mut self, directory: &str, path: &str) -> Option<bool> {
        if self.stopped || self.tree.directory() != directory {
            return None;
        }
        if self.previews(path) {
            self.close_reader();
            Some(false)
        } else {
            self.open(path.into());
            Some(true)
        }
    }
    pub fn open(&mut self, path: String) {
        self.open_at(self.tree.directory().into(), path, false);
    }

    pub(super) fn open_session_path(&mut self, directory: String, path: String) -> bool {
        self.open_at(directory, path, true)
    }

    fn open_at(&mut self, directory: String, path: String, session_preview: bool) -> bool {
        if !self.stopped {
            self.session_preview = session_preview;
            self.pictures.suspend();
            self.reader_close = Default::default();
            self.presentation.reset();
            self.document.open(directory.clone(), path.clone());
            self.reader.open(directory, path);
            return true;
        }
        false
    }
    pub fn reader_link(&self, target: &str, tx: &mut rune::Tx) {
        if let Some(url) = self.backend.file_link(target) {
            let _ = tx.open_url(&url);
        }
    }
    pub fn close_reader(&mut self) {
        self.session_preview = false;
        self.pictures.suspend();
        self.presentation.reset();
        self.document.close();
        self.reader.close();
    }
    pub fn with_documents(mut self, store: Store, instance: String) -> Self {
        self.document = Box::new(Editor::new(
            self.backend.clone(),
            store,
            instance,
            self.wake.clone(),
        ));
        self
    }
    pub(super) fn with_draft_project(mut self, project: crate::catalog::Project) -> Self {
        self.document.set_project(project);
        self
    }
    pub fn save_document(&mut self, scope: u64) {
        self.document.save(scope, &mut self.reader);
    }
    pub(super) fn document_kind(&self) -> Option<super::presentation::Kind> {
        use super::presentation::Kind;
        self.reader
            .target()
            .filter(|_| self.document.editable())
            .map(|target| Kind::Text(super::document::text_format(&target.path)))
            .or(self.presentation.kind)
    }
    pub fn refresh_document(&mut self, scope: u64) {
        self.document.refresh(scope, &mut self.reader);
    }
    pub fn confirm_document(&mut self, id: u64, accepted: bool) {
        self.document.confirm(id, accepted, &mut self.reader);
    }
    pub(crate) fn observe_document_write(&mut self) -> bool {
        if self.document.take_write() && !self.stopped {
            self.tree.invalidate_all();
            self.pending = None;
            self.due = Some(0.0);
            return true;
        }
        false
    }
    pub(crate) fn next_wake(&self) -> Option<f64> {
        if self.stopped {
            return None;
        }
        let pending = self.pending.as_ref().map(|(due, _)| *due);
        let refresh = (self.active && self.tree_visible() && self.online)
            .then_some(self.due)
            .flatten();
        match (pending, refresh) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
    pub fn poll(&mut self, now: f64) -> bool {
        self.clock = now;
        let mut changed = self.observe_document_write();
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
        if !self.session_preview
            && self
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
        let markdown = self.document_kind()
            == Some(super::presentation::Kind::Text(
                super::document::Format::Markdown,
            ));
        changed |= self.pictures.sync(
            markdown.then(|| (self.document.scope(), self.document.revision())),
            markdown && !self.presentation.source && self.active && self.online && !self.stopped,
            &self.backend.base,
            &self.document.edit().text,
        );
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
        if self.shell_managed {
            self.actions.retain_rows(&self.rows);
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
