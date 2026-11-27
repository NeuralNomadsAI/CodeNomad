use super::form_view::{actions, fields};
use crate::{State, agent_api::Form, agent_forms};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, col};
use rune_theme_codenomad::{
    TextRole,
    layout::{self, Layout},
    tokens,
};
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

fn collect_values(tree: &Value, out: &mut Vec<String>) {
    if let Some(value) = tree["value"].as_str()
        && !value.is_empty()
    {
        out.push(value.to_string());
    }
    if let Some(children) = tree["children"].as_array() {
        for child in children {
            collect_values(child, out);
        }
    }
}

fn focused_key(rt: &mut Runtime<State>) -> Option<String> {
    let mut key = None;
    rt.update(|_, tx| key = tx.focused().map(str::to_owned));
    key
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
            let staging_key = agent_forms::string_option_key("raw_env_key", "staging");
            let prod_key = agent_forms::string_option_key("raw_env_key", "prod");
            let opt_staging = find_node(&tree, &staging_key).unwrap();
            let opt_prod = find_node(&tree, &prod_key).unwrap();
            let env_group = find_node(&tree, &agent_forms::field_group_key("raw_env_key")).unwrap();
            assert_eq!(env_group["role"], "radio-group");
            assert_eq!(env_group["name"], "Environment");
            assert_eq!(env_group["description"], "Pick deployment target");
            assert_eq!(opt_staging["role"], "radio-button");
            assert_eq!(opt_staging["name"], "Staging");
            assert_eq!(
                opt_staging["description"],
                "Pre-production · Environment · Pick deployment target"
            );
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
            let api_key = agent_forms::multi_option_key("raw_scopes_key", "api");
            let web_key = agent_forms::multi_option_key("raw_scopes_key", "web");
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

            // Text fields carry human/localized accessible names, never raw keys, and selecting a
            // radio never copies its raw wire value into the custom text input.
            let env_custom = find_input(&tree, "custom-raw_env_key");
            assert_eq!(env_custom["name"], format!("Environment · {other_values}"));
            assert_eq!(env_custom["description"], "Pick deployment target");
            assert_eq!(
                env_custom["value"].as_str().unwrap_or(""),
                "",
                "selecting a radio must not populate the custom editor with its raw wire value"
            );
            assert!(
                find_node(&tree, "field-raw_env_key").is_none(),
                "option-backed string field must not render a duplicate field editor"
            );
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
                find_input(&tree, "custom-raw_env_key"),
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

            // Reconciliation after the POST finishes keeps Answer/Cancel gated on fresh request
            // authority while leaving the draft fields editable.
            rt.update(|s, _| {
                let a = s.agent.as_mut().unwrap();
                a.forms_lane.busy = false;
                a.forms_lane.reconciling = true;
            });
            rt.frame(1.0 / 60.0);
            let tree = rt.accessibility_json();
            assert!(has_state(
                find_node(&tree, "answer-question").unwrap(),
                "disabled"
            ));
            assert!(has_state(
                find_node(&tree, "cancel-question").unwrap(),
                "disabled"
            ));
            assert!(!has_state(
                find_node(&tree, "bool-raw_confirm_key-false").unwrap(),
                "disabled"
            ));
            assert!(!has_state(
                find_input(&tree, "field-raw_untitled_key"),
                "disabled"
            ));
        });
    }
}

#[test]
fn option_keys_do_not_alias_and_keep_value_identity_across_reorders_and_replacements() {
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
                    "options": [
                        {"value": "c", "label": "Alpha C"},
                        {"value": "d", "label": "Alpha D"}
                    ]
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
        let mut rt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        rt.frame(0.0);

        let first_c = agent_forms::string_option_key("a-b", "c");
        let first_d = agent_forms::string_option_key("a-b", "d");
        let second_bc = agent_forms::string_option_key("a", "b-c");
        assert_ne!(first_c, second_bc);

        let tree = rt.accessibility_json();
        assert_eq!(find_node(&tree, &first_c).unwrap()["name"], "Alpha C");
        assert_eq!(find_node(&tree, &second_bc).unwrap()["name"], "Beta BC");
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&first_c)),
            Some((first_c.clone(), Some("pending-content-form-alias".into())))
        );
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&second_bc)),
            Some((second_bc.clone(), Some("pending-content-form-alias".into())))
        );

        // Focus "c", then reorder options [c, d] -> [d, c] under the same form ID.
        rt.update(|_, tx| tx.focus(first_c.clone(), true));
        rt.frame(1.0 / 60.0);
        rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0]["options"] = json!([
                {"value": "d", "label": "Alpha D"},
                {"value": "c", "label": "Alpha C"}
            ]);
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        rt.frame(1.0 / 60.0);
        press_key(&mut rt, Key::Text(" ".into()));
        // Space activates the originally focused option ("c"), NOT the new occupant at index 0 ("d").
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-alias".into(), "a-b".into())]
                .choice
                .as_deref(),
            Some("c")
        );

        // Replacing "c" with "e" under the same form ID moves focus to the non-answer header
        // anchor (NOT surviving option "d" or replacement "e"), and prunes the removed choice.
        rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0]["options"] = json!([
                {"value": "e", "label": "Alpha E"},
                {"value": "d", "label": "Alpha D"}
            ]);
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        rt.frame(1.0 / 60.0);
        assert_eq!(
            focused_key(&mut rt).as_deref(),
            Some(rune_theme_codenomad::form_controls::FORM_FOCUS_ANCHOR),
            "removing a focused choice must move focus to a non-answer target, never to a surviving option"
        );
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&first_c)),
            None
        );
        assert_eq!(
            crate::agent::focused_control_key(&rt.state, Some(&first_d)),
            Some((first_d.clone(), Some("pending-content-form-alias".into())))
        );
        press_key(&mut rt, Key::Text(" ".into()));
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-alias".into(), "a-b".into())]
                .choice
                .as_deref(),
            None,
            "Space after removing the focused option must not select surviving option d or replacement e"
        );
    });
}

#[test]
fn duplicate_empty_and_blank_label_options_stay_consistent_across_seed_render_and_validation() {
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
                        {"value": "internal_choice_key", "label": "   "},
                        {"value": "internal_unlabeled_key"}
                    ]
                }),
                json!({
                    "key": "tags",
                    "title": "Tags",
                    "type": "multiselect",
                    "default": ["", "alpha", "stale_removed"],
                    "options": [
                        {"value": "", "label": "Empty"},
                        {"value": "alpha", "label": "Alpha"},
                        {"value": "alpha", "label": "Alpha duplicate"}
                    ]
                }),
                json!({
                    "key": "constrained_empty",
                    "title": "Constrained",
                    "type": "string",
                    "options": []
                }),
            ],
        };
        let (mut state, _rx) = state_with_form(form);
        // Simulate a stale retained empty selection before re-seeding on refresh.
        {
            let a = state.agent.as_mut().unwrap();
            a.drafts
                .get_mut(&("form-norm".into(), "tags".into()))
                .unwrap()
                .selected
                .insert("".into());
            agent_forms::seed(&a.forms, &mut a.drafts);
        }
        let mut rt = Runtime::new(state, render_form, (420.0, 960.0), Env::new(false, 1.0));
        rt.frame(0.0);

        let tree = rt.accessibility_json();
        let mut names = Vec::new();
        collect_names(&tree, &mut names);
        for leaked in ["internal_choice_key", "internal_unlabeled_key"] {
            assert!(
                !names.iter().any(|n| n.contains(leaked)),
                "raw option value {leaked} leaked into accessible names: {names:?}"
            );
            assert!(
                !rt.elements()
                    .iter()
                    .any(|e| e.text.as_deref().is_some_and(|t| t.contains(leaked))),
                "raw option value {leaked} leaked into visible text"
            );
        }

        // Closed choice renders no textarea at all, only radios + optional Clear control.
        assert!(
            find_node(&tree, "field-choice").is_none()
                && find_node(&tree, "custom-choice").is_none(),
            "closed string choice must not render a textarea"
        );
        assert!(
            find_node(&tree, "field-constrained_empty").is_none()
                && find_node(&tree, "custom-constrained_empty").is_none(),
            "closed string with empty/normalized-away options must not render a textarea"
        );

        let radio_group = find_node(&tree, &agent_forms::field_group_key("choice")).unwrap();
        let radios = radio_group["children"].as_array().unwrap();
        // Optional declared empty option preserved, duplicate "prod" collapsed -> 4 distinct radios.
        assert_eq!(radios.len(), 4, "{radios:?}");
        assert_eq!(radios[0]["name"], "Empty");
        assert!(has_state(&radios[0], "unchecked"));
        assert_eq!(radios[1]["name"], "Production");
        assert!(has_state(&radios[1], "unchecked"));
        assert_eq!(radios[2]["name"], "Your answer 3");
        assert_eq!(radios[3]["name"], "Your answer 4");

        // Tapping the blank-label option stores its raw protocol value in Draft::choice,
        // submits it, and NEVER leaks it into visible text, accessible names, or accessible values.
        let raw_opt_key = agent_forms::string_option_key("choice", "internal_choice_key");
        tap(&mut rt, &raw_opt_key);
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-norm".into(), "choice".into())]
                .choice
                .as_deref(),
            Some("internal_choice_key")
        );
        let post_tree = rt.accessibility_json();
        let mut post_names = Vec::new();
        let mut post_values = Vec::new();
        collect_names(&post_tree, &mut post_names);
        collect_values(&post_tree, &mut post_values);
        for leaked in ["internal_choice_key", "internal_unlabeled_key"] {
            assert!(
                !post_names.iter().any(|n| n.contains(leaked)),
                "raw option value {leaked} leaked into accessible names after selection: {post_names:?}"
            );
            assert!(
                !post_values.iter().any(|v| v.contains(leaked)),
                "raw option value {leaked} leaked into accessible values after selection: {post_values:?}"
            );
            assert!(
                !rt.elements()
                    .iter()
                    .any(|e| e.text.as_deref().is_some_and(|t| t.contains(leaked))),
                "raw option value {leaked} leaked into visible text after selection"
            );
        }

        // Multiselect preserves declared "" and sanitizes out undeclared "stale_removed".
        let a = rt.state.agent.as_ref().unwrap();
        let answer = agent_forms::answer(&a.forms[0], &a.drafts).expect("sanitized draft submits");
        assert_eq!(answer["choice"], json!("internal_choice_key"));
        assert_eq!(answer["tags"], json!(["", "alpha"]));

        // Optional closed choice can be cleared via its localized Clear button.
        let clear_key = agent_forms::clear_option_key("choice");
        let clear_node =
            find_node(&post_tree, &clear_key).expect("clear button for optional choice");
        assert_eq!(clear_node["name"], "Choice · Clear");
        assert!(!has_state(clear_node, "disabled"));
        tap(&mut rt, &clear_key);
        let a = rt.state.agent.as_ref().unwrap();
        let cleared_answer =
            agent_forms::answer(&a.forms[0], &a.drafts).expect("cleared optional submits");
        assert!(
            cleared_answer.get("choice").is_none(),
            "clearing an optional closed choice must omit it from the submitted answer"
        );

        // Non-custom string whose raw options normalized away OR explicit empty `options: []`
        // must never accept arbitrary free text.
        rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-norm".into(), "constrained_empty".into()))
                .unwrap()
                .edit = rune::edit::TextEdit::new("arbitrary free text");
        });
        let a = rt.state.agent.as_ref().unwrap();
        assert!(
            agent_forms::answer(&a.forms[0], &a.drafts).is_err(),
            "non-custom string with raw options must never accept arbitrary free text"
        );

        let empty_closed = json!({
            "key": "closed_empty",
            "title": "Closed empty",
            "type": "string",
            "custom": false,
            "options": []
        });
        let arbitrary_draft = agent_forms::Draft {
            edit: rune::edit::TextEdit::new("not allowed"),
            ..Default::default()
        };
        assert!(
            agent_forms::value(&empty_closed, &arbitrary_draft).is_err(),
            "explicit empty options array on closed string must reject arbitrary text"
        );
        let arbitrary_choice = agent_forms::Draft {
            choice: Some("not allowed".into()),
            ..Default::default()
        };
        assert!(
            agent_forms::value(&empty_closed, &arbitrary_choice).is_err(),
            "explicit empty options array on closed string must reject arbitrary choice"
        );

        // Malformed option shapes (missing, null, or non-array options) must be rejected by
        // both supported() and value().
        for malformed in [
            json!({"key": "bad_multi_missing", "type": "multiselect"}),
            json!({"key": "bad_multi_null", "type": "multiselect", "options": null}),
            json!({"key": "bad_multi_str", "type": "multiselect", "options": "nope"}),
            json!({"key": "bad_str_null", "type": "string", "options": null}),
            json!({"key": "bad_str_obj", "type": "string", "options": {"a": 1}}),
        ] {
            let bad_form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-bad-opt".into(),
                title: "Bad".into(),
                fields: vec![malformed.clone()],
            };
            assert!(
                !agent_forms::supported(&bad_form),
                "malformed options shape must be unsupported: {malformed}"
            );
            assert!(
                agent_forms::value(&malformed, &agent_forms::Draft::default()).is_err(),
                "malformed options shape must fail validation: {malformed}"
            );
        }

        // Refresh adding closed options to an existing free-text field reconciles retained
        // draft.edit so incompatible free text is dropped and matching text becomes a choice.
        let mut transition_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-kind-transition".into(),
            title: "Kind transition".into(),
            fields: vec![
                json!({"key": "dropped_edit", "title": "Drop", "type": "string"}),
                json!({"key": "promoted_edit", "title": "Promote", "type": "string"}),
            ],
        };
        let mut transition_drafts = agent_forms::Drafts::default();
        agent_forms::seed(&[transition_form.clone()], &mut transition_drafts);
        transition_drafts
            .get_mut(&("form-kind-transition".into(), "dropped_edit".into()))
            .unwrap()
            .choose("incompatible free text");
        transition_drafts
            .get_mut(&("form-kind-transition".into(), "promoted_edit".into()))
            .unwrap()
            .choose("opt_b");
        transition_form.fields[0]["options"] = json!([{"value": "opt_a", "label": "Opt A"}]);
        transition_form.fields[1]["options"] = json!([{"value": "opt_b", "label": "Opt B"}]);
        agent_forms::seed(&[transition_form.clone()], &mut transition_drafts);
        assert_eq!(
            transition_drafts[&("form-kind-transition".into(), "dropped_edit".into())]
                .edit
                .text,
            ""
        );
        assert_eq!(
            transition_drafts[&("form-kind-transition".into(), "promoted_edit".into())]
                .choice
                .as_deref(),
            Some("opt_b")
        );
        let transitioned_ans = agent_forms::answer(&transition_form, &transition_drafts)
            .expect("reconciled closed choices must submit cleanly");
        assert!(transitioned_ans.get("dropped_edit").is_none());
        assert_eq!(transitioned_ans["promoted_edit"], json!("opt_b"));
        transition_drafts
            .get_mut(&("form-kind-transition".into(), "dropped_edit".into()))
            .unwrap()
            .choose_option("opt_a");
        let after_pick = agent_forms::answer(&transition_form, &transition_drafts)
            .expect("picking a radio after transition must submit cleanly");
        assert_eq!(after_pick["dropped_edit"], json!("opt_a"));

        // Custom multiselect preserves structured hidden defaults verbatim (including embedded
        // newlines), keeps custom defaults on option refresh, and promotes custom entries into
        // checked options when a refresh declares them so they disappear from the custom editor
        // and can be unchecked cleanly.
        let custom_multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-custom-multi".into(),
            title: "Custom tags".into(),
            fields: vec![
                json!({
                    "key": "hidden_tags",
                    "type": "multiselect",
                    "custom": true,
                    "hidden": true,
                    "required": true,
                    "options": [],
                    "default": ["", "team\nlocal"]
                }),
                json!({
                    "key": "mixed_tags",
                    "title": "Mixed",
                    "type": "multiselect",
                    "custom": true,
                    "options": [{"value": "opt_a", "label": "Opt A"}],
                    "default": ["opt_a", "team-local", "custom-keep"]
                }),
            ],
        };
        let (state, _rx) = state_with_form(custom_multi_form);
        let mut custom_rt = Runtime::new(state, render_form, (420.0, 680.0), Env::new(false, 1.0));
        custom_rt.frame(0.0);
        {
            let a = custom_rt.state.agent.as_ref().unwrap();
            let ans = agent_forms::answer(&a.forms[0], &a.drafts)
                .expect("custom multiselect defaults must submit cleanly");
            assert_eq!(
                ans["hidden_tags"],
                json!(["", "team\nlocal"]),
                "hidden structured custom default must round-trip verbatim without dropping items or splitting on newline"
            );
            assert_eq!(
                ans["mixed_tags"],
                json!(["opt_a", "team-local", "custom-keep"])
            );
        }

        // Refresh removes opt_a and promotes team-local into a labeled option.
        custom_rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[1]["options"] = json!([
                {"value": "opt_b", "label": "Opt B"},
                {"value": "team-local", "label": "Team Local"}
            ]);
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        custom_rt.frame(1.0 / 60.0);
        custom_rt.frame(1.0);
        let promoted_tree = custom_rt.accessibility_json();
        let promoted_key = agent_forms::multi_option_key("mixed_tags", "team-local");
        let promoted_box = find_node(&promoted_tree, &promoted_key).expect("promoted checkbox");
        assert_eq!(promoted_box["name"], "Team Local");
        assert!(has_state(promoted_box, "checked"));
        let custom_input = find_input(&promoted_tree, "custom-mixed_tags");
        assert_eq!(
            custom_input["value"], "custom-keep",
            "promoted option must leave the custom editor and preserve unrelated custom entries"
        );
        // Toggling Team Local off removes it completely from the submitted answer.
        let promoted_pos = custom_rt.find(&promoted_key);
        tap(&mut custom_rt, &promoted_key);
        let after_tap_tree = custom_rt.accessibility_json();
        let after_tap_box = find_node(&after_tap_tree, &promoted_key).expect("checkbox after tap");
        let a = custom_rt.state.agent.as_ref().unwrap();
        let d = &a.drafts[&("form-custom-multi".into(), "mixed_tags".into())];
        assert!(
            has_state(after_tap_box, "unchecked"),
            "promoted checkbox must uncheck on tap (pos={promoted_pos:?}, selected={:?}, preserved_custom={:?}, custom={:?}, box={after_tap_box})",
            d.selected,
            d.preserved_custom,
            d.custom.text
        );
        let refreshed_ans = agent_forms::answer(&a.forms[0], &a.drafts)
            .expect("custom default survives option refresh and uncheck");
        assert_eq!(refreshed_ans["hidden_tags"], json!(["", "team\nlocal"]));
        assert_eq!(refreshed_ans["mixed_tags"], json!(["custom-keep"]));
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
                find_node(&tree, &agent_forms::field_group_key("raw_first")).unwrap()["name"],
                first_caption
            );
            assert_eq!(
                find_node(&tree, &agent_forms::field_group_key("raw_second")).unwrap()["name"],
                second_caption
            );
            assert_eq!(
                find_input(&tree, "custom-raw_first")["name"],
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
fn single_untitled_field_inherits_and_wraps_overlong_form_title_at_narrow_width() {
    crate::strings::with_locale("en", || {
        let long_title = "https://example.invalid/confirm/rollout/unbroken_identifier_token_that_must_wrap_at_240px";
        let form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-single".into(),
            title: long_title.into(),
            fields: vec![json!({
                "key": "internal_answer_key",
                "type": "string",
                "description": "Explain why"
            })],
        };
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (240.0, 420.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let tree = rt.accessibility_json();
        let input = find_input(&tree, "field-internal_answer_key");
        assert_eq!(input["name"], long_title);
        assert_eq!(input["description"], "Explain why");

        let els = rt.elements();
        assert!(
            els.iter().any(|e| e.text.as_deref() == Some("Explain why")),
            "single-field description must be visible"
        );
        let title_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("form-title"))
            .expect("form-title element");
        assert!(
            title_el.rect[0] + title_el.rect[2] <= 240.5,
            "inherited unbroken form title overflowed narrow viewport: {:?}",
            title_el.rect
        );
        assert!(
            title_el.rect[3] > tokens(false).text(TextRole::Body).line_px() * 1.5,
            "inherited unbroken form title should wrap across multiple lines: {:?}",
            title_el.rect
        );
    });
}

#[test]
fn kind_changes_custom_option_authority_multiline_defaults_selection_and_unanswerable_errors() {
    crate::strings::with_locale("en", || {
        // 1. Selecting a radio and refreshing the field without options never copies the raw wire
        // value into the new textbox; incompatible kind transitions (e.g. hidden multiselect ->
        // required boolean with default: true) reseed cleanly instead of blocking submission.
        let form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-kind-reseed".into(),
            title: "Kind transitions".into(),
            fields: vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "options": [{"value": "internal_prod", "label": "Production"}]
                }),
                json!({
                    "key": "gate",
                    "type": "multiselect",
                    "hidden": true,
                    "options": [{"value": "x", "label": "X"}],
                    "default": ["x"]
                }),
            ],
        };
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
        rt.frame(0.0);
        tap(
            &mut rt,
            &agent_forms::string_option_key("env", "internal_prod"),
        );
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-kind-reseed".into(), "env".into())]
                .choice
                .as_deref(),
            Some("internal_prod")
        );

        rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields = vec![
                json!({"key": "env", "title": "Environment", "type": "string"}),
                json!({
                    "key": "gate",
                    "title": "Gate",
                    "type": "boolean",
                    "required": true,
                    "hidden": true,
                    "default": true
                }),
            ];
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        rt.frame(1.0 / 60.0);
        rt.frame(1.0);
        let tree = rt.accessibility_json();
        let env_input = find_input(&tree, "field-env");
        assert_eq!(
            env_input["value"].as_str().unwrap_or(""),
            "",
            "dropping options must never copy a radio wire value into the textbox"
        );
        let mut visible_values = Vec::new();
        collect_values(&tree, &mut visible_values);
        assert!(
            !visible_values.iter().any(|v| v.contains("internal_prod"))
                && !rt.elements().iter().any(|e| e
                    .text
                    .as_deref()
                    .is_some_and(|t| t.contains("internal_prod"))),
            "wire choice ID leaked after removing options"
        );
        let a = rt.state.agent.as_ref().unwrap();
        let ans = agent_forms::answer(&a.forms[0], &a.drafts)
            .expect("reseeded required boolean default must submit cleanly");
        assert!(ans.get("env").is_none());
        assert_eq!(ans["gate"], json!(true));

        // 2. Declared multiselect options have one authoritative selection state: typing a
        // declared option's wire value into custom text cannot submit it while unchecked.
        // 3. Visible multiline custom default stays intact when appending a new line.
        // 4. Identical snapshot refresh keeps focus and partial selection inside custom editor.
        let multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-multi-edges".into(),
            title: "Multi edges".into(),
            fields: vec![
                json!({
                    "key": "targets",
                    "title": "Targets",
                    "type": "multiselect",
                    "custom": true,
                    "options": [{"value": "prod", "label": "Production"}],
                    "default": ["prod", "custom-keep"]
                }),
                json!({
                    "key": "multiline",
                    "title": "Multiline",
                    "type": "multiselect",
                    "custom": true,
                    "options": [],
                    "default": ["team\nlocal"]
                }),
            ],
        };
        let (state, _rx) = state_with_form(multi_form);
        let mut mrt = Runtime::new(state, render_form, (420.0, 760.0), Env::new(false, 1.0));
        mrt.frame(0.0);

        // Focus custom-targets via real pointer click, select "custom" (0..6) with Shift+Right,
        // then apply an identical snapshot refresh and verify both focus and selection survive.
        let targets_input_el = mrt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("input") && e.path.contains("custom-targets"))
            .expect("custom-targets inner input");
        let targets_input_path = targets_input_el.path.clone();
        let (ix, iy) = (
            targets_input_el.rect[0] + targets_input_el.rect[2] * 0.5,
            targets_input_el.rect[1] + targets_input_el.rect[3] * 0.5,
        );
        mrt.pointer_down(ix, iy);
        mrt.pointer_up(ix, iy);
        mrt.frame(1.0 / 60.0);
        assert!(
            mrt.elements()
                .into_iter()
                .any(|e| e.path == targets_input_path && e.focused),
            "clicking custom-targets must focus its inner editor"
        );
        press_key(&mut mrt, Key::Home);
        let shift = Mods {
            shift: true,
            ..Mods::default()
        };
        for _ in 0..6 {
            let ev = KeyEvent {
                key: Key::Right,
                mods: shift,
            };
            mrt.key(ev.clone());
            mrt.key_up(ev);
            mrt.frame(1.0 / 60.0);
        }
        {
            let d = &mrt.state.agent.as_ref().unwrap().drafts
                [&("form-multi-edges".into(), "targets".into())];
            assert_eq!(
                (d.custom.anchor, d.custom.focus),
                (0, 6),
                "Shift+Right must select the first 6 bytes before refresh"
            );
        }
        mrt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        mrt.frame(2.0 / 60.0);
        assert!(
            mrt.elements()
                .into_iter()
                .any(|e| e.path == targets_input_path && e.focused),
            "identical snapshot refresh must preserve focus inside custom multiselect editor"
        );
        {
            let d = &mrt.state.agent.as_ref().unwrap().drafts
                [&("form-multi-edges".into(), "targets".into())];
            assert_eq!(
                (d.custom.anchor, d.custom.focus),
                (0, 6),
                "identical snapshot refresh must not collapse TextEdit selection"
            );
        }

        // Type "prod" in custom-targets while Production is checked, then uncheck Production.
        mrt.update(|s, _| {
            let d = s
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-multi-edges".into(), "targets".into()))
                .unwrap();
            d.custom_editor().text = "prod\nextra-custom".into();
        });
        mrt.frame(1.0);
        let prod_box = agent_forms::multi_option_key("targets", "prod");
        tap(&mut mrt, &prod_box);
        let mtree = mrt.accessibility_json();
        assert!(has_state(
            find_node(&mtree, &prod_box).unwrap(),
            "unchecked"
        ));

        // Append "new" to visible multiline default field.
        mrt.update(|s, _| {
            let d = s
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-multi-edges".into(), "multiline".into()))
                .unwrap();
            d.custom_editor().text.push_str("\nnew");
        });
        mrt.frame(2.0);
        // Unchecking Production after typing "prod\nextra-custom" removes "prod" from both the
        // checkbox selection and the custom input, submitting only `["extra-custom"]`.
        let a = mrt.state.agent.as_ref().unwrap();
        let mans = agent_forms::answer(&a.forms[0], &a.drafts).expect("valid multiselect answer");
        assert_eq!(mans["targets"], json!(["extra-custom"]));
        assert_eq!(
            mans["multiline"],
            json!(["team\nlocal", "new"]),
            "editing a visible multiline custom default must preserve the structured entry intact"
        );
    });

    // 5. Required closed choices with empty/normalized-away options surface an explicit localized
    // error, never fall back to free text, and disable Answer (both unconditional and conditional).
    for (locale, expected_error) in [
        ("en", "Unsupported form"),
        ("fr", "Formulaire non pris en charge"),
    ] {
        crate::strings::with_locale(locale, || {
            for broken_field in [
                json!({"key": "empty_closed", "title": "Pick", "type": "string", "required": true, "options": []}),
                json!({"key": "blank_closed", "title": "Pick", "type": "string", "required": true, "options": [{"value": "", "label": "Empty"}]}),
                json!({"key": "empty_multi", "title": "Tags", "type": "multiselect", "required": true, "options": []}),
            ] {
                let broken_form = Form {
                    tool: None,
                    infer_websearch: false,
                    id: "form-unanswerable".into(),
                    title: "Broken".into(),
                    fields: vec![broken_field.clone()],
                };
                assert!(
                    !agent_forms::supported(&broken_form),
                    "required closed choice with zero valid options must be unsupported: {broken_field}"
                );
                let (state, _rx) = state_with_form(broken_form);
                let mut urt =
                    Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
                urt.frame(0.0);
                let utree = urt.accessibility_json();
                let err_node =
                    find_node(&utree, "form-unsupported").expect("localized error banner");
                assert_eq!(err_node["role"], "alert");
                assert_eq!(err_node["name"], expected_error);
                assert!(has_state(
                    find_node(&utree, "answer-question").unwrap(),
                    "disabled"
                ));
                let key = broken_field["key"].as_str().unwrap();
                assert!(
                    find_node(&utree, &format!("field-{key}")).is_none()
                        && find_node(&utree, &format!("custom-{key}")).is_none(),
                    "closed choice must never fall back to a free-text editor"
                );
            }

            // Conditional unanswerable field stays valid while inactive and surfaces the error once active.
            let cond_form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-cond-unanswerable".into(),
                title: "Conditional".into(),
                fields: vec![
                    json!({
                        "key": "mode",
                        "title": "Mode",
                        "type": "string",
                        "default": "ok",
                        "options": [
                            {"value": "ok", "label": "Safe"},
                            {"value": "broken", "label": "Broken"}
                        ]
                    }),
                    json!({
                        "key": "dead_end",
                        "title": "Dead end",
                        "type": "string",
                        "required": true,
                        "options": [],
                        "when": [{"key": "mode", "op": "eq", "value": "broken"}]
                    }),
                ],
            };
            assert!(agent_forms::supported(&cond_form));
            let (state, _rx) = state_with_form(cond_form);
            let mut crt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
            crt.frame(0.0);
            let inactive_tree = crt.accessibility_json();
            assert!(find_node(&inactive_tree, "form-unsupported").is_none());
            assert!(!has_state(
                find_node(&inactive_tree, "answer-question").unwrap(),
                "disabled"
            ));
            tap(&mut crt, &agent_forms::string_option_key("mode", "broken"));
            let active_tree = crt.accessibility_json();
            let err_node =
                find_node(&active_tree, "form-unsupported").expect("active unanswerable alert");
            assert_eq!(err_node["name"], expected_error);
            assert!(has_state(
                find_node(&active_tree, "answer-question").unwrap(),
                "disabled"
            ));
            assert!(find_node(&active_tree, "field-dead_end").is_none());
        });
    }
}

