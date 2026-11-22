use super::{Mode, Ui, panel, reader};
use crate::{State, strings::t};
use codenomad_client::{backend::Backend, transport::WorkspaceEvent};
use rune::{El, row};
use rune_theme_codenomad::{git_diff::DiffState, git_panel, layout::Layout};

pub(crate) struct Binding {
    pub owner: Option<Ui>,
    pub(super) detached_diff: DiffState,
    pub(super) close: crate::components::window_close_button::WindowCloseState,
    width: f32,
}

impl Default for Binding {
    fn default() -> Self {
        Self {
            owner: None,
            detached_diff: DiffState::new(vec![]),
            close: Default::default(),
            width: rune_theme_codenomad::layout::initial_window().0,
        }
    }
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
        files.show(owner.shown && owner.mode() == Mode::Workspace);
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
    let changed = owner.poll(now);
    if changed
        && let Some(focus) = focus
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
    changed
}

pub(crate) fn toggle(s: &State) -> El {
    let Some(owner) = &s.git.owner else {
        return rune::el();
    };
    view_button(s, owner.shown)
}

pub(crate) fn show(s: &mut State, visible: bool) {
    if let Some(owner) = &mut s.git.owner {
        owner.show(visible);
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

fn view_button(s: &State, shown: bool) -> El {
    let scope = s.input_scope.clone();
    crate::components::button(
        "files-panel-toggle",
        t("instanceShell.rightPanel.tabs.files"),
        false,
        crate::screen::action(&scope, |s| {
            show(s, !s.git.owner.as_ref().is_some_and(|owner| owner.shown));
        }),
    )
    .expanded(shown)
}

// The shell owns the transcript/composer and supplies the Workspace body.
pub(crate) fn surface(s: &State, conversation: El, footer: El) -> El {
    let Some(owner) = &s.git.owner else {
        return rune::col()
            .full_width()
            .remaining()
            .child(conversation)
            .child(footer);
    };
    let content = if has_preview(s) {
        reader(s)
    } else {
        conversation
    };
    let center = git_panel::conversation_column()
        .child(content.remaining())
        .child(footer);
    if !owner.shown {
        return center.full_width();
    }
    let width = git_panel::dock_width(s.git.width);
    row()
        .full_width()
        .full_height()
        .remaining()
        .key("git-surface")
        .on_layout(|s: &mut State, [_, _, width, _]| s.git.width = width)
        .child(center)
        .child(panel(s, width, rune::el()))
}
