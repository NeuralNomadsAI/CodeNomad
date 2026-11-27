use super::*;
use crate::{
    Phase, State,
    agent_api::{Form, Permission},
    agent_forms, init, view,
};
use rune::{Env, Runtime, TouchPhase};
use serde_json::json;

fn state() -> State {
    let (jobs, _) = bounded(1);
    let (stop, _) = bounded(1);
    let (_, results) = bounded(1);
    let mut ui = Ui::new(Handle::test(jobs, stop, results));
    ui.reading = false;
    ui.known = true;
    ui.mark_pending_known();
    ui.online = true;
    let mut state = init();
    state.phase = Phase::Ready;
    state.agent = Some(ui);
    state
}
fn runtime(state: State, size: (f32, f32)) -> Runtime<State> {
    let mut rt = Runtime::new(state, view, size, Env::new(false, 1.0));
    settle(&mut rt);
    rt
}
fn settle(rt: &mut Runtime<State>) {
    for _ in 0..30 {
        rt.frame(0.02);
    }
}
fn visible(rt: &Runtime<State>, key: &str) {
    let node = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("missing {key}"));
    if node.role == "textbox" {
        assert_eq!(node.fill, rune_theme_codenomad::field_kit(false).c.bg_base);
    }
    let (stack_w, stack_h) = rt
        .elements()
        .iter()
        .find(|e| e.key.as_deref() == Some("session-stack"))
        .map_or((f32::INFINITY, f32::INFINITY), |e| {
            (e.visible[2], e.visible[3])
        });
    assert!(
        node.rect[2] > 0.0
            && node.rect[3] > 0.0
            && node.visible[2] >= node.rect[2].min(stack_w) - 1.0
            && node.visible[3] >= node.rect[3].min(stack_h) - 1.0,
        "{key} must be a usable visible control: rect={:?} visible={:?}, layout={:?}",
        node.rect,
        node.visible,
        rt.elements()
            .iter()
            .filter_map(|e| {
                let key = e.key.as_deref()?;
                matches!(
                    key,
                    "application-shell" | "session-shell" | "session-stack" | "session-composer"
                )
                .then_some((key, e.rect, e.visible))
            })
            .collect::<Vec<_>>()
    );
}
fn reveal(rt: &mut Runtime<State>, key: &str) {
    rt.update(|_, tx| {
        tx.scroll_into_view(key.to_owned());
        tx.instant();
    });
    settle(rt);
    visible(rt, key);
}
#[test]
fn workspace_chat_keeps_history_agent_and_composer_inside_the_viewport() {
    for size in [(390.0, 844.0), (1100.0, 900.0)] {
        let mut state = state();
        state.workspace = Some(crate::workspace::Ui::new());
        state.chat_title = "Existing history".into();
        state.messages.push(
            crate::Message {
                usage: None,
                id: "visible-history".into(),
                role: "assistant".into(),
                completed: true,
                body: "Existing answer".into(),
                parts: vec![],
            }
            .into(),
        );
        let rt = runtime(state, size);
        for key in [
            "tab-body-tab-0",
            "history",
            "agent-panel",
            "model-picker",
            "session-composer",
            "composer",
            "send",
        ] {
            let node = rt
                .elements()
                .into_iter()
                .find(|e| e.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing integrated chat node {key}"));
            println!(
                "{}",
                json!({"viewport":[size.0,size.1],"key":key,"rect":node.rect,"visible":node.visible})
            );
            assert!(
                node.rect[2] > 0.0
                    && node.rect[3] > 0.0
                    && node.rect[1] >= 0.0
                    && node.rect[1] + node.rect[3] <= size.1 + 1.0
                    && node.visible[2] >= node.rect[2] - 1.0
                    && node.visible[3] >= node.rect[3] - 1.0,
                "{key} must be painted inside {size:?}: rect={:?}, visible={:?}",
                node.rect,
                node.visible
            );
        }
    }
}
#[test]
fn permissions_keep_actions_visible_and_reason_reachable_across_viewports() {
    for right_wanted in [false, true] {
        for size in [(1400.0, 900.0), (390.0, 740.0), (390.0, 320.0)] {
            let mut state = state();
            crate::gallery::shell::fixture(&mut state);
            state.shell.wanted = [Some([false, right_wanted]); 2];
            let ui = state.agent.as_mut().unwrap();
            ui.selected = "permission-fixture".into();
            ui.permissions.push(Permission {
                tool: None,
                id: ui.selected.clone(),
                action: "read".into(),
                resources: (0..40)
                    .map(|i| format!("/synthetic/resource-{i}"))
                    .collect(),
                message: String::new(),
                supported: true,
            });
            ui.reasons.insert(ui.selected.clone(), TextEdit::new(""));
            let mut rt = runtime(state, size);
            assert_eq!(
                rt.find("right-panel").is_some(),
                right_wanted && size.0 > 390.0
            );
            for key in ["allow_once", "allow_always", "reject"] {
                if size.1 == 320.0 {
                    reveal(&mut rt, key);
                } else {
                    visible(&rt, key);
                }
            }
            reveal(&mut rt, "reason-permission-fixture");
            rt.update(|_, tx| tx.scroll_to_bottom_instant("session-stack"));
            settle(&mut rt);
            visible(&rt, "composer");
            let (x, y) = rt.find("composer").unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.paste("draft through the dock");
            rt.frame(0.02);
            assert_eq!(rt.state.draft.text, "draft through the dock");
            if size == (390.0, 320.0) && right_wanted {
                let long = "Long draft line\n".repeat(60);
                let (commands, received) = bounded(1);
                rt.update(|s, _| {
                    s.commands = Some(commands);
                    s.draft.replace_text(&long);
                });
                settle(&mut rt);
                let editor = rt
                    .elements()
                    .into_iter()
                    .find(|node| node.path.ends_with("/composer/scroll/input"))
                    .unwrap();
                let viewport = rt
                    .elements()
                    .into_iter()
                    .find(|node| node.path.ends_with("/composer/scroll"))
                    .unwrap();
                assert!(editor.rect[3] > 320.0, "fixture must overflow the editor");
                assert!(
                    viewport.rect[3] <= 320.0,
                    "long draft must not grow the viewport"
                );
                rt.update(|_, tx| tx.scroll_to_bottom_instant(&viewport.path));
                rt.frame(0.02);
                assert_eq!(rt.scroll_at_bottom(&viewport.path), Some(true));
                reveal(&mut rt, "send");
                let (x, y) = rt.find("send").unwrap();
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
                rt.frame(0.02);
                assert!(
                    matches!(received.try_recv().unwrap(), crate::transport::Command::Prompt(prompt) if prompt.text == long.trim_end())
                );
            }
            reveal(&mut rt, "history");
            reveal(&mut rt, "allow_once");
        }
    }
}
#[test]
fn question_fields_model_list_and_composer_remain_scroll_reachable() {
    for size in [(1400.0, 900.0), (390.0, 740.0), (390.0, 320.0)] {
        let mut state = state();
        let ui = state.agent.as_mut().unwrap();
        ui.selected = "form-fixture".into();
        ui.forms.push(Form { tool: None, infer_websearch: false, owner: Default::default(), id: ui.selected.clone(), title: "Synthetic question".into(), fields: (0..24).map(|i| json!({"key":format!("field{i}"),"type":"string","title":format!("Synthetic field {i}")})).collect() });
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        let mut rt = runtime(state, size);
        reveal(&mut rt, "field-field23");
        let (x, y) = rt.find("field-field23").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.paste("draft");
        rt.frame(0.0);
        assert_eq!(
            rt.state.agent.as_ref().unwrap().drafts[&("form-fixture".into(), "field23".into())]
                .edit
                .text,
            "draft"
        );
        reveal(&mut rt, "answer-question");
        reveal(&mut rt, "cancel-question");
        reveal(&mut rt, "composer");
        rt.update(|state, tx| {
            let ui = state.agent.as_mut().unwrap();
            ui.forms.clear();
            ui.picker = true;
            ui.models = (0..40)
                .map(|i| Model {
                    reference: json!(format!("model{i}")),
                    label: format!("Synthetic model {i}"),
                    included: false,
                })
                .collect();
            tx.instant();
        });
        settle(&mut rt);
        reveal(&mut rt, "model-\"model39\"");
        reveal(&mut rt, "stop-response");
        reveal(&mut rt, "composer");
    }
}

fn audit_settlement_during_edit(permission: bool) {
    let mut initial = state();
    let ui = initial.agent.as_mut().unwrap();
    ui.selected = "audit_pending".into();
    let key;
    if permission {
        ui.permissions.push(Permission {
            tool: None,
            id: ui.selected.clone(),
            action: "read".into(),
            resources: vec!["/synthetic".into()],
            message: String::new(),
            supported: true,
        });
        ui.reasons.insert(ui.selected.clone(), TextEdit::new(""));
        key = "reason-audit_pending";
    } else {
        ui.forms.push(Form {
            tool: None,
            infer_websearch: false,
            owner: Default::default(),
            id: ui.selected.clone(),
            title: "Synthetic question".into(),
            fields: vec![json!({"key":"answer","type":"string"})],
        });
        agent_forms::seed(&ui.forms, &mut ui.drafts);
        key = "field-answer";
    }
    let (native, results) = bounded(4);
    ui.handle.results = results;
    let mut rt = runtime(initial, (960.0, 760.0));
    rt.poll = Some(crate::poll);
    reveal(&mut rt, key);
    let (x, y) = rt.find(key).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.paste("draft before settlement");
    rt.frame(0.02);
    assert!(
        native
            .try_send(super::Result::Read(
                Snapshot {
                    models: None,
                    current: None,
                    directory: None,
                    session_known: true,
                    root_directory: None,
                    usage: None,
                    running: false,
                    permissions: Some(vec![]),
                    forms: Some(vec![]),
                },
                false,
                0
            ))
            .is_ok()
    );
    // One queued edit races with the authoritative snapshot, as during real recovery.
    rt.paste(" late edit");
    rt.frame(0.02);
    for _ in 0..12 {
        rt.frame(0.02);
    }
    let ui = rt.state.agent.as_ref().unwrap();
    assert!(ui.permissions.is_empty() && ui.forms.is_empty());
    assert!(ui.reasons.is_empty() && ui.drafts.is_empty());
    // Also cover focus reconciliation on removal after the queued edit.
    rt.key(rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
}
#[test]
fn audit_permission_settled_while_reason_focused() {
    audit_settlement_during_edit(true);
}
#[test]
fn audit_question_settled_while_answer_focused() {
    audit_settlement_during_edit(false);
}
#[test]
fn late_editor_event_cannot_change_a_replacement_session_with_the_same_request_id() {
    let mut initial = state();
    let ui = initial.agent.as_mut().unwrap();
    ui.selected = "reused-request".into();
    ui.permissions.push(Permission {
        tool: None,
        id: ui.selected.clone(),
        action: "read".into(),
        resources: vec![],
        message: String::new(),
        supported: true,
    });
    ui.reasons
        .insert(ui.selected.clone(), TextEdit::new("first session"));
    let mut rt = runtime(initial, (960.0, 760.0));
    reveal(&mut rt, "reason-reused-request");
    let (x, y) = rt.find("reason-reused-request").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.paste(" active edit");
    rt.frame(0.02);
    assert!(
        rt.state.agent.as_ref().unwrap().reasons["reused-request"]
            .text
            .contains("active edit"),
        "Control: the real inner editor must accept input before its owner changes"
    );
    // Replace the session before reconciling the rendered editor and its captured accessor.
    rt.state.show_chat();
    let mut replacement = state().agent.unwrap();
    replacement.reasons.insert(
        "reused-request".into(),
        TextEdit::new("replacement session"),
    );
    rt.state.agent = Some(replacement);
    rt.state.draft = TextEdit::new("replacement composer");
    rt.paste(" late event");
    rt.frame(0.02);
    assert_eq!(
        rt.state.agent.as_ref().unwrap().reasons["reused-request"].text,
        "replacement session"
    );
    assert_eq!(rt.state.draft.text, "replacement composer");
}

fn seed_passages(state: &mut State, count: usize) {
    state
        .workspace
        .get_or_insert_with(crate::workspace::Ui::new);
    state.chat_title = "Keyboard viewport".into();
    for i in 0..count {
        state.messages.push(
            crate::Message {
                usage: None,
                id: format!("passage-{i:02}"),
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                completed: true,
                body: format!(
                    "Keyboard passage {i} with enough prose to wrap differently between narrow portrait and wider landscape viewports."
                ),
                parts: vec![],
            }
            .into(),
        );
    }
}

fn element_rect(rt: &Runtime<State>, key: &str) -> [f32; 4] {
    rt.elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("missing {key}"))
        .rect
}

fn resize(rt: &mut Runtime<State>, size: (f32, f32)) {
    rt.set_viewport(size, 1.0);
    settle(rt);
}

#[test]
fn keyboard_viewport_matrix_preserves_reading_draft_and_actions() {
    let cases = [
        ((320.0, 720.0), (320.0, 420.0)),
        ((360.0, 760.0), (360.0, 440.0)),
        ((390.0, 844.0), (390.0, 514.0)),
        ((390.0, 844.0), (390.0, 393.0)),
        ((720.0, 320.0), (720.0, 175.0)),
        ((760.0, 360.0), (760.0, 200.0)),
        ((844.0, 390.0), (844.0, 220.0)),
    ];
    for permission in [true, false] {
        for (original, short) in cases {
            let mut s = state();
            seed_passages(&mut s, 36);
            s.draft = TextEdit::new("Draft before keyboard");
            let ui = s.agent.as_mut().unwrap();
            if permission {
                ui.selected = "perm-1".into();
                ui.permissions.push(Permission {
                    tool: None,
                    id: "perm-1".into(),
                    action: "edit".into(),
                    resources: (0..18).map(|i| format!("/synthetic/file-{i}.rs")).collect(),
                    message: "Approve synthetic edit".into(),
                    supported: true,
                });
                ui.reasons
                    .insert("perm-1".into(), TextEdit::new("Partial reason"));
            } else {
                ui.selected = "form-1".into();
                ui.forms.push(Form {
                    tool: None,
                    infer_websearch: false,
                    owner: Default::default(),
                    id: "form-1".into(),
                    title: "Choose a target".into(),
                    fields: (0..12)
                        .map(|i| {
                            json!({
                                "key": format!("q{i}"),
                                "type": "string",
                                "title": format!("Question field {i}")
                            })
                        })
                        .collect(),
                });
                agent_forms::seed(&ui.forms, &mut ui.drafts);
                ui.drafts
                    .get_mut(&("form-1".into(), "q0".into()))
                    .unwrap()
                    .edit = TextEdit::new("Partial answer");
            }
            let mut rt = Runtime::new(s, view, original, Env::new(false, 1.0));
            settle(&mut rt);
            assert!(
                rt.find("pending-navigation").is_none(),
                "single pending request hides prev/next navigation"
            );
            rt.update(|_, tx| {
                tx.scroll_key_to("passage-18", -12.0);
                tx.instant();
            });
            settle(&mut rt);
            let before_history = element_rect(&rt, "history");
            let before_row = element_rect(&rt, "passage-18");
            let before_offset = before_row[1] - before_history[1];
            assert!(
                (before_offset + 12.0).abs() <= 2.0,
                "{original:?} ({permission}): expected anchor near -12, got {before_offset}"
            );
            reveal(&mut rt, "composer");
            let (cx, cy) = rt.find("composer").unwrap();
            rt.pointer_down(cx, cy);
            rt.pointer_up(cx, cy);
            settle(&mut rt);
            assert!(
                rt.state.draft.focused,
                "{original:?} ({permission}): composer must accept focus before resize"
            );

            resize(&mut rt, short);
            assert!(
                rt.state.draft.focused,
                "{short:?} ({permission}): composer must keep focus after shrink"
            );
            let region = if permission {
                "pending-content-perm-1"
            } else {
                "pending-content-form-1"
            };
            let actions: &[&str] = if permission {
                &["allow_once", "allow_always", "reject"]
            } else {
                &["answer-question", "cancel-question"]
            };
            for key in actions {
                reveal(&mut rt, key);
            }
            let input_key = if permission {
                "reason-perm-1"
            } else {
                "field-q0"
            };
            rt.update(|_, tx| {
                tx.scroll_into_view(region.to_owned());
                tx.instant();
            });
            settle(&mut rt);
            reveal(&mut rt, input_key);
            reveal(&mut rt, "composer");
            reveal(&mut rt, "send");
            reveal(&mut rt, "history");
            let stack_h = element_rect(&rt, "session-stack")[3];
            let avail = stack_h - element_rect(&rt, "transcript-controls")[3];
            let history_h = element_rect(&rt, "history")[3];
            let expected_min = if avail < 91.0 {
                (avail - 32.0).max(0.0)
            } else {
                64.0
            };
            assert!(
                history_h >= expected_min - 0.5,
                "{short:?}: history must keep its readable reserve (stack={stack_h}, history={history_h})"
            );
            assert_eq!(rt.state.draft.text, "Draft before keyboard");
            let ui = rt.state.agent.as_ref().unwrap();
            if permission {
                assert_eq!(ui.reasons["perm-1"].text, "Partial reason");
            } else {
                assert_eq!(
                    ui.drafts[&("form-1".into(), "q0".into())].edit.text,
                    "Partial answer"
                );
            }

            resize(&mut rt, original);
            assert!(
                rt.state.draft.focused,
                "{original:?} ({permission}): composer must keep focus after restore"
            );
            reveal(&mut rt, "history");
            let after_history = element_rect(&rt, "history");
            let after_row = element_rect(&rt, "passage-18");
            let after_offset = after_row[1] - after_history[1];
            assert!(
                (after_offset - before_offset).abs() <= 2.0,
                "{original:?}->{short:?} ({permission}): passage-18 drifted from {before_offset} to {after_offset}"
            );
        }
    }
}

#[test]
fn multiple_pending_requests_show_navigation_controls() {
    let mut s = state();
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-a".into();
    for id in ["perm-a", "perm-b"] {
        ui.permissions.push(Permission {
            tool: None,
            id: id.into(),
            action: "read".into(),
            resources: vec!["/synthetic/a".into()],
            message: String::new(),
            supported: true,
        });
        ui.reasons.insert(id.into(), TextEdit::new(""));
    }
    let rt = runtime(s, (390.0, 740.0));
    visible(&rt, "pending-prev");
    visible(&rt, "pending-next");
}

#[test]
fn short_viewport_without_interruption_bounds_long_draft_and_preserves_reading() {
    let long_draft = (0..40)
        .map(|i| format!("Long draft line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut s = state();
    seed_passages(&mut s, 36);
    s.draft = TextEdit::new(&long_draft);
    let mut rt = Runtime::new(s, view, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);

    // Focus the composer and scroll transcript up to passage-18.
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-18", -10.0);
        tx.instant();
    });
    settle(&mut rt);
    assert!(rt.state.draft.focused);

    // Non-crowded keyboard/landscape heights keep history >= 64px and Send unclipped without stack scroll.
    for size in [(390.0, 514.0), (320.0, 420.0), (760.0, 384.0)] {
        resize(&mut rt, size);
        let history = element_rect(&rt, "history");
        let composer = element_rect(&rt, "composer");
        assert!(
            rt.scroll_at_bottom("session-stack").is_none(),
            "{size:?}: non-crowded viewport must not enable outer stack scroll"
        );
        visible(&rt, "history");
        assert!(
            history[3] >= 64.0 - 0.5,
            "{size:?}: history crushed to {}",
            history[3]
        );
        assert!(
            composer[3] < 320.0,
            "{size:?}: long draft must cap below 320px, got {}",
            composer[3]
        );
        visible(&rt, "composer");
        visible(&rt, "send");
        assert!(rt.state.draft.focused, "{size:?}: composer must keep focus");
        assert_eq!(rt.state.draft.text, long_draft);
    }

    // Intermediate Solid parity band (44 <= fieldSpace < 108, e.g. fieldSpace = 90):
    // must NOT enable outer stack scroll, caps composer to 44px, and gives remaining ~46px to history.
    let shell_chrome = 384.0 - element_rect(&rt, "session-stack")[3];
    let controls_h = element_rect(&rt, "transcript-controls")[3];
    let agent_h = element_rect(&rt, "agent-panel")[3];
    let composer_chrome =
        element_rect(&rt, "session-composer")[3] - element_rect(&rt, "composer")[3];
    let non_field = shell_chrome + controls_h + agent_h + composer_chrome;
    // Empty draft parity: at a short viewport with fieldSpace=160, Solid gives a 44px composer
    // floor (minimumForViewport) and ~116px transcript rather than forcing a 96px floor.
    rt.update(|s, tx| {
        let focused = s.draft.focused;
        s.draft = TextEdit::new("");
        s.draft.focused = focused;
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (720.0, non_field + 160.0));
    let empty_composer = element_rect(&rt, "composer");
    let empty_history = element_rect(&rt, "history");
    assert!(
        (empty_composer[3] - 44.0).abs() <= 1.0,
        "empty draft at short viewport must follow Solid 44px floor, got {}",
        empty_composer[3]
    );
    assert!(
        (empty_history[3] - 116.0).abs() <= 2.0,
        "empty draft must leave ~116px of unused composer room to transcript, got {}",
        empty_history[3]
    );
    assert!(rt.state.draft.focused, "empty draft parity must keep focus");
    rt.update(|s, tx| {
        let focused = s.draft.focused;
        s.draft = TextEdit::new(&long_draft);
        s.draft.focused = focused;
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (720.0, non_field + 90.0));
    assert!(
        rt.scroll_at_bottom("session-stack").is_none(),
        "fieldSpace=90 without interruption must match Solid and keep outer stack scroll off"
    );
    let mid_composer = element_rect(&rt, "composer");
    let mid_history = element_rect(&rt, "history");
    assert!(
        (mid_composer[3] - 44.0).abs() <= 1.0,
        "fieldSpace=90 must cap composer to 44px, got {}",
        mid_composer[3]
    );
    assert!(
        (mid_history[3] - 46.0).abs() <= 2.0,
        "fieldSpace=90 must leave ~46px to history without overflow, got {}",
        mid_history[3]
    );
    visible(&rt, "composer");
    visible(&rt, "send");

    // Crowded landscape/keyboard heights (fieldSpace < 44) enable stack scroll while preserving history reserve, draft, focus, and reachability.
    for size in [(720.0, non_field + 30.0), (720.0, 175.0)] {
        resize(&mut rt, size);
        assert!(
            rt.scroll_at_bottom("session-stack").is_some(),
            "{size:?}: fieldSpace < 44 must enable outer stack scroll"
        );
        reveal(&mut rt, "composer");
        reveal(&mut rt, "send");
        reveal(&mut rt, "history");
        let stack_h = element_rect(&rt, "session-stack")[3];
        let history_h = element_rect(&rt, "history")[3];
        let expected_min = if stack_h < 91.0 {
            (stack_h - 32.0).max(0.0)
        } else {
            64.0
        };
        assert!(
            history_h >= expected_min - 0.5,
            "{size:?}: crowded history must keep reserve (stack={stack_h}, history={history_h})"
        );
        assert!(rt.state.draft.focused, "{size:?}: composer must keep focus");
        assert_eq!(rt.state.draft.text, long_draft);
    }

    // Restoring portrait keeps passage-18 anchored across width and height transitions.
    resize(&mut rt, (390.0, 844.0));
    let history = element_rect(&rt, "history");
    let row = element_rect(&rt, "passage-18");
    assert!(
        (row[1] - history[1] + 10.0).abs() <= 2.0,
        "passage-18 drifted across width/height transitions: row={row:?}, history={history:?}"
    );
    assert!(rt.state.draft.focused);
    assert_eq!(rt.state.draft.text, long_draft);
}

#[test]
fn resize_bottom_bounce_height_only_latest_and_reader_reconciliation() {
    let mut s = state();
    seed_passages(&mut s, 36);
    let mut rt = Runtime::new(s, view, (390.0, 420.0), Env::new(false, 1.0));
    settle(&mut rt);

    // Scrolled up near the bottom so growing the viewport clamps offset to st.max and queues
    // AtBottom(true) before Layout("history"): shrinking back must restore passage-28 at -6.0.
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-28", -6.0);
        tx.instant();
    });
    settle(&mut rt);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    let before_history = element_rect(&rt, "history");
    let before_offset = element_rect(&rt, "passage-28")[1] - before_history[1];
    assert!((before_offset + 6.0).abs() <= 2.0);
    resize(&mut rt, (390.0, 844.0));
    resize(&mut rt, (390.0, 420.0));
    let after_history = element_rect(&rt, "history");
    let after_offset = element_rect(&rt, "passage-28")[1] - after_history[1];
    assert!(
        (after_offset - before_offset).abs() <= 2.0,
        "clamped grow/shrink round-trip must restore passage-28 at {before_offset}, got {after_offset}"
    );
    resize(&mut rt, (390.0, 844.0));

    // Same-frame scroll_key_to + Latest: Latest must win over an earlier same-frame scroll_key_to.
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-18", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        crate::chat::reading::Reading::restore(
            &crate::chat::reading::Bookmark::Message {
                id: "passage-18".into(),
                offset: -12.0,
            },
            tx,
        );
        crate::chat::reader::latest(s, tx);
    });
    settle(&mut rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(true),
        "Latest in the same transaction must override an earlier scroll_key_to"
    );

    // Production workspace::poll with a cached second tab must not wipe history_size.
    rt.update(|s, tx| {
        crate::workspace::new_tab(s, tx);
        tx.instant();
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        // Restore chat messages on active tab and poll cached background tab before resize.
        s.phase = Phase::Ready;
        seed_passages(s, 36);
        s.show_chat();
        tx.instant();
    });
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-18", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    let poll_before = element_rect(&rt, "passage-18")[1] - element_rect(&rt, "history")[1];
    rt.update(|s, tx| {
        let _ = crate::workspace::poll(s, 1.0, tx);
    });
    resize(&mut rt, (760.0, 360.0));
    resize(&mut rt, (390.0, 844.0));
    let poll_after = element_rect(&rt, "passage-18")[1] - element_rect(&rt, "history")[1];
    assert!(
        (poll_after - poll_before).abs() <= 2.0,
        "workspace::poll must not break resize bookmark restore: {poll_before} -> {poll_after}"
    );

    // Height-only resize with unchanged width/row rects must not wedge manual bottom follow or Latest.
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-18", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (390.0, 514.0));
    rt.update(|_, tx| {
        tx.scroll_to_bottom_instant("history");
        tx.instant();
    });
    settle(&mut rt);
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    resize(&mut rt, (390.0, 844.0));
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(true),
        "scrolling to bottom after a height-only resize must stay at bottom on the next resize"
    );

    // Latest after a height-only resize also returns to and stays at bottom.
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-18", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (390.0, 514.0));
    rt.update(|s, tx| crate::chat::reader::latest(s, tx));
    settle(&mut rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(true),
        "Latest must jump to bottom after a height-only resize"
    );
    resize(&mut rt, (390.0, 844.0));
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(true),
        "subsequent resize after Latest must stay at bottom"
    );
}