#[test]
fn reduced_tab_order_identical_refresh_provenance_removable_multiline_impossible_bounds_and_required_groups()
 {
    crate::strings::with_locale("en", || {
        // 1. Reduced Tab order (macOS Full Keyboard Access off) still visits radios & checkboxes,
        // and required choice groups expose requiredness both visibly (*) and accessibly ("required").
        let form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r6-a11y".into(),
            title: "Choices".into(),
            fields: vec![
                json!({
                    "key": "req_radio",
                    "title": "Required target",
                    "type": "string",
                    "required": true,
                    "options": [
                        {"value": "a", "label": "Alpha"},
                        {"value": "b", "label": "Beta"}
                    ]
                }),
                json!({
                    "key": "opt_radio",
                    "title": "Optional target",
                    "type": "string",
                    "options": [{"value": "c", "label": "Gamma"}]
                }),
                json!({
                    "key": "req_multi",
                    "title": "Required tags",
                    "type": "multiselect",
                    "required": true,
                    "options": [{"value": "x", "label": "Tag X"}]
                }),
                json!({
                    "key": "opt_multi",
                    "title": "Optional tags",
                    "type": "multiselect",
                    "options": [{"value": "y", "label": "Tag Y"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(form);
        let mut rt = Runtime::new(state, render_form, (420.0, 960.0), Env::new(false, 1.0));
        rt.frame(0.0);
        rt.set_full_keyboard_access(false);
        let tree = rt.accessibility_json();
        assert!(has_state(
            find_node(&tree, &agent_forms::field_group_key("req_radio")).unwrap(),
            "required"
        ));
        assert!(!has_state(
            find_node(&tree, &agent_forms::field_group_key("opt_radio")).unwrap(),
            "required"
        ));
        let req_multi_group = find_node(&tree, &agent_forms::field_group_key("req_multi")).unwrap();
        assert!(
            !has_state(req_multi_group, "required"),
            "role=group must not rely on invalid aria-required"
        );
        assert!(
            req_multi_group["description"]
                .as_str()
                .is_some_and(|d| d.contains("Question Required")),
            "required checkbox group must convey requiredness via accessible description: {req_multi_group}"
        );
        let req_multi_box =
            find_node(&tree, &agent_forms::multi_option_key("req_multi", "x")).unwrap();
        assert!(!has_state(req_multi_box, "required"));
        assert!(
            req_multi_box["description"]
                .as_str()
                .is_some_and(|d| d.contains("Question Required")),
            "keyboard-focused checkbox in required group must inherit localized requiredness hint"
        );
        let opt_multi_group = find_node(&tree, &agent_forms::field_group_key("opt_multi")).unwrap();
        assert!(!has_state(opt_multi_group, "required"));
        assert!(opt_multi_group["description"].is_null());
        let required_markers = rt
            .elements()
            .into_iter()
            .filter(|e| {
                e.key.as_deref() == Some("required-marker") && e.text.as_deref() == Some("*")
            })
            .count();
        assert_eq!(
            required_markers, 2,
            "exactly the two required choice fields must display a visible required marker"
        );

        let alpha_key = agent_forms::string_option_key("req_radio", "a");
        let beta_key = agent_forms::string_option_key("req_radio", "b");
        let gamma_key = agent_forms::string_option_key("opt_radio", "c");
        let tag_x_key = agent_forms::multi_option_key("req_multi", "x");
        press_key(&mut rt, Key::Tab);
        assert_eq!(focused_key(&mut rt).as_deref(), Some(alpha_key.as_str()));
        press_key(&mut rt, Key::Down);
        assert_eq!(focused_key(&mut rt).as_deref(), Some(beta_key.as_str()));
        press_key(&mut rt, Key::Tab);
        assert_eq!(focused_key(&mut rt).as_deref(), Some(gamma_key.as_str()));
        press_key(&mut rt, Key::Tab);
        assert_eq!(focused_key(&mut rt).as_deref(), Some(tag_x_key.as_str()));
        press_key(&mut rt, Key::Enter);
        let after_enter = rt.accessibility_json();
        assert!(has_state(
            find_node(&after_enter, &tag_x_key).unwrap(),
            "checked"
        ));

        // 2. Identical refresh must NOT silently select an already-declared unchecked option when
        // its wire value appears in custom text (for both multiselect and string-with-options).
        let id_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r6-ident".into(),
            title: "Identical refresh".into(),
            fields: vec![
                json!({
                    "key": "multi_env",
                    "title": "Environments",
                    "type": "multiselect",
                    "custom": true,
                    "options": [{"value": "prod", "label": "Production"}]
                }),
                json!({
                    "key": "radio_env",
                    "title": "Primary",
                    "type": "string",
                    "custom": true,
                    "options": [{"value": "prod", "label": "Production"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(id_form);
        let mut id_rt = Runtime::new(state, render_form, (420.0, 760.0), Env::new(false, 1.0));
        id_rt.frame(0.0);
        id_rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            let md = a
                .drafts
                .get_mut(&("form-r6-ident".into(), "multi_env".into()))
                .unwrap();
            md.custom_editor().text = "prod".into();
            md.custom.anchor = 0;
            md.custom.focus = 4;
            let rd = a
                .drafts
                .get_mut(&("form-r6-ident".into(), "radio_env".into()))
                .unwrap();
            rd.custom_editor().text = "prod".into();
            rd.custom.anchor = 1;
            rd.custom.focus = 3;
        });
        id_rt.frame(1.0 / 60.0);
        // Apply identical snapshot refresh.
        id_rt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        id_rt.frame(2.0 / 60.0);
        {
            let a = id_rt.state.agent.as_ref().unwrap();
            let md = &a.drafts[&("form-r6-ident".into(), "multi_env".into())];
            assert!(!md.selected.contains("prod"));
            assert_eq!(md.custom.text, "prod");
            assert_eq!((md.custom.anchor, md.custom.focus), (0, 4));
            assert_eq!(
                agent_forms::validate(&a.forms[0].fields[0], md),
                Ok(Some(json!(["prod"])))
            );
            let rd = &a.drafts[&("form-r6-ident".into(), "radio_env".into())];
            assert_eq!(rd.choice, None);
            assert_eq!(rd.custom.text, "prod");
            assert_eq!((rd.custom.anchor, rd.custom.focus), (1, 3));
            // Typing a declared string option's value into custom resolves cleanly (matching Solid)
            // without disturbing the editor caret on identical snapshot refresh.
            assert_eq!(
                agent_forms::validate(&a.forms[0].fields[1], rd),
                Ok(Some(json!("prod")))
            );
            let ans = agent_forms::answer(&a.forms[0], &a.drafts)
                .expect("exact declared custom values must submit cleanly");
            assert_eq!(ans["multi_env"], json!(["prod"]));
            assert_eq!(ans["radio_env"], json!("prod"));
        }
        let id_tree = id_rt.accessibility_json();
        assert!(!has_state(
            find_input(&id_tree, "custom-multi_env"),
            "invalid"
        ));
        assert!(!has_state(
            find_input(&id_tree, "custom-radio_env"),
            "invalid"
        ));
        assert!(has_state(
            find_node(
                &id_tree,
                &agent_forms::string_option_key("radio_env", "prod")
            )
            .unwrap(),
            "checked"
        ));
        assert!(!has_state(
            find_node(&id_tree, "answer-question").unwrap(),
            "disabled"
        ));
        // Clearing "prod" from multi_env custom and selecting the declared radio resolves both conflicts.
        id_rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r6-ident".into(), "multi_env".into()))
                .unwrap()
                .custom_editor()
                .text
                .clear();
        });
        id_rt.frame(3.0 / 60.0);
        let radio_prod_key = agent_forms::string_option_key("radio_env", "prod");
        tap(&mut id_rt, &radio_prod_key);
        let id_resolved = id_rt.accessibility_json();
        assert!(has_state(
            find_node(&id_resolved, &radio_prod_key).unwrap(),
            "checked"
        ));
        assert!(!has_state(
            find_input(&id_resolved, "custom-multi_env"),
            "invalid"
        ));
        assert!(find_node(&id_resolved, "error:9:multi_env").is_none());
        assert!(!has_state(
            find_input(&id_resolved, "custom-radio_env"),
            "invalid"
        ));
        assert!(find_node(&id_resolved, "error:9:radio_env").is_none());
        assert!(!has_state(
            find_node(&id_resolved, "answer-question").unwrap(),
            "disabled"
        ));
        {
            let a = id_rt.state.agent.as_ref().unwrap();
            let ans = agent_forms::answer(&a.forms[0], &a.drafts).expect("resolved answers");
            assert_eq!(ans["multi_env"], json!([]));
            assert_eq!(ans["radio_env"], json!("prod"));
        }

        // 3. Removing options from a closed string whose default matched an option wire value
        // must NOT leak that wire value into the replacement textbox across repeated reseeds,
        // while a hidden required string keeps submitting its internal default.
        let prov_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r6-prov".into(),
            title: "Default provenance".into(),
            fields: vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "default": "internal_prod",
                    "options": [{"value": "internal_prod", "label": "Production"}]
                }),
                json!({
                    "key": "hidden_env",
                    "title": "Hidden Environment",
                    "type": "string",
                    "hidden": true,
                    "required": true,
                    "default": "secret_tier",
                    "options": [{"value": "secret_tier", "label": "Secret Tier"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(prov_form);
        let mut prt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        prt.frame(0.0);
        prt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields = vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "default": "internal_prod"
                }),
                json!({
                    "key": "hidden_env",
                    "title": "Hidden Environment",
                    "type": "string",
                    "hidden": true,
                    "required": true,
                    "default": "secret_tier"
                }),
            ];
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        prt.frame(1.0 / 60.0);
        let ptree = prt.accessibility_json();
        assert_eq!(
            find_input(&ptree, "field-env")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "prior choice wire default must not appear in free-text input after options are removed"
        );
        assert!(
            !prt.elements().iter().any(|e| e
                .text
                .as_deref()
                .is_some_and(|t| t.contains("internal_prod") || t.contains("secret_tier"))),
            "prior choice wire defaults must not appear visibly"
        );
        assert!(
            !has_state(find_node(&ptree, "answer-question").unwrap(), "disabled"),
            "hidden required string must keep submitting its preserved default"
        );
        {
            let a = prt.state.agent.as_ref().unwrap();
            let ans = agent_forms::answer(&a.forms[0], &a.drafts).expect("hidden default submits");
            assert_eq!(ans["hidden_env"], json!("secret_tier"));
            assert!(ans.get("env").is_none());
        }
        // Repeated reseed (closed with another option -> free with original wire value) must
        // retain lifetime provenance and never leak internal_prod; unhiding hidden_env must
        // also never copy secret_tier into the newly visible textbox.
        prt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "env",
                "title": "Environment",
                "type": "string",
                "default": "other_opt",
                "options": [{"value": "other_opt", "label": "Other"}]
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
            a.forms[0].fields = vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "default": "internal_prod"
                }),
                json!({
                    "key": "hidden_env",
                    "title": "Hidden Environment",
                    "type": "string",
                    "hidden": false,
                    "required": true,
                    "default": "secret_tier"
                }),
            ];
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        prt.frame(2.0 / 60.0);
        let ptree2 = prt.accessibility_json();
        assert_eq!(
            find_input(&ptree2, "field-env")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "repeated reseed must retain prior choice provenance for the lifetime of the field"
        );
        assert_eq!(
            find_input(&ptree2, "field-hidden_env")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "unhiding a field must never leak its prior choice wire value into the visible textbox"
        );

        // 4. Visible multiline multiselect default with maxItems:1 uses stable value-based keys,
        // participates in focused_control_key lookup, and preserves focus across promotion.
        let max1_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r6-max1".into(),
            title: "Single slot".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "maxItems": 1,
                "options": [{"value": "prod", "label": "Production"}],
                "default": ["team\nlocal"]
            })],
        };
        let (state, _rx) = state_with_form(max1_form);
        let mut m1 = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
        m1.frame(0.0);
        let custom_box_key = agent_forms::multi_option_key("tags", "team\nlocal");
        let prod_box_key = agent_forms::multi_option_key("tags", "prod");
        assert_eq!(
            crate::agent::focused_control_key(&m1.state, Some(&custom_box_key)),
            Some((
                custom_box_key.clone(),
                Some("pending-content-form-r6-max1".into())
            )),
            "focused_control_key must recognize preserved multiline custom checkboxes"
        );
        let m1_tree = m1.accessibility_json();
        let custom_box =
            find_node(&m1_tree, &custom_box_key).expect("visible structured default checkbox");
        assert_eq!(custom_box["role"], "check-box");
        assert_eq!(custom_box["name"], "team\nlocal");
        assert!(has_state(custom_box, "checked"));
        assert!(!has_state(
            find_node(&m1_tree, "answer-question").unwrap(),
            "disabled"
        ));
        // Checking Production while multiline default is still checked exceeds maxItems:1.
        tap(&mut m1, &prod_box_key);
        assert!(has_state(
            find_node(&m1.accessibility_json(), "answer-question").unwrap(),
            "disabled"
        ));
        // Unchecking the structured multiline default frees the slot and enables Answer with ["prod"].
        tap(&mut m1, &custom_box_key);
        let after_remove = m1.accessibility_json();
        assert!(has_state(
            find_node(&after_remove, &custom_box_key).unwrap(),
            "unchecked"
        ));
        assert!(!has_state(
            find_node(&after_remove, "answer-question").unwrap(),
            "disabled"
        ));
        let a = m1.state.agent.as_ref().unwrap();
        assert_eq!(
            agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["tags"],
            json!(["prod"])
        );

        // Two preserved multiline defaults: promoting the focused first one to a declared option
        // keeps keyboard focus on that exact option rather than shifting to the second one.
        let promo_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r7-promo".into(),
            title: "Stable preserved focus".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": [],
                "default": ["first\nval", "second\nval"]
            })],
        };
        let (state, _rx) = state_with_form(promo_form);
        let mut pr = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
        pr.frame(0.0);
        let first_key = agent_forms::multi_option_key("tags", "first\nval");
        let second_key = agent_forms::multi_option_key("tags", "second\nval");
        pr.update(|_, tx| tx.focus(first_key.clone(), true));
        pr.frame(1.0 / 60.0);
        assert_eq!(focused_key(&mut pr).as_deref(), Some(first_key.as_str()));
        pr.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": [{"value": "first\nval", "label": "First promoted"}],
                "default": ["first\nval", "second\nval"]
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        pr.frame(2.0 / 60.0);
        assert_eq!(
            focused_key(&mut pr).as_deref(),
            Some(first_key.as_str()),
            "promoting a preserved multiline default must keep focus on the same value"
        );
        press_key(&mut pr, Key::Text(" ".into()));
        let pr_tree = pr.accessibility_json();
        assert!(has_state(
            find_node(&pr_tree, &first_key).unwrap(),
            "unchecked"
        ));
        assert!(has_state(
            find_node(&pr_tree, &second_key).unwrap(),
            "checked"
        ));

        // 5. Impossible or malformed bounds (minItems:2, maxItems:1; fractional maxItems:0.5;
        // or required closed string exceeding 20,000 UTF-16 code units) are flagged unsupported,
        // fail value() directly, and surface the localized error.
        let oversized = "x".repeat(20_001);
        for impossible_field in [
            json!({
                "key": "bad_minmax",
                "title": "Contradictory",
                "type": "multiselect",
                "minItems": 2,
                "maxItems": 1,
                "options": [
                    {"value": "a", "label": "A"},
                    {"value": "b", "label": "B"}
                ]
            }),
            json!({
                "key": "fractional_max",
                "title": "Fractional maxItems",
                "type": "multiselect",
                "maxItems": 0.5,
                "options": [{"value": "a", "label": "A"}]
            }),
            json!({
                "key": "oversized_closed",
                "title": "Too long",
                "type": "string",
                "required": true,
                "options": [{"value": oversized, "label": "Giant"}]
            }),
        ] {
            let imp_form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-r6-impossible".into(),
                title: "Impossible".into(),
                fields: vec![impossible_field.clone()],
            };
            assert!(
                agent_forms::field_unanswerable(&impossible_field),
                "impossible constraints must be flagged unanswerable"
            );
            assert!(
                !agent_forms::supported(&imp_form),
                "form with unconditional impossible field must be unsupported"
            );
            let mut drafts = agent_forms::Drafts::new();
            agent_forms::seed(std::slice::from_ref(&imp_form), &mut drafts);
            let k = impossible_field["key"].as_str().unwrap().to_string();
            assert!(
                agent_forms::value(
                    &impossible_field,
                    &drafts[&("form-r6-impossible".into(), k)]
                )
                .is_err(),
                "value() must reject impossible or malformed bounds directly"
            );
            let (state, _rx) = state_with_form(imp_form);
            let mut irt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
            irt.frame(0.0);
            let itree = irt.accessibility_json();
            assert_eq!(
                find_node(&itree, "form-unsupported").unwrap()["name"],
                "Unsupported form"
            );
            assert!(has_state(
                find_node(&itree, "answer-question").unwrap(),
                "disabled"
            ));
        }

        // 6. Requiredness semantics: sole editors expose `required` directly, while hybrid
        // choice+custom fields expose `required` on a shared parent group rather than marking
        // each individual sub-control mandatory.
        let req_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r7-required".into(),
            title: "Required semantics".into(),
            fields: vec![
                json!({
                    "key": "req_text",
                    "title": "Required text",
                    "type": "string",
                    "required": true
                }),
                json!({
                    "key": "req_num",
                    "title": "Required number",
                    "type": "number",
                    "required": true
                }),
                json!({
                    "key": "req_custom_only",
                    "title": "Custom only string",
                    "type": "string",
                    "required": true,
                    "custom": true,
                    "options": []
                }),
                json!({
                    "key": "req_multi_custom_only",
                    "title": "Custom only multi",
                    "type": "multiselect",
                    "required": true,
                    "custom": true,
                    "options": []
                }),
                json!({
                    "key": "req_hybrid_radio",
                    "title": "Hybrid radio",
                    "type": "string",
                    "required": true,
                    "custom": true,
                    "options": [{"value": "a", "label": "Option A"}]
                }),
                json!({
                    "key": "req_hybrid_multi",
                    "title": "Hybrid multi",
                    "type": "multiselect",
                    "required": true,
                    "custom": true,
                    "options": [{"value": "x", "label": "Item X"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(req_form);
        let mut rrt = Runtime::new(state, render_form, (420.0, 960.0), Env::new(false, 1.0));
        rrt.frame(0.0);
        let rtree = rrt.accessibility_json();
        for sole_key in [
            "field-req_text",
            "field-req_num",
            "custom-req_custom_only",
            "custom-req_multi_custom_only",
        ] {
            assert!(
                has_state(find_input(&rtree, sole_key), "required"),
                "sole editor {sole_key} must expose required state"
            );
        }
        for (field_key, group_key, choice_key, custom_key) in [
            (
                "req_hybrid_radio",
                agent_forms::field_group_key("req_hybrid_radio"),
                agent_forms::string_option_key("req_hybrid_radio", "a"),
                "custom-req_hybrid_radio",
            ),
            (
                "req_hybrid_multi",
                agent_forms::field_group_key("req_hybrid_multi"),
                agent_forms::multi_option_key("req_hybrid_multi", "x"),
                "custom-req_hybrid_multi",
            ),
        ] {
            let shared_key = agent_forms::field_container_key(field_key);
            let shared = find_node(&rtree, &shared_key)
                .expect("shared required parent group for hybrid choice+custom field");
            assert_eq!(shared["role"], "group");
            assert!(
                !has_state(shared, "required"),
                "role=group must not emit invalid aria-required"
            );
            assert!(
                shared["description"]
                    .as_str()
                    .is_some_and(|d| d.contains("Question Required")),
                "shared hybrid group must convey localized requiredness in description: {shared}"
            );
            assert!(
                !has_state(find_node(&rtree, &group_key).unwrap(), "required"),
                "inner choice group {group_key} must not claim individual requiredness in hybrid field"
            );
            let choice_node = find_node(&rtree, &choice_key).unwrap();
            assert!(!has_state(choice_node, "required"));
            assert!(
                choice_node["description"]
                    .as_str()
                    .is_some_and(|d| d.contains("Question Required")),
                "focused choice {choice_key} inside hybrid required field must surface requirement hint"
            );
            let custom_input = find_input(&rtree, custom_key);
            assert!(
                !has_state(custom_input, "required"),
                "inner custom input {custom_key} must not claim individual requiredness in hybrid field"
            );
            assert!(
                custom_input["description"]
                    .as_str()
                    .is_some_and(|d| d.contains("Question Required")),
                "focused custom input {custom_key} inside hybrid required field must surface requirement hint"
            );
        }

        // 7a. Hidden multiselect defaults stay isolated and never leak on reveal without default.
        let hidden_multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r8-hidden-multi".into(),
            title: "Hidden multiselect".into(),
            fields: vec![json!({
                "key": "secret_tags",
                "title": "Secret tags",
                "type": "multiselect",
                "hidden": true,
                "custom": true,
                "options": [],
                "default": ["internal-token"]
            })],
        };
        let (state, _rx) = state_with_form(hidden_multi_form);
        let mut hrt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        hrt.frame(0.0);
        {
            let a = hrt.state.agent.as_ref().unwrap();
            assert_eq!(
                agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["secret_tags"],
                json!(["internal-token"])
            );
        }
        hrt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "secret_tags",
                "title": "Secret tags",
                "type": "multiselect",
                "custom": true,
                "options": []
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        hrt.frame(1.0 / 60.0);
        let htree = hrt.accessibility_json();
        assert_eq!(
            find_input(&htree, "custom-secret_tags")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "revealing a previously hidden custom multiselect must not expose its hidden default"
        );
        assert!(
            !hrt.elements().iter().any(|e| e
                .text
                .as_deref()
                .is_some_and(|t| t.contains("internal-token"))),
            "hidden multiselect default must not appear visibly after reveal"
        );

        // 7b. Native signed Infinity bounds on number fields are valid while non-finite answers
        // and unsatisfiable bounds (minimum: "Infinity") remain rejected.
        let inf_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r8-inf".into(),
            title: "Unbounded number".into(),
            fields: vec![json!({
                "key": "num_inf",
                "title": "Amount",
                "type": "number",
                "required": true,
                "minimum": "-Infinity",
                "maximum": "Infinity",
                "default": "NaN"
            })],
        };
        assert!(agent_forms::supported(&inf_form));
        assert!(!agent_forms::field_unanswerable(&inf_form.fields[0]));
        assert!(agent_forms::field_unanswerable(&json!({
            "key": "impossible_inf",
            "type": "number",
            "required": true,
            "minimum": "Infinity"
        })));
        let (state, _rx) = state_with_form(inf_form);
        let mut nrt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        nrt.frame(0.0);
        let ntree = nrt.accessibility_json();
        assert!(find_node(&ntree, "form-unsupported").is_none());
        assert_eq!(
            find_input(&ntree, "field-num_inf")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "non-finite wire default NaN must not be seeded as editable text"
        );
        nrt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.drafts
                .get_mut(&("form-r8-inf".into(), "num_inf".into()))
                .unwrap()
                .editor()
                .text = "2".into();
        });
        nrt.frame(1.0 / 60.0);
        assert!(!has_state(
            find_node(&nrt.accessibility_json(), "answer-question").unwrap(),
            "disabled"
        ));
        {
            let a = nrt.state.agent.as_ref().unwrap();
            assert_eq!(
                agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["num_inf"],
                json!(2.0)
            );
        }

        // 7c. Declared empty string value in multiselect is preserved and submittable as [""].
        let empty_multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r8-empty-multi".into(),
            title: "Empty option value".into(),
            fields: vec![json!({
                "key": "empty_opt",
                "title": "Preset",
                "type": "multiselect",
                "required": true,
                "options": [{"value": "", "label": "Default"}]
            })],
        };
        assert!(agent_forms::supported(&empty_multi_form));
        let (state, _rx) = state_with_form(empty_multi_form);
        let mut ert = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        ert.frame(0.0);
        let empty_box_key = agent_forms::multi_option_key("empty_opt", "");
        let etree = ert.accessibility_json();
        assert!(find_node(&etree, "form-unsupported").is_none());
        assert_eq!(
            find_node(&etree, &empty_box_key).unwrap()["name"],
            "Default"
        );
        tap(&mut ert, &empty_box_key);
        assert!(!has_state(
            find_node(&ert.accessibility_json(), "answer-question").unwrap(),
            "disabled"
        ));
        {
            let a = ert.state.agent.as_ref().unwrap();
            assert_eq!(
                agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["empty_opt"],
                json!([""])
            );
        }

        // 7d. Promoting a custom multiselect line during refresh preserves keyboard focus and
        // remaps the remaining selection without reparenting the editor.
        let promo_edit_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r8-promo-edit".into(),
            title: "Promote while editing".into(),
            fields: vec![json!({
                "key": "promote_tags",
                "title": "Tags",
                "type": "multiselect",
                "required": true,
                "custom": true,
                "options": []
            })],
        };
        let (state, _rx) = state_with_form(promo_edit_form);
        let mut pert = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
        pert.frame(0.0);
        pert.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            let d = a
                .drafts
                .get_mut(&("form-r8-promo-edit".into(), "promote_tags".into()))
                .unwrap();
            d.custom_editor().text = "target\nkeep editing".into();
        });
        pert.frame(1.0 / 60.0);
        let promo_input = pert
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("input") && e.path.contains("custom-promote_tags"))
            .expect("custom-promote_tags inner input");
        let promo_input_path = promo_input.path.clone();
        let px = promo_input.rect[0] + promo_input.rect[2] * 0.5;
        let py = promo_input.rect[1] + promo_input.rect[3] * 0.5;
        pert.pointer_down(px, py);
        pert.pointer_up(px, py);
        pert.frame(2.0 / 60.0);
        pert.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            let d = a
                .drafts
                .get_mut(&("form-r8-promo-edit".into(), "promote_tags".into()))
                .unwrap();
            d.custom.anchor = 12;
            d.custom.focus = 19;
        });
        pert.frame(3.0 / 60.0);
        assert!(
            pert.elements()
                .into_iter()
                .any(|e| e.path == promo_input_path && e.focused),
            "custom-promote_tags input must be focused before refresh"
        );
        pert.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "promote_tags",
                "title": "Tags",
                "type": "multiselect",
                "required": true,
                "custom": true,
                "options": [{"value": "target", "label": "Target"}]
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        pert.frame(4.0 / 60.0);
        assert!(
            pert.elements()
                .into_iter()
                .any(|e| e.path == promo_input_path && e.focused),
            "promoting a custom line must keep editor path stable and preserve keyboard focus"
        );
        {
            let a = pert.state.agent.as_ref().unwrap();
            let d = &a.drafts[&("form-r8-promo-edit".into(), "promote_tags".into())];
            assert!(d.selected.contains("target"));
            assert_eq!(d.custom.text, "keep editing");
            assert_eq!(
                (d.custom.anchor, d.custom.focus),
                (5, 12),
                "selection on remaining line ('editing') must survive line promotion"
            );
            assert!(d.custom.focused);
        }
    });

    // 7e. Violated field limits (maxLength, minItems) expose localized field-associated errors
    // and invalid states in both en and fr, clearing as soon as the field becomes valid.
    for (locale, max_len_expected, min_items_expected) in [
        ("en", "Limit: ≤ 3", "Limit: ≥ 2 items"),
        ("fr", "Limite : ≤ 3", "Limite : ≥ 2 éléments"),
    ] {
        crate::strings::with_locale(locale, || {
            let val_form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-r8-validation".into(),
                title: "Limits".into(),
                fields: vec![
                    json!({
                        "key": "short_text",
                        "title": "Code",
                        "type": "string",
                        "maxLength": 3
                    }),
                    json!({
                        "key": "min_tags",
                        "title": "Tags",
                        "type": "multiselect",
                        "minItems": 2,
                        "options": [
                            {"value": "a", "label": "Alpha"},
                            {"value": "b", "label": "Beta"}
                        ]
                    }),
                ],
            };
            let (state, _rx) = state_with_form(val_form);
            let mut vrt = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
            vrt.frame(0.0);
            // Enter 4 chars in maxLength:3 field and check 1 option in minItems:2 multiselect.
            vrt.update(|s, _| {
                let a = s.agent.as_mut().unwrap();
                a.drafts
                    .get_mut(&("form-r8-validation".into(), "short_text".into()))
                    .unwrap()
                    .editor()
                    .text = "abcd".into();
            });
            vrt.frame(1.0 / 60.0);
            let tag_a = agent_forms::multi_option_key("min_tags", "a");
            let tag_b = agent_forms::multi_option_key("min_tags", "b");
            tap(&mut vrt, &tag_a);
            let vtree = vrt.accessibility_json();
            assert!(has_state(
                find_node(&vtree, "answer-question").unwrap(),
                "disabled"
            ));
            let short_in = find_input(&vtree, "field-short_text");
            assert!(has_state(short_in, "invalid"));
            assert!(
                short_in["description"]
                    .as_str()
                    .is_some_and(|d| d.contains(max_len_expected)),
                "maxLength violation must reach input description ({locale}): {short_in}"
            );
            let short_err = find_node(&vtree, "error:10:short_text").unwrap();
            assert_eq!(short_err["role"], "alert");
            assert_eq!(short_err["name"], max_len_expected);

            let tag_a_node = find_node(&vtree, &tag_a).unwrap();
            assert!(has_state(tag_a_node, "invalid"));
            assert!(
                tag_a_node["description"]
                    .as_str()
                    .is_some_and(|d| d.contains(min_items_expected)),
                "minItems violation must reach checkbox description ({locale}): {tag_a_node}"
            );
            let tags_err = find_node(&vtree, "error:8:min_tags").unwrap();
            assert_eq!(tags_err["role"], "alert");
            assert_eq!(tags_err["name"], min_items_expected);

            // Fix both violations -> alerts and invalid states clear and Answer enables.
            vrt.update(|s, _| {
                let a = s.agent.as_mut().unwrap();
                a.drafts
                    .get_mut(&("form-r8-validation".into(), "short_text".into()))
                    .unwrap()
                    .editor()
                    .text = "abc".into();
            });
            vrt.frame(2.0 / 60.0);
            tap(&mut vrt, &tag_b);
            let ok_tree = vrt.accessibility_json();
            assert!(!has_state(
                find_input(&ok_tree, "field-short_text"),
                "invalid"
            ));
            assert!(find_node(&ok_tree, "error:10:short_text").is_none());
            assert!(!has_state(find_node(&ok_tree, &tag_a).unwrap(), "invalid"));
            assert!(find_node(&ok_tree, "error:8:min_tags").is_none());
            assert!(!has_state(
                find_node(&ok_tree, "answer-question").unwrap(),
                "disabled"
            ));
        });
    }

    // 8. Round-9 regressions: hidden option provenance into custom editor, active hidden invalid
    // form alert without leaking secrets, trailing-newline preservation on line promotion, and
    // Clear returning focus to the cleared field's first radio without selecting it.
    crate::strings::with_locale("en", || {
        // 8a. Hidden string option value must NOT leak into custom editor when revealed with new options.
        let hidden_opt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r9-hidden-opt".into(),
            title: "Hidden option provenance".into(),
            fields: vec![json!({
                "key": "hidden_opt",
                "title": "Target",
                "type": "string",
                "hidden": true,
                "default": "internal_prod",
                "options": [{"value": "internal_prod", "label": "Production"}]
            })],
        };
        let (state, _rx) = state_with_form(hidden_opt_form);
        let mut hopt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        hopt.frame(0.0);
        hopt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "hidden_opt",
                "title": "Target",
                "type": "string",
                "custom": true,
                "default": "internal_prod",
                "options": [{"value": "other", "label": "Other"}]
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        hopt.frame(1.0 / 60.0);
        let hopt_tree = hopt.accessibility_json();
        assert_eq!(
            find_input(&hopt_tree, "custom-hidden_opt")["value"]
                .as_str()
                .unwrap_or(""),
            "",
            "prior hidden option value must not appear in custom textarea on reveal"
        );
        assert!(
            !hopt.elements().iter().any(|e| e
                .text
                .as_deref()
                .is_some_and(|t| t.contains("internal_prod"))),
            "prior hidden option value must not appear visibly"
        );

        // 8b. Active hidden required field without default surfaces form-level alert without
        // exposing hidden keys or values.
        let hidden_invalid_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r9-hidden-invalid".into(),
            title: "Hidden blocker".into(),
            fields: vec![
                json!({
                    "key": "visible_note",
                    "title": "Note",
                    "type": "string",
                    "default": "ok"
                }),
                json!({
                    "key": "internal_secret_field",
                    "title": "Secret",
                    "type": "string",
                    "hidden": true,
                    "required": true
                }),
            ],
        };
        let (state, _rx) = state_with_form(hidden_invalid_form);
        let mut hinv = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        hinv.frame(0.0);
        let hinv_tree = hinv.accessibility_json();
        assert!(has_state(
            find_node(&hinv_tree, "answer-question").unwrap(),
            "disabled"
        ));
        let alert = find_node(&hinv_tree, "form-unsupported")
            .expect("active invalid hidden field must surface localized form-level alert");
        assert_eq!(alert["role"], "alert");
        assert_eq!(alert["name"], "Unsupported form");
        assert!(
            !hinv.elements().iter().any(|e| e
                .text
                .as_deref()
                .is_some_and(|t| t.contains("internal_secret_field"))),
            "hidden field key must never appear visibly"
        );

        // 8c. Promoting a multiselect line preserves trailing newline and caret on empty last line.
        let trailing_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r9-trailing".into(),
            title: "Trailing newline".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": []
            })],
        };
        let mut tdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&trailing_form), &mut tdrafts);
        {
            let d = tdrafts
                .get_mut(&("form-r9-trailing".into(), "tags".into()))
                .unwrap();
            d.custom_editor().text = "target\nkeep\n".into();
            d.custom.anchor = 12;
            d.custom.focus = 12;
        }
        let mut refreshed = trailing_form.clone();
        refreshed.fields[0] = json!({
            "key": "tags",
            "title": "Tags",
            "type": "multiselect",
            "custom": true,
            "options": [{"value": "target", "label": "Target"}]
        });
        agent_forms::seed(std::slice::from_ref(&refreshed), &mut tdrafts);
        {
            let d = tdrafts
                .get_mut(&("form-r9-trailing".into(), "tags".into()))
                .unwrap();
            assert!(d.selected.contains("target"));
            assert_eq!(d.custom.text, "keep\n");
            assert_eq!((d.custom.anchor, d.custom.focus), (5, 5));
            d.custom.text.insert_str(d.custom.focus, "new");
            assert_eq!(d.custom.text, "keep\nnew");
        }

        // 8d. Activating Clear on a mid-form optional choice returns focus to that field's first
        // radio without selecting it, so the next Tab continues forward instead of restarting.
        let clear_nav_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r9-clear-nav".into(),
            title: "Clear focus continuity".into(),
            fields: vec![
                json!({
                    "key": "first_bool",
                    "title": "First",
                    "type": "boolean",
                    "default": true
                }),
                json!({
                    "key": "mid_choice",
                    "title": "Middle choice",
                    "type": "string",
                    "default": "b",
                    "options": [
                        {"value": "a", "label": "Alpha"},
                        {"value": "b", "label": "Beta"}
                    ]
                }),
                json!({
                    "key": "last_tags",
                    "title": "Last tags",
                    "type": "multiselect",
                    "options": [{"value": "z", "label": "Zeta"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(clear_nav_form);
        let mut crt = Runtime::new(state, render_form, (420.0, 820.0), Env::new(false, 1.0));
        crt.frame(0.0);
        let mid_a = agent_forms::string_option_key("mid_choice", "a");
        let mid_b = agent_forms::string_option_key("mid_choice", "b");
        let mid_clear = agent_forms::clear_option_key("mid_choice");
        let last_z = agent_forms::multi_option_key("last_tags", "z");
        crt.update(|_, tx| tx.focus(mid_clear.clone(), true));
        crt.frame(1.0 / 60.0);
        assert_eq!(focused_key(&mut crt).as_deref(), Some(mid_clear.as_str()));
        press_key(&mut crt, Key::Enter);
        assert_eq!(
            focused_key(&mut crt).as_deref(),
            Some(mid_a.as_str()),
            "Clear must return focus to the cleared field's first radio, not the top of the form"
        );
        let after_clear = crt.accessibility_json();
        assert!(has_state(
            find_node(&after_clear, &mid_a).unwrap(),
            "unchecked"
        ));
        assert!(has_state(
            find_node(&after_clear, &mid_b).unwrap(),
            "unchecked"
        ));
        press_key(&mut crt, Key::Tab);
        assert_eq!(
            focused_key(&mut crt).as_deref(),
            Some(last_z.as_str()),
            "Tab after Clear must advance forward to the next field instead of revisiting earlier fields"
        );

        // 9a. Hidden multiselect wire provenance must never leak into either a visible free-text
        // editor or a visible custom multiselect editor on reveal.
        for reveal_field in [
            json!({
                "key": "secret_m",
                "title": "Secret",
                "type": "string",
                "default": "internal-id"
            }),
            json!({
                "key": "secret_m",
                "title": "Secret",
                "type": "multiselect",
                "custom": true,
                "options": [],
                "default": ["internal-id"]
            }),
        ] {
            let hm_form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-r10-multi-prov".into(),
                title: "Multiselect wire provenance".into(),
                fields: vec![json!({
                    "key": "secret_m",
                    "title": "Secret",
                    "type": "multiselect",
                    "hidden": true,
                    "options": [{"value": "internal-id", "label": "Internal"}],
                    "default": ["internal-id"]
                })],
            };
            let (state, _rx) = state_with_form(hm_form);
            let mut hrt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
            hrt.frame(0.0);
            hrt.update(|s, _| {
                let a = s.agent.as_mut().unwrap();
                a.forms[0].fields[0] = reveal_field.clone();
                agent_forms::seed(&a.forms, &mut a.drafts);
            });
            hrt.frame(1.0 / 60.0);
            let htree = hrt.accessibility_json();
            let input_key = if reveal_field["type"] == "string" {
                "field-secret_m"
            } else {
                "custom-secret_m"
            };
            assert_eq!(
                find_input(&htree, input_key)["value"]
                    .as_str()
                    .unwrap_or(""),
                "",
                "hidden multiselect wire value must not leak into {input_key}"
            );
            assert!(
                !hrt.elements()
                    .iter()
                    .any(|e| e.text.as_deref().is_some_and(|t| t.contains("internal-id"))),
                "hidden multiselect wire value must not appear visibly"
            );
        }

        // 9b. Untouched visible required free-text field becoming hidden with a valid default
        // adopts that hidden default and enables Answer cleanly.
        let vis_to_hidden = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r10-hide".into(),
            title: "Visibility transition".into(),
            fields: vec![json!({
                "key": "token",
                "title": "Token",
                "type": "string",
                "required": true
            })],
        };
        let (state, _rx) = state_with_form(vis_to_hidden);
        let mut vrt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        vrt.frame(0.0);
        // Tab into untouched required editor without typing -> must stay clean and not mark dirty.
        press_key(&mut vrt, Key::Tab);
        let focused_tree = vrt.accessibility_json();
        assert!(
            !has_state(find_input(&focused_tree, "field-token"), "invalid"),
            "tabbing into untouched required textbox must not mark it invalid"
        );
        assert!(
            find_node(&focused_tree, "error:5:token").is_none(),
            "tabbing into untouched required textbox must not emit an assertive alert"
        );
        // Refresh the same untouched field as hidden with default "fixed" -> Answer enables with "fixed".
        vrt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0] = json!({
                "key": "token",
                "title": "Token",
                "type": "string",
                "hidden": true,
                "required": true,
                "default": "fixed"
            });
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        vrt.frame(2.0 / 60.0);
        let hidden_tree = vrt.accessibility_json();
        assert!(find_node(&hidden_tree, "form-unsupported").is_none());
        assert!(!has_state(
            find_node(&hidden_tree, "answer-question").unwrap(),
            "disabled"
        ));
        {
            let a = vrt.state.agent.as_ref().unwrap();
            assert_eq!(
                agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["token"],
                json!("fixed")
            );
        }

        // 9c. Invalid hidden non-custom multiselect default (["allowed", "unknown"]) is rejected
        // instead of silently stripped, disabling Answer and surfacing the hidden-field alert.
        let invalid_hidden_multi = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r10-bad-hidden-multi".into(),
            title: "Invalid hidden default".into(),
            fields: vec![json!({
                "key": "hidden_tags",
                "title": "Tags",
                "type": "multiselect",
                "hidden": true,
                "required": true,
                "options": [{"value": "allowed", "label": "Allowed"}],
                "default": ["allowed", "unknown"]
            })],
        };
        let (state, _rx) = state_with_form(invalid_hidden_multi);
        let mut bmrt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        bmrt.frame(0.0);
        {
            let a = bmrt.state.agent.as_ref().unwrap();
            assert!(
                agent_forms::answer(&a.forms[0], &a.drafts).is_err(),
                "disallowed entry in hidden multiselect default must be rejected"
            );
        }
        let bm_tree = bmrt.accessibility_json();
        assert!(has_state(
            find_node(&bm_tree, "answer-question").unwrap(),
            "disabled"
        ));
        assert_eq!(
            find_node(&bm_tree, "form-unsupported").unwrap()["name"],
            "Unsupported form"
        );

        // 9d. Refresh adding a custom multiselect entry to `options` while disabling `custom`
        // promotes the newly declared option first instead of discarding it.
        let promo_disable_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r10-promo-disable".into(),
            title: "Promote on custom=false".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": []
            })],
        };
        let mut pdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&promo_disable_form), &mut pdrafts);
        pdrafts
            .get_mut(&("form-r10-promo-disable".into(), "tags".into()))
            .unwrap()
            .custom_editor()
            .text = "target\nleftover".into();
        let mut promo_closed = promo_disable_form.clone();
        promo_closed.fields[0] = json!({
            "key": "tags",
            "title": "Tags",
            "type": "multiselect",
            "custom": false,
            "options": [{"value": "target", "label": "Target"}]
        });
        agent_forms::seed(std::slice::from_ref(&promo_closed), &mut pdrafts);
        assert_eq!(
            agent_forms::answer(&promo_closed, &pdrafts).unwrap()["tags"],
            json!(["target"])
        );

        // 9e. Browser web-mirror / aria-activedescendant focus proxy for two required Yes/No
        // fields exposes each field's distinct question title and requiredness on the focused
        // radio itself without setting invalid aria-required on individual radios.
        let two_bools_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r10-web-radios".into(),
            title: "Confirmations".into(),
            fields: vec![
                json!({
                    "key": "proceed",
                    "title": "Proceed now?",
                    "type": "boolean",
                    "required": true
                }),
                json!({
                    "key": "notify",
                    "title": "Notify team?",
                    "type": "boolean",
                    "required": true
                }),
            ],
        };
        let (state, _rx) = state_with_form(two_bools_form);
        let mut wrt = Runtime::new(state, render_form, (420.0, 640.0), Env::new(false, 1.0));
        wrt.frame(0.0);
        let web_items: Vec<serde_json::Value> = serde_json::from_str(&wrt.a11y_json()).unwrap();
        let radios: Vec<&serde_json::Value> = web_items
            .iter()
            .filter(|item| item["o"] == "radio")
            .collect();
        assert_eq!(radios.len(), 4);
        assert!(
            radios.iter().all(|r| r.get("rq").is_none()),
            "individual radios in web mirror must not set aria-required: {radios:?}"
        );
        let group_of =
            |r: &serde_json::Value| r["a"].as_u64().and_then(|idx| web_items.get(idx as usize));
        assert!(
            radios.iter().any(|r| {
                r["t"] == "Yes"
                    && r["d"]
                        .as_str()
                        .is_some_and(|d| d.contains("Question Required"))
                    && group_of(r).is_some_and(|g| {
                        g["o"] == "radiogroup" && g["t"] == "Proceed now?" && g["rq"] == json!(true)
                    })
            }),
            "first Yes radio web mirror must link to its radiogroup title and expose requiredness: {web_items:?}"
        );
        assert!(
            radios.iter().any(|r| {
                r["t"] == "Yes"
                    && r["d"]
                        .as_str()
                        .is_some_and(|d| d.contains("Question Required"))
                    && group_of(r).is_some_and(|g| {
                        g["o"] == "radiogroup" && g["t"] == "Notify team?" && g["rq"] == json!(true)
                    })
            }),
            "second Yes radio web mirror must link to its radiogroup title and expose requiredness: {web_items:?}"
        );
    });
}

