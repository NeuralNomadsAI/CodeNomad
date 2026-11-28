use super::*;
use crate::{
    Phase, State,
    agent_api::{Form, FormOwner, Model, Permission},
    agent_forms, init, view,
};
use rune::{Env, Runtime};
use rune_theme_codenomad::field_kit;
use serde_json::{Value, json};

fn ready_state() -> State {
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

fn render_settled(state: State, size: (f32, f32), dark: bool) -> Runtime<State> {
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || view(s, cx)),
        size,
        Env::new(dark, 1.0),
    );
    for _ in 0..20 {
        rt.frame(0.02);
    }
    rt
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

fn has_state(node: &Value, state: &str) -> bool {
    node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|s| s == state))
}

#[test]
fn permission_dock_renders_structured_header_inset_resources_alert_and_offline_notice() {
    for dark in [false, true] {
        let mut s = ready_state();
        let ui = s.agent.as_mut().unwrap();
        ui.error = true;
        ui.selected = "perm-1".into();
        ui.permissions.push(Permission {
            tool: None,
            id: "perm-1".into(),
            action: "edit".into(),
            resources: vec![
                "packages/rune-app/src/agent/view.rs".into(),
                "packages/rune-app/src/agent/form_view.rs".into(),
            ],
            message: "Apply visual parity update to interruption dock".into(),
            supported: true,
        });
        ui.reasons.insert("perm-1".into(), TextEdit::new(""));

        let rt = render_settled(s, (390.0, 740.0), dark);
        let tree = rt.accessibility_json();

        let err = find_node(&tree, "agent-error").expect("agent-error node");
        assert_eq!(err["role"], "alert");

        let eyebrow = find_node(&tree, "form-eyebrow").expect("permission header eyebrow");
        assert_eq!(eyebrow["name"], "Permission");
        let title = find_node(&tree, "form-title").expect("permission header title");
        assert_eq!(title["name"], "edit");

        let elements = rt.elements();
        let resources = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("permission-resources"))
            .expect("permission-resources inset card");
        assert!(
            resources.rect[2] > 0.0
                && resources.rect[3] > 0.0
                && resources.fill.a > 0.0
                && resources.fill != field_kit(dark).c.bg_base,
            "permission resources must sit on a visible inset surface distinct from surface-field (dark={dark}): rect={:?} fill={:?}",
            resources.rect,
            resources.fill
        );

        let reason = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("reason-perm-1"))
            .expect("reason textarea");
        assert_eq!(reason.fill, field_kit(dark).c.bg_base);
        assert!(find_node(&tree, "permission-unsupported").is_none());
        assert!(find_node(&tree, "pending-offline-status").is_none());
    }

    // Unsupported/bounded permission disables approvals, keeps Reject active, and emits no fake failure alert.
    let mut unsupported = ready_state();
    let ui = unsupported.agent.as_mut().unwrap();
    ui.selected = "perm-unsupported".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-unsupported".into(),
        action: String::new(),
        resources: vec![],
        message: String::new(),
        supported: false,
    });
    ui.reasons
        .insert("perm-unsupported".into(), TextEdit::new(""));
    let rt = render_settled(unsupported, (390.0, 740.0), true);
    let tree = rt.accessibility_json();
    assert!(find_node(&tree, "permission-unsupported").is_none());
    assert_eq!(
        find_node(&tree, "form-eyebrow").expect("empty-action permission eyebrow")["name"],
        "Permission"
    );
    assert!(find_node(&tree, "form-title").is_none());
    for key in ["allow_once", "allow_always"] {
        assert!(
            has_state(find_node(&tree, key).expect(key), "disabled"),
            "{key} must be disabled for unsupported permission"
        );
    }
    assert!(
        !has_state(find_node(&tree, "reject").expect("reject"), "disabled"),
        "reject must remain enabled for unsupported/bounded permission"
    );

    // Offline state after initial connection exposes a polite status notice while locking reply buttons;
    // before initial connection (`known == false`), no premature "Reconnecting" status appears.
    let mut preconnect = ready_state();
    let ui = preconnect.agent.as_mut().unwrap();
    ui.known = false;
    ui.online = false;
    ui.selected = "perm-pre".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-pre".into(),
        action: "read".into(),
        resources: vec![],
        message: String::new(),
        supported: true,
    });
    ui.reasons.insert("perm-pre".into(), TextEdit::new(""));
    let rt_pre = render_settled(preconnect, (390.0, 740.0), false);
    assert!(find_node(&rt_pre.accessibility_json(), "pending-offline-status").is_none());

    let mut offline = ready_state();
    let ui = offline.agent.as_mut().unwrap();
    ui.online = false;
    ui.selected = "perm-offline".into();
    ui.permissions.push(Permission {
        tool: None,
        id: "perm-offline".into(),
        action: "read".into(),
        resources: vec!["README.md".into()],
        message: String::new(),
        supported: true,
    });
    ui.reasons.insert("perm-offline".into(), TextEdit::new(""));
    let rt = render_settled(offline, (390.0, 740.0), false);
    let tree = rt.accessibility_json();
    let status = find_node(&tree, "pending-offline-status").expect("offline status notice");
    assert_eq!(status["role"], "status");
    assert_eq!(status["name"], "Reconnecting");
    assert!(has_state(
        find_node(&tree, "allow_once").unwrap(),
        "disabled"
    ));
}

