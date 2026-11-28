//! Inline post-#1791 `launch.when` and calendar configuration editor view.
use super::editor::{CalendarEditor, CriterionDraft, CriterionKind};
use crate::{
    missions::view::Scoped,
    strings::{locale, t},
};
use codenomad_client::missions::{
    CriteriaStructure, CriterionConnector, LaunchCriterion, LaunchPolicy,
    MISSION_LAUNCH_CRITERIA_MAX, RepositoryEvent, RepositoryProvider,
};
use rune::{El, col, edit::TextEdit, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, field_kit,
    file_row_actions::icons as row_icons,
    git_panel::{
        self as theme,
        ButtonLook::{Flat, Submit, WithIcon},
    },
    layout::{self, Layout},
    settings as chrome,
};

pub(super) fn editor_view<S: 'static>(editor: &CalendarEditor, busy: bool, owner: Scoped<S>) -> El {
    let dark = layout::dark();
    let title_owner = owner.clone();
    let objective_owner = owner.clone();
    let notes_owner = owner.clone();
    let goal_owner = owner.clone();

    let title_field = layout::hinted_field(&editor.title, t("missions.create.title"))
        .label(t("missions.create.title"))
        .on_edit(move |state: &mut S| {
            let (panel, fallback) = title_owner.get(state);
            panel
                .and_then(|panel| panel.calendars.editor.as_mut())
                .map_or(fallback, |ed| &mut ed.title)
        })
        .build(&field_kit(dark))
        .key("mission-calendar-edit-title");

    let objective_field = layout::textarea(&editor.objective)
        .label(t("missions.create.objective"))
        .on_edit(move |state: &mut S| {
            let (panel, fallback) = objective_owner.get(state);
            panel
                .and_then(|panel| panel.calendars.editor.as_mut())
                .map_or(fallback, |ed| &mut ed.objective)
        })
        .build(&field_kit(dark))
        .key("mission-calendar-edit-objective");

    let notes_field = layout::hinted_field(&editor.notes, t("missions.control.notes"))
        .label(t("missions.control.notes"))
        .on_edit(move |state: &mut S| {
            let (panel, fallback) = notes_owner.get(state);
            panel
                .and_then(|panel| panel.calendars.editor.as_mut())
                .map_or(fallback, |ed| &mut ed.notes)
        })
        .build(&field_kit(dark))
        .key("mission-calendar-edit-notes");

    let goal_label = t("missions.scheduling.coordinatorGoal");
    let goal_checkbox = chrome::checkbox_cell(
        goal_label.into(),
        editor.coordinator_goal,
        busy,
        move |state: &mut S| {
            if let Some(panel) = goal_owner.get(state).0
                && let Some(ed) = panel.calendars.editor.as_mut()
            {
                ed.coordinator_goal = !ed.coordinator_goal;
            }
        },
    )
    .key("mission-calendar-edit-goal");

    let mut form = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .key("mission-calendar-editor")
        .role("region")
        .label(t("missions.control.edit"))
        .child(title_field)
        .child(objective_field)
        .child(notes_field)
        .child(chrome::setting_row_with_info(
            goal_label,
            None,
            goal_checkbox,
        ));

    if editor.retained_opaque {
        let replace_owner = owner.clone();
        form = form
            .child(theme::note(
                t("missions.scheduling.retained.retired"),
                "status",
            ))
            .child(
                layout::action_row().child(
                    theme::button(
                        t("missions.scheduling.retained.replace"),
                        Flat,
                        busy,
                        move |state, tx| {
                            if let Some(panel) = replace_owner.get(state).0
                                && let Some(ed) = panel.calendars.editor.as_mut()
                            {
                                ed.replace_retained();
                                tx.instant();
                            }
                        },
                    )
                    .key("mission-calendar-replace-retained"),
                ),
            );
    } else {
        let structure = preview_structure(&editor.criteria);
        let count = editor.criteria.len();
        for (index, draft) in editor.criteria.iter().enumerate() {
            let connector = (index > 0).then(|| structure.connectors[index - 1]);
            form = form.child(criterion_card(
                draft,
                index,
                count,
                connector,
                busy,
                owner.clone(),
            ));
        }
        let add_owner = owner.clone();
        form = form.child(
            layout::action_row().child(
                theme::button(
                    t("missions.scheduling.addCriterion"),
                    WithIcon(&theme::PLUS),
                    busy || count >= MISSION_LAUNCH_CRITERIA_MAX,
                    move |state, tx| {
                        if let Some(panel) = add_owner.get(state).0
                            && let Some(ed) = panel.calendars.editor.as_mut()
                        {
                            ed.add_criterion();
                            tx.instant();
                        }
                    },
                )
                .key("mission-calendar-add-criterion"),
            ),
        );
    }

    if let Some(error_key) = editor.validation_error {
        form = form.child(theme::note(t(error_key), "alert").key("mission-calendar-edit-error"));
    }

    let save_owner = owner.clone();
    let cancel_owner = owner;
    form.child(
        layout::action_row()
            .child(
                theme::button(
                    t("missions.control.save"),
                    Submit,
                    busy,
                    move |state, tx| {
                        if let Some(panel) = save_owner.get(state).0 {
                            panel.save_calendar_editor();
                            tx.instant();
                        }
                    },
                )
                .key("mission-calendar-save"),
            )
            .child(
                theme::button(
                    t("missions.control.cancel"),
                    Flat,
                    busy,
                    move |state, tx| {
                        if let Some(panel) = cancel_owner.get(state).0 {
                            panel.calendars.close_editor();
                            tx.instant();
                        }
                    },
                )
                .key("mission-calendar-cancel"),
            ),
    )
}

