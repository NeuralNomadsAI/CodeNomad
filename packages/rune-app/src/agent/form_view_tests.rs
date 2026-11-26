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
                json!(["team\nlocal"]),
                "hidden structured custom default must round-trip verbatim without splitting on newline"
            );
            assert_eq!(
                ans["mixed_tags"],
                json!(["custom-keep", "opt_a", "team-local"])
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
        assert_eq!(refreshed_ans["hidden_tags"], json!(["team\nlocal"]));
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
        // Typing declared option "prod" into custom-targets while Production is unchecked must
        // block submission with a field-associated conflict instead of silently dropping it.
        {
            let a = mrt.state.agent.as_ref().unwrap();
            let td = &a.drafts[&("form-multi-edges".into(), "targets".into())];
            assert_eq!(
                agent_forms::validate(&a.forms[0].fields[0], td),
                Err(agent_forms::ValidationError::DuplicateCustomOption)
            );
            assert!(agent_forms::answer(&a.forms[0], &a.drafts).is_err());
        }
        let conflict_tree = mrt.accessibility_json();
        assert!(has_state(
            find_input(&conflict_tree, "custom-targets"),
            "invalid"
        ));
        assert_eq!(
            find_node(&conflict_tree, "field-error:7:targets").unwrap()["name"],
            "Clear — Other values"
        );
        assert!(has_state(
            find_node(&conflict_tree, "answer-question").unwrap(),
            "disabled"
        ));
        // Removing "prod" from custom-targets resolves the conflict and submits cleanly.
        mrt.update(|s, _| {
            let d = s
                .agent
                .as_mut()
                .unwrap()
                .drafts
                .get_mut(&("form-multi-edges".into(), "targets".into()))
                .unwrap();
            d.custom_editor().text = "extra-custom".into();
        });
        mrt.frame(3.0);
        let a = mrt.state.agent.as_ref().unwrap();
        let mans = agent_forms::answer(&a.forms[0], &a.drafts).expect("valid multiselect answer");
        assert_eq!(
            mans["targets"],
            json!(["extra-custom"]),
            "unchecked declared option must not be submitted via custom text"
        );
        assert_eq!(
            mans["multiline"],
            json!(["new", "team\nlocal"]),
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
                Err(agent_forms::ValidationError::DuplicateCustomOption)
            );
            let rd = &a.drafts[&("form-r6-ident".into(), "radio_env".into())];
            assert_eq!(rd.choice, None);
            assert_eq!(rd.custom.text, "prod");
            assert_eq!((rd.custom.anchor, rd.custom.focus), (1, 3));
            // Typing a declared string option's wire value into custom while the radio is
            // unchecked must conflict and block submission rather than submitting an unchecked radio.
            assert_eq!(
                agent_forms::validate(&a.forms[0].fields[1], rd),
                Err(agent_forms::ValidationError::SelectDeclaredOption)
            );
            assert!(agent_forms::value(&a.forms[0].fields[1], rd).is_err());
            assert!(agent_forms::answer(&a.forms[0], &a.drafts).is_err());
        }
        let id_tree = id_rt.accessibility_json();
        assert!(has_state(
            find_input(&id_tree, "custom-multi_env"),
            "invalid"
        ));
        assert_eq!(
            find_node(&id_tree, "field-error:9:multi_env").unwrap()["name"],
            "Clear — Other values"
        );
        assert!(has_state(
            find_input(&id_tree, "custom-radio_env"),
            "invalid"
        ));
        let err_node = find_node(&id_tree, "field-error:9:radio_env")
            .expect("conflict alert for declared string option in custom input");
        assert_eq!(err_node["role"], "alert");
        assert_eq!(err_node["name"], "Select an option");
        assert!(has_state(
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
        assert!(find_node(&id_resolved, "field-error:9:multi_env").is_none());
        assert!(!has_state(
            find_input(&id_resolved, "custom-radio_env"),
            "invalid"
        ));
        assert!(find_node(&id_resolved, "field-error:9:radio_env").is_none());
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
            let shared_key = format!("field-body:{}:{field_key}", field_key.len());
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
            let short_err = find_node(&vtree, "field-error:10:short_text").unwrap();
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
            let tags_err = find_node(&vtree, "field-error:8:min_tags").unwrap();
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
            assert!(find_node(&ok_tree, "field-error:10:short_text").is_none());
            assert!(!has_state(find_node(&ok_tree, &tag_a).unwrap(), "invalid"));
            assert!(find_node(&ok_tree, "field-error:8:min_tags").is_none());
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
            find_node(&focused_tree, "field-error:5:token").is_none(),
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
        assert!(
            radios.iter().any(|r| {
                r["t"] == "Yes"
                    && r["d"].as_str().is_some_and(|d| {
                        d.contains("Proceed now?") && d.contains("Question Required")
                    })
            }),
            "first Yes radio web mirror must carry its own question title and requiredness: {radios:?}"
        );
        assert!(
            radios.iter().any(|r| {
                r["t"] == "Yes"
                    && r["d"].as_str().is_some_and(|d| {
                        d.contains("Notify team?") && d.contains("Question Required")
                    })
            }),
            "second Yes radio web mirror must carry its own question title and requiredness: {radios:?}"
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
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "radio"
                    && item["t"] == "Yes"
                    && item["d"].as_str().is_some_and(|d| {
                        d.contains("Database") && d.contains("Keep the existing database?")
                    })
            }),
            "boolean radio web mirror must expose both header and field description: {web_items:?}"
        );
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "radio"
                    && item["t"] == "Staging"
                    && item["d"].as_str().is_some_and(|d| {
                        d.contains("Tier") && d.contains("Which deployment tier should be used?")
                    })
            }),
            "string radio web mirror must expose both header and field description: {web_items:?}"
        );
        assert!(
            web_items.iter().any(|item| {
                item["o"] == "checkbox"
                    && item["t"] == "Metrics"
                    && item["d"].as_str().is_some_and(|d| {
                        d.contains("Extras") && d.contains("Select optional modules to enable.")
                    })
            }),
            "multiselect checkbox web mirror must expose both header and field description: {web_items:?}"
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
                .text = "2026-11-26 12:00".into();
        });
        prt.frame(1.0 / 60.0);
        let ptree = prt.accessibility_json();
        assert!(has_state(
            find_node(&ptree, "answer-question").unwrap(),
            "disabled"
        ));
        for k in ["code", "site", "mail", "day", "stamp"] {
            let err_key = format!("field-error:{}:{k}", k.len());
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