#[test]
fn multi_request_navigation_uses_compact_icon_buttons_and_updates_polite_position() {
    let mut s = ready_state();
    let ui = s.agent.as_mut().unwrap();
    ui.selected = "perm-a".into();
    for (id, action) in [("perm-a", "read"), ("perm-b", "edit")] {
        ui.permissions.push(Permission {
            tool: None,
            id: id.into(),
            action: action.into(),
            resources: vec![format!("/repo/{id}.rs")],
            message: String::new(),
            supported: true,
        });
        ui.reasons.insert(id.into(), TextEdit::new(""));
    }

    let mut rt = render_settled(s, (390.0, 740.0), true);
    let elements = rt.elements();
    let prev = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("pending-prev"))
        .expect("pending-prev");
    let next = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("pending-next"))
        .expect("pending-next");
    let pos = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("pending-position"))
        .expect("pending-position");
    assert!(
        prev.rect[2] <= 36.0
            && prev.rect[3] <= 36.0
            && next.rect[2] <= 36.0
            && next.rect[3] <= 36.0,
        "pending prev/next must be compact icon buttons: prev={:?} next={:?}",
        prev.rect,
        next.rect
    );
    assert!(
        (prev.rect[1] - next.rect[1]).abs() <= 4.0
            && prev.rect[0] < pos.rect[0]
            && pos.rect[0] < next.rect[0],
        "pending navigation must stay single-row at 390px: prev={:?} pos={:?} next={:?}",
        prev.rect,
        pos.rect,
        next.rect
    );

    let tree = rt.accessibility_json();
    let prev_node = find_node(&tree, "pending-prev").unwrap();
    let next_node = find_node(&tree, "pending-next").unwrap();
    let pos_node = find_node(&tree, "pending-position").unwrap();
    assert_eq!(prev_node["name"], "Previous request");
    assert_eq!(next_node["name"], "Next request");
    assert!(has_state(prev_node, "disabled"));
    assert!(!has_state(next_node, "disabled"));
    assert_eq!(pos_node["role"], "status");
    assert_eq!(pos_node["name"], "1 / 2");

    let (nx, ny) = rt.find("pending-next").unwrap();
    rt.pointer_down(nx, ny);
    rt.pointer_up(nx, ny);
    for _ in 0..6 {
        rt.frame(0.02);
    }
    assert_eq!(rt.state.agent.as_ref().unwrap().selected, "perm-b");
    let tree2 = rt.accessibility_json();
    assert!(!has_state(
        find_node(&tree2, "pending-prev").unwrap(),
        "disabled"
    ));
    assert!(has_state(
        find_node(&tree2, "pending-next").unwrap(),
        "disabled"
    ));
    assert_eq!(
        find_node(&tree2, "pending-position").unwrap()["name"],
        "2 / 2"
    );
}

#[test]
fn global_form_uses_project_request_eyebrow_and_model_picker_highlights_active_model() {
    let mut s = ready_state();
    let ui = s.agent.as_mut().unwrap();
    ui.picker = true;
    ui.models = vec![
        Model {
            reference: json!("m-1"),
            label: "Model Alpha".into(),
            included: true,
            limit: None,
        },
        Model {
            reference: json!("m-2"),
            label: "Model Beta".into(),
            included: true,
            limit: None,
        },
    ];
    ui.current = Some(json!("m-2"));
    ui.selected = "form-global".into();
    ui.forms.push(Form {
        tool: None,
        infer_websearch: false,
        owner: FormOwner::Global(None),
        id: "form-global".into(),
        title: "Authenticate provider".into(),
        fields: vec![json!({
            "key": "token",
            "type": "string",
            "title": "API key",
            "required": true
        })],
    });
    agent_forms::seed(&ui.forms, &mut ui.drafts);

    let rt = render_settled(s, (420.0, 760.0), true);
    let tree = rt.accessibility_json();
    assert_eq!(
        find_node(&tree, "form-eyebrow").unwrap()["name"],
        "Project request"
    );
    assert!(has_state(
        find_node(&tree, "model-picker").unwrap(),
        "expanded"
    ));

    assert_eq!(
        find_node(&tree, "model-\"m-1\"").expect("model-1 node")["role"],
        "button"
    );
    assert_eq!(
        find_node(&tree, "model-\"m-2\"").expect("model-2 node")["role"],
        "button"
    );
    let elements = rt.elements();
    let alpha = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("model-\"m-1\""))
        .expect("model-1 row");
    let beta = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("model-\"m-2\""))
        .expect("model-2 row");
    assert!(
        beta.fill != alpha.fill && beta.fill.a > 0.0,
        "selected model row must be visually highlighted: alpha={:?} beta={:?}",
        alpha.fill,
        beta.fill
    );
}