#[test]
fn rotation_clamps_shortened_long_message_and_attachment_error_keeps_send_reachable() {
    let mut s = state();
    seed_passages(&mut s, 12);
    s.messages.push(
        crate::Message {
            usage: None,
            id: "long-anchor".into(),
            role: "assistant".into(),
            completed: true,
            body: "Long wrapping paragraph for rotation clamp verification. ".repeat(8),
            parts: vec![],
        }
        .into(),
    );
    for i in 12..30 {
        s.messages.push(
            crate::Message {
                usage: None,
                id: format!("tail-{i:02}"),
                role: "assistant".into(),
                completed: true,
                body: format!("Trailing passage {i} to keep scroll slack below long-anchor."),
                parts: vec![],
            }
            .into(),
        );
    }
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("long-anchor", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let narrow = element_rect(&rt, "long-anchor");
    assert!(
        narrow[3] > 220.0,
        "expected tall wrapped message in 320px portrait, got {}",
        narrow[3]
    );
    let deep_offset = -(narrow[3] - 40.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("long-anchor", deep_offset);
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (844.0, 390.0));
    let history = element_rect(&rt, "history");
    let wide = element_rect(&rt, "long-anchor");
    assert!(
        wide[3] < -deep_offset - 20.0,
        "expected message to shorten below deep_offset ({deep_offset}) in 844px landscape, got {}",
        wide[3]
    );
    assert!(
        wide[1] + wide[3] > history[1] + 4.0 && wide[1] < history[1] + history[3],
        "rotation must clamp offset so shortened long-anchor stays visible: wide={wide:?}, history={history:?}"
    );

    // Attachment error alert height is accounted for in session_layout at the exact fieldSpace=44 threshold.
    let long_draft = (0..30)
        .map(|i| format!("Draft {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    rt.update(|s, tx| {
        s.draft = TextEdit::new(&long_draft);
        s.attachments.error = false;
        tx.instant();
    });
    resize(&mut rt, (720.0, 360.0));
    let header_a = 360.0 - element_rect(&rt, "session-stack")[3];
    let controls_a = element_rect(&rt, "transcript-controls")[3];
    let agent_a = element_rect(&rt, "agent-panel")[3];
    let comp_chrome_a = element_rect(&rt, "session-composer")[3] - element_rect(&rt, "composer")[3];
    rt.update(|s, tx| {
        s.attachments.error = true;
        tx.instant();
    });
    settle(&mut rt);
    let err_h = element_rect(&rt, "attachment-error")[3];
    assert!(
        err_h > 10.0,
        "expected visible attachment error row, got {err_h}"
    );
    let threshold_h = header_a + controls_a + agent_a + comp_chrome_a + 44.0 + err_h * 0.5;
    rt.update(|s, tx| {
        s.attachments.error = false;
        tx.instant();
    });
    resize(&mut rt, (720.0, threshold_h));
    assert!(
        rt.scroll_at_bottom("session-stack").is_none(),
        "without attachment-error, fieldSpace >= 44 must keep outer stack non-scrolling"
    );
    rt.update(|s, tx| {
        s.attachments.error = true;
        tx.instant();
    });
    settle(&mut rt);
    assert!(
        rt.scroll_at_bottom("session-stack").is_some(),
        "enabling attachment-error at threshold height must push fieldSpace < 44 and enable outer stack scroll"
    );
    for size in [(760.0, 360.0), (720.0, 320.0), (320.0, 380.0)] {
        resize(&mut rt, size);
        reveal(&mut rt, "send");
        visible(&rt, "send");
    }
}

#[test]
fn ultra_short_touch_drag_reaches_permission_and_shallow_height_only_resize_never_drifts() {
    ultra_short_touch_drag_cases_1_to_5();
    ultra_short_touch_drag_cases_6_to_9();
    ultra_short_touch_drag_cases_10_to_13();
    ultra_short_touch_drag_cases_14_to_17();
}

fn ultra_short_touch_drag_cases_1_to_5() {
    // 1. Touch drag at 720x160 CSS px (stack <= 64px) reaches permission actions via exposed chrome strip.
    let mut s = state();
    seed_passages(&mut s, 36);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-1".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-1".into(),
        action: "edit".into(),
        resources: (0..12).map(|i| format!("/synthetic/file-{i}.rs")).collect(),
        message: "Approve synthetic edit".into(),
        supported: true,
    });
    ui.reasons.insert("perm-1".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 320.0), Env::new(false, 1.0));
    settle(&mut rt);
    // Size the window so session-stack is 56px tall (equivalent to 720x160 CSS px on web).
    let chrome_h = 320.0 - element_rect(&rt, "session-stack")[3];
    resize(&mut rt, (720.0, chrome_h + 56.0));
    let stack = element_rect(&rt, "session-stack");
    let history = element_rect(&rt, "history");
    assert!(
        stack[3] <= 64.0 && stack[3] >= 54.0,
        "expected ultra-short stack ~56px (<= 64px), got {stack:?}"
    );
    let top_strip = (history[1] - stack[1]).max(0.0);
    let bottom_strip = (stack[1] + stack[3] - (history[1] + history[3])).max(0.0);
    assert!(
        history[3] > 0.0 && top_strip + bottom_strip >= 24.0,
        "history must leave a touch-draggable chrome strip in session-stack: stack={stack:?}, history={history:?}, top_strip={top_strip}, bottom_strip={bottom_strip}"
    );
    // A real touch drag starting on the exposed non-history strip (top controls or bottom strip)
    // must scroll session-stack down to reject.
    let start_x = stack[0] + stack[2] * 0.5;
    let start_y = if bottom_strip >= 12.0 {
        stack[1] + stack[3] - 6.0
    } else {
        stack[1] + (top_strip * 0.5).max(6.0)
    };
    assert!(start_y < history[1] || start_y > history[1] + history[3]);
    let mut t = 1.0;
    let mut reached_reject = false;
    rt.touch(1, TouchPhase::Started, start_x, start_y, t);
    rt.frame(1.0 / 60.0);
    for step in 1..=20 {
        t += 0.016;
        rt.touch(
            1,
            TouchPhase::Moved,
            start_x,
            start_y - step as f32 * 8.0,
            t,
        );
        rt.frame(1.0 / 60.0);
        if rt.elements().iter().any(|n| {
            n.key.as_deref() == Some("reject") && n.visible[3] >= n.rect[3].min(20.0) - 0.5
        }) {
            // Pause >= FLING_HOLD (0.1s) before lifting so the controlled pan settles on reject.
            t += 0.15;
            rt.touch(
                1,
                TouchPhase::Ended,
                start_x,
                start_y - step as f32 * 8.0,
                t,
            );
            settle(&mut rt);
            reached_reject = rt.elements().iter().any(|n| {
                n.key.as_deref() == Some("reject") && n.visible[3] >= n.rect[3].min(20.0) - 0.5
            });
            break;
        }
    }
    assert!(
        reached_reject,
        "real touch drag from exposed chrome strip must scroll session-stack to permission actions at 56px stack"
    );

    // 2. Shallow (< 24px visible) anchor near tail must not drift on height-only clamped grow/shrink.
    let mut s = state();
    seed_passages(&mut s, 36);
    let mut rt = Runtime::new(s, view, (390.0, 420.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-28", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let row_h = element_rect(&rt, "passage-28")[3];
    let shallow_offset = -(row_h - 8.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("passage-28", shallow_offset);
        tx.instant();
    });
    settle(&mut rt);
    let before_offset = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!((before_offset - shallow_offset).abs() <= 2.0);
    resize(&mut rt, (390.0, 844.0));
    resize(&mut rt, (390.0, 420.0));
    let after_offset = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!(
        (after_offset - before_offset).abs() <= 2.0,
        "shallow non-rotated anchor must not drift across clamped height-only round-trip: {before_offset} -> {after_offset}"
    );

    // 3. Reconnecting / switching chat without unmounting history preserves first-resize anchor restore.
    rt.update(|s, _| {
        s.renew_scope();
        s.revision += 1;
    });
    settle(&mut rt);
    resize(&mut rt, (390.0, 844.0));
    resize(&mut rt, (390.0, 420.0));
    let reconnect_after = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!(
        (reconnect_after - before_offset).abs() <= 2.0,
        "first resize after same-session scope renewal must still preserve anchor: {before_offset} -> {reconnect_after}"
    );

    // 4. Focused composer without interruption auto-scrolls into view when stack shrinks to 56px
    // without calling reveal("composer").
    let mut s = state();
    seed_passages(&mut s, 24);
    let mut rt = Runtime::new(s, view, (760.0, 360.0), Env::new(false, 1.0));
    settle(&mut rt);
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    let chrome_h = 360.0 - element_rect(&rt, "session-stack")[3];
    resize(&mut rt, (720.0, chrome_h + 56.0));
    assert!(rt.state.draft.focused);
    visible(&rt, "composer");

    // 5. Rotating a very tall paragraph (> 1000px) scrolled near its tail rescues it even when
    // the old negative offset would fall outside virtualization overscan.
    let mut s = state();
    seed_passages(&mut s, 10);
    s.messages.push(
        crate::Message {
            usage: None,
            id: "huge-anchor".into(),
            role: "assistant".into(),
            completed: true,
            body: "Very long wrapping paragraph to force virtualization eviction on rotation. "
                .repeat(48),
            parts: vec![],
        }
        .into(),
    );
    for i in 10..60 {
        s.messages.push(
            crate::Message {
                usage: None,
                id: format!("huge-tail-{i:02}"),
                role: "assistant".into(),
                completed: true,
                body: format!("Trailing passage {i} below the very long paragraph."),
                parts: vec![],
            }
            .into(),
        );
    }
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("huge-anchor", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let narrow = element_rect(&rt, "huge-anchor");
    assert!(
        narrow[3] > 900.0,
        "expected > 900px paragraph in 320px portrait, got {}",
        narrow[3]
    );
    let deep_offset = -(narrow[3] - 30.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("huge-anchor", deep_offset);
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (844.0, 390.0));
    let history = element_rect(&rt, "history");
    let wide = element_rect(&rt, "huge-anchor");
    assert!(
        wide[1] < history[1] && ((wide[1] + wide[3]) - (history[1] + 24.0)).abs() <= 4.0,
        "rotation rescue must clamp shortened huge-anchor near 24px visible (not offset 0): wide={wide:?}, history={history:?}"
    );
}

fn ultra_short_touch_drag_cases_6_to_9() {
    // 6. First scroll gesture after a height-only resize (390x844 -> 390x514) must not snap back.
    let mut s = state();
    seed_passages(&mut s, 36);
    let mut rt = Runtime::new(s, view, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-12", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    resize(&mut rt, (390.0, 514.0));
    let hist = element_rect(&rt, "history");
    let before_p14 = element_rect(&rt, "passage-14")[1] - hist[1];
    assert!(before_p14 > 20.0);
    // Scroll down in one wheel gesture to bring passage-14 to the top without reaching bottom.
    rt.wheel(
        hist[0] + hist[2] * 0.5,
        hist[1] + hist[3] * 0.5,
        -(before_p14 + 4.0),
    );
    settle(&mut rt);
    let after_p14 = element_rect(&rt, "passage-14")[1] - element_rect(&rt, "history")[1];
    assert!(
        after_p14 < 12.0,
        "first scroll after height-only resize must advance to passage-14 without snapping back: {before_p14} -> {after_p14}"
    );

    // 7. Rotating a very tall paragraph whose shortened offset both leaves overscan AND clamps at bottom
    // still rescues huge-anchor into view instead of staying stuck at the tail.
    let mut s = state();
    seed_passages(&mut s, 6);
    s.messages.push(
        crate::Message {
            usage: None,
            id: "huge-bottom".into(),
            role: "assistant".into(),
            completed: true,
            body: "Very long wrapping paragraph to force bottom clamp and overscan eviction on rotation. "
                .repeat(96),
            parts: vec![],
        }
        .into(),
    );
    for i in 0..18 {
        s.messages.push(
            crate::Message {
                usage: None,
                id: format!("huge-bottom-tail-{i:02}"),
                role: "assistant".into(),
                completed: true,
                body: format!("Short trailing passage {i} below the very long paragraph."),
                parts: vec![],
            }
            .into(),
        );
    }
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("huge-bottom", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let narrow_b = element_rect(&rt, "huge-bottom");
    assert!(narrow_b[3] > 1800.0, "got {}", narrow_b[3]);
    let deep_b = -(narrow_b[3] - 30.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("huge-bottom", deep_b);
        tx.instant();
    });
    settle(&mut rt);
    assert!(
        !rt.scroll_at_bottom("history").unwrap_or(true),
        "must start above bottom before rotation"
    );
    resize(&mut rt, (844.0, 390.0));
    let history_b = element_rect(&rt, "history");
    let wide_b = element_rect(&rt, "huge-bottom");
    assert!(
        wide_b[1] < history_b[1]
            && (((wide_b[1] + wide_b[3]) - (history_b[1] + 24.0)).abs() <= 4.0
                || (rt.scroll_at_bottom("history") == Some(true)
                    && wide_b[1] + wide_b[3] >= history_b[1] + 20.0)),
        "bottom-clamped rotation rescue must clamp huge-bottom near 24px visible (not offset 0): wide={wide_b:?}, history={history_b:?}"
    );

    // 8. Focused composer WITH an active permission dock, open left sidebar and scrolled history
    // must auto-scroll into view when shrinking 720x320 -> 720x175 (dark=true, scroll_stack=true).
    let mut s = state();
    crate::gallery::shell::fixture(&mut s);
    s.shell.wanted = [Some([true, false]); 2];
    seed_passages(&mut s, 36);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-short".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-short".into(),
        action: "edit".into(),
        resources: (0..12).map(|i| format!("/synthetic/file-{i}.rs")).collect(),
        message: "Approve synthetic edit".into(),
        supported: true,
    });
    ui.reasons.insert("perm-short".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 320.0), Env::new(true, 1.0));
    // Simulate Event::Connected renewing input_scope before the initial Action::Layout arrives.
    rt.frame(0.02);
    rt.update(|s, _| s.renew_scope());
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-25", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    // Scroll session-stack with wheel so composer sits in the lower half of 720x320.
    let stack0 = element_rect(&rt, "session-stack");
    let comp0 = element_rect(&rt, "composer");
    let dy = (comp0[1] - (stack0[1] + stack0[3] - comp0[3] - 12.0)).max(0.0);
    rt.wheel(
        stack0[0] + stack0[2] * 0.5,
        stack0[1] + stack0[3] - 10.0,
        -dy,
    );
    settle(&mut rt);
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    rt.paste("Brouillon permission\nLigne 2\nLigne 3");
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    let stack_before = element_rect(&rt, "session-stack");
    let comp_before = element_rect(&rt, "composer");
    resize(&mut rt, (720.0, 175.0));
    assert!(rt.state.draft.focused);
    let stack_after = element_rect(&rt, "session-stack");
    let comp_after = element_rect(&rt, "composer");
    assert!(
        comp_after[1] < stack_after[1] + stack_after[3] - 20.0
            && comp_after[1] + comp_after[3] > stack_after[1] + 20.0,
        "focused composer must stay visible after shrink with active permission: before={comp_before:?}/{stack_before:?}, after={comp_after:?}/{stack_after:?}"
    );

    // 9. Simultaneous Event::Connected scope renewal during portrait->landscape rotation must
    // still restore and clamp a shortened long paragraph instead of leaving it offscreen.
    let mut s = state();
    seed_passages(&mut s, 10);
    s.messages.push(
        crate::Message {
            usage: None,
            id: "reconnect-long".into(),
            role: "assistant".into(),
            completed: true,
            body: "Long wrapping paragraph rotated while Event::Connected renews input_scope. "
                .repeat(12),
            parts: vec![],
        }
        .into(),
    );
    for i in 10..40 {
        s.messages.push(
            crate::Message {
                usage: None,
                id: format!("reconnect-tail-{i:02}"),
                role: "assistant".into(),
                completed: true,
                body: format!("Trailing passage {i} below reconnect-long."),
                parts: vec![],
            }
            .into(),
        );
    }
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("reconnect-long", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let narrow_r = element_rect(&rt, "reconnect-long");
    assert!(narrow_r[3] > 200.0, "got {}", narrow_r[3]);
    let deep_r = -(narrow_r[3] - 24.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("reconnect-long", deep_r);
        tx.instant();
    });
    settle(&mut rt);
    // Renew input_scope right before the resize frame delivers Action::Layout("history")
    // without rebuilding the tree first, simulating Event::Connected mid-rotation.
    rt.update(|s, _| s.renew_scope());
    resize(&mut rt, (844.0, 390.0));
    // Allow animated width-spring resize triggered by non-instant renew_scope() to rest.
    settle(&mut rt);
    let history_r = element_rect(&rt, "history");
    let wide_r = element_rect(&rt, "reconnect-long");
    assert!(
        wide_r[1] < history_r[1] && ((wide_r[1] + wide_r[3]) - (history_r[1] + 24.0)).abs() <= 4.0,
        "rotation during Event::Connected scope renewal must clamp reconnect-long near 24px visible: wide={wide_r:?}, history={history_r:?}"
    );
}