fn preview_structure(criteria: &[CriterionDraft]) -> CriteriaStructure {
    let stub = LaunchPolicy {
        when: criteria
            .iter()
            .map(|draft| match draft.kind {
                CriterionKind::Cron => LaunchCriterion::Cron {
                    expression: String::new(),
                    zone: String::new(),
                },
                _ => LaunchCriterion::FilesChanged { paths: Vec::new() },
            })
            .collect(),
    };
    stub.structure()
}

fn criterion_card<S: 'static>(
    draft: &CriterionDraft,
    index: usize,
    total: usize,
    connector: Option<CriterionConnector>,
    busy: bool,
    owner: Scoped<S>,
) -> El {
    let loc = locale();
    let number = (index + 1).to_string();
    let heading = catalogue::format(loc, "missions.scheduling.criterion", &[("number", &number)]);
    let title_line = match connector {
        Some(conn) => {
            let conn_label = t(match conn {
                CriterionConnector::Or => "missions.scheduling.connector.or",
                CriterionConnector::If => "missions.scheduling.connector.if",
                CriterionConnector::Else => "missions.scheduling.connector.else",
            });
            format!("{conn_label} · {heading}")
        }
        None => heading,
    };

    let kind_label = catalogue::format(
        loc,
        "missions.scheduling.criterionKind",
        &[("number", &number)],
    );
    let kind_text = t(draft.kind.label_key());
    let kind_owner = owner.clone();
    let mut header_actions = layout::action_row().child(
        layout::button_tx(kind_text, busy, move |state, tx| {
            if let Some(panel) = kind_owner.get(state).0
                && let Some(ed) = panel.calendars.editor.as_mut()
                && let Some(row) = ed.criteria.get_mut(index)
            {
                let zone = ed.default_zone.clone();
                let next = row.kind.next();
                row.switch_kind(next, &zone);
                ed.validation_error = None;
                tx.instant();
            }
        })
        .label(format!("{kind_label}: {kind_text}"))
        .key(format!("mission-calendar-criterion-kind-{index}")),
    );

    if total > 1 {
        let up_owner = owner.clone();
        let down_owner = owner.clone();
        let move_label = catalogue::format(
            loc,
            "missions.scheduling.dragHandle",
            &[("number", &number)],
        );
        header_actions = header_actions
            .child(
                layout::button_tx("↑", busy || index == 0, move |state, tx| {
                    if let Some(panel) = up_owner.get(state).0
                        && let Some(ed) = panel.calendars.editor.as_mut()
                    {
                        ed.move_criterion(index, -1);
                        tx.instant();
                    }
                })
                .label(format!("{move_label} ↑"))
                .key(format!("mission-calendar-criterion-up-{index}")),
            )
            .child(
                layout::button_tx("↓", busy || index + 1 >= total, move |state, tx| {
                    if let Some(panel) = down_owner.get(state).0
                        && let Some(ed) = panel.calendars.editor.as_mut()
                    {
                        ed.move_criterion(index, 1);
                        tx.instant();
                    }
                })
                .label(format!("{move_label} ↓"))
                .key(format!("mission-calendar-criterion-down-{index}")),
            );
    }

    let remove_owner = owner.clone();
    let remove_label = catalogue::format(
        loc,
        "missions.scheduling.removeCriterion",
        &[("number", &number)],
    );
    header_actions = header_actions.child(
        theme::icon_button(
            &row_icons::TRASH,
            remove_label,
            busy || total <= 1,
            None,
            move |state, tx| {
                if let Some(panel) = remove_owner.get(state).0
                    && let Some(ed) = panel.calendars.editor.as_mut()
                {
                    ed.remove_criterion(index);
                    tx.instant();
                }
            },
        )
        .key(format!("mission-calendar-criterion-remove-{index}")),
    );

    let card = theme::context()
        .key(format!("mission-calendar-criterion-{index}"))
        .child(text(title_line).text_role(TextRole::Small).wrap_anywhere())
        .child(header_actions);

    criterion_fields(card, draft, index, busy, owner)
}

