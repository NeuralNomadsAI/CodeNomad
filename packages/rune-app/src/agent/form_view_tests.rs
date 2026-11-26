use super::form_view::{actions, fields};
use crate::{State, agent_api::Form, agent_forms};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, col};
use rune_theme_codenomad::layout::{self, Layout};
use serde_json::{Value, json};

fn state_with_form(form: Form) -> (State, codenomad_client::Receiver<crate::agent::PendingJob>) {
    let (jobs, _) = codenomad_client::bounded(1);
    let (stop, _) = codenomad_client::bounded(1);
    let (_, results) = codenomad_client::bounded(1);
    let (forms_tx, forms_rx) = codenomad_client::bounded(4);
    let mut handle = crate::agent::Handle::test(jobs, stop, results);
    handle.forms = forms_tx;
    let mut ui = crate::agent::Ui::new(handle);
    ui.reading = false;
    ui.known = true;
    ui.mark_pending_known();
    ui.forms_lane.reading = false;
    ui.online = true;
    while forms_rx.try_recv().is_ok() {}
    ui.selected = form.id.clone();
    ui.forms.push(form);
    agent_forms::seed(&ui.forms, &mut ui.drafts);
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    s.agent = Some(ui);
    (s, forms_rx)
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
fn question_form_exposes_native_radio_checkbox_states_localized_names_and_mutation_lock() {
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
                        "description": "Pick deployment target",
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
            let (state, forms_rx) = state_with_form(form);
            let mut rt = Runtime::new(state, render_form, (480.0, 1400.0), Env::new(true, 1.0));
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

            // Visible field description is rendered for sighted users as well as a11y metadata.
            assert!(
                rt.elements()
                    .iter()
                    .any(|e| e.text.as_deref() == Some("Pick deployment target")),
                "field description must be rendered visibly"
            );

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
            assert!(has_state(
                find_node(&tree, "bool-raw_confirm_key-true").unwrap(),
                "checked"
            ));
            assert!(has_state(
                find_node(&tree, "bool-raw_confirm_key-false").unwrap(),
                "unchecked"
            ));

            // String options expose native radio-button role + selection state + description.
            let staging_key = agent_forms::string_option_key(1, 0);
            let prod_key = agent_forms::string_option_key(1, 1);
            let opt_staging = find_node(&tree, &staging_key).unwrap();
            let opt_prod = find_node(&tree, &prod_key).unwrap();
            assert_eq!(opt_staging["role"], "radio-button");
            assert_eq!(opt_staging["name"], "Staging");
            assert_eq!(opt_staging["description"], "Pre-production");
            assert!(has_state(opt_staging, "unchecked"), "{opt_staging}");
            assert!(has_state(opt_prod, "unchecked"), "{opt_prod}");

            tap(&mut rt, &prod_key);
            let tree = rt.accessibility_json();
            assert!(has_state(
                find_node(&tree, &staging_key).unwrap(),
                "unchecked"
            ));
            assert!(has_state(find_node(&tree, &prod_key).unwrap(), "checked"));

            // Multiselect options expose native check-box role + checked/unchecked states.
            let api_key = agent_forms::multi_option_key(2, 0);
            let web_key = agent_forms::multi_option_key(2, 1);
            let multi_api = find_node(&tree, &api_key).unwrap();
            let multi_web = find_node(&tree, &web_key).unwrap();
            assert_eq!(multi_api["role"], "check-box");
            assert_eq!(multi_api["name"], "API");
            assert!(has_state(multi_api, "unchecked"), "{multi_api}");
            assert_eq!(multi_web["role"], "check-box");
            assert!(has_state(multi_web, "unchecked"), "{multi_web}");

            tap(&mut rt, &api_key);
            tap(&mut rt, &web_key);
            let tree = rt.accessibility_json();
            assert!(has_state(find_node(&tree, &api_key).unwrap(), "checked"));
            assert!(has_state(find_node(&tree, &web_key).unwrap(), "checked"));

            // Keyboard activation toggles checkboxes and moves/selects radios.
            rt.update(|_, tx| tx.focus(api_key.clone(), true));
            rt.frame(1.0 / 60.0);
            press_key(&mut rt, Key::Text(" ".into()));
            let tree = rt.accessibility_json();
            assert!(has_state(find_node(&tree, &api_key).unwrap(), "unchecked"));

            rt.update(|_, tx| tx.focus(prod_key.clone(), true));
            rt.frame(1.0 / 60.0);
            press_key(&mut rt, Key::Up);
            press_key(&mut rt, Key::Text(" ".into()));
            let tree = rt.accessibility_json();
            assert!(has_state(
                find_node(&tree, &staging_key).unwrap(),
                "checked"
            ));

            // Text fields carry human/localized accessible names, never raw keys.
            let env_custom = find_input(&tree, "field-raw_env_key");
            assert_eq!(env_custom["name"], format!("Environment · {other_values}"));
            assert_eq!(env_custom["description"], "Pick deployment target");
            let scopes_custom = find_input(&tree, "custom-raw_scopes_key");
            assert_eq!(scopes_custom["name"], format!("Scopes · {other_values}"));
            let untitled_input = find_input(&tree, "field-raw_untitled_key");
            assert_eq!(untitled_input["name"], fallback_answer);

            // Real in-flight form submission locks options and text inputs even while model `busy` is false.
            assert!(!rt.state.agent.as_ref().unwrap().busy);
            assert!(!rt.state.agent.as_ref().unwrap().forms_locked());
            tap(&mut rt, "answer-question");
            assert!(
                matches!(
                    forms_rx.try_recv(),
                    Ok(crate::agent::PendingJob::Act(
                        crate::agent_api::Action::Answer(..),
                        _
                    ))
                ),
                "tapping answer-question must dispatch Action::Answer"
            );
            assert!(rt.state.agent.as_ref().unwrap().forms_mutating());
            assert!(!rt.state.agent.as_ref().unwrap().busy);
            let tree = rt.accessibility_json();
            assert!(has_state(
                find_node(&tree, "bool-raw_confirm_key-false").unwrap(),
                "disabled"
            ));
            assert!(has_state(
                find_node(&tree, &staging_key).unwrap(),
                "disabled"
            ));
            assert!(has_state(find_node(&tree, &api_key).unwrap(), "disabled"));
            assert!(has_state(
                find_input(&tree, "field-raw_env_key"),
                "disabled"
            ));
            assert!(has_state(
                find_input(&tree, "custom-raw_scopes_key"),
                "disabled"
            ));
            tap(&mut rt, "bool-raw_confirm_key-false");
            tap(&mut rt, &api_key);
            assert_eq!(
                rt.state.agent.as_ref().unwrap().drafts
                    [&("form-m12".into(), "raw_confirm_key".into())]
                    .edit
                    .text,
                "true"
            );
            assert!(
                !rt.state.agent.as_ref().unwrap().drafts
                    [&("form-m12".into(), "raw_scopes_key".into())]
                    .selected
                    .contains("api")
            );
            // Screen editor callback also refuses draft mutations while locked.
            rt.update(|s, _| {
                let scope = s.input_scope.clone();
                let edit = s.editor(
                    &scope,
                    crate::screen::Editor::Form(("form-m12".into(), "raw_untitled_key".into())),
                );
                edit.text.push_str("late edit");
            });
            assert_eq!(
                rt.state.agent.as_ref().unwrap().drafts
                    [&("form-m12".into(), "raw_untitled_key".into())]
                    .edit
                    .text,
                ""
            );

            // Reconciliation keeps controls locked after the in-flight request finishes.
            rt.update(|s, _| {
                let a = s.agent.as_mut().unwrap();
                a.forms_lane.busy = false;
                a.forms_lane.reconciling = true;
            });
            rt.frame(1.0 / 60.0);
            let tree = rt.accessibility_json();
            assert!(has_state(
                find_node(&tree, "bool-raw_confirm_key-false").unwrap(),
                "disabled"
            ));
            assert!(has_state(
                find_input(&tree, "field-raw_untitled_key"),
                "disabled"
            ));
        });
    }
}

