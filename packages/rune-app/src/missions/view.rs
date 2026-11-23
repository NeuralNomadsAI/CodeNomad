use super::directory::{Kind, Panel, title};
use crate::strings::{locale, t};
use codenomad_client::missions::{RunState, Status, Summary};
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
pub(crate) fn panel<S: 'static>(ui: &Panel, owner: Owner<S>) -> El {
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
        let scoped = scoped.clone();
        list = list.child(
            shell::session_row(title(row), selected, false, move |state, _| {
                if let Some(panel) = scoped.get(state).0 {
                    panel.select(&id);
                }
            })
            .key(format!("mission-row-{}", row.id))
            .description(status(row)),
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

fn status(row: &Summary) -> &'static str {
    t(match (row.status, row.run_state) {
        (Status::Completed, _) => "missions.control.status.completed",
        (Status::Failed, _) => "missions.control.status.failed",
        (Status::Stopped, _) => "missions.control.status.stopped",
        (Status::Active, Some(RunState::Prepared)) => "missions.control.run.prepared",
        (Status::Active, Some(RunState::Paused)) => "missions.control.run.paused",
        (Status::Active, Some(RunState::Stopped)) => "missions.control.status.stopped",
        (Status::Active, _) => "missions.control.status.active",
    })
}
