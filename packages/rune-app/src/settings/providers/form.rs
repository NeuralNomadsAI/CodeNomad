//! Dynamic native provider authentication form fields (string, select, number, boolean, multiselect, external link).
use super::{Catalog, manager::PickerId};
use crate::strings::t;
use codenomad_client::settings::provider_auth::{
    FormField, FormFieldKind, is_field_visible, is_http_url,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn view<S: 'static>(
    catalog: &Catalog,
    fields: &[FormField],
    answers: &BTreeMap<String, Value>,
    disabled: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    let mut stack = col().full_width().separate(Space::Sm);
    for field in fields {
        if !is_field_visible(field, answers) {
            continue;
        }
        let field_key = field.key.clone();
        match &field.kind {
            FormFieldKind::External { url } if is_http_url(url) => {
                let target_url = url.clone();
                let fk = field_key.clone();
                let mut block = col().full_width().separate(Space::Xs).child(
                    layout::button_tx(&field.title, disabled, move |s: &mut S, tx| {
                        access(s)
                            .manager
                            .open_external_link(&fk, &target_url, tx, access);
                    })
                    .key(format!("provider-form-link-{}", field.key)),
                );
                if catalog.manager.external_link_failed(&field.key) {
                    block = block.child(text(t("toastHistory.openLinkError")).wrap().role("alert"));
                }
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                stack = stack.child(block);
            }
            FormFieldKind::External { .. } => {}
            FormFieldKind::Boolean { .. } => {
                let checked = answers.get(&field.key).and_then(Value::as_bool) == Some(true);
                let fk = field_key.clone();
                let control = chrome::checkbox_cell(
                    field.title.clone(),
                    checked,
                    disabled,
                    move |s: &mut S| {
                        access(s)
                            .manager
                            .set_form_value(&fk, Some(Value::Bool(!checked)));
                    },
                )
                .key(format!("provider-form-bool-{}", field.key));
                let mut block = col().full_width().separate(Space::Xs).child(
                    layout::action_row()
                        .child(control)
                        .child(text(&field.title).wrap()),
                );
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                stack = stack.child(block);
            }
            FormFieldKind::String {
                options, custom, ..
            } if !options.is_empty() && !*custom => {
                let picker_id = PickerId::FormField(field.key.clone());
                let current_val = answers.get(&field.key).and_then(Value::as_str);
                let raw_labels: Vec<String> = options.iter().map(|o| o.label.clone()).collect();
                let display_labels = super::manager::unique_labels(&raw_labels);
                let current_label = current_val.and_then(|v| {
                    options
                        .iter()
                        .position(|o| o.value == v)
                        .and_then(|idx| display_labels.get(idx))
                        .map(String::as_str)
                });
                let labels: Vec<&str> = display_labels.iter().map(String::as_str).collect();
                let pairs: Vec<(String, String)> = display_labels
                    .iter()
                    .zip(options.iter())
                    .map(|(disp, o)| (disp.clone(), o.value.clone()))
                    .collect();
                let pid_toggle = picker_id.clone();
                let pid_choose = picker_id.clone();
                let fk = field_key.clone();
                let control = chrome::picker(
                    &format!("provider-form-select-{}", field.key),
                    &field.title,
                    &labels,
                )
                .current(current_label.or(Some(t("settings.providers.prompt.selectPlaceholder"))))
                .disabled(disabled)
                .open(catalog.manager.open_picker.as_ref() == Some(&picker_id))
                .on_toggle(move |s: &mut S| access(s).manager.toggle_picker(pid_toggle.clone()))
                .on_close(move |s: &mut S| access(s).manager.close_picker())
                .on_choose(move |s: &mut S, chosen, _| {
                    let mgr = &mut access(s).manager;
                    if mgr.open_picker.as_ref() == Some(&pid_choose) {
                        mgr.close_picker();
                        if let Some((_, val)) = pairs.iter().find(|(disp, _)| disp == chosen) {
                            mgr.set_form_value(&fk, Some(Value::String(val.clone())));
                        }
                    }
                });
                let mut block = col()
                    .full_width()
                    .separate(Space::Xs)
                    .child(text(&field.title).text_role(TextRole::Label))
                    .child(chrome::build_picker(control, layers));
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                stack = stack.child(block);
            }
            FormFieldKind::String { placeholder, .. } => {
                let edit_model = catalog.manager.form_text_edit(&field.key);
                let hint = placeholder.as_deref().unwrap_or("");
                let fk = field_key.clone();
                let input = layout::hinted_field(edit_model, hint)
                    .label(&field.title)
                    .disabled(disabled)
                    .on_edit(move |s: &mut S| access(s).manager.form_text_edit_mut(&fk))
                    .build(&field_kit(layout::dark()))
                    .literal_direction()
                    .key(format!("provider-form-text-{}", field.key));
                let mut block = col()
                    .full_width()
                    .separate(Space::Xs)
                    .child(text(&field.title).text_role(TextRole::Label))
                    .child(input);
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                stack = stack.child(block);
            }
            FormFieldKind::Number { .. } => {
                let edit_model = catalog.manager.form_text_edit(&field.key);
                let fk = field_key.clone();
                let input = layout::literal_field(edit_model)
                    .label(&field.title)
                    .disabled(disabled)
                    .on_edit(move |s: &mut S| access(s).manager.form_text_edit_mut(&fk))
                    .build(&field_kit(layout::dark()))
                    .literal_direction()
                    .key(format!("provider-form-num-{}", field.key));
                let mut block = col()
                    .full_width()
                    .separate(Space::Xs)
                    .child(text(&field.title).text_role(TextRole::Label))
                    .child(input);
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                stack = stack.child(block);
            }
            FormFieldKind::Multiselect {
                options, custom, ..
            } => {
                let current: Vec<String> = answers
                    .get(&field.key)
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut block = col()
                    .full_width()
                    .separate(Space::Xs)
                    .child(text(&field.title).text_role(TextRole::Label));
                if let Some(desc) = &field.description {
                    block = block.child(text(desc).wrap().text_role(TextRole::Small));
                }
                for opt in options {
                    let is_selected = current.contains(&opt.value);
                    let fk = field_key.clone();
                    let val = opt.value.clone();
                    let box_el = chrome::checkbox_cell(
                        opt.label.clone(),
                        is_selected,
                        disabled,
                        move |s: &mut S| {
                            access(s).manager.toggle_multiselect_option(&fk, &val);
                        },
                    )
                    .key(format!("provider-form-multi-{}-{}", field.key, opt.value));
                    block = block.child(
                        layout::action_row()
                            .child(box_el)
                            .child(text(&opt.label).wrap()),
                    );
                }
                if *custom {
                    let edit_model = catalog.manager.form_text_edit(&field.key);
                    let fk = field_key.clone();
                    let input = layout::hinted_field(
                        edit_model,
                        t("settings.providers.prompt.customValuesPlaceholder"),
                    )
                    .label(&field.title)
                    .disabled(disabled)
                    .on_edit(move |s: &mut S| access(s).manager.form_text_edit_mut(&fk))
                    .build(&field_kit(layout::dark()))
                    .literal_direction()
                    .key(format!("provider-form-custom-{}", field.key));
                    block = block.child(input);
                }
                stack = stack.child(block);
            }
        }
    }
    stack
}

