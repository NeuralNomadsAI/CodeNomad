use super::*;
use crate::{
    Phase, State,
    agent_api::{Form, Permission},
    agent_forms, init, view,
};
use rune::{Env, Runtime};
use serde_json::json;

fn state() -> State {
    let (jobs, _) = bounded(1);
    let (stop, _) = bounded(1);
    let (_, results) = bounded(1);
    let mut ui = Ui::new(Handle {
        jobs,
        stop,
        results,
    });
    ui.reading = false;
    ui.known = true;
    ui.pending_known = true;
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
    assert!(
        node.rect[3] > 0.0 && node.visible[2] > 0.0 && node.visible[3] >= node.rect[3] - 1.0,
        "{key} must be a usable visible control: rect={:?} visible={:?}",
        node.rect,
        node.visible
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
    for size in [(1400.0, 900.0), (390.0, 740.0), (390.0, 320.0)] {
        let mut state = state();
        let ui = state.agent.as_mut().unwrap();
        ui.selected = "permission-fixture".into();
        ui.permissions.push(Permission {
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
        for key in ["allow_once", "allow_always", "reject"] {
            if size.1 == 320.0 {
                reveal(&mut rt, key);
            } else {
                visible(&rt, key);
            }
        }
        reveal(&mut rt, "reason-permission-fixture");
        reveal(&mut rt, "composer");
        reveal(&mut rt, "history");
        reveal(&mut rt, "allow_once");
    }
}
#[test]
fn question_fields_model_list_and_composer_remain_scroll_reachable() {
    for size in [(1400.0, 900.0), (390.0, 740.0), (390.0, 320.0)] {
        let mut state = state();
        let ui = state.agent.as_mut().unwrap();
        ui.selected = "form-fixture".into();
        ui.forms.push(Form { id: ui.selected.clone(), title: "Synthetic question".into(), fields: (0..24).map(|i| json!({"key":format!("field{i}"),"type":"string","title":format!("Synthetic field {i}")})).collect() });
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
                    session_known: true,
                    running: false,
                    permissions: Some(vec![]),
                    forms: Some(vec![]),
                },
                false
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