#[test]
fn close_guard_descriptions_hidden_reveal_cascades_patterns_empty_choice_and_blank_custom() {
    crate::strings::with_locale("en", || {
        // 1. Close guard (`navigation_blocked`) stays false when merely tabbing into an untouched
        // pending question textbox, turns true as soon as text is edited on both active and cached
        // tabs, and stays consistent with `Draft::is_dirty()`.
        let guard_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-guard".into(),
            title: "Question".into(),
            fields: vec![json!({
                "key": "note",
                "title": "Note",
                "type": "string",
                "required": true
            })],
        };
        let (state, _rx) = state_with_form(guard_form);
        let mut grt = Runtime::new(state, render_form, (420.0, 480.0), Env::new(false, 1.0));
        grt.frame(0.0);
        assert!(
            !crate::agent::navigation_blocked(&grt.state),
            "untouched form must not block tab close"
        );
        // Focus the textbox without editing text.
        let note_el = grt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("input") && e.path.contains("field-note"))
            .expect("field-note inner input");
        grt.pointer_down(
            note_el.rect[0] + note_el.rect[2] * 0.5,
            note_el.rect[1] + note_el.rect[3] * 0.5,
        );
        grt.pointer_up(
            note_el.rect[0] + note_el.rect[2] * 0.5,
            note_el.rect[1] + note_el.rect[3] * 0.5,
        );
        grt.frame(1.0 / 60.0);
        assert!(
            !crate::agent::navigation_blocked(&grt.state),
            "focusing without typing must not block tab close"
        );
        // Typing into the textbox trips navigation_blocked on both the active tab and when the tab
        // is suspended into workspace cache after switching away.
        press_key(&mut grt, Key::Text("hello".into()));
        assert!(
            crate::agent::navigation_blocked(&grt.state),
            "typing into a pending question textbox must trip active tab close guard"
        );
        let mut ws_state = crate::init();
        crate::gallery::shell::fixture(&mut ws_state);
        let mut ws_ui = crate::workspace::Ui::new();
        ws_ui.fixture_ready();
        ws_state.workspace = Some(ws_ui);
        let proj0 = ws_state.screen.launcher().unwrap().project.clone().unwrap();
        crate::workspace::opened(&mut ws_state, &proj0);
        let mut ws_rt = Runtime::new(
            ws_state,
            |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
            (1200.0, 800.0),
            Env::new(false, 1.0),
        );
        ws_rt.update(|s, tx| {
            crate::workspace::new_tab(s, tx);
            let proj1 = crate::catalog::Project {
                id: "project-1".into(),
                path: "/repo-1".into(),
                temporary: false,
            };
            if let Some(l) = s.screen.launcher_mut() {
                l.project = Some(proj1.clone());
                l.sessions = vec![crate::catalog::Session {
                    id: "session-1".into(),
                    title: "Session 1".into(),
                }];
            }
            crate::workspace::opened(s, &proj1);
            crate::workspace::select(s, "tab-0", tx);
        });
        ws_rt.state.agent = grt.state.agent.take();
        // Active tab-0 cannot close while edited pending question textbox is dirty.
        ws_rt.update(|s, tx| crate::workspace::close(s, "tab-0", tx));
        assert_eq!(
            ws_rt.state.workspace.as_ref().unwrap().tab_count(),
            2,
            "active tab with edited question textbox must block tab close"
        );
        // Switching to tab-1 caches tab-0; closing cached tab-0 must still be blocked.
        ws_rt.update(|s, tx| {
            crate::workspace::select(s, "tab-1", tx);
            crate::workspace::close(s, "tab-0", tx);
        });
        assert_eq!(
            ws_rt.state.workspace.as_ref().unwrap().tab_count(),
            2,
            "cached tab with edited question textbox must also block tab close"
        );

        // 2. Browser focus proxy (`a11y_json`) includes field description on radios (boolean &
        // string options) and checkboxes (multiselect) so OpenCode's actual question prose is
        // announced alongside the short header.
        let desc_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-desc".into(),
            title: "Setup".into(),
            fields: vec![
                json!({
                    "key": "db",
                    "title": "Database",
                    "description": "Keep the existing database?",
                    "type": "boolean",
                    "required": true
                }),
                json!({
                    "key": "tier",
                    "title": "Tier",
                    "description": "Which deployment tier should be used?",
                    "type": "string",
                    "options": [{"value": "staging", "label": "Staging"}]
                }),
                json!({
                    "key": "extras",
                    "title": "Extras",
                    "description": "Select optional modules to enable.",
                    "type": "multiselect",
                    "options": [{"value": "metrics", "label": "Metrics"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(desc_form);
        let mut drt = Runtime::new(state, render_form, (420.0, 820.0), Env::new(false, 1.0));
        drt.frame(0.0);
        let web_items: Vec<serde_json::Value> = serde_json::from_str(&drt.a11y_json()).unwrap();
        let group_of = |item: &serde_json::Value| {
            item["a"]
                .as_u64()
                .and_then(|idx| web_items.get(idx as usize))
        };
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "radio"
                    && item["t"] == "Yes"
                    && group_of(item).is_some_and(|g| {
                        g["o"] == "radiogroup"
                            && g["t"] == "Database"
                            && g["d"]
                                .as_str()
                                .is_some_and(|d| d.contains("Keep the existing database?"))
                    })
            }),
            "boolean radio web mirror must link to radiogroup carrying header and field description once: {web_items:?}"
        );
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "radio"
                    && item["t"] == "Staging"
                    && group_of(item).is_some_and(|g| {
                        g["o"] == "radiogroup"
                            && g["t"] == "Tier"
                            && g["d"].as_str().is_some_and(|d| {
                                d.contains("Which deployment tier should be used?")
                            })
                    })
            }),
            "string radio web mirror must link to radiogroup carrying header and field description once: {web_items:?}"
        );
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "checkbox"
                    && item["t"] == "Metrics"
                    && group_of(item).is_some_and(|g| {
                        g["o"] == "group"
                            && g["t"] == "Extras"
                            && g["d"]
                                .as_str()
                                .is_some_and(|d| d.contains("Select optional modules to enable."))
                    })
            }),
            "multiselect checkbox web mirror must link to group carrying header and field description once: {web_items:?}"
        );

        // 3. Refreshing a hidden custom multiselect with `options: []` and `default: ["opaque-token"]`
        // to `hidden: false` while retaining the same default must never hydrate `"opaque-token"`
        // into the visible or accessible custom editor.
        let hidden_opaque_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-hidden-opaque".into(),
            title: "Opaque reveal".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "hidden": true,
                "options": [],
                "default": ["opaque-token"]
            })],
        };
        let (state, _rx) = state_with_form(hidden_opaque_form);
        let mut hrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        hrt.frame(0.0);
        hrt.update(|s, _| {
            let a = s.agent.as_mut().unwrap();
            a.forms[0].fields[0]["hidden"] = json!(false);
            agent_forms::seed(&a.forms, &mut a.drafts);
        });
        hrt.frame(1.0 / 60.0);
        hrt.frame(1.0);
        let htree = hrt.accessibility_json();
        let mut hvals = Vec::new();
        collect_values(&htree, &mut hvals);
        assert!(
            !hvals.iter().any(|v| v.contains("opaque-token"))
                && !hrt.elements().iter().any(|e| e
                    .text
                    .as_deref()
                    .is_some_and(|t| t.contains("opaque-token"))),
            "retained hidden default must never leak into visible custom editor on reveal: {hvals:?}"
        );

        // 4. Cascading `when` resolves in schema order against active answers only, and numeric
        // `when` rules compare integer/number answers numerically (`1` == `1.0`).
        let cascade_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-cascade".into(),
            title: "Cascade".into(),
            fields: vec![
                json!({"key": "a", "title": "Enable", "type": "boolean", "default": false}),
                json!({
                    "key": "b",
                    "title": "Mode",
                    "type": "string",
                    "default": "yes",
                    "when": [{"key": "a", "op": "eq", "value": true}]
                }),
                json!({
                    "key": "c",
                    "title": "Detail",
                    "type": "string",
                    "required": true,
                    "when": [{"key": "b", "op": "eq", "value": "yes"}]
                }),
                json!({
                    "key": "count",
                    "title": "Count",
                    "type": "integer",
                    "default": 1
                }),
                json!({
                    "key": "one_extra",
                    "title": "When one",
                    "type": "string",
                    "required": true,
                    "when": [{"key": "count", "op": "eq", "value": 1}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(cascade_form);
        let mut crt = Runtime::new(state, render_form, (420.0, 760.0), Env::new(false, 1.0));
        crt.frame(0.0);
        let ctree = crt.accessibility_json();
        assert!(
            find_node(&ctree, "field-b").is_none() && find_node(&ctree, "field-c").is_none(),
            "inactive cascade fields b and c must not render while a=false"
        );
        assert!(
            find_node(&ctree, "field-one_extra").is_some(),
            "integer answer 1 must activate field with numeric when value 1"
        );
        crt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r11-cascade".into(), "one_extra".into()))
                .unwrap()
                .editor()
                .text = "matched".into();
        });
        crt.frame(1.0 / 60.0);
        let a = crt.state.agent.as_ref().unwrap();
        let cans = agent_forms::answer(&a.forms[0], &a.drafts)
            .expect("inactive cascade must not require c, and integer 1 must match");
        assert_eq!(cans["a"], json!(false));
        assert!(cans.get("b").is_none() && cans.get("c").is_none());
        assert_eq!(cans["count"], json!(1));
        assert_eq!(cans["one_extra"], json!("matched"));

        // 5. Native string `pattern` and `format` constraints (`uri`, `email`, `date`, `date-time`)
        // block Answer and surface inline field errors until valid; invalid regex fails closed.
        let constraint_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-constraints".into(),
            title: "Constraints".into(),
            fields: vec![
                json!({"key": "code", "title": "Code", "type": "string", "required": true, "pattern": "^ok$"}),
                json!({"key": "site", "title": "Site", "type": "string", "format": "uri"}),
                json!({"key": "mail", "title": "Mail", "type": "string", "format": "email"}),
                json!({"key": "day", "title": "Day", "type": "string", "format": "date"}),
                json!({"key": "stamp", "title": "Stamp", "type": "string", "format": "date-time"}),
            ],
        };
        let (state, _rx) = state_with_form(constraint_form);
        let mut prt = Runtime::new(state, render_form, (420.0, 960.0), Env::new(false, 1.0));
        prt.frame(0.0);
        prt.update(|s, _| {
            let d = &mut s.agent.as_mut().unwrap().drafts;
            d.get_mut(&("form-r11-constraints".into(), "code".into()))
                .unwrap()
                .editor()
                .text = "bad".into();
            d.get_mut(&("form-r11-constraints".into(), "site".into()))
                .unwrap()
                .editor()
                .text = "not-a-uri".into();
            d.get_mut(&("form-r11-constraints".into(), "mail".into()))
                .unwrap()
                .editor()
                .text = "missing-at".into();
            d.get_mut(&("form-r11-constraints".into(), "day".into()))
                .unwrap()
                .editor()
                .text = "2026-02-30".into();
            d.get_mut(&("form-r11-constraints".into(), "stamp".into()))
                .unwrap()
                .editor()
                .text = "not-a-date-time".into();
        });
        prt.frame(1.0 / 60.0);
        let ptree = prt.accessibility_json();
        assert!(has_state(
            find_node(&ptree, "answer-question").unwrap(),
            "disabled"
        ));
        for k in ["code", "site", "mail", "day", "stamp"] {
            let err_key = format!("error:{}:{k}", k.len());
            assert_eq!(
                find_node(&ptree, &err_key).expect("inline format/pattern error")["name"],
                "Invalid"
            );
        }
        assert!(
            agent_forms::answer(
                &prt.state.agent.as_ref().unwrap().forms[0],
                &prt.state.agent.as_ref().unwrap().drafts
            )
            .is_err()
        );
        prt.update(|s, _| {
            let d = &mut s.agent.as_mut().unwrap().drafts;
            d.get_mut(&("form-r11-constraints".into(), "code".into()))
                .unwrap()
                .editor()
                .text = "ok".into();
            d.get_mut(&("form-r11-constraints".into(), "site".into()))
                .unwrap()
                .editor()
                .text = "https://example.com/path?x=1".into();
            d.get_mut(&("form-r11-constraints".into(), "mail".into()))
                .unwrap()
                .editor()
                .text = "dev@example.com".into();
            d.get_mut(&("form-r11-constraints".into(), "day".into()))
                .unwrap()
                .editor()
                .text = "2024-02-29".into();
            d.get_mut(&("form-r11-constraints".into(), "stamp".into()))
                .unwrap()
                .editor()
                .text = "2026-11-26T14:30:00Z".into();
        });
        prt.frame(1.0 / 60.0);
        let ptree_ok = prt.accessibility_json();
        assert!(!has_state(
            find_node(&ptree_ok, "answer-question").unwrap(),
            "disabled"
        ));
        let pans = agent_forms::answer(
            &prt.state.agent.as_ref().unwrap().forms[0],
            &prt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("valid pattern and formats must submit");
        assert_eq!(pans["code"], json!("ok"));
        assert_eq!(pans["day"], json!("2024-02-29"));
        let bad_regex_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-bad-regex".into(),
            title: "Bad regex".into(),
            fields: vec![json!({
                "key": "re",
                "title": "Regex",
                "type": "string",
                "required": true,
                "pattern": "[unclosed"
            })],
        };
        assert!(!agent_forms::supported(&bad_regex_form));

        // 6. Optional scalar string choice with `{value: "", label: "Use default"}` renders,
        // distinguishes `Some("")` from unselected `None`, and submits `""` when selected or omits
        // the key when cleared.
        let empty_opt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-empty-opt".into(),
            title: "Optional default".into(),
            fields: vec![json!({
                "key": "mode",
                "title": "Mode",
                "type": "string",
                "default": "",
                "options": [
                    {"value": "", "label": "Use default"},
                    {"value": "custom_mode", "label": "Custom mode"}
                ]
            })],
        };
        let (state, _rx) = state_with_form(empty_opt_form);
        let mut ert = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        ert.frame(0.0);
        let etree = ert.accessibility_json();
        let empty_radio_key = agent_forms::string_option_key("mode", "");
        let empty_radio =
            find_node(&etree, &empty_radio_key).expect("optional empty radio must render");
        assert_eq!(empty_radio["name"], "Use default");
        assert!(has_state(empty_radio, "checked"));
        assert_eq!(
            agent_forms::answer(
                &ert.state.agent.as_ref().unwrap().forms[0],
                &ert.state.agent.as_ref().unwrap().drafts
            )
            .unwrap()["mode"],
            json!(""),
            "explicit empty optional choice must submit empty string"
        );
        tap(&mut ert, &agent_forms::clear_option_key("mode"));
        let cleared = agent_forms::answer(
            &ert.state.agent.as_ref().unwrap().forms[0],
            &ert.state.agent.as_ref().unwrap().drafts,
        )
        .unwrap();
        assert!(
            cleared.get("mode").is_none(),
            "clearing optional empty choice must omit key from answer"
        );
        tap(&mut ert, &empty_radio_key);
        assert_eq!(
            agent_forms::answer(
                &ert.state.agent.as_ref().unwrap().forms[0],
                &ert.state.agent.as_ref().unwrap().drafts
            )
            .unwrap()["mode"],
            json!("")
        );

        // 7. Visible custom multiselect with whitespace-only preserved default `[" "]` gets a
        // localized non-blank label so it stays present in the browser mirror, can be discovered
        // and unchecked, and keeps the exact `" "` answer value separate from its display label.
        let blank_custom_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r11-blank-custom".into(),
            title: "Blank custom".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": [],
                "default": [" "]
            })],
        };
        let (state, _rx) = state_with_form(blank_custom_form);
        let mut brt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        brt.frame(0.0);
        let btree = brt.accessibility_json();
        let blank_key = agent_forms::multi_option_key("tags", " ");
        let blank_node =
            find_node(&btree, &blank_key).expect("preserved blank custom checkbox must render");
        assert_eq!(blank_node["name"], "Other values 1");
        assert!(has_state(blank_node, "checked"));
        let bweb: Vec<serde_json::Value> = serde_json::from_str(&brt.a11y_json()).unwrap();
        assert!(
            bweb.iter().any(|item| {
                item["o"] == "checkbox" && item["t"] == "Other values 1" && item["c"] == "true"
            }),
            "preserved blank custom checkbox must stay visible in browser web mirror: {bweb:?}"
        );
        assert_eq!(
            agent_forms::answer(
                &brt.state.agent.as_ref().unwrap().forms[0],
                &brt.state.agent.as_ref().unwrap().drafts
            )
            .unwrap()["tags"],
            json!([" "])
        );
        tap(&mut brt, &blank_key);
        assert_eq!(
            agent_forms::answer(
                &brt.state.agent.as_ref().unwrap().forms[0],
                &brt.state.agent.as_ref().unwrap().drafts
            )
            .unwrap()["tags"],
            json!([])
        );
    });
}

