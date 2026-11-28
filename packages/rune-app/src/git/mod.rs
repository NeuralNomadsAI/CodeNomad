mod actions;
mod binding;
mod changes;
mod date;
mod diff;
mod menu;
mod preview;
mod refresh;
mod request;
mod view;
#[cfg(test)]
pub(crate) use binding::fixture_open_preview;
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) use binding::poll_notices;
pub(crate) use binding::{
    Binding, PlacementHold, SessionDirectory, can_place, close_preview, connected,
    connected_placed, conversation_checkout, detach_session, diff_preferences,
    dismiss_panel_overlays, event, file_link_scope, files_checkout, has_preview, hold_placement,
    is_composing, mode, online, overlay_open, panel_overlay_open, placeable, placement,
    placement_hold, placement_unconfirmed, poll, project_opened, release_placement,
    restore_reading_if_closed, session_directory, set_diff_preferences, set_mode, show,
};
#[cfg(test)]
pub(crate) use binding::{
    fixture_commit_draft, fixture_commit_preedit, fixture_online, fixture_open_picker,
    fixture_open_placement_picker, fixture_unstaged_change, fixture_worktrees,
};
pub(crate) use diff::DiffPreferences;
pub(crate) use view::{panel, reader, session_worktree};

pub(crate) fn history_worktree<'a>(s: &'a crate::State, slug: &str) -> Option<&'a str> {
    let inventory = s.git.owner.as_ref()?.inventory.as_ref()?;
    if inventory.repository != Repository::Git {
        return None;
    }
    let tree = inventory
        .trees
        .iter()
        .find(|tree| tree.slug == slug && !tree.missing)?;
    Some(
        tree.label
            .as_deref()
            .or(tree.branch.as_deref())
            .unwrap_or(&tree.slug),
    )
}

use crate::platform::{collation::Collation, reads::Reads};
use changes::{Changes, Id};
use codenomad_client::{
    Wake,
    backend::Backend,
    catalog::Sessions,
    git::{Details, GitError, Page, Refusal, Repository, Worktree, Worktrees},
    history::Error,
    same_server_path,
};
use preview::{Preview, Source};
use request::{Completed, GitMessage, Lane, Mutation, MutationKind, Read, Requests, Value};
use rune::edit::TextEdit;
use rune_theme_codenomad::git_diff::{ImageCache, image_cache};
use rune_theme_codenomad::git_panel::ScrollBookmark;
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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
    dates: std::cell::RefCell<Option<(&'static str, Vec<String>)>>,
    selected: Option<String>,
    details: Option<Details>,
    file: Option<String>,
}

impl History {
    fn retained_bytes(&self) -> usize {
        let page = self.page.as_ref().map_or(0, |page| {
            page.commits.iter().fold(0usize, |total, commit| {
                total
                    .saturating_add(commit.id.len())
                    .saturating_add(commit.subject.len())
                    .saturating_add(commit.author.len())
                    .saturating_add(commit.date.len())
                    .saturating_add(commit.refs.len())
            })
        });
        let details = self.details.as_ref().map_or(0, |details| {
            details
                .id
                .len()
                .saturating_add(details.message.len())
                .saturating_add(details.files.iter().fold(0usize, |total, file| {
                    total
                        .saturating_add(file.path.len())
                        .saturating_add(file.original_path.as_deref().map_or(0, str::len))
                        .saturating_add(file.kind.len())
                }))
        });
        let dates = self
            .dates
            .borrow()
            .as_ref()
            .map_or(0, |(_, list)| list.iter().map(String::len).sum());
        page.saturating_add(details).saturating_add(dates)
    }

    fn evict_cached(&mut self) -> usize {
        let before = self.retained_bytes();
        self.page = None;
        self.details = None;
        self.dates.borrow_mut().take();
        before
    }

