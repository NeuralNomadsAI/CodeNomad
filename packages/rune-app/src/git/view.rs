mod diff_view;
mod history;
pub(crate) use diff_view::reader;

use super::{
    Lane, Mode, MutationKind, Preview, Ui,
    changes::{self, SECTIONS},
};
use crate::{
    State,
    strings::{locale, t},
};
use codenomad_client::git::{Repository, Section};
use rune::{El, Tx, col, el, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, field_kit, git_panel as theme,
    git_panel::ButtonLook::{Flat, Neutral, Submit, WithIcon},
    layout::{self, Layout, dark},
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
    let context = theme::context()
        .key("git-context")
        .child(
            layout::action_row()
                .child(theme::branch(branch(ui)).key("git-branch"))
                .child(icon(
                    "git-refresh",
                    &theme::REFRESH_CW,
                    t("instanceShell.rightPanel.actions.refresh"),
                    ui.loading() || !ui.online,
                    None,
                    run(s, |s, _| {
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
                )),
        )
        .child(worktree_picker(ui, width, &mut overlay));
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
    let mode_lanes: &[Lane] = match ui.mode {
        Mode::Workspace => &[Lane::Worktrees],
        Mode::Changes => &[Lane::Worktrees, Lane::Changes, Lane::Preferences],
        Mode::History => &[Lane::Worktrees, Lane::History, Lane::Details],
    };
    for lane in mode_lanes {
        if let Some(error) = &ui.requests.slot(*lane).error {
            panel = panel.child(theme::note(error, "alert"));
        }
    }
    if ui.mode != Mode::Workspace
        && let Some((ok, message)) = &ui.mutation_message
    {
        panel = panel.child(theme::note(message, if *ok { "status" } else { "alert" }));
    }
    let body = if ui.mode == Mode::Workspace {
        workspace
    } else if ui.repository() == Repository::Uninitialized {
        theme::header()
            .child(
                text(t("filesPanel.gitInit.notRepository"))
                    .text_role(TextRole::Small)
                    .wrap(),
            )
            .child(
                button(
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
                .key("git-init"),
            )
    } else if ui.inventory.is_none() || ui.repository() == Repository::NoGit {
        if ui.loading() {
            theme::note(t("instanceInfo.loading"), "status")
        } else {
            el()
        }
    } else {
        match ui.mode {
            Mode::Changes => changes_view(s, ui, width, &mut overlay),
            Mode::History => history::view(s, ui),
            Mode::Workspace => el(),
        }
    };
    theme::dock(theme::with_overlays(panel.child(body), overlay), width)
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

fn worktree_picker(ui: &Ui, width: f32, overlay: &mut Vec<El>) -> El {
    let trees: Vec<_> = ui
        .inventory
        .iter()
        .flat_map(|list| &list.trees)
        .filter(|tree| !tree.missing)
        .map(|tree| {
            let name = basename(&tree.directory);
            let label = if ui.repository() == Repository::Git {
                format!(
                    "{name} · {}",
                    tree.branch
                        .as_deref()
                        .unwrap_or_else(|| t("gitPanel.detached"))
                )
            } else {
                name.into()
            };
            (label, tree.slug.clone())
        })
        .collect();
    let mut labels: Vec<_> = trees.iter().map(|(label, _)| label.clone()).collect();
    let mut seen = std::collections::HashSet::new();
    for (i, label) in labels.iter_mut().enumerate() {
        while !seen.insert(label.clone()) {
            label.push_str(" · ");
            label.push_str(&trees[i].1);
        }
    }
    let current = trees
        .iter()
        .position(|(_, slug)| slug == &ui.slug)
        .and_then(|i| labels.get(i))
        .cloned();
    let choices: Vec<_> = labels
        .iter()
        .cloned()
        .zip(trees.into_iter().map(|(_, slug)| slug))
        .collect();
    let local_scope = ui.scope.clone();
    let close_scope = local_scope.clone();
    let select = move |s: &mut State, label: &str, _: &mut Tx| {
        if !s
            .git
            .owner
            .as_ref()
            .is_some_and(|ui| std::rc::Rc::ptr_eq(&local_scope, &ui.scope))
        {
            return;
        }
        if let Some(ui) = &mut s.git.owner {
            ui.picker = false;
            if let Some((_, slug)) = choices.iter().find(|(v, _)| v == label) {
                ui.select_tree(slug.clone());
            }
        }
        super::binding::sync_files(s);
    };
    theme::worktree_picker(
        &labels,
        current.as_deref(),
        t("gitPanel.worktree"),
        width,
        ui.picker,
        labels.is_empty() || !ui.online,
        {
            let scope = ui.scope.clone();
            move |s: &mut State| {
                if let Some(ui) = &mut s.git.owner
                    && std::rc::Rc::ptr_eq(&scope, &ui.scope)
                {
                    ui.picker = !ui.picker;
                }
            }
        },
        move |s: &mut State| {
            if let Some(ui) = &mut s.git.owner
                && std::rc::Rc::ptr_eq(&close_scope, &ui.scope)
            {
                ui.picker = false;
            }
        },
        select,
        overlay,
    )
}

fn changes_view(s: &State, ui: &Ui, width: f32, overlay: &mut Vec<El>) -> El {
    let mut body = theme::saved_scroll::<State>("git-changes-body", &ui.changes_scroll)
        .on_drawn_layout_tx(action(s, |s, bounds, _| {
            if let Some(ui) = &mut s.git.owner {
                ui.body_bounds = bounds;
            }
        }));
    let status = ui.requests.slot(Lane::Changes);
    if ui.changes.count() == 0 && (ui.loading() || ui.changes.ready() && status.error.is_none()) {
        body = body.child(theme::note(
            t(if ui.loading() {
                "instanceInfo.loading"
            } else {
                "instanceShell.gitChanges.empty"
            }),
            "status",
        ));
    }
    if ui.backend.session.is_empty() {
        body = body.child(theme::note(
            t("instanceShell.gitChanges.noSessionSelected"),
            "status",
        ));
    }
    for section in SECTIONS {
        let i = changes::index(section);
        let count = ui.changes.section(section).count();
        let open = ui.changes.open[i];
        let name = section_label(section);
        let mut group = theme::section()
            .key(section.key())
            .role("group")
            .label(name)
            .on_drawn_layout_tx(action(s, move |s, bounds, _| {
                if let Some(ui) = &mut s.git.owner {
                    ui.zones[i] = bounds;
                }
            }))
            .child(
                theme::section_button(
                    name,
                    count,
                    open,
                    handler(s, move |ui, _| ui.changes.open[i] = !ui.changes.open[i]),
                )
                .key(format!("git-section-{}", section.key())),
            );
        if open {
            if section == Section::Staged {
                group = group.child(commit_box(s, ui));
            }
            let mut visible = 0;
            for entry in ui.changes.visible(section) {
                visible += 1;
                group = group.child(file_row(s, ui, entry, width, overlay));
            }
            let hidden = count - visible;
            if hidden > 0 {
                let label = numbered(
                    if hidden == 1 {
                        "instanceShell.gitChanges.hiddenRows.one"
                    } else {
                        "instanceShell.gitChanges.hiddenRows.other"
                    },
                    hidden,
                );
                group = group.child(
                    layout::action_row()
                        .pad(Space::Xs)
                        .child(text(label).text_role(TextRole::Label))
                        .child(
                            button(
                                s,
                                numbered(
                                    "instanceShell.gitChanges.hiddenRows.show",
                                    hidden.min(changes::ROW_LIMIT),
                                ),
                                Neutral,
                                false,
                                move |ui, tx| {
                                    if let Some(first) = ui.changes.show_more(section) {
                                        tx.focus(first.key(), tx.focus_visible());
                                    }
                                },
                            )
                            .key(format!("git-reveal-{}", section.key())),
                        ),
                );
            }
        }
        body = body.child(group);
    }
    body
}

fn commit_box(s: &State, ui: &Ui) -> El {
    let mut group = theme::header().role("group").label(t("gitPanel.actions"));
    for section in SECTIONS {
        let actions = ui.changes.action_rows(section);
        if let Some(first) = actions.first() {
            let target = first.id.clone();
            let name = if actions.len() == 1 {
                format!("{} · {}", stage_label(section), target.path)
            } else {
                numbered(
                    if section == Section::Staged {
                        "instanceShell.gitChanges.actions.unstageSelected"
                    } else {
                        "instanceShell.gitChanges.actions.stageSelected"
                    },
                    actions.len(),
                )
            };
            group = group.child(
                button(s, name, Flat, !ui.can_change_index(), move |ui, tx| {
                    ui.move_paths(&target, tx.focused())
                })
                .key(format!("git-bulk-{}", section.key())),
            );
        }
    }
    let label = t("instanceShell.gitChanges.commit.placeholder");
    group.child(
        layout::action_row()
            .child(
                theme::commit_message(
                    &ui.changes.draft,
                    label,
                    edit(s, |ui| &mut ui.changes.draft),
                )
                .key("git-commit-message"),
            )
            .child(
                button(
                    s,
                    t(if ui.requests.mutation == Some(MutationKind::Commit) {
                        "instanceShell.gitChanges.commit.submitting"
                    } else {
                        "instanceShell.gitChanges.commit.submit"
                    }),
                    Submit,
                    !ui.can_commit(),
                    |ui, _| ui.commit(),
                )
                .key("git-commit"),
            ),
    )
}

fn file_row(s: &State, ui: &Ui, entry: &changes::Row, width: f32, overlay: &mut Vec<El>) -> El {
    let id = entry.id.clone();
    let key = id.key();
    let selected = ui.changes.is_selected(&id);
    let selection_id = id.clone();
    let drag_id = id.clone();
    let disabled = ui.backend.session.is_empty();
    let target = Preview::local(entry);
    let active = ui.preview.as_ref() == Some(&target);
    let letter = entry
        .change
        .kind
        .chars()
        .next()
        .map(|ch| ch.to_ascii_uppercase().to_string())
        .unwrap_or_default();
    let path = id.path.clone();
    let (plus, minus) = (entry.change.additions, entry.change.deletions);
    let main = theme::file(
        path.clone(),
        letter,
        Some((plus, minus)),
        path,
        disabled,
        selected,
        handler(s, move |ui, tx| {
            let mods = tx.mods();
            ui.changes
                .select(selection_id.clone(), mods.primary(), mods.shift);
        }),
    )
    .key(&key);
    let main = if !disabled {
        theme::with_file_drop(
            main,
            action(s, move |s, point, tx| {
                if let Some(ui) = &mut s.git.owner {
                    let other = 1 - changes::index(drag_id.section);
                    if inside(point, ui.body_bounds) && inside(point, ui.zones[other]) {
                        ui.move_paths(&drag_id, tx.focused());
                    }
                }
            }),
        )
    } else {
        main
    };
    let stage = format!("{} · {}", stage_label(id.section), id.path);
    let action_id = id.clone();
    let action = run(s, move |s, tx| {
        if let Some(ui) = &mut s.git.owner {
            ui.move_paths(&action_id, tx.focused());
        }
    });
    let stage =
        if ui.open_menu.as_ref() == Some(&id) || theme::compact_file_actions(width, &id.path) {
            let (trigger, menu) = super::menu::control(ui, &id, width, &stage, action);
            overlay.extend(menu);
            trigger
        } else {
            icon(
                &id.action_key("stage"),
                if id.section == Section::Staged {
                    &theme::MINUS
                } else {
                    &theme::PLUS
                },
                stage,
                !ui.can_change_index(),
                None,
                action,
            )
        };
    theme::file_row(selected)
        .key(id.action_key("container"))
        .child(main)
        .child(preview_button(
            s,
            &id.action_key("preview"),
            target,
            disabled,
            active,
        ))
        .child(stage)
}

fn inside([x, y]: [f32; 2], [left, top, w, h]: [f32; 4]) -> bool {
    x >= left && x < left + w && y >= top && y < top + h
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
        run(s, move |s, _| {
            if s.git
                .owner
                .as_mut()
                .is_some_and(|ui| ui.toggle_preview(target.clone()))
                && let Some(files) = &mut s.files
            {
                files.close_reader();
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

pub(super) fn section_label(section: Section) -> &'static str {
    t(if section == Section::Staged {
        "instanceShell.gitChanges.sections.staged"
    } else {
        "instanceShell.gitChanges.sections.unstaged"
    })
}

fn stage_label(section: Section) -> &'static str {
    t(if section == Section::Staged {
        "instanceShell.gitChanges.actions.unstage"
    } else {
        "instanceShell.gitChanges.actions.stage"
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
