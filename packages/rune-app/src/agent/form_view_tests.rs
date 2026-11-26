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
                    "options": [
                        {"value": "", "label": "Only empty"}
                    ]
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
        // Empty option dropped, duplicate "prod" collapsed -> 3 distinct radios.
        assert_eq!(radios.len(), 3, "{radios:?}");
        assert_eq!(radios[0]["name"], "Production");
        assert!(has_state(&radios[0], "unchecked"));
        assert_eq!(radios[1]["name"], "Your answer 2");
        assert_eq!(radios[2]["name"], "Your answer 3");

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

        // Multiselect sanitized out "" and "stale_removed" so the form submits cleanly with ["alpha"].
        let a = rt.state.agent.as_ref().unwrap();
        let answer = agent_forms::answer(&a.forms[0], &a.drafts).expect("sanitized draft submits");
        assert_eq!(answer["choice"], json!("internal_choice_key"));
        assert_eq!(answer["tags"], json!(["alpha"]));

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
        let mut arbitrary_draft = agent_forms::Draft::default();
        arbitrary_draft.edit = rune::edit::TextEdit::new("not allowed");
        assert!(
            agent_forms::value(&empty_closed, &arbitrary_draft).is_err(),
            "explicit empty options array on closed string must reject arbitrary text"
        );
        let mut arbitrary_choice = agent_forms::Draft::default();
        arbitrary_choice.choice = Some("not allowed".into());
        assert!(
            agent_forms::value(&empty_closed, &arbitrary_choice).is_err(),
            "explicit empty options array on closed string must reject arbitrary choice"
        );

        // Malformed option shapes (missing or non-array multiselect options, non-array string options)
        // must be rejected by both supported() and value().
        for malformed in [
            json!({"key": "bad_multi_missing", "type": "multiselect"}),
            json!({"key": "bad_multi_str", "type": "multiselect", "options": "nope"}),
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

        // Custom multiselect with options: [] and default: ["team-local"] preserves custom defaults
        // (including hidden required fields), and refresh prunes only stale option-backed picks.
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
                    "default": ["", "team-local"]
                }),
                json!({
                    "key": "mixed_tags",
                    "title": "Mixed",
                    "type": "multiselect",
                    "custom": true,
                    "options": [{"value": "opt_a", "label": "Opt A"}],
                    "default": ["opt_a", "custom-keep"]
                }),
            ],
        };
        let mut custom_drafts = agent_forms::Drafts::default();
        agent_forms::seed(&[custom_multi_form.clone()], &mut custom_drafts);
        let ans = agent_forms::answer(&custom_multi_form, &custom_drafts)
            .expect("custom multiselect defaults must submit cleanly");
        assert_eq!(ans["hidden_tags"], json!(["team-local"]));
        assert_eq!(ans["mixed_tags"], json!(["custom-keep", "opt_a"]));

        // Refresh removes opt_a from options: stale option-backed pick is pruned while custom-keep survives.
        let mut refreshed = custom_multi_form;
        refreshed.fields[1]["options"] = json!([{"value": "opt_b", "label": "Opt B"}]);
        agent_forms::seed(&[refreshed.clone()], &mut custom_drafts);
        let refreshed_ans = agent_forms::answer(&refreshed, &custom_drafts)
            .expect("custom default survives option refresh");
        assert_eq!(refreshed_ans["hidden_tags"], json!(["team-local"]));
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
