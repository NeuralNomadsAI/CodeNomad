use super::{DiffPreferences, Mode, Ui};
use crate::{State, components::diff::DiffState};
use codenomad_client::{backend::Backend, transport::WorkspaceEvent};
use std::{cell::Cell, rc::Rc};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};
type PlacementHolds = HashMap<(String, String), Rc<PlacementHold>>;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PlacementHold {
    pub members: HashSet<String>,
    pub answered: bool,
}

pub(crate) struct Binding {
    pub owner: Option<Ui>,
    pub(super) detached_diff: DiffState,
    pub(super) close: crate::components::window_close_button::WindowCloseState,
    preferences: Rc<Cell<DiffPreferences>>,
    placement_unconfirmed: Rc<RefCell<PlacementHolds>>,
    preview_closed_by_event: bool,
    #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
    pub scene: bool,
}

impl Default for Binding {
    fn default() -> Self {
        Self {
            owner: None,
            detached_diff: DiffState::new(vec![]),
            close: Default::default(),
            preferences: Rc::new(Cell::new(DiffPreferences::default())),
            placement_unconfirmed: Default::default(),
            preview_closed_by_event: false,
            #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
            scene: false,
        }
    }
}

impl Binding {
    pub(crate) fn retained_bytes(&self) -> usize {
        self.owner.as_ref().map_or(0, Ui::retained_bytes)
    }

    pub(crate) fn draft_bytes(&self) -> usize {
        self.owner.as_ref().map_or(0, Ui::draft_bytes)
    }

    pub(crate) fn evict_inactive_caches(&mut self) -> usize {
        self.owner.as_mut().map_or(0, Ui::evict_inactive_caches)
    }

    pub(crate) fn take(binding: &mut Box<Self>) -> Box<Self> {
        let taken = std::mem::take(binding);
        binding.preferences = taken.preferences.clone();
        binding.placement_unconfirmed = taken.placement_unconfirmed.clone();
        taken
    }
}

pub(crate) fn diff_preferences(s: &State) -> DiffPreferences {
    s.git.preferences.get()
}

pub(crate) fn panel_overlay_open(s: &State) -> bool {
    s.git.owner.as_ref().is_some_and(|ui| {
        let picker_visible = ui.picker
            && ui.online
            && ui
                .inventory
                .as_ref()
                .is_some_and(|list| list.trees.iter().any(|tree| !tree.missing));
        let menu_visible = ui.open_menu.is_some() && ui.online;
        ui.shown && (menu_visible || picker_visible)
    })
}

pub(crate) fn overlay_open(s: &State) -> bool {
    s.git
        .owner
        .as_ref()
        .is_some_and(|ui| ui.placement_picker.is_some())
        || panel_overlay_open(s)
}

pub(crate) fn dismiss_panel_overlays(s: &mut State, tx: &mut rune::Tx) {
    super::menu::clear(s, tx);
    if let Some(ui) = &mut s.git.owner {
        ui.picker = false;
    }
}

pub(crate) enum SessionDirectory {
    Root,
    ResolveSession(String),
}

pub(crate) fn session_directory(s: &State) -> SessionDirectory {
    if s.screen.is_launcher() {
        return SessionDirectory::Root;
    }
    let active = crate::workspace::active_session(s)
        .map(str::to_owned)
        .or_else(|| {
            s.git
                .owner
                .as_ref()
                .filter(|owner| !owner.backend.session.is_empty())
                .map(|owner| owner.backend.session.clone())
        });
    active.map_or(SessionDirectory::Root, SessionDirectory::ResolveSession)
}

pub(crate) fn is_composing(s: &State) -> bool {
    s.git
        .owner
        .as_ref()
        .is_some_and(|ui| ui.changes.draft.is_composing() || ui.filter.is_composing())
}

#[cfg(test)]
pub(crate) fn fixture_commit_preedit(s: &mut State, text: &str) {
    if let Some(ui) = &mut s.git.owner {
        ui.changes
            .draft
            .ime(&rune::edit::Ime::Preedit(text.to_owned(), None, Vec::new()));
    }
}

