use crate::{State, agent_api::Form, agent_forms, components::button, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, field_kit, form_controls,
    layout::{self, Layout, textarea},
};

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
    let mut body = col()
        .full_width()
        .separate(Space::Sm)
        .child(text(t("permissionApproval.kind.question")))
        .child(text(&form.title).wrap());
    if !supported {
        body = body.child(text(t("rune.unsupported_question")))
    }
    let values = agent_forms::values(form, &a.drafts);
    let visible: Vec<(usize, &serde_json::Value)> = form
        .fields
        .iter()
        .enumerate()
        .filter(|(_, f)| f["hidden"] != true && agent_forms::active(f, &values))
        .collect();
    let visible_count = visible.len();
    let untitled_count = visible
        .iter()
        .filter(|(_, f)| field_title(f).is_none())
        .count();
    let mut untitled_ordinal = 0usize;
    for (field_index, field) in visible {
        let key = field["key"].as_str().unwrap_or_default();
        let identity = (form.id.clone(), key.to_string());
        let Some(d) = a.drafts.get(&identity) else {
            continue;
        };
        if field_title(field).is_none() {
            untitled_ordinal += 1;
        }
        let (field_name, show_heading) =
            field_caption(field, form, visible_count, untitled_count, untitled_ordinal);
        let field_desc = field_description(field);
        if show_heading {
            body = body.child(form_controls::field_heading(&field_name));
        }
        if let Some(desc) = field_desc {
            body = body.child(form_controls::field_description(desc));
        }
        let group_key = agent_forms::field_group_key(field_index);
        match field["type"].as_str() {
            Some("boolean") => {
                const CHOICES: [(&str, &str); 2] = [("rune.yes", "true"), ("rune.no", "false")];
                let items = CHOICES
                    .iter()
                    .enumerate()
                    .map(|(index, &(label_key, value))| {
                        let id = identity.clone();
                        form_controls::radio_option(
                            &agent_forms::bool_option_key(key, value),
                            t(label_key),
                            None,
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
                    field_desc,
                    true,
                    items,
                ));
            }
            Some("string" | "number" | "integer") => {
                let mut has_options = false;
                if field["type"] == "string" {
                    let valid = agent_forms::normalized_options(field);
                    if !valid.is_empty() {
                        has_options = true;
                        let total = valid.len();
                        let items = valid
                            .into_iter()
                            .enumerate()
                            .map(|(index, option)| {
                                let label = option_label(option, index);
                                let selected = d.edit.text == option.value;
                                let value = option.value.to_string();
                                let id = identity.clone();
                                form_controls::radio_option(
                                    &agent_forms::string_option_key(field_index, index),
                                    &label,
                                    option.description,
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
                                            d.choose(&value)
                                        }
                                    }),
                                )
                            })
                            .collect();
                        body = body.child(form_controls::radio_group(
                            &group_key,
                            &field_name,
                            field_desc,
                            false,
                            items,
                        ));
                    }
                }
                let id = identity.clone();
                let input_label = if has_options && field["custom"] == true {
                    format!("{field_name} · {}", t("rune.other_values"))
                } else {
                    field_name.clone()
                };
                let mut editor = textarea(&d.edit)
                    .label(input_label)
                    .disabled(locked)
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Form(id)));
                if let Some(desc) = field_desc {
                    editor = editor.description(desc);
                }
                body = body.child(
                    editor
                        .build(&field_kit(layout::dark()))
                        .key(format!("field-{key}")),
                );
            }
            Some("multiselect") => {
                let valid = agent_forms::normalized_options(field);
                if !valid.is_empty() {
                    let items: Vec<El> = valid
                        .into_iter()
                        .enumerate()
                        .map(|(index, option)| {
                            let label = option_label(option, index);
                            let checked = d.selected.contains(option.value);
                            let value = option.value.to_string();
                            let id = identity.clone();
                            form_controls::checkbox_option(
                                &agent_forms::multi_option_key(field_index, index),
                                &label,
                                option.description,
                                checked,
                                locked,
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
                    body = body.child(form_controls::checkbox_group(
                        &group_key,
                        &field_name,
                        field_desc,
                        items,
                    ));
                }
                if field["custom"] == true {
                    let id = identity.clone();
                    let custom_label = format!("{field_name} · {}", t("rune.other_values"));
                    let mut editor = textarea(&d.custom)
                        .label(custom_label)
                        .disabled(locked)
                        .on_edit(crate::screen::edit(
                            &scope,
                            crate::screen::Editor::Custom(id),
                        ));
                    if let Some(desc) = field_desc {
                        editor = editor.description(desc);
                    }
                    body = body.child(
                        editor
                            .build(&field_kit(layout::dark()))
                            .key(format!("custom-{key}")),
                    );
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
