mod changes_panel;
mod detail;
mod diff_view;
mod history;
mod worktrees;
pub(crate) use diff_view::reader;
pub(crate) use worktrees::session_worktree;

use super::{Lane, Mode, MutationKind, Preview, Ui};
use crate::{
    State,
    strings::{locale, t},
};
use codenomad_client::git::{Repository, Section};
use rune::{El, Tx, col, el, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    git_panel::ButtonLook::{Neutral, WithIcon},
    layout::{self, Layout},
};

const MODES: [Mode; 3] = [Mode::Workspace, Mode::Changes, Mode::History];
const MODE_NAMES: [&str; 3] = [
    "filesPanel.workspace",
    "gitPanel.changes",
    "filesPanel.commits",
];

pub(crate) fn panel(s: &State, width: f32, workspace: El) -> El {
    let Some(ui) = &s.git.owner else {
        return workspace;
    };
    let title = t("instanceShell.rightPanel.tabs.files");
    let mode = MODES.iter().position(|mode| *mode == super::mode(s));
    let set_mode = action(s, move |s, i, _| {
        if let Some(mode) = MODES.get(i).copied() {
            super::set_mode(s, mode);
        }
    });
    let selector =
        theme::fit_modes(&MODE_NAMES.map(t), title, mode, width, set_mode).key("git-mode");
    let mut overlay = Vec::new();
    let can_retry_detached =
        !ui.online && crate::launcher::can_retry_detached_workspace(s, ui.workspace_id());
    let context = theme::context()
        .key("git-context")
        .child(
            layout::action_row()
                .child(theme::branch(branch(ui)).key("git-branch"))
                .child(
                    theme::header_icon_button(
                        &theme::REFRESH_CW,
                        t("instanceShell.rightPanel.actions.refresh"),
                        ui.loading() || (!ui.online && !can_retry_detached),
                        None,
                        run(s, |s, _| {
                            if s.git.owner.as_ref().is_some_and(|ui| {
                                !ui.online
                                    && crate::launcher::can_retry_detached_workspace(
                                        s,
                                        ui.workspace_id(),
                                    )
                            }) {
                                crate::launcher::retry_detached_reconcile(s);
                                return;
                            }
                            if let Some(ui) = &mut s.git.owner {
                                ui.refresh();
                            }
                            if let Some(files) = &mut s.files
                                && s.git
                                    .owner
                                    .as_ref()
                                    .is_some_and(|g| g.mode == Mode::Workspace)
                            {
                                files.refresh(None);
                            }
                        }),
                    )
                    .key("git-refresh"),
                ),
        )
        .child(worktrees::browse(ui, width, &mut overlay));
    let mut tools = theme::tools().key("git-tools").child(selector);
    if ui.mode == Mode::Changes && ui.changes.ready() {
        tools = tools.child(theme::count(file_count(ui.changes.count())).key("git-count"));
    }
    let mut panel = theme::panel()
        .key("git-panel")
        .role("region")
        .label(title)
        .child(context)
        .child(tools);
    let mode_lanes: &[Lane] = if ui.repository() == Repository::Uninitialized {
        &[Lane::Worktrees]
    } else {
        match ui.mode {
            Mode::Workspace => &[Lane::Worktrees],
            Mode::Changes => &[Lane::Worktrees, Lane::Changes, Lane::Preferences],
            Mode::History => &[Lane::Worktrees, Lane::History, Lane::Details],
        }
    };
    for lane in mode_lanes {
        if let Some(error) = &ui.requests.slot(*lane).error {
            panel = panel.child(
                theme::note(error.localized(), "alert")
                    .key(format!("git-error-{}", lane_key(*lane))),
            );
        }
    }
    if ui.mode != Mode::Workspace
        && let Some((ok, message)) = &ui.mutation_message
    {
        panel = panel.child(
            theme::note(message.localized(), if *ok { "status" } else { "alert" })
                .key("git-mutation-message"),
        );
    }
    if ui.backend.session.is_empty() {
        panel = panel.child(
            theme::note(t("instanceShell.gitChanges.noSessionSelected"), "status")
                .key("git-no-session"),
        );
    }
    let body = if ui.mode == Mode::Workspace {
        workspace
    } else if ui.repository() == Repository::Uninitialized {
        let mut init = button(
            s,
            t(if ui.requests.mutation == Some(MutationKind::Init) {
                "filesPanel.gitInit.pending"
            } else {
                "filesPanel.gitInit.action"
            }),
            WithIcon(&theme::BRANCH),
            !ui.can_mutate(),
            |ui, _| ui.initialize(),
        )
        .key("git-init");
        if let Some(directory) = ui.tree().map(|tree| tree.directory.as_str()) {
            init = init.help(directory).description(directory);
        }
        col()
            .full_width()
            .key("git-init-empty")
            .child(
                theme::note(t("filesPanel.gitInit.notRepository"), "status").key("git-init-note"),
            )
            .child(layout::action_row().pad(Space::Md).child(init))
    } else {
        match ui.mode {
            Mode::Changes => changes_panel::view(s, ui, width, &mut overlay),
            Mode::History if ui.history.selected.is_some() => detail::view(s, ui),
            Mode::History => history::view(s, ui),
            Mode::Workspace => el(),
        }
    };
    theme::dock(theme::with_overlays(panel.child(body), overlay), width)
}

