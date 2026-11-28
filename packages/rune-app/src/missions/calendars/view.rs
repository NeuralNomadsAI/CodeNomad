//! Programmed Missions ("calendars") panel section, detail, and run history.
//! Uses only semantic `rune_theme_codenomad` controls and shared i18n keys.
use super::{
    editor_view::editor_view,
    summary::{
        describe_criteria, describe_rule_trigger, display_status, format_epoch_ms,
        format_history_entry, next_due_label_key, next_due_millis, primary_zone, status_text,
        template_label_key,
    },
};
use crate::{
    missions::{directory::Panel, task_rows::OpenTask, view::Scoped},
    strings::{locale, t},
};
use codenomad_client::missions::{CalendarLaunch, CalendarView};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, attachment,
    document_reader::editor as modal,
    file_row_actions::icons as row_icons,
    git_panel::{self as theme, ButtonLook::Flat},
    layout::{self, Layout},
    shell,
};

pub(crate) fn view<S: 'static>(ui: &Panel, owner: Scoped<S>, open_task: Option<OpenTask<S>>) -> El {
    let calendars = &ui.calendars;
    let should_show = !calendars.entries.is_empty()
        || calendars.failed
        || calendars.busy_mutation()
        || calendars.feedback.is_some();
    if !should_show
        || (calendars.unavailable && calendars.entries.is_empty() && calendars.feedback.is_none())
    {
        return rune::el();
    }

    let heading = t("missions.scheduling.title");
    let mut section = theme::context()
        .key("mission-calendars-section")
        .role("region")
        .label(heading)
        .child(shell::panel_title(heading).role("heading"));

    if !calendars.entries.is_empty() {
        let mut list = col().full_width().role("list").label(heading);
        for item in &calendars.entries {
            let id = item.id.clone();
            let selected = calendars.selected.as_deref() == Some(id.as_str());
            let status = status_text(display_status(item, &ui.summaries), locale());
            let row_owner = owner.clone();
            list = list.child(
                theme::file_row(selected)
                    .child(
                        shell::session_row(&item.title, selected, false, move |state, tx| {
                            if let Some(panel) = row_owner.get(state).0 {
                                panel.calendars.select(&id);
                                tx.instant();
                            }
                        })
                        .remaining()
                        .key(format!("mission-calendar-row-{}", item.id))
                        .description(status.clone()),
                    )
                    .child(attachment::status_badge(&status)),
            );
        }
        section = section.child(list);
    }

    if calendars.failed {
        let retry_owner = owner.clone();
        section = section
            .child(theme::note(
                t("missions.control.reader.unavailable"),
                "alert",
            ))
            .child(
                layout::action_row().child(
                    theme::button(
                        t("missionsPanel.reader.retry"),
                        Flat,
                        calendars.busy_read(),
                        move |state, tx| {
                            if let Some(panel) = retry_owner.get(state).0 {
                                panel.refresh_calendars();
                                tx.instant();
                            }
                        },
                    )
                    .key("mission-calendars-retry"),
                ),
            );
    }

    if let Some(selected) = calendars.selected_view() {
        section = section.child(calendar_detail(ui, selected, owner, open_task));
    }

    section
}