#[cfg(test)]
pub(crate) fn fixture_commit_draft(s: &mut State, text: Option<&str>) -> Option<String> {
    let ui = s.git.owner.as_mut()?;
    if let Some(text) = text {
        ui.changes.draft.replace_text(text);
    }
    Some(ui.changes.draft.text.clone())
}

#[cfg(test)]
pub(crate) fn fixture_open_picker(s: &mut State) {
    if s.git
        .owner
        .as_ref()
        .is_some_and(|ui| ui.inventory.is_none())
    {
        let shown = s.git.owner.as_ref().is_some_and(|ui| ui.shown);
        fixture_worktrees(s);
        if let Some(ui) = s.git.owner.as_mut() {
            ui.shown = shown;
        }
    }
    if let Some(ui) = s.git.owner.as_mut() {
        ui.online = true;
        ui.picker = true;
    }
}

#[cfg(test)]
pub(crate) fn fixture_worktrees(s: &mut State) {
    if let Some(ui) = s.git.owner.as_mut() {
        ui.online = true;
        ui.shown = true;
        ui.inventory = Some(codenomad_client::git::Worktrees {
            repository: codenomad_client::git::Repository::Git,
            trees: vec![
                codenomad_client::git::Worktree {
                    slug: "root".into(),
                    label: None,
                    directory: "D:/repo".into(),
                    service_directory: None,
                    branch: Some("main".into()),
                    head: None,
                    missing: false,
                },
                codenomad_client::git::Worktree {
                    slug: "review".into(),
                    label: None,
                    directory: "D:/repo-review".into(),
                    service_directory: None,
                    branch: Some("feature".into()),
                    head: None,
                    missing: false,
                },
            ],
        });
    }
}

#[cfg(test)]
pub(crate) fn fixture_online(s: &State) -> Option<bool> {
    s.git.owner.as_ref().map(|ui| ui.online)
}

#[cfg(test)]
pub(crate) fn fixture_unstaged_change(s: &mut State, path: &str) {
    if let Some(ui) = s.git.owner.as_mut() {
        ui.changes.replace(
            vec![codenomad_client::git::Status {
                path: path.into(),
                original_path: None,
                staged: None,
                unstaged: Some(codenomad_client::git::Change {
                    kind: "modified".into(),
                    additions: 1,
                    deletions: 0,
                }),
                whitespace_only: false,
            }],
            false,
        );
    }
}

#[cfg(test)]
pub(crate) fn fixture_open_placement_picker(s: &mut State) {
    if let Some(ui) = s.git.owner.as_mut() {
        ui.placement_picker = Some(vec![("review".into(), "review · feature".into())]);
    }
}

pub(crate) fn set_diff_preferences(s: &mut State, preference: DiffPreferences) {
    s.git.preferences.set(preference);
    if let Some(owner) = &mut s.git.owner {
        apply_preference(owner, preference);
    }
}

fn apply_preference(owner: &mut Ui, preference: DiffPreferences) -> bool {
    owner.reader.apply(
        preference,
        owner.preview.as_ref().map(|target| target.path.as_str()),
        owner.hide_whitespace,
    )
}

pub(crate) fn connected(s: &mut State, backend: &Backend) {
    connect(s, backend, None);
}

pub(crate) fn connected_placed(s: &mut State, backend: &Backend, slug: &str) {
    connect(s, backend, Some(slug));
}

fn connect(s: &mut State, backend: &Backend, placement: Option<&str>) {
    if s.git.owner.as_mut().is_some_and(|owner| match placement {
        Some(slug) => owner.bind_placed(backend, Some(slug)),
        None => owner.bind(backend),
    }) {
        sync_files(s);
        return;
    }
    let root = s
        .files
        .as_ref()
        .map(|files| files.tree.directory().into())
        .or_else(|| {
            s.screen
                .launcher()?
                .project
                .as_ref()
                .filter(|project| project.id == backend.workspace)
                .map(|project| project.path.clone())
        });
    let mut owner = Ui::new(backend.clone(), root, s.reads.clone(), s.wake.clone());
    if let Some(slug) = placement {
        owner.bind_placed(backend, Some(slug));
    }
    s.git.owner = Some(owner);
}

