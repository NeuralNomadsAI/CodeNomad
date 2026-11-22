use super::{DiffPreferences, Mode, Ui};
use crate::{State, components::diff::DiffState};
use codenomad_client::{backend::Backend, transport::WorkspaceEvent};
use std::{cell::Cell, rc::Rc};

pub(crate) struct Binding {
    pub owner: Option<Ui>,
    pub(super) detached_diff: DiffState,
    pub(super) close: crate::components::window_close_button::WindowCloseState,
    preferences: Rc<Cell<DiffPreferences>>,
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
            #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
            scene: false,
        }
    }
}

impl Binding {
    pub(crate) fn take(binding: &mut Self) -> Self {
        let taken = std::mem::take(binding);
        binding.preferences = taken.preferences.clone();
        taken
    }
}

pub(crate) fn diff_preferences(s: &State) -> DiffPreferences {
    s.git.preferences.get()
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
    if s.git
        .owner
        .as_mut()
        .is_some_and(|owner| owner.bind(backend))
    {
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
    s.git.owner = Some(Ui::new(
        backend.clone(),
        root,
        s.reads.clone(),
        s.wake.clone(),
    ));
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
        let visible = owner.shown && owner.mode() == Mode::Workspace;
        if files.panel != visible {
            files.show(visible);
        }
        if let Some(tree) = owner.tree()
            && !codenomad_client::same_server_path(files.tree.directory(), &tree.directory)
        {
            files.tree.switch(tree.directory.clone());
            files.refresh(None);
        }
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
    let Some(owner) = &mut s.git.owner else {
        return false;
    };
    let focus = if owner.shown && owner.mode() == Mode::Changes && owner.requests.has_completion() {
        owner
            .changes
            .focus_order(tx.focused().filter(|key| key.starts_with("git-row-")))
    } else {
        None
    };
    let preference_changed = owner.active && apply_preference(owner, preference);
    let changed = owner.poll(now) || preference_changed;
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
        && let Some(next) = owner.changes.focus_after(focus)
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
    changed | super::menu::poll(s, tx)
}

pub(crate) fn show(s: &mut State, visible: bool) {
    if let Some(owner) = &mut s.git.owner {
        owner.show(visible);
    }
    sync_files(s);
}

pub(crate) fn mode(s: &State) -> Mode {
    s.git.owner.as_ref().map_or(Mode::Workspace, Ui::mode)
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