fn lane_key(lane: Lane) -> &'static str {
    match lane {
        Lane::Worktrees => "worktrees",
        Lane::Changes => "changes",
        Lane::Preferences => "preferences",
        Lane::History => "history",
        Lane::Details => "details",
        Lane::Preview => "preview",
        Lane::InitSessions => "init-sessions",
    }
}

fn branch(ui: &Ui) -> String {
    if matches!(
        ui.repository(),
        Repository::Uninitialized | Repository::NoGit
    ) {
        return ui
            .tree()
            .map(|tree| basename(&tree.directory))
            .unwrap_or_default()
            .into();
    }
    ui.tree()
        .and_then(|t| t.branch.as_deref())
        .unwrap_or_else(|| t("gitPanel.detached"))
        .into()
}

fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|v| !v.is_empty())
        .unwrap_or(path)
}

pub(super) fn preview_button(
    s: &State,
    key: &str,
    target: Preview,
    disabled: bool,
    active: bool,
) -> El {
    icon(
        key,
        &theme::EYE,
        format!("{} · {}", t("filesPanel.viewer"), target.path),
        disabled,
        Some(active),
        run(s, move |s, tx| {
            let was_open = crate::git::has_preview(s);
            let opened = s
                .git
                .owner
                .as_mut()
                .is_some_and(|ui| ui.toggle_preview(target.clone()));
            if opened || was_open != crate::git::has_preview(s) {
                s.notifications.supersede_navigation();
            }
            if opened {
                if let Some(files) = &mut s.files {
                    files.close_reader();
                }
                crate::workspace::close_mission_reader(s);
            } else {
                crate::git::restore_reading_if_closed(s, was_open, tx);
            }
        }),
    )
}

pub(super) fn icon(
    key: &str,
    glyph: &'static theme::Glyph,
    name: impl Into<String>,
    disabled: bool,
    active: Option<bool>,
    press: impl Fn(&mut State, &mut Tx) + 'static,
) -> El {
    theme::icon_button(glyph, name, disabled, active, press).key(key)
}

pub(super) fn reveal_row_actions_at_rest(s: &State) -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
        || s.shell.has_floating()
        || (s.shell.width() > 0.0 && s.shell.width() < 768.0)
}

pub(super) fn section_label(section: Section) -> &'static str {
    t(if section == Section::Staged {
        "instanceShell.gitChanges.sections.staged"
    } else {
        "instanceShell.gitChanges.sections.unstaged"
    })
}

pub(super) fn file_count(count: usize) -> String {
    numbered(
        if count == 1 {
            "gitPanel.files.one"
        } else {
            "gitPanel.files.other"
        },
        count,
    )
}

fn numbered(key: &str, count: usize) -> String {
    catalogue::format(locale(), key, &[("count", &count.to_string())])
}

fn action<A>(
    s: &State,
    press: impl Fn(&mut State, A, &mut Tx) + Clone + 'static,
) -> impl Fn(&mut State, A, &mut Tx) + Clone + 'static {
    let root = s.input_scope.clone();
    let git = s.git.owner.as_ref().map(|ui| ui.scope.clone());
    move |s, value, tx| {
        if s.current_scope(&root)
            && s.git
                .owner
                .as_ref()
                .zip(git.as_ref())
                .is_some_and(|(ui, scope)| std::rc::Rc::ptr_eq(&ui.scope, scope))
        {
            press(s, value, tx);
        }
    }
}

fn run(
    s: &State,
    press: impl Fn(&mut State, &mut Tx) + Clone + 'static,
) -> impl Fn(&mut State, &mut Tx) + Clone + 'static {
    let checked = action(s, move |s, (), tx| press(s, tx));
    move |s, tx| checked(s, (), tx)
}

fn edit(
    s: &State,
    lens: fn(&mut Ui) -> &mut rune::edit::TextEdit,
) -> impl Fn(&mut State) -> &mut rune::edit::TextEdit + 'static {
    let root = s.input_scope.clone();
    let git = s.git.owner.as_ref().map(|ui| ui.scope.clone());
    move |s| {
        if s.current_scope(&root)
            && let Some(ui) = &mut s.git.owner
            && git
                .as_ref()
                .is_some_and(|scope| std::rc::Rc::ptr_eq(&ui.scope, scope))
        {
            return lens(ui);
        }
        s.rejected_edit = rune::edit::TextEdit::new("");
        &mut s.rejected_edit
    }
}

fn button(
    s: &State,
    label: impl Into<String>,
    look: theme::ButtonLook,
    disabled: bool,
    press: impl Fn(&mut Ui, &mut Tx) + Clone + 'static,
) -> El {
    theme::button(label, look, disabled, handler(s, press))
}

fn handler(
    s: &State,
    press: impl Fn(&mut Ui, &mut Tx) + Clone + 'static,
) -> impl Fn(&mut State, &mut Tx) + Clone + 'static {
    run(s, move |s, tx| {
        if let Some(ui) = &mut s.git.owner {
            press(ui, tx);
        }
    })
}