pub(crate) fn detach_session(s: &mut State) {
    let backend = s.screen.launcher().and_then(|launcher| {
        let mut backend = launcher.connection.clone()?;
        backend.workspace.clone_from(&launcher.project.as_ref()?.id);
        backend.session.clear();
        Some(backend)
    });
    let is_online = s.screen.launcher().is_some_and(|launcher| {
        launcher
            .project
            .as_ref()
            .is_some_and(|project| launcher.workspace_stream_online_for(&project.id))
    });
    if let Some(files) = &mut s.files {
        files.detach_session();
        files.online(is_online);
    } else if let Some(backend) = &backend {
        crate::files::bind(s, backend);
        if let Some(files) = &mut s.files {
            files.online(is_online);
        }
    }
    if let Some(owner) = &mut s.git.owner {
        owner.detach_session();
        owner.online(is_online);
    } else if let Some(backend) = &backend {
        connected(s, backend);
        online(s, is_online);
        crate::workspace::restore_files_mode(s);
    }
}

pub(crate) fn project_opened(s: &mut State) {
    let Some(mut backend) = s.screen.launcher().and_then(|launcher| {
        let mut backend = launcher.connection.clone()?;
        backend.workspace.clone_from(&launcher.project.as_ref()?.id);
        Some(backend)
    }) else {
        return;
    };
    let stream_online = s
        .screen
        .launcher()
        .is_some_and(|launcher| launcher.workspace_stream_online_for(&backend.workspace));
    backend.session.clear();
    backend.session_directory = None;
    crate::files::bind(s, &backend);
    connected(s, &backend);
    if let Some(files) = &mut s.files {
        files.online(stream_online);
    }
    online(s, stream_online);
}

pub(super) fn sync_files(s: &mut State) {
    if let Some(owner) = &s.git.owner
        && let Some(files) = &mut s.files
    {
        let inventory = owner
            .inventory
            .as_ref()
            .filter(|list| !list.trees.is_empty());
        if files.reader.target().is_some_and(|target| {
            owner.session_checkout_removed()
                || inventory.is_some_and(|list| {
                    !list.trees.iter().any(|tree| {
                        !tree.missing
                            && (codenomad_client::same_server_path(
                                &tree.directory,
                                &target.directory,
                            ) || files.session_preview()
                                && tree.slug == owner.session_slug
                                && tree.service_directory.as_deref().is_some_and(|alias| {
                                    codenomad_client::same_server_path(alias, &target.directory)
                                }))
                    })
                })
        }) {
            files.close_reader();
        }
        if let Some(tree) = owner.tree()
            && !codenomad_client::same_server_path(files.tree.directory(), &tree.directory)
        {
            files.browse(tree.directory.clone());
        }
        files.show(
            owner.shown
                && owner.mode() == Mode::Workspace
                && (inventory.is_none() || owner.tree().is_some()),
        );
    }
}

pub(crate) fn online(s: &mut State, online: bool) {
    if let Some(owner) = &mut s.git.owner {
        owner.online(online);
    }
}

pub(crate) fn event(s: &mut State, event: &WorkspaceEvent) {
    let had_preview = has_preview(s);
    if let Some(owner) = &mut s.git.owner {
        owner.event(event);
    }
    if had_preview && !has_preview(s) {
        s.git.preview_closed_by_event = true;
    }
}

