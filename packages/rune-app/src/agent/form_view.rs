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

fn field_accessible_name<'a>(
    field: &'a serde_json::Value,
    form: &'a Form,
    visible_fields: usize,
) -> &'a str {
    if let Some(title) = field_title(field) {
        return title;
    }
    let form_title = form.title.trim();
    if visible_fields == 1 && !form_title.is_empty() {
        return form_title;
    }
    t("question-receipt.answer")
}

pub fn fields(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
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
    let visible: Vec<&serde_json::Value> = form
        .fields
        .iter()
        .filter(|f| f["hidden"] != true && agent_forms::active(f, &values))
        .collect();
    let visible_count = visible.len();
    for field in visible {
        let key = field["key"].as_str().unwrap_or_default();
        let identity = (form.id.clone(), key.to_string());
        let Some(d) = a.drafts.get(&identity) else {
            continue;
        };
        let explicit_title = field_title(field);
        let field_name = field_accessible_name(field, form, visible_count);
        let field_desc = field_description(field);
        if let Some(title) = explicit_title {
            body = body.child(text(title).wrap());
        }
        match field["type"].as_str() {
            Some("boolean") => {
                const CHOICES: [(&str, &str); 2] = [("rune.yes", "true"), ("rune.no", "false")];
                let items = CHOICES
                    .iter()
                    .enumerate()
                    .map(|(index, &(label_key, value))| {
                        let id = identity.clone();
                        form_controls::radio_option(
                            &format!("bool-{key}-{value}"),
                            t(label_key),
                            None,
                            d.edit.text == value,
                            a.busy,
                            false,
                            (index + 1, CHOICES.len()),
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(d) =
                                    s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.choose(value)
                                }
                            }),
                        )
                    })
                    .collect();
                body = body.child(form_controls::radio_group(
                    field_name, field_desc, true, items,
                ));
            }
            Some("string" | "number" | "integer") => {
                let mut has_options = false;
                if field["type"] == "string"
                    && let Some(options) = field["options"].as_array()
                {
                    let valid: Vec<(&str, &str, Option<&str>)> = options
                        .iter()
                        .take(64)
                        .filter_map(|option| {
                            let value = option["value"].as_str()?;
                            let label = option["label"]
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(value);
                            let desc = option["description"]
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            Some((value, label, desc))
                        })
                        .collect();
                    if !valid.is_empty() {
                        has_options = true;
                        let total = valid.len();
                        let items = valid
                            .into_iter()
                            .enumerate()
                            .map(|(index, (value, label, desc))| {
                                let selected = d.edit.text == value;
                                let value = value.to_string();
                                let id = identity.clone();
                                form_controls::radio_option(
                                    &format!("option-{key}-{value}"),
                                    label,
                                    desc,
                                    selected,
                                    a.busy,
                                    true,
                                    (index + 1, total),
                                    crate::screen::action(&scope, move |s: &mut State| {
                                        if let Some(d) =
                                            s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                        {
                                            d.choose(&value)
                                        }
                                    }),
                                )
                            })
                            .collect();
                        body = body.child(form_controls::radio_group(
                            field_name, field_desc, false, items,
                        ));
                    }
                }
                let id = identity.clone();
                let input_label = if has_options && field["custom"] == true {
                    format!("{field_name} · {}", t("rune.other_values"))
                } else {
                    field_name.to_string()
                };
                let mut editor = textarea(&d.edit)
                    .label(input_label)
                    .disabled(a.busy)
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
                if let Some(options) = field["options"].as_array() {
                    let items: Vec<El> = options
                        .iter()
                        .take(64)
                        .filter_map(|option| {
                            let value = option["value"].as_str()?;
                            let label = option["label"]
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(value);
                            let desc = option["description"]
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            let checked = d.selected.contains(value);
                            let value = value.to_string();
                            let id = identity.clone();
                            Some(form_controls::checkbox_option(
                                &format!("multi-{key}-{value}"),
                                label,
                                desc,
                                checked,
                                a.busy,
                                crate::screen::action(&scope, move |s: &mut State| {
                                    if let Some(d) =
                                        s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                    {
                                        d.toggle(&value)
                                    }
                                }),
                            ))
                        })
                        .collect();
                    if !items.is_empty() {
                        body = body
                            .child(form_controls::checkbox_group(field_name, field_desc, items));
                    }
                }
                if field["custom"] == true {
                    let id = identity.clone();
                    let custom_label = if explicit_title.is_some() {
                        format!("{field_name} · {}", t("rune.other_values"))
                    } else {
                        t("rune.other_values").to_string()
                    };
                    let mut editor = textarea(&d.custom)
                        .label(custom_label)
                        .disabled(a.busy)
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

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Cx, Env, Key, KeyEvent, Mods, Runtime};
    use serde_json::{Value, json};

    fn state_with_form(form: Form) -> State {
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (_, results) = codenomad_client::bounded(1);
        let mut ui = crate::agent::Ui::new(crate::agent::Handle::test(jobs, stop, results));
        ui.reading = false;
        ui.known = true;
        ui.mark_pending_known();
        ui.online = true;
        ui.selected = form.id.clone();
        ui.forms.push(form);
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        s.agent = Some(ui);
        s
    }

    fn render_form(s: &State, cx: &mut Cx<State>) -> El {
        layout::render(cx, |_| {
            let Some(form) = s.agent.as_ref().and_then(|a| a.forms.first()) else {
                return col();
            };
            col()
                .full_width()
                .full_height()
                .child(fields(s, form))
                .child(actions(s, form))
        })
    }

    fn find_node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
        if tree["key"] == key {
            return Some(tree);
        }
        tree["children"]
            .as_array()?
            .iter()
            .find_map(|child| find_node(child, key))
    }

    fn find_input<'a>(tree: &'a Value, wrapper_key: &str) -> &'a Value {
        let wrapper = find_node(tree, wrapper_key)
            .unwrap_or_else(|| panic!("missing textarea wrapper {wrapper_key}"));
        find_node(wrapper, "input")
            .unwrap_or_else(|| panic!("missing inner input inside {wrapper_key}: {wrapper}"))
    }

    fn has_state(node: &Value, state: &str) -> bool {
        node["states"]
            .as_array()
            .is_some_and(|states| states.iter().any(|s| s == state))
    }

    fn collect_names(tree: &Value, out: &mut Vec<String>) {
        if let Some(name) = tree["name"].as_str() {
            out.push(name.to_string());
        }
        if let Some(children) = tree["children"].as_array() {
            for child in children {
                collect_names(child, out);
            }
        }
    }

    fn tap(rt: &mut Runtime<State>, key: &str) {
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("missing form control {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }

    fn press_key(rt: &mut Runtime<State>, key: Key) {
        let event = KeyEvent {
            key,
            mods: Mods::default(),
        };
        rt.key(event.clone());
        rt.key_up(event);
        rt.frame(1.0 / 60.0);
    }

    #[test]
    fn question_form_exposes_native_radio_checkbox_states_and_localized_names() {
        for (locale, yes_label, no_label, fallback_answer, other_values) in [
            ("en", "Yes", "No", "Your answer", "Other values"),
            ("fr", "Oui", "Non", "Votre réponse", "Autres valeurs"),
        ] {
            crate::strings::with_locale(locale, || {
                let form = Form {
                    tool: None,
                    infer_websearch: false,
                    id: "form-m12".into(),
                    title: "Deployment check".into(),
                    fields: vec![
                        json!({
                            "key": "raw_confirm_key",
                            "title": "Proceed now?",
                            "type": "boolean",
                            "default": false
                        }),
                        json!({
                            "key": "raw_env_key",
                            "title": "Environment",
                            "type": "string",
                            "custom": true,
                            "options": [
                                {"value": "staging", "label": "Staging", "description": "Pre-production"},
                                {"value": "prod", "label": "Production"}
                            ]
                        }),
                        json!({
                            "key": "raw_scopes_key",
                            "title": "Scopes",
                            "type": "multiselect",
                            "custom": true,
                            "options": [
                                {"value": "api", "label": "API"},
                                {"value": "web", "label": "Web"}
                            ]
                        }),
                        json!({
                            "key": "raw_untitled_key",
                            "type": "string"
                        }),
                    ],
                };
                let mut rt = Runtime::new(
                    state_with_form(form),
                    render_form,
                    (480.0, 900.0),
                    Env::new(true, 1.0),
                );
                rt.frame(0.0);

                let tree = rt.accessibility_json();
                let mut names = Vec::new();
                collect_names(&tree, &mut names);
                for name in &names {
                    assert!(
                        !name.contains('●')
                            && !name.contains('○')
                            && !name.contains('☑')
                            && !name.contains('☐'),
                        "simulated glyph leaked into accessible name: {name}"
                    );
                    for raw_key in [
                        "raw_confirm_key",
                        "raw_env_key",
                        "raw_scopes_key",
                        "raw_untitled_key",
                    ] {
                        assert_ne!(name, raw_key, "raw technical key leaked as accessible name");
                    }
                }

                // Boolean radios expose native radio-button role + checked/unchecked states.
                let bool_yes = find_node(&tree, "bool-raw_confirm_key-true").unwrap();
                let bool_no = find_node(&tree, "bool-raw_confirm_key-false").unwrap();
                assert_eq!(bool_yes["role"], "radio-button");
                assert_eq!(bool_yes["name"], yes_label);
                assert_eq!(bool_yes["position"], 1);
                assert!(has_state(bool_yes, "unchecked"), "{bool_yes}");
                assert_eq!(bool_no["role"], "radio-button");
                assert_eq!(bool_no["name"], no_label);
                assert_eq!(bool_no["position"], 2);
                assert!(has_state(bool_no, "checked"), "{bool_no}");

                tap(&mut rt, "bool-raw_confirm_key-true");
                let tree = rt.accessibility_json();
                let bool_yes = find_node(&tree, "bool-raw_confirm_key-true").unwrap();
                let bool_no = find_node(&tree, "bool-raw_confirm_key-false").unwrap();
                assert!(has_state(bool_yes, "checked"), "{bool_yes}");
                assert!(has_state(bool_no, "unchecked"), "{bool_no}");

                // String options expose native radio-button role + selection state + description.
                let opt_staging = find_node(&tree, "option-raw_env_key-staging").unwrap();
                let opt_prod = find_node(&tree, "option-raw_env_key-prod").unwrap();
                assert_eq!(opt_staging["role"], "radio-button");
                assert_eq!(opt_staging["name"], "Staging");
                assert_eq!(opt_staging["description"], "Pre-production");
                assert!(has_state(opt_staging, "unchecked"), "{opt_staging}");
                assert!(has_state(opt_prod, "unchecked"), "{opt_prod}");

                tap(&mut rt, "option-raw_env_key-prod");
                let tree = rt.accessibility_json();
                let opt_staging = find_node(&tree, "option-raw_env_key-staging").unwrap();
                let opt_prod = find_node(&tree, "option-raw_env_key-prod").unwrap();
                assert!(has_state(opt_staging, "unchecked"), "{opt_staging}");
                assert!(has_state(opt_prod, "checked"), "{opt_prod}");

                // Multiselect options expose native check-box role + checked/unchecked states.
                let multi_api = find_node(&tree, "multi-raw_scopes_key-api").unwrap();
                let multi_web = find_node(&tree, "multi-raw_scopes_key-web").unwrap();
                assert_eq!(multi_api["role"], "check-box");
                assert_eq!(multi_api["name"], "API");
                assert!(has_state(multi_api, "unchecked"), "{multi_api}");
                assert_eq!(multi_web["role"], "check-box");
                assert!(has_state(multi_web, "unchecked"), "{multi_web}");

                tap(&mut rt, "multi-raw_scopes_key-api");
                tap(&mut rt, "multi-raw_scopes_key-web");
                let tree = rt.accessibility_json();
                assert!(has_state(
                    find_node(&tree, "multi-raw_scopes_key-api").unwrap(),
                    "checked"
                ));
                assert!(has_state(
                    find_node(&tree, "multi-raw_scopes_key-web").unwrap(),
                    "checked"
                ));

                // Keyboard activation toggles checkboxes and moves/selects radios.
                rt.update(|_, tx| tx.focus("multi-raw_scopes_key-api", true));
                rt.frame(1.0 / 60.0);
                press_key(&mut rt, Key::Text(" ".into()));
                let tree = rt.accessibility_json();
                assert!(has_state(
                    find_node(&tree, "multi-raw_scopes_key-api").unwrap(),
                    "unchecked"
                ));

                rt.update(|_, tx| tx.focus("option-raw_env_key-prod", true));
                rt.frame(1.0 / 60.0);
                press_key(&mut rt, Key::Up);
                press_key(&mut rt, Key::Text(" ".into()));
                let tree = rt.accessibility_json();
                assert!(has_state(
                    find_node(&tree, "option-raw_env_key-staging").unwrap(),
                    "checked"
                ));

                // Text fields carry human/localized accessible names, never raw keys.
                let env_custom = find_input(&tree, "field-raw_env_key");
                assert_eq!(env_custom["name"], format!("Environment · {other_values}"));
                let scopes_custom = find_input(&tree, "custom-raw_scopes_key");
                assert_eq!(scopes_custom["name"], format!("Scopes · {other_values}"));
                let untitled_input = find_input(&tree, "field-raw_untitled_key");
                assert_eq!(untitled_input["name"], fallback_answer);

                // Busy state disables options and prevents state changes.
                rt.update(|s, _| {
                    s.agent.as_mut().unwrap().busy = true;
                });
                rt.frame(1.0 / 60.0);
                let tree = rt.accessibility_json();
                assert!(has_state(
                    find_node(&tree, "bool-raw_confirm_key-false").unwrap(),
                    "disabled"
                ));
                assert!(has_state(
                    find_node(&tree, "multi-raw_scopes_key-api").unwrap(),
                    "disabled"
                ));
                tap(&mut rt, "bool-raw_confirm_key-false");
                assert_eq!(
                    rt.state.agent.as_ref().unwrap().drafts
                        [&("form-m12".into(), "raw_confirm_key".into())]
                        .edit
                        .text,
                    "true"
                );
            });
        }
    }

    #[test]
    fn single_untitled_field_inherits_form_title_as_accessible_name() {
        crate::strings::with_locale("en", || {
            let form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-single".into(),
                title: "Confirm rollout".into(),
                fields: vec![json!({
                    "key": "internal_answer_key",
                    "type": "string",
                    "description": "Explain why"
                })],
            };
            let mut rt = Runtime::new(
                state_with_form(form),
                render_form,
                (420.0, 320.0),
                Env::new(false, 1.0),
            );
            rt.frame(0.0);
            let tree = rt.accessibility_json();
            let input = find_input(&tree, "field-internal_answer_key");
            assert_eq!(input["name"], "Confirm rollout");
            assert_eq!(input["description"], "Explain why");
        });
    }
}
