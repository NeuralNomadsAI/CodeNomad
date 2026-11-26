use crate::{
    State,
    agent_api::Form,
    agent_forms,
    components::button,
    strings::{locale, t},
};
use rune::{El, col};
use rune_theme_codenomad::{Space, catalogue, form_controls, layout::Layout};

fn format_bound(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

fn format_items_limit(prefix: &str, count: u64) -> String {
    let loc = locale();
    let count_str = count.to_string();
    let item_key = if count == 1 {
        "newTab.items.one"
    } else {
        "newTab.items.other"
    };
    let items = catalogue::format(loc, item_key, &[("count", &count_str)]);
    let limit = format!("{prefix} {items}");
    catalogue::format(
        loc,
        "toolCall.renderer.read.detail.limit",
        &[("limit", &limit)],
    )
}

fn validation_message(err: &agent_forms::ValidationError) -> String {
    let loc = locale();
    match err {
        agent_forms::ValidationError::Unsupported => t("rune.unsupported_question").to_string(),
        agent_forms::ValidationError::Required => t("formRequest.errors.validation").to_string(),
        agent_forms::ValidationError::SelectDeclaredOption => {
            t("formRequest.selectPlaceholder").to_string()
        }
        agent_forms::ValidationError::TooShort { min } => {
            let limit = format!("≥ {min}");
            catalogue::format(
                loc,
                "toolCall.renderer.read.detail.limit",
                &[("limit", &limit)],
            )
        }
        agent_forms::ValidationError::TooLong { max } => {
            let limit = format!("≤ {max}");
            catalogue::format(
                loc,
                "toolCall.renderer.read.detail.limit",
                &[("limit", &limit)],
            )
        }
        agent_forms::ValidationError::BelowMin { min } => {
            let limit = format!("≥ {}", format_bound(*min));
            catalogue::format(
                loc,
                "toolCall.renderer.read.detail.limit",
                &[("limit", &limit)],
            )
        }
        agent_forms::ValidationError::AboveMax { max } => {
            let limit = format!("≤ {}", format_bound(*max));
            catalogue::format(
                loc,
                "toolCall.renderer.read.detail.limit",
                &[("limit", &limit)],
            )
        }
        agent_forms::ValidationError::TooFewItems { min } => format_items_limit("≥", *min),
        agent_forms::ValidationError::TooManyItems { max } => format_items_limit("≤", *max),
        agent_forms::ValidationError::NotNumber | agent_forms::ValidationError::NotInteger => {
            t("toolCall.renderer.toolName.invalid").to_string()
        }
    }
}

fn join_notes(parts: &[Option<&str>]) -> Option<String> {
    let joined: Vec<&str> = parts
        .iter()
        .flatten()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    (!joined.is_empty()).then(|| joined.join(" · "))
}

fn field_title(field: &serde_json::Value) -> Option<&str> {
    field["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
}

fn field_description(field: &serde_json::Value) -> Option<&str> {
    field["description"]
        .as_str()
        .map(str::trim)
        .filter(|desc| !desc.is_empty())
}

fn field_caption(
    field: &serde_json::Value,
    form: &Form,
    visible_count: usize,
    untitled_count: usize,
    untitled_ordinal: usize,
) -> (String, bool) {
    if let Some(title) = field_title(field) {
        return (title.to_string(), true);
    }
    let form_title = form.title.trim();
    if visible_count == 1 && !form_title.is_empty() {
        return (form_title.to_string(), false);
    }
    if untitled_count > 1 {
        return (
            format!("{} {untitled_ordinal}", t("question-receipt.answer")),
            true,
        );
    }
    (t("question-receipt.answer").to_string(), true)
}

fn option_label(option: agent_forms::NormalizedOption<'_>, index: usize) -> String {
    option
        .label
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} {}", t("question-receipt.answer"), index + 1))
}

pub fn fields(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let locked = a.forms_mutating();
    let supported = agent_forms::supported(form);
    let values = agent_forms::values(form, &a.drafts);
    let has_unanswerable_active = form
        .fields
        .iter()
        .any(|f| agent_forms::active(f, &values) && agent_forms::field_unanswerable(f));
    let visible: Vec<&serde_json::Value> = form
        .fields
        .iter()
        .filter(|f| f["hidden"] != true && agent_forms::active(f, &values))
        .collect();
    let visible_count = visible.len();
    let header_required = visible_count == 1
        && field_title(visible[0]).is_none()
        && !form.title.trim().is_empty()
        && agent_forms::field_required(visible[0]);
    let mut body = col()
        .full_width()
        .separate(Space::Sm)
        .child(form_controls::form_header(
            t("permissionApproval.kind.question"),
            &form.title,
            header_required,
        ));
    if !supported || has_unanswerable_active {
        body = body.child(form_controls::form_error(t("rune.unsupported_question")))
    }
    let untitled_count = visible.iter().filter(|f| field_title(f).is_none()).count();
    let mut untitled_ordinal = 0usize;
    for field in visible {
        let key = field["key"].as_str().unwrap_or_default();
        let identity = (form.id.clone(), key.to_string());
        let Some(d) = a.drafts.get(&identity) else {
            continue;
        };
        if field_title(field).is_none() {
            untitled_ordinal += 1;
        }
        let required = agent_forms::field_required(field);
        let (field_name, show_heading) =
            field_caption(field, form, visible_count, untitled_count, untitled_ordinal);
        let field_desc = field_description(field);
        if show_heading {
            body = body.child(form_controls::field_heading(&field_name, required));
        }
        if let Some(desc) = field_desc {
            body = body.child(form_controls::field_description(desc));
        }
        let group_key = agent_forms::field_group_key(key);
        let container_key = format!("field-body:{}:{key}", key.len());
        let error_key = format!("field-error:{}:{key}", key.len());
        let validation_error = agent_forms::visible_validation_error(field, d);
        let error_text = validation_error.as_ref().map(validation_message);
        let is_invalid = error_text.is_some();
        match field["type"].as_str() {
            Some("boolean") => {
                const CHOICES: [(&str, &str); 2] = [("rune.yes", "true"), ("rune.no", "false")];
                let group_desc = join_notes(&[field_desc, error_text.as_deref()]);
                let items = CHOICES
                    .iter()
                    .enumerate()
                    .map(|(index, &(label_key, value))| {
                        let id = identity.clone();
                        form_controls::radio_option(
                            &agent_forms::bool_option_key(key, value),
                            t(label_key),
                            None,
                            error_text.as_deref(),
                            d.edit.text == value,
                            locked,
                            false,
                            (index + 1, CHOICES.len()),
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(d) = s
                                    .agent
                                    .as_mut()
                                    .filter(|a| !a.forms_mutating())
                                    .and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.choose(value)
                                }
                            }),
                        )
                    })
                    .collect();
                body = body.child(form_controls::radio_group(
                    &group_key,
                    &field_name,
                    group_desc.as_deref(),
                    true,
                    required,
                    is_invalid,
                    items,
                ));
                if let Some(msg) = &error_text {
                    body = body.child(form_controls::field_error(&error_key, msg));
                }
            }
            Some("string") if agent_forms::has_declared_options(field) => {
                let valid = agent_forms::normalized_options(field);
                let allow_custom = field["custom"] == true;
                let custom_active = allow_custom && !d.custom.text.is_empty();
                let custom_conflict =
                    validation_error == Some(agent_forms::ValidationError::SelectDeclaredOption);
                let has_choice = !custom_active && d.choice.is_some();
                let shared_required = required && !valid.is_empty() && allow_custom;
                let req_note = shared_required.then(|| t("toolCall.question.status.required"));
                let custom_invalid = custom_conflict
                    || (allow_custom && (valid.is_empty() || custom_active) && is_invalid);
                let radio_invalid =
                    !valid.is_empty() && is_invalid && !custom_conflict && !custom_active;
                let radio_note = join_notes(&[
                    req_note,
                    radio_invalid.then_some(error_text.as_deref()).flatten(),
                ]);
                let radio_group_desc = join_notes(&[
                    field_desc,
                    req_note,
                    radio_invalid.then_some(error_text.as_deref()).flatten(),
                ]);
                let mut children = Vec::new();
                if !valid.is_empty() {
                    let total = valid.len();
                    let items = valid
                        .iter()
                        .enumerate()
                        .map(|(index, option)| {
                            let label = option_label(*option, index);
                            let selected =
                                !custom_active && d.choice.as_deref() == Some(option.value);
                            let value = option.value.to_string();
                            let id = identity.clone();
                            form_controls::radio_option(
                                &agent_forms::string_option_key(key, &value),
                                &label,
                                option.description,
                                radio_note.as_deref(),
                                selected,
                                locked,
                                true,
                                (index + 1, total),
                                crate::screen::action(&scope, move |s: &mut State| {
                                    if let Some(d) = s
                                        .agent
                                        .as_mut()
                                        .filter(|a| !a.forms_mutating())
                                        .and_then(|a| a.drafts.get_mut(&id))
                                    {
                                        d.choose_option(&value)
                                    }
                                }),
                            )
                        })
                        .collect();
                    children.push(form_controls::radio_group(
                        &group_key,
                        &field_name,
                        radio_group_desc.as_deref(),
                        false,
                        required && !shared_required,
                        radio_invalid,
                        items,
                    ));
                    if field["required"] != true {
                        let id = identity.clone();
                        let clear_label = t("sessionList.selection.clearLabel");
                        let clear_accessible = format!("{field_name} · {clear_label}");
                        children.push(form_controls::clear_choice_button(
                            &agent_forms::clear_option_key(key),
                            clear_label,
                            &clear_accessible,
                            locked || !has_choice,
                            crate::screen::action_tx(&scope, move |s: &mut State, tx| {
                                if let Some(d) = s
                                    .agent
                                    .as_mut()
                                    .filter(|a| !a.forms_mutating())
                                    .and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.clear_choice();
                                    tx.focus(form_controls::FORM_FOCUS_ANCHOR, tx.focus_visible());
                                }
                            }),
                        ));
                    }
                }
                if allow_custom {
                    let id = identity.clone();
                    let custom_label = if !valid.is_empty() {
                        format!("{field_name} · {}", t("rune.other_values"))
                    } else {
                        field_name.clone()
                    };
                    let custom_desc = join_notes(&[
                        field_desc,
                        req_note,
                        custom_invalid.then_some(error_text.as_deref()).flatten(),
                    ]);
                    children.push(form_controls::form_textarea(
                        &format!("custom-{key}"),
                        &d.custom,
                        &custom_label,
                        custom_desc.as_deref(),
                        locked,
                        required && valid.is_empty(),
                        custom_invalid,
                        crate::screen::edit(&scope, crate::screen::Editor::Custom(id)),
                    ));
                }
                if let Some(msg) = &error_text {
                    children.push(form_controls::field_error(&error_key, msg));
                }
                let container_desc = join_notes(&[field_desc, req_note, error_text.as_deref()]);
                body = body.child(form_controls::field_container(
                    &container_key,
                    &field_name,
                    container_desc.as_deref(),
                    shared_required,
                    children,
                ));
            }
            Some("string" | "number" | "integer") => {
                let id = identity.clone();
                let editor_desc = join_notes(&[field_desc, error_text.as_deref()]);
                body = body.child(form_controls::form_textarea(
                    &format!("field-{key}"),
                    &d.edit,
                    &field_name,
                    editor_desc.as_deref(),
                    locked,
                    required,
                    is_invalid,
                    crate::screen::edit(&scope, crate::screen::Editor::Form(id)),
                ));
                if let Some(msg) = &error_text {
                    body = body.child(form_controls::field_error(&error_key, msg));
                }
            }
            Some("multiselect") => {
                let valid = agent_forms::normalized_options(field);
                let allow_custom = field["custom"] == true;
                let has_choices =
                    !valid.is_empty() || (allow_custom && !d.preserved_custom.is_empty());
                let shared_required = required && has_choices && allow_custom;
                let req_note =
                    (required && has_choices).then(|| t("toolCall.question.status.required"));
                let choice_note = join_notes(&[req_note, error_text.as_deref()]);
                let group_desc = join_notes(&[field_desc, req_note, error_text.as_deref()]);
                let mut items: Vec<El> = valid
                    .into_iter()
                    .enumerate()
                    .map(|(index, option)| {
                        let label = option_label(option, index);
                        let checked = d.selected.contains(option.value);
                        let value = option.value.to_string();
                        let id = identity.clone();
                        form_controls::checkbox_option(
                            &agent_forms::multi_option_key(key, &value),
                            &label,
                            option.description,
                            choice_note.as_deref(),
                            checked,
                            locked,
                            is_invalid,
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(d) = s
                                    .agent
                                    .as_mut()
                                    .filter(|a| !a.forms_mutating())
                                    .and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.toggle(&value)
                                }
                            }),
                        )
                    })
                    .collect();
                if allow_custom {
                    for raw in &d.preserved_custom {
                        let checked = d.preserved_custom_selected.contains(raw);
                        let value = raw.clone();
                        let id = identity.clone();
                        items.push(form_controls::checkbox_option(
                            &agent_forms::multi_option_key(key, raw),
                            raw,
                            None,
                            choice_note.as_deref(),
                            checked,
                            locked,
                            is_invalid,
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(d) = s
                                    .agent
                                    .as_mut()
                                    .filter(|a| !a.forms_mutating())
                                    .and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.toggle_preserved_custom(&value)
                                }
                            }),
                        ));
                    }
                }
                let mut children = Vec::new();
                if has_choices {
                    children.push(form_controls::checkbox_group(
                        &group_key,
                        &field_name,
                        group_desc.as_deref(),
                        items,
                    ));
                }
                if allow_custom {
                    let id = identity.clone();
                    let custom_label = if has_choices {
                        format!("{field_name} · {}", t("rune.other_values"))
                    } else {
                        field_name.clone()
                    };
                    let custom_desc = join_notes(&[
                        field_desc,
                        shared_required.then(|| t("toolCall.question.status.required")),
                        error_text.as_deref(),
                    ]);
                    children.push(form_controls::form_textarea(
                        &format!("custom-{key}"),
                        &d.custom,
                        &custom_label,
                        custom_desc.as_deref(),
                        locked,
                        required && !has_choices,
                        is_invalid,
                        crate::screen::edit(&scope, crate::screen::Editor::Custom(id)),
                    ));
                }
                if let Some(msg) = &error_text {
                    children.push(form_controls::field_error(&error_key, msg));
                }
                body = body.child(form_controls::field_container(
                    &container_key,
                    &field_name,
                    group_desc.as_deref(),
                    shared_required,
                    children,
                ));
            }
            _ => {}
        }
    }
    body
}
pub fn actions(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let id = form.id.clone();
    let cancel = id.clone();
    rune_theme_codenomad::layout::action_row()
        .separate(Space::Sm)
        .child(button(
            "answer-question",
            t("rune.answer"),
            a.forms_locked() || agent_forms::answer(form, &a.drafts).is_err(),
            crate::screen::action(&scope, move |s: &mut State| {
                if let Some(a) = s.agent.as_mut() {
                    a.answer_form(&id)
                }
            }),
        ))
        .child(button(
            "cancel-question",
            t("rune.cancel_question"),
            a.forms_locked(),
            crate::screen::action(&scope, move |s: &mut State| {
                if let Some(a) = s.agent.as_mut() {
                    a.cancel_form(cancel.clone())
                }
            }),
        ))
}
