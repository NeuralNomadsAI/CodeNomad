use super::directory::{Kind, Panel, title};
use crate::strings::{locale, t};
use codenomad_client::missions::{RunState, Status};
use rune::{El, col, edit::TextEdit, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, field_kit, git_panel as theme,
    layout::{self, Layout},
    shell,
};

type Owner<S> = fn(&mut S) -> (Option<&mut Panel>, &mut TextEdit);

struct Scoped<S> {
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
    fn get<'a>(&self, state: &'a mut S) -> (Option<&'a mut Panel>, &'a mut TextEdit) {
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
    panel_body(ui, owner, rune::el(), default_cleanups::<S>(ui))
}

pub(crate) fn panel_body<S: 'static>(ui: &Panel, owner: Owner<S>, actions: El, cleanups: El) -> El {
    let heading = t("missions.control.mapLabel");
    let search = t("missionsPanel.picker.search");
    let partial = ui.has_more(Kind::Summaries);
    let scoped = Scoped {
        owner,
        scope: ui.scope.clone(),
    };
    let mut list = col().full_width().role("list").label(heading);
    let mut shown = false;
    for row in ui.shown_rows() {
        shown = true;
        let id = row.id.clone();
        let selected = ui.selected.as_deref() == Some(&id);
        let interrupted = selected
            && row.status == Status::Active
            && row.run_state.unwrap_or(RunState::Running) == RunState::Running
            && ui.detail.snapshot.as_ref().is_some_and(|snap| {
                snap.header.root.id == row.id && ui.observation.interrupted(&snap.header)
            });
        let description = if interrupted {
            t("missionsPanel.state.interrupted")
        } else {
            status(row.status, row.run_state)
        };
        let scoped = scoped.clone();
        list = list.child(
            shell::session_row(title(row), selected, false, move |state, tx| {
                if let Some(panel) = scoped.get(state).0 {
                    panel.select(&id);
                    tx.instant();
                }
            })
            .key(format!("mission-row-{}", row.id))
            .description(description),
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
        body = body.child(actions).child(detail(ui, scoped.clone()));
    }
    body = body.child(cleanups);
    body = body.child(page_footer(ui, scoped.clone(), Kind::Cleanups));
    let refresh = scoped.clone();
    let mut field = layout::hinted_field(&ui.filter, search).label(search);
    if partial {
        field = field.description(t("missionsPanel.pages.searchLoaded"));
    }
    let field = field
        .on_edit(move |s: &mut S| {
            let (panel, fallback) = scoped.get(s);
            panel.map_or(fallback, |panel| &mut panel.filter)
        })
        .build(field_kit(layout::dark()))
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

#[cfg(test)]
fn default_cleanups<S: 'static>(ui: &Panel) -> El {
    let owner = super::cleanup::CleanupOwner::default();
    super::cleanup_view::cleanup_view::<S>(ui, &owner, "", |_, _, _, _| {}, |_, _, _, _, _| {})
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

fn detail<S: 'static>(ui: &Panel, owner: Scoped<S>) -> El {
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
        result = result.child(snapshot.tasks.view::<S>());
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

fn status(status: Status, run_state: Option<RunState>) -> &'static str {
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