fn ultra_short_touch_drag_cases_10_to_13() {
    // 10. A wheel gesture arriving AFTER a single frame of a height-only shrink (while
    // Action::Layout is still queued) must NOT be cancelled back to passage-12.
    let mut s = state();
    seed_passages(&mut s, 36);
    let mut rt = Runtime::new(s, view, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-12", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    rt.set_viewport((390.0, 514.0), 1.0);
    // Single frame only: Action::Layout("history") is queued for the next frame.
    rt.frame(0.02);
    let hist_mid = element_rect(&rt, "history");
    let before_mid_p14 = element_rect(&rt, "passage-14")[1] - hist_mid[1];
    assert!(before_mid_p14 > 20.0);
    rt.wheel(
        hist_mid[0] + hist_mid[2] * 0.5,
        hist_mid[1] + hist_mid[3] * 0.5,
        -(before_mid_p14 + 4.0),
    );
    settle(&mut rt);
    let after_mid_p14 = element_rect(&rt, "passage-14")[1] - element_rect(&rt, "history")[1];
    assert!(
        after_mid_p14 < 12.0,
        "mid-resize wheel gesture must advance to passage-14 without reverting to passage-12: {before_mid_p14} -> {after_mid_p14}"
    );

    // 11. Mid-rotation wheel gesture (320x720 -> 844x390, single frame, then wheel to passage-14
    // before Layout(history) delivers) must NOT revert back to passage-12.
    let mut s = state();
    seed_passages(&mut s, 36);
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-12", -12.0);
        tx.instant();
    });
    settle(&mut rt);
    rt.set_viewport((844.0, 390.0), 1.0);
    rt.frame(0.02);
    let hist_rot = element_rect(&rt, "history");
    let before_rot_p14 = element_rect(&rt, "passage-14")[1] - hist_rot[1];
    assert!(before_rot_p14 > 20.0);
    rt.wheel(
        hist_rot[0] + hist_rot[2] * 0.5,
        hist_rot[1] + hist_rot[3] * 0.5,
        -(before_rot_p14 + 4.0),
    );
    settle(&mut rt);
    let after_rot_p14 = element_rect(&rt, "passage-14")[1] - element_rect(&rt, "history")[1];
    assert!(
        after_rot_p14 < 12.0,
        "mid-rotation wheel gesture must advance to passage-14 without reverting to passage-12: {before_rot_p14} -> {after_rot_p14}"
    );

    // 12. Width-only shrink without interruption that wraps agent-panel onto 2 lines and flips
    // scroll_stack false -> true at unchanged stack height must auto-scroll focused composer into view.
    let mut s = state();
    seed_passages(&mut s, 20);
    let ui = s.agent.as_mut().unwrap();
    ui.models.push(Model {
        reference: serde_json::json!("m-wrap-12"),
        label: "Model · Long Name For Wrap".into(),
        included: true,
    });
    ui.current = Some(serde_json::json!("m-wrap-12"));
    let mut rt = Runtime::new(s, view, (720.0, 260.0), Env::new(false, 1.0));
    settle(&mut rt);
    let stack_wide = element_rect(&rt, "session-stack");
    let header_h = 260.0 - stack_wide[3];
    let controls_wide = element_rect(&rt, "transcript-controls")[3];
    let agent_wide = element_rect(&rt, "agent-panel");
    let comp_wide = element_rect(&rt, "session-composer");
    let field_wide = element_rect(&rt, "composer");
    // Measure narrow wrapped agent-panel + composer chrome to choose an exact height where
    // wide (1-row agent-panel) has scroll_stack=false and narrow (2-row agent-panel) flips scroll_stack=true.
    resize(&mut rt, (180.0, 260.0));
    let agent_narrow = element_rect(&rt, "agent-panel");
    let comp_narrow = element_rect(&rt, "session-composer");
    let field_narrow = element_rect(&rt, "composer");
    let chrome_wide = comp_wide[3] - field_wide[3];
    let chrome_narrow = comp_narrow[3] - field_narrow[3];
    assert!(
        agent_narrow[3] + chrome_narrow > agent_wide[3] + chrome_wide + 20.0,
        "narrow width must wrap chrome taller: wide={}/{}, narrow={}/{}",
        agent_wide[3],
        chrome_wide,
        agent_narrow[3],
        chrome_narrow
    );
    let target_stack_h = controls_wide + agent_wide[3] + chrome_wide + 52.0;
    let target_h = header_h + target_stack_h;
    assert!(
        target_stack_h - controls_wide - agent_narrow[3] - chrome_narrow < 44.0,
        "target_stack_h={target_stack_h} must enter scroll_stack when narrowed"
    );
    resize(&mut rt, (720.0, target_h));
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    assert!(rt.scroll_at_bottom("session-stack").is_none());
    // Shrink WIDTH ONLY at the exact same height.
    resize(&mut rt, (180.0, target_h));
    assert!(rt.state.draft.focused);
    assert!(rt.scroll_at_bottom("session-stack").is_some());
    let stack_w_after = element_rect(&rt, "session-stack");
    let comp_w_after = element_rect(&rt, "composer");
    assert!(
        comp_w_after[1] < stack_w_after[1] + stack_w_after[3] - 16.0
            && comp_w_after[1] + comp_w_after[3] > stack_w_after[1] + 16.0,
        "width-only shrink flipping scroll_stack must reveal focused composer: comp={comp_w_after:?}, stack={stack_w_after:?}"
    );

    // 13. Real Event::Connected delivered via poll_chat during rotation preserves rescue/clamp.
    let mut s = state();
    crate::gallery::shell::fixture(&mut s);
    s.messages.clear();
    seed_passages(&mut s, 10);
    s.messages.push(
        crate::Message {
            usage: None,
            id: "connected-long".into(),
            role: "assistant".into(),
            completed: true,
            body: "Long wrapping paragraph rotated across a real poll_chat Event::Connected. "
                .repeat(12),
            parts: vec![],
        }
        .into(),
    );
    for i in 10..40 {
        s.messages.push(
            crate::Message {
                usage: None,
                id: format!("connected-tail-{i:02}"),
                role: "assistant".into(),
                completed: true,
                body: format!("Trailing passage {i} below connected-long."),
                parts: vec![],
            }
            .into(),
        );
    }
    let (events_tx, incoming_rx) = bounded(4);
    s.incoming = Some(incoming_rx);
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("connected-long", 0.0);
        tx.instant();
    });
    settle(&mut rt);
    let narrow_c = element_rect(&rt, "connected-long");
    assert!(narrow_c[3] > 200.0, "got {}", narrow_c[3]);
    let deep_c = -(narrow_c[3] - 24.0);
    rt.update(move |_, tx| {
        tx.scroll_key_to("connected-long", deep_c);
        tx.instant();
    });
    settle(&mut rt);
    let scope_before = rt.state.input_scope.clone();
    let backend =
        crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").expect("synthetic backend");
    events_tx
        .try_send(crate::transport::Event::Connected(backend))
        .unwrap();
    rt.update(|s, _| {
        assert!(crate::poll_chat(s, 4));
        assert!(!s.current_scope(&scope_before));
    });
    resize(&mut rt, (844.0, 390.0));
    settle(&mut rt);
    let history_c = element_rect(&rt, "history");
    let wide_c = element_rect(&rt, "connected-long");
    assert!(
        wide_c[1] < history_c[1] && ((wide_c[1] + wide_c[3]) - (history_c[1] + 24.0)).abs() <= 4.0,
        "real Event::Connected during rotation must clamp connected-long near 24px visible: wide={wide_c:?}, history={history_c:?}"
    );
}

