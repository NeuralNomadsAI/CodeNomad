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
        agent_forms::ValidationError::NotNumber
        | agent_forms::ValidationError::NotInteger
        | agent_forms::ValidationError::InvalidFormat => {
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

fn bounded_note(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[allow(clippy::too_many_arguments)]
fn bounded_option_description(
    scope: &std::rc::Rc<()>,
    identity: &(String, String),
    field_key: &str,
    option_value: &str,
    option_label: &str,
    raw_description: Option<&str>,
    reveals: usize,
    locked: bool,
    include_option_label: bool,
) -> (Option<String>, Option<El>) {
    let Some(raw) = raw_description else {
        return (None, None);
    };
    let (shown, hidden, next_step) = form_controls::option_description_window(raw, reveals);
    let button = (hidden > 0).then(|| {
        let loc = locale();
        let hidden_str = hidden.to_string();
        let status = catalogue::format(
            loc,
            if hidden == 1 {
                "messageBlock.hiddenText.one"
            } else {
                "messageBlock.hiddenText.other"
            },
            &[("count", &hidden_str)],
        );
        let reveal_text = if next_step == hidden {
            t("messageBlock.hiddenText.showAll").to_string()
        } else {
            let more_str = next_step.to_string();
            catalogue::format(
                loc,
                "messageBlock.hiddenText.showMore",
                &[("count", &more_str)],
            )
        };
        let short_label = bounded_note(option_label, 48);
        let visible_label = if include_option_label {
            format!("{short_label} · {reveal_text}")
        } else {
            reveal_text.clone()
        };
        let reveal_accessible = format!("{short_label} · {reveal_text} · {status}");
        let rid = identity.clone();
        let rval = option_value.to_string();
        form_controls::clear_choice_button(
            &agent_forms::option_desc_reveal_key(field_key, &rval),
            &visible_label,
            &reveal_accessible,
            locked,
            crate::screen::action_tx(scope, move |s: &mut State, _tx| {
                if let Some(d) = s
                    .agent
                    .as_mut()
                    .filter(|a| !a.forms_mutating())
                    .and_then(|a| a.drafts.get_mut(&rid))
                {
                    d.reveal_option_description(&rval);
                }
            }),
        )
    });
    (Some(shown), button)
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

fn is_websearch_provider_form(form: &Form) -> bool {
    if !form.infer_websearch || form.fields.len() != 1 {
        return false;
    }
    let field = &form.fields[0];
    if field["type"] != "string"
        || field["custom"] == true
        || field["hidden"] == true
        || field["required"] != true
    {
        return false;
    }
    let Some(options) = field["options"].as_array().filter(|opts| !opts.is_empty()) else {
        return false;
    };
    match field["key"].as_str() {
        Some("provider") => true,
        Some("choice") => {
            options.len() == 3
                && ["allow", "choose", "disable"]
                    .iter()
                    .all(|val| options.iter().any(|o| o["value"] == *val))
        }
        _ => false,
    }
}

fn form_display_title(form: &Form) -> &str {
    if is_websearch_provider_form(form) {
        t("toolCall.websearch.provider")
    } else {
        form.title.as_str()
    }
}

fn field_caption(
    field: &serde_json::Value,
    display_title: &str,
    visible_count: usize,
    untitled_count: usize,
    untitled_ordinal: usize,
) -> (String, bool) {
    if let Some(title) = field_title(field) {
        return (title.to_string(), true);
    }
    let form_title = display_title.trim();
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

pub fn form_panel(s: &State, form: &Form) -> (El, El) {
    let Some(a) = s.agent.as_ref() else {
        return (rune::el(), rune::el());
    };
    let eval = agent_forms::evaluate_form(form, &a.drafts);
    (
        fields_with_eval(s, form, &eval),
        actions_with_eval(s, form, eval.can_answer),
    )
}

pub fn fields(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let eval = agent_forms::evaluate_form(form, &a.drafts);
    fields_with_eval(s, form, &eval)
}

fn fields_with_eval(s: &State, form: &Form, eval: &agent_forms::FormEvaluation<'_>) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let locked = a.forms_mutating();
    let visible: Vec<(
        &serde_json::Value,
        &Result<Option<serde_json::Value>, agent_forms::ValidationError>,
    )> = eval
        .active
        .iter()
        .filter(|(f, _)| f["type"] == "external" || f["hidden"] != true)
        .map(|(f, res)| (*f, res))
        .collect();
    let display_title = form_display_title(form);
    let visible_count = visible.len();
    let header_required = visible_count == 1
        && field_title(visible[0].0).is_none()
        && !display_title.trim().is_empty()
        && agent_forms::field_required(visible[0].0);
    let mut body = col()
        .full_width()
        .separate(Space::Sm)
        .child(form_controls::form_header(
            t("permissionApproval.kind.question"),
            display_title,
            header_required,
        ));
    if !eval.supported || eval.has_unanswerable_active || eval.has_invalid_hidden_active {
        body = body.child(form_controls::form_error(t("rune.unsupported_question")))
    }
    let untitled_count = visible
        .iter()
        .filter(|(f, _)| field_title(f).is_none())
        .count();
    let mut untitled_ordinal = 0usize;
    for (field, field_result) in visible {
        let key = field["key"].as_str().unwrap_or_default();
        let identity = (form.id.clone(), key.to_string());
        let Some(d) = a.drafts.get(&identity) else {
            continue;
        };
        if field_title(field).is_none() {
            untitled_ordinal += 1;
        }
        let required = agent_forms::field_required(field);
        let (field_name, show_heading) = field_caption(
            field,
            display_title,
            visible_count,
            untitled_count,
            untitled_ordinal,
        );
        let field_desc = field_description(field);
        if show_heading {
            body = body.child(form_controls::field_heading(&field_name, required));
        }
        if let Some(desc) = field_desc {
            body = body.child(form_controls::field_description(desc));
        }
        let group_key = agent_forms::field_group_key(key);
        let container_key = agent_forms::field_container_key(key);
        let error_key = agent_forms::field_error_key(key);
        let validation_error = field_result
            .as_ref()
            .err()
            .and_then(|err| agent_forms::visible_validation_error_for(err, d));
        let error_text = validation_error.as_ref().map(validation_message);
        let is_invalid = error_text.is_some();
        let short_caption = bounded_note(&field_name, 160);
        let short_desc = field_desc.map(|desc| bounded_note(desc, 240));
        match field["type"].as_str() {
            Some("boolean") => {
                const CHOICES: [(&str, &str); 2] = [("rune.yes", "true"), ("rune.no", "false")];
                let req_note = required.then(|| t("toolCall.question.status.required"));
                let group_desc = join_notes(&[field_desc, error_text.as_deref()]);
                let option_note = join_notes(&[
                    Some(short_caption.as_str()),
                    short_desc.as_deref(),
                    req_note,
                    error_text.as_deref(),
                ]);
                let items = CHOICES
                    .iter()
                    .enumerate()
                    .map(|(index, &(label_key, value))| {
                        let id = identity.clone();
                        form_controls::radio_option(
                            &agent_forms::bool_option_key(key, value),
                            t(label_key),
                            None,
                            option_note.as_deref(),
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
                let has_answer = d.choice.is_some()
                    || (allow_custom
                        && (!d.custom.text.is_empty() || (!d.is_dirty() && d.has_string_value)));
                let shared_required = required && !valid.is_empty() && allow_custom;
                let req_note = required.then(|| t("toolCall.question.status.required"));
                let shared_req_note =
                    shared_required.then(|| t("toolCall.question.status.required"));
                let custom_invalid =
                    allow_custom && (valid.is_empty() || custom_active) && is_invalid;
                let radio_invalid = !valid.is_empty() && is_invalid && !custom_active;
                let radio_note = join_notes(&[
                    Some(short_caption.as_str()),
                    short_desc.as_deref(),
                    req_note,
                    radio_invalid.then_some(error_text.as_deref()).flatten(),
                ]);
                let radio_group_desc = join_notes(&[
                    field_desc,
                    shared_req_note,
                    radio_invalid.then_some(error_text.as_deref()).flatten(),
                ]);
                let mut children = Vec::new();
                if !valid.is_empty() {
                    let total = valid.len();
                    let mut reveal_buttons = Vec::new();
                    let items = valid
                        .iter()
                        .enumerate()
                        .map(|(index, option)| {
                            let label = option_label(*option, index);
                            let selected = (!custom_active
                                && d.choice.as_deref() == Some(option.value))
                                || (custom_active && d.custom.text == option.value);
                            let value = option.value.to_string();
                            let id = identity.clone();
                            let (shown_desc, reveal_button) = bounded_option_description(
                                &scope,
                                &identity,
                                key,
                                option.value,
                                &label,
                                option.description,
                                d.option_description_reveals(option.value),
                                locked,
                                true,
                            );
                            if let Some(btn) = reveal_button {
                                reveal_buttons.push(btn);
                            }
                            form_controls::radio_option(
                                &agent_forms::string_option_key(key, &value),
                                &label,
                                shown_desc.as_deref(),
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
                    children.extend(reveal_buttons);
                    if field["required"] != true {
                        let id = identity.clone();
                        let first_option_key = agent_forms::string_option_key(key, valid[0].value);
                        let clear_label = t("sessionList.selection.clearLabel");
                        let clear_accessible = format!("{field_name} · {clear_label}");
                        children.push(form_controls::clear_choice_button(
                            &agent_forms::clear_option_key(key),
                            clear_label,
                            &clear_accessible,
                            locked || !has_answer,
                            crate::screen::action_tx(&scope, move |s: &mut State, tx| {
                                if let Some(d) = s
                                    .agent
                                    .as_mut()
                                    .filter(|a| !a.forms_mutating())
                                    .and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.clear_choice();
                                    tx.focus(first_option_key.clone(), tx.focus_visible());
                                }
                            }),
                        ));
                    }
                }
                if allow_custom {
                    let id = identity.clone();
                    if !valid.is_empty() {
                        children.push(form_controls::field_description(t("rune.other_values")));
                    }
                    let custom_label = if !valid.is_empty() {
                        format!("{field_name} · {}", t("rune.other_values"))
                    } else {
                        field_name.clone()
                    };
                    let custom_desc = join_notes(&[
                        field_desc,
                        shared_req_note,
                        custom_invalid.then_some(error_text.as_deref()).flatten(),
                    ]);
                    children.push(form_controls::form_textarea(
                        &agent_forms::custom_editor_key(key),
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
                let container_desc = join_notes(&[shared_req_note, error_text.as_deref()]);
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
                    &agent_forms::field_editor_key(key),
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
                let checkbox_invalid = is_invalid;
                let req_note =
                    (required && has_choices).then(|| t("toolCall.question.status.required"));
                let choice_note = join_notes(&[
                    Some(short_caption.as_str()),
                    short_desc.as_deref(),
                    req_note,
                    checkbox_invalid.then_some(error_text.as_deref()).flatten(),
                ]);
                let group_desc = join_notes(&[field_desc, req_note, error_text.as_deref()]);
                let container_desc = join_notes(&[
                    (!has_choices).then_some(field_desc).flatten(),
                    req_note,
                    error_text.as_deref(),
                ]);
                let custom_checked = if allow_custom {
                    d.custom_multiselect_values()
                } else {
                    std::collections::HashSet::new()
                };
                let multi_locked = locked || d.oversized_multiselect_default;
                let mut items: Vec<El> = Vec::new();
                for (index, option) in valid.into_iter().enumerate() {
                    let label = option_label(option, index);
                    let checked = d.selected.contains(option.value)
                        || (!option.value.is_empty() && custom_checked.contains(option.value));
                    let value = option.value.to_string();
                    let id = identity.clone();
                    let (shown_desc, reveal_button) = bounded_option_description(
                        &scope,
                        &identity,
                        key,
                        option.value,
                        &label,
                        option.description,
                        d.option_description_reveals(option.value),
                        locked,
                        false,
                    );
                    items.push(form_controls::checkbox_option(
                        &agent_forms::multi_option_key(key, &value),
                        &label,
                        shown_desc.as_deref(),
                        choice_note.as_deref(),
                        checked,
                        multi_locked,
                        checkbox_invalid,
                        crate::screen::action(&scope, move |s: &mut State| {
                            if let Some(a) = s.agent.as_mut().filter(|a| !a.forms_mutating()) {
                                if let Some(d) = a.drafts.get_mut(&id)
                                    && (d.custom.focused || d.custom_was_focused)
                                {
                                    d.custom.focused = false;
                                    d.custom_was_focused = true;
                                }
                                a.reconcile_custom_focus();
                                if let Some(d) = a.drafts.get_mut(&id) {
                                    d.toggle(&value)
                                }
                            }
                        }),
                    ));
                    if let Some(btn) = reveal_button {
                        items.push(btn);
                    }
                }
                if allow_custom {
                    for (index, raw) in d.preserved_custom.iter().take(64).enumerate() {
                        let checked = d.preserved_custom_selected.contains(raw);
                        let value = raw.clone();
                        let label = if raw.trim().is_empty()
                            || super::string_constraints::trim_es(raw).is_empty()
                        {
                            format!("{} {}", t("rune.other_values"), index + 1)
                        } else {
                            raw.clone()
                        };
                        let id = identity.clone();
                        items.push(form_controls::checkbox_option(
                            &agent_forms::multi_option_key(key, raw),
                            &label,
                            None,
                            choice_note.as_deref(),
                            checked,
                            multi_locked,
                            checkbox_invalid,
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(a) = s.agent.as_mut().filter(|a| !a.forms_mutating()) {
                                    if let Some(d) = a.drafts.get_mut(&id)
                                        && (d.custom.focused || d.custom_was_focused)
                                    {
                                        d.custom.focused = false;
                                        d.custom_was_focused = true;
                                    }
                                    a.reconcile_custom_focus();
                                    if let Some(d) = a.drafts.get_mut(&id) {
                                        d.toggle_preserved_custom(&value)
                                    }
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
                if d.oversized_multiselect_default {
                    let clear_id = identity.clone();
                    let clear_label = t("sessionList.selection.clearLabel");
                    let clear_accessible = format!("{field_name} · {clear_label}");
                    children.push(form_controls::clear_choice_button(
                        &agent_forms::clear_option_key(key),
                        clear_label,
                        &clear_accessible,
                        locked,
                        crate::screen::action_tx(&scope, move |s: &mut State, _tx| {
                            if let Some(d) = s
                                .agent
                                .as_mut()
                                .filter(|a| !a.forms_mutating())
                                .and_then(|a| a.drafts.get_mut(&clear_id))
                            {
                                d.clear_multiselect();
                            }
                        }),
                    ));
                }
                if allow_custom {
                    let id = identity.clone();
                    let custom_hint = t("formRequest.customValuesPlaceholder");
                    children.push(form_controls::field_description(custom_hint));
                    let custom_label = if has_choices {
                        format!("{field_name} · {}", t("rune.other_values"))
                    } else {
                        field_name.clone()
                    };
                    let custom_desc = join_notes(&[
                        field_desc,
                        Some(custom_hint),
                        shared_required.then(|| t("toolCall.question.status.required")),
                        error_text.as_deref(),
                    ]);
                    children.push(form_controls::form_textarea(
                        &agent_forms::custom_editor_key(key),
                        &d.custom,
                        &custom_label,
                        custom_desc.as_deref(),
                        multi_locked,
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
                    container_desc.as_deref(),
                    shared_required,
                    children,
                ));
            }
            Some("external") => {
                if let Some(url) = agent_forms::external_url(field) {
                    let req_note = Some(t("toolCall.question.status.required"));
                    let link_label = t("formRequest.openExternal");
                    let link_accessible = format!("{field_name} · {link_label}");
                    let ack_label = t("alertDialog.actions.confirm");
                    let ack_note = join_notes(&[
                        Some(short_caption.as_str()),
                        short_desc.as_deref(),
                        req_note,
                        error_text.as_deref(),
                    ]);
                    let container_desc = join_notes(&[field_desc, req_note, error_text.as_deref()]);
                    let link_id = identity.clone();
                    let link_scope = scope.clone();
                    let link_url = url.clone();
                    let ack_id = identity.clone();
                    let mut children = Vec::new();
                    children.push(form_controls::clear_choice_button(
                        &agent_forms::external_link_key(key),
                        link_label,
                        &link_accessible,
                        locked,
                        crate::screen::action_tx(&scope, move |s: &mut State, tx| {
                            let Some(seq) = s
                                .agent
                                .as_mut()
                                .filter(|a| !a.forms_mutating())
                                .and_then(|a| a.drafts.get_mut(&link_id))
                                .map(|d| {
                                    d.external_link_seq = d.external_link_seq.wrapping_add(1);
                                    d.external_link_failed = false;
                                    d.external_link_seq
                                })
                            else {
                                return;
                            };
                            let cb_id = link_id.clone();
                            let cb_scope = link_scope.clone();
                            if tx
                                .open_url_then(&link_url, move |s: &mut State, result, _| {
                                    if s.current_scope(&cb_scope)
                                        && let Some(d) =
                                            s.agent.as_mut().and_then(|a| a.drafts.get_mut(&cb_id))
                                        && d.external_link_seq == seq
                                    {
                                        d.external_link_failed = result.is_err();
                                    }
                                })
                                .is_err()
                                && let Some(d) =
                                    s.agent.as_mut().and_then(|a| a.drafts.get_mut(&link_id))
                                && d.external_link_seq == seq
                            {
                                d.external_link_failed = true;
                            }
                        }),
                    ));
                    if d.external_link_failed {
                        children.push(form_controls::field_error(
                            &format!("{error_key}:link"),
                            t("toastHistory.openLinkError"),
                        ));
                    }
                    children.push(form_controls::checkbox_option(
                        &agent_forms::external_ack_key(key),
                        ack_label,
                        None,
                        ack_note.as_deref(),
                        d.external_acknowledged,
                        locked,
                        is_invalid,
                        crate::screen::action(&scope, move |s: &mut State| {
                            if let Some(d) = s
                                .agent
                                .as_mut()
                                .filter(|a| !a.forms_mutating())
                                .and_then(|a| a.drafts.get_mut(&ack_id))
                            {
                                d.toggle_external_acknowledged();
                            }
                        }),
                    ));
                    if let Some(msg) = &error_text {
                        children.push(form_controls::field_error(&error_key, msg));
                    }
                    body = body.child(form_controls::field_container(
                        &container_key,
                        &field_name,
                        container_desc.as_deref(),
                        true,
                        children,
                    ));
                }
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
    let can_answer = agent_forms::answer(form, &a.drafts).is_ok();
    actions_with_eval(s, form, can_answer)
}

fn actions_with_eval(s: &State, form: &Form, can_answer: bool) -> El {
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
            a.forms_locked() || !can_answer,
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