#[test]
fn bounded_patterns_opencode_parity_inactive_constraints_hidden_roundtrip_opaque_paths_and_custom_labels()
 {
    crate::strings::with_locale("en", || {
        // 1. Nested empty-repeat pattern completes cleanly in bounded time without freezing.
        let dos_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-dos".into(),
            title: "Bounded pattern".into(),
            fields: vec![json!({
                "key": "re",
                "title": "Pattern",
                "type": "string",
                "pattern": "(?:(?:(?:(?:a{0}){256}){256}){256}){256}"
            })],
        };
        assert!(
            agent_forms::supported(&dos_form),
            "valid nested empty-repeat pattern must complete in bounded time without freezing"
        );

        // 2. OpenCode string constraint parity: unanchored pattern (`abc` matches `xabcx`),
        // email (`a@b` rejected, `dev@example.com` accepted), and date-time
        // (`2026-11-26T25:00` rejected, `2026-11-26T14:30` and `2026-11-26T14:30:00+02:00` accepted).
        let parity_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-parity".into(),
            title: "Parity".into(),
            fields: vec![
                json!({"key": "sub", "title": "Sub", "type": "string", "required": true, "pattern": "abc"}),
                json!({"key": "mail", "title": "Mail", "type": "string", "format": "email"}),
                json!({"key": "dt", "title": "When", "type": "string", "format": "date-time"}),
            ],
        };
        let mut drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&parity_form), &mut drafts);
        drafts
            .get_mut(&("form-r12-parity".into(), "sub".into()))
            .unwrap()
            .editor()
            .text = "xabcx".into();
        drafts
            .get_mut(&("form-r12-parity".into(), "mail".into()))
            .unwrap()
            .editor()
            .text = "a@b".into();
        assert!(
            agent_forms::answer(&parity_form, &drafts).is_err(),
            "single-label email a@b must be rejected"
        );
        drafts
            .get_mut(&("form-r12-parity".into(), "mail".into()))
            .unwrap()
            .editor()
            .text = "dev@example.com".into();
        drafts
            .get_mut(&("form-r12-parity".into(), "dt".into()))
            .unwrap()
            .editor()
            .text = "2026-11-26T25:00".into();
        assert!(
            agent_forms::answer(&parity_form, &drafts).is_err(),
            "out-of-range hour in date-time must be rejected"
        );
        drafts
            .get_mut(&("form-r12-parity".into(), "dt".into()))
            .unwrap()
            .editor()
            .text = "2026-11-26T14:30:00+02:00".into();
        let parity_ans = agent_forms::answer(&parity_form, &drafts)
            .expect("unanchored pattern xabcx, valid email, and RFC 3339 date-time must pass");
        assert_eq!(parity_ans["sub"], json!("xabcx"));
        assert_eq!(parity_ans["mail"], json!("dev@example.com"));
        assert_eq!(parity_ans["dt"], json!("2026-11-26T14:30:00+02:00"));

        // 3. Inactive conditional field with invalid pattern `[` does not disable the form while
        // its condition is false, and fails closed once activated.
        let cond_bad_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-cond-bad".into(),
            title: "Conditional invalid".into(),
            fields: vec![
                json!({"key": "enable", "title": "Enable", "type": "boolean", "default": false}),
                json!({
                    "key": "extra",
                    "title": "Extra",
                    "type": "string",
                    "required": true,
                    "pattern": "[",
                    "when": [{"key": "enable", "op": "eq", "value": true}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(cond_bad_form);
        let mut cbrt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        cbrt.frame(0.0);
        let cb_tree = cbrt.accessibility_json();
        assert!(
            find_node(&cb_tree, "form-unsupported").is_none(),
            "inactive conditional field with bad pattern must not show unsupported banner"
        );
        assert!(
            !has_state(find_node(&cb_tree, "answer-question").unwrap(), "disabled"),
            "Answer must stay enabled while invalid conditional field is inactive"
        );
        assert_eq!(
            agent_forms::answer(
                &cbrt.state.agent.as_ref().unwrap().forms[0],
                &cbrt.state.agent.as_ref().unwrap().drafts
            )
            .unwrap(),
            json!({"enable": false})
        );
        tap(&mut cbrt, "bool-enable-true");
        let cb_active = cbrt.accessibility_json();
        assert_eq!(
            find_node(&cb_active, "form-unsupported").unwrap()["name"],
            "Unsupported form"
        );
        assert!(has_state(
            find_node(&cb_active, "answer-question").unwrap(),
            "disabled"
        ));
        assert!(
            agent_forms::answer(
                &cbrt.state.agent.as_ref().unwrap().forms[0],
                &cbrt.state.agent.as_ref().unwrap().drafts
            )
            .is_err()
        );

        // 4. Hidden optional empty string default `""` round-trips and activates dependent `when`,
        // and hidden multiselect `["b", "a", "b"]` preserves exact order and multiplicity for
        // `minItems: 3`.
        let hidden_rt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-hidden-rt".into(),
            title: "Hidden roundtrip".into(),
            fields: vec![
                json!({"key": "empty_h", "type": "string", "hidden": true, "default": ""}),
                json!({
                    "key": "dep",
                    "title": "Dependent",
                    "type": "string",
                    "default": "activated",
                    "when": [{"key": "empty_h", "op": "eq", "value": ""}]
                }),
                json!({
                    "key": "ordered_h",
                    "type": "multiselect",
                    "hidden": true,
                    "minItems": 3,
                    "options": [
                        {"value": "a", "label": "A"},
                        {"value": "b", "label": "B"}
                    ],
                    "default": ["b", "a", "b"]
                }),
            ],
        };
        let (state, _rx) = state_with_form(hidden_rt_form);
        let mut hrt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        hrt.frame(0.0);
        let htree = hrt.accessibility_json();
        assert!(
            find_node(&htree, "field-dep").is_some(),
            "hidden empty default must activate dependent when.eq '' field"
        );
        assert!(
            !has_state(find_node(&htree, "answer-question").unwrap(), "disabled"),
            "hidden multiselect ['b','a','b'] must satisfy minItems=3"
        );
        let hans = agent_forms::answer(
            &hrt.state.agent.as_ref().unwrap().forms[0],
            &hrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("hidden empty string and ordered duplicate multiselect must submit cleanly");
        assert_eq!(hans["empty_h"], json!(""));
        assert_eq!(hans["dep"], json!("activated"));
        assert_eq!(hans["ordered_h"], json!(["b", "a", "b"]));

        // 5. Wire option values never appear in `_a11yPath` / web mirror JSON, and a 65th declared
        // option value used as default on a `custom: true` field never hydrates into the custom box.
        let mut sixty_five: Vec<serde_json::Value> = (0..64)
            .map(|i| json!({"value": format!("opt_{i}"), "label": format!("Option {i}")}))
            .collect();
        sixty_five.push(json!({"value": "internal_prod", "label": "Internal Prod 65"}));
        let opaque_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-opaque".into(),
            title: "Opaque paths".into(),
            fields: vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "options": [{"value": "internal_secret_val", "label": "Production"}]
                }),
                json!({
                    "key": "overflow",
                    "title": "Overflow",
                    "type": "string",
                    "custom": true,
                    "default": "internal_prod",
                    "options": sixty_five
                }),
            ],
        };
        let (state, _rx) = state_with_form(opaque_form);
        let mut ort = Runtime::new(state, render_form, (420.0, 760.0), Env::new(false, 1.0));
        ort.frame(0.0);
        let web_raw = ort.a11y_json();
        assert!(
            !web_raw.contains("internal_secret_val") && !web_raw.contains("internal_prod"),
            "wire option values must never enter browser mirror paths or values: {web_raw}"
        );
        let otree = ort.accessibility_json();
        let mut ovals = Vec::new();
        collect_values(&otree, &mut ovals);
        assert!(
            !ovals.iter().any(|v| v.contains("internal_prod"))
                && !ort.elements().iter().any(|e| e
                    .text
                    .as_deref()
                    .is_some_and(|t| t.contains("internal_prod"))),
            "65th declared option default must never appear in custom textbox: {ovals:?}"
        );

        // 6 & 7. Custom editors under choices render visible localized labels (including the
        // discoverable comma separator for multiselect), accept comma-separated custom entries,
        // and preserve comma-containing defaults verbatim.
        let custom_label_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r12-custom-labels".into(),
            title: "Custom labels".into(),
            fields: vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "custom": true,
                    "options": [{"value": "prod", "label": "Production"}]
                }),
                json!({
                    "key": "tags",
                    "title": "Tags",
                    "type": "multiselect",
                    "custom": true,
                    "options": [{"value": "api", "label": "API"}],
                    "default": ["with, comma"]
                }),
            ],
        };
        for (locale, expected_other, expected_multi_hint) in [
            ("en", "Other values", "Other values, separated by commas"),
            (
                "fr",
                "Autres valeurs",
                "Autres valeurs, séparées par des virgules",
            ),
        ] {
            crate::strings::with_locale(locale, || {
                let (state, _rx) = state_with_form(custom_label_form.clone());
                let mut lrt =
                    Runtime::new(state, render_form, (420.0, 820.0), Env::new(false, 1.0));
                lrt.frame(0.0);
                let texts: Vec<String> =
                    lrt.elements().into_iter().filter_map(|e| e.text).collect();
                assert!(
                    texts.iter().any(|t| t == expected_other),
                    "{locale}: string custom editor must render visible '{expected_other}' label: {texts:?}"
                );
                assert!(
                    texts.iter().any(|t| t == expected_multi_hint),
                    "{locale}: multiselect custom editor must render visible '{expected_multi_hint}' label: {texts:?}"
                );
                lrt.update(|s, _| {
                    s.agent
                        .as_mut()
                        .unwrap()
                        .drafts
                        .get_mut(&("form-r12-custom-labels".into(), "tags".into()))
                        .unwrap()
                        .custom_editor()
                        .text = "alpha, beta".into();
                });
                let ans = agent_forms::answer(
                    &lrt.state.agent.as_ref().unwrap().forms[0],
                    &lrt.state.agent.as_ref().unwrap().drafts,
                )
                .expect("comma-separated custom multiselect entries must submit");
                assert_eq!(ans["tags"], json!(["with, comma", "alpha", "beta"]));
            });
        }

        // Round-13 regressions:
        // (a) ECMAScript UTF-16 pattern semantics: `^.$` rejects `🦀` (2 UTF-16 units) while `^..$`
        //     and `^🦀$` accept it.
        // (b) Internationalized email (`élodie@example.com`) accepted, invalid IPv6 URI
        //     (`https://[bad]`) rejected, valid IPv6 URI (`https://[::1]:8080/x`) accepted.
        // (c) Large character class under bounded repeat hits byte/AST/class budgets immediately.
        // (d) Required hidden custom multiselect with `default: [""]` submits `[""]` cleanly.
        // (e) Literal commas in custom multiselect with `maxItems: 1` via quoting (`"Doe, Jane"`)
        //     or backslash escaping (`Doe\, Jane`) submit as a single item and promote cleanly.
        let r13_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r13".into(),
            title: "Round 13 parity".into(),
            fields: vec![
                json!({"key": "one_unit", "title": "One unit", "type": "string", "required": true, "pattern": "^.$"}),
                json!({"key": "two_units", "title": "Two units", "type": "string", "required": true, "pattern": "^..$"}),
                json!({"key": "mail", "title": "Mail", "type": "string", "required": true, "format": "email"}),
                json!({"key": "url", "title": "URL", "type": "string", "required": true, "format": "uri"}),
                json!({
                    "key": "hidden_empty_custom",
                    "type": "multiselect",
                    "hidden": true,
                    "required": true,
                    "custom": true,
                    "options": [],
                    "default": [""]
                }),
                json!({
                    "key": "single_custom",
                    "title": "Name",
                    "type": "multiselect",
                    "custom": true,
                    "maxItems": 1,
                    "options": []
                }),
            ],
        };
        let mut r13_drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&r13_form), &mut r13_drafts);
        // `^.$` must reject 🦀 (surrogate pair = 2 UTF-16 code units).
        r13_drafts
            .get_mut(&("form-r13".into(), "one_unit".into()))
            .unwrap()
            .editor()
            .text = "🦀".into();
        r13_drafts
            .get_mut(&("form-r13".into(), "two_units".into()))
            .unwrap()
            .editor()
            .text = "🦀".into();
        r13_drafts
            .get_mut(&("form-r13".into(), "mail".into()))
            .unwrap()
            .editor()
            .text = "élodie@example.com".into();
        r13_drafts
            .get_mut(&("form-r13".into(), "url".into()))
            .unwrap()
            .editor()
            .text = "https://[bad]".into();
        r13_drafts
            .get_mut(&("form-r13".into(), "single_custom".into()))
            .unwrap()
            .custom_editor()
            .text = "\"prod\"".into();
        assert!(
            agent_forms::validate(
                &r13_form.fields[0],
                &r13_drafts[&("form-r13".into(), "one_unit".into())]
            )
            .is_err(),
            "^.$ must reject 🦀 under ECMAScript UTF-16 semantics"
        );
        assert!(
            agent_forms::validate(
                &r13_form.fields[1],
                &r13_drafts[&("form-r13".into(), "two_units".into())]
            )
            .is_ok(),
            "^..$ must accept 🦀 under ECMAScript UTF-16 semantics"
        );
        assert!(
            agent_forms::validate(
                &r13_form.fields[2],
                &r13_drafts[&("form-r13".into(), "mail".into())]
            )
            .is_ok(),
            "internationalized email élodie@example.com must be accepted"
        );
        assert!(
            agent_forms::validate(
                &r13_form.fields[3],
                &r13_drafts[&("form-r13".into(), "url".into())]
            )
            .is_err(),
            "invalid IPv6 URI https://[bad] must be rejected"
        );
        r13_drafts
            .get_mut(&("form-r13".into(), "one_unit".into()))
            .unwrap()
            .editor()
            .text = "a".into();
        r13_drafts
            .get_mut(&("form-r13".into(), "url".into()))
            .unwrap()
            .editor()
            .text = "https://[::1]:8080/ok".into();
        let r13_ans = agent_forms::answer(&r13_form, &r13_drafts)
            .expect("literal quotes, hidden [''], UTF-16 parity, unicode email, and valid IPv6 URL must submit");
        assert_eq!(r13_ans["hidden_empty_custom"], json!([""]));
        assert_eq!(r13_ans["single_custom"], json!(["\"prod\""]));
        // Ordinary unquoted backslashes (e.g. Windows UNC paths) remain literal.
        r13_drafts
            .get_mut(&("form-r13".into(), "single_custom".into()))
            .unwrap()
            .custom_editor()
            .text = r"\\serveur\partage".into();
        let r13_unc = agent_forms::answer(&r13_form, &r13_drafts)
            .expect("UNC path with leading double backslash must submit verbatim");
        assert_eq!(r13_unc["single_custom"], json!([r"\\serveur\partage"]));
        // Oversized character class under bounded repeat defers cleanly in bounded time.
        let huge_class = format!("[{}]{{256}}", "a".repeat(2500));
        let huge_class_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r13-class-dos".into(),
            title: "Huge class".into(),
            fields: vec![json!({
                "key": "re",
                "title": "Regex",
                "type": "string",
                "pattern": huge_class
            })],
        };
        assert!(agent_forms::supported(&huge_class_form));
        let dense_class = format!("[{}]{{256}}", "a".repeat(1200));
        let dense_class_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r13-class-ast".into(),
            title: "Dense class".into(),
            fields: vec![json!({
                "key": "re",
                "title": "Regex",
                "type": "string",
                "pattern": dense_class
            })],
        };
        assert!(agent_forms::supported(&dense_class_form));

        // Round 14 regressions:
        // 1. Valid ECMAScript lookahead defers to OpenCode instead of disabling Answer, while
        // genuinely malformed lookahead syntax still fails closed.
        let lookahead_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-lookahead".into(),
            title: "Lookahead".into(),
            fields: vec![json!({
                "key": "tok",
                "title": "Token",
                "type": "string",
                "required": true,
                "pattern": "^[A-Z]+(?=:)",
                "default": "ABC:"
            })],
        };
        let (state, _rx) = state_with_form(lookahead_form);
        let mut lrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        lrt.frame(0.0);
        let ltree = lrt.accessibility_json();
        assert!(
            !has_state(find_node(&ltree, "answer-question").unwrap(), "disabled"),
            "lookahead pattern with matching default must keep Answer enabled"
        );
        let lans = agent_forms::answer(
            &lrt.state.agent.as_ref().unwrap().forms[0],
            &lrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("lookahead pattern must defer cleanly instead of blocking locally");
        assert_eq!(lans["tok"], json!("ABC:"));

        let bad_lookahead_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-bad-lookahead".into(),
            title: "Bad lookahead".into(),
            fields: vec![json!({
                "key": "tok",
                "title": "Token",
                "type": "string",
                "required": true,
                "pattern": "(?=unclosed"
            })],
        };
        assert!(
            !agent_forms::supported(&bad_lookahead_form),
            "unclosed lookahead is a genuine regex syntax error and must fail closed"
        );

        // 2. OpenCode format parity: `date-time` without seconds/zone (`2026-11-26T14:30`,
        // including on an active hidden field), single-char TLD email (`a@b.c`), and URI with
        // path space (`https://example.com/a b`) all pass, while invalid host/date-time fail.
        let fmt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-formats".into(),
            title: "Formats".into(),
            fields: vec![
                json!({
                    "key": "hidden_dt",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "2026-11-26T14:30"
                }),
                json!({
                    "key": "mail",
                    "title": "Email",
                    "type": "string",
                    "format": "email",
                    "required": true,
                    "default": "a@b.c"
                }),
                json!({
                    "key": "url",
                    "title": "URL",
                    "type": "string",
                    "format": "uri",
                    "required": true,
                    "default": "https://example.com/a b"
                }),
            ],
        };
        let (state, _rx) = state_with_form(fmt_form);
        let mut frt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        frt.frame(0.0);
        let ftree = frt.accessibility_json();
        assert!(
            !has_state(find_node(&ftree, "answer-question").unwrap(), "disabled"),
            "hidden date-time 2026-11-26T14:30, email a@b.c, and URI with path space must enable Answer"
        );
        let fans = agent_forms::answer(
            &frt.state.agent.as_ref().unwrap().forms[0],
            &frt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("OpenCode-compatible date-time, email, and uri defaults must submit");
        assert_eq!(fans["hidden_dt"], json!("2026-11-26T14:30"));
        assert_eq!(fans["mail"], json!("a@b.c"));
        assert_eq!(fans["url"], json!("https://example.com/a b"));
        frt.state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r14-formats".into(), "url".into()))
            .unwrap()
            .editor()
            .text = "https://bad host".into();
        assert!(
            agent_forms::answer(
                &frt.state.agent.as_ref().unwrap().forms[0],
                &frt.state.agent.as_ref().unwrap().drafts
            )
            .is_err(),
            "URI with space in host must still be rejected"
        );

        // 3. Optional hidden multiselect with absent default omits key and does not trigger
        // `when.neq`, whereas explicit `default: []` submits `[]` and triggers `when.neq`.
        let absent_hidden_ms = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-hidden-absent".into(),
            title: "Hidden absent".into(),
            fields: vec![
                json!({
                    "key": "tags",
                    "type": "multiselect",
                    "hidden": true,
                    "options": [{"value": "prod", "label": "Prod"}]
                }),
                json!({
                    "key": "reason",
                    "title": "Reason",
                    "type": "string",
                    "required": true,
                    "when": [{"key": "tags", "op": "neq", "value": "prod"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(absent_hidden_ms);
        let mut art = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        art.frame(0.0);
        let atree = art.accessibility_json();
        assert!(
            find_node(&atree, "field-reason").is_none(),
            "absent hidden multiselect default must not activate when.neq dependent field"
        );
        assert!(
            !has_state(find_node(&atree, "answer-question").unwrap(), "disabled"),
            "Answer must stay enabled when absent hidden multiselect leaves when.neq inactive"
        );
        let aans = agent_forms::answer(
            &art.state.agent.as_ref().unwrap().forms[0],
            &art.state.agent.as_ref().unwrap().drafts,
        )
        .expect("absent optional hidden multiselect must submit without tags key");
        assert_eq!(aans, json!({}));

        let explicit_empty_ms = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-hidden-empty".into(),
            title: "Hidden empty".into(),
            fields: vec![
                json!({
                    "key": "tags",
                    "type": "multiselect",
                    "hidden": true,
                    "default": [],
                    "options": [{"value": "prod", "label": "Prod"}]
                }),
                json!({
                    "key": "reason",
                    "title": "Reason",
                    "type": "string",
                    "required": true,
                    "default": "non-prod",
                    "when": [{"key": "tags", "op": "neq", "value": "prod"}]
                }),
            ],
        };
        let mut edrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&explicit_empty_ms), &mut edrafts);
        let eans = agent_forms::answer(&explicit_empty_ms, &edrafts).expect(
            "explicit empty hidden multiselect default [] must activate when.neq and submit",
        );
        assert_eq!(eans, json!({"tags": [], "reason": "non-prod"}));

        // 4. Custom multiselect entries preserve literal double quotes verbatim (e.g. `"prod"`
        // and `Acme "West"`), matching Solid's comma-separated split.
        let quote_ms_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r14-quotes".into(),
            title: "Literal quotes".into(),
            fields: vec![json!({
                "key": "orgs",
                "title": "Orgs",
                "type": "multiselect",
                "custom": true,
                "options": []
            })],
        };
        let mut qdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&quote_ms_form), &mut qdrafts);
        qdrafts
            .get_mut(&("form-r14-quotes".into(), "orgs".into()))
            .unwrap()
            .custom_editor()
            .text = "Acme \"West\", \"prod\"".into();
        let qans = agent_forms::answer(&quote_ms_form, &qdrafts)
            .expect("literal quotes in custom multiselect must submit verbatim");
        assert_eq!(qans["orgs"], json!(["Acme \"West\"", "\"prod\""]));
    });
}

#[test]
fn form_budget_oversized_defaults_opencode_formats_untouched_arrays_and_disjoint_keys() {
    crate::strings::with_locale("en", || {
        // Round 15 regressions:
        // 1. Worst-case long regex (`a{256}a{256}a{256}a{256}b`) on a 20,000-char default finishes
        // immediately within the match step budget without stalling the UI.
        let long_a = "a".repeat(20_000);
        let match_dos_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-match-dos".into(),
            title: "Bounded match".into(),
            fields: vec![json!({
                "key": "big",
                "title": "Big",
                "type": "string",
                "required": true,
                "pattern": "a{256}a{256}a{256}a{256}b",
                "default": long_a
            })],
        };
        let t0 = std::time::Instant::now();
        let (state, _rx) = state_with_form(match_dos_form);
        let mut mrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        mrt.frame(0.0);
        let mtree = mrt.accessibility_json();
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "bounded regex matcher must not stall on 20,000-char input"
        );
        assert!(
            !has_state(find_node(&mtree, "answer-question").unwrap(), "disabled"),
            "match-budget deferral must keep Answer enabled instead of blocking"
        );

        // 2. Quantified assertion group `(^)?ok` is valid ECMAScript and enables Answer for `ok`,
        // while bare `^?ok` stays a syntax error.
        let group_assert_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-group-assert".into(),
            title: "Group assertion".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "(^)?ok",
                "default": "ok"
            })],
        };
        let mut gadrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&group_assert_form), &mut gadrafts);
        assert_eq!(
            agent_forms::answer(&group_assert_form, &gadrafts).expect("(^)?ok must accept 'ok'")["val"],
            json!("ok")
        );
        let bare_assert_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-bare-assert".into(),
            title: "Bare assertion".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^?ok"
            })],
        };
        assert!(!agent_forms::supported(&bare_assert_form));

        // 3. OpenCode 2.4.1 hidden format parity: `team..ops@example.com`, `" https://example.com "`,
        // and `2026-11-26T24:00:00Z` on required hidden fields all enable Answer and submit.
        let hidden_fmt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-hidden-formats".into(),
            title: "Hidden formats".into(),
            fields: vec![
                json!({
                    "key": "mail",
                    "type": "string",
                    "format": "email",
                    "hidden": true,
                    "required": true,
                    "default": "team..ops@example.com"
                }),
                json!({
                    "key": "uri",
                    "type": "string",
                    "format": "uri",
                    "hidden": true,
                    "required": true,
                    "default": " https://example.com "
                }),
                json!({
                    "key": "dt",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "2026-11-26T24:00:00Z"
                }),
            ],
        };
        let (state, _rx) = state_with_form(hidden_fmt_form);
        let mut hfrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        hfrt.frame(0.0);
        let hftree = hfrt.accessibility_json();
        assert!(
            !has_state(find_node(&hftree, "answer-question").unwrap(), "disabled"),
            "OpenCode-accepted hidden email/uri/date-time defaults must enable Answer"
        );
        let hfans = agent_forms::answer(
            &hfrt.state.agent.as_ref().unwrap().forms[0],
            &hfrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("OpenCode-accepted hidden format defaults must submit");
        assert_eq!(hfans["mail"], json!("team..ops@example.com"));
        assert_eq!(hfans["uri"], json!(" https://example.com "));
        assert_eq!(hfans["dt"], json!("2026-11-26T24:00:00Z"));

        // 4. Visible multiselect untouched parity: required custom `default: [""]` renders as a
        // checkable preserved item and submits `[""]`; optional untouched multiselect with no
        // default omits the key and does not trigger `when.neq`.
        let vis_ms_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-vis-ms".into(),
            title: "Visible multiselect".into(),
            fields: vec![
                json!({
                    "key": "empty_item",
                    "title": "Empty custom",
                    "type": "multiselect",
                    "required": true,
                    "custom": true,
                    "options": [],
                    "default": [""]
                }),
                json!({
                    "key": "tags",
                    "title": "Tags",
                    "type": "multiselect",
                    "options": [{"value": "prod", "label": "Prod"}]
                }),
                json!({
                    "key": "dep",
                    "title": "Dependent",
                    "type": "string",
                    "required": true,
                    "when": [{"key": "tags", "op": "neq", "value": "prod"}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(vis_ms_form);
        let mut vmrt = Runtime::new(state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        vmrt.frame(0.0);
        let vmtree = vmrt.accessibility_json();
        let empty_item_key = agent_forms::multi_option_key("empty_item", "");
        assert!(has_state(
            find_node(&vmtree, &empty_item_key).expect("empty custom default checkbox must render"),
            "checked"
        ));
        assert!(
            find_node(&vmtree, "field-dep").is_none(),
            "untouched optional multiselect with no default must not activate when.neq"
        );
        assert!(
            !has_state(find_node(&vmtree, "answer-question").unwrap(), "disabled"),
            "Answer must stay enabled with untouched default [''] and absent optional multiselect"
        );
        let vmans = agent_forms::answer(
            &vmrt.state.agent.as_ref().unwrap().forms[0],
            &vmrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("visible multiselect default [''] and omitted optional multiselect must submit");
        assert_eq!(vmans, json!({"empty_item": [""]}));

        // 5. Quoted custom multiselect entry after Unicode NBSP (`\u{00A0}`) stays one item under
        // `maxItems: 2`.
        let nbsp_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r15-nbsp".into(),
            title: "Unicode whitespace".into(),
            fields: vec![json!({
                "key": "names",
                "title": "Names",
                "type": "multiselect",
                "custom": true,
                "maxItems": 2,
                "options": []
            })],
        };
        let mut ndrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&nbsp_form), &mut ndrafts);
        ndrafts
            .get_mut(&("form-r15-nbsp".into(), "names".into()))
            .unwrap()
            .custom_editor()
            .text = "red,\u{00A0}\"blue\"".into();
        let nans = agent_forms::answer(&nbsp_form, &ndrafts)
            .expect("NBSP-trimmed literal quote entry must submit cleanly under maxItems=2");
        assert_eq!(nans["names"], json!(["red", "\"blue\""]));

        // Round 16 regressions:
        // 1. Form-level regex work budget prevents 32 required 64-option radio fields with heavy
        // patterns from stalling UI render/validation.
        let heavy_fields: Vec<serde_json::Value> = (0..32)
            .map(|fi| {
                let mut opts: Vec<serde_json::Value> = (0..63)
                    .map(|oi| {
                        let val = format!("{}_{fi}_{oi}", "a".repeat(500));
                        json!({"value": val, "label": format!("Opt {oi}")})
                    })
                    .collect();
                opts.push(json!({"value": format!("{}b", "a".repeat(256)), "label": "Match"}));
                json!({
                    "key": format!("f{fi}"),
                    "title": format!("Field {fi}"),
                    "type": "string",
                    "required": true,
                    "pattern": "a{256}b",
                    "options": opts
                })
            })
            .collect();
        let heavy_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-heavy".into(),
            title: "Heavy regex".into(),
            fields: heavy_fields,
        };
        let t_heavy = std::time::Instant::now();
        let (state, _rx) = state_with_form(heavy_form);
        let mut hrt16 = Runtime::new(state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        hrt16.frame(0.0);
        assert!(
            t_heavy.elapsed() < std::time::Duration::from_secs(2),
            "32x64 regex option scan must share a form-level work budget and stay responsive"
        );

        // 2. Oversized custom multiselect default (100,000 comma items) does not materialize
        // unbounded checkbox rows and surfaces the form as unsupported.
        let huge_defaults: Vec<serde_json::Value> = (0..100_000)
            .map(|i| json!(format!("item{i:05},")))
            .collect();
        let huge_ms_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-huge-ms".into(),
            title: "Oversized default".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": [],
                "default": huge_defaults
            })],
        };
        let t_huge = std::time::Instant::now();
        let (state, _rx) = state_with_form(huge_ms_form);
        let mut humrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        humrt.frame(0.0);
        let humtree = humrt.accessibility_json();
        assert!(
            t_huge.elapsed() < std::time::Duration::from_secs(2),
            "oversized multiselect default must fail fast without allocating 100k checkboxes"
        );
        assert!(
            humrt.state.agent.as_ref().unwrap().drafts[&("form-r16-huge-ms".into(), "tags".into())]
                .preserved_custom
                .is_empty(),
            "oversized multiselect default must not retain unbounded preserved checkboxes"
        );
        assert!(
            find_node(&humtree, &agent_forms::field_error_key("tags")).is_some(),
            "oversized visible multiselect default must surface field limit error while untouched"
        );
        assert!(has_state(
            find_node(&humtree, "answer-question").unwrap(),
            "disabled"
        ));

        // 3 & 4. Hidden date-time default `2026-11-26` and hidden email default `a@b..c` are
        // accepted (matching OpenCode); edited local date-time normalizes to UTC while untouched
        // protocol default is preserved verbatim.
        let dt_mail_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-dt-mail".into(),
            title: "Date and email".into(),
            fields: vec![
                json!({
                    "key": "hdt",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "2026-11-26"
                }),
                json!({
                    "key": "hmail",
                    "type": "string",
                    "format": "email",
                    "hidden": true,
                    "required": true,
                    "default": "a@b..c"
                }),
                json!({
                    "key": "vdt",
                    "title": "Schedule",
                    "type": "string",
                    "format": "date-time",
                    "default": "2026-11-26T14:30"
                }),
            ],
        };
        let mut dm_drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&dt_mail_form), &mut dm_drafts);
        let untouched_dm = agent_forms::answer(&dt_mail_form, &dm_drafts)
            .expect("hidden date-only date-time, a@b..c email, and untouched default must pass");
        assert_eq!(untouched_dm["hdt"], json!("2026-11-26"));
        assert_eq!(untouched_dm["hmail"], json!("a@b..c"));
        assert_eq!(untouched_dm["vdt"], json!("2026-11-26T14:30"));
        dm_drafts
            .get_mut(&("form-r16-dt-mail".into(), "vdt".into()))
            .unwrap()
            .editor()
            .text = "2026-11-26T15:45".into();
        let edited_dm = agent_forms::answer(&dt_mail_form, &dm_drafts)
            .expect("edited local datetime must normalize to UTC and submit");
        let edited_vdt = edited_dm["vdt"].as_str().unwrap();
        assert!(
            edited_vdt.ends_with('Z') && edited_vdt.len() == 24,
            "edited local date-time must normalize to UTC RFC 3339, got {edited_vdt}"
        );

        // 5. Untouched visible optional string with explicit `default: ""` activates `when.eq ""`
        // and submits `""`.
        let empty_str_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-empty-str".into(),
            title: "Empty default".into(),
            fields: vec![
                json!({"key": "note", "title": "Note", "type": "string", "default": ""}),
                json!({
                    "key": "follow",
                    "title": "Follow-up",
                    "type": "string",
                    "required": true,
                    "default": "yes",
                    "when": [{"key": "note", "op": "eq", "value": ""}]
                }),
            ],
        };
        let (state, _rx) = state_with_form(empty_str_form);
        let mut esrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        esrt.frame(0.0);
        let estree = esrt.accessibility_json();
        assert!(
            find_node(&estree, &agent_forms::field_editor_key("follow")).is_some(),
            "untouched visible optional string default '' must activate when.eq '' dependent"
        );
        let esans = agent_forms::answer(
            &esrt.state.agent.as_ref().unwrap().forms[0],
            &esrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("untouched explicit empty string default and dependent must submit");
        assert_eq!(esans, json!({"note": "", "follow": "yes"}));

        // 6. Untouched visible multiselect preserves exact order `["beta", "alpha"]` and
        // duplicate multiplicity `["alpha", "alpha"]` for `minItems: 2`.
        let ordered_ms_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-ordered-ms".into(),
            title: "Ordered multiselect".into(),
            fields: vec![
                json!({
                    "key": "order",
                    "title": "Order",
                    "type": "multiselect",
                    "options": [
                        {"value": "alpha", "label": "Alpha"},
                        {"value": "beta", "label": "Beta"}
                    ],
                    "default": ["beta", "alpha"]
                }),
                json!({
                    "key": "dups",
                    "title": "Dups",
                    "type": "multiselect",
                    "minItems": 2,
                    "options": [{"value": "alpha", "label": "Alpha"}],
                    "default": ["alpha", "alpha"]
                }),
            ],
        };
        let (state, _rx) = state_with_form(ordered_ms_form);
        let mut omrt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        omrt.frame(0.0);
        let omtree = omrt.accessibility_json();
        assert!(
            find_node(&omtree, "form-unsupported").is_none(),
            "untouched ['alpha','alpha'] default must satisfy minItems=2 without unsupported banner"
        );
        let omans = agent_forms::answer(
            &omrt.state.agent.as_ref().unwrap().forms[0],
            &omrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("untouched ordered and duplicate multiselect defaults must submit verbatim");
        assert_eq!(omans["order"], json!(["beta", "alpha"]));
        assert_eq!(omans["dups"], json!(["alpha", "alpha"]));

        // 7. BOM / U+FEFF before entry in custom multiselect is trimmed while keeping literal quotes.
        let mut bom_drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&nbsp_form), &mut bom_drafts);
        bom_drafts
            .get_mut(&("form-r15-nbsp".into(), "names".into()))
            .unwrap()
            .custom_editor()
            .text = "red,\u{FEFF}\"blue\"".into();
        let bom_ans = agent_forms::answer(&nbsp_form, &bom_drafts)
            .expect("U+FEFF-trimmed literal quote entry must submit cleanly under maxItems=2");
        assert_eq!(bom_ans["names"], json!(["red", "\"blue\""]));

        // 8. Disjoint key namespaces: choice field `x` and free-text field `body:1:x` never
        // collide on sibling keys, and focus lookup returns the exact editor key.
        let disjoint_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r16-disjoint".into(),
            title: "Disjoint keys".into(),
            fields: vec![
                json!({
                    "key": "x",
                    "title": "Choice X",
                    "type": "string",
                    "options": [{"value": "a", "label": "A"}]
                }),
                json!({
                    "key": "body:1:x",
                    "title": "Free body",
                    "type": "string"
                }),
            ],
        };
        let (state, _rx) = state_with_form(disjoint_form);
        let mut drt = Runtime::new(state, render_form, (420.0, 560.0), Env::new(false, 1.0));
        drt.frame(0.0);
        let dtree = drt.accessibility_json();
        let editor_key = agent_forms::field_editor_key("body:1:x");
        let container_key = agent_forms::field_container_key("x");
        assert_ne!(editor_key, container_key);
        assert!(
            find_node(&dtree, &container_key).is_some(),
            "choice field container must keep its disjoint container key"
        );
        assert_eq!(
            find_input(&dtree, &editor_key)["role"],
            "multiline-text-input",
            "free-text editor must keep its exact editor key without colliding with choice container"
        );
        drt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r16-disjoint".into(), "body:1:x".into()))
                .unwrap()
                .edit
                .focused = true;
        });
        assert_eq!(
            crate::agent::focused_control_key(&drt.state, Some(&editor_key))
                .map(|(k, _)| k)
                .as_deref(),
            Some(editor_key.as_str())
        );
    });
}