fn ultra_short_touch_drag_cases_14_to_17() {
    // 14. Active permission dock with agent control error reserves space for agent-error so
    // allow_once / allow_always / reject stay unclipped on short viewports.
    let mut s = state();
    seed_passages(&mut s, 12);
    let ui = s.agent.as_mut().unwrap();
    ui.error = true;
    ui.selected = "perm-err".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-err".into(),
        action: "edit".into(),
        resources: (0..12).map(|i| format!("/synthetic/err-{i}.rs")).collect(),
        message: "Approve synthetic edit with error banner".into(),
        supported: true,
    });
    ui.reasons.insert("perm-err".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (360.0, 260.0), Env::new(false, 1.0));
    settle(&mut rt);
    for key in ["agent-error", "allow_once", "allow_always", "reject"] {
        reveal(&mut rt, key);
    }

    // 15. A live streaming SSE arrival through poll_chat during bottom-clamped resize restoration
    // must still restore passage-28 immediately on Frame 2, and a manual wheel scroll right after
    // Frame 2 must never be overwritten by any delayed confirmation probe.
    let mut s = state();
    seed_passages(&mut s, 36);
    let (sse_tx, sse_rx) = bounded(8);
    s.incoming = Some(sse_rx);
    let mut rt = Runtime::new(s, view, (390.0, 420.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.scroll_key_to("passage-28", -6.0);
        tx.instant();
    });
    settle(&mut rt);
    let sse_before = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!((sse_before + 6.0).abs() <= 2.0);
    resize(&mut rt, (390.0, 1600.0));
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    rt.set_viewport((390.0, 420.0), 1.0);
    rt.frame(0.02); // Frame 1: relayout at 420, queues Action::Layout("history")
    for event in [
        crate::transport::Event::Message(crate::Message {
            usage: None,
            id: "sse-live-arrival".into(),
            role: "assistant".into(),
            completed: false,
            body: String::new(),
            parts: vec![],
        }),
        crate::transport::Event::Text(
            "sse-live-arrival".into(),
            crate::content::TextEvent::Start { ordinal: Some(0) },
        ),
        crate::transport::Event::Text(
            "sse-live-arrival".into(),
            crate::content::TextEvent::Delta {
                ordinal: Some(0),
                text: "Live streaming SSE chunk arriving during resize restore.\nLine two grows the tail.".into(),
            },
        ),
    ] {
        sse_tx.try_send(event).unwrap();
    }
    rt.update(|s, _| {
        assert!(crate::poll_chat(s, 8));
    });
    rt.frame(0.02); // Frame 2: Layout(history) restores passage-28 directly without Frame-3 probe
    let sse_after = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!(
        (sse_after - sse_before).abs() <= 2.0,
        "streaming SSE arrival via poll_chat must not lose passage-28 anchor: before={sse_before}, after={sse_after}"
    );
    // Manual scroll immediately after Frame 2 must stick and never be reverted by a stale callback.
    let hist_sse = element_rect(&rt, "history");
    rt.wheel(
        hist_sse[0] + hist_sse[2] * 0.5,
        hist_sse[1] + hist_sse[3] * 0.5,
        140.0,
    );
    settle(&mut rt);
    let after_manual = element_rect(&rt, "passage-28")[1] - element_rect(&rt, "history")[1];
    assert!(
        after_manual > sse_after + 60.0,
        "manual scroll after bottom-clamped resize restore must not be overwritten: sse_after={sse_after}, after_manual={after_manual}"
    );

    // 16. Shrinking a focused 10-line composer to 44px without outer stack scroll (fieldSpace ~= 90)
    // must scroll the inner composer viewport so the active caret on the last line stays visible.
    let mut s = state();
    seed_passages(&mut s, 20);
    let mut rt = Runtime::new(s, view, (720.0, 560.0), Env::new(false, 1.0));
    settle(&mut rt);
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    let ten_lines = (1..=10)
        .map(|i| format!("Composer caret line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    rt.paste(&ten_lines);
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    let comp_tall = element_rect(&rt, "composer");
    assert!(
        comp_tall[3] > 140.0,
        "10-line draft should expand composer, got {}",
        comp_tall[3]
    );
    let header_c = 560.0 - element_rect(&rt, "session-stack")[3];
    let agent_c = element_rect(&rt, "agent-panel")[3];
    let comp_chrome_c = element_rect(&rt, "session-composer")[3] - comp_tall[3];
    // Target fieldSpace = 90px -> scroll_stack = false, composer max_h = 44px.
    let short_caret_h = header_c + agent_c + comp_chrome_c + 90.0;
    resize(&mut rt, (720.0, short_caret_h));
    assert!(rt.state.draft.focused);
    assert!(
        rt.scroll_at_bottom("session-stack").is_none(),
        "fieldSpace ~= 90px must keep outer session-stack non-scrolling"
    );
    let comp_short = element_rect(&rt, "composer");
    assert!(
        (comp_short[3] - 44.0).abs() <= 4.0,
        "composer should clamp to ~44px, got {}",
        comp_short[3]
    );
    let (scroll_y, scroll_max) = rt.state.tool_diff_preferences.composer_scroll.get();
    assert!(
        scroll_max > 80.0 && scroll_y >= scroll_max - 12.0,
        "inner composer scroller must scroll to keep the last-line caret visible: scroll_y={scroll_y}, scroll_max={scroll_max}"
    );
    // Resuming typing must not trigger a corrective caret jump: the caret is already visible.
    rt.paste("!");
    settle(&mut rt);
    let (scroll_after_type, _) = rt.state.tool_diff_preferences.composer_scroll.get();
    assert!(
        (scroll_after_type - scroll_y).abs() <= 1.0,
        "typing after shrink must not jump inner composer scroll: before={scroll_y}, after={scroll_after_type}"
    );

    // 17. Width-only shrink while scroll_stack is ALREADY true (active permission + long model label)
    // must keep the focused composer scrolled into view even when the dock wraps taller.
    let mut s = state();
    seed_passages(&mut s, 20);
    let ui = s.agent.as_mut().unwrap();
    ui.models.push(crate::agent_api::Model {
        reference: "provider/very-long-model-name-for-wrapping".into(),
        label: "provider · Very Long Model Name That Wraps Narrow Dock".into(),
        included: true,
    });
    ui.current = Some("provider/very-long-model-name-for-wrapping".into());
    ui.selected = "perm-wrap".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-wrap".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/wrap.rs".into()],
        message: "Approve synthetic wrap".into(),
        supported: true,
    });
    ui.reasons.insert("perm-wrap".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 260.0), Env::new(false, 1.0));
    settle(&mut rt);
    let stack_720 = element_rect(&rt, "session-stack");
    let comp_720 = element_rect(&rt, "composer");
    // Scroll outer session-stack so the composer sits near the bottom edge, then focus it.
    let dy = (comp_720[1] - (stack_720[1] + stack_720[3] - comp_720[3] - 4.0)).max(0.0);
    rt.update(|_, tx| {
        tx.scroll_to_y("session-stack", dy);
        tx.instant();
    });
    settle(&mut rt);
    let comp_720_visible = element_rect(&rt, "composer");
    assert!(
        comp_720_visible[1] + comp_720_visible[3] <= stack_720[1] + stack_720[3] + 2.0
            && comp_720_visible[1] >= stack_720[1] + stack_720[3] - comp_720_visible[3] - 16.0,
        "composer should sit near the bottom edge before narrowing: comp={comp_720_visible:?}, stack={stack_720:?}"
    );
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    assert!(rt.scroll_at_bottom("session-stack").is_some());
    let dock_before = element_rect(&rt, "agent-panel");
    // Shrink WIDTH ONLY at the exact same height so the dock action bar wraps onto extra rows.
    resize(&mut rt, (320.0, 260.0));
    assert!(rt.state.draft.focused);
    let dock_after = element_rect(&rt, "agent-panel");
    assert!(
        dock_after[3] > dock_before[3] + 10.0,
        "narrowing must wrap dock chrome taller: before={}, after={}",
        dock_before[3],
        dock_after[3]
    );
    let stack_320 = element_rect(&rt, "session-stack");
    let comp_320 = element_rect(&rt, "composer");
    assert!(
        comp_320[1] < stack_320[1] + stack_320[3] - 20.0
            && comp_320[1] + comp_320[3] > stack_320[1] + 20.0,
        "width-only shrink while scroll_stack is already true must keep focused composer visible: comp={comp_320:?}, stack={stack_320:?}"
    );
}

