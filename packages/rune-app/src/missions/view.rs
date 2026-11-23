use super::directory::{Kind, Panel, title};
use crate::strings::{locale, t};
use codenomad_client::missions::{RunState, Status, Summary};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, field_kit, git_panel as theme,
    layout::{self, Layout},
    shell,
};

/// Panel content only. The Shell owns its occurrence, visibility and mounting.
pub(crate) fn panel<S: 'static>(ui: &Panel, owner: fn(&mut S) -> &mut Panel) -> El {
    let heading = t("missions.control.mapLabel");
    let search = t("missionsPanel.picker.search");
    let mut list = col().full_width().role("list").label(heading);
    let mut shown = false;
    for row in ui.shown_rows() {
        shown = true;
        let id = row.id.clone();
        let selected = ui.selected.as_deref() == Some(&id);
        list = list.child(
            shell::session_row(title(row), selected, false, move |state, _| {
                owner(state).select(&id);
            })
            .key(format!("mission-row-{}", row.id))
            .description(status(row)),
        );
    }
    let mut body = theme::scroll().child(list);
    if ui.loaded(Kind::Summaries) && !ui.failed(Kind::Summaries) && !shown {
        let key = if ui.summaries.is_empty() {
            "missions.control.empty.title"
        } else {
            "missionsPanel.picker.noMatch"
        };
        body = body.child(theme::note(t(key), "status"));
    }
    body = body.child(page_footer(ui, owner, Kind::Summaries));
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
            body = body.child(
                col()
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
                    .child(text(counts).text_role(TextRole::Small).wrap_anywhere()),
            );
        }
    }
    body = body.child(page_footer(ui, owner, Kind::Cleanups));
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
                                owner(s).refresh();
                            })
                            .key("missions-refresh"),
                        ),
                )
                .child(
                    layout::hinted_field(&ui.filter, search)
                        .label(search)
                        .on_edit(move |s: &mut S| &mut owner(s).filter)
                        .build(field_kit(layout::dark()))
                        .key("missions-search"),
                ),
        )
        .child(body)
}

fn page_footer<S: 'static>(ui: &Panel, owner: fn(&mut S) -> &mut Panel, kind: Kind) -> El {
    let mut footer = col().full_width();
    if ui.busy(kind) {
        footer = footer.child(theme::note(t("missions.control.loading"), "status"));
    } else if ui.failed(kind) {
        footer = footer
            .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
            .child(layout::button(
                t("missionsPanel.reader.retry"),
                false,
                move |s| owner(s).more(kind),
            ));
    } else if ui.has_more(kind) {
        footer = footer.child(layout::button(
            t("missionsPanel.pages.more"),
            false,
            move |s| owner(s).more(kind),
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