#[test]
fn reducible_overlimit_multiselect_ordered_edits_optional_hidden_min_items_dst_and_rfc2822_dates() {
    crate::strings::with_locale("en", || {
        // 1. 33 declared options all selected by default with `maxItems: 32` is NOT permanently
        // unanswerable: unchecking one option brings the count to 32 and enables Answer.
        let thirty_three_opts: Vec<serde_json::Value> = (0..33)
            .map(|i| json!({"value": format!("opt_{i:02}"), "label": format!("Option {i:02}")}))
            .collect();
        let thirty_three_defaults: Vec<serde_json::Value> =
            (0..33).map(|i| json!(format!("opt_{i:02}"))).collect();
        let over_limit_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r17-overlimit".into(),
            title: "Over limit".into(),
            fields: vec![json!({
                "key": "picks",
                "title": "Picks",
                "type": "multiselect",
                "maxItems": 32,
                "options": thirty_three_opts,
                "default": thirty_three_defaults
            })],
        };
        let (state, _rx) = state_with_form(over_limit_form);
        let mut olrt = Runtime::new(state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        olrt.frame(0.0);
        let oltree = olrt.accessibility_json();
        assert!(
            find_node(&oltree, "form-unsupported").is_none(),
            "33 selected declared options must be reducible rather than marked unsupported"
        );
        assert!(has_state(
            find_node(&oltree, "answer-question").unwrap(),
            "disabled"
        ));
        olrt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r17-overlimit".into(), "picks".into()))
                .unwrap()
                .toggle("opt_00");
        });
        olrt.frame(1.0 / 60.0);
        let ol_after = olrt.accessibility_json();
        assert!(
            !has_state(find_node(&ol_after, "answer-question").unwrap(), "disabled"),
            "unchecking one option from 33 must enable Answer at 32 items"
        );
        let ol_ans = agent_forms::answer(
            &olrt.state.agent.as_ref().unwrap().forms[0],
            &olrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("32 remaining picks must submit cleanly");
        assert_eq!(ol_ans["picks"].as_array().unwrap().len(), 32);

        // 2. Editing a multiselect preserves order and duplicate multiplicity of untouched entries:
        // starting from `["b", "b"]` and checking `a` submits `["b", "b", "a"]`.
        let edit_order_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r17-order-edit".into(),
            title: "Order edit".into(),
            fields: vec![json!({
                "key": "items",
                "title": "Items",
                "type": "multiselect",
                "options": [
                    {"value": "a", "label": "A"},
                    {"value": "b", "label": "B"}
                ],
                "default": ["b", "b"]
            })],
        };
        let mut odrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&edit_order_form), &mut odrafts);
        odrafts
            .get_mut(&("form-r17-order-edit".into(), "items".into()))
            .unwrap()
            .toggle("a");
        let oans = agent_forms::answer(&edit_order_form, &odrafts)
            .expect("checking 'a' on default ['b', 'b'] must submit cleanly");
        assert_eq!(oans["items"], json!(["b", "b", "a"]));

        // 3. Optional hidden multiselect with `minItems: 1` and no default omits key and keeps
        // Answer enabled.
        let opt_hidden_min_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r17-hidden-min".into(),
            title: "Hidden minItems".into(),
            fields: vec![json!({
                "key": "tags",
                "type": "multiselect",
                "hidden": true,
                "minItems": 1,
                "options": [{"value": "prod", "label": "Prod"}]
            })],
        };
        let (state, _rx) = state_with_form(opt_hidden_min_form);
        let mut hmrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        hmrt.frame(0.0);
        let hmtree = hmrt.accessibility_json();
        assert!(
            find_node(&hmtree, "form-unsupported").is_none(),
            "optional absent hidden multiselect with minItems=1 must not block the form"
        );
        assert!(
            !has_state(find_node(&hmtree, "answer-question").unwrap(), "disabled"),
            "optional absent hidden multiselect with minItems=1 must keep Answer enabled"
        );
        let hmans = agent_forms::answer(
            &hmrt.state.agent.as_ref().unwrap().forms[0],
            &hmrt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("optional absent hidden multiselect with minItems=1 must submit empty object");
        assert_eq!(hmans, json!({}));

        // 4. Desktop DST disambiguation matches ECMAScript Date (`America/New_York`):
        // spring-forward gap `2026-03-08T02:30` -> `2026-03-08T07:30:00.000Z` (03:30 EDT),
        // fall-back overlap `2026-11-01T01:30` -> `2026-11-01T05:30:00.000Z` (earlier EDT instant).
        let ny_clock = |utc_secs: i64| -> Option<(i32, i32, i32, i32, i32, i32)> {
            // 2026 America/New_York DST:
            // starts 2026-03-08 07:00:00Z (1772953200), ends 2026-11-01 06:00:00Z (1793512800)
            let offset = if (1_772_953_200..1_793_512_800).contains(&utc_secs) {
                -4 * 3600
            } else {
                -5 * 3600
            };
            let local = utc_secs + offset;
            let days = local.div_euclid(86_400);
            let sod = local.rem_euclid(86_400);
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = mp + if mp < 10 { 3 } else { -9 };
            let y = y + i64::from(m <= 2);
            Some((
                y as i32,
                m as i32,
                d as i32,
                (sod / 3600) as i32,
                ((sod % 3600) / 60) as i32,
                (sod % 60) as i32,
            ))
        };
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "2026-03-08T02:30",
                ny_clock
            )
            .as_deref(),
            Some("2026-03-08T07:30:00.000Z")
        );
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "2026-11-01T01:30",
                ny_clock
            )
            .as_deref(),
            Some("2026-11-01T05:30:00.000Z")
        );

        // 5. Required hidden `date-time` field with RFC 2822 default `"Thu, 26 Nov 2026 14:30:00 GMT"`
        // passes on desktop and submits verbatim.
        let rfc2822_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r17-rfc2822".into(),
            title: "RFC 2822 date".into(),
            fields: vec![json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "hidden": true,
                "required": true,
                "default": "Thu, 26 Nov 2026 14:30:00 GMT"
            })],
        };
        let (state, _rx) = state_with_form(rfc2822_form);
        let mut r28rt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        r28rt.frame(0.0);
        let r28tree = r28rt.accessibility_json();
        assert!(
            !has_state(find_node(&r28tree, "answer-question").unwrap(), "disabled"),
            "RFC 2822 hidden date-time default must keep Answer enabled on desktop"
        );
        let r28ans = agent_forms::answer(
            &r28rt.state.agent.as_ref().unwrap().forms[0],
            &r28rt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("RFC 2822 hidden date-time default must submit verbatim");
        assert_eq!(r28ans["when"], json!("Thu, 26 Nov 2026 14:30:00 GMT"));
    });
}

#[test]
fn literal_backslashes_custom_order_visible_min_items_recoverable_oversized_extended_years_shared_budget_and_group_descriptions()
 {
    crate::strings::with_locale("en", || {
        // 1 & 2. Ordinary unquoted backslashes stay literal (`\\serveur\partage`) and edited
        // custom multiselect text obeys the exact user-typed order (`beta, alpha`).
        let custom_order_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-custom".into(),
            title: "Custom order".into(),
            fields: vec![
                json!({
                    "key": "paths",
                    "title": "Paths",
                    "type": "multiselect",
                    "custom": true,
                    "options": []
                }),
                json!({
                    "key": "ordered",
                    "title": "Ordered",
                    "type": "multiselect",
                    "custom": true,
                    "options": [],
                    "default": ["alpha", "beta"]
                }),
            ],
        };
        let mut drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&custom_order_form), &mut drafts);
        drafts
            .get_mut(&("form-r18-custom".into(), "paths".into()))
            .unwrap()
            .custom_editor()
            .text = r"\\serveur\partage".into();
        drafts
            .get_mut(&("form-r18-custom".into(), "ordered".into()))
            .unwrap()
            .custom_editor()
            .text = "beta, alpha".into();
        let ans = agent_forms::answer(&custom_order_form, &drafts)
            .expect("literal UNC path and reordered custom values must submit");
        assert_eq!(ans["paths"], json!([r"\\serveur\partage"]));
        assert_eq!(ans["ordered"], json!(["beta", "alpha"]));

        // 3. Visible multiselect with `minItems: 1` (no `required`, no `default`) blocks submit
        // even while untouched, enables after checking, and blocks again if unchecked.
        let vis_min_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-vis-min".into(),
            title: "Visible minItems".into(),
            fields: vec![json!({
                "key": "env",
                "title": "Environment",
                "type": "multiselect",
                "minItems": 1,
                "options": [{"value": "prod", "label": "Prod"}]
            })],
        };
        let (state, _rx) = state_with_form(vis_min_form);
        let mut vrt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        vrt.frame(0.0);
        let vtree = vrt.accessibility_json();
        assert!(
            has_state(find_node(&vtree, "answer-question").unwrap(), "disabled"),
            "untouched visible multiselect with minItems=1 must disable Answer"
        );
        let prod_key = agent_forms::multi_option_key("env", "prod");
        tap(&mut vrt, &prod_key);
        let vtree_checked = vrt.accessibility_json();
        assert!(
            !has_state(
                find_node(&vtree_checked, "answer-question").unwrap(),
                "disabled"
            ),
            "checking option must satisfy visible minItems=1"
        );
        tap(&mut vrt, &prod_key);
        let vtree_unchecked = vrt.accessibility_json();
        assert!(
            has_state(
                find_node(&vtree_unchecked, "answer-question").unwrap(),
                "disabled"
            ),
            "unchecking option must disable Answer again"
        );

        // 4. Visible multiselect with 65 copies of `prod` in default hydrates `prod` as checked
        // (keeping the 65-item count until unchecked), then unchecking and re-checking `prod`
        // submits `["prod"]`.
        let oversized_65_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-over65".into(),
            title: "Oversized 65".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "options": [{"value": "prod", "label": "Prod"}],
                "default": vec![json!("prod"); 65]
            })],
        };
        let (state, _rx) = state_with_form(oversized_65_form);
        let mut ort = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        ort.frame(0.0);
        let otree = ort.accessibility_json();
        assert!(
            find_node(&otree, "form-unsupported").is_none(),
            "recoverable visible oversized default must not lock the form as unsupported"
        );
        assert!(has_state(
            find_node(&otree, "answer-question").unwrap(),
            "disabled"
        ));
        let target_prod = agent_forms::multi_option_key("targets", "prod");
        assert!(
            has_state(find_node(&otree, &target_prod).unwrap(), "checked"),
            "65 copies of `prod` must hydrate `prod` as checked"
        );
        tap(&mut ort, &target_prod);
        let otree2 = ort.accessibility_json();
        assert!(
            !has_state(find_node(&otree2, "answer-question").unwrap(), "disabled"),
            "unchecking `prod` removes all 65 copies and enables Answer"
        );
        tap(&mut ort, &target_prod);
        let oans = agent_forms::answer(
            &ort.state.agent.as_ref().unwrap().forms[0],
            &ort.state.agent.as_ref().unwrap().drafts,
        )
        .expect("re-checked multiselect option must submit");
        assert_eq!(oans["targets"], json!(["prod"]));

        // 5. Desktop accepts ECMAScript extended-year ISO date-times (`+010000-01-01T00:00:00.000Z`)
        // in hidden required fields and rejects out-of-range / `-000000` dates.
        let ext_year_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-ext-year".into(),
            title: "Extended year".into(),
            fields: vec![json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "hidden": true,
                "required": true,
                "default": "+010000-01-01T00:00:00.000Z"
            })],
        };
        let mut edrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&ext_year_form), &mut edrafts);
        let eans = agent_forms::answer(&ext_year_form, &edrafts)
            .expect("extended-year ISO date-time must pass desktop validation");
        assert_eq!(eans["when"], json!("+010000-01-01T00:00:00.000Z"));
        for bad_date in [
            "-000000-01-01T00:00:00.000Z",
            "+999999-01-01T00:00:00.000Z",
            "+010000-02-30T00:00:00.000Z",
        ] {
            let bad_field = json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "required": true
            });
            let mut bd = agent_forms::Draft::default();
            bd.editor().text = bad_date.into();
            assert!(
                agent_forms::value(&bad_field, &bd).is_err(),
                "invalid extended-year date-time `{bad_date}` must be rejected"
            );
        }

        // 6. 32 required radio groups with `a{256}b` and 1,000-char `'a'` first option share one
        // form-level budget and cache per-match exhaustion across single-pass `form_panel` rebuilds.
        let long_a = "a".repeat(1000);
        let hard_fields: Vec<serde_json::Value> = (0..32)
            .map(|i| {
                json!({
                    "key": format!("g{i}"),
                    "title": format!("Group {i}"),
                    "type": "string",
                    "required": true,
                    "pattern": "a{256}b",
                    "options": [{"value": long_a, "label": "Long A"}]
                })
            })
            .collect();
        let hard_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-budget".into(),
            title: "Shared budget".into(),
            fields: hard_fields,
        };
        let (state, _rx) = state_with_form(hard_form);
        let t0 = std::time::Instant::now();
        let mut brt = Runtime::new(
            state,
            |s: &State, cx: &mut Cx<State>| {
                layout::render(cx, |_| {
                    let Some(a) = s.agent.as_ref() else {
                        return col();
                    };
                    let (body, foot) = super::form_view::form_panel(s, &a.forms[0]);
                    col().full_width().full_height().child(body).child(foot)
                })
            },
            (420.0, 520.0),
            Env::new(false, 1.0),
        );
        brt.frame(0.0);
        brt.frame(1.0 / 60.0);
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "32x a{{256}}b form_panel rebuilds must stay bounded via shared budget + cache"
        );

        // 7. 64-radio group with a 1 MiB field description keeps the description once on the
        // `radiogroup` and never duplicates it onto the 64 individual `radio-button` nodes.
        let big_desc = "D".repeat(1_048_576);
        let radio_opts: Vec<serde_json::Value> = (0..64)
            .map(|i| json!({"value": format!("v{i}"), "label": format!("Option {i}")}))
            .collect();
        let big_desc_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r18-big-desc".into(),
            title: "Big description".into(),
            fields: vec![json!({
                "key": "choice",
                "title": "Choice",
                "description": big_desc,
                "type": "string",
                "options": radio_opts
            })],
        };
        let (state, _rx) = state_with_form(big_desc_form);
        let mut drt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        drt.frame(0.0);
        let dtree = drt.accessibility_json();
        let group_node = find_node(&dtree, &agent_forms::field_group_key("choice")).unwrap();
        assert_eq!(
            group_node["description"].as_str().map(str::len),
            Some(1_048_576),
            "radiogroup must retain the field description once"
        );
        for i in 0..64 {
            let opt_key = agent_forms::string_option_key("choice", &format!("v{i}"));
            let opt_node = find_node(&dtree, &opt_key).unwrap();
            let opt_desc = opt_node["description"]
                .as_str()
                .expect("radio option carries bounded caption + prompt");
            assert!(
                opt_desc.starts_with("Choice · ") && opt_desc.len() < 300,
                "radio option {i} must keep a bounded description (< 300 bytes), never 1 MiB (got {} bytes)",
                opt_desc.len()
            );
        }
    });
}

#[test]
fn active_descendant_caption_unpadded_dates_cleared_empty_string_custom_declared_values_and_keyed_regex_cache()
 {
    crate::strings::with_locale("en", || {
        // 1. Tabbing between two Yes/No questions exposes each focused radio's own question
        // caption on the active descendant proxy itself (not only on the mirrored group).
        let two_yes_no = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r19-active".into(),
            title: "Confirmations".into(),
            fields: vec![
                json!({
                    "key": "proceed",
                    "title": "Proceed now?",
                    "type": "boolean",
                    "required": true
                }),
                json!({
                    "key": "notify",
                    "title": "Notify team?",
                    "type": "boolean",
                    "required": true
                }),
            ],
        };
        let (state, _rx) = state_with_form(two_yes_no);
        let mut art = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        art.frame(0.0);
        // First Tab lands on the first radio group's selected radio ("No" for Proceed now?).
        press_key(&mut art, Key::Tab);
        let first_focus = focused_key(&mut art).expect("first focused radio");
        assert_eq!(first_focus, "bool-proceed-false");
        let web_items_1: Vec<serde_json::Value> = serde_json::from_str(&art.a11y_json()).unwrap();
        let active_1 = web_items_1
            .iter()
            .find(|item| {
                item["p"]
                    .as_str()
                    .is_some_and(|p| p.ends_with(&format!("/{first_focus}")))
            })
            .expect("active descendant web item for first radio");
        assert!(
            active_1["d"]
                .as_str()
                .is_some_and(|d| d.contains("Proceed now?") && d.contains("Question Required")),
            "focused active descendant must identify its own question: {active_1}"
        );
        // Tab to second radio group's selected radio ("No" for Notify team?).
        press_key(&mut art, Key::Tab);
        let second_focus = focused_key(&mut art).expect("second focused radio");
        assert_eq!(second_focus, "bool-notify-false");
        let web_items_2: Vec<serde_json::Value> = serde_json::from_str(&art.a11y_json()).unwrap();
        let active_2 = web_items_2
            .iter()
            .find(|item| {
                item["p"]
                    .as_str()
                    .is_some_and(|p| p.ends_with(&format!("/{second_focus}")))
            })
            .expect("active descendant web item for second radio");
        assert!(
            active_2["d"]
                .as_str()
                .is_some_and(|d| d.contains("Notify team?") && d.contains("Question Required")),
            "second focused active descendant must identify its own question: {active_2}"
        );

        // 2. Desktop accepts unpadded JS `Date.parse` dates like `2026-2-3` on required hidden
        // `date-time` fields and submits them verbatim.
        let unpadded_dt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r19-unpadded-dt".into(),
            title: "Unpadded date".into(),
            fields: vec![json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "hidden": true,
                "required": true,
                "default": "2026-2-3"
            })],
        };
        let mut dt_drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&unpadded_dt_form), &mut dt_drafts);
        let dt_ans = agent_forms::answer(&unpadded_dt_form, &dt_drafts)
            .expect("unpadded date-time default `2026-2-3` must pass on desktop");
        assert_eq!(dt_ans["when"], json!("2026-2-3"));

        // 3. Typing into an optional text field with `default: ""` and then clearing it back to
        // `""` re-activates `when: eq ""` and submits `""` instead of omitting both keys.
        let cleared_empty_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r19-cleared-empty".into(),
            title: "Cleared empty".into(),
            fields: vec![
                json!({
                    "key": "note",
                    "title": "Note",
                    "type": "string",
                    "default": ""
                }),
                json!({
                    "key": "followup",
                    "title": "Follow-up",
                    "type": "string",
                    "default": "shown",
                    "when": [{"key": "note", "op": "eq", "value": ""}]
                }),
            ],
        };
        let mut cdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&cleared_empty_form), &mut cdrafts);
        cdrafts
            .get_mut(&("form-r19-cleared-empty".into(), "note".into()))
            .unwrap()
            .editor()
            .text = "x".into();
        let while_typed = agent_forms::answer(&cleared_empty_form, &cdrafts).unwrap();
        assert_eq!(while_typed, json!({"note": "x"}));
        cdrafts
            .get_mut(&("form-r19-cleared-empty".into(), "note".into()))
            .unwrap()
            .editor()
            .text
            .clear();
        let after_clear = agent_forms::answer(&cleared_empty_form, &cdrafts)
            .expect("clearing a defaulted empty string must keep value presence");
        assert_eq!(after_clear, json!({"note": "", "followup": "shown"}));

        // 4. Custom multiselect with declared option `prod` and `minItems: 2` accepts `prod, prod`
        // in custom input, and custom scalar input matching a declared option selects & submits it.
        let custom_declared_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r19-declared-custom".into(),
            title: "Custom declared".into(),
            fields: vec![
                json!({
                    "key": "targets",
                    "title": "Targets",
                    "type": "multiselect",
                    "custom": true,
                    "minItems": 2,
                    "options": [{"value": "prod", "label": "Production"}]
                }),
                json!({
                    "key": "tier",
                    "title": "Tier",
                    "type": "string",
                    "custom": true,
                    "options": [{"value": "prod", "label": "Production"}]
                }),
            ],
        };
        let mut mdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&custom_declared_form), &mut mdrafts);
        mdrafts
            .get_mut(&("form-r19-declared-custom".into(), "targets".into()))
            .unwrap()
            .custom_editor()
            .text = "prod, prod".into();
        mdrafts
            .get_mut(&("form-r19-declared-custom".into(), "tier".into()))
            .unwrap()
            .custom_editor()
            .text = "prod".into();
        let mans = agent_forms::answer(&custom_declared_form, &mdrafts)
            .expect("custom declared values and multiplicity must match Solid and OpenCode");
        assert_eq!(mans["targets"], json!(["prod", "prod"]));
        assert_eq!(mans["tier"], json!("prod"));

        // 5. Pattern validation cache works consistently across repeated checks without storing
        // plaintext draft values (keyed 128-bit digests only).
        let secret_field = json!({
            "key": "token",
            "title": "Token",
            "type": "string",
            "required": true,
            "pattern": "^sk-[a-z0-9]{4,}$"
        });
        let mut sd = agent_forms::Draft::default();
        sd.editor().text = "sk-secret1234".into();
        assert_eq!(
            agent_forms::value(&secret_field, &sd),
            Ok(Some(json!("sk-secret1234")))
        );
        sd.editor().text = "bad".into();
        assert!(agent_forms::value(&secret_field, &sd).is_err());
    });
}

#[test]
fn unified_multiselect_checkbox_custom_focus_proxy_prompt_clearable_email_gmt_offset_and_bounded_pattern_cache()
 {
    crate::strings::with_locale("en", || {
        // 1. Multiselect checkbox state and reply stay unified with custom input: typing "prod"
        // checks Production, toggling off removes "prod" from both checkbox and custom text, and
        // toggling back on produces `["prod"]` without duplicates.
        let unified_ms_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r20-unified-ms".into(),
            title: "Targets".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let (state, _rx) = state_with_form(unified_ms_form);
        let mut urt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        urt.frame(0.0);
        urt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r20-unified-ms".into(), "targets".into()))
                .unwrap()
                .custom_editor()
                .text = "prod".into();
        });
        urt.frame(1.0 / 60.0);
        let prod_box = agent_forms::multi_option_key("targets", "prod");
        let utree1 = urt.accessibility_json();
        assert!(
            has_state(find_node(&utree1, &prod_box).unwrap(), "checked"),
            "typing declared value in custom input must check its checkbox"
        );
        // Toggle off -> unchecked and omitted/empty (no stale "prod" submitted).
        tap(&mut urt, &prod_box);
        let utree2 = urt.accessibility_json();
        assert!(has_state(
            find_node(&utree2, &prod_box).unwrap(),
            "unchecked"
        ));
        let uans_off = agent_forms::answer(
            &urt.state.agent.as_ref().unwrap().forms[0],
            &urt.state.agent.as_ref().unwrap().drafts,
        )
        .unwrap();
        assert_eq!(uans_off["targets"], json!([]));
        // Toggle on -> checked and submits `["prod"]` with no duplicate.
        tap(&mut urt, &prod_box);
        let utree3 = urt.accessibility_json();
        assert!(has_state(find_node(&utree3, &prod_box).unwrap(), "checked"));
        let uans_on = agent_forms::answer(
            &urt.state.agent.as_ref().unwrap().forms[0],
            &urt.state.agent.as_ref().unwrap().drafts,
        )
        .unwrap();
        assert_eq!(uans_on["targets"], json!(["prod"]));

        // 2. Focused radio's web active-descendant proxy carries both title ("Database") and
        // bounded field description ("Which database should we remove?").
        let db_prompt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r20-proxy-desc".into(),
            title: "Cleanup".into(),
            fields: vec![json!({
                "key": "db",
                "title": "Database",
                "description": "Which database should we remove?",
                "type": "string",
                "options": [
                    {"value": "primary", "label": "Primary"},
                    {"value": "replica", "label": "Replica"}
                ]
            })],
        };
        let (state, _rx) = state_with_form(db_prompt_form);
        let mut prt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        prt.frame(0.0);
        press_key(&mut prt, Key::Tab);
        let focused = focused_key(&mut prt).expect("focused radio");
        let pitems: Vec<serde_json::Value> = serde_json::from_str(&prt.a11y_json()).unwrap();
        let active_proxy = pitems
            .iter()
            .find(|item| {
                item["p"]
                    .as_str()
                    .is_some_and(|p| p.ends_with(&format!("/{focused}")))
            })
            .expect("active radio proxy in web mirror");
        assert!(
            active_proxy["d"].as_str().is_some_and(|d| {
                d.contains("Database") && d.contains("Which database should we remove?")
            }),
            "focused radio proxy must include both title and field prompt: {active_proxy}"
        );

        // 3. Clearing a defaulted optional constrained field (email defaulted to `dev@example.com`)
        // omits the key and keeps Answer enabled instead of blocking with InvalidFormat.
        let opt_email_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r20-opt-email".into(),
            title: "Contact".into(),
            fields: vec![json!({
                "key": "email",
                "title": "Email",
                "type": "string",
                "format": "email",
                "default": "dev@example.com"
            })],
        };
        let mut edrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&opt_email_form), &mut edrafts);
        edrafts
            .get_mut(&("form-r20-opt-email".into(), "email".into()))
            .unwrap()
            .editor()
            .text
            .clear();
        let eans = agent_forms::answer(&opt_email_form, &edrafts)
            .expect("clearing a defaulted optional email field must omit the key and pass");
        assert_eq!(eans, json!({}));

        // 4. Desktop accepts OpenCode/JS `date-time` defaults with `GMT+0000` (and parenthesized
        // zone names) in required hidden fields and submits verbatim.
        let gmt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r20-gmt".into(),
            title: "GMT offset".into(),
            fields: vec![json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "hidden": true,
                "required": true,
                "default": "2026-11-26 14:30:00 GMT+0000"
            })],
        };
        let mut gdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&gmt_form), &mut gdrafts);
        let gans = agent_forms::answer(&gmt_form, &gdrafts)
            .expect("GMT+0000 date-time default must pass on desktop");
        assert_eq!(gans["when"], json!("2026-11-26 14:30:00 GMT+0000"));

        // 5. Oversized patterns (> 2 KiB) bypass PATTERN_CACHE completely so sequential large
        // plugin forms never bloat retained pattern cache bytes.
        let before_bytes = crate::agent::string_constraints::pattern_cache_bytes();
        for i in 0..8 {
            let huge_pat = format!("^{}{}$", "a".repeat(32_768), i);
            let field = json!({
                "key": "big",
                "type": "string",
                "pattern": huge_pat
            });
            assert!(crate::agent::string_constraints::valid_string_constraints(
                &field
            ));
        }
        let after_bytes = crate::agent::string_constraints::pattern_cache_bytes();
        assert_eq!(
            after_bytes, before_bytes,
            "oversized deferred patterns must never be retained in PATTERN_CACHE"
        );
        assert!(
            after_bytes <= 64 * 1024,
            "PATTERN_CACHE retained bytes must stay bounded <= 64 KiB"
        );
    });
}

#[test]
fn empty_custom_default_blank_custom_empty_option_us_hyphen_date_and_single_pass_multiselect_render()
 {
    crate::strings::with_locale("en", || {
        // 1. Optional string field with `custom: true`, one non-empty option, and `default: ""`
        // preserves the untouched empty custom default, activates `when: eq ""`, and submits both.
        // Typing then clearing the custom editor drops back to absent (matching Solid).
        let empty_custom_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r21-empty-custom".into(),
            title: "Mode".into(),
            fields: vec![
                json!({
                    "key": "mode",
                    "title": "Mode",
                    "type": "string",
                    "custom": true,
                    "options": [{"value": "fast", "label": "Fast"}],
                    "default": ""
                }),
                json!({
                    "key": "followup",
                    "title": "Follow-up",
                    "type": "string",
                    "default": "details",
                    "when": [{"key": "mode", "op": "eq", "value": ""}]
                }),
            ],
        };
        let mut drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&empty_custom_form), &mut drafts);
        let untouched = agent_forms::answer(&empty_custom_form, &drafts)
            .expect("untouched explicit empty custom default must activate follow-up and submit");
        assert_eq!(untouched, json!({"mode": "", "followup": "details"}));
        drafts
            .get_mut(&("form-r21-empty-custom".into(), "mode".into()))
            .unwrap()
            .custom_editor()
            .text = "custom".into();
        let typed = agent_forms::answer(&empty_custom_form, &drafts).unwrap();
        assert_eq!(typed, json!({"mode": "custom"}));
        drafts
            .get_mut(&("form-r21-empty-custom".into(), "mode".into()))
            .unwrap()
            .custom_editor()
            .text
            .clear();
        let cleared = agent_forms::answer(&empty_custom_form, &drafts).unwrap();
        assert_eq!(cleared, json!({}));

        // 2. Blank custom input (`" "`) in a custom multiselect with a declared `""` option
        // ("None") never marks "None" checked and still lets the user toggle "None" on and off.
        let empty_opt_ms = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r21-blank-opt".into(),
            title: "Choices".into(),
            fields: vec![json!({
                "key": "picks",
                "title": "Picks",
                "type": "multiselect",
                "custom": true,
                "minItems": 1,
                "options": [{"value": "", "label": "None"}]
            })],
        };
        let (state, _rx) = state_with_form(empty_opt_ms);
        let mut brt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        brt.frame(0.0);
        brt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r21-blank-opt".into(), "picks".into()))
                .unwrap()
                .custom_editor()
                .text = " ".into();
        });
        brt.frame(1.0 / 60.0);
        let none_key = agent_forms::multi_option_key("picks", "");
        let btree1 = brt.accessibility_json();
        assert!(
            has_state(find_node(&btree1, &none_key).unwrap(), "unchecked"),
            "blank custom input must not mark declared empty-value checkbox as checked"
        );
        assert!(has_state(
            find_node(&btree1, "answer-question").unwrap(),
            "disabled"
        ));
        // Clicking "None" explicitly selects `""`, satisfies `minItems: 1`, and submits `[""]`.
        tap(&mut brt, &none_key);
        let btree2 = brt.accessibility_json();
        assert!(has_state(find_node(&btree2, &none_key).unwrap(), "checked"));
        assert!(!has_state(
            find_node(&btree2, "answer-question").unwrap(),
            "disabled"
        ));
        let bans = agent_forms::answer(
            &brt.state.agent.as_ref().unwrap().forms[0],
            &brt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("explicitly selecting declared empty-value checkbox must submit");
        assert_eq!(bans["picks"], json!([""]));

        // 3. Desktop accepts US hyphenated `date-time` default `11-26-2026 14:30:00` in a
        // required hidden field and submits it verbatim.
        let us_dt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r21-us-dt".into(),
            title: "US date".into(),
            fields: vec![json!({
                "key": "when",
                "type": "string",
                "format": "date-time",
                "hidden": true,
                "required": true,
                "default": "11-26-2026 14:30:00"
            })],
        };
        let mut udrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&us_dt_form), &mut udrafts);
        let uans = agent_forms::answer(&us_dt_form, &udrafts)
            .expect("US hyphenated date-time default must pass on desktop");
        assert_eq!(uans["when"], json!("11-26-2026 14:30:00"));

        // 4. Pasting a huge comma-separated column (> 20,000 UTF-16 code units) into a 64-option
        // custom multiselect stays fast on render (O(1) size bailout, never reparsed 64 times).
        let opts_64: Vec<serde_json::Value> = (0..64)
            .map(|i| json!({"value": format!("opt_{i:02}"), "label": format!("Opt {i:02}")}))
            .collect();
        let big_paste_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r21-paste".into(),
            title: "Paste".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": opts_64
            })],
        };
        let (mut state, _rx) = state_with_form(big_paste_form);
        state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r21-paste".into(), "tags".into()))
            .unwrap()
            .custom_editor()
            .text = (0..10_000)
            .map(|i| format!("row{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let t0 = std::time::Instant::now();
        let mut prt = Runtime::new(state, render_form, (420.0, 520.0), Env::new(false, 1.0));
        prt.frame(0.0);
        prt.frame(1.0 / 60.0);
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "oversized custom paste across 64 multiselect options must bail out cleanly in render"
        );
    });
}