fn criterion_fields<S: 'static>(
    card: El,
    draft: &CriterionDraft,
    index: usize,
    busy: bool,
    owner: Scoped<S>,
) -> El {
    match draft.kind {
        CriterionKind::Cron => card
            .child(criterion_field(
                &draft.primary,
                t("missions.scheduling.cron"),
                format!("mission-calendar-criterion-primary-{index}"),
                owner.clone(),
                index,
                |row| &mut row.primary,
            ))
            .child(criterion_field(
                &draft.secondary,
                t("missions.scheduling.zone"),
                format!("mission-calendar-criterion-secondary-{index}"),
                owner,
                index,
                |row| &mut row.secondary,
            )),
        CriterionKind::FilesChanged => card.child(criterion_field(
            &draft.primary,
            t("missions.scheduling.files"),
            format!("mission-calendar-criterion-primary-{index}"),
            owner,
            index,
            |row| &mut row.primary,
        )),
        CriterionKind::BranchCommits => card
            .child(criterion_field(
                &draft.primary,
                t("missions.scheduling.repository.repository"),
                format!("mission-calendar-criterion-primary-{index}"),
                owner.clone(),
                index,
                |row| &mut row.primary,
            ))
            .child(criterion_field(
                &draft.secondary,
                t("missions.scheduling.repository.branch"),
                format!("mission-calendar-criterion-secondary-{index}"),
                owner,
                index,
                |row| &mut row.secondary,
            )),
        CriterionKind::GithubNotification => card.child(criterion_field(
            &draft.primary,
            t("missions.scheduling.github.repositoryOptional"),
            format!("mission-calendar-criterion-primary-{index}"),
            owner,
            index,
            |row| &mut row.primary,
        )),
        CriterionKind::GithubSecurityAlert => card.child(criterion_field(
            &draft.primary,
            t("missions.scheduling.github.repository"),
            format!("mission-calendar-criterion-primary-{index}"),
            owner,
            index,
            |row| &mut row.primary,
        )),
        CriterionKind::GithubPullRequest | CriterionKind::GithubIssue => card
            .child(criterion_field(
                &draft.primary,
                t("missions.scheduling.github.repository"),
                format!("mission-calendar-criterion-primary-{index}"),
                owner.clone(),
                index,
                |row| &mut row.primary,
            ))
            .child(criterion_field(
                &draft.secondary,
                t("missions.scheduling.github.author"),
                format!("mission-calendar-criterion-secondary-{index}"),
                owner,
                index,
                |row| &mut row.secondary,
            )),
        CriterionKind::RepositoryActivity => {
            let provider_owner = owner.clone();
            let event_owner = owner.clone();
            card.child(
                layout::action_row()
                    .child(
                        layout::button_tx(
                            t(provider_label_key(draft.provider)),
                            busy,
                            move |state, tx| {
                                if let Some(panel) = provider_owner.get(state).0
                                    && let Some(ed) = panel.calendars.editor.as_mut()
                                    && let Some(row) = ed.criteria.get_mut(index)
                                {
                                    row.cycle_provider();
                                    tx.instant();
                                }
                            },
                        )
                        .key(format!("mission-calendar-criterion-provider-{index}")),
                    )
                    .child(
                        layout::button_tx(
                            t(repository_event_key(draft.provider, draft.event)),
                            busy,
                            move |state, tx| {
                                if let Some(panel) = event_owner.get(state).0
                                    && let Some(ed) = panel.calendars.editor.as_mut()
                                    && let Some(row) = ed.criteria.get_mut(index)
                                {
                                    row.cycle_event();
                                    tx.instant();
                                }
                            },
                        )
                        .key(format!("mission-calendar-criterion-event-{index}")),
                    ),
            )
            .child(criterion_field(
                &draft.host,
                t("missions.scheduling.repository.git"),
                format!("mission-calendar-criterion-host-{index}"),
                owner.clone(),
                index,
                |row| &mut row.host,
            ))
            .child(criterion_field(
                &draft.primary,
                t("missions.scheduling.repository.repository"),
                format!("mission-calendar-criterion-primary-{index}"),
                owner.clone(),
                index,
                |row| &mut row.primary,
            ))
            .child(criterion_field(
                &draft.author,
                t("missions.scheduling.github.author"),
                format!("mission-calendar-criterion-author-{index}"),
                owner,
                index,
                |row| &mut row.author,
            ))
        }
        CriterionKind::RemoteBranchCommits => {
            let provider_owner = owner.clone();
            card.child(
                layout::button_tx(
                    t(provider_label_key(draft.provider)),
                    busy,
                    move |state, tx| {
                        if let Some(panel) = provider_owner.get(state).0
                            && let Some(ed) = panel.calendars.editor.as_mut()
                            && let Some(row) = ed.criteria.get_mut(index)
                        {
                            row.cycle_provider();
                            tx.instant();
                        }
                    },
                )
                .key(format!("mission-calendar-criterion-provider-{index}")),
            )
            .child(criterion_field(
                &draft.host,
                t("missions.scheduling.repository.git"),
                format!("mission-calendar-criterion-host-{index}"),
                owner.clone(),
                index,
                |row| &mut row.host,
            ))
            .child(criterion_field(
                &draft.primary,
                t("missions.scheduling.repository.repository"),
                format!("mission-calendar-criterion-primary-{index}"),
                owner.clone(),
                index,
                |row| &mut row.primary,
            ))
            .child(criterion_field(
                &draft.secondary,
                t("missions.scheduling.repository.branch"),
                format!("mission-calendar-criterion-secondary-{index}"),
                owner,
                index,
                |row| &mut row.secondary,
            ))
        }
    }
}

