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
    assert!(
        node.rect[3] > 0.0 && node.visible[2] > 0.0 && node.visible[3] >= node.rect[3] - 1.0,
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
        ui.forms.push(Form { tool: None, infer_websearch: false, id: ui.selected.clone(), title: "Synthetic question".into(), fields: (0..24).map(|i| json!({"key":format!("field{i}"),"type":"string","title":format!("Synthetic field {i}")})).collect() });
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
        assert!(
            (rail[0] - (history[0] + history[2])).abs() <= 1.0 && rail[0] + rail[2] <= 800.5,
            "{label}: rail horizontal placement {rail:?} must abut history {history:?} inside viewport"
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
    rt.update(|s, _| {
        crate::timeline::tests::set_outline_error(s, 240.0, false);
        crate::timeline::tests::set_filtered_notice(s, true);
    });
    rt.set_viewport((240.0, 260.0), 1.0);
    settle_all(&mut rt);
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
