use super::{
    directory::{Kind, Panel, title},
    reader::ReaderTarget,
    task_rows::OpenTask,
};
use crate::strings::{locale, t};
use codenomad_client::missions::{RunState, Status};
use rune::{El, Tx, col, edit::TextEdit, row, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, field_kit, git_panel as theme,
    layout::{self, Layout},
    shell,
};
use std::rc::Rc;

type Owner<S> = fn(&mut S) -> (Option<&mut Panel>, &mut TextEdit);

pub(super) struct Scoped<S> {
    owner: Owner<S>,
    scope: std::rc::Rc<()>,
}

impl<S> Clone for Scoped<S> {
    fn clone(&self) -> Self {
        Self {
            owner: self.owner,
            scope: self.scope.clone(),
        }
    }
}

impl<S> Scoped<S> {
    pub(super) fn get<'a>(&self, state: &'a mut S) -> (Option<&'a mut Panel>, &'a mut TextEdit) {
        let (panel, fallback) = (self.owner)(state);
        (
            panel.filter(|panel| std::rc::Rc::ptr_eq(&panel.scope, &self.scope)),
            fallback,
        )
    }
}

/// Panel content only. The Shell owns its occurrence, visibility and mounting.
#[cfg(test)]
pub(crate) fn panel<S: 'static>(ui: &Panel, owner: Owner<S>) -> El {
    panel_body(ui, owner, rune::el(), None, |_, _| {})
}

pub(crate) fn panel_body<S: 'static>(
    ui: &Panel,
    owner: Owner<S>,
    actions: El,
    open_task: Option<OpenTask<S>>,
    on_reader_open: fn(&mut S, &mut Tx),
) -> El {
    let heading = t("missions.control.mapLabel");
    let search = t("missionsPanel.picker.search");
    let partial = ui.has_more(Kind::Summaries);
    let scoped = Scoped {
        owner,
        scope: ui.scope.clone(),
    };
    let mut list = col().full_width().role("list").label(heading);
    let mut shown = false;
    for item in ui.shown_rows() {
        shown = true;
        let id = item.id.clone();
        let eye_id = item.id.clone();
        let name = title(item);
        let selected = ui.selected.as_deref() == Some(&id);
        let active_eye = ui.reader.is_overview_open(&id);
        let scoped_row = scoped.clone();
        let scoped_eye = scoped.clone();
        list = list.child(
            row()
                .full_width()
                .key(format!("mission-row-container-{}", item.id))
                .child(
                    shell::session_row(name, selected, false, move |state, tx| {
                        if let Some(panel) = scoped_row.get(state).0 {
                            panel.select(&id);
                            tx.instant();
                        }
                    })
                    .remaining()
                    .key(format!("mission-row-{}", item.id))
                    .description(status(item.status, item.run_state)),
                )
                .child(
                    theme::icon_button(
                        &theme::EYE,
                        format!("{} · {name}", t("missionsPanel.overview")),
                        false,
                        Some(active_eye),
                        move |state, tx| {
                            if let Some(panel) = scoped_eye.get(state).0 {
                                let eye_key = format!("mission-row-eye-{eye_id}");
                                if panel.toggle_overview(&eye_id) {
                                    panel.reader.set_return_focus(
                                        tx.focused().unwrap_or(&eye_key).to_owned(),
                                    );
                                    on_reader_open(state, tx);
                                    tx.focus("mission-reader-close", tx.focus_visible());
                                } else if let Some(back) = panel.reader.take_return_focus() {
                                    tx.focus(back, tx.focus_visible());
                                }
                                tx.instant();
                            }
                        },
                    )
                    .key(format!("mission-row-eye-{}", item.id)),
                ),
        );
    }
    let mut body = theme::scroll().child(list);
    if ui.covered(Kind::Summaries) && !shown {
        let key = if ui.summaries.is_empty() {
            "missions.control.empty.title"
        } else {
            "missionsPanel.picker.noMatch"
        };
        body = body.child(theme::note(t(key), "status"));
    }
    body = body.child(page_footer(ui, scoped.clone(), Kind::Summaries));
    if ui.selected.is_some() {
        if ui.detail.snapshot.is_some() {
            let owner = scoped.clone();
            body = body.child(ui.observation.view(move |state| {
                if let Some(panel) = owner.get(state).0 {
                    panel.observation.more();
                }
            }));
        }
        body = body.child(actions).child(detail(
            ui,
            scoped.clone(),
            open_task.clone(),
            on_reader_open,
        ));
    }
    body = body.child(super::calendars::view(ui, scoped.clone(), open_task));
    if !ui.cleanups.is_empty() {
        body = body.child(
            text(t("missions.progress.cleanupHistory"))
                .text_role(TextRole::Small)
                .pad(Space::Sm)
                .role("heading"),
        );
        for cleanup in &ui.cleanups {
            let counts = catalogue::format(
                locale(),
                "missions.cleanup.counts",
                &[
                    ("removed", &cleanup.removed.to_string()),
                    ("retained", &cleanup.retained.to_string()),
                    ("pending", &cleanup.pending.to_string()),
                ],
            );
            let mut row = col()
                .full_width()
                .pad(Space::Sm)
                .key(format!(
                    "mission-cleanup-{}-{}",
                    cleanup.mission_id, cleanup.deletion_id
                ))
                .child(
                    text(&cleanup.objective)
                        .text_role(TextRole::Small)
                        .wrap_anywhere(),
                )
                .child(text(counts).text_role(TextRole::Small).wrap_anywhere());
            if cleanup.document_pending == Some(true) {
                row = row.child(theme::note(t("missions.cleanup.documentPending"), "status"));
            }
            body = body.child(row);
        }
    }
    body = body.child(page_footer(ui, scoped.clone(), Kind::Cleanups));
    let refresh = scoped.clone();
    let mut field = layout::hinted_field(&ui.filter, search)
        .label(search)
        .input_mode(rune::InputMode::Search);
    if partial {
        field = field.description(t("missionsPanel.pages.searchLoaded"));
    }
    let field = field
        .on_edit(move |s: &mut S| {
            let (panel, fallback) = scoped.get(s);
            panel.map_or(fallback, |panel| &mut panel.filter)
        })
        .build(&field_kit(layout::dark()))
        .key("missions-search");
    let field = if partial {
        field.help(t("missionsPanel.pages.searchLoaded"))
    } else {
        field
    };
    theme::panel()
        .key("missions-panel")
        .role("region")
        .label(heading)
        .child(
            theme::header()
                .child(
                    layout::action_row()
                        .child(shell::panel_title(heading).role("heading"))
                        .child(
                            layout::button(t("missions.control.refresh"), false, move |s| {
                                if let Some(panel) = refresh.get(s).0 {
                                    panel.refresh();
                                }
                            })
                            .key("missions-refresh"),
                        ),
                )
                .child(field),
        )
        .child(body)
}