pub(crate) fn poll(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
    let preference = diff_preferences(s);
    let workspace_preview = crate::files::has_preview(s);
    let event_closed = std::mem::take(&mut s.git.preview_closed_by_event);
    let had_preview = has_preview(s) || event_closed;
    let can_place = can_place(s);
    let Some(owner) = &mut s.git.owner else {
        return false;
    };
    owner.workspace_preview = workspace_preview;
    let focus = if owner.shown && owner.mode() == Mode::Changes && owner.requests.has_completion() {
        owner
            .changes
            .focus_order(tx.focused().filter(|key| key.starts_with("git-row-")))
    } else {
        None
    };
    let preference_changed = owner.active && apply_preference(owner, preference);
    let closed_picker = !can_place && owner.placement_picker.take().is_some();
    if closed_picker && owner.active {
        tx.focus_when_shown("composer", tx.focus_visible());
    }
    let changed = owner.poll(now) || preference_changed || closed_picker;
    let change_slot = owner.requests.slot(super::Lane::Changes);
    let parked = if owner.requests.mutation.is_none() && !change_slot.busy() && !change_slot.dirty {
        owner.pending_row_focus.take().filter(|_| {
            owner.active && owner.shown && owner.mode() == Mode::Changes && tx.focused().is_none()
        })
    } else {
        None
    };
    if changed
        && let Some(focus) = focus.or(parked)
        && let Some(next) = owner
            .changes
            .focus_after(focus, !owner.backend.session.is_empty())
    {
        tx.focus(next, tx.focus_visible());
    }
    if let Some(deadline) = owner.passive_due {
        tx.wake_after(std::time::Duration::from_secs_f64(
            (deadline - now).max(0.0),
        ));
    }
    if owner.take_files_invalidation()
        && let Some(files) = &mut s.files
    {
        files.refresh(None);
    }
    if owner.active
        && let Some(sessions) = owner.init_sessions.take()
        && let Some(launcher) = s.screen.launcher_mut()
        && launcher
            .project
            .as_ref()
            .is_some_and(|project| project.id == owner.backend.workspace)
    {
        launcher.sessions = sessions.rows;
        launcher.next = sessions.next;
    }
    let closed_by_event = event_closed && !has_preview(s);
    if changed || closed_by_event {
        sync_files(s);
        tx.instant();
        restore_reading_if_closed(s, had_preview, tx);
    }
    publish_notice(s);
    changed | closed_by_event | super::menu::poll(s, tx)
}

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn poll_notices(s: &mut State, tx: &mut rune::Tx) -> bool {
    let event_closed = std::mem::take(&mut s.git.preview_closed_by_event);
    let had_preview = has_preview(s) || event_closed;
    let changed = s.git.owner.as_mut().is_some_and(Ui::poll_results);
    let closed_by_event = event_closed && !has_preview(s);
    if changed || closed_by_event {
        sync_files(s);
        if s.git.owner.as_ref().is_none_or(|owner| owner.active) {
            tx.instant();
            restore_reading_if_closed(s, had_preview, tx);
        }
    }
    publish_notice(s);
    changed || closed_by_event
}

fn publish_notice(s: &mut State) {
    if let Some((backend, (success, message))) = s.git.owner.as_mut().and_then(|owner| {
        owner
            .mutation_notice
            .take()
            .map(|notice| (owner.backend.clone(), notice))
    }) {
        crate::shell::notifications::emit_from(
            s,
            backend,
            crate::shell::notifications::Category::Files,
            message.localized(),
            !success,
        );
    }
}

pub(crate) fn show(s: &mut State, visible: bool) {
    #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
    if s.git.scene {
        return;
    }
    if let Some(owner) = &mut s.git.owner {
        owner.show(visible);
    }
    sync_files(s);
}

pub(crate) fn mode(s: &State) -> Mode {
    s.git.owner.as_ref().map_or(Mode::Workspace, Ui::mode)
}

