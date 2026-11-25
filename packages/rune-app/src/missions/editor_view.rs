use super::{
    directory::Panel,
    editor::{
        HoldState, Mode, PrefillState, TEXT_LIMIT, TITLE_LIMIT, notes_limit_exceeded,
        objective_limit_exceeded, title_limit_exceeded,
    },
};
use crate::{components::window_close_button, strings::t};
use codenomad_client::missions::{RunState, TaskMode, Template, utf16_len};
use rune::{El, Tx, col, edit::TextEdit, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit, git_panel as theme,
    layout::{self, Layout, dark},
    settings as chrome,
};

type PanelOwner<S> = fn(&mut S) -> (Option<&mut Panel>, &mut TextEdit);

struct Scoped<S> {
    owner: PanelOwner<S>,
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

pub(crate) fn view<S: 'static>(
    panel: &Panel,
    owner: PanelOwner<S>,
    on_close: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    let Some(form) = panel.editor.form.as_ref() else {
        return rune::el();
    };
    let scoped = Scoped {
        owner,
        scope: panel.scope.clone(),
    };
    let creation_hold = (form.mode == Mode::Create)
        .then(|| panel.editor.active_hold(&panel.backend))
        .flatten();
    let edit_hold = form.edit.as_ref().and_then(|edit| {
        panel
            .editor
            .active_edit_hold(&panel.backend, &edit.mission_id)
    });
    let locked = form.fields_locked(creation_hold, edit_hold);
    let structural_locked = locked || form.mode == Mode::Edit;

    let heading = match form.mode {
        Mode::Create => t("missions.control.create"),
        Mode::Edit => t("missions.control.edit"),
    };
    let subtitle = form
        .edit
        .as_ref()
        .and_then(|edit| edit.title.as_deref().filter(|s| !s.trim().is_empty()))
        .or_else(|| form.edit.as_ref().map(|edit| edit.excerpt.as_str()));

    let close_owner = scoped.clone();
    let close_cb = on_close.clone();
    let close_btn = window_close_button::scoped_close_button(
        &form.close,
        "mission-editor-close",
        dark(),
        Some(t("missions.control.cancel")),
        move |s: &mut S| {
            close_owner
                .get(s)
                .0
                .and_then(|p| p.editor.form.as_mut())
                .map(|f| &mut f.close)
        },
        move |s: &mut S, tx| close_cb(s, tx),
    );
    let mut header_title = col()
        .remaining()
        .separate(Space::Xs)
        .child(theme::clipped(heading, TextRole::Body).role("heading"));
    if let Some(sub) = subtitle {
        header_title = header_title.child(theme::clipped(sub, TextRole::Label));
    }
    let header = theme::chrome().child(header_title).child(close_btn);

    let mut content = col().full_width().pad(Space::Md).separate(Space::Sm);

    let active_hold_state = creation_hold
        .map(|h| h.state)
        .or_else(|| edit_hold.map(|h| h.state));
    if let Some(state) = active_hold_state {
        let (key, role) = match state {
            HoldState::Pending => ("missions.control.mutation.pending", "status"),
            HoldState::Uncertain => ("missions.scheduling.uncertain", "alert"),
        };
        content = content.child(theme::note(t(key), role));
    }

    if form.mode == Mode::Edit {
        match form.prefill {
            PrefillState::Loading => {
                content =
                    content.child(theme::note(t("missions.control.reader.loading"), "status"));
            }
            PrefillState::Changed => {
                let reopen_owner = scoped.clone();
                content = content
                    .child(theme::note(t("missions.control.reader.changed"), "alert"))
                    .child(
                        layout::button(
                            t("missions.control.reopen"),
                            form.reopening.is_some(),
                            move |s: &mut S| {
                                if let Some(p) = reopen_owner.get(s).0 {
                                    p.reopen_editor();
                                }
                            },
                        )
                        .key("mission-editor-prefill-reopen"),
                    );
            }
            PrefillState::Failed => {
                let retry_owner = scoped.clone();
                content = content
                    .child(theme::note(
                        t("missions.control.reader.unavailable"),
                        "alert",
                    ))
                    .child(
                        layout::button(t("missionsPanel.reader.retry"), false, move |s: &mut S| {
                            if let Some(p) = retry_owner.get(s).0 {
                                p.retry_editor_prefill();
                            }
                        })
                        .key("mission-editor-prefill-retry"),
                    );
            }
            PrefillState::Ready => {}
        }
    }