fn page_footer<S: 'static>(ui: &Panel, owner: Scoped<S>, kind: Kind) -> El {
    let mut footer = col().full_width();
    if ui.busy(kind) {
        footer = footer.child(theme::note(t("missions.control.loading"), "status"));
    } else if ui.failed(kind) {
        footer = footer
            .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
            .child(layout::button(
                t("missionsPanel.reader.retry"),
                false,
                move |s| {
                    if let Some(panel) = owner.get(s).0 {
                        panel.more(kind);
                    }
                },
            ));
    } else if ui.has_more(kind) {
        footer = footer.child(layout::button(
            t("missionsPanel.pages.more"),
            false,
            move |s| {
                if let Some(panel) = owner.get(s).0 {
                    panel.more(kind);
                }
            },
        ));
    }
    footer
}

fn detail<S: 'static>(
    ui: &Panel,
    owner: Scoped<S>,
    open_task: Option<OpenTask<S>>,
    on_reader_open: fn(&mut S, &mut Tx),
) -> El {
    let detail = &ui.detail;
    let mut result = col()
        .full_width()
        .pad(Space::Sm)
        .key("mission-detail")
        .role("region")
        .label(t("missions.control.overview"));
    if let Some(snapshot) = &detail.snapshot {
        let header = &snapshot.header.root;
        let name = header
            .title
            .as_deref()
            .filter(|title| !title.is_empty())
            .or_else(|| {
                ui.summaries
                    .iter()
                    .find(|row| row.id == header.id)
                    .map(title)
            })
            .unwrap_or(t("missions.control.overview"));
        result = result
            .child(text(name).role("heading").wrap_anywhere())
            .child(text(status(header.status, header.run_state)).text_role(TextRole::Small))
            .child(text(&header.excerpt).wrap_anywhere());
        if let Some(attention) = &snapshot.header.tasks.page.attention {
            let (remaining, exact) = snapshot.attention_remaining();
            let counts = &attention.counts;
            if remaining > 0 {
                let count = remaining.to_string();
                let label = if exact {
                    catalogue::format(
                        locale(),
                        if remaining == 1 {
                            "missionsPanel.tasks.attention.one"
                        } else {
                            "missionsPanel.tasks.attention.other"
                        },
                        &[("count", &count)],
                    )
                } else {
                    t("missionsPanel.tasks.attention.show").into()
                };
                let help = catalogue::format(
                    locale(),
                    "missionsPanel.tasks.attention.counts",
                    &[
                        ("blocked", &counts.blocked.to_string()),
                        ("failed", &counts.failed.to_string()),
                        ("recovery", &counts.recovery.to_string()),
                        ("notifications", &counts.notifications.to_string()),
                    ],
                );
                let attention_owner = owner.clone();
                result = result.child(
                    layout::button(&label, detail.busy() || detail.failed, move |s| {
                        if let Some(panel) = attention_owner.get(s).0 {
                            panel.detail.attention();
                        }
                    })
                    .key("mission-attention-more")
                    .help(&help)
                    .description(help),
                );
            }
        }
        let open_task_id = match ui.reader.target() {
            Some(ReaderTarget::Task {
                mission_id,
                task_id,
                ..
            }) if mission_id == &header.id => Some(task_id.clone()),
            _ => None,
        };
        let task_owner = owner.clone();
        let mission_id = header.id.clone();
        let on_open: super::task_rows::TaskOpen<S> = Rc::new(
            move |s: &mut S, task_id: String, task_key: String, tx: &mut Tx| {
                if let Some(panel) = task_owner.get(s).0 {
                    let eye_key = format!("mission-task-eye-{task_id}");
                    if panel.toggle_task(&mission_id, &task_id, &task_key) {
                        panel
                            .reader
                            .set_return_focus(tx.focused().unwrap_or(&eye_key).to_owned());
                        on_reader_open(s, tx);
                        tx.focus("mission-reader-close", tx.focus_visible());
                    } else if let Some(back) = panel.reader.take_return_focus() {
                        tx.focus(back, tx.focus_visible());
                    }
                    tx.instant();
                }
            },
        );
        let conversation = open_task.map(|open| {
            (
                snapshot.header.root.coordinator_session_id().to_owned(),
                ui.observation.current_actors(),
                open,
            )
        });
        result = result.child(snapshot.tasks.view_with_open::<S>(
            open_task_id,
            Some(on_open),
            conversation,
        ));
    }
    if detail.busy() || detail.snapshot.is_none() && !detail.failed {
        result = result.child(theme::note(t("missions.control.loading"), "status"));
    } else if detail.failed {
        result = result
            .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
            .child(
                layout::button(t("missionsPanel.reader.retry"), false, move |s| {
                    if let Some(panel) = owner.get(s).0 {
                        panel.detail.retry();
                    }
                })
                .key("mission-detail-retry"),
            );
    } else if detail
        .snapshot
        .as_ref()
        .is_some_and(|s| s.end < s.header.tasks.page.total)
    {
        result = result.child(
            layout::button(t("missionsPanel.pages.more"), false, move |s| {
                if let Some(panel) = owner.get(s).0 {
                    panel.detail.more();
                }
            })
            .key("mission-tasks-more"),
        );
    }
    result
}

pub(super) fn status(status: Status, run_state: Option<RunState>) -> &'static str {
    t(match (status, run_state) {
        (Status::Completed, _) => "missions.control.status.completed",
        (Status::Failed, _) => "missions.control.status.failed",
        (Status::Stopped, _) => "missions.control.status.stopped",
        (Status::Active, Some(RunState::Prepared)) => "missions.control.run.prepared",
        (Status::Active, Some(RunState::Paused)) => "missions.control.run.paused",
        (Status::Active, Some(RunState::Stopped)) => "missions.control.status.stopped",
        (Status::Active, _) => "missions.control.status.active",
    })
}