pub(crate) fn conversation_checkout(
    s: &State,
    workspace_id: &str,
    project_root: &str,
) -> Option<(String, Option<String>)> {
    if let Some(owner) = &s.git.owner
        && owner.backend.workspace == workspace_id
    {
        if owner.session_checkout_removed() {
            return None;
        }
        if !owner.session_slug.is_empty() {
            if owner.session_slug == "root" {
                return Some(("root".into(), Some(project_root.to_owned())));
            }
            let expected = owner
                .inventory
                .as_ref()
                .and_then(|inv| inv.trees.iter().find(|t| t.slug == owner.session_slug))
                .map(|t| t.directory.clone())
                .or_else(|| {
                    owner
                        .backend
                        .session_directory
                        .as_deref()
                        .filter(|dir| !dir.is_empty())
                        .map(str::to_owned)
                });
            return Some((owner.session_slug.clone(), expected));
        }
    }
    Some(("root".into(), Some(project_root.to_owned())))
}

#[cfg(test)]
mod conversation_checkout_tests {
    use super::conversation_checkout;
    use crate::{backend::Backend, git::Ui, init};
    use codenomad_client::git::{Repository, Worktree, Worktrees};

    #[test]
    fn conversation_checkout_uses_session_slug_not_browsed_git_slug() {
        let mut s = init();
        let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.workspace = "ws-1".into();
        backend.session = "ses-1".into();
        backend.session_directory = Some("/repo-wt-a".into());
        let mut ui = Ui::new(
            backend,
            Some("/repo".into()),
            s.reads.clone(),
            s.wake.clone(),
        );
        ui.session_slug = "wt-a".into();
        ui.slug = "wt-b".into();
        ui.inventory = Some(Worktrees {
            repository: Repository::Git,
            trees: vec![
                Worktree {
                    slug: "root".into(),
                    label: None,
                    directory: "/repo".into(),
                    service_directory: None,
                    branch: Some("main".into()),
                    head: None,
                    missing: false,
                },
                Worktree {
                    slug: "wt-a".into(),
                    label: None,
                    directory: "/repo-wt-a".into(),
                    service_directory: None,
                    branch: Some("feat-a".into()),
                    head: None,
                    missing: false,
                },
                Worktree {
                    slug: "wt-b".into(),
                    label: None,
                    directory: "/repo-wt-b".into(),
                    service_directory: None,
                    branch: Some("feat-b".into()),
                    head: None,
                    missing: false,
                },
            ],
        });
        s.git.owner = Some(ui);

        assert_eq!(
            conversation_checkout(&s, "ws-1", "/repo"),
            Some(("wt-a".into(), Some("/repo-wt-a".into())))
        );
        // Removed conversation worktree refuses opening instead of falling back to root.
        s.git.owner.as_mut().unwrap().session_slug = "wt-gone".into();
        assert_eq!(conversation_checkout(&s, "ws-1", "/repo"), None);
        // Different workspace falls back to root.
        assert_eq!(
            conversation_checkout(&s, "ws-other", "/other"),
            Some(("root".into(), Some("/other".into())))
        );
    }
}

pub(crate) fn files_checkout(s: &State, directory: &str) -> Option<String> {
    let owner = s.git.owner.as_ref()?;
    if let Some(tree) = owner.tree() {
        return codenomad_client::same_server_path(directory, &tree.directory)
            .then(|| tree.slug.clone());
    }
    if owner.slug != "root" {
        return None;
    }
    let project = s.screen.launcher()?.project.as_ref()?;
    codenomad_client::same_server_path(directory, &project.path).then(|| "root".into())
}

pub(crate) fn file_link_scope(s: &State) -> Option<(&Backend, &str)> {
    let owner = s.git.owner.as_ref()?;
    let backend = &owner.backend;
    if backend.session.is_empty()
        || owner.stopped
        || placement_unconfirmed(s)
        || owner.session_checkout_removed()
        || s.workspace.is_some() && crate::workspace::active_session(s) != Some(&backend.session)
    {
        return None;
    }
    let native = backend.session_directory.as_deref()?;
    let host = owner
        .inventory
        .as_ref()
        .and_then(|inventory| {
            inventory
                .trees
                .iter()
                .find(|tree| {
                    !tree.missing
                        && tree.slug == owner.session_slug
                        && tree
                            .service_directory
                            .as_deref()
                            .is_some_and(|path| codenomad_client::same_server_path(path, native))
                })
                .map(|tree| tree.directory.as_str())
        })
        .unwrap_or(native);
    Some((backend, host))
}