#[test]
fn focused_interruption_and_composer_caret_follow_viewport_changes() {
    // 18. Focused interruption question field near the bottom of pending-content must stay visible
    // inside both its inner dock scroller and the viewport when the keyboard shrinks 320x720 -> 320x420.
    let mut s = state();
    seed_passages(&mut s, 16);
    let form = Form {
        tool: None,
        infer_websearch: false, owner: Default::default(),
        id: "q-focus".into(),
        title: "Scrollable question with multiple fields".into(),
        fields: (0..6)
            .map(|i| {
                json!({
                    "key": format!("q{i}"),
                    "title": format!("Question field {i} with enough label text to stretch the dock."),
                    "type": "string"
                })
            })
            .collect(),
    };
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "q-focus".into();
    ui.forms.push(form);
    agent_forms::seed(&ui.forms, &mut ui.drafts);
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    reveal(&mut rt, "field-q5");
    let (fx, fy) = rt.find("field-q5").unwrap();
    rt.pointer_down(fx, fy);
    rt.pointer_up(fx, fy);
    settle(&mut rt);
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("q-focus".into(), "q5".into()))
            .is_some_and(|d| d.edit.focused),
        "field-q5 should be focused before keyboard shrink"
    );
    resize(&mut rt, (320.0, 420.0));
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("q-focus".into(), "q5".into()))
            .is_some_and(|d| d.edit.focused),
        "field-q5 should retain focus across keyboard shrink"
    );
    let region_420 = element_rect(&rt, "pending-content-q-focus");
    let field_420 = element_rect(&rt, "field-q5");
    assert!(
        field_420[1] >= region_420[1] - 1.0
            && field_420[1] + field_420[3] <= region_420[1] + region_420[3] + 1.0
            && field_420[1] + field_420[3] <= 420.5,
        "focused interruption field must stay visible after keyboard shrink: field={field_420:?}, region={region_420:?}"
    );

    // 19. A live permission arriving while the keyboard is already open on a scrolling 720x160 stack
    // must re-reveal the focused composer even when session-stack dimensions do not change.
    let mut s = state();
    seed_passages(&mut s, 16);
    let mut rt = Runtime::new(s, view, (720.0, 160.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(rt.scroll_at_bottom("session-stack").is_some());
    reveal(&mut rt, "composer");
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    rt.update(|s, _| {
        let ui = s.agent.as_mut().unwrap();
        ui.selected = "perm-live".into();
        ui.permissions.push(Permission {
            tool: None,
            id: "perm-live".into(),
            action: "edit".into(),
            resources: (0..4).map(|i| format!("/synthetic/live-{i}.rs")).collect(),
            message: "Live permission arriving while keyboard is open".into(),
            supported: true,
        });
        ui.reasons.insert("perm-live".into(), TextEdit::new(""));
        s.revision += 1;
    });
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    let stack_live = element_rect(&rt, "session-stack");
    let comp_live = element_rect(&rt, "composer");
    assert!(
        comp_live[1] < stack_live[1] + stack_live[3] - 20.0
            && comp_live[1] + comp_live[3] > stack_live[1] + 20.0,
        "live permission arriving with open keyboard must keep focused composer visible: comp={comp_live:?}, stack={stack_live:?}"
    );

    // 20. Ctrl+Home arriving in the exact frame that executes the deferred composer-caret probe
    // must keep line 1 visible instead of being overwritten by the stale bottom scroll_to_y.
    let mut s = state();
    seed_passages(&mut s, 20);
    let mut rt = Runtime::new(s, view, (720.0, 560.0), Env::new(false, 1.0));
    settle(&mut rt);
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    let ten_lines = (1..=10)
        .map(|i| format!("Caret race line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    rt.paste(&ten_lines);
    settle(&mut rt);
    let comp_tall_20 = element_rect(&rt, "composer");
    let header_20 = 560.0 - element_rect(&rt, "session-stack")[3];
    let agent_20 = element_rect(&rt, "agent-panel")[3];
    let comp_chrome_20 = element_rect(&rt, "session-composer")[3] - comp_tall_20[3];
    let short_h_20 = header_20 + agent_20 + comp_chrome_20 + 90.0;
    rt.set_viewport((720.0, short_h_20), 1.0);
    rt.frame(0.02); // Frame 1: relayout composer to 44px, queues Action::Layout("composer")
    rt.frame(0.02); // Frame 2: composer_field_layout arms reveal_composer_caret & mounts probe
    let ctrl_home = rune::KeyEvent {
        key: rune::Key::Home,
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    rt.key(ctrl_home.clone());
    rt.key_up(ctrl_home);
    // Verify on the very first frame processing Ctrl+Home (zero 1-frame jump to bottom).
    rt.frame(0.02);
    assert_eq!(rt.state.draft.range(), (0, 0));
    let (scroll_top_f3, scroll_max_f3) = rt.state.tool_diff_preferences.composer_scroll.get();
    let comp_f3 = element_rect(&rt, "composer");
    let caret_f3 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret on Ctrl+Home frame");
    assert!(
        scroll_max_f3 > 80.0
            && scroll_top_f3 <= 10.0
            && caret_f3[1] >= comp_f3[1] - 1.0
            && caret_f3[1] + caret_f3[3] <= comp_f3[1] + comp_f3[3] + 1.0,
        "Ctrl+Home during caret probe must keep line 1 caret visible on its very first frame: scroll_y={scroll_top_f3}, scroll_max={scroll_max_f3}, caret={caret_f3:?}, comp={comp_f3:?}"
    );
    settle(&mut rt);
    let (scroll_top, scroll_max_20) = rt.state.tool_diff_preferences.composer_scroll.get();
    let comp_20 = element_rect(&rt, "composer");
    let caret_20 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret");
    assert!(
        scroll_max_20 > 80.0
            && scroll_top <= 10.0
            && caret_20[1] >= comp_20[1] - 1.0
            && caret_20[1] + caret_20[3] <= comp_20[1] + comp_20[3] + 1.0,
        "Ctrl+Home during caret probe must keep line 1 caret visible at top: scroll_y={scroll_top}, scroll_max={scroll_max_20}, caret={caret_20:?}, comp={comp_20:?}"
    );

    // 21. Shrinking session-stack below the 44px composer height (to 28px) must keep the caret
    // unclipped on resize AND across subsequent Ctrl+End / Ctrl+Home navigation without fighting
    // manual session-stack scrolling.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-ultra-caret".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-ultra-caret".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/ultra.rs".into()],
        message: "Approve synthetic ultra-short caret test".into(),
        supported: true,
    });
    ui.reasons
        .insert("perm-ultra-caret".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 320.0), Env::new(false, 1.0));
    settle(&mut rt);
    reveal(&mut rt, "composer");
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    let ten_lines_21 = (1..=10)
        .map(|i| format!("Ultra caret line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    rt.paste(&ten_lines_21);
    settle(&mut rt);
    let ctrl_home = rune::KeyEvent {
        key: rune::Key::Home,
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    let ctrl_end = rune::KeyEvent {
        key: rune::Key::End,
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    rt.key(ctrl_home.clone());
    rt.key_up(ctrl_home.clone());
    settle(&mut rt);
    assert_eq!(rt.state.draft.range(), (0, 0));
    let header_21 = 320.0 - element_rect(&rt, "session-stack")[3];
    resize(&mut rt, (720.0, header_21 + 28.0));
    assert!(rt.state.draft.focused);
    let stack_28 = element_rect(&rt, "session-stack");
    assert!(
        stack_28[3] <= 30.0,
        "expected ~28px stack, got {stack_28:?}"
    );
    let caret_28 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret");
    assert!(
        caret_28[1] >= stack_28[1] - 1.0
            && caret_28[1] + caret_28[3] <= stack_28[1] + stack_28[3] + 1.0,
        "line-1 caret must stay unclipped inside 28px session-stack: caret={caret_28:?}, stack={stack_28:?}"
    );
    // Navigate to line 10 after stabilization: session-stack must follow the caret.
    rt.key(ctrl_end.clone());
    rt.key_up(ctrl_end);
    settle(&mut rt);
    let end_len = rt.state.draft.text.len();
    assert_eq!(rt.state.draft.range(), (end_len, end_len));
    let caret_end_28 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret after Ctrl+End");
    assert!(
        caret_end_28[1] >= stack_28[1] - 1.0
            && caret_end_28[1] + caret_end_28[3] <= stack_28[1] + stack_28[3] + 1.0,
        "line-10 caret after Ctrl+End must stay unclipped inside 28px session-stack: caret={caret_end_28:?}, stack={stack_28:?}"
    );
    // Navigate back to line 1: session-stack must follow back up.
    rt.key(ctrl_home.clone());
    rt.key_up(ctrl_home);
    settle(&mut rt);
    assert_eq!(rt.state.draft.range(), (0, 0));
    let caret_home_28 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret after Ctrl+Home");
    assert!(
        caret_home_28[1] >= stack_28[1] - 1.0
            && caret_home_28[1] + caret_home_28[3] <= stack_28[1] + stack_28[3] + 1.0,
        "line-1 caret after Ctrl+Home must stay unclipped inside 28px session-stack: caret={caret_home_28:?}, stack={stack_28:?}"
    );
    // Manual wheel scrolling up inside session-stack must not be fought by caret follow.
    let stack_y_before_wheel = rt.state.tool_diff_preferences.stack_scroll.get().0;
    rt.wheel(stack_28[0] + 4.0, stack_28[1] + 4.0, 80.0);
    settle(&mut rt);
    let stack_y_after_wheel = rt.state.tool_diff_preferences.stack_scroll.get().0;
    assert!(
        stack_y_after_wheel < stack_y_before_wheel - 20.0,
        "manual stack wheel must stay scrolled up: before={stack_y_before_wheel}, after={stack_y_after_wheel}"
    );
    // Wrapping IME preedit composition (without committing) must also keep the caret unclipped
    // inside the 28px session-stack.
    let preedit =
        "日本語の変換前テキストが複数行に折り返される長い入力候補の検証用文字列です。".repeat(3);
    let end = preedit.len();
    rt.ime(rune::Ime::Preedit(preedit, Some((end, end)), vec![]));
    settle(&mut rt);
    let stack_ime = element_rect(&rt, "session-stack");
    let caret_ime = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer input must expose a drawn caret during IME preedit");
    assert!(
        caret_ime[1] >= stack_ime[1] - 1.0
            && caret_ime[1] + caret_ime[3] <= stack_ime[1] + stack_ime[3] + 1.0,
        "wrapping IME preedit caret must stay unclipped inside 28px session-stack: caret={caret_ime:?}, stack={stack_ime:?}"
    );
    // Commit / clear preedit, then test selection inversion (Ctrl+End -> Ctrl+Shift+Home -> Ctrl+A):
    // sorted range() stays (0, len) while active caret moves from line 1 to line 10.
    rt.ime(rune::Ime::Preedit(String::new(), None, vec![]));
    settle(&mut rt);
    let ctrl_end_2 = rune::KeyEvent {
        key: rune::Key::End,
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    let ctrl_shift_home = rune::KeyEvent {
        key: rune::Key::Home,
        mods: rune::Mods {
            ctrl: true,
            shift: true,
            ..rune::Mods::default()
        },
    };
    let ctrl_a = rune::KeyEvent {
        key: rune::Key::Command('a'),
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    rt.key(ctrl_end_2.clone());
    rt.key_up(ctrl_end_2);
    settle(&mut rt);
    rt.key(ctrl_shift_home.clone());
    rt.key_up(ctrl_shift_home);
    settle(&mut rt);
    let len_inv = rt.state.draft.text.len();
    assert_eq!((rt.state.draft.anchor, rt.state.draft.focus), (len_inv, 0));
    rt.key(ctrl_a.clone());
    rt.key_up(ctrl_a);
    settle(&mut rt);
    assert_eq!((rt.state.draft.anchor, rt.state.draft.focus), (0, len_inv));
    let stack_inv = element_rect(&rt, "session-stack");
    let caret_inv = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer must expose drawn caret after Ctrl+A inversion");
    assert!(
        caret_inv[1] >= stack_inv[1] - 1.0
            && caret_inv[1] + caret_inv[3] <= stack_inv[1] + stack_inv[3] + 1.0,
        "Ctrl+A selection inversion must scroll 28px session-stack to reveal line-10 caret: caret={caret_inv:?}, stack={stack_inv:?}"
    );

    // Same-length single-operation replacement ("abcdefghi" -> "abcd\nefgh", cursor stays at 9)
    // must still trigger outer stack caret reveal when caret moves to line 2.
    let ctrl_a_2 = rune::KeyEvent {
        key: rune::Key::Command('a'),
        mods: rune::Mods {
            ctrl: true,
            ..rune::Mods::default()
        },
    };
    rt.key(ctrl_a_2.clone());
    rt.key_up(ctrl_a_2.clone());
    settle(&mut rt);
    rt.paste("abcdefghi");
    settle(&mut rt);
    assert_eq!(rt.state.draft.text, "abcdefghi");
    assert_eq!((rt.state.draft.anchor, rt.state.draft.focus), (9, 9));
    let comp_same = element_rect(&rt, "composer");
    let stack_same0 = element_rect(&rt, "session-stack");
    let cur_sy = rt.state.tool_diff_preferences.stack_scroll.get().0;
    // Align composer top near stack top so only line 1 fits inside the 28px stack.
    let align_dy = comp_same[1] - stack_same0[1];
    rt.update(move |_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", (cur_sy + align_dy).max(0.0));
    });
    settle(&mut rt);
    rt.key(ctrl_a_2.clone());
    rt.key_up(ctrl_a_2);
    rt.paste("abcd\nefgh");
    settle(&mut rt);
    assert_eq!(rt.state.draft.text, "abcd\nefgh");
    assert_eq!((rt.state.draft.anchor, rt.state.draft.focus), (9, 9));
    let stack_same = element_rect(&rt, "session-stack");
    let caret_same = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("focused composer must expose drawn caret after same-length newline replacement");
    assert!(
        caret_same[1] >= stack_same[1] - 1.0
            && caret_same[1] + caret_same[3] <= stack_same[1] + stack_same[3] + 1.0,
        "same-length replacement moving caret to line 2 must stay unclipped in 28px session-stack: caret={caret_same:?}, stack={stack_same:?}"
    );
}

#[test]
fn wheel_after_bottom_clamped_resize_and_dynamic_dock_reveals() {
    // 22. A manual wheel gesture between Frame 1 and Frame 2 after a bottom-clamped resize must
    // win over the saved anchor (both for headless rt.wheel and real host wheel_event).
    let top_passage_key = |rt: &Runtime<State>| -> Option<String> {
        let hist = element_rect(rt, "history");
        let probe = hist[1] + 0.5;
        rt.elements().into_iter().find_map(|e| {
            let key = e.key?;
            (key.starts_with("passage-")
                && e.rect[3] > 0.0
                && e.rect[1] <= probe
                && e.rect[1] + e.rect[3] > probe)
                .then_some(key)
        })
    };
    let mut landed = Vec::new();
    for use_wheel_event in [false, true] {
        let mut s = state();
        seed_passages(&mut s, 32);
        let mut rt = Runtime::new(s, view, (390.0, 420.0), Env::new(false, 1.0));
        settle(&mut rt);
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("passage-28", -12.0);
        });
        settle(&mut rt);
        assert_eq!(top_passage_key(&rt).as_deref(), Some("passage-28"));
        resize(&mut rt, (390.0, 1600.0));
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
        rt.set_viewport((390.0, 420.0), 1.0);
        rt.frame(0.02); // Frame 1: bottom-stuck layout at 390x420, queues Action::Layout("history")
        let hist_22 = element_rect(&rt, "history");
        let (hx, hy) = (hist_22[0] + hist_22[2] / 2.0, hist_22[1] + hist_22[3] / 2.0);
        if use_wheel_event {
            rt.wheel_event(rune::WheelEvent::new(0.0, 220.0).at(hx, hy));
            rt.frame(0.02); // Frame 2 itself must apply the user's wheel (0-frame blip)
            assert_eq!(
                rt.scroll_at_bottom("history"),
                Some(false),
                "wheel_event between Frame 1 and Frame 2 must leave bottom on Frame 2"
            );
            let f2_top = top_passage_key(&rt).expect("visible passage on Frame 2");
            assert_ne!(
                f2_top, "passage-28",
                "wheel_event between Frame 1 and Frame 2 must not snap back to passage-28 on Frame 2: {f2_top:?}"
            );
        } else {
            rt.wheel(hx, hy, 220.0);
        }
        settle(&mut rt);
        let after_22 = top_passage_key(&rt).expect("visible passage after settle");
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        assert_ne!(
            after_22, "passage-28",
            "manual wheel between Frame 1 and Frame 2 (wheel_event={use_wheel_event}) must not be overwritten by passage-28: {after_22:?}"
        );
        landed.push(after_22);
    }
    assert_eq!(
        landed[0], landed[1],
        "rt.wheel and wheel_event must settle on the same passage: {landed:?}"
    );

    // 22b. Downward wheel at the bottom boundary of history between Frame 1 and Frame 2 on a
    // scrollable session-stack must chain to session-stack (not swallow the wheel) and must not
    // snap history back to passage-28.
    let mut s = state();
    seed_passages(&mut s, 32);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-22b".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-22b".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/22b.rs".into()],
        message: "Boundary wheel chaining test".into(),
        supported: true,
    });
    ui.reasons.insert("perm-22b".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (390.0, 260.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("passage-28", -12.0);
    });
    settle(&mut rt);
    assert_eq!(top_passage_key(&rt).as_deref(), Some("passage-28"));
    resize(&mut rt, (390.0, 1600.0));
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    rt.set_viewport((390.0, 260.0), 1.0);
    rt.frame(0.02); // Frame 1: bottom-stuck history on scrollable session-stack, queues Layout
    let hist_22b = element_rect(&rt, "history");
    let stack_before_22b = rt.state.tool_diff_preferences.stack_scroll.get().0;
    rt.wheel_event(rune::WheelEvent::new(0.0, -120.0).at(
        hist_22b[0] + hist_22b[2] / 2.0,
        hist_22b[1] + hist_22b[3] / 2.0,
    ));
    settle(&mut rt);
    let stack_after_22b = rt.state.tool_diff_preferences.stack_scroll.get().0;
    assert!(
        stack_after_22b > stack_before_22b + 20.0,
        "downward wheel at bottom boundary of history must chain to session-stack: before={stack_before_22b}, after={stack_after_22b}"
    );
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(true),
        "downward wheel at bottom boundary must keep history at bottom instead of snapping back to passage-28"
    );

    // 23. A second interruption arriving while a permission reason field is focused near the
    // bottom of a 56px session-stack must re-reveal the focused field after prev/next nav mounts.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-r2b3-1".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-r2b3-1".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/r2b3.rs".into()],
        message: "Approve synthetic permission 1".into(),
        supported: true,
    });
    ui.reasons.insert("perm-r2b3-1".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 260.0), Env::new(false, 1.0));
    settle(&mut rt);
    let header_23 = 260.0 - element_rect(&rt, "session-stack")[3];
    resize(&mut rt, (720.0, header_23 + 56.0));
    reveal(&mut rt, "pending-content-perm-r2b3-1");
    reveal(&mut rt, "reason-perm-r2b3-1");
    let (rx, ry) = rt.find("reason-perm-r2b3-1").unwrap();
    rt.pointer_down(rx, ry);
    rt.pointer_up(rx, ry);
    settle(&mut rt);
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .reasons
            .get("perm-r2b3-1")
            .is_some_and(|e| e.focused),
        "reason-perm-r2b3-1 must be focused"
    );
    rt.update(|s, _| {
        let ui = s.agent.as_mut().unwrap();
        ui.permissions.push(Permission {
            tool: None,
            id: "perm-r2b3-2".into(),
            action: "bash".into(),
            resources: vec!["/synthetic/r2b3-2.rs".into()],
            message: "Second permission arrives".into(),
            supported: true,
        });
        ui.reasons.insert("perm-r2b3-2".into(), TextEdit::new(""));
    });
    settle(&mut rt);
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .reasons
            .get("perm-r2b3-1")
            .is_some_and(|e| e.focused),
        "reason-perm-r2b3-1 must retain focus when 2nd permission arrives"
    );
    let stack_23 = element_rect(&rt, "session-stack");
    let reason_23 = element_rect(&rt, "reason-perm-r2b3-1");
    let vis_23 = (reason_23[1] + reason_23[3]).min(stack_23[1] + stack_23[3])
        - reason_23[1].max(stack_23[1]);
    assert!(
        vis_23 >= 20.0,
        "focused permission reason must remain visible in 56px stack after 2nd permission mounts prev/next nav: reason={reason_23:?}, stack={stack_23:?}, vis={vis_23}"
    );

    // 24. Width-only grow that unwraps a 2-row agent bar to 1 row must keep focused model-search
    // visible inside a short session-stack.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.picker = true;
    ui.models = (0..12)
        .map(|i| Model {
            reference: serde_json::json!(format!("m-{i}")),
            label: if i == 0 {
                "Model · Long Name For Wrap".into()
            } else {
                format!("Model {i}")
            },
            included: true,
        })
        .collect();
    // Select a model label long enough to wrap `agent-actions` at 220px and unwrap at 600px
    // regardless of the host OS locale (e.g., English "Model"+"Refresh"+"Stop" fits in 204px).
    ui.current = Some(serde_json::json!("m-0"));
    let mut rt = Runtime::new(s, view, (220.0, 220.0), Env::new(false, 1.0));
    settle(&mut rt);
    let actions_narrow = element_rect(&rt, "agent-actions");
    reveal(&mut rt, "model-search");
    let (mx, my) = rt.find("model-search").unwrap();
    rt.pointer_down(mx, my);
    rt.pointer_up(mx, my);
    settle(&mut rt);
    // Position model-search right at the top of session-stack.
    let stack_24_before = element_rect(&rt, "session-stack");
    let search_24_before = element_rect(&rt, "model-search");
    let cur_stack_y_24 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    let delta_24 = search_24_before[1] - stack_24_before[1];
    rt.update(move |_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", (cur_stack_y_24 + delta_24).max(0.0));
    });
    settle(&mut rt);
    assert!(rt.state.agent.as_ref().unwrap().search.focused);
    resize(&mut rt, (600.0, 220.0));
    let actions_wide = element_rect(&rt, "agent-actions");
    assert!(
        actions_wide[3] < actions_narrow[3] - 4.0,
        "expected agent-actions to unwrap on width grow: narrow={actions_narrow:?}, wide={actions_wide:?}"
    );
    assert!(rt.state.agent.as_ref().unwrap().search.focused);
    let stack_24 = element_rect(&rt, "session-stack");
    let search_24 = element_rect(&rt, "model-search");
    assert!(
        search_24[1] >= stack_24[1] - 1.0
            && search_24[1] + search_24[3] <= stack_24[1] + stack_24[3] + 1.0,
        "focused model-search must remain visible after width-only grow unwraps agent-actions: search={search_24:?}, stack={stack_24:?}"
    );

    // 25. Clearing attachments.error while the composer is focused near the top of a scrolling
    // session-stack must re-reveal the composer instead of clipping its top edge.
    let mut s = state();
    seed_passages(&mut s, 16);
    s.attachments.error = true;
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-r1m3".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-r1m3".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/r1m3.rs".into()],
        message: "Attachment error disappearance test".into(),
        supported: true,
    });
    ui.reasons.insert("perm-r1m3".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (390.0, 220.0), Env::new(false, 1.0));
    settle(&mut rt);
    reveal(&mut rt, "composer");
    let (cx, cy) = rt.find("composer").unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    settle(&mut rt);
    // Position composer right at the top of session-stack while still having room below.
    let stack_25_before = element_rect(&rt, "session-stack");
    let comp_25_before = element_rect(&rt, "composer");
    let cur_stack_y_25 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    let delta_25 = comp_25_before[1] - stack_25_before[1];
    rt.update(move |_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", (cur_stack_y_25 + delta_25).max(0.0));
    });
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    rt.update(|s, _| {
        s.attachments.error = false;
    });
    settle(&mut rt);
    assert!(rt.state.draft.focused);
    let stack_25 = element_rect(&rt, "session-stack");
    let comp_25 = element_rect(&rt, "composer");
    assert!(
        comp_25[1] >= stack_25[1] - 1.0
            && comp_25[1] + comp_25[3] <= stack_25[1] + stack_25[3] + 1.0,
        "focused composer must remain visible when attachment error clears: comp={comp_25:?}, stack={stack_25:?}"
    );

    // 26. Boolean field "q" must not collide with a text field named "q-true" when revealing the
    // focused question field on dock shrink.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "form-r2m1".into();
    let mut fields = vec![serde_json::json!({
        "key": "q",
        "title": "Boolean q",
        "type": "boolean"
    })];
    for i in 0..6 {
        fields.push(serde_json::json!({
            "key": format!("pad{i}"),
            "title": format!("Padding field {i}"),
            "type": "string"
        }));
    }
    fields.push(serde_json::json!({
        "key": "q-true",
        "title": "Text field named q-true",
        "type": "string"
    }));
    ui.forms.push(Form {
        tool: None,
        infer_websearch: false,
        owner: Default::default(),
        id: "form-r2m1".into(),
        title: "Key collision check".into(),
        fields,
    });
    crate::agent_forms::seed(&ui.forms, &mut ui.drafts);
    let mut rt = Runtime::new(s, view, (320.0, 720.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(
        rt.find("bool-q-true").is_some(),
        "boolean Yes button must use bool-q-true key"
    );
    reveal(&mut rt, "field-q-true");
    let (fx, fy) = rt.find("field-q-true").unwrap();
    rt.pointer_down(fx, fy);
    rt.pointer_up(fx, fy);
    settle(&mut rt);
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .drafts
            .get(&("form-r2m1".into(), "q-true".into()))
            .is_some_and(|d| d.edit.focused),
        "field-q-true text editor must be focused"
    );
    resize(&mut rt, (320.0, 420.0));
    let content_26 = element_rect(&rt, "pending-content-form-r2m1");
    let field_26 = element_rect(&rt, "field-q-true");
    assert!(
        field_26[1] >= content_26[1] - 1.0
            && field_26[1] + field_26[3] <= content_26[1] + content_26[3] + 1.0,
        "field-q-true text editor (not bool-q-true) must stay visible in pending-content on shrink: field={field_26:?}, content={content_26:?}"
    );

    // 27. Width-only resize with 2 pending requests and open model picker must keep focused
    // model-search visible inside session-stack instead of scrolling agent-panel over it.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.picker = true;
    ui.models = (0..10)
        .map(|i| Model {
            reference: serde_json::json!(format!("m27-{i}")),
            label: format!("Model 27-{i}"),
            included: true,
        })
        .collect();
    ui.selected = "perm-27a".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-27a".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/27a.rs".into()],
        message: "First pending permission for model-search width resize check.".into(),
        supported: true,
    });
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-27b".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/27b.rs".into()],
        message: "Second pending permission for model-search width resize check.".into(),
        supported: true,
    });
    ui.reasons.insert("perm-27a".into(), TextEdit::new(""));
    ui.reasons.insert("perm-27b".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (720.0, 220.0), Env::new(false, 1.0));
    settle(&mut rt);
    let header_27 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (720.0, header_27 + 145.0));
    reveal(&mut rt, "model-search");
    let (mx27, my27) = rt.find("model-search").unwrap();
    rt.pointer_down(mx27, my27);
    rt.pointer_up(mx27, my27);
    settle(&mut rt);
    // Place session-stack top just above agent-panel so model-search sits near the top of the stack.
    let stack_27_before = element_rect(&rt, "session-stack");
    let panel_27_before = element_rect(&rt, "agent-panel");
    let cur_stack_y_27 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    let delta_27 = (panel_27_before[1] - stack_27_before[1] - 4.0).max(-cur_stack_y_27);
    rt.update(move |_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", (cur_stack_y_27 + delta_27).max(0.0));
    });
    settle(&mut rt);
    assert!(rt.state.agent.as_ref().unwrap().search.focused);
    resize(&mut rt, (730.0, header_27 + 145.0));
    assert!(rt.state.agent.as_ref().unwrap().search.focused);
    let stack_27 = element_rect(&rt, "session-stack");
    let search_27 = element_rect(&rt, "model-search");
    assert!(
        search_27[1] >= stack_27[1] - 1.0
            && search_27[1] + search_27[3] <= stack_27[1] + stack_27[3] + 1.0,
        "focused model-search must stay visible inside session-stack on width resize with 2 pending requests: search={search_27:?}, stack={stack_27:?}"
    );

    // 28. Focusing an off-screen composer via Tab in a short 56px session-stack without resizing
    // again must scroll session-stack so the composer caret becomes visible immediately.
    let mut s = state();
    seed_passages(&mut s, 16);
    let mut rt = Runtime::new(s, view, (390.0, 400.0), Env::new(false, 1.0));
    settle(&mut rt);
    let header_28 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (390.0, header_28 + 56.0));
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", 0.0);
    });
    settle(&mut rt);
    assert!(!rt.state.draft.focused);
    let tab = rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    };
    for _ in 0..48 {
        if rt.state.draft.focused {
            break;
        }
        rt.key(tab.clone());
        rt.key_up(tab.clone());
        settle(&mut rt);
    }
    assert!(
        rt.state.draft.focused,
        "Tab navigation must reach the composer on a 56px session-stack"
    );
    let stack_28 = element_rect(&rt, "session-stack");
    let caret_28 = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/composer/scroll/input"))
        .and_then(|e| e.caret)
        .expect("Tab-focused composer must expose a drawn caret");
    assert!(
        caret_28[1] >= stack_28[1] - 1.0
            && caret_28[1] + caret_28[3] <= stack_28[1] + stack_28[3] + 1.0,
        "Tab focusing an off-screen composer must scroll session-stack to reveal its caret: caret={caret_28:?}, stack={stack_28:?}"
    );

    // 29. Tab focusing an off-screen interruption reason field on a 56px session-stack must
    // scroll session-stack so the reason field becomes visible immediately.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-29".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-29".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/perm-29.rs".into()],
        message: "Approve edit for Tab-focus interruption reveal check.".into(),
        supported: true,
    });
    ui.reasons.insert("perm-29".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (390.0, 400.0), Env::new(false, 1.0));
    settle(&mut rt);
    let header_29 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (390.0, header_29 + 56.0));
    // Place controls-refresh just above the bottom edge of session-stack so reason-perm-29 is off-screen below.
    let stack_29_0 = element_rect(&rt, "session-stack");
    let refresh_29 = element_rect(&rt, "controls-refresh");
    let cur_sy_29 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    let target_sy_29 =
        (cur_sy_29 + (refresh_29[1] + refresh_29[3]) - (stack_29_0[1] + stack_29_0[3]) + 2.0)
            .max(0.0);
    rt.update(move |_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", target_sy_29);
    });
    settle(&mut rt);
    let tab_29 = rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    };
    for _ in 0..48 {
        if rt
            .state
            .agent
            .as_ref()
            .and_then(|a| a.reasons.get("perm-29"))
            .is_some_and(|r| r.focused)
        {
            break;
        }
        rt.key(tab_29.clone());
        rt.key_up(tab_29.clone());
        settle(&mut rt);
    }
    assert!(
        rt.state
            .agent
            .as_ref()
            .and_then(|a| a.reasons.get("perm-29"))
            .is_some_and(|r| r.focused),
        "Tab must reach reason-perm-29 on a 56px session-stack"
    );
    let stack_29 = element_rect(&rt, "session-stack");
    let reason_29 = element_rect(&rt, "reason-perm-29");
    assert!(
        reason_29[1] >= stack_29[1] - 1.0
            && reason_29[1] + reason_29[3] <= stack_29[1] + stack_29[3] + 1.0,
        "Tab focusing off-screen reason-perm-29 must reveal it inside 56px session-stack: reason={reason_29:?}, stack={stack_29:?}"
    );

    // 30. Typing in a focused dock field after manually scrolling session-stack away must reveal it.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", 0.0);
    });
    settle(&mut rt);
    let reason_30_hidden = element_rect(&rt, "reason-perm-29");
    assert!(
        reason_30_hidden[1] >= stack_29[1] + stack_29[3] - 1.0,
        "manual stack scroll must move focused reason-perm-29 off-screen: reason={reason_30_hidden:?}, stack={stack_29:?}"
    );
    rt.paste("more");
    settle(&mut rt);
    let stack_30 = element_rect(&rt, "session-stack");
    let reason_30 = element_rect(&rt, "reason-perm-29");
    assert!(
        reason_30[1] >= stack_30[1] - 1.0
            && reason_30[1] + reason_30[3] <= stack_30[1] + stack_30[3] + 1.0,
        "typing in an off-screen focused dock field must reveal it inside session-stack: reason={reason_30:?}, stack={stack_30:?}"
    );

    // 31. Adding resources to an already capped permission dock must re-reveal focused reason-* inside pending-content.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-31".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-31".into(),
        action: "edit".into(),
        resources: (0..8)
            .map(|i| format!("/synthetic/saturated/resource-{i}.rs"))
            .collect(),
        message: "Saturated permission dock.".into(),
        supported: true,
    });
    ui.reasons.insert("perm-31".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (320.0, 420.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|s, tx| {
        tx.instant();
        tx.scroll_into_view("reason-perm-31");
        tx.focus("reason-perm-31", false);
        s.agent
            .as_mut()
            .unwrap()
            .reasons
            .get_mut("perm-31")
            .unwrap()
            .focused = true;
    });
    settle(&mut rt);
    let dock_h_before = element_rect(&rt, "agent-panel")[3];
    rt.update(|s, _| {
        let p = &mut s.agent.as_mut().unwrap().permissions[0];
        for i in 8..18 {
            p.resources
                .push(format!("/synthetic/saturated/resource-{i}.rs"));
        }
    });
    settle(&mut rt);
    let dock_h_after = element_rect(&rt, "agent-panel")[3];
    assert!(
        (dock_h_after - dock_h_before).abs() <= 1.0,
        "dock height must remain capped when extra resources arrive: before={dock_h_before}, after={dock_h_after}"
    );
    let pc_31 = element_rect(&rt, "pending-content-perm-31");
    let reason_31 = element_rect(&rt, "reason-perm-31");
    assert!(
        reason_31[1] >= pc_31[1] - 1.0 && reason_31[1] + reason_31[3] <= pc_31[1] + pc_31[3] + 1.0,
        "extra resources in a capped dock must keep focused reason-perm-31 visible inside pending-content: reason={reason_31:?}, pending={pc_31:?}"
    );

    // 32. Manual margin wheel on a 28px stack between Ctrl+End mounting stack-caret-pin and its on_layout_tx must win.
    let mut s = state();
    seed_passages(&mut s, 12);
    s.draft = TextEdit::new(
        &(0..8)
            .map(|i| format!("Line {i} of ultra-short stack wheel test"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let mut rt = Runtime::new(s, view, (390.0, 400.0), Env::new(false, 1.0));
    settle(&mut rt);
    let header_32 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (390.0, header_32 + 28.0));
    let comp_32 = element_rect(&rt, "composer");
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_into_view("composer");
        tx.focus("composer", false);
    });
    settle(&mut rt);
    let home_32 = rune::KeyEvent {
        key: rune::Key::Home,
        mods: rune::Mods {
            ctrl: true,
            ..Default::default()
        },
    };
    rt.key(home_32.clone());
    rt.key_up(home_32);
    settle(&mut rt);
    let end_32 = rune::KeyEvent {
        key: rune::Key::End,
        mods: rune::Mods {
            ctrl: true,
            ..Default::default()
        },
    };
    // Frame 1: Ctrl+End mounts stack-caret-pin and queues its on_layout_tx.
    rt.key(end_32.clone());
    rt.key_up(end_32);
    rt.frame(0.02);
    let before_wheel_32 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    assert!(before_wheel_32 > 40.0);
    // Queue a manual upward wheel on session-stack's side margin BEFORE Frame 2 drains on_layout_tx.
    let stack_32 = element_rect(&rt, "session-stack");
    let margin_x = stack_32[0] + 2.0;
    let margin_y = stack_32[1] + stack_32[3] * 0.5;
    assert!(margin_x < comp_32[0] || margin_x >= stack_32[0]);
    rt.wheel_event(rune::WheelEvent::new(0.0, 80.0).at(margin_x, margin_y));
    settle(&mut rt);
    let after_wheel_32 = rt.state.tool_diff_preferences.stack_scroll.get().0;
    assert!(
        after_wheel_32 < before_wheel_32 - 30.0,
        "manual margin wheel before stack-caret-pin on_layout_tx must not be undone: before={before_wheel_32}, after={after_wheel_32}"
    );

    // 33. Tab focusing a boolean answer button inside pending-content on a 56px two-level
    // scrolling session-stack must scroll session-stack so the focused button is visible.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "form-33".into();
    let form_33 = Form {
        tool: None,
        infer_websearch: false,
        owner: Default::default(),
        id: "form-33".into(),
        title: "Confirm deployment target?".into(),
        fields: vec![serde_json::json!({
            "key": "confirm",
            "title": "Proceed with deployment?",
            "type": "boolean"
        })],
    };
    ui.drafts.insert(
        ("form-33".into(), "confirm".into()),
        crate::agent_forms::Draft::default(),
    );
    ui.forms.push(form_33);
    let mut rt = Runtime::new(s, view, (390.0, 400.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    settle(&mut rt);
    let header_33 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (390.0, header_33 + 56.0));
    // Scroll session-stack to top so bool-confirm-true sits off-screen below.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_y("session-stack", 0.0);
        tx.focus("controls-refresh", true);
    });
    settle(&mut rt);
    let stack_33_before = element_rect(&rt, "session-stack");
    let bool_33_before = element_rect(&rt, "bool-confirm-true");
    assert!(
        bool_33_before[1] >= stack_33_before[1] + stack_33_before[3] - 1.0,
        "bool-confirm-true must start off-screen below 56px session-stack: bool={bool_33_before:?}, stack={stack_33_before:?}"
    );
    let tab_33 = rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    };
    let mut reached_bool = false;
    for _ in 0..32 {
        rt.key(tab_33.clone());
        rt.key_up(tab_33.clone());
        settle(&mut rt);
        rt.update(|_, tx| {
            reached_bool = tx.focused() == Some("bool-confirm-true");
        });
        if reached_bool {
            break;
        }
    }
    assert!(
        reached_bool,
        "Tab from Agent controls must reach bool-confirm-true"
    );
    let stack_33 = element_rect(&rt, "session-stack");
    let bool_33 = element_rect(&rt, "bool-confirm-true");
    assert!(
        bool_33[1] >= stack_33[1] - 1.0
            && bool_33[1] + bool_33[3] <= stack_33[1] + stack_33[3] + 1.0,
        "Tab focusing bool-confirm-true inside pending-content must reveal it in 56px session-stack: bool={bool_33:?}, stack={stack_33:?}"
    );

    // 34. Shrinking the viewport while a direct agent-panel footer button (reject) holds Tab
    // focus must keep reject focused and reveal it inside the narrowed 56px session-stack.
    let mut s = state();
    seed_passages(&mut s, 16);
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-34".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-34".into(),
        action: "edit".into(),
        resources: vec!["/synthetic/footer-focus.rs".into()],
        message: "Keep footer action visible when viewport shrinks.".into(),
        supported: true,
    });
    ui.reasons.insert("perm-34".into(), TextEdit::new(""));
    let mut rt = Runtime::new(s, view, (390.0, 600.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    settle(&mut rt);
    rt.update(|_, tx| {
        tx.focus("controls-refresh", true);
    });
    settle(&mut rt);
    let tab_34 = rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    };
    let mut reached_reject = false;
    for _ in 0..32 {
        rt.key(tab_34.clone());
        rt.key_up(tab_34.clone());
        settle(&mut rt);
        rt.update(|_, tx| {
            reached_reject = tx.focused() == Some("reject");
        });
        if reached_reject {
            break;
        }
    }
    assert!(reached_reject, "Tab navigation must reach reject button");
    assert_eq!(
        rt.state.tool_diff_preferences.focused_agent_control_key(),
        Some("reject"),
        "sync_focused_agent_control must record direct dock footer button reject"
    );
    let header_34 = element_rect(&rt, "session-stack")[1];
    resize(&mut rt, (390.0, header_34 + 56.0));
    let mut still_reject = false;
    rt.update(|_, tx| {
        still_reject = tx.focused() == Some("reject");
    });
    assert!(
        still_reject,
        "viewport shrink must keep Tab focus on reject"
    );
    let stack_34 = element_rect(&rt, "session-stack");
    let reject_34 = element_rect(&rt, "reject");
    assert!(
        reject_34[1] >= stack_34[1] - 1.0
            && reject_34[1] + reject_34[3] <= stack_34[1] + stack_34[3] + 1.0,
        "shrinking viewport with Tab focus on reject must scroll reject into 56px session-stack: reject={reject_34:?}, stack={stack_34:?}"
    );
}