#[test]
fn option_keys_do_not_alias_across_hyphenated_fields_and_values() {
    crate::strings::with_locale("en", || {
        let form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-alias".into(),
            title: "Hyphen check".into(),
            fields: vec![
                json!({
                    "key": "a-b",
                    "title": "First",
                    "type": "string",
                    "options": [{"value": "c", "label": "Alpha C"}]
                }),
                json!({
                    "key": "a",
                    "title": "Second",
                    "type": "string",
                    "options": [{"value": "b-c", "label": "Beta BC"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        rt.frame(0.0);

        let first_key = agent_forms::string_option_key(0, 0);
        let second_key = agent_forms::string_option_key(1, 0);
        assert_ne!(first_key, second_key);

        let tree = rt.accessibility_json();
        assert_eq!(find_node(&tree, &first_key).unwrap()["name"], "Alpha C");
        assert_eq!(find_node(&tree, &second_key).unwrap()["name"], "Beta BC");
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&first_key)),
            Some((first_key.clone(), Some("pending-content-form-alias".into())))
        );
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&second_key)),
            Some((
                second_key.clone(),
                Some("pending-content-form-alias".into())
            ))
        );

        tap(&mut rt, &second_key);
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-alias".into(), "a-b".into())]
                .edit
                .text,
            ""
        );
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-alias".into(), "a".into())]
                .edit
                .text,
            "b-c"
        );
    });
}