pub(crate) fn placement(s: &State) -> Option<&str> {
    s.git
        .owner
        .as_ref()
        .map(|owner| owner.session_slug.as_str())
}

pub(crate) fn can_place(s: &State) -> bool {
    s.phase == crate::Phase::Ready
        && !s.screen.is_launcher()
        && !placement_unconfirmed(s)
        && crate::launcher::can_change_session(s)
        && s.screen
            .launcher()
            .is_some_and(|launcher| !launcher.pending)
        && s.agent
            .as_ref()
            .is_some_and(|agent| !agent.blocked() && !agent.running)
        && s.git.owner.as_ref().is_some_and(|owner| {
            owner.active
                && owner.online
                && !owner.stopped
                && owner.repository() == super::Repository::Git
                && crate::workspace::active_session(s) == Some(owner.backend.session.as_str())
        })
}

pub(crate) fn hold_placement(s: &mut State, hold: PlacementHold) {
    if let Some(owner) = &s.git.owner {
        let hold = Rc::new(hold);
        s.git.placement_unconfirmed.borrow_mut().extend(
            hold.members
                .iter()
                .map(|id| ((owner.backend.base.clone(), id.clone()), hold.clone())),
        );
    }
}

pub(crate) fn placement_unconfirmed(s: &State) -> bool {
    placement_hold(s).is_some()
}

pub(crate) fn placement_hold(s: &State) -> Option<PlacementHold> {
    let owner = s.git.owner.as_ref()?;
    let holds = s.git.placement_unconfirmed.borrow();
    holds
        .get(&(owner.backend.base.clone(), owner.backend.session.clone()))
        .map(|ids| (**ids).clone())
}

pub(crate) fn release_placement(s: &mut State, base: &str, hold: &PlacementHold) {
    if !hold.answered {
        return;
    }
    s.git
        .placement_unconfirmed
        .borrow_mut()
        .retain(|(held_base, id), ids| {
            held_base != base || !hold.members.contains(id) || ids.as_ref() != hold
        });
}

pub(crate) fn placeable(s: &State, slug: &str) -> bool {
    s.git.owner.as_ref().is_some_and(|owner| {
        slug != owner.session_slug
            && owner.inventory.as_ref().is_some_and(|list| {
                list.trees
                    .iter()
                    .any(|tree| tree.slug == slug && !tree.missing)
            })
    })
}

pub(crate) fn set_mode(s: &mut State, mode: Mode) {
    if let Some(owner) = &mut s.git.owner {
        owner.set_mode(mode);
    }
    sync_files(s);
}

pub(crate) fn has_preview(s: &State) -> bool {
    s.git.owner.as_ref().is_some_and(Ui::has_preview)
}

pub(crate) fn close_preview(s: &mut State) {
    s.git.preview_closed_by_event = false;
    if let Some(owner) = &mut s.git.owner {
        owner.close_preview();
    }
}

pub(crate) fn restore_reading_if_closed(s: &mut State, had_preview: bool, tx: &mut rune::Tx) {
    if had_preview
        && !has_preview(s)
        && !s.screen.is_launcher()
        && !crate::files::has_preview(s)
        && s.git.owner.as_ref().is_none_or(|owner| owner.active)
    {
        crate::chat::reading::restore_position(s, tx);
    }
}

#[cfg(test)]
pub(crate) fn fixture_open_preview(s: &mut State) {
    let backend = crate::backend::Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "test".into(),
        session: "s".into(),
        client_id: "c".into(),
        session_directory: None,
        fresh_mode: false,
    };
    let mut owner = Ui::new(
        backend,
        Some("/synthetic".into()),
        s.reads.clone(),
        s.wake.clone(),
    );
    owner.replace_preview(super::preview::Preview {
        source: super::preview::Source::Local(codenomad_client::git::Section::Unstaged),
        path: "diff.rs".into(),
        original_path: None,
    });
    s.git.owner = Some(owner);
}