#[test]
fn expanded_dock_with_timeline_banner_keeps_history_and_dock_non_overlapping() {
    for reduced_motion in [false, true] {
        expanded_dock_with_timeline_banner_case(reduced_motion);
    }
}

fn expanded_dock_with_timeline_banner_case(reduced_motion: bool) {
    let mut initial = state();
    initial.messages = (0..150)
        .map(|i| {
            crate::Message {
                usage: None,
                id: format!("row-{i}"),
                role: "user".into(),
                completed: true,
                body: format!("Message {i}"),
                parts: vec![],
            }
            .into()
        })
        .collect();
    initial.agent.as_mut().unwrap().picker = true;
    crate::timeline::tests::set_outline_error(&mut initial, 800.0, false);
    let mut rt = Runtime::new(initial, view, (800.0, 260.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.set_system_reduced_motion(reduced_motion);
    let settle_all = |rt: &mut Runtime<State>| {
        for _ in 0..45 {
            rt.frame(0.016);
        }
    };
    rt.frame(0.0);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-40", -14.0);
    });
    settle_all(&mut rt);
    struct Phase {
        path: String,
        history: [f32; 4],
        rail: [f32; 4],
        dock: [f32; 4],
        banner: Option<([f32; 4], [f32; 4], bool)>,
    }
    let snapshot = |rt: &Runtime<State>| {
        let elements = rt.elements();
        let get = |key: &str| {
            elements
                .iter()
                .find(|node| node.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing {key}"))
        };
        let history = get("history");
        Phase {
            path: history.path.clone(),
            history: history.rect,
            rail: get("timeline").rect,
            dock: get("agent-panel").rect,
            banner: {
                let banners: Vec<_> = elements
                    .iter()
                    .filter(|node| node.key.as_deref() == Some("timeline-outline-retry"))
                    .collect();
                assert!(
                    banners.len() <= 1,
                    "duplicate timeline-outline-retry banners mounted: {}",
                    banners.len()
                );
                banners.into_iter().next().map(|node| {
                    let prefix = format!("{}/", node.path);
                    let children: Vec<_> = elements
                        .iter()
                        .filter(|child| child.path.starts_with(&prefix))
                        .collect();
                    let expected_text = crate::strings::t("history.navigation.outlineUnavailable");
                    let expected_retry = crate::strings::t("messageSection.search.retry");
                    let message_count = children
                        .iter()
                        .filter(|child| {
                            child.role != "button" && child.text.as_deref() == Some(expected_text)
                        })
                        .count();
                    let button_count = children
                        .iter()
                        .filter(|child| {
                            child.role == "button"
                                && (child.label.as_deref() == Some(expected_retry)
                                    || child.text.as_deref() == Some(expected_retry))
                        })
                        .count();
                    let unclipped = node.rect[2] > 0.0
                        && node.rect[3] > 0.0
                        && (node.visible[2] - node.rect[2]).abs() <= 0.5
                        && (node.visible[3] - node.rect[3]).abs() <= 0.5
                        && message_count == 1
                        && button_count == 1
                        && children.iter().all(|child| {
                            child.rect[2] > 0.0
                                && child.rect[3] > 0.0
                                && (child.visible[2] - child.rect[2]).abs() <= 0.5
                                && (child.visible[3] - child.rect[3]).abs() <= 0.5
                        });
                    (node.rect, node.visible, unclipped)
                })
            },
        }
    };
    let find_unclipped_offscreen_rail_button = |rt: &Runtime<State>| {
        let elements = rt.elements();
        let history = elements
            .iter()
            .find(|node| node.key.as_deref() == Some("history"))
            .expect("missing history");
        let is_row_in_history = |row: &str| {
            elements.iter().any(|n| {
                n.key.as_deref() == Some(row)
                    && n.visible[2] > 0.0
                    && n.visible[3] > 0.0
                    && n.rect[1] + n.rect[3] > history.rect[1] + 0.5
                    && n.rect[1] < history.rect[1] + history.rect[3] - 0.5
            })
        };
        elements
            .iter()
            .filter(|node| {
                node.path.contains("/timeline/")
                    && node.role == "button"
                    && node.rect[2] > 0.0
                    && node.rect[3] > 0.0
                    && (node.visible[2] - node.rect[2]).abs() <= 0.5
                    && (node.visible[3] - node.rect[3]).abs() <= 0.5
            })
            .filter_map(|node| {
                node.key
                    .as_deref()
                    .and_then(|key| key.split(':').next())
                    .filter(|row| *row != "row-40" && !is_row_in_history(row))
                    .map(|row| (row.to_string(), node.rect))
            })
            .next()
    };
    let anchor = |rt: &Runtime<State>| {
        let history = rt.presented("history").unwrap().0;
        let row = rt.presented("row-40").unwrap().0;
        row[1] - history[1]
    };
    // touch-target-size and timelineRail.width from crates/rune-theme-codenomad/assets/theme.json.
    const TOUCH_TARGET_MIN: f32 = 40.0;
    const RAIL_WIDTH: f32 = 40.0;

    let assert_rail_geometry = |rail: [f32; 4], history: [f32; 4], label: &str| {
        assert!(
            (rail[1] - history[1]).abs() <= 1.0 && (rail[3] - history[3]).abs() <= 1.0,
            "{label}: rail vertical bounds {rail:?} must match history {history:?}"
        );
        assert!(
            (rail[2] - RAIL_WIDTH).abs() <= 0.5,
            "{label}: rail width {} must match {RAIL_WIDTH}",
            rail[2]
        );
        let rtl = rune_theme_codenomad::catalogue::direction(crate::strings::locale()) == "rtl";
        let abuts = if rtl {
            (rail[0] + rail[2] - history[0]).abs() <= 1.0 && rail[0] >= -0.5
        } else {
            (rail[0] - (history[0] + history[2])).abs() <= 1.0 && rail[0] + rail[2] <= 800.5
        };
        assert!(
            abuts,
            "{label}: rail horizontal placement {rail:?} must abut history {history:?} inside viewport (rtl={rtl})"
        );
    };
    let assert_rail_clickable = |rt: &mut Runtime<State>, rail: [f32; 4], label: &str| {
        let offset_before = crate::timeline::tests::rail_scroll_offset(&rt.state);
        let before_visible: std::collections::HashSet<String> = rt
            .elements()
            .into_iter()
            .filter(|n| {
                n.path.contains("/timeline/")
                    && n.role == "button"
                    && n.visible[2] > 0.0
                    && n.visible[3] > 0.0
            })
            .filter_map(|n| n.key)
            .collect();
        rt.wheel_xy(
            rail[0] + rail[2] / 2.0,
            rail[1] + rail[3] / 2.0,
            0.0,
            -160.0,
        );
        settle_all(rt);
        let offset_after = crate::timeline::tests::rail_scroll_offset(&rt.state);
        assert!(
            offset_after > offset_before + 100.0,
            "{label}: wheeling rail must scroll downward: before={offset_before}, after={offset_after}"
        );
        let elements = rt.elements();
        let mut seen = std::collections::HashSet::new();
        let mut visible_indices = Vec::new();
        for node in elements
            .iter()
            .filter(|n| n.path.contains("/timeline/") && n.role == "button")
        {
            let key = node
                .key
                .as_deref()
                .unwrap_or_else(|| panic!("{label}: rail button missing key"));
            assert!(
                seen.insert(key.to_string()),
                "{label}: duplicate rail marker key {key}"
            );
            let overlap =
                (node.rect[1] + node.rect[3]).min(rail[1] + rail[3]) - node.rect[1].max(rail[1]);
            if overlap > 0.5 {
                assert!(
                    node.visible[2] > 0.0
                        && node.visible[3] > 0.0
                        && (node.visible[2] - node.rect[2]).abs() <= 0.5
                        && (node.visible[3] - overlap).abs() <= 1.0,
                    "{label}: overlapping rail marker {key} unexpectedly clipped: rect={:?}, visible={:?}, rail={rail:?}, overlap={overlap}",
                    node.rect,
                    node.visible
                );
                if let Some(idx) = key
                    .split(':')
                    .next()
                    .and_then(|row| row.strip_prefix("row-"))
                    .and_then(|n| n.parse::<usize>().ok())
                {
                    visible_indices.push(idx);
                }
            }
        }
        visible_indices.sort_unstable();
        assert!(
            visible_indices.len() >= 2,
            "{label}: expected at least 2 visible rail markers for contiguity check: {visible_indices:?}"
        );
        for pair in visible_indices.windows(2) {
            assert_eq!(
                pair[1],
                pair[0] + 1,
                "{label}: gap in visible rail markers: {visible_indices:?}"
            );
        }
        let (target_row, [x, y, w, h]) = find_unclipped_offscreen_rail_button(rt)
            .unwrap_or_else(|| panic!("{label}: missing unclipped off-screen rail button"));
        assert!(
            !before_visible.contains(&format!("{target_row}:User:0:false")),
            "{label}: clicked button {target_row} should have been scrolled into view by wheel"
        );
        rt.pointer_down(x + w / 2.0, y + h / 2.0);
        rt.pointer_up(x + w / 2.0, y + h / 2.0);
        settle_all(rt);
        let hist = rt.presented("history").expect("history presented").0;
        let block_key = format!("body-{target_row}");
        let after_block = rt.presented(&block_key).map(|(r, _)| r);
        assert!(
            after_block.is_some_and(|r| r[3] > 0.0 && (r[1] - hist[1]).abs() <= 2.0),
            "{label}: clicking unclipped off-screen rail button {target_row} did not align {block_key} to top of history {hist:?}: after_block={after_block:?}"
        );
        rt.update(|s, tx| {
            crate::timeline::cancel_jump(s);
            tx.instant();
            tx.scroll_key_to("row-40", -14.0);
        });
        settle_all(rt);
    };

    let base = snapshot(&rt);
    let expected_path = base.path;
    let base_history = base.history;
    let base_rail = base.rail;
    let base_dock = base.dock;
    let expected_offset = anchor(&rt);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    assert!(
        (expected_offset - (-14.0)).abs() < 1.0,
        "unexpected initial anchor offset: {expected_offset}"
    );
    assert_rail_geometry(base_rail, base_history, "before banner");
    assert!(
        base_history[3] >= TOUCH_TARGET_MIN - 0.5,
        "history must keep touch-target minimum height ({TOUCH_TARGET_MIN}): {base_history:?}"
    );
    assert!(
        base_history[1] + base_history[3] <= base_dock[1] + 0.5 && base_dock[1] < 260.0,
        "history {base_history:?} must sit directly above agent-panel {base_dock:?} without rail inflation"
    );
    assert_rail_clickable(&mut rt, base_rail, "before banner");
    // Discover the first band junction dynamically from rendered band 0 instead of assuming BAND=64.
    let seam = rt
        .elements()
        .iter()
        .filter(|n| n.path.contains("/timeline-bands/0/") && n.role == "button")
        .filter_map(|n| {
            n.key
                .as_deref()?
                .split(':')
                .next()?
                .strip_prefix("row-")?
                .parse::<usize>()
                .ok()
        })
        .max()
        .expect("expected mounted markers in first timeline band");
    rt.update(|_, tx| rune_theme_codenomad::timeline::show_marker(seam, tx));
    settle_all(&mut rt);
    let band_elements = rt.elements();
    let mut band_seen = std::collections::HashSet::new();
    let mut band_visible = Vec::new();
    let mut band_rects = std::collections::HashMap::<usize, [f32; 4]>::new();
    let mut band_parents = std::collections::HashMap::<usize, String>::new();
    for node in band_elements
        .iter()
        .filter(|n| n.path.contains("/timeline/") && n.role == "button")
    {
        let key = node.key.as_deref().expect("band junction button key");
        assert!(
            band_seen.insert(key.to_string()),
            "duplicate key across band seam: {key}"
        );
        let idx = key
            .split(':')
            .next()
            .and_then(|row| row.strip_prefix("row-"))
            .and_then(|n| n.parse::<usize>().ok());
        if let Some(i) = idx {
            band_rects.insert(i, node.rect);
            if let Some((parent, _)) = node.path.rsplit_once('/') {
                band_parents.insert(i, parent.to_string());
            }
        }
        let overlap = (node.rect[1] + node.rect[3]).min(base_rail[1] + base_rail[3])
            - node.rect[1].max(base_rail[1]);
        if overlap > 0.5 {
            assert!(
                node.visible[2] > 0.0
                    && node.visible[3] > 0.0
                    && (node.visible[3] - overlap).abs() <= 1.0,
                "band seam marker {key} unexpectedly clipped: rect={:?}, visible={:?}",
                node.rect,
                node.visible
            );
            if let Some(i) = idx {
                band_visible.push(i);
            }
        }
    }
    band_visible.sort_unstable();
    assert!(
        band_visible.contains(&seam) && band_visible.contains(&(seam + 1)),
        "expected band junction ({seam} and {}) visible together: {band_visible:?}",
        seam + 1
    );
    assert_ne!(
        band_parents.get(&seam),
        band_parents.get(&(seam + 1)),
        "markers {seam} and {} must live in distinct virtual bands: {:?} vs {:?}",
        seam + 1,
        band_parents.get(&seam),
        band_parents.get(&(seam + 1))
    );
    for pair in band_visible.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "gap across band seam: {band_visible:?}"
        );
    }
    let (r_prev, r_seam, r_next, r_after) = (
        band_rects[&(seam - 1)],
        band_rects[&seam],
        band_rects[&(seam + 1)],
        band_rects[&(seam + 2)],
    );
    let pitch_before = r_seam[1] - r_prev[1];
    let pitch_seam = r_next[1] - r_seam[1];
    let pitch_after = r_after[1] - r_next[1];
    assert!(
        pitch_before > 0.0
            && (pitch_seam - pitch_before).abs() <= 0.5
            && (pitch_after - pitch_before).abs() <= 0.5,
        "band seam spacing must match normal marker pitch: seam={seam}, before={pitch_before}, seam_gap={pitch_seam}, after={pitch_after}"
    );
    rt.update(|s, tx| {
        crate::timeline::cancel_jump(s);
        tx.instant();
        tx.scroll_key_to("row-40", -14.0);
    });
    settle_all(&mut rt);

    rt.update(|s, _| crate::timeline::tests::set_outline_error(s, 800.0, true));
    settle_all(&mut rt);
    let with_banner = snapshot(&rt);
    let (banner, banner_visible, banner_unclipped) =
        with_banner.banner.expect("missing timeline-outline-retry");
    let history = with_banner.history;
    let rail = with_banner.rail;
    let dock = with_banner.dock;
    assert_eq!(with_banner.path, expected_path);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    assert!((anchor(&rt) - expected_offset).abs() < 0.5);
    assert!(
        banner_unclipped,
        "banner and descendants must be completely visible without clipping: rect={banner:?}, visible={banner_visible:?}"
    );
    assert!(
        history[3] >= TOUCH_TARGET_MIN - 0.5,
        "history must keep touch-target minimum height ({TOUCH_TARGET_MIN}): {history:?}"
    );
    assert_rail_geometry(rail, history, "with banner");
    assert!(
        banner[1] + banner[3] <= history[1] + 0.5,
        "banner {banner:?} overlapped history {history:?}"
    );
    assert!(
        history[1] + history[3] <= dock[1] + 0.5 && dock[1] < 260.0,
        "history {history:?} overlapped or pushed agent-panel {dock:?}"
    );
    assert!(dock[3] > 0.0, "agent-panel must stay measurable: {dock:?}");
    assert_rail_clickable(&mut rt, rail, "with banner");
    // Also verify the seam entering the final short band (band 1 -> band 2 for 150 markers) while
    // the banner is mounted and compressing the rail viewport.
    let last_seam = (seam + 1) * 2 - 1;
    rt.update(|_, tx| rune_theme_codenomad::timeline::show_marker(last_seam, tx));
    settle_all(&mut rt);
    let short_band_elements = rt.elements();
    let mut short_seen = std::collections::HashSet::new();
    let mut short_visible = Vec::new();
    let mut short_rects = std::collections::HashMap::<usize, [f32; 4]>::new();
    let mut short_parents = std::collections::HashMap::<usize, String>::new();
    for node in short_band_elements
        .iter()
        .filter(|n| n.path.contains("/timeline/") && n.role == "button")
    {
        let key = node.key.as_deref().expect("short band seam button key");
        assert!(
            short_seen.insert(key.to_string()),
            "duplicate key across short band seam: {key}"
        );
        let idx = key
            .split(':')
            .next()
            .and_then(|row| row.strip_prefix("row-"))
            .and_then(|n| n.parse::<usize>().ok());
        if let Some(i) = idx {
            short_rects.insert(i, node.rect);
            if let Some((parent, _)) = node.path.rsplit_once('/') {
                short_parents.insert(i, parent.to_string());
            }
        }
        let overlap =
            (node.rect[1] + node.rect[3]).min(rail[1] + rail[3]) - node.rect[1].max(rail[1]);
        if overlap > 0.5 {
            assert!(
                node.visible[2] > 0.0
                    && node.visible[3] > 0.0
                    && (node.visible[3] - overlap).abs() <= 1.0,
                "short band seam marker {key} unexpectedly clipped under banner: rect={:?}, visible={:?}",
                node.rect,
                node.visible
            );
            if let Some(i) = idx {
                short_visible.push(i);
            }
        }
    }
    short_visible.sort_unstable();
    assert!(
        short_visible.contains(&last_seam) && short_visible.contains(&(last_seam + 1)),
        "expected last short-band seam ({last_seam} and {}) visible under banner: {short_visible:?}",
        last_seam + 1
    );
    assert_ne!(
        short_parents.get(&last_seam),
        short_parents.get(&(last_seam + 1)),
        "markers {last_seam} and {} must live in distinct bands under banner",
        last_seam + 1
    );
    for pair in short_visible.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "gap across last short-band seam under banner: {short_visible:?}"
        );
    }
    let short_pitch_before = short_rects[&last_seam][1] - short_rects[&(last_seam - 1)][1];
    let short_pitch_seam = short_rects[&(last_seam + 1)][1] - short_rects[&last_seam][1];
    let short_pitch_after = short_rects[&(last_seam + 2)][1] - short_rects[&(last_seam + 1)][1];
    assert!(
        short_pitch_before > 0.0
            && (short_pitch_seam - short_pitch_before).abs() <= 0.5
            && (short_pitch_after - short_pitch_before).abs() <= 0.5,
        "last short-band seam spacing under banner must match marker pitch: before={short_pitch_before}, seam={short_pitch_seam}, after={short_pitch_after}"
    );
    // Also verify the final marker (149) in the tail band under the banner: visible, unclipped,
    // contiguous with marker 148 at the same pitch, and clickable.
    rt.update(|_, tx| rune_theme_codenomad::timeline::show_marker(149, tx));
    settle_all(&mut rt);
    let tail_elements = rt.elements();
    let last_node = tail_elements
        .iter()
        .find(|n| n.key.as_deref() == Some("row-149:User:0:false"))
        .expect("final marker row-149 presented under banner");
    let prev_node = tail_elements
        .iter()
        .find(|n| n.key.as_deref() == Some("row-148:User:0:false"))
        .expect("penultimate marker row-148 presented under banner");
    let last_overlap = (last_node.rect[1] + last_node.rect[3]).min(rail[1] + rail[3])
        - last_node.rect[1].max(rail[1]);
    let tail_pitch = last_node.rect[1] - prev_node.rect[1];
    assert!(
        last_overlap > 0.5
            && last_node.visible[2] > 0.0
            && last_node.visible[3] > 0.0
            && (last_node.visible[3] - last_node.rect[3]).abs() <= 0.5
            && last_node.rect[1] + last_node.rect[3] <= rail[1] + rail[3] + 0.5
            && (tail_pitch - short_pitch_before).abs() <= 0.5,
        "final marker 149 must stay completely visible (unclipped full height) and at marker pitch under banner: rect={:?}, visible={:?}, rail={rail:?}, pitch={tail_pitch}",
        last_node.rect,
        last_node.visible
    );
    let tail_offset_before = crate::timeline::tests::rail_scroll_offset(&rt.state);
    let last_cx = last_node.rect[0] + last_node.rect[2] / 2.0;
    let last_cy = last_node.rect[1] + last_node.rect[3] / 2.0;
    rt.pointer_down(last_cx, last_cy);
    rt.pointer_up(last_cx, last_cy);
    settle_all(&mut rt);
    let row_149 = rt
        .presented("row-149")
        .expect("clicking final marker 149 under banner must mount row-149")
        .0;
    let hist_after_149 = rt.presented("history").expect("history presented").0;
    let row_149_overlap = (row_149[1] + row_149[3]).min(hist_after_149[1] + hist_after_149[3])
        - row_149[1].max(hist_after_149[1]);
    assert!(
        row_149[3] > 0.0 && row_149_overlap >= hist_after_149[3].min(row_149[3]) - 1.0,
        "clicking final marker 149 under banner must scroll row-149 into history viewport: row={row_149:?}, history={hist_after_149:?}, overlap={row_149_overlap}"
    );
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 160.0);
    settle_all(&mut rt);
    let tail_offset_after = crate::timeline::tests::rail_scroll_offset(&rt.state);
    assert!(
        tail_offset_after < tail_offset_before - 100.0,
        "with banner at tail: wheeling rail upward from marker 149 must scroll: before={tail_offset_before}, after={tail_offset_after}"
    );
    rt.update(|s, tx| {
        crate::timeline::cancel_jump(s);
        tx.instant();
        tx.scroll_key_to("row-40", -14.0);
    });
    settle_all(&mut rt);
    reveal(&mut rt, "model-search");
    reveal(&mut rt, "history");

    rt.update(|s, _| crate::timeline::tests::set_outline_error(s, 800.0, false));
    settle_all(&mut rt);
    let restored = snapshot(&rt);
    assert_eq!(restored.path, expected_path);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    assert!((anchor(&rt) - expected_offset).abs() < 0.5);
    assert!(restored.banner.is_none());
    let restored_history = restored.history;
    let restored_rail = restored.rail;
    let restored_dock = restored.dock;
    assert!((restored_history[3] - base_history[3]).abs() < 0.5);
    assert_rail_geometry(restored_rail, restored_history, "after banner");
    assert!(restored_history[1] + restored_history[3] <= restored_dock[1] + 0.5);
    assert_rail_clickable(&mut rt, restored_rail, "after banner");

    reveal(&mut rt, "history");
    reveal(&mut rt, "model-search");

    // Compare geometry of the same dock with a short (2-marker) rail vs the 150-marker rail,
    // both with and without the banner, proving rail markers never inflate history height.
    rt.update(|s, _| {
        s.messages.drain(2..);
        s.revision += 1;
        crate::timeline::structure_changed(s);
    });
    settle_all(&mut rt);
    let short_base = snapshot(&rt);
    assert!(
        (short_base.history[3] - base_history[3]).abs() <= 0.5
            && (short_base.dock[1] - base_dock[1]).abs() <= 0.5,
        "150-marker rail must not inflate history or shift dock vs 2-marker rail: long={base_history:?}/{base_dock:?}, short={:?}/{:?}",
        short_base.history,
        short_base.dock
    );
    rt.update(|s, _| crate::timeline::tests::set_outline_error(s, 800.0, true));
    settle_all(&mut rt);
    let short_banner = snapshot(&rt);
    assert!(
        (short_banner.history[3] - history[3]).abs() <= 0.5
            && (short_banner.dock[1] - dock[1]).abs() <= 0.5,
        "150-marker rail with banner must match 2-marker rail geometry: long={history:?}/{dock:?}, short={:?}/{:?}",
        short_banner.history,
        short_banner.dock
    );

    // Also verify a wrapped multi-line destinationFiltered alert at narrow width (240 px) reserves
    // its full height without clipping or overlapping history / expanded dock.
    // Scope to "en" so shorter CJK translations do not stay single-line at 240 px.
    crate::strings::with_locale("en", || {
        rt.update(|s, _| {
            crate::timeline::tests::set_outline_error(s, 240.0, false);
            crate::timeline::tests::set_filtered_notice(s, true);
        });
        rt.set_viewport((240.0, 260.0), 1.0);
        settle_all(&mut rt);
    });
    let elements = rt.elements();
    let alert = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("timeline-destination-filtered"))
        .expect("missing wrapped timeline-destination-filtered alert");
    let filt_history = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("history"))
        .expect("missing history with filtered alert")
        .rect;
    let filt_dock = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("agent-panel"))
        .expect("missing agent-panel with filtered alert")
        .rect;
    assert!(
        alert.rect[3] > 24.0
            && (alert.visible[2] - alert.rect[2]).abs() <= 0.5
            && (alert.visible[3] - alert.rect[3]).abs() <= 0.5
            && alert.rect[1] + alert.rect[3] <= filt_history[1] + 0.5
            && filt_history[3] >= TOUCH_TARGET_MIN - 0.5
            && filt_history[1] + filt_history[3] <= filt_dock[1] + 0.5,
        "wrapped destinationFiltered alert must reserve full height above history and expanded dock: alert={:?} (visible={:?}), history={filt_history:?}, dock={filt_dock:?}",
        alert.rect,
        alert.visible
    );
}