#[test]
fn checkbox_custom_dedup_unpadded_local_dt_normalization_literal_quotes_optional_bad_pattern_and_bounded_option_descriptions()
 {
    crate::strings::with_locale("en", || {
        // 1. Checking Production (`prod`) and entering `prod` in Other values preserves
        // Solid/OpenCode multiplicity (`["prod", "prod"]`), satisfying `minItems: 2`.
        let multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r22-dedup".into(),
            title: "Deploy".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "minItems": 2,
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let mut drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&multi_form), &mut drafts);
        let td = drafts
            .get_mut(&("form-r22-dedup".into(), "targets".into()))
            .unwrap();
        td.toggle("prod");
        td.custom_editor().text = "prod".into();
        let ans = agent_forms::answer(&multi_form, &drafts)
            .expect("checked prod + custom 'prod' must preserve Solid/OpenCode multiplicity");
        assert_eq!(ans["targets"], json!(["prod", "prod"]));

        // 2. Unpadded local date-time `2026-11-26 4:30` normalizes to UTC `2026-11-26T09:30:00.000Z`
        // under US Eastern time (-05:00) instead of falling back to the raw timezone-less string.
        let est_clock = |utc_secs: i64| -> Option<(i32, i32, i32, i32, i32, i32)> {
            let local = utc_secs - 5 * 3600;
            let days = local.div_euclid(86_400);
            let sod = local.rem_euclid(86_400);
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = mp + if mp < 10 { 3 } else { -9 };
            let y = y + i64::from(m <= 2);
            Some((
                y as i32,
                m as i32,
                d as i32,
                (sod / 3600) as i32,
                ((sod % 3600) / 60) as i32,
                (sod % 60) as i32,
            ))
        };
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "2026-11-26 4:30",
                est_clock
            )
            .as_deref(),
            Some("2026-11-26T09:30:00.000Z")
        );

        // 3. Literal quotes like `"prod"` entered into custom multiselect stay `"prod"` verbatim.
        let literal_quote_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r22-quotes".into(),
            title: "Quotes".into(),
            fields: vec![json!({
                "key": "tags",
                "title": "Tags",
                "type": "multiselect",
                "custom": true,
                "options": []
            })],
        };
        let mut qdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&literal_quote_form), &mut qdrafts);
        qdrafts
            .get_mut(&("form-r22-quotes".into(), "tags".into()))
            .unwrap()
            .custom_editor()
            .text = "\"prod\"".into();
        let qans = agent_forms::answer(&literal_quote_form, &qdrafts).unwrap();
        assert_eq!(qans["tags"], json!(["\"prod\""]));

        // 4. An unused optional field with malformed pattern `[unclosed` does not block submitting
        // a sibling required field, while typing into the optional field still rejects the value.
        let opt_bad_pat_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r22-opt-pat".into(),
            title: "Profile".into(),
            fields: vec![
                json!({"key": "name", "title": "Name", "type": "string", "required": true}),
                json!({"key": "note", "title": "Note", "type": "string", "pattern": "[unclosed"}),
            ],
        };
        assert!(agent_forms::supported(&opt_bad_pat_form));
        let mut pdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&opt_bad_pat_form), &mut pdrafts);
        pdrafts
            .get_mut(&("form-r22-opt-pat".into(), "name".into()))
            .unwrap()
            .editor()
            .text = "Alice".into();
        let pans = agent_forms::answer(&opt_bad_pat_form, &pdrafts)
            .expect("untouched optional field with malformed pattern must not block required Name");
        assert_eq!(pans, json!({"name": "Alice"}));
        pdrafts
            .get_mut(&("form-r22-opt-pat".into(), "note".into()))
            .unwrap()
            .editor()
            .text = "typed".into();
        assert!(
            agent_forms::answer(&opt_bad_pat_form, &pdrafts).is_err(),
            "supplying text into a field with malformed pattern must fail closed"
        );

        // 5. Ten options each with a 100 KiB description bound both initial visual layout and
        // accessibility strings, exposing an incremental reveal button per truncated option.
        let huge_opt_desc = "E".repeat(100_000);
        let opts_10: Vec<serde_json::Value> = (0..10)
            .map(|i| {
                json!({
                    "value": format!("opt_{i}"),
                    "label": format!("Option {i}"),
                    "description": huge_opt_desc
                })
            })
            .collect();
        let big_opt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r22-opt-desc".into(),
            title: "Large options".into(),
            fields: vec![json!({
                "key": "choice",
                "title": "Choice",
                "type": "string",
                "options": opts_10
            })],
        };
        let (state, _rx) = state_with_form(big_opt_form);
        let t0 = std::time::Instant::now();
        let mut brt = Runtime::new(state, render_form, (420.0, 2600.0), Env::new(false, 1.0));
        brt.frame(0.0);
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "10x100KiB option descriptions must render quickly via bounded previews"
        );
        let btree = brt.accessibility_json();
        let opt0_key = agent_forms::string_option_key("choice", "opt_0");
        let opt0_node = find_node(&btree, &opt0_key).unwrap();
        assert!(
            opt0_node["description"]
                .as_str()
                .is_some_and(|d| d.len() < 400),
            "option accessibility description must stay bounded (< 400 bytes), never 100 KiB"
        );
        let initial_desc_len: usize = brt
            .elements()
            .into_iter()
            .filter(|e| e.key.as_deref() == Some("description"))
            .filter_map(|e| e.text.map(|t| t.len()))
            .sum();
        assert!(
            initial_desc_len < 4_000,
            "initial visual option descriptions across 10 options must be bounded (< 4 KiB, got {initial_desc_len})"
        );
        // Activating the separate reveal button expands opt_0 by one bounded step without
        // expanding sibling options or bloating opt_0's accessibility string.
        let reveal0 = agent_forms::option_desc_reveal_key("choice", "opt_0");
        let reveal0_node = find_node(&btree, &reveal0).unwrap();
        assert!(
            reveal0_node["name"]
                .as_str()
                .is_some_and(|n| n.contains("Option 0")),
            "reveal button must identify its option in accessible name"
        );
        tap(&mut brt, &reveal0);
        let after_desc_len: usize = brt
            .elements()
            .into_iter()
            .filter(|e| e.key.as_deref() == Some("description"))
            .filter_map(|e| e.text.map(|t| t.len()))
            .sum();
        assert!(
            after_desc_len > initial_desc_len + 1_500 && after_desc_len < 6_000,
            "revealing one step must expand opt_0 by ~2,000 chars only (got {after_desc_len})"
        );
        let btree_after = brt.accessibility_json();
        let opt0_after = find_node(&btree_after, &opt0_key).unwrap();
        assert!(
            opt0_after["description"]
                .as_str()
                .is_some_and(|d| d.len() > 2_000 && d.len() < 3_000),
            "option accessibility description must expose the newly revealed 2,000-char chunk while staying bounded (never 100 KiB)"
        );
    });
}

#[test]
fn revealed_option_a11y_multiselect_multiplicity_strict_dates_empty_default_clear_failed_reply_focus_and_backref_deferred_rejection()
 {
    crate::strings::with_locale("en", || {
        // 1. A 300-character option description keeps its collapsed 240-char accessibility budget
        // initially, and exposes the full revealed text (including tail after char 240) to both
        // native AccessKit and web mirror after activating Show all.
        let tail_instruction = "CRITICAL_TAIL_AFTER_240";
        let long_300 = format!("{} {tail_instruction}", "A".repeat(250));
        let reveal_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r23-reveal".into(),
            title: "Instructions".into(),
            fields: vec![json!({
                "key": "opt",
                "title": "Option",
                "type": "string",
                "options": [
                    {"value": "a", "label": "Alpha", "description": long_300}
                ]
            })],
        };
        let (state, _rx) = state_with_form(reveal_form);
        let mut rrt = Runtime::new(state, render_form, (420.0, 900.0), Env::new(false, 1.0));
        rrt.frame(0.0);
        let opt_a_key = agent_forms::string_option_key("opt", "a");
        let before_tree = rrt.accessibility_json();
        let before_desc = find_node(&before_tree, &opt_a_key).unwrap()["description"]
            .as_str()
            .unwrap();
        assert!(
            !before_desc.contains(tail_instruction),
            "collapsed option preview must stay within the 240-char initial budget"
        );
        let reveal_key = agent_forms::option_desc_reveal_key("opt", "a");
        tap(&mut rrt, &reveal_key);
        let after_tree = rrt.accessibility_json();
        let after_desc = find_node(&after_tree, &opt_a_key).unwrap()["description"]
            .as_str()
            .unwrap();
        assert!(
            after_desc.contains(tail_instruction),
            "activating Show all must expose revealed text after char 240 in AccessKit: {after_desc}"
        );
        let web_items: Vec<serde_json::Value> = serde_json::from_str(&rrt.a11y_json()).unwrap();
        assert!(
            web_items.iter().any(|item| {
                item["p"]
                    .as_str()
                    .is_some_and(|p| p.ends_with(&format!("/{opt_a_key}")))
                    && item["d"]
                        .as_str()
                        .is_some_and(|d| d.contains(tail_instruction))
            }),
            "activating Show all must expose revealed text in the web mirror too: {web_items:?}"
        );

        // 2. Strict cross-target date-time validation rejects invalid numeric/named dates like
        // `99/99/2026`, `2/30/2026`, `Jan 99, 2026`, while accepting valid formats.
        let dt_field = json!({
            "key": "when",
            "title": "When",
            "type": "string",
            "format": "date-time",
            "required": true
        });
        let mut budget = crate::agent::string_constraints::MatchBudget::new();
        for bad in [
            "99/99/2026",
            "2/30/2026",
            "13-01-2026 12:00",
            "Jan 99, 2026",
            "Feb 30, 2026",
            "2026/13/01",
        ] {
            assert_eq!(
                crate::agent::string_constraints::matches_string_constraints_budgeted(
                    &dt_field,
                    bad,
                    &mut budget
                ),
                Ok(crate::agent::string_constraints::MatchOutcome::NoMatch),
                "invalid date-time {bad:?} must be rejected identically across targets"
            );
        }
        for good in [
            "2026-11-26T14:30:00Z",
            "2026-11-26 4:30",
            "2026/11/26",
            "11/26/2026",
            "11-26-2026 14:30:00",
            "Thu, 26 Nov 2026 14:30:00 GMT",
            "Nov 26, 2026",
            "November 26, 2026 2:30 PM",
        ] {
            assert_eq!(
                crate::agent::string_constraints::matches_string_constraints_budgeted(
                    &dt_field,
                    good,
                    &mut budget
                ),
                Ok(crate::agent::string_constraints::MatchOutcome::Matched),
                "valid date-time {good:?} must be accepted"
            );
        }

        // 3. Optional string with `custom: true`, declared `prod`, and `default: ""`: Clear is
        // enabled initially because Rune would submit `""`, and clicking Clear omits the field.
        let empty_default_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r23-empty-clear".into(),
            title: "Target".into(),
            fields: vec![json!({
                "key": "env",
                "title": "Environment",
                "type": "string",
                "custom": true,
                "default": "",
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let (state, _rx) = state_with_form(empty_default_form);
        let mut ert = Runtime::new(state, render_form, (420.0, 720.0), Env::new(false, 1.0));
        ert.frame(0.0);
        let clear_key = agent_forms::clear_option_key("env");
        let before_clear_tree = ert.accessibility_json();
        assert!(
            !has_state(
                find_node(&before_clear_tree, &clear_key).unwrap(),
                "disabled"
            ),
            "Clear must be enabled when an explicit empty default would be submitted"
        );
        let before_ans = agent_forms::answer(
            &ert.state.agent.as_ref().unwrap().forms[0],
            &ert.state.agent.as_ref().unwrap().drafts,
        )
        .unwrap();
        assert_eq!(before_ans["env"], json!(""));
        tap(&mut ert, &clear_key);
        let after_clear_tree = ert.accessibility_json();
        assert!(
            has_state(
                find_node(&after_clear_tree, &clear_key).unwrap(),
                "disabled"
            ),
            "Clear must become disabled once the explicit empty default is cleared"
        );
        let after_ans = agent_forms::answer(
            &ert.state.agent.as_ref().unwrap().forms[0],
            &ert.state.agent.as_ref().unwrap().drafts,
        )
        .unwrap();
        assert!(after_ans.get("env").is_none());

        // 4. Stale editor focus after a failed reply must never steal focus from another enabled
        // control focused while the reply was pending, and must preserve editor text/selection.
        let focus_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r23-focus".into(),
            title: "Reply focus".into(),
            fields: vec![json!({
                "key": "msg",
                "title": "Message",
                "type": "string",
                "required": true,
                "default": "hello world"
            })],
        };
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (results_tx, results) = codenomad_client::bounded(4);
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
        ui.selected = focus_form.id.clone();
        ui.forms.push(focus_form.clone());
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        let mut state = crate::init();
        state.phase = crate::Phase::Ready;
        state.agent = Some(ui);
        let render_with_sibling = |s: &State, cx: &mut Cx<State>| {
            layout::render(cx, |_| {
                let Some(form) = s.agent.as_ref().and_then(|a| a.forms.first()) else {
                    return col();
                };
                col()
                    .full_width()
                    .full_height()
                    .child(fields(s, form))
                    .child(actions(s, form))
                    .child(crate::components::button(
                        "sibling-enabled",
                        "Other",
                        false,
                        |_: &mut State| {},
                    ))
            })
        };
        let mut frt = Runtime::new(
            state,
            render_with_sibling,
            (420.0, 620.0),
            Env::new(false, 1.0),
        );
        frt.frame(0.0);
        // Focus textbox and set a non-empty selection.
        frt.update(|s, _| {
            let d = s
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r23-focus".into(), "msg".into()))
                .unwrap();
            d.edit.focused = true;
            d.edit.anchor = 0;
            d.edit.focus = 5;
        });
        frt.frame(1.0 / 60.0);
        // Invoke Answer without blurring the textbox (simulating AccessKit Click action).
        frt.update(|s, _| {
            s.agent.as_mut().unwrap().answer_form("form-r23-focus");
        });
        frt.frame(1.0 / 60.0);
        let pending_gen = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, generation)) => generation,
            _ => panic!("expected PendingJob::Act"),
        };
        // Focus another enabled control while locked.
        frt.update(|_, tx| tx.focus("sibling-enabled", true));
        frt.frame(1.0 / 60.0);
        assert_eq!(focused_key(&mut frt).as_deref(), Some("sibling-enabled"));
        // Deliver a failed reply that leaves the same form pending.
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::Failed,
                Some(vec![focus_form.clone()]),
                pending_gen,
            ))
            .unwrap();
        frt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        frt.frame(1.0 / 60.0);
        assert_eq!(
            focused_key(&mut frt).as_deref(),
            Some("sibling-enabled"),
            "unlocking after a failed reply must not steal focus back to the stale textbox"
        );
        let msg_draft = frt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r23-focus".into(), "msg".into()))
            .unwrap();
        assert_eq!(msg_draft.edit.text, "hello world");
        assert_eq!((msg_draft.edit.anchor, msg_draft.edit.focus), (0, 5));

        // 5. Backreferences, lookarounds, and inline modifiers evaluate within budget, and
        // genuinely deferred patterns distinguish Deferred from Matched and surface field-level
        // errors when rejected by the server.
        let backref_field = json!({
            "key": "code",
            "title": "Code",
            "type": "string",
            "required": true,
            "pattern": "^([A-Z]{2})-\\1$"
        });
        let mut budget = crate::agent::string_constraints::MatchBudget::new();
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &backref_field,
                "AB-CD",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch),
            "^([A-Z]{{2}})-\\1$ must reject AB-CD locally"
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &backref_field,
                "AB-AB",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched),
            "^([A-Z]{{2}})-\\1$ must accept AB-AB locally"
        );
        let lookahead_field = json!({
            "key": "pw",
            "type": "string",
            "pattern": "^(?=.*[0-9])(?=.*[A-Z]).{8,}$"
        });
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &lookahead_field,
                "abcdef12",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &lookahead_field,
                "Abcdef12",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        let named_ref_field = json!({
            "key": "pair",
            "type": "string",
            "pattern": "^(?<t>[a-z]+)=\\k<t>$"
        });
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &named_ref_field,
                "foo=bar",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &named_ref_field,
                "foo=foo",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        let lookbehind_field = json!({
            "key": "lb",
            "type": "string",
            "pattern": "(?<=foo)bar"
        });
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &lookbehind_field,
                "bazbar",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &lookbehind_field,
                "foobar",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        let mod_field = json!({
            "key": "mod",
            "type": "string",
            "pattern": "(?i:^ok$)"
        });
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &mod_field,
                "OK",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &mod_field,
                "NO",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );

        // Genuinely deferred pattern (`\p{Lu}`): returns Deferred, enables initial submit, and
        // surfaces a field-level error on server rejection until the user changes the value.
        let deferred_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r23-deferred".into(),
            title: "Deferred".into(),
            fields: vec![json!({
                "key": "token",
                "title": "Token",
                "type": "string",
                "required": true,
                "pattern": "^\\p{Lu}+$"
            })],
        };
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &deferred_form.fields[0],
                "abc",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Deferred)
        );
        let (jobs2, _) = codenomad_client::bounded(1);
        let (stop2, _) = codenomad_client::bounded(1);
        let (results2_tx, results2) = codenomad_client::bounded(4);
        let (forms2_tx, forms2_rx) = codenomad_client::bounded(4);
        let mut handle2 = crate::agent::Handle::test(jobs2, stop2, results2);
        handle2.forms = forms2_tx;
        let mut ui2 = crate::agent::Ui::new(handle2);
        ui2.reading = false;
        ui2.known = true;
        ui2.mark_pending_known();
        ui2.forms_lane.reading = false;
        ui2.online = true;
        while forms2_rx.try_recv().is_ok() {}
        ui2.selected = deferred_form.id.clone();
        ui2.forms.push(deferred_form.clone());
        agent_forms::seed(&ui2.forms, &mut ui2.drafts);
        ui2.drafts
            .get_mut(&("form-r23-deferred".into(), "token".into()))
            .unwrap()
            .editor()
            .text = "abc".into();
        let mut state2 = crate::init();
        state2.phase = crate::Phase::Ready;
        state2.agent = Some(ui2);
        let mut drt = Runtime::new(state2, render_form, (420.0, 620.0), Env::new(false, 1.0));
        drt.frame(0.0);
        assert!(
            !has_state(
                find_node(&drt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "deferred pattern must allow initial submission to authoritative server"
        );
        drt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r23-deferred"));
        let def_gen = match forms2_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, generation)) => generation,
            _ => panic!("expected deferred PendingJob::Act"),
        };
        results2_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "{\"error\":\"Form field does not match pattern: token\"}".into(),
                )),
                Some(vec![deferred_form.clone()]),
                def_gen,
            ))
            .unwrap();
        drt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        drt.frame(1.0 / 60.0);
        let rejected_tree = drt.accessibility_json();
        assert!(
            find_node(&rejected_tree, &agent_forms::field_error_key("token")).is_some(),
            "server rejection of a deferred field must surface a field-level error"
        );
        assert!(
            has_state(
                find_node(&rejected_tree, "answer-question").unwrap(),
                "disabled"
            ),
            "server-rejected deferred value must disable Answer until edited"
        );
        drt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r23-deferred".into(), "token".into()))
                .unwrap()
                .editor()
                .text = "ABC".into();
        });
        drt.frame(1.0 / 60.0);
        let edited_tree = drt.accessibility_json();
        assert!(
            find_node(&edited_tree, &agent_forms::field_error_key("token")).is_none(),
            "editing the deferred field must clear the previous rejection error"
        );
        assert!(
            !has_state(
                find_node(&edited_tree, "answer-question").unwrap(),
                "disabled"
            ),
            "editing the deferred field must re-enable Answer"
        );
    });
}

#[test]
fn transient_503_keeps_deferred_retryable_unicode_capture_names_extended_iso_years_committed_custom_multiselect_and_reveal_focus_region()
 {
    crate::strings::with_locale("en", || {
        // 1. A transient 503 failure (FormReplyOutcome::Failed) on a deferred field (`^a{257}$`)
        // keeps the unchanged valid answer retryable with Answer enabled.
        let retry_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-503".into(),
            title: "Retry".into(),
            fields: vec![json!({
                "key": "code",
                "title": "Code",
                "type": "string",
                "required": true,
                "pattern": "^a{257}$"
            })],
        };
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (results_tx, results) = codenomad_client::bounded(4);
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
        ui.selected = retry_form.id.clone();
        ui.forms.push(retry_form.clone());
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        ui.drafts
            .get_mut(&("form-r24-503".into(), "code".into()))
            .unwrap()
            .editor()
            .text = "a".repeat(257);
        let mut state = crate::init();
        state.phase = crate::Phase::Ready;
        state.agent = Some(ui);
        let mut rt = Runtime::new(state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        rt.frame(0.0);
        rt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r24-503"));
        let g1 = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, generation)) => generation,
            _ => panic!("expected PendingJob::Act"),
        };
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::Failed,
                Some(vec![retry_form.clone()]),
                g1,
            ))
            .unwrap();
        rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        rt.frame(1.0 / 60.0);
        let after_503 = rt.accessibility_json();
        assert!(
            find_node(&after_503, &agent_forms::field_error_key("code")).is_none(),
            "transient 503 failure must not mark a deferred field invalid"
        );
        assert!(
            !has_state(
                find_node(&after_503, "answer-question").unwrap(),
                "disabled"
            ),
            "transient 503 failure must keep Answer enabled for retry"
        );

        // 2. Unicode ECMAScript capture group names (`^(?<café>abc)$`) are accepted and matched
        // locally, and escaped names defer instead of marking the form unsupported.
        let unicode_cap_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-unicode-cap".into(),
            title: "Unicode".into(),
            fields: vec![json!({
                "key": "word",
                "title": "Word",
                "type": "string",
                "required": true,
                "pattern": "^(?<café>abc)$"
            })],
        };
        assert!(agent_forms::supported(&unicode_cap_form));
        let mut budget = crate::agent::string_constraints::MatchBudget::new();
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &unicode_cap_form.fields[0],
                "abc",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &unicode_cap_form.fields[0],
                "xyz",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );
        let unicode_ref_field = json!({
            "key": "dup",
            "type": "string",
            "required": true,
            "pattern": "^(?<café>[a-z]+)-\\k<café>$"
        });
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &unicode_ref_field,
                "hi-hi",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Matched)
        );
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &unicode_ref_field,
                "hi-no",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::NoMatch)
        );
        let escaped_cap_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-escaped-cap".into(),
            title: "Escaped".into(),
            fields: vec![json!({
                "key": "word",
                "title": "Word",
                "type": "string",
                "required": true,
                "pattern": "^(?<a\\u0062>abc)$"
            })],
        };
        assert!(agent_forms::supported(&escaped_cap_form));

        // 3. Signed 6-digit extended ISO local date-time (`+010000-01-01T00:00`) normalizes to
        // `+010000-01-01T00:00:00.000Z` on desktop just like web, and out-of-range local
        // date-times fail validation rather than sending raw timezone-less strings.
        let utc_clock = |utc_secs: i64| -> Option<(i32, i32, i32, i32, i32, i32)> {
            let days = utc_secs.div_euclid(86_400);
            let sod = utc_secs.rem_euclid(86_400);
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = mp + if mp < 10 { 3 } else { -9 };
            let y = y + i64::from(m <= 2);
            Some((
                y as i32,
                m as i32,
                d as i32,
                (sod / 3600) as i32,
                ((sod % 3600) / 60) as i32,
                (sod % 60) as i32,
            ))
        };
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "+010000-01-01T00:00",
                utc_clock
            )
            .as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "-000001-01-01T00:00",
                utc_clock
            )
            .as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        let oor_dt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-oor-dt".into(),
            title: "Date".into(),
            fields: vec![json!({
                "key": "dt",
                "title": "DT",
                "type": "string",
                "format": "date-time",
                "required": true
            })],
        };
        let mut oor_drafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&oor_dt_form), &mut oor_drafts);
        oor_drafts
            .get_mut(&("form-r24-oor-dt".into(), "dt".into()))
            .unwrap()
            .editor()
            .text = "+275760-09-14T00:00".into();
        assert!(
            agent_forms::answer(&oor_dt_form, &oor_drafts).is_err(),
            "out-of-range local date-time must fail validation instead of sending unnormalized wire value"
        );

        // 4. Typing declared `prod` into Other values, Tabbing out (committing), and replacing
        // custom text with `qa` keeps Production checked and submits `["prod", "qa"]`.
        let commit_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-commit".into(),
            title: "Deploy".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let (mut mstate, _mrx) = state_with_form(commit_form);
        {
            let a = mstate.agent.as_mut().unwrap();
            let d = a
                .drafts
                .get_mut(&("form-r24-commit".into(), "targets".into()))
                .unwrap();
            d.custom.focused = true;
            d.custom_editor().text = "prod".into();
            a.reconcile_custom_focus();
            // Simulate Tab out (blur).
            a.drafts
                .get_mut(&("form-r24-commit".into(), "targets".into()))
                .unwrap()
                .custom
                .focused = false;
            assert!(a.reconcile_custom_focus());
            // Focus again and replace custom text with `qa`.
            let d = a
                .drafts
                .get_mut(&("form-r24-commit".into(), "targets".into()))
                .unwrap();
            d.custom.focused = true;
            d.custom_editor().text = "qa".into();
        }
        let a = mstate.agent.as_ref().unwrap();
        let mans = agent_forms::answer(&a.forms[0], &a.drafts).unwrap();
        assert_eq!(mans["targets"], json!(["prod", "qa"]));

        // 5. focused_control_key resolves description-reveal buttons for both radio and checkbox
        // options to the form's scroll region so post-layout focus reveal keeps them in view.
        let long_desc = "D".repeat(500);
        let reveal_focus_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r24-reveal-focus".into(),
            title: "Choices".into(),
            fields: vec![
                json!({
                    "key": "env",
                    "title": "Environment",
                    "type": "string",
                    "options": [{"value": "prod", "label": "Prod", "description": long_desc}]
                }),
                json!({
                    "key": "tags",
                    "title": "Tags",
                    "type": "multiselect",
                    "options": [{"value": "api", "label": "API", "description": long_desc}]
                }),
            ],
        };
        let (rf_state, _rfrx) = state_with_form(reveal_focus_form);
        let radio_reveal = agent_forms::option_desc_reveal_key("env", "prod");
        let multi_reveal = agent_forms::option_desc_reveal_key("tags", "api");
        let expected_region = Some("pending-content-form-r24-reveal-focus".to_string());
        assert_eq!(
            crate::agent::focused_control_key(&rf_state, Some(&radio_reveal)),
            Some((radio_reveal, expected_region.clone())),
            "radio option description reveal button must resolve to form scroll region"
        );
        assert_eq!(
            crate::agent::focused_control_key(&rf_state, Some(&multi_reveal)),
            Some((multi_reveal, expected_region)),
            "checkbox option description reveal button must resolve to form scroll region"
        );
    });
}

