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
            #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
            scene: false,
        }
    }
}

impl Binding {
    pub(crate) fn take(binding: &mut Self) -> Self {
        let taken = std::mem::take(binding);
        binding.preferences = taken.preferences.clone();
        binding.placement_unconfirmed = taken.placement_unconfirmed.clone();
        taken
    }
}

pub(crate) fn diff_preferences(s: &State) -> DiffPreferences {
    s.git.preferences.get()
}

pub(crate) fn overlay_open(s: &State) -> bool {
    s.git.owner.as_ref().is_some_and(|ui| {
        ui.placement_picker.is_some() || (ui.shown && (ui.open_menu.is_some() || ui.picker))
    })
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
    if let Some(ui) = s.git.owner.as_mut() {
        ui.picker = true;
    }
}

#[cfg(test)]
pub(crate) fn fixture_online(s: &State) -> Option<bool> {
    s.git.owner.as_ref().map(|ui| ui.online)
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
    let stream_online = s
        .screen
        .launcher()
        .is_some_and(crate::launcher::Launcher::workspace_stream_online);
    let backend = s.screen.launcher().and_then(|launcher| {
        let mut backend = launcher.connection.clone()?;
        backend.workspace.clone_from(&launcher.project.as_ref()?.id);
        backend.session.clear();
        Some(backend)
    });
    let is_online = backend.is_some() && stream_online;
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
    backend.session.clear();
    backend.session_directory = None;
    crate::files::bind(s, &backend);
    connected(s, &backend);
    if let Some(files) = &mut s.files {
        files.online(true);
    }
    online(s, true);
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
    if let Some(owner) = &mut s.git.owner {
        owner.event(event);
    }
}

pub(crate) fn poll(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
    let preference = diff_preferences(s);
    let workspace_preview = crate::files::has_preview(s);
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
    if changed {
        sync_files(s);
        tx.instant();
    }
    publish_notice(s);
    changed | super::menu::poll(s, tx)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn poll_notices(s: &mut State) -> bool {
    let changed = s.git.owner.as_mut().is_some_and(Ui::poll_results);
    publish_notice(s);
    changed
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
            message,
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
    if let Some(owner) = &mut s.git.owner {
        owner.close_preview();
    }
}