fn criterion_field<S: 'static>(
    edit: &TextEdit,
    label: &'static str,
    key: String,
    owner: Scoped<S>,
    index: usize,
    select: fn(&mut CriterionDraft) -> &mut TextEdit,
) -> El {
    layout::hinted_field(edit, label)
        .label(label)
        .on_edit(move |state: &mut S| {
            let (panel, fallback) = owner.get(state);
            panel
                .and_then(|panel| panel.calendars.editor.as_mut())
                .and_then(|ed| ed.criteria.get_mut(index))
                .map_or(fallback, select)
        })
        .build(&field_kit(layout::dark()))
        .key(key)
}

fn provider_label_key(provider: RepositoryProvider) -> &'static str {
    match provider {
        RepositoryProvider::Github => "missions.scheduling.repository.provider.github",
        RepositoryProvider::Gitlab => "missions.scheduling.repository.provider.gitlab",
        RepositoryProvider::Gitea => "missions.scheduling.repository.provider.gitea",
    }
}

fn repository_event_key(provider: RepositoryProvider, event: RepositoryEvent) -> &'static str {
    match (provider, event) {
        (RepositoryProvider::Gitlab, RepositoryEvent::PullRequestCreated) => {
            "missions.scheduling.repository.merge.pull-request-created"
        }
        (RepositoryProvider::Gitlab, RepositoryEvent::PullRequestMerged) => {
            "missions.scheduling.repository.merge.pull-request-merged"
        }
        (RepositoryProvider::Gitlab, RepositoryEvent::IssueCreated) => {
            "missions.scheduling.repository.merge.issue-created"
        }
        (_, RepositoryEvent::PullRequestCreated) => {
            "missions.scheduling.repository.pull.pull-request-created"
        }
        (_, RepositoryEvent::PullRequestMerged) => {
            "missions.scheduling.repository.pull.pull-request-merged"
        }
        (_, RepositoryEvent::IssueCreated) => "missions.scheduling.repository.pull.issue-created",
    }
}