    fn dates(&self, locale: &'static str) -> std::cell::Ref<'_, [String]> {
        let mut cache = self.dates.borrow_mut();
        if cache.as_ref().is_none_or(|(cached, _)| *cached != locale) {
            *cache = Some((
                locale,
                self.page
                    .iter()
                    .flat_map(|page| &page.commits)
                    .map(|commit| date::display(&commit.date, locale))
                    .collect(),
            ));
        }
        drop(cache);
        std::cell::Ref::map(self.dates.borrow(), |cache| {
            cache
                .as_ref()
                .map_or(&[][..], |(_, dates)| dates.as_slice())
        })
    }
}

pub(crate) struct Ui {
    backend: Backend,
    root: Option<String>,
    inventory: Option<Worktrees>,
    slug: String,
    session_slug: String,
    workspace_preview: bool,
    scope: std::rc::Rc<()>,
    tree_epoch: u64,
    index_revision: u64,
    index_checked: Option<u64>,
    picker: bool,
    placement_picker: Option<Vec<(String, String)>>,
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
    mutation_message: Option<(bool, GitMessage)>,
    mutation_notice: Option<(bool, GitMessage)>,
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
            workspace_preview: false,
            scope: std::rc::Rc::new(()),
            tree_epoch: 0,
            index_revision: 0,
            index_checked: None,
            picker: false,
            placement_picker: None,
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
            mutation_notice: None,
            invalidated_files: false,
            init_sessions: None,
            collation: Collation::try_default().ok(),
        }
    }

    pub(crate) fn workspace_id(&self) -> &str {
        &self.backend.workspace
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
            || self.backend.session_directory != backend.session_directory
            || placement.is_some_and(|slug| self.session_slug != slug)
        {
            self.backend.session.clone_from(&backend.session);
            self.backend
                .session_directory
                .clone_from(&backend.session_directory);
            if let Some(slug) = placement {
                self.session_slug = slug.into();
            }
            self.close_preview();
            if self.slug != self.session_slug && self.changes.draft.text.is_empty() {
                self.slug.clone_from(&self.session_slug);
                self.reset_tree();
            }
        }
        true
    }

    pub(crate) fn detach_session(&mut self) {
        self.backend.session.clear();
        self.backend.session_directory = None;
        self.session_slug = "root".into();
        self.placement_picker = None;
        self.close_preview();
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
        } else {
            self.picker = false;
        }
        self.demand();
    }

    pub(crate) fn activate(&mut self, active: bool) {
        if !active {
            self.keep_scroll();
            self.placement_picker = None;
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
                self.picker = false;
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

    pub(crate) fn retained_bytes(&self) -> usize {
        self.reader
            .retained_bytes()
            .saturating_add(self.history.retained_bytes())
    }

    pub(crate) fn draft_bytes(&self) -> usize {
        self.changes.draft.text.len()
    }

    pub(crate) fn evict_inactive_caches(&mut self) -> usize {
        let mut freed = self.reader.retained_bytes();
        if freed > 0 {
            self.reader.clear();
            if self.preview.is_some() {
                self.dirty(&[Lane::Preview]);
            }
        }
        let history_freed = self.history.evict_cached();
        if history_freed > 0 {
            self.dirty(&[Lane::History, Lane::Details]);
            freed = freed.saturating_add(history_freed);
        }
        freed
    }

    #[cfg(test)]
    pub(crate) fn fixture_load_diff(&mut self, path: &str, before: String, after: String) {
        let _ = self.reader.replace(
            codenomad_client::git::Diff::Text { before, after },
            path,
            false,
            &self.images,
        );
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

    pub(super) fn session_checkout_removed(&self) -> bool {
        self.session_slug != "root"
            && self.inventory.as_ref().is_some_and(|inventory| {
                !inventory.trees.is_empty()
                    && !inventory
                        .trees
                        .iter()
                        .any(|tree| tree.slug == self.session_slug)
            })
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
pub(crate) fn probe_observable_error(s: &crate::State) -> Option<String> {
    let ui = s.git.owner.as_ref()?;
    for (name, lane) in request::LANES {
        if let Some(error) = &ui.requests.slot(lane).error {
            return Some(format!("git slot {name}: {}", error.localized()));
        }
    }
    if let Some((false, message)) = &ui.mutation_message {
        return Some(format!("git mutation error: {}", message.localized()));
    }
    None
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) fn probe_slots_diagnostic(s: &crate::State) -> String {
    let Some(ui) = s.git.owner.as_ref() else {
        return "git_owner=None".into();
    };
    let slots = request::LANES
        .iter()
        .map(|(name, lane)| {
            let slot = ui.requests.slot(*lane);
            format!(
                "{name}(busy={},dirty={},err={:?})",
                slot.busy(),
                slot.dirty,
                slot.error.as_ref().map(request::GitMessage::localized)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "online={}, shown={}, mode={:?}, slug={}, session_slug={}, can_change_index={}, can_commit={}, can_place={}, mutation={:?}, mutation_message={:?}, slots=[{slots}]",
        ui.online,
        ui.shown,
        ui.mode,
        ui.slug,
        ui.session_slug,
        ui.can_change_index(),
        ui.can_commit(),
        can_place(s),
        ui.requests.mutation,
        ui.mutation_message
            .as_ref()
            .map(|(ok, message)| (*ok, message.localized()))
    )
}

#[cfg(all(test, feature = "test-support", not(target_arch = "wasm32")))]
impl Ui {
    pub(crate) fn fixture_set_mutation_error(&mut self, message: &str) {
        self.mutation_message = Some((false, GitMessage::Raw(message.into())));
    }

    pub(crate) fn fixture_set_index_stale(&mut self, stale: bool) {
        self.index_checked = if stale {
            None
        } else {
            Some(self.index_revision)
        };
    }

    pub(crate) fn fixture_set_history_dirty(&mut self, dirty: bool) {
        self.requests.slot_mut(Lane::History).dirty = dirty;
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

    pub(crate) fn load_empty_scene(&mut self, state: &str) {
        self.close_preview();
        let error = match state {
            "no-git" => {
                Some("Git is missing from the backend PATH. Restart CodeNomad after changing PATH.")
            }
            "error" if self.mode == Mode::Changes => Some("fixture status refused"),
            "error" => Some("fixture history refused"),
            _ => None,
        };
        if self.mode == Mode::Changes {
            self.changes = Changes::default();
            if let Some(error) = error {
                self.read_failed(
                    Lane::Changes,
                    Refusal::new(500, None, Some(error.into())).into(),
                );
            } else {
                self.accept(
                    Lane::Changes,
                    Value::Changes(vec![], None, self.index_revision),
                );
            }
        } else if self.mode == Mode::History {
            self.history = History::default();
            if let Some(error) = error {
                self.read_failed(
                    Lane::History,
                    Refusal::new(500, None, Some(error.into())).into(),
                );
            } else {
                self.accept(
                    Lane::History,
                    Value::History(
                        Page {
                            head: None,
                            commits: vec![],
                            has_more: false,
                        },
                        false,
                    ),
                );
            }
        }
    }
}
mod settle;
#[cfg(test)]
mod tests;
