use super::*;
use crate::git::{
    changes::{self, SECTIONS},
    menu,
};

pub(super) fn view(s: &State, ui: &Ui, width: f32, overlay: &mut Vec<El>) -> El {
    let mut body = theme::saved_scroll::<State>("git-changes-body", &ui.changes_scroll)
        .on_drawn_layout_tx(action(s, |s, bounds, _| {
            if let Some(ui) = &mut s.git.owner {
                ui.body_bounds = bounds;
            }
        }));
    let status = ui.requests.slot(Lane::Changes);
    if ui.changes.count() == 0 && (ui.loading() || ui.changes.ready() && status.error.is_none()) {
        let (key, label) = if ui.loading() {
            ("git-changes-loading", "instanceInfo.loading")
        } else {
            ("git-changes-empty", "instanceShell.gitChanges.empty")
        };
        body = body.child(theme::note(t(label), "status").key(key));
    }
    for (pos, section) in SECTIONS.iter().copied().enumerate() {
        let last = pos + 1 == SECTIONS.len();
        let i = changes::index(section);
        let count = ui.changes.section(section).count();
        let open = ui.changes.open[i];
        let name = section_label(section);
        let mut group = theme::section(last)
            .key(section.key())
            .role("group")
            .label(name)
            .on_drawn_layout_tx(action(s, move |s, bounds, _| {
                if let Some(ui) = &mut s.git.owner {
                    ui.zones[i] = bounds;
                }
            }))
            .child(
                theme::change_section_button(
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
                        .key(format!("git-hidden-{}", section.key()))
                        .pad(Space::Sm)
                        .inset_surface()
                        .child(theme::count(label))
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
    let mut group = theme::commit_box()
        .key("git-commit-box")
        .role("group")
        .label(t("gitPanel.actions"));
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
            let help = actions
                .iter()
                .map(|row| row.id.path.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            group = group.child(
                theme::panel_more_button(
                    name,
                    Some(help),
                    !ui.can_change_index(),
                    handler(s, move |ui, tx| ui.move_paths(&target, tx.focused())),
                )
                .key(format!("git-bulk-{}", section.key())),
            );
        }
    }
    let label = t("instanceShell.gitChanges.commit.placeholder");
    let submit_label = t(if ui.requests.mutation == Some(MutationKind::Commit) {
        "instanceShell.gitChanges.commit.submitting"
    } else {
        "instanceShell.gitChanges.commit.submit"
    });
    group.child(theme::commit_input(
        &ui.changes.draft,
        label,
        edit(s, |ui| &mut ui.changes.draft),
        submit_label,
        !ui.can_commit(),
        handler(s, |ui, _| ui.commit()),
    ))
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
    let main = theme::file_item(
        path.clone(),
        letter,
        false,
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
            let (trigger, menu) = menu::control(ui, &id, width, &stage, action);
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
    let reveal = reveal_row_actions_at_rest(s) || active || ui.open_menu.as_ref() == Some(&id);
    theme::file_row(selected)
        .key(id.action_key("container"))
        .child(main)
        .child(
            theme::file_row_actions(reveal)
                .key(id.action_key("actions"))
                .child(preview_button(
                    s,
                    &id.action_key("preview"),
                    target,
                    disabled,
                    active,
                ))
                .child(stage),
        )
}

fn inside([x, y]: [f32; 2], [left, top, w, h]: [f32; 4]) -> bool {
    x >= left && x < left + w && y >= top && y < top + h
}

fn stage_label(section: Section) -> &'static str {
    t(if section == Section::Staged {
        "instanceShell.gitChanges.actions.unstage"
    } else {
        "instanceShell.gitChanges.actions.stage"
    })
}