    // Objective field
    let obj_label = t("missions.create.objective");
    let obj_owner = scoped.clone();
    let obj_over = objective_limit_exceeded(&form.objective.text);
    content = content
        .child(text(obj_label).text_role(TextRole::Small))
        .child(
            layout::hinted_textarea(&form.objective, t("missions.create.objectivePlaceholder"))
                .rows(4)
                .label(obj_label)
                .disabled(locked)
                .on_edit(move |s: &mut S| {
                    let (panel, fallback) = obj_owner.get(s);
                    panel
                        .and_then(|p| p.editor.form.as_mut())
                        .map_or(fallback, |f| &mut f.objective)
                })
                .build(field_kit(dark()))
                .key("mission-editor-objective"),
        )
        .child(counter(&form.objective.text, TEXT_LIMIT));
    if obj_over {
        content = content.child(theme::note(t("missions.control.mutation.error"), "alert"));
    }

    // Title field
    let title_label = t("missions.create.title");
    let derived = form.derived_title();
    let title_owner = scoped.clone();
    let title_invalid = title_limit_exceeded(&form.title.text);
    content = content
        .child(text(title_label).text_role(TextRole::Small))
        .child(
            layout::hinted_field(&form.title, &derived)
                .label(title_label)
                .invalid(title_invalid)
                .disabled(structural_locked)
                .on_edit(move |s: &mut S| {
                    let (panel, fallback) = title_owner.get(s);
                    panel
                        .and_then(|p| p.editor.form.as_mut())
                        .map_or(fallback, |f| &mut f.title)
                })
                .build(field_kit(dark()))
                .key("mission-editor-title"),
        )
        .child(counter(&form.title.text, TITLE_LIMIT));

    if form.mode == Mode::Edit {
        let lock_key = match form.edit.as_ref().and_then(|e| e.run_state) {
            Some(RunState::Prepared) | None => "missions.scheduling.lock.journal",
            _ => "missions.scheduling.lock.launched-once",
        };
        content = content.child(theme::note(t(lock_key), "status"));
    }

    // Notes field
    let notes_label = t("missions.control.notes");
    let notes_owner = scoped.clone();
    let notes_over = notes_limit_exceeded(&form.notes.text);
    content = content
        .child(text(notes_label).text_role(TextRole::Small))
        .child(
            layout::textarea(&form.notes)
                .rows(3)
                .label(notes_label)
                .disabled(locked)
                .on_edit(move |s: &mut S| {
                    let (panel, fallback) = notes_owner.get(s);
                    panel
                        .and_then(|p| p.editor.form.as_mut())
                        .map_or(fallback, |f| &mut f.notes)
                })
                .build(field_kit(dark()))
                .key("mission-editor-notes"),
        )
        .child(counter(&form.notes.text, TEXT_LIMIT));
    if notes_over {
        content = content.child(theme::note(t("missions.control.mutation.error"), "alert"));
    }

    // Template (Playbook) selector
    let template_labels = [
        t("missions.control.template.custom"),
        t("missions.control.template.debug"),
        t("missions.control.template.wayfinder"),
        t("missions.control.template.delivery"),
        t("missions.control.template.compare"),
    ];
    let selected_template = Template::ALL
        .iter()
        .position(|candidate| *candidate == form.template);
    let tmpl_owner = scoped.clone();
    content = content
        .child(text(t("missions.control.template")).text_role(TextRole::Small))
        .child(
            chrome::segments(
                t("missions.control.template"),
                &template_labels,
                selected_template,
                structural_locked,
                move |s: &mut S, index| {
                    if let Some(p) = tmpl_owner.get(s).0
                        && let Some(form) = p.editor.form.as_mut()
                        && let Some(chosen) = Template::ALL.get(index).copied()
                    {
                        form.template = chosen;
                    }
                },
            )
            .key("mission-editor-template"),
        );
    if let Some(compare_err) = form.compare_error() {
        content = content.child(theme::note(t(compare_err), "alert"));
    }