pub(super) fn effective_answers(
    fields: &[FormField],
    answers: &BTreeMap<String, Value>,
    edits: &BTreeMap<String, rune::TextEdit>,
    touched: &BTreeSet<String>,
) -> BTreeMap<String, Value> {
    let mut merged = answers.clone();
    sync_text_edits_to_answers(fields, edits, touched, &mut merged);
    merged
}

pub(super) fn sync_text_edits_to_answers(
    fields: &[FormField],
    edits: &BTreeMap<String, rune::TextEdit>,
    touched: &BTreeSet<String>,
    answers: &mut BTreeMap<String, Value>,
) {
    for field in fields {
        let Some(edit) = edits.get(&field.key) else {
            continue;
        };
        let is_touched = touched.contains(&field.key);
        match &field.kind {
            FormFieldKind::String {
                options, custom, ..
            } if options.is_empty() || *custom => {
                if edit.text.is_empty() && !is_touched && !answers.contains_key(&field.key) {
                    continue;
                }
                answers.insert(field.key.clone(), Value::String(edit.text.clone()));
            }
            FormFieldKind::Number { integer, .. } => {
                let trimmed = edit.text.trim();
                if trimmed.is_empty() {
                    answers.remove(&field.key);
                } else if *integer {
                    if let Ok(v) = trimmed.parse::<i64>() {
                        answers.insert(field.key.clone(), json!(v));
                    } else {
                        answers.insert(field.key.clone(), Value::Null);
                    }
                } else if let Ok(v) = trimmed.parse::<f64>()
                    && v.is_finite()
                {
                    answers.insert(field.key.clone(), json!(v));
                } else {
                    answers.insert(field.key.clone(), Value::Null);
                }
            }
            FormFieldKind::Multiselect {
                options,
                custom: true,
                ..
            } => {
                let had_key = answers.contains_key(&field.key);
                let option_values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                let mut merged: Vec<String> = answers
                    .get(&field.key)
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter(|s| option_values.contains(s))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                for part in edit.text.split(',') {
                    let trimmed = part.trim();
                    if !trimmed.is_empty() && !merged.iter().any(|existing| existing == trimmed) {
                        merged.push(trimmed.to_owned());
                    }
                }
                if merged.is_empty() && !is_touched && !had_key {
                    continue;
                }
                answers.insert(field.key.clone(), json!(merged));
            }
            _ => {}
        }
    }
}
