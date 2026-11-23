mod actions;
mod binding;
mod changes;
mod diff;
mod menu;
mod preview;
mod refresh;
mod request;
mod view;
pub(crate) use binding::{
    Binding, close_preview, connected, connected_placed, diff_preferences, event, has_preview,
    mode, online, poll, project_opened, set_diff_preferences, set_mode, show,
};
pub(crate) use diff::DiffPreferences;
pub(crate) use view::{panel, reader};

use crate::platform::{collation::Collation, reads::Reads};
use changes::{Changes, Id};
use codenomad_client::{
    Wake,
    backend::Backend,
    catalog::Sessions,
    git::{Details, Page, Refusal, Repository, Worktree, Worktrees},
    history::Error,
    same_server_path,
};
use preview::{Preview, Source};
use request::{Completed, Lane, Mutation, MutationKind, Read, Requests, Value};
use rune::edit::TextEdit;
use rune_theme_codenomad::git_diff::{ImageCache, image_cache};
use rune_theme_codenomad::git_panel::ScrollBookmark;
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Workspace,
    Changes,
    History,
}

impl Mode {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Changes => "changes",
            Self::History => "history",
        }
    }

    pub(crate) fn restore(key: &str) -> Option<Self> {
        match key {
            "workspace" => Some(Self::Workspace),
            "changes" => Some(Self::Changes),
            "history" => Some(Self::History),
            _ => None,
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
    session_slug: String,
    scope: std::rc::Rc<()>,
    tree_epoch: u64,
    index_revision: u64,
    index_checked: Option<u64>,
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
    menu: rune_theme_codenomad::action_menu::State<crate::State>,
    open_menu: Option<Id>,
    changes_scroll: ScrollBookmark,
    history_scroll: ScrollBookmark,
    detail_scroll: ScrollBookmark,
    reader: diff::Reader,
    images: ImageCache,
    preview: Option<Preview>,
    preview_revision: u64,
    reconcile_revision: Option<u64>,
    pending_row_focus: Option<(Vec<Id>, usize)>,
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
            session_slug: "root".into(),
            scope: std::rc::Rc::new(()),
            tree_epoch: 0,
            index_revision: 0,
            index_checked: None,
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
            menu: Default::default(),
            open_menu: None,
            changes_scroll: ScrollBookmark::default(),
            history_scroll: ScrollBookmark::default(),
            detail_scroll: ScrollBookmark::default(),
            reader: diff::Reader::default(),
            preview: None,
            preview_revision: 0,
            reconcile_revision: None,
            pending_row_focus: None,
            mutation_message: None,
            invalidated_files: false,
            init_sessions: None,
            collation: Collation::try_default().ok(),
        }
    }

    pub(crate) fn bind(&mut self, backend: &Backend) -> bool {
        self.bind_placed(backend, None)
    }

    fn bind_placed(&mut self, backend: &Backend, placement: Option<&str>) -> bool {
        if self.backend.workspace != backend.workspace || self.backend.base != backend.base {
            return false;
        }
        let placement =
            placement.or_else(|| (self.backend.session != backend.session).then_some("root"));
        if !self.backend.client.same_connection(&backend.client) {
            let previous = self.backend.client.server_identity();
            if previous.is_none() || previous != backend.client.server_identity() {
                return false;
            }
            self.backend.client = backend.client.clone();
            self.backend.client_id.clone_from(&backend.client_id);
            self.requests.renew(backend.clone());
            self.invalidate_index();
        }
        if self.backend.session != backend.session
            || placement.is_some_and(|slug| self.session_slug != slug)
        {
            self.backend.session.clone_from(&backend.session);
            self.session_slug = placement.unwrap_or("root").into();
            self.close_preview();
            if self.slug != self.session_slug {
                self.slug.clone_from(&self.session_slug);
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
            self.invalidate_index();
            self.dirty(&[
                Lane::Worktrees,
                Lane::Changes,
                Lane::History,
                Lane::Preferences,
            ]);
            if self.has_local_preview() {
                self.dirty(&[Lane::Preview]);
            }
        }
        self.demand();
    }

    pub(crate) fn activate(&mut self, active: bool) {
        if !active {
            self.keep_scroll();
        } else if !self.active {
            self.invalidate_index();
            self.retry_panel_reads();
        }
        self.active = active;
        self.demand();
    }

    pub(crate) fn show(&mut self, shown: bool) {
        if self.shown != shown {
            if !shown {
                self.keep_scroll();
            }
            self.shown = shown;
            if shown {
                self.retry_panel_reads();
            }
            if shown && self.mode == Mode::Changes && self.has_local_preview() {
                self.dirty(&[Lane::Changes, Lane::Preview]);
            }
            self.demand();
        }
    }

    pub(crate) fn mode(&self) -> Mode {
        self.mode
    }
    pub(crate) fn set_mode(&mut self, mode: Mode) {
        if self.mode != mode {
            self.keep_scroll();
            self.mode = mode;
            self.retry_panel_reads();
            self.demand();
        }
    }

    fn keep_scroll(&self) {
        self.changes_scroll.retain_for_remount();
        self.history_scroll.retain_for_remount();
        self.detail_scroll.retain_for_remount();
    }

    fn retry_panel_reads(&mut self) {
        let lanes: &[Lane] = match self.mode {
            Mode::Workspace => &[Lane::Worktrees],
            Mode::Changes => &[Lane::Worktrees, Lane::Changes, Lane::Preferences],
            Mode::History => &[Lane::Worktrees, Lane::History, Lane::Details],
        };
        for &lane in lanes {
            let slot = self.requests.slot_mut(lane);
            slot.dirty |= slot.error.is_some();
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
        self.index_checked = None;
        self.scope = std::rc::Rc::new(());
        self.picker = false;
        let open = self.changes.open;
        self.changes = Changes::default();
        self.menu = Default::default();
        self.open_menu = None;
        self.changes.open = open;
        self.changes_scroll = ScrollBookmark::default();
        self.history_scroll = ScrollBookmark::default();
        self.detail_scroll = ScrollBookmark::default();
        self.history = History::default();
        self.mutation_message = None;
        self.reconcile_revision = None;
        self.pending_row_focus = None;
        self.close_preview();
        for lane in [Lane::Changes, Lane::History, Lane::Details] {
            *self.requests.slot_mut(lane) = Default::default();
        }
    }

    fn repository(&self) -> Repository {
        self.inventory
            .as_ref()
            .map_or(Repository::Unknown, |inventory| inventory.repository)
    }

    pub(crate) fn set_hide_whitespace(&mut self, hide: bool) {
        if self.hide_whitespace == hide {
            return;
        }
        self.hide_whitespace = hide;
        self.changes.project(hide);
        self.requests.slot_mut(Lane::Changes).cancel();
        self.invalidate_index();
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
        self.history_scroll.retain_for_remount();
        self.history.selected = Some(id);
        self.demand();
    }

    fn back_to_history(&mut self) {
        self.detail_scroll = ScrollBookmark::default();
        self.history.selected = None;
        self.history.details = None;
        self.history.file = None;
        *self.requests.slot_mut(Lane::Details) = Default::default();
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
        self.accept(
            Lane::Changes,
            Value::Changes(statuses, None, self.index_revision),
        );
        self.accept(Lane::History, Value::History(commits, false));
        self.replace_preview(Preview {
            source: Source::Local(codenomad_client::git::Section::Staged),
            path: path.into(),
            original_path: None,
        });
        self.accept(Lane::Preview, Value::Preview(diff));
        self.mode = mode;
        self.online = true;
        self.shown = true;
    }

    pub(crate) fn load_commit_scene(&mut self, details: Details) {
        self.history.selected = Some(details.id.clone());
        self.accept(Lane::Details, Value::Details(details));
    }
}
mod settle;
#[cfg(test)]
mod tests;