#[test]
fn exact_validator_field_attribution_rtl_lookbehind_defer_committed_multiselect_order_canonical_local_iso_and_localized_websearch_consent()
 {
    crate::strings::with_locale("en", || {
        // 1. Two deferred fields (`code` and `pattern`) with `^a{257}$`: OpenCode rejecting
        // `Form field does not match pattern: code` must mark ONLY `code` invalid, never `pattern`.
        let two_def_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r25-attr".into(),
            title: "Two deferred".into(),
            fields: vec![
                json!({"key": "code", "title": "Code", "type": "string", "required": true, "pattern": "^a{257}$"}),
                json!({"key": "pattern", "title": "Pattern", "type": "string", "required": true, "pattern": "^a{257}$"}),
            ],
        };
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (results_tx, results) = codenomad_client::bounded(4);
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
        ui.selected = two_def_form.id.clone();
        ui.forms.push(two_def_form.clone());
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        ui.drafts
            .get_mut(&("form-r25-attr".into(), "code".into()))
            .unwrap()
            .editor()
            .text = "b".into();
        ui.drafts
            .get_mut(&("form-r25-attr".into(), "pattern".into()))
            .unwrap()
            .editor()
            .text = "a".repeat(257);
        let mut state = crate::init();
        state.phase = crate::Phase::Ready;
        state.agent = Some(ui);
        let mut rt = Runtime::new(state, render_form, (420.0, 720.0), Env::new(false, 1.0));
        rt.frame(0.0);
        rt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r25-attr"));
        let g = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, generation)) => generation,
            _ => panic!("expected PendingJob::Act"),
        };
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "{\"error\":\"Form field does not match pattern: code\"}".into(),
                )),
                Some(vec![two_def_form.clone()]),
                g,
            ))
            .unwrap();
        rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        rt.frame(1.0 / 60.0);
        let after_rej = rt.accessibility_json();
        assert!(
            find_node(&after_rej, &agent_forms::field_error_key("code")).is_some(),
            "rejected field `code` must show a field error"
        );
        assert!(
            find_node(&after_rej, &agent_forms::field_error_key("pattern")).is_none(),
            "unrelated valid field `pattern` must NOT be marked invalid because the sentence contains the word 'pattern'"
        );
        // Fixing `code` immediately re-enables Answer without touching `pattern`.
        rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r25-attr".into(), "code".into()))
                .unwrap()
                .editor()
                .text = "a".repeat(257);
        });
        rt.frame(1.0 / 60.0);
        assert!(
            !has_state(
                find_node(&rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "fixing `code` must re-enable Answer"
        );

        // 2. Capture-bearing lookbehind `^abc(?<=([ab]+)([bc]+))\1$` defers to OpenCode instead
        // of falsely rejecting ECMAScript's valid right-to-left match `"abca"`.
        let rtl_lb_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r25-rtl-lb".into(),
            title: "RTL lookbehind".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^abc(?<=([ab]+)([bc]+))\\1$"
            })],
        };
        let mut budget = crate::agent::string_constraints::MatchBudget::new();
        assert_eq!(
            crate::agent::string_constraints::matches_string_constraints_budgeted(
                &rtl_lb_form.fields[0],
                "abca",
                &mut budget
            ),
            Ok(crate::agent::string_constraints::MatchOutcome::Deferred),
            "capture-bearing lookbehind must defer instead of applying wrong forward capture priority"
        );
        let mut lbdrafts = agent_forms::Drafts::new();
        agent_forms::seed(std::slice::from_ref(&rtl_lb_form), &mut lbdrafts);
        lbdrafts
            .get_mut(&("form-r25-rtl-lb".into(), "val".into()))
            .unwrap()
            .editor()
            .text = "abca".into();
        assert_eq!(
            agent_forms::answer(&rtl_lb_form, &lbdrafts).unwrap()["val"],
            json!("abca")
        );

        // 3. Blurring a custom multiselect after typing `qa,prod` preserves exact typed order
        // `["qa", "prod"]` (matching Solid), and multiple promoted declared values (`beta,alpha`)
        // preserve deterministic typed order `["beta", "alpha"]`.
        let order_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r25-order".into(),
            title: "Order".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "options": [
                    {"value": "alpha", "label": "Alpha"},
                    {"value": "beta", "label": "Beta"},
                    {"value": "prod", "label": "Production"}
                ]
            })],
        };
        let (mut ostate, _orx) = state_with_form(order_form.clone());
        {
            let a = ostate.agent.as_mut().unwrap();
            let d = a
                .drafts
                .get_mut(&("form-r25-order".into(), "targets".into()))
                .unwrap();
            d.custom.focused = true;
            d.custom_editor().text = "qa,prod".into();
            a.reconcile_custom_focus();
            a.drafts
                .get_mut(&("form-r25-order".into(), "targets".into()))
                .unwrap()
                .custom
                .focused = false;
            assert!(a.reconcile_custom_focus());
        }
        let a = ostate.agent.as_ref().unwrap();
        assert_eq!(
            agent_forms::answer(&a.forms[0], &a.drafts).unwrap()["targets"],
            json!(["qa", "prod"]),
            "blurring `qa,prod` must preserve Solid's exact typed order"
        );
        // Multiple declared values preserve deterministic typed order `["beta", "alpha"]`.
        let (mut ostate2, _orx2) = state_with_form(order_form);
        {
            let a = ostate2.agent.as_mut().unwrap();
            let d = a
                .drafts
                .get_mut(&("form-r25-order".into(), "targets".into()))
                .unwrap();
            d.custom.focused = true;
            d.custom_editor().text = "beta,alpha".into();
            a.reconcile_custom_focus();
            a.drafts
                .get_mut(&("form-r25-order".into(), "targets".into()))
                .unwrap()
                .custom
                .focused = false;
            assert!(a.reconcile_custom_focus());
        }
        let a2 = ostate2.agent.as_ref().unwrap();
        assert_eq!(
            agent_forms::answer(&a2.forms[0], &a2.drafts).unwrap()["targets"],
            json!(["beta", "alpha"]),
            "promoting multiple declared values on blur must preserve deterministic typed order"
        );

        // 4. Unpadded local `2026-2-3T4:30` formats to canonical padded ISO `2026-02-03T04:30:00.000`
        // for Chromium/wasm32 Date parsing so desktop and wasm agree identically.
        assert_eq!(
            crate::agent::string_constraints::canonical_local_date_time_iso("2026-2-3T4:30")
                .as_deref(),
            Some("2026-02-03T04:30:00.000")
        );
        assert_eq!(
            crate::agent::string_constraints::canonical_local_date_time_iso("+010000-01-01T00:00")
                .as_deref(),
            Some("+010000-01-01T00:00:00.000")
        );
    });

    // 5. Native Web Search provider consent form localizes both its heading and its untitled
    // radio-group accessible name in French (`Fournisseur de recherche web`), matching Solid.
    crate::strings::with_locale("fr", || {
        let ws_form = Form {
            tool: None,
            infer_websearch: true,
            id: "form-r25-ws".into(),
            title: "Web Search".into(),
            fields: vec![json!({
                "key": "choice",
                "type": "string",
                "required": true,
                "options": [
                    {"value": "allow", "label": "Allow"},
                    {"value": "choose", "label": "Choose"},
                    {"value": "disable", "label": "Disable"}
                ]
            })],
        };
        let (ws_state, _wsrx) = state_with_form(ws_form);
        let mut wrt = Runtime::new(ws_state, render_form, (420.0, 720.0), Env::new(false, 1.0));
        wrt.frame(0.0);
        let wtree = wrt.accessibility_json();
        let group = find_node(&wtree, &agent_forms::field_group_key("choice")).unwrap();
        assert_eq!(
            group["name"], "Fournisseur de recherche web",
            "recognized Web Search consent form must use localized title as radio-group name"
        );
        assert!(
            wrt.elements().iter().any(|e| {
                e.text
                    .as_deref()
                    .is_some_and(|text| text.contains("Fournisseur de recherche web"))
            }),
            "recognized Web Search consent form must localize its visible heading"
        );
    });
}

#[test]
fn promoted_duplicate_replacement_bounded_nullable_repeat_escaped_capture_names_exact_dotted_key_editable_reconciliation_lmt_seconds_and_oversized_refresh_guard()
 {
    crate::strings::with_locale("en", || {
        // 1. Typing `prod,prod` in a custom multiselect (`maxItems: 2`), blurring to promote the
        // first `prod`, and replacing the remaining custom text `prod` with `qa` submits
        // `["prod", "qa"]` without leaving a ghost duplicate `prod`.
        let dup_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r26-dup".into(),
            title: "Targets".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "maxItems": 2,
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let (mut dup_state, _duprx) = state_with_form(dup_form.clone());
        dup_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r26-dup".into(), "targets".into()))
            .unwrap()
            .custom_editor()
            .text = "prod,prod".into();
        let mut drt = Runtime::new(dup_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        drt.frame(0.0);
        // Simulate focus then blur on custom multiselect editor.
        drt.update(|s, _| {
            let scope = s.input_scope.clone();
            let _ = s.editor(
                &scope,
                crate::screen::Editor::Custom(("form-r26-dup".into(), "targets".into())),
            );
            s.agent.as_mut().unwrap().reconcile_custom_focus();
        });
        {
            let a = drt.state.agent.as_ref().unwrap();
            let d = &a.drafts[&("form-r26-dup".into(), "targets".into())];
            assert!(d.selected.contains("prod"));
            assert_eq!(d.custom.text, "prod");
            assert_eq!(
                agent_forms::answer(&dup_form, &a.drafts).unwrap()["targets"],
                json!(["prod", "prod"])
            );
        }
        // Now replace the remaining text `prod` with `qa`.
        drt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r26-dup".into(), "targets".into()))
                .unwrap()
                .custom_editor()
                .text = "qa".into();
        });
        drt.frame(1.0 / 60.0);
        assert_eq!(
            agent_forms::answer(&dup_form, &drt.state.agent.as_ref().unwrap().drafts).unwrap()["targets"],
            json!(["prod", "qa"]),
            "replacing remaining custom text after blur promotion must not keep a ghost duplicate"
        );
        assert!(
            !has_state(
                find_node(&drt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must stay enabled for 2 items (`[\"prod\", \"qa\"]`) with maxItems: 2"
        );

        // 2. Bounded nullable repeat `^(?=(a?){1,2})\1$` matches `"a"` (ECMAScript zero-progress guard
        // prevents optional second iteration from overwriting capture 1 with an empty match).
        let repeat_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r26-repeat".into(),
            title: "Repeat".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^(?=(a?){1,2})\\1$"
            })],
        };
        let (mut r_state, _rrx) = state_with_form(repeat_form.clone());
        r_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r26-repeat".into(), "val".into()))
            .unwrap()
            .editor()
            .text = "a".into();
        assert_eq!(
            agent_forms::answer(&repeat_form, &r_state.agent.as_ref().unwrap().drafts).unwrap()["val"],
            json!("a"),
            "bounded optional repeat must apply ECMAScript zero-progress guard"
        );

        // 3. Valid escaped capture group name `^(?<\u0061>x)\k<a>$` decodes and matches `"xx"`.
        let esc_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r26-esc".into(),
            title: "Escaped group".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^(?<\\u0061>x)\\k<a>$"
            })],
        };
        let (mut esc_state, _erx) = state_with_form(esc_form.clone());
        esc_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r26-esc".into(), "val".into()))
            .unwrap()
            .editor()
            .text = "xx".into();
        assert_eq!(
            agent_forms::answer(&esc_form, &esc_state.agent.as_ref().unwrap().drafts).unwrap()["val"],
            json!("xx"),
            "escaped capture name \\u0061 must resolve to `a` and match `xx`"
        );

        // 4. Native validation rejection with dotted key `code.` attributes strictly to `code.`
        // without stripping punctuation onto `code`, and an unrecognized message stays form-level.
        let dotted_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r26-dot".into(),
            title: "Dotted keys".into(),
            fields: vec![
                json!({
                    "key": "code",
                    "title": "Code",
                    "type": "string",
                    "required": true,
                    "pattern": "^a{257}$"
                }),
                json!({
                    "key": "code.",
                    "title": "Code Dot",
                    "type": "string",
                    "required": true,
                    "pattern": "^a{257}$"
                }),
            ],
        };
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (results_tx, results) = codenomad_client::bounded(4);
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
        ui.selected = dotted_form.id.clone();
        ui.forms.push(dotted_form.clone());
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        ui.drafts
            .get_mut(&("form-r26-dot".into(), "code".into()))
            .unwrap()
            .editor()
            .text = "a".repeat(257);
        ui.drafts
            .get_mut(&("form-r26-dot".into(), "code.".into()))
            .unwrap()
            .editor()
            .text = "b".into();
        let mut dot_state = crate::init();
        dot_state.phase = crate::Phase::Ready;
        dot_state.agent = Some(ui);
        let mut dot_rt = Runtime::new(dot_state, render_form, (420.0, 720.0), Env::new(false, 1.0));
        dot_rt.frame(0.0);
        dot_rt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r26-dot"));
        let gen1 = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, g)) => g,
            _ => panic!("expected PendingJob::Act"),
        };
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "{\"error\":\"Form field does not match pattern: code.\"}".into(),
                )),
                Some(vec![dotted_form.clone()]),
                gen1,
            ))
            .unwrap();
        dot_rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        dot_rt.frame(1.0 / 60.0);
        let dot_tree = dot_rt.accessibility_json();
        assert!(
            find_node(&dot_tree, &agent_forms::field_error_key("code.")).is_some(),
            "exact dotted key `code.` must receive the field rejection"
        );
        assert!(
            find_node(&dot_tree, &agent_forms::field_error_key("code")).is_none(),
            "valid sibling `code` must not be matched by stripping trailing punctuation"
        );
        // Correcting `code.` immediately re-enables Answer.
        dot_rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r26-dot".into(), "code.".into()))
                .unwrap()
                .editor()
                .text = "a".repeat(257);
        });
        dot_rt.frame(1.0 / 60.0);
        assert!(
            !has_state(
                find_node(&dot_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "correcting `code.` must re-enable Answer"
        );

        // 5. Validation rejection followed by a 503 form-list refresh leaves the draft editable
        // while Answer and Cancel remain gated on fresh request authority.
        dot_rt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r26-dot"));
        let gen2 = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, g)) => g,
            _ => panic!("expected second PendingJob::Act"),
        };
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "{\"error\":\"Form validation failed\"}".into(),
                )),
                None,
                gen2,
            ))
            .unwrap();
        dot_rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        dot_rt.frame(1.0 / 60.0);
        let recon_tree = dot_rt.accessibility_json();
        assert!(
            has_state(
                find_node(&recon_tree, "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must stay disabled while reconciling after a 503 refresh"
        );
        assert!(
            has_state(
                find_node(&recon_tree, "cancel-question").unwrap(),
                "disabled"
            ),
            "Cancel must stay disabled while reconciling after a 503 refresh"
        );
        assert!(
            !has_state(find_input(&recon_tree, "field-code"), "disabled"),
            "draft field must remain editable after the reply POST finishes even when refresh returned 503"
        );
        dot_rt.update(|s, _| {
            let scope = s.input_scope.clone();
            let edit = s.editor(
                &scope,
                crate::screen::Editor::Form(("form-r26-dot".into(), "code".into())),
            );
            edit.text = "edited-while-reconciling".into();
        });
        assert_eq!(
            dot_rt.state.agent.as_ref().unwrap().drafts[&("form-r26-dot".into(), "code".into())]
                .edit
                .text,
            "edited-while-reconciling",
            "screen editor callback must accept draft edits while awaiting refresh reconciliation"
        );

        // 6. Historical LMT offset with seconds (`Europe/Paris` 1900 `+00:09:21`) preserves exact
        // seconds on desktop, matching Chromium's `1900-01-01T11:50:39.000Z`.
        let paris_1900_clock = |utc_secs: i64| -> Option<(i32, i32, i32, i32, i32, i32)> {
            let local = utc_secs + 9 * 60 + 21;
            let days = local.div_euclid(86_400);
            let sod = local.rem_euclid(86_400);
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = mp + if mp < 10 { 3 } else { -9 };
            let y = y + i64::from(m <= 2);
            Some((
                y as i32,
                m as i32,
                d as i32,
                (sod / 3600) as i32,
                ((sod % 3600) / 60) as i32,
                (sod % 60) as i32,
            ))
        };
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "1900-01-01T12:00",
                paris_1900_clock
            )
            .as_deref(),
            Some("1900-01-01T11:50:39.000Z"),
            "native local clock conversion must preserve historical offset seconds"
        );

        // 7. Refreshing a pending multiselect form with an oversized comma-only paste bypasses
        // custom parsing without unbounded allocations and retains the draft text for trimming.
        let big_commas = ",".repeat(250_000);
        let mut big_drafts = std::collections::HashMap::new();
        agent_forms::seed(&[dup_form.clone()], &mut big_drafts);
        big_drafts
            .get_mut(&("form-r26-dup".into(), "targets".into()))
            .unwrap()
            .custom_editor()
            .text = big_commas.clone();
        agent_forms::seed(&[dup_form.clone()], &mut big_drafts);
        assert_eq!(
            big_drafts[&("form-r26-dup".into(), "targets".into())]
                .custom
                .text
                .len(),
            250_000,
            "refresh reconciliation must retain oversized custom text without clearing or allocating unbounded entries"
        );
        assert_eq!(
            agent_forms::evaluate_form(&dup_form, &big_drafts).active[0].1,
            Err(agent_forms::ValidationError::TooLong { max: 20_000 }),
            "oversized custom draft must remain flagged TooLong(20_000) after refresh"
        );
    });
}

#[test]
fn preserved_65_item_multiselect_defaults_committed_custom_before_checkbox_interleaved_form_created_rejection_flagless_k_escape_and_gmt_colon_date_time()
 {
    crate::strings::with_locale("en", || {
        // 1. A 65-item multiselect default (`keep` + 64 copies of `drop`) preserves both checkboxes
        // checked and never silently discards defaults when `add` is toggled; unchecking `drop`
        // recovers cleanly to `["keep", "add"]`. Truly unrepresentable overflow (>64 runs) stays
        // guarded until explicit Clear.
        let mut defaults_65 = vec![json!("keep")];
        defaults_65.extend(std::iter::repeat_n(json!("drop"), 64));
        let multi65_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-multi65".into(),
            title: "Defaults".into(),
            fields: vec![json!({
                "key": "picks",
                "title": "Picks",
                "type": "multiselect",
                "maxItems": 100,
                "options": [
                    {"value": "keep", "label": "Keep"},
                    {"value": "drop", "label": "Drop"},
                    {"value": "add", "label": "Add"}
                ],
                "default": defaults_65
            })],
        };
        let (mut m65_state, _m65rx) = state_with_form(multi65_form.clone());
        {
            let d = &m65_state.agent.as_ref().unwrap().drafts
                [&("form-r27-multi65".into(), "picks".into())];
            assert!(d.selected.contains("keep"), "`keep` must be loaded checked");
            assert!(d.selected.contains("drop"), "`drop` must be loaded checked");
            assert!(!d.selected.contains("add"));
        }
        m65_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r27-multi65".into(), "picks".into()))
            .unwrap()
            .toggle("add");
        assert_eq!(
            agent_forms::evaluate_form(&multi65_form, &m65_state.agent.as_ref().unwrap().drafts)
                .active[0]
                .1,
            Err(agent_forms::ValidationError::TooManyItems { max: 32 }),
            "checking `add` must keep the 65 defaults counted instead of silently submitting [\"add\"]"
        );
        m65_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r27-multi65".into(), "picks".into()))
            .unwrap()
            .toggle("drop");
        assert_eq!(
            agent_forms::answer(&multi65_form, &m65_state.agent.as_ref().unwrap().drafts).unwrap()
                ["picks"],
            json!(["keep", "add"]),
            "unchecking `drop` removes all 64 copies and leaves [\"keep\", \"add\"]"
        );
        // Truly unrepresentable overflow (>64 distinct runs) cannot be bypassed by toggle without Clear.
        let mut alt_70 = Vec::with_capacity(70);
        for i in 0..70 {
            alt_70.push(json!(if i % 2 == 0 { "keep" } else { "drop" }));
        }
        let overflow_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-ovf".into(),
            title: "Overflow".into(),
            fields: vec![json!({
                "key": "picks",
                "title": "Picks",
                "type": "multiselect",
                "maxItems": 100,
                "options": [
                    {"value": "keep", "label": "Keep"},
                    {"value": "drop", "label": "Drop"},
                    {"value": "add", "label": "Add"}
                ],
                "default": alt_70
            })],
        };
        let (ovf_state, _ovfrx) = state_with_form(overflow_form.clone());
        let mut ovf_rt = Runtime::new(ovf_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        ovf_rt.frame(0.0);
        let ovf_tree = ovf_rt.accessibility_json();
        assert!(
            find_node(&ovf_tree, &agent_forms::clear_option_key("picks")).is_some(),
            "unrepresentable overflow default must expose an explicit Clear control"
        );
        ovf_rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r27-ovf".into(), "picks".into()))
                .unwrap()
                .toggle("add");
        });
        assert!(
            agent_forms::answer(&overflow_form, &ovf_rt.state.agent.as_ref().unwrap().drafts)
                .is_err(),
            "toggle alone must not silently discard an unrepresentable overflow default"
        );
        ovf_rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r27-ovf".into(), "picks".into()))
                .unwrap()
                .clear_multiselect();
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r27-ovf".into(), "picks".into()))
                .unwrap()
                .toggle("add");
        });
        assert_eq!(
            agent_forms::answer(&overflow_form, &ovf_rt.state.agent.as_ref().unwrap().drafts)
                .unwrap()["picks"],
            json!(["add"]),
            "explicit Clear must unlock selection cleanly"
        );

        // 2. Typing `qa` in custom multiselect, blurring to commit it, then checking `prod` sends
        // `["qa", "prod"]` (matching Solid), not `["prod", "qa"]`.
        let order_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-order".into(),
            title: "Order".into(),
            fields: vec![json!({
                "key": "targets",
                "title": "Targets",
                "type": "multiselect",
                "custom": true,
                "options": [{"value": "prod", "label": "Production"}]
            })],
        };
        let (mut ord_state, _ordrx) = state_with_form(order_form.clone());
        ord_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r27-order".into(), "targets".into()))
            .unwrap()
            .custom_editor()
            .text = "qa".into();
        let mut ord_rt = Runtime::new(ord_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        ord_rt.frame(0.0);
        // Focus then Tab-blur custom editor, then check `prod`.
        ord_rt.update(|s, _| {
            let scope = s.input_scope.clone();
            let _ = s.editor(
                &scope,
                crate::screen::Editor::Custom(("form-r27-order".into(), "targets".into())),
            );
            s.agent.as_mut().unwrap().reconcile_custom_focus();
            s.agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r27-order".into(), "targets".into()))
                .unwrap()
                .toggle("prod");
        });
        assert_eq!(
            agent_forms::answer(&order_form, &ord_rt.state.agent.as_ref().unwrap().drafts).unwrap()
                ["targets"],
            json!(["qa", "prod"]),
            "checkbox toggled after committed custom entry must append after `qa`"
        );

        // 3. Interleaved `form.created` while a deferred reply POST is in flight must not erase
        // the server's 400 field rejection once the trailing read confirms the form is unchanged.
        let def_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-def1".into(),
            title: "Deferred".into(),
            fields: vec![json!({
                "key": "code",
                "title": "Code",
                "type": "string",
                "required": true,
                "pattern": "^x{257}$"
            })],
        };
        let other_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-def2".into(),
            title: "Other".into(),
            fields: vec![json!({
                "key": "note",
                "title": "Note",
                "type": "string"
            })],
        };
        let (jobs, _) = codenomad_client::bounded(1);
        let (stop, _) = codenomad_client::bounded(1);
        let (results_tx, results) = codenomad_client::bounded(4);
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
        ui.selected = def_form.id.clone();
        ui.forms.push(def_form.clone());
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        ui.drafts
            .get_mut(&("form-r27-def1".into(), "code".into()))
            .unwrap()
            .editor()
            .text = "x".into();
        let mut race_state = crate::init();
        race_state.phase = crate::Phase::Ready;
        race_state.agent = Some(ui);
        let mut race_rt = Runtime::new(
            race_state,
            render_form,
            (420.0, 620.0),
            Env::new(false, 1.0),
        );
        race_rt.frame(0.0);
        race_rt.update(|s, _| s.agent.as_mut().unwrap().answer_form("form-r27-def1"));
        let act_gen = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Act(_, g)) => g,
            _ => panic!("expected PendingJob::Act"),
        };
        // Interleave `form.created` for another form before ActForm completes.
        race_rt.update(|s, _| {
            s.agent
                .as_mut()
                .unwrap()
                .notice_request(true, "form-r27-def2".into());
        });
        // Deliver the 400 validation rejection for the now-stale generation `act_gen`.
        results_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "{\"error\":\"Form field does not match pattern: code\"}".into(),
                )),
                Some(vec![def_form.clone()]),
                act_gen,
            ))
            .unwrap();
        race_rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        // Drain the scheduled trailing read and confirm both forms (original unchanged).
        let read_gen = match forms_rx.try_recv() {
            Ok(crate::agent::PendingJob::Read(g)) => g,
            _ => panic!("expected trailing PendingJob::Read"),
        };
        results_tx
            .try_send(crate::agent::Result::Forms(
                Some(vec![def_form.clone(), other_form]),
                read_gen,
            ))
            .unwrap();
        race_rt.update(|s, _| {
            s.agent.as_mut().unwrap().poll();
        });
        race_rt.frame(1.0 / 60.0);
        let race_tree = race_rt.accessibility_json();
        assert!(
            find_node(&race_tree, &agent_forms::field_error_key("code")).is_some(),
            "confirmed field rejection must survive an interleaved form.created refresh"
        );
        assert!(
            has_state(
                find_node(&race_tree, "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must stay disabled for the rejected `x` value after trailing read confirms unchanged form"
        );

        // 4. Flagless JS `\k<id>` with no named capture groups defers to OpenCode instead of
        // marking the form unsupported, while invalid named backref with a named group still fails.
        let k_escape_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-kesc".into(),
            title: "Identity k".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^\\k<id>$"
            })],
        };
        assert!(
            agent_forms::supported(&k_escape_form),
            "flagless `^\\k<id>$` without named captures must not be marked unsupported"
        );
        let (mut k_state, _krx) = state_with_form(k_escape_form.clone());
        k_state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r27-kesc".into(), "val".into()))
            .unwrap()
            .editor()
            .text = "k<id>".into();
        assert_eq!(
            agent_forms::answer(&k_escape_form, &k_state.agent.as_ref().unwrap().drafts).unwrap()["val"],
            json!("k<id>"),
            "flagless `^\\k<id>$` must allow submitting `k<id>`"
        );
        let bad_named_ref = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-badk".into(),
            title: "Bad named ref".into(),
            fields: vec![json!({
                "key": "val",
                "title": "Val",
                "type": "string",
                "required": true,
                "pattern": "^(?<a>x)\\k<b>$"
            })],
        };
        assert!(
            !agent_forms::supported(&bad_named_ref),
            "unresolved `\\k<b>` with a named capture group must remain invalid syntax"
        );

        // 5. Required hidden `date-time` default `Thu Jan 01 1970 01:00:00 GMT+0100 (GMT+01:00)`
        // (and localized/unclassified JS Date strings) passes instead of disabling Answer.
        let gmt_colon_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r27-gmt-colon".into(),
            title: "GMT colon".into(),
            fields: vec![
                json!({
                    "key": "when",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "Thu Jan 01 1970 01:00:00 GMT+0100 (GMT+01:00)"
                }),
                json!({
                    "key": "local_tz",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "Thu Jan 01 1970 01:00:00 GMT+0100 (heure normale d’Europe centrale)"
                }),
                json!({
                    "key": "exotic",
                    "type": "string",
                    "format": "date-time",
                    "hidden": true,
                    "required": true,
                    "default": "Jan 1970"
                }),
            ],
        };
        let (gmt_state, _gmtrx) = state_with_form(gmt_colon_form.clone());
        let mut gmt_rt = Runtime::new(gmt_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        gmt_rt.frame(0.0);
        assert!(
            !has_state(
                find_node(&gmt_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "JS-valid date-time defaults including `(GMT+01:00)` must enable Answer"
        );
        let gmt_ans = agent_forms::answer(
            &gmt_colon_form,
            &gmt_rt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("JS-valid hidden date-time defaults must submit verbatim");
        assert_eq!(
            gmt_ans["when"],
            json!("Thu Jan 01 1970 01:00:00 GMT+0100 (GMT+01:00)")
        );
        assert_eq!(
            gmt_ans["local_tz"],
            json!("Thu Jan 01 1970 01:00:00 GMT+0100 (heure normale d’Europe centrale)")
        );
        assert_eq!(gmt_ans["exotic"], json!("Jan 1970"));
    });
}

#[test]
fn round28_utf8_date_empty_opts_deferred_clear_icase_async_reject_bounded_provenance() {
    crate::strings::with_locale("en", || {
        // 1. Arbitrary UTF-8 / emoji strings in `date-time` and `date` fields must never panic.
        let dt_field = json!({
            "key": "when",
            "title": "When",
            "type": "string",
            "format": "date-time",
            "required": true
        });
        let date_field = json!({
            "key": "day",
            "title": "Day",
            "type": "string",
            "format": "date",
            "required": true
        });
        for bad in [
            "a🦀1",
            "+🦀123456",
            "-🦀123456",
            "2026-01-01 🦀x",
            "2026-01-01 +🦀",
            "2026-01-01 12:00 🦀",
            "🦀-12-34",
            "éé-12-34",
        ] {
            let mut d = agent_forms::Draft::default();
            d.edit = rune::edit::TextEdit::new(bad);
            assert_eq!(
                agent_forms::validate(&dt_field, &d),
                Err(agent_forms::ValidationError::InvalidFormat),
                "UTF-8 input `{bad}` must cleanly fail date-time validation without panicking"
            );
            assert_eq!(
                agent_forms::validate(&date_field, &d),
                Err(agent_forms::ValidationError::InvalidFormat),
                "UTF-8 input `{bad}` must cleanly fail date validation without panicking"
            );
        }

        // 2. Empty `options: []` with `format: "date-time"` and `custom: true` normalizes edited
        // local date-times to UTC like Solid's datetime-local fallback, while declared choices stay verbatim.
        let empty_opts_dt = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r28-empty-opts-dt".into(),
            title: "Empty opts date-time".into(),
            fields: vec![
                json!({
                    "key": "when_empty_opts",
                    "title": "When",
                    "type": "string",
                    "format": "date-time",
                    "options": [],
                    "custom": true,
                    "required": true
                }),
                json!({
                    "key": "when_free",
                    "title": "When Free",
                    "type": "string",
                    "format": "date-time",
                    "required": true
                }),
                json!({
                    "key": "when_declared",
                    "title": "When Declared",
                    "type": "string",
                    "format": "date-time",
                    "options": [{ "value": "2026-11-26T14:30", "label": "Afternoon" }],
                    "custom": true,
                    "required": true
                }),
            ],
        };
        let (mut dt_state, _dtrx) = state_with_form(empty_opts_dt.clone());
        {
            let drafts = &mut dt_state.agent.as_mut().unwrap().drafts;
            drafts
                .get_mut(&("form-r28-empty-opts-dt".into(), "when_empty_opts".into()))
                .unwrap()
                .custom
                .text = "2026-11-26T14:30".into();
            drafts
                .get_mut(&("form-r28-empty-opts-dt".into(), "when_free".into()))
                .unwrap()
                .edit
                .text = "2026-11-26T14:30".into();
            drafts
                .get_mut(&("form-r28-empty-opts-dt".into(), "when_declared".into()))
                .unwrap()
                .choose_option("2026-11-26T14:30");
        }
        let dt_ans = agent_forms::answer(&empty_opts_dt, &dt_state.agent.as_ref().unwrap().drafts)
            .expect("empty-options custom date-time must normalize cleanly");
        let expected_utc = dt_ans["when_free"].as_str().unwrap();
        assert!(
            expected_utc.ends_with('Z'),
            "edited local date-time must normalize to UTC: {expected_utc}"
        );
        assert_eq!(
            dt_ans["when_empty_opts"],
            json!(expected_utc),
            "empty `options: []` + `custom: true` must normalize edited local date-time identically to free-text"
        );
        assert_eq!(
            dt_ans["when_declared"],
            json!("2026-11-26T14:30"),
            "declared choice values must remain verbatim"
        );

        // 3. Clearing an optional field with a deferred regex (`^[a-z]{257}$`) omits the field
        // instead of submitting `""` and locking the form.
        let deferred_opt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r28-deferred-opt".into(),
            title: "Deferred optional".into(),
            fields: vec![
                json!({
                    "key": "name",
                    "title": "Name",
                    "type": "string",
                    "required": true
                }),
                json!({
                    "key": "long_code",
                    "title": "Long code",
                    "type": "string",
                    "required": false,
                    "pattern": "^[a-z]{257}$"
                }),
            ],
        };
        let (mut opt_state, _optrx) = state_with_form(deferred_opt_form.clone());
        {
            let drafts = &mut opt_state.agent.as_mut().unwrap().drafts;
            drafts
                .get_mut(&("form-r28-deferred-opt".into(), "name".into()))
                .unwrap()
                .edit
                .text = "Alice".into();
            let opt_draft = drafts
                .get_mut(&("form-r28-deferred-opt".into(), "long_code".into()))
                .unwrap();
            opt_draft.edit.text = "x".into();
            assert!(opt_draft.is_dirty());
            opt_draft.edit.text.clear();
            assert!(opt_draft.is_dirty());
        }
        let mut opt_rt = Runtime::new(opt_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        opt_rt.frame(0.0);
        assert!(
            !has_state(
                find_node(&opt_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "clearing a dirty optional field with a deferred regex must keep Answer enabled"
        );
        let opt_ans = agent_forms::answer(
            &deferred_opt_form,
            &opt_rt.state.agent.as_ref().unwrap().drafts,
        )
        .expect("cleared optional deferred-regex field must omit cleanly");
        assert_eq!(opt_ans, json!({ "name": "Alice" }));

        // 4. ECMAScript flagless case-insensitive regex matching (`Σ`/`σ`/`ς`, `ſ` isolation, ranges).
        let sigma_field = json!({
            "key": "greek",
            "title": "Greek",
            "type": "string",
            "required": true,
            "pattern": "(?i:^Σ$)"
        });
        for valid in ["Σ", "σ", "ς"] {
            let mut d = agent_forms::Draft::default();
            d.edit = rune::edit::TextEdit::new(valid);
            assert_eq!(
                agent_forms::validate(&sigma_field, &d),
                Ok(Some(json!(valid))),
                "`(?i:^Σ$)` must match `{valid}`"
            );
        }
        let mut bad_greek = agent_forms::Draft::default();
        bad_greek.edit = rune::edit::TextEdit::new("α");
        assert_eq!(
            agent_forms::validate(&sigma_field, &bad_greek),
            Err(agent_forms::ValidationError::InvalidFormat)
        );
        let ascii_s_field = json!({
            "key": "letter",
            "title": "Letter",
            "type": "string",
            "required": true,
            "pattern": "(?i:^s$)"
        });
        let mut long_s = agent_forms::Draft::default();
        long_s.edit = rune::edit::TextEdit::new("\u{017F}");
        assert_eq!(
            agent_forms::validate(&ascii_s_field, &long_s),
            Err(agent_forms::ValidationError::InvalidFormat),
            "flagless ECMAScript `(?i:^s$)` must not fold non-ASCII U+017F into ASCII `s`"
        );
        let greek_range_field = json!({
            "key": "range",
            "title": "Range",
            "type": "string",
            "required": true,
            "pattern": "(?i:^[Α-Ω]$)"
        });
        let mut final_sigma = agent_forms::Draft::default();
        final_sigma.edit = rune::edit::TextEdit::new("ς");
        assert_eq!(
            agent_forms::validate(&greek_range_field, &final_sigma),
            Ok(Some(json!("ς"))),
            "`(?i:^[Α-Ω]$)` must match final sigma `ς`"
        );
        let large_non_ascii_range = json!({
            "key": "wide",
            "title": "Wide",
            "type": "string",
            "required": true,
            "pattern": "(?i:^[\\u0100-\\u03FF]$)"
        });
        let mut wide_d = agent_forms::Draft::default();
        wide_d.edit = rune::edit::TextEdit::new("ς");
        assert_eq!(
            agent_forms::validate(&large_non_ascii_range, &wide_d),
            Ok(Some(json!("ς"))),
            "large non-ASCII case-insensitive range must defer rather than reject"
        );

        // 5. Rejected form POST unlocks draft editing immediately on `ActFormOutcome` before a slow
        // follow-up `GET` finishes (`ActFormSnapshot`), while Answer/Cancel stay disabled until snapshot.
        let reject_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r28-async-reject".into(),
            title: "Async reject".into(),
            fields: vec![json!({
                "key": "code",
                "title": "Code",
                "type": "string",
                "required": true,
                "pattern": "^[a-z]{257}$"
            })],
        };
        let (jobs_tx, _jobs_rx) = codenomad_client::bounded(1);
        let (perms_tx, _perms_rx) = codenomad_client::bounded(1);
        let (forms_tx, forms_rx) = codenomad_client::bounded(1);
        let (catalog_tx, _catalog_rx) = codenomad_client::bounded(1);
        let (stop_tx, _stop_rx) = codenomad_client::bounded(1);
        let (out_tx, res_rx) = codenomad_client::bounded(16);
        let mut agent = crate::agent::Ui::new(crate::agent::Handle {
            connection: None,
            workspace_id: None,
            jobs: jobs_tx,
            permissions: perms_tx,
            forms: forms_tx,
            catalog: catalog_tx,
            stop: stop_tx,
            results: res_rx,
        });
        let _ = forms_rx.try_recv();
        agent.fixture_ready();
        agent.forms_lane.reading = false;
        agent.forms = vec![reject_form.clone()];
        agent.selected = reject_form.id.clone();
        agent_forms::seed(&agent.forms, &mut agent.drafts);
        agent.mark_pending_known();
        agent
            .drafts
            .get_mut(&("form-r28-async-reject".into(), "code".into()))
            .unwrap()
            .edit
            .text = "bad".into();
        agent.answer_form("form-r28-async-reject");
        let sent_gen = match forms_rx.try_recv().expect("act job queued") {
            crate::agent::PendingJob::Act(_, g) => g,
            _ => panic!("expected PendingJob::Act"),
        };
        assert!(agent.forms_mutating());
        assert!(agent.forms_locked());
        // POST fails immediately with 400; follow-up GET is still in flight.
        out_tx
            .try_send(crate::agent::Result::ActFormOutcome(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "Form field does not match pattern: code".into(),
                )),
                sent_gen,
            ))
            .unwrap();
        assert!(agent.poll());
        assert!(
            !agent.forms_mutating(),
            "draft editing must unlock immediately when the rejected POST returns"
        );
        assert!(
            agent.forms_locked(),
            "Answer/Cancel must stay locked until the follow-up forms snapshot arrives"
        );
        assert!(agent.error);
        let rejected_draft = agent
            .drafts
            .get(&("form-r28-async-reject".into(), "code".into()))
            .unwrap();
        assert_eq!(
            rejected_draft.server_rejected_value,
            Some(json!("bad")),
            "field rejection must appear immediately before the follow-up GET finishes"
        );
        // User edits the field while the slow follow-up GET is still pending.
        let fixed_value = "b".repeat(257);
        agent
            .drafts
            .get_mut(&("form-r28-async-reject".into(), "code".into()))
            .unwrap()
            .edit
            .text = fixed_value.clone();
        // Follow-up GET finally arrives.
        out_tx
            .try_send(crate::agent::Result::ActFormSnapshot(
                Some(vec![reject_form.clone()]),
                sent_gen,
            ))
            .unwrap();
        assert!(agent.poll());
        assert!(!agent.forms_mutating());
        assert!(!agent.forms_locked());
        assert_eq!(
            agent
                .drafts
                .get(&("form-r28-async-reject".into(), "code".into()))
                .unwrap()
                .edit
                .text,
            fixed_value,
            "user edits made while waiting for follow-up GET must be preserved"
        );
        assert_eq!(
            agent_forms::answer(&reject_form, &agent.drafts).unwrap()["code"],
            json!(fixed_value)
        );

        // 6. Provenance sets and option description reveals stay strictly bounded across 1,000
        // refreshes of 64 x 4 KiB distinct options and fail closed on kind change once exhausted.
        let mut drafts = agent_forms::Drafts::new();
        let pad = "x".repeat(4080);
        for round in 0..1_000usize {
            let options: Vec<serde_json::Value> = (0..64usize)
                .map(|idx| {
                    let v = format!("r{round:04}-o{idx:02}-{pad}");
                    json!({ "value": v, "label": format!("Option {idx}"), "description": "desc" })
                })
                .collect();
            let form = Form {
                tool: None,
                infer_websearch: false,
                id: "form-r28-bounded".into(),
                title: "Bounded".into(),
                fields: vec![json!({
                    "key": "choice",
                    "title": "Choice",
                    "type": "string",
                    "options": options
                })],
            };
            agent_forms::seed(&[form], &mut drafts);
            let d = drafts
                .get_mut(&("form-r28-bounded".into(), "choice".into()))
                .unwrap();
            let reveal_key = format!("r{round:04}-o00-{pad}");
            d.reveal_option_description(&reveal_key);
            assert!(
                d.prior_choice_values.total_bytes() <= 64 * 1024,
                "prior_choice_values bytes must never exceed 64 KiB"
            );
            assert!(
                d.option_desc_reveals.len() <= 64,
                "option_desc_reveals must stay bounded to current options"
            );
        }
        let d_after = drafts
            .get(&("form-r28-bounded".into(), "choice".into()))
            .unwrap();
        assert!(d_after.prior_choice_values.is_exhausted());
        assert_eq!(d_after.prior_choice_values.len(), 0);
        assert_eq!(d_after.prior_choice_values.total_bytes(), 0);
        // Transition to StringFree: exhausted provenance fails closed and strips leaked default.
        let transitioned = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r28-bounded".into(),
            title: "Bounded".into(),
            fields: vec![json!({
                "key": "choice",
                "title": "Choice",
                "type": "string",
                "default": format!("r0000-o00-{pad}")
            })],
        };
        agent_forms::seed(&[transitioned], &mut drafts);
        let d_free = drafts
            .get(&("form-r28-bounded".into(), "choice".into()))
            .unwrap();
        assert!(
            d_free.edit.text.is_empty(),
            "exhausted provenance must fail closed and strip defaults across kind transition"
        );
    });
}