    // Task mode selector
    let mode_labels = [
        t("missions.taskMode.native"),
        t("missions.taskMode.independent"),
    ];
    let selected_mode = TaskMode::ALL
        .iter()
        .position(|candidate| *candidate == form.task_mode);
    let mode_owner = scoped.clone();
    content = content
        .child(text(t("missions.taskMode.label")).text_role(TextRole::Small))
        .child(
            chrome::segments(
                t("missions.taskMode.label"),
                &mode_labels,
                selected_mode,
                structural_locked,
                move |s: &mut S, index| {
                    if let Some(p) = mode_owner.get(s).0
                        && let Some(form) = p.editor.form.as_mut()
                        && let Some(chosen) = TaskMode::ALL.get(index).copied()
                    {
                        form.task_mode = chosen;
                    }
                },
            )
            .key("mission-editor-task-mode"),
        );

    // Start automatically (create only)
    if form.mode == Mode::Create {
        let start_owner = scoped.clone();
        content = content.child(
            chrome::checkbox(
                t("missions.scheduling.startOnCreation"),
                form.start_on_creation,
                structural_locked,
                move |s: &mut S| {
                    if let Some(p) = start_owner.get(s).0
                        && let Some(form) = p.editor.form.as_mut()
                    {
                        form.start_on_creation = !form.start_on_creation;
                    }
                },
            )
            .key("mission-editor-autostart"),
        );
    }

    if active_hold_state.is_none()
        && let Some(err) = form.error
    {
        content = content.child(theme::note(t(err), "alert"));
    }

    // Action footer
    let cancel_cb = on_close;
    let mut actions = layout::action_row().child(
        layout::button_tx(t("missions.control.cancel"), false, move |s: &mut S, tx| {
            cancel_cb(s, tx);
        })
        .key("mission-editor-cancel"),
    );

    if let Some(hold) = creation_hold
        && hold.state == HoldState::Uncertain
    {
        let rec_owner = scoped.clone();
        actions = actions.child(
            layout::button_tx(
                t("missions.control.refresh"),
                hold.checking,
                move |s: &mut S, tx| {
                    if let Some(p) = rec_owner.get(s).0 {
                        p.reconcile_editor_creation();
                        tx.instant();
                    }
                },
            )
            .key("mission-editor-reconcile"),
        );
    }

    if let Some(hold) = edit_hold
        && hold.state == HoldState::Uncertain
    {
        let rec_owner = scoped.clone();
        actions = actions.child(
            layout::button_tx(
                t("missions.control.refresh"),
                hold.checking,
                move |s: &mut S, tx| {
                    if let Some(p) = rec_owner.get(s).0 {
                        p.reconcile_editor_edit();
                        tx.instant();
                    }
                },
            )
            .key("mission-editor-reconcile"),
        );
    }

    if form.mode == Mode::Edit && form.edit_conflict && edit_hold.is_none() {
        let reopen_owner = scoped.clone();
        actions = actions.child(
            layout::button_tx(
                t("missions.control.reopen"),
                form.reopening.is_some(),
                move |s: &mut S, tx| {
                    if let Some(p) = reopen_owner.get(s).0 {
                        p.reopen_editor();
                        tx.instant();
                    }
                },
            )
            .key("mission-editor-reopen"),
        );
    }

    let pending = form.starting_created || active_hold_state == Some(HoldState::Pending);
    let submit_label = if pending {
        t("missions.control.mutation.pending")
    } else if form.mode == Mode::Create {
        t("missions.create.submit")
    } else {
        t("missions.control.save")
    };
    let can_submit = form.can_submit(creation_hold, edit_hold);
    let submit_btn = if can_submit {
        let submit_owner = scoped;
        layout::button_tx(submit_label, false, move |s: &mut S, tx| {
            if let Some(p) = submit_owner.get(s).0 {
                p.submit_editor();
                tx.instant();
            }
        })
        .key("mission-editor-submit")
    } else {
        layout::focusable_disabled_button(submit_label).key("mission-editor-submit")
    };
    actions = actions.child(submit_btn);

    content = content.child(actions);

    col()
        .key("mission-editor")
        .role("region")
        .label(heading)
        .full_width()
        .full_height()
        .reading_surface()
        .child(header)
        .child(theme::scroll().child(content))
}

fn counter(value: &str, max: usize) -> El {
    text(format!("{} / {max}", utf16_len(value))).text_role(TextRole::Label)
}