#[test]
fn duplicate_empty_and_blank_label_options_are_normalized_consistently() {
    crate::strings::with_locale("en", || {
        let form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-norm".into(),
            title: "Normalization".into(),
            fields: vec![
                json!({
                    "key": "choice",
                    "title": "Choice",
                    "type": "string",
                    "options": [
                        {"value": "", "label": "Empty"},
                        {"value": "prod", "label": "Production"},
                        {"value": "prod", "label": "Production duplicate"},
                        {"value": "   ", "label": "   "}
                    ]
                }),
                json!({
                    "key": "tags",
                    "title": "Tags",
                    "type": "multiselect",
                    "options": [
                        {"value": "", "label": "Empty"},
                        {"value": "alpha", "label": "Alpha"},
                        {"value": "alpha", "label": "Alpha duplicate"}
                    ]
                }),
            ],
        };
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        rt.frame(0.0);

        let tree = rt.accessibility_json();
        let radio_group = find_node(&tree, &agent_forms::field_group_key(0)).unwrap();
        let radios = radio_group["children"].as_array().unwrap();
        // Empty option dropped, duplicate "prod" collapsed -> 2 distinct radios ("prod" and "   ").
        assert_eq!(radios.len(), 2, "{radios:?}");
        assert_eq!(radios[0]["name"], "Production");
        assert!(has_state(&radios[0], "unchecked"));
        // Whitespace value with blank label receives a nonblank localized name.
        assert_eq!(radios[1]["name"], "Your answer 2");
        assert!(has_state(&radios[1], "unchecked"));

        let check_group = find_node(&tree, &agent_forms::field_group_key(1)).unwrap();
        let checks = check_group["children"].as_array().unwrap();
        assert_eq!(checks.len(), 1, "{checks:?}");
        assert_eq!(checks[0]["name"], "Alpha");
    });
}

#[test]
fn multiple_untitled_fields_render_distinct_visible_localized_captions_and_descriptions() {
    for (locale, answer_word, other_values) in [
        ("en", "Your answer", "Other values"),
        ("fr", "Votre réponse", "Autres valeurs"),
    ] {
        crate::strings::with_locale(locale, || {
            let form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-untitled".into(),
                title: "Confirm rollout".into(),
                fields: vec![
                    json!({
                        "key": "raw_first",
                        "type": "string",
                        "description": "First helper text",
                        "custom": true,
                        "options": [{"value": "x", "label": "Option X"}]
                    }),
                    json!({
                        "key": "raw_second",
                        "type": "multiselect",
                        "description": "Second helper text",
                        "custom": true,
                        "options": [{"value": "y", "label": "Option Y"}]
                    }),
                ],
            };
            let (state, _rx) = state_with_form(form);
            let mut rt = Runtime::new(state, render_form, (420.0, 680.0), Env::new(false, 1.0));
            rt.frame(0.0);

            let first_caption = format!("{answer_word} 1");
            let second_caption = format!("{answer_word} 2");
            let els = rt.elements();
            assert!(
                els.iter()
                    .any(|e| e.text.as_deref() == Some(first_caption.as_str())),
                "first untitled field must render a visible caption"
            );
            assert!(
                els.iter()
                    .any(|e| e.text.as_deref() == Some(second_caption.as_str())),
                "second untitled field must render a visible caption"
            );
            assert!(
                els.iter()
                    .any(|e| e.text.as_deref() == Some("First helper text")),
                "first field description must be visible"
            );
            assert!(
                els.iter()
                    .any(|e| e.text.as_deref() == Some("Second helper text")),
                "second field description must be visible"
            );

            let tree = rt.accessibility_json();
            assert_eq!(
                find_node(&tree, &agent_forms::field_group_key(0)).unwrap()["name"],
                first_caption
            );
            assert_eq!(
                find_node(&tree, &agent_forms::field_group_key(1)).unwrap()["name"],
                second_caption
            );
            assert_eq!(
                find_input(&tree, "field-raw_first")["name"],
                format!("{first_caption} · {other_values}")
            );
            assert_eq!(
                find_input(&tree, "custom-raw_second")["name"],
                format!("{second_caption} · {other_values}")
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
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (420.0, 320.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let tree = rt.accessibility_json();
        let input = find_input(&tree, "field-internal_answer_key");
        assert_eq!(input["name"], "Confirm rollout");
        assert_eq!(input["description"], "Explain why");
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.text.as_deref() == Some("Explain why")),
            "single-field description must be visible"
        );
    });
}
