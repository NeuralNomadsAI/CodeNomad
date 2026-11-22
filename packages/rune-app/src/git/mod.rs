mod binding;
mod changes;
mod diff;
mod request;
mod view;
pub(crate) use binding::{
    Binding, close_preview, connected, event, has_preview, online, poll, project_opened, show,
    surface, toggle,
};
pub(crate) use view::{panel, reader};

use crate::platform::{collation::Collation, reads::Reads};
use changes::{Changes, Id};
use codenomad_client::{
    Wake,
    backend::Backend,
    catalog::Sessions,
    git::{Details, Page, Refusal, Repository, Section, Worktree, Worktrees},
    history::Error,
    same_server_path,
    transport::WorkspaceEvent,
};
use request::{Completed, Lane, Mutation, MutationKind, Read, Requests, Value};
use rune::edit::TextEdit;
use rune_theme_codenomad::git_diff::{ImageCache, image_cache};
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Workspace,
    Changes,
    History,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Source {
    Local(Section),
    Commit { id: String, subject: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Preview {
    source: Source,
    path: String,
    original_path: Option<String>,
}

impl Preview {
    fn local(row: &changes::Row) -> Self {
        Self {
            source: Source::Local(row.id.section),
            path: row.id.path.clone(),
            original_path: row.original_path.clone(),
        }
    }
}

#[derive(Default)]
struct History {
    page: Option<Page>,
    selected: Option<String>,
    details: Option<Details>,
    file: Option<String>,
}

pub(crate) struct Ui {
    backend: Backend,
    root: Option<String>,
    inventory: Option<Worktrees>,
    slug: String,
    scope: std::rc::Rc<()>,
    tree_epoch: u64,
    picker: bool,
    zones: [[f32; 4]; 2],
    body_bounds: [f32; 4],
    active: bool,
    online: bool,
    shown: bool,
    stopped: bool,
    clock: f64,
    passive_due: Option<f64>,
    passive_started: Option<f64>,
    last_passive: Option<f64>,
    mode: Mode,
    hide_whitespace: bool,
    filter: TextEdit,
    history: History,
    changes: Changes,
    reader: diff::Reader,
    images: ImageCache,
    preview: Option<Preview>,
    preview_revision: u64,
    mutation_message: Option<(bool, String)>,
    invalidated_files: bool,
    init_sessions: Option<Sessions>,
    collation: Option<Collation>,
    requests: Requests,
}

impl Ui {
    pub(crate) fn new(backend: Backend, root: Option<String>, reads: Reads, wake: Wake) -> Self {
        Self {
            requests: Requests::new(backend.clone(), reads, wake.clone()),
            images: image_cache(wake),
            backend,
            root,
            inventory: None,
            slug: "root".into(),
            scope: std::rc::Rc::new(()),
            tree_epoch: 0,
            picker: false,
            zones: [[0.0; 4]; 2],
            body_bounds: [0.0; 4],
            active: true,
            online: false,
            shown: false,
            stopped: false,
            clock: 0.0,
            passive_due: None,
            passive_started: None,
            last_passive: None,
            mode: Mode::Workspace,
            hide_whitespace: true,
            filter: TextEdit::new(""),
            history: History::default(),
            changes: Changes::default(),
            reader: diff::Reader::default(),
            preview: None,
            preview_revision: 0,
            mutation_message: None,
            invalidated_files: false,
            init_sessions: None,
            collation: Collation::try_default().ok(),
        }
    }

    pub(crate) fn bind(&mut self, backend: &Backend) -> bool {
        if self.backend.workspace != backend.workspace || self.backend.base != backend.base {
            return false;
        }
        if self.backend.session != backend.session {
            self.backend.session.clone_from(&backend.session);
            self.close_preview();
            if self.slug != "root" {
                self.slug = "root".into();
                self.reset_tree();
            }
        }
        true
    }

    pub(crate) fn online(&mut self, online: bool) {
        if self.online == online || self.stopped {
            return;
        }
        self.online = online;
        if online {
            self.dirty(&[
                Lane::Worktrees,
                Lane::Changes,
                Lane::History,
                Lane::Preferences,
            ]);
            if self
                .preview
                .as_ref()
                .is_some_and(|target| matches!(target.source, Source::Local(_)))
            {
                self.dirty(&[Lane::Preview]);
            }
        }
        self.demand();
    }

    pub(crate) fn activate(&mut self, active: bool) {
        self.active = active;
        self.demand();
    }

    pub(crate) fn show(&mut self, shown: bool) {
        if self.shown != shown {
            self.shown = shown;
            self.demand();
        }
    }

    pub(crate) fn mode(&self) -> Mode {
        self.mode
    }
    pub(crate) fn set_mode(&mut self, mode: Mode) {
        if self.mode != mode {
            self.mode = mode;
            self.demand();
        }
    }

    pub(crate) fn tree(&self) -> Option<&Worktree> {
        self.inventory
            .as_ref()?
            .trees
            .iter()
            .find(|tree| tree.slug == self.slug && !tree.missing)
    }

    fn select_tree(&mut self, slug: String) {
        if self.slug != slug
            && self.inventory.as_ref().is_some_and(|list| {
                list.trees
                    .iter()
                    .any(|tree| tree.slug == slug && !tree.missing)
            })
        {
            self.slug = slug;
            self.reset_tree();
            self.demand();
        }
    }

    fn reset_tree(&mut self) {
        self.tree_epoch = self.tree_epoch.wrapping_add(1);
        self.scope = std::rc::Rc::new(());
        self.picker = false;
        let open = self.changes.open;
        self.changes = Changes::default();
        self.changes.open = open;
        self.history = History::default();
        self.mutation_message = None;
        self.close_preview();
        for lane in [Lane::Changes, Lane::History, Lane::Details] {
            *self.requests.slot_mut(lane) = Default::default();
        }
    }

    pub(crate) fn event(&mut self, event: &WorkspaceEvent) {
        if self.stopped {
            return;
        }
        match event {
            WorkspaceEvent::UiPreferencesChanged => {
                self.requests.slot_mut(Lane::Preferences).cancel();
                self.dirty(&[Lane::Preferences]);
            }
            WorkspaceEvent::FilesChanged {
                workspace_id,
                changes,
            } if workspace_id == &self.backend.workspace
                && self.tree().is_some_and(|tree| {
                    changes
                        .iter()
                        .any(|change| same_server_path(&change.directory, &tree.directory))
                }) =>
            {
                self.filesystem_hint();
            }
            WorkspaceEvent::NativeFilesystemChanged { workspace_id }
                if workspace_id == &self.backend.workspace =>
            {
                self.filesystem_hint()
            }
            WorkspaceEvent::WorktreesChanged { workspace_id }
                if workspace_id == &self.backend.workspace =>
            {
                self.dirty(&[Lane::Worktrees, Lane::Changes, Lane::History]);
            }
            WorkspaceEvent::Stopped { workspace_id } if workspace_id == &self.backend.workspace => {
                self.stopped = true;
                self.reset_tree();
                self.inventory = None;
                self.demand();
            }
            _ => {}
        }
    }

    fn filesystem_hint(&mut self) {
        let start = *self.passive_started.get_or_insert(self.clock);
        let soon = self.clock + 0.1;
        self.passive_due = Some(
            self.last_passive
                .map_or(soon, |last| (last + 5.0).max(soon))
                .min(start + 5.0),
        );
    }

    fn dirty(&mut self, lanes: &[Lane]) {
        for lane in lanes {
            self.requests.slot_mut(*lane).dirty = true;
        }
    }

    fn demand(&mut self) {
        let available = self.active && self.online && !self.stopped;
        let shown = available && self.shown;
        let tree_wanted = shown
            || available
                && (self.preview.is_some() || self.requests.slot(Lane::InitSessions).dirty);
        let git = self.repository() != Repository::Uninitialized && self.tree().is_some();
        let changes = shown && git && self.mode == Mode::Changes;
        let history = shown && git && self.mode == Mode::History;
        for (lane, wanted) in [
            (Lane::Worktrees, tree_wanted),
            (Lane::InitSessions, available),
            (Lane::Changes, changes),
            (Lane::History, history),
            (Lane::Details, history && self.history.selected.is_some()),
            (Lane::Preview, available && self.preview.is_some()),
            (
                Lane::Preferences,
                shown || available && self.preview.is_some(),
            ),
        ] {
            if !wanted {
                self.requests.slot_mut(lane).cancel();
            }
        }
        if tree_wanted && self.requests.mutation.is_none() {
            self.ensure(
                Read::Worktrees(self.inventory.is_some()),
                self.inventory.is_none(),
            );
        }
        if shown || available && self.preview.is_some() {
            self.ensure(Read::Preferences, false);
        }
        if self.requests.mutation.is_some() {
            return;
        }
        if available
            && !self.requests.slot(Lane::Worktrees).busy()
            && let Some(root) = self
                .inventory
                .as_ref()
                .and_then(|list| list.trees.iter().find(|tree| tree.slug == "root"))
        {
            self.ensure(Read::InitSessions(root.clone()), false);
        }
        if let Some(tree) = self.tree().cloned() {
            if changes {
                self.ensure(
                    Read::Changes(tree.clone(), self.hide_whitespace),
                    !self.changes.ready(),
                );
            }
            if history {
                self.ensure(
                    Read::History(tree.slug.clone(), None),
                    self.history.page.is_none(),
                );
                if let Some(id) = self.history.selected.clone() {
                    self.ensure(
                        Read::Details(tree.clone(), id),
                        self.history.details.is_none(),
                    );
                }
            }
            if available && let Some(target) = self.preview.clone() {
                self.ensure(Read::Preview(tree, target), self.reader.content.is_none());
            }
        }
    }

    fn ensure(&mut self, read: Read, missing: bool) {
        let slot = self.requests.slot(read.lane());
        if slot.dirty || missing && slot.error.is_none() {
            self.requests.start(read);
        }
    }

    fn repository(&self) -> Repository {
        self.inventory
            .as_ref()
            .map_or(Repository::Unknown, |inventory| inventory.repository)
    }

    fn refresh(&mut self) {
        if matches!(
            self.repository(),
            Repository::Uninitialized | Repository::NoGit
        ) || self.inventory.is_none()
            || self.requests.slot(Lane::Worktrees).error.is_some()
        {
            self.dirty(&[Lane::Worktrees]);
        } else {
            match self.mode {
                Mode::Workspace => self.dirty(&[Lane::Worktrees]),
                Mode::Changes => {
                    self.dirty(&[Lane::Changes]);
                    if self
                        .preview
                        .as_ref()
                        .is_some_and(|t| matches!(t.source, Source::Local(_)))
                    {
                        self.dirty(&[Lane::Preview]);
                    }
                }
                Mode::History => {
                    self.dirty(&[Lane::History]);
                    if self.history.selected.is_some() && self.history.details.is_none() {
                        self.dirty(&[Lane::Details]);
                    }
                }
            }
        }
        self.demand();
    }

    pub(crate) fn set_hide_whitespace(&mut self, hide: bool) {
        if self.hide_whitespace == hide {
            return;
        }
        self.hide_whitespace = hide;
        self.changes.project(hide);
        self.requests.slot_mut(Lane::Changes).cancel();
        self.dirty(&[Lane::Changes]);
        self.reconcile_preview();
        if let Some(target) = &self.preview {
            self.reader.rebuild(&target.path, hide);
        }
        self.demand();
    }

    fn more(&mut self) {
        if self.mode != Mode::History || !self.can_read_panel() {
            return;
        }
        if let Some(page) = &self.history.page
            && let Some(head) = &page.head
            && page.has_more
        {
            self.requests.start(Read::History(
                self.slug.clone(),
                Some((head.clone(), page.commits.len())),
            ));
        }
    }

    fn select_commit(&mut self, id: String) {
        if self.mode != Mode::History
            || !self.can_read_panel()
            || !self
                .history
                .page
                .as_ref()
                .is_some_and(|page| page.commits.iter().any(|entry| entry.id == id))
        {
            return;
        }
        self.back_to_history();
        self.history.selected = Some(id);
        self.demand();
    }

    fn back_to_history(&mut self) {
        self.history.selected = None;
        self.history.details = None;
        self.history.file = None;
        *self.requests.slot_mut(Lane::Details) = Default::default();
    }

    fn toggle_preview(&mut self, preview: Preview) -> bool {
        if !self.can_read_panel() || self.backend.session.is_empty() {
            return false;
        }
        if self.preview.as_ref() == Some(&preview) {
            self.close_preview();
            return false;
        }
        let admitted = match &preview.source {
            Source::Local(section) => {
                self.mode == Mode::Changes
                    && self
                        .changes
                        .find(&Id {
                            section: *section,
                            path: preview.path.clone(),
                        })
                        .is_some_and(|row| row.original_path == preview.original_path)
            }
            Source::Commit { id, .. } => {
                self.mode == Mode::History
                    && self.history.details.as_ref().is_some_and(|details| {
                        details.id == *id
                            && details.files.iter().any(|row| row.path == preview.path)
                    })
            }
        };
        if !admitted {
            return false;
        }
        self.replace_preview(preview);
        self.demand();
        true
    }

    fn replace_preview(&mut self, preview: Preview) {
        self.close_preview();
        if let Source::Local(section) = preview.source {
            self.changes.keep_visible(Id {
                section,
                path: preview.path.clone(),
            });
        }
        self.preview = Some(preview);
    }

    pub(crate) fn has_preview(&self) -> bool {
        self.preview.is_some()
    }
    pub(crate) fn close_preview(&mut self) {
        if self.preview.take().is_some() {
            self.preview_revision += 1;
            self.reader.clear();
            *self.requests.slot_mut(Lane::Preview) = Default::default();
        }
    }

    fn reconcile_preview(&mut self) {
        let Some(target) = &self.preview else {
            return;
        };
        let Source::Local(section) = target.source else {
            return;
        };
        let next = self
            .changes
            .equivalent(&Id {
                section,
                path: target.path.clone(),
            })
            .map(Preview::local);
        if next.as_ref() != Some(target) {
            if let Some(next) = next {
                self.replace_preview(next);
            } else {
                self.close_preview();
            }
        }
    }

    fn can_read_panel(&self) -> bool {
        self.active && self.online && self.shown && !self.stopped
    }

    fn can_mutate(&self) -> bool {
        self.can_read_panel()
            && self.requests.mutation.is_none()
            && self.tree().is_some()
            && !self.requests.slot(Lane::Worktrees).busy()
            && !self.requests.slot(Lane::Worktrees).dirty
            && self.requests.slot(Lane::Worktrees).error.is_none()
    }

    fn can_change_index(&self) -> bool {
        let changes = self.requests.slot(Lane::Changes);
        self.can_mutate()
            && self.mode == Mode::Changes
            && self.repository() == Repository::Git
            && self.changes.ready()
            && !changes.busy()
            && !changes.dirty
            && changes.error.is_none()
    }

    fn mutation(&mut self, action: Mutation) {
        if self.can_mutate()
            && let Some(tree) = self.tree().cloned()
        {
            for lane in [Lane::Changes, Lane::History, Lane::Preview] {
                self.requests.slot_mut(lane).cancel();
            }
            self.mutation_message = None;
            self.requests.mutate(self.tree_epoch, tree, action);
        }
    }

    fn move_paths(&mut self, id: &Id) {
        let paths = self.changes.paths(id);
        if self.can_change_index() && !paths.is_empty() {
            self.mutation(Mutation::Paths(id.section, paths));
        }
    }

    fn can_commit(&self) -> bool {
        self.can_change_index()
            && self.changes.section(Section::Staged).next().is_some()
            && !self.changes.draft.text.trim().is_empty()
    }

    fn commit(&mut self) {
        if self.can_commit() {
            let draft = self.changes.draft.text.clone();
            self.mutation(Mutation::Commit {
                message: draft.trim().to_owned(),
                draft,
            });
        }
    }

    fn initialize(&mut self) {
        if self.mode != Mode::Workspace
            && self.repository() == Repository::Uninitialized
            && let Some(root) = &self.root
            && self
                .tree()
                .is_some_and(|tree| tree.slug == "root" && same_server_path(&tree.directory, root))
        {
            self.mutation(Mutation::Init(root.clone()));
        }
    }
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
impl Ui {
    pub(crate) fn load_scene(
        &mut self,
        mode: Mode,
        inventory: Worktrees,
        statuses: Vec<codenomad_client::git::Status>,
        commits: Page,
        path: &str,
        diff: codenomad_client::git::Diff,
    ) {
        self.accept(Lane::Worktrees, Value::Worktrees(inventory));
        self.accept(Lane::Changes, Value::Changes(statuses));
        self.accept(Lane::History, Value::History(commits, false));
        self.replace_preview(Preview {
            source: Source::Local(Section::Staged),
            path: path.into(),
            original_path: None,
        });
        self.accept(Lane::Preview, Value::Preview(diff));
        self.mode = mode;
        self.online = true;
        self.shown = true;
    }
}
mod settle;
#[cfg(test)]
mod tests;