#[test]
fn round29_clock_fallback_bounded_paste_external_nullable_deferred_stale_reject_dup_named() {
    crate::strings::with_locale("en", || {
        // 1. Failing native clock lookup must return None without stack overflow.
        #[cfg(not(target_arch = "wasm32"))]
        assert_eq!(
            crate::agent::string_constraints::normalize_local_date_time_with_clock(
                "2026-01-15T12:00",
                |_| None,
            ),
            None,
            "failed clock lookup must not recurse indefinitely"
        );

        // 2. Oversized paste and IME commits are clamped at the input boundary (retaining
        // TooLong > 20_000 while keeping text, undo history, and layout bounded).
        let paste_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r29-paste".into(),
            title: "Paste bound".into(),
            fields: vec![json!({
                "key": "note",
                "title": "Note",
                "type": "string",
                "required": true
            })],
        };
        let (paste_state, _prx) = state_with_form(paste_form.clone());
        let mut paste_rt = Runtime::new(
            paste_state,
            render_form,
            (420.0, 620.0),
            Env::new(false, 1.0),
        );
        paste_rt.frame(0.0);
        let input_path = find_node(&paste_rt.accessibility_json(), "field-note")
            .and_then(|n| n["children"].as_array())
            .and_then(|kids| kids.first())
            .and_then(|n| n["id"].as_str())
            .map(str::to_string);
        let _ = input_path;
        let (ix, iy) = paste_rt.find("field-note").unwrap();
        paste_rt.pointer_down(ix, iy);
        paste_rt.pointer_up(ix, iy);
        paste_rt.frame(0.0);
        paste_rt.paste("a".repeat(2_000_000));
        paste_rt.frame(0.0);
        let after_paste_units = paste_rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r29-paste".into(), "note".into()))
            .unwrap()
            .edit
            .text
            .encode_utf16()
            .count();
        assert_eq!(
            after_paste_units,
            rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "oversized paste must clamp at MAX_FORM_EDITOR_UTF16"
        );
        assert!(
            has_state(
                find_node(&paste_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "clamped oversized paste (>20_000) must still fail validation and disable Answer"
        );
        paste_rt.ime(rune::Ime::Commit("b".repeat(50_000)));
        paste_rt.frame(0.0);
        let after_ime_units = paste_rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r29-paste".into(), "note".into()))
            .unwrap()
            .edit
            .text
            .encode_utf16()
            .count();
        assert!(
            after_ime_units <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "oversized IME commit must clamp at MAX_FORM_EDITOR_UTF16"
        );
        paste_rt
            .state
            .agent
            .as_mut()
            .unwrap()
            .drafts
            .get_mut(&("form-r29-paste".into(), "note".into()))
            .unwrap()
            .edit
            .undo();
        let after_undo_units = paste_rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r29-paste".into(), "note".into()))
            .unwrap()
            .edit
            .text
            .encode_utf16()
            .count();
        assert!(
            after_undo_units <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "undo history must never retain unbounded pasted/committed text"
        );

        // 3. Valid `type: "external"` field exposes safe HTTP(S) link and explicit acknowledgement
        // checkbox producing `{"setup": true}`, rejects unsafe schemes, and resets on URL change.
        let ext_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r29-ext".into(),
            title: "External setup".into(),
            fields: vec![json!({
                "key": "setup",
                "title": "External setup",
                "type": "external",
                "url": "https://example.com/setup"
            })],
        };
        assert!(agent_forms::supported(&ext_form));
        let (ext_state, _erx) = state_with_form(ext_form.clone());
        let mut ext_rt = Runtime::new(ext_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        ext_rt.frame(0.0);
        assert!(
            has_state(
                find_node(&ext_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "unacknowledged external field must disable Answer"
        );
        let link_key = agent_forms::external_link_key("setup");
        let ack_key = agent_forms::external_ack_key("setup");
        let (lx, ly) = ext_rt
            .find(&link_key)
            .expect("external link button rendered");
        ext_rt.pointer_down(lx, ly);
        ext_rt.pointer_up(lx, ly);
        ext_rt.frame(0.0);
        assert_eq!(
            ext_rt.take_url_requests(),
            vec!["https://example.com/setup".to_string()],
            "clicking external link button must open validated HTTPS URL"
        );
        assert!(
            has_state(
                find_node(&ext_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "opening link alone must not silently acknowledge external field"
        );
        let (ax, ay) = ext_rt
            .find(&ack_key)
            .expect("external acknowledgement checkbox rendered");
        ext_rt.pointer_down(ax, ay);
        ext_rt.pointer_up(ax, ay);
        ext_rt.frame(0.0);
        assert!(
            !has_state(
                find_node(&ext_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "checking explicit external acknowledgement must enable Answer"
        );
        assert_eq!(
            agent_forms::answer(&ext_form, &ext_rt.state.agent.as_ref().unwrap().drafts).unwrap(),
            json!({ "setup": true })
        );
        // Changing URL on refresh resets acknowledgement.
        let ext_form_v2 = Form {
            fields: vec![json!({
                "key": "setup",
                "title": "External setup",
                "type": "external",
                "url": "https://example.com/step-2"
            })],
            ..ext_form.clone()
        };
        agent_forms::seed(
            &[ext_form_v2.clone()],
            &mut ext_rt.state.agent.as_mut().unwrap().drafts,
        );
        assert!(
            agent_forms::answer(&ext_form_v2, &ext_rt.state.agent.as_ref().unwrap().drafts)
                .is_err(),
            "URL change on refresh must reset external acknowledgement"
        );

        // 4. Explicitly cleared optional string with nullable deferred pattern `^(?:a{257})?$`
        // retains `""` and keeps conditional `when: eq ""` siblings active, while untouched omits it.
        let nullable_def_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r29-null-def".into(),
            title: "Nullable deferred".into(),
            fields: vec![
                json!({
                    "key": "opt",
                    "title": "Optional",
                    "type": "string",
                    "required": false,
                    "pattern": "^(?:a{257})?$"
                }),
                json!({
                    "key": "extra",
                    "title": "Extra",
                    "type": "string",
                    "required": false,
                    "default": "shown",
                    "when": [{ "key": "opt", "op": "eq", "value": "" }]
                }),
            ],
        };
        let (mut nd_state, _ndrx) = state_with_form(nullable_def_form.clone());
        assert_eq!(
            agent_forms::answer(&nullable_def_form, &nd_state.agent.as_ref().unwrap().drafts)
                .unwrap(),
            json!({}),
            "untouched optional field must stay omitted and keep eq \"\" sibling hidden"
        );
        {
            let opt_d = nd_state
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r29-null-def".into(), "opt".into()))
                .unwrap();
            opt_d.edit.text = "x".into();
            assert!(opt_d.is_dirty());
            opt_d.edit.text.clear();
        }
        assert_eq!(
            agent_forms::answer(&nullable_def_form, &nd_state.agent.as_ref().unwrap().drafts)
                .unwrap(),
            json!({ "opt": "", "extra": "shown" }),
            "explicitly cleared optional string with nullable deferred regex must retain \"\" and activate eq \"\" sibling"
        );

        // 5. Server rejection marker is bound to the submitted field schema and invalidated when
        // a later snapshot replaces the field's pattern on the same form ID.
        let schema_v1 = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r29-schema".into(),
            title: "Schema update".into(),
            fields: vec![json!({
                "key": "code",
                "title": "Code",
                "type": "string",
                "required": true,
                "pattern": "^a{257}$"
            })],
        };
        let schema_v2 = Form {
            fields: vec![json!({
                "key": "code",
                "title": "Code",
                "type": "string",
                "required": true,
                "pattern": "^(?:a{257}|ok)$"
            })],
            ..schema_v1.clone()
        };
        let (jobs_tx, _jobs_rx) = codenomad_client::bounded(1);
        let (perms_tx, _perms_rx) = codenomad_client::bounded(1);
        let (forms_tx, forms_rx) = codenomad_client::bounded(1);
        let (catalog_tx, _catalog_rx) = codenomad_client::bounded(1);
        let (stop_tx, _stop_rx) = codenomad_client::bounded(1);
        let (out_tx, res_rx) = codenomad_client::bounded(16);
        let mut agent = crate::agent::Ui::new(crate::agent::Handle {
            connection: None,
            workspace_id: None,
            jobs: jobs_tx,
            permissions: perms_tx,
            forms: forms_tx,
            catalog: catalog_tx,
            stop: stop_tx,
            results: res_rx,
        });
        let _ = forms_rx.try_recv();
        agent.fixture_ready();
        agent.forms_lane.reading = false;
        agent.forms = vec![schema_v1.clone()];
        agent.selected = schema_v1.id.clone();
        agent_forms::seed(&agent.forms, &mut agent.drafts);
        agent.mark_pending_known();
        agent
            .drafts
            .get_mut(&("form-r29-schema".into(), "code".into()))
            .unwrap()
            .edit
            .text = "ok".into();
        agent.answer_form("form-r29-schema");
        let act_gen = match forms_rx.try_recv().unwrap() {
            crate::agent::PendingJob::Act(_, g) => g,
            _ => panic!("expected PendingJob::Act"),
        };
        out_tx
            .try_send(crate::agent::Result::ActForm(
                crate::agent_api::FormReplyOutcome::ValidationRejected(Some(
                    "Form field does not match pattern: code".into(),
                )),
                Some(vec![schema_v1.clone()]),
                act_gen,
            ))
            .unwrap();
        assert!(agent.poll());
        assert!(
            agent_forms::answer(&schema_v1, &agent.drafts).is_err(),
            "unchanged schema must keep `ok` rejected after 400"
        );
        // Later refresh replaces the pattern on the same form ID: stale rejection must clear.
        agent.refresh_forms();
        let refresh_gen = match forms_rx.try_recv().unwrap() {
            crate::agent::PendingJob::Read(g) => g,
            _ => panic!("expected PendingJob::Read"),
        };
        out_tx
            .try_send(crate::agent::Result::Forms(
                Some(vec![schema_v2.clone()]),
                refresh_gen,
            ))
            .unwrap();
        assert!(agent.poll());
        assert_eq!(
            agent_forms::answer(&schema_v2, &agent.drafts).unwrap()["code"],
            json!("ok"),
            "replacing field schema on later snapshot must invalidate stale rejection marker"
        );

        // 6. Duplicate named capture groups in disjoint alternatives defer to OpenCode instead of
        // binding `\k<x>` only to the first capture and falsely rejecting `bb`.
        let dup_named_field = json!({
            "key": "dup",
            "title": "Dup",
            "type": "string",
            "required": true,
            "pattern": "^(?:(?<x>a)|(?<x>b))\\k<x>$"
        });
        for candidate in ["aa", "bb"] {
            let mut d = agent_forms::Draft::default();
            d.edit = rune::edit::TextEdit::new(candidate);
            assert_eq!(
                agent_forms::validate(&dup_named_field, &d),
                Ok(Some(json!(candidate))),
                "duplicate named capture pattern must defer and accept `{candidate}`"
            );
        }
    });
}

#[test]
fn round30_crlf_paste_cap_ime_preedit_cap_rejected_empty_clear_and_ampm_datetime_defaults() {
    crate::strings::with_locale("en", || {
        // 1. Pasting `"ab\r\n".repeat(7000)` (21,000 normalized UTF-16 units) must cap on the
        // post-CRLF-folded stream so the resulting text stays above 20,000 units and blocks Answer
        // instead of silently truncating to 15,360 valid units.
        let crlf_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r30-crlf".into(),
            title: "CRLF paste".into(),
            fields: vec![json!({
                "key": "body",
                "title": "Body",
                "type": "string",
                "required": true
            })],
        };
        let (state, _rx) = state_with_form(crlf_form.clone());
        let mut rt = Runtime::new(state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let (ix, iy) = rt.find("field-body").expect("free-text editor must mount");
        rt.pointer_down(ix, iy);
        rt.pointer_up(ix, iy);
        rt.frame(0.0);
        rt.paste("ab\r\n".repeat(7_000));
        rt.frame(0.0);
        let body_utf16 = rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r30-crlf".into(), "body".into()))
            .unwrap()
            .edit
            .text
            .encode_utf16()
            .count();
        assert!(
            body_utf16 > 20_000
                && body_utf16 <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "CRLF paste of 21,000 normalized units must stay in (20000..=20480] so Answer stays blocked, got {body_utf16}"
        );
        assert!(
            agent_forms::answer(&crlf_form, &rt.state.agent.as_ref().unwrap().drafts).is_err(),
            "oversized CRLF paste must fail validation instead of silently truncating into a valid answer"
        );
        let crlf_tree = rt.accessibility_json();
        assert!(
            has_state(
                find_node(&crlf_tree, "answer-question").expect("Answer button must mount"),
                "disabled"
            ),
            "Answer button must stay disabled after oversized CRLF paste"
        );

        // 2. Uncommitted IME preedit of 50,000 chars is bounded both in layout on the uncommitted
        // frame (even without poll) and in stored state via Agent::poll, as well as after commit.
        let ime_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r30-ime".into(),
            title: "IME preedit".into(),
            fields: vec![json!({
                "key": "body",
                "title": "Body",
                "type": "string",
                "required": true
            })],
        };
        let (ime_state, _irx) = state_with_form(ime_form.clone());
        let mut ime_rt = Runtime::new(ime_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        ime_rt.frame(0.0);
        let (ix, iy) = ime_rt.find("field-body").expect("IME editor must mount");
        ime_rt.pointer_down(ix, iy);
        ime_rt.pointer_up(ix, iy);
        ime_rt.frame(0.0);
        ime_rt.ime(rune::Ime::Preedit("x".repeat(50_000), None, Vec::new()));
        ime_rt.frame(0.0);
        let els = ime_rt.elements();
        let laid_out_len = els
            .iter()
            .find(|e| e.key.as_deref() == Some("input"))
            .and_then(|e| e.text.as_deref())
            .map_or(0, |v| v.encode_utf16().count());
        assert!(
            laid_out_len > 20_000
                && laid_out_len <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "uncommitted IME preedit laid out in input must stay bounded in (20000..=20480], got {laid_out_len}"
        );
        assert!(
            ime_rt.state.agent.as_mut().unwrap().poll(),
            "Agent::poll must clamp oversized uncommitted preedit in state"
        );
        let stored_preedit_len = ime_rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r30-ime".into(), "body".into()))
            .unwrap()
            .edit
            .preedit()
            .map_or(0, |(p, _)| p.encode_utf16().count());
        assert!(
            stored_preedit_len > 20_000
                && stored_preedit_len <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "uncommitted IME preedit must be bounded in stored draft state, got {stored_preedit_len}"
        );
        ime_rt.ime(rune::Ime::Commit("y".repeat(50_000)));
        ime_rt.frame(0.0);
        let committed_len = ime_rt
            .state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r30-ime".into(), "body".into()))
            .unwrap()
            .edit
            .text
            .encode_utf16()
            .count();
        assert!(
            committed_len > 20_000
                && committed_len <= rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16,
            "committed IME text must also stay bounded in (20000..=20480], got {committed_len}"
        );
        assert!(
            has_state(
                find_node(&ime_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must stay disabled after oversized IME commit"
        );

        // 3. A server-rejected explicit empty answer on an optional deferred-pattern string field
        // stays invalid and keeps conditional `when: eq ""` siblings visible and Answer disabled
        // until the user explicitly clicks Clear to omit the field.
        let rej_empty_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r30-rej-empty".into(),
            title: "Rejected empty".into(),
            fields: vec![
                json!({
                    "key": "opt",
                    "title": "Optional",
                    "type": "string",
                    "required": false,
                    "pattern": "^(?=a{257})"
                }),
                json!({
                    "key": "note",
                    "title": "Note",
                    "type": "string",
                    "required": false,
                    "default": "hi",
                    "when": [{ "key": "opt", "op": "eq", "value": "" }]
                }),
            ],
        };
        let (mut rej_state, _rrx) = state_with_form(rej_empty_form.clone());
        {
            let opt_d = rej_state
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r30-rej-empty".into(), "opt".into()))
                .unwrap();
            opt_d.edit.text = "x".into();
            assert!(opt_d.is_dirty());
            opt_d.edit.text.clear();
        }
        assert_eq!(
            agent_forms::answer(&rej_empty_form, &rej_state.agent.as_ref().unwrap().drafts)
                .unwrap(),
            json!({ "opt": "", "note": "hi" })
        );
        // Simulate server 400 rejecting `opt: ""`:
        {
            let opt_d = rej_state
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-r30-rej-empty".into(), "opt".into()))
                .unwrap();
            opt_d.set_server_rejected(rej_empty_form.fields[0].clone(), json!(""));
        }
        let mut rej_rt = Runtime::new(rej_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        rej_rt.frame(0.0);
        assert!(
            agent_forms::answer(
                &rej_empty_form,
                &rej_rt.state.agent.as_ref().unwrap().drafts
            )
            .is_err(),
            "server-rejected explicit empty string must stay invalid instead of silently omitting"
        );
        let rej_tree = rej_rt.accessibility_json();
        assert!(
            has_state(
                find_node(&rej_tree, "answer-question").expect("Answer button"),
                "disabled"
            ),
            "Answer must stay disabled after server rejects explicit empty answer"
        );
        assert!(
            find_node(&rej_tree, &agent_forms::field_editor_key("note")).is_some(),
            "conditional `when: eq \"\"` sibling must stay visible while rejected empty answer is active"
        );
        let (cx, cy) = rej_rt
            .find(&agent_forms::clear_option_key("opt"))
            .expect("optional free-text field with rejected empty answer must expose Clear");
        rej_rt.pointer_down(cx, cy);
        rej_rt.pointer_up(cx, cy);
        rej_rt.frame(0.0);
        assert_eq!(
            agent_forms::answer(
                &rej_empty_form,
                &rej_rt.state.agent.as_ref().unwrap().drafts
            )
            .unwrap(),
            json!({}),
            "explicit Clear action must omit the optional field and allow submitting {{}}"
        );
        let cleared_tree = rej_rt.accessibility_json();
        assert!(
            find_node(&cleared_tree, &agent_forms::field_editor_key("note")).is_none(),
            "conditional sibling must hide once user explicitly clears the empty answer"
        );
        assert!(
            !has_state(
                find_node(&cleared_tree, "answer-question").expect("Answer button"),
                "disabled"
            ),
            "Answer must become enabled after user explicitly clears the rejected empty answer"
        );

        // 4. Required hidden `date-time` field with V8/OpenCode-valid defaults like
        // `"2026-11-26 2:30 PM GMT"` and `"2026-11-26 14:30 (Paris)"` must remain valid and
        // submit verbatim, while impossible shapes like `"2026-11-26T2:30 PM GMT"` and
        // `"2026-11-26 13:00 PM GMT"` are still rejected.
        let ampm_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r30-ampm".into(),
            title: "AM/PM date-time".into(),
            fields: vec![
                json!({
                    "key": "when_gmt",
                    "title": "When GMT",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "2026-11-26 2:30 PM GMT"
                }),
                json!({
                    "key": "when_paren",
                    "title": "When Paren",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "2026-11-26 14:30 (Paris)"
                }),
                json!({
                    "key": "when_defer",
                    "title": "When Deferred",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "2026-11-26 2 PM GMT"
                }),
            ],
        };
        let (ampm_state, _arx) = state_with_form(ampm_form.clone());
        assert_eq!(
            agent_forms::answer(&ampm_form, &ampm_state.agent.as_ref().unwrap().drafts)
                .expect("valid OpenCode AM/PM and parenthesized date-time defaults must pass"),
            json!({
                "when_gmt": "2026-11-26 2:30 PM GMT",
                "when_paren": "2026-11-26 14:30 (Paris)",
                "when_defer": "2026-11-26 2 PM GMT"
            })
        );
        let dt_field = json!({
            "key": "when",
            "title": "When",
            "type": "string",
            "format": "date-time",
            "required": true
        });
        let mut dt_budget = crate::agent::string_constraints::MatchBudget::new();
        for bad in [
            "2026-11-26T2:30 PM GMT",
            "2026-11-26 13:00 PM GMT",
            "2026-11-26 25:00 GMT",
            "2026-11-26 garbage",
        ] {
            assert_eq!(
                crate::agent::string_constraints::matches_string_constraints_budgeted(
                    &dt_field,
                    bad,
                    &mut dt_budget
                ),
                Ok(crate::agent::string_constraints::MatchOutcome::NoMatch),
                "invalid date-time `{bad}` must remain rejected"
            );
        }
    });
}

#[test]
fn round31_short_offset_datetime_and_exact_20k_multiselect_default() {
    crate::strings::with_locale("en", || {
        // 1. Required hidden `date-time` field with short offset `"2026-11-27 14:30:00+00"` and
        // unrecognized V8-accepted spellings like `"2026-11-27 14:30:00+99"` and
        // `"11/27/2026 14:30:00+00"` must keep Answer enabled and submit verbatim.
        let dt_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r31-dt".into(),
            title: "Short offset date-time".into(),
            fields: vec![
                json!({
                    "key": "pg_utc",
                    "title": "PG UTC",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "2026-11-27 14:30:00+00"
                }),
                json!({
                    "key": "numeric_short",
                    "title": "Numeric short",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "11/27/2026 14:30:00+00"
                }),
                json!({
                    "key": "exotic_offset",
                    "title": "Exotic offset",
                    "type": "string",
                    "format": "date-time",
                    "required": true,
                    "hidden": true,
                    "default": "2026-11-27 14:30:00+99"
                }),
            ],
        };
        let (dt_state, _drx) = state_with_form(dt_form.clone());
        assert_eq!(
            agent_forms::answer(&dt_form, &dt_state.agent.as_ref().unwrap().drafts)
                .expect("short-offset and deferred OpenCode date-time defaults must pass"),
            json!({
                "pg_utc": "2026-11-27 14:30:00+00",
                "numeric_short": "11/27/2026 14:30:00+00",
                "exotic_offset": "2026-11-27 14:30:00+99"
            })
        );
        let mut dt_rt = Runtime::new(dt_state, render_form, (420.0, 620.0), Env::new(false, 1.0));
        dt_rt.frame(0.0);
        assert!(
            !has_state(
                find_node(&dt_rt.accessibility_json(), "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must be enabled for valid short-offset hidden date-time defaults"
        );

        // 2. Required custom multiselect with `options: []` and one default item of exactly
        // 20,000 ASCII chars must NOT count a trailing newline, must keep the editor enabled,
        // and must submit the untouched default verbatim.
        let exact_20k = "a".repeat(20_000);
        let multi_form = Form {
            tool: None,
            infer_websearch: false,
            id: "form-r31-20k".into(),
            title: "Exact 20k multiselect".into(),
            fields: vec![json!({
                "key": "items",
                "title": "Items",
                "type": "multiselect",
                "required": true,
                "custom": true,
                "options": [],
                "default": [exact_20k.clone()]
            })],
        };
        let (multi_state, _mrx) = state_with_form(multi_form.clone());
        let draft = multi_state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r31-20k".into(), "items".into()))
            .unwrap();
        assert!(
            !draft.oversized_multiselect_default,
            "single 20,000-unit default must not trip oversized_multiselect_default"
        );
        assert_eq!(draft.custom.text.len(), 20_000);
        assert_eq!(
            agent_forms::answer(&multi_form, &multi_state.agent.as_ref().unwrap().drafts)
                .expect("exact 20,000-unit multiselect default must validate and submit"),
            json!({ "items": [exact_20k] })
        );
        let mut multi_rt = Runtime::new(
            multi_state,
            render_form,
            (420.0, 620.0),
            Env::new(false, 1.0),
        );
        multi_rt.frame(0.0);
        let multi_tree = multi_rt.accessibility_json();
        assert!(
            !has_state(
                find_node(&multi_tree, "answer-question").unwrap(),
                "disabled"
            ),
            "Answer must be enabled for exact 20,000-unit multiselect default"
        );
        assert!(
            !has_state(find_input(&multi_tree, "custom-items"), "disabled"),
            "custom multiselect editor must remain enabled at exact 20,000-unit boundary"
        );
    });
}