fn calendar_detail<S: 'static>(
    ui: &Panel,
    calendar: &CalendarView,
    owner: Scoped<S>,
    open_task: Option<OpenTask<S>>,
) -> El {
    let loc = locale();
    let busy = ui.calendars.busy_mutation();
    let editing = ui
        .calendars
        .editor
        .as_ref()
        .is_some_and(|ed| ed.calendar_id == calendar.id);

    let mut actions = layout::action_row();
    let pause_label = t(if calendar.paused {
        "missionsPanel.action.resume"
    } else {
        "missionsPanel.action.pause"
    });
    let pause_id = calendar.id.clone();
    let pause_owner = owner.clone();
    actions = actions.child(
        layout::button_tx(pause_label, busy, move |state, tx| {
            if let Some(panel) = pause_owner.get(state).0 {
                panel.toggle_calendar_pause(&pause_id);
                tx.instant();
            }
        })
        .key("mission-calendar-toggle-pause"),
    );

    if !editing {
        let edit_id = calendar.id.clone();
        let edit_owner = owner.clone();
        actions = actions.child(
            theme::icon_button(
                &shell::icons::PENCIL,
                t("missions.control.edit"),
                busy,
                None,
                move |state, tx| {
                    if let Some(panel) = edit_owner.get(state).0 {
                        panel.calendars.open_editor(&edit_id);
                        tx.instant();
                    }
                },
            )
            .key("mission-calendar-edit"),
        );
    }

    if let Some(open) = open_task
        && let Some(session_id) = calendar.coordinator_session_id()
    {
        let session = session_id.to_owned();
        actions = actions.child(
            theme::icon_button(
                &shell::icons::CONVERSATION,
                t("missionsPanel.action.openConversation"),
                false,
                None,
                move |state, tx| {
                    open(state, session.clone(), tx);
                    tx.instant();
                },
            )
            .key("mission-calendar-open-conversation"),
        );
    }

    let delete_id = calendar.id.clone();
    let delete_owner = owner.clone();
    actions = actions.child(
        theme::icon_button(
            &row_icons::TRASH,
            t("missions.control.delete"),
            busy,
            None,
            move |state, tx| {
                if let Some(panel) = delete_owner.get(state).0 {
                    panel.calendars.request_delete(&delete_id);
                    tx.instant();
                }
            },
        )
        .key("mission-calendar-delete"),
    );

    let zone = primary_zone(calendar);
    let status = status_text(display_status(calendar, &ui.summaries), loc);
    let next_due = next_due_millis(calendar)
        .map(|ms| format_epoch_ms(ms, loc, zone))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| t("missions.scheduleList.none").to_owned());
    let next_line = format!("{} · {next_due}", t(next_due_label_key(calendar)));

    let mut detail = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .key("mission-calendar-detail")
        .role("region")
        .label(&calendar.title)
        .child(
            layout::action_row()
                .child(
                    text(&calendar.title)
                        .role("heading")
                        .wrap_anywhere()
                        .remaining(),
                )
                .child(attachment::status_badge(&status)),
        )
        .child(text(next_line).text_role(TextRole::Small).wrap_anywhere())
        .child(actions);

    if busy {
        detail = detail.child(theme::note(
            t("missions.control.mutation.pending"),
            "status",
        ));
    } else if let Some(feedback) = ui.calendars.feedback {
        detail = detail.child(theme::note(t(feedback), "alert").key("mission-calendar-feedback"));
    }

    if let Some(template) = calendar.mission.template {
        let line = format!(
            "{} · {}",
            t("missions.control.template"),
            t(template_label_key(template))
        );
        detail = detail.child(text(line).text_role(TextRole::Small).wrap_anywhere());
    }
    if calendar.coordinator_goal() {
        detail = detail.child(
            text(t("missions.scheduling.coordinatorGoal"))
                .text_role(TextRole::Small)
                .wrap_anywhere(),
        );
    }

    detail = detail.child(launch_summary_block(calendar, loc));
    if editing && let Some(editor) = ui.calendars.editor.as_ref() {
        detail = detail.child(editor_view(editor, busy, owner));
    }
    detail = detail.child(history_block(calendar, loc, zone));
    detail
}

fn launch_summary_block(calendar: &CalendarView, loc: &str) -> El {
    let mut block = col()
        .full_width()
        .separate(Space::Xs)
        .key("mission-calendar-launch")
        .child(shell::panel_title(t("missions.scheduling.when")).role("heading"));
    match &calendar.launch {
        Some(CalendarLaunch::Criteria(policy)) => {
            for line in describe_criteria(policy, loc) {
                block = block.child(text(line).text_role(TextRole::Small).wrap_anywhere());
            }
        }
        Some(CalendarLaunch::Opaque(_)) => {
            block = block.child(theme::note(
                t("missions.scheduling.retained.title"),
                "status",
            ));
            for rule in &calendar.rules {
                block = block.child(
                    text(describe_rule_trigger(&rule.trigger, loc))
                        .text_role(TextRole::Small)
                        .wrap_anywhere(),
                );
            }
        }
        None => {
            for rule in &calendar.rules {
                block = block.child(
                    text(describe_rule_trigger(&rule.trigger, loc))
                        .text_role(TextRole::Small)
                        .wrap_anywhere(),
                );
            }
        }
    }
    block
}

fn history_block(calendar: &CalendarView, loc: &str, zone: &str) -> El {
    let heading = t("missionsPanel.pastRuns");
    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .key("mission-calendar-history")
        .role("region")
        .label(heading)
        .child(shell::panel_title(heading).role("heading"));
    let history = calendar.history();
    if history.is_empty() {
        section = section.child(
            text(t("missionsPanel.schedule.noRuns"))
                .text_role(TextRole::Small)
                .wrap_anywhere(),
        );
    } else {
        for (index, entry) in history.iter().rev().enumerate() {
            section = section.child(
                text(format_history_entry(entry, loc, zone))
                    .key(format!("mission-calendar-history-{index}"))
                    .text_role(TextRole::Small)
                    .wrap_anywhere(),
            );
        }
    }
    section
}

pub(crate) fn delete_confirmation<S: 'static>(
    panel: &Panel,
    on_confirm: fn(&mut S, bool, &mut Tx),
) -> Option<El> {
    let (_, title) = panel.calendars.pending_delete()?;
    let prompt = if title.is_empty() {
        t("missions.control.delete").to_owned()
    } else {
        format!("{}: {title}", t("missions.control.delete"))
    };
    Some(modal::confirmation(
        layout::dark(),
        &prompt,
        t("missions.control.cancel"),
        t("missions.control.delete"),
        on_confirm,
    ))
}
