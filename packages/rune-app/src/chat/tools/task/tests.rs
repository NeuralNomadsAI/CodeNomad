use crate::{Phase, chat::actions::Display, history, init, strings::with_locale};
use rune::{Env, Runtime};
use serde_json::json;

fn launch(id: &str, started: u64, ack: u64) -> crate::Message {
    history::decode_message(&json!({
        "id": id,
        "type": "assistant",
        "time": {"created": started, "completed": ack},
        "content": [{
            "type": "tool",
            "id": "call",
            "name": "subagent",
            "time": {"ran": started, "completed": ack},
            "state": {
                "status": "completed",
                "input": {"description": "Check the fixture", "prompt": "Bounded prompt"},
                "metadata": {"sessionId": "child", "status": "running"},
                "content": [{"type": "text", "text": "Launch acknowledgement"}]
            }
        }]
    }))
    .unwrap()
}

fn report_row(id: &str, at: u64, state: &str, text: &str) -> crate::Message {
    history::decode_message(&json!({
        "id": id,
        "type": "synthetic",
        "time": {"created": at},
        "text": format!("<subagent sessionID=\"child\" state=\"{state}\">\n{text}\n</subagent>")
    }))
    .unwrap()
}

pub(super) fn child_steps_page_from(
    start_id: usize,
    count: usize,
    older: bool,
    payload: &str,
) -> history::Page {
    let tools: Vec<_> = (start_id..start_id + count)
        .map(|i| {
            json!({
                "type": "tool",
                "id": format!("step_{i}"),
                "name": "read",
                "state": {
                    "status": "completed",
                    "input": {"filePath": format!("file_{i:03}.rs")},
                    "content": [{"type": "text", "text": payload}]
                }
            })
        })
        .collect();
    history::decode(json!({
        "status": "window",
        "latest": true,
        "older": if older { json!({"kind": "before", "messageID": "prev"}) } else { serde_json::Value::Null },
        "messages": [{"id": "child_msg", "type": "assistant", "time": {"completed": 1}, "content": tools}]
    }))
    .unwrap()
}

pub(super) fn child_steps_page(count: usize, older: bool, payload: &str) -> history::Page {
    child_steps_page_from(0, count, older, payload)
}

#[test]
fn task_uses_its_own_background_report_and_keeps_the_synthetic_row_hidden() {
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(
        &mut state,
        json!({"toolCallExpansionDefaults": {"tools": {"task": "collapsed"}}}),
    );
    state.messages = vec![
        launch("first", 10, 15).into(),
        report_row("older", 20, "completed", "First result").into(),
        launch("second", 30, 35).into(),
        report_row("latest", 40, "completed", "Second result").into(),
    ];
    let mut rt = Runtime::new(state, crate::view, (960.0, 900.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let before = rt.accessibility_json().to_string();
    assert!(!before.contains("First result") && !before.contains("Second result"));
    let (x, y) = rt.find("toggle-tool-first:4:call").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let after = rt.accessibility_json().to_string();
    assert!(after.contains("First result") && after.contains("Bounded prompt"));
    assert!(!after.contains("Second result") && !after.contains("Launch acknowledgement"));
}

#[test]
fn loaded_child_cards_replace_the_legacy_summary() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "launch", "name": "task", "state": {"status": "completed",
              "metadata": {"sessionID": "child", "status": "running",
                "summary": [{"tool": "bash", "title": "Legacy summary only", "status": "completed"}]}}
        }]
    }))
    .unwrap();
    let child = history::decode(json!({"status": "window", "latest": true, "messages": [
        {"id": "child-step", "type": "assistant", "time": {}, "content": [{
            "type": "tool", "id": "read", "name": "read", "state": {"status": "running", "input": {"filePath": "actual.txt"}}
        }]}
    ]}))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(parent.into());
    let mut rt = Runtime::new(state, crate::view, (960.0, 900.0), Env::new(false, 1.0));
    rt.frame(0.0);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Legacy summary only")
    );
    let mut lease = None;
    rt.update(|s, _| {
        lease = Some(s.transcript_display.children.install("child", child));
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("actual.txt") && !tree.contains("Legacy summary only"));
    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({"toolCallExpansionDefaults": {"tools": {"read": "hidden"}}}),
        )
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(!tree.contains("actual.txt") && !tree.contains("Legacy summary only"));
}

#[test]
fn subagent_duration_ticks_past_launch_ack_and_ends_at_terminal_report() {
    let start = 1_000_000_u64;
    let ack = start + 1_200;
    let mut state = init();
    state.phase = Phase::Ready;
    state
        .transcript_display
        .tool_clock
        .set_test_now(Some(start + 65_000));
    state.messages = vec![launch("run1", start, ack).into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Running") && tree.contains("\"1m 05s\""),
        "{tree}"
    );
    assert!(
        !tree.contains("\"1s\""),
        "must not freeze at launch ack: {tree}"
    );

    // Advancing the clock updates the displayed live label.
    let mut ticked = false;
    rt.update(|s, tx| {
        s.transcript_display
            .tool_clock
            .set_test_now(Some(start + 66_000));
        ticked = Display::poll(s, false, 0.01, tx);
    });
    assert!(ticked);
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Running") && tree.contains("\"1m 06s\""),
        "{tree}"
    );

    // An intermediate running report must keep ticking.
    rt.update(|s, _| {
        s.transcript_display
            .tool_clock
            .set_test_now(Some(start + 67_000));
        s.messages
            .push(report_row("mid", start + 66_500, "running", "Still working").into());
        s.revision += 1;
    });
    rt.frame(0.03);
    rt.update(|s, tx| ticked = Display::poll(s, false, 1.1, tx));
    assert!(ticked);
    rt.frame(1.12);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Running") && tree.contains("\"1m 07s\""),
        "{tree}"
    );

    // A terminal report freezes the duration at its timestamp and stops the clock.
    rt.update(|s, _| {
        s.transcript_display
            .tool_clock
            .set_test_now(Some(start + 75_000));
        s.messages
            .push(report_row("done", start + 67_000, "completed", "Final answer").into());
        s.revision += 1;
    });
    rt.frame(1.2);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Completed") && tree.contains("\"1m 7s\"") && !tree.contains("1m 15s"),
        "{tree}"
    );
    rt.update(|s, tx| ticked = Display::poll(s, false, 3.5, tx));
    assert!(!ticked);

    // An un-timestamped continuation must not inherit an older terminal report and must isolate its own report from the earlier launch.
    let untimed = history::decode_message(&json!({
        "id": "untimed",
        "type": "assistant",
        "time": {},
        "content": [{
            "type": "tool",
            "id": "call_untimed",
            "name": "subagent",
            "state": {
                "status": "completed",
                "input": {"description": "Untimed continuation"},
                "metadata": {"sessionId": "child", "status": "running"}
            }
        }]
    }))
    .unwrap();
    rt.update(|s, _| {
        s.messages.push(untimed.into());
        s.revision += 1;
    });
    rt.frame(3.55);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Untimed continuation") && tree.contains("Running"),
        "untimed launch inherited old report: {tree}"
    );
    rt.update(|s, _| {
        s.messages.push(
            report_row(
                "done_untimed",
                start + 68_000,
                "completed",
                "Untimed result",
            )
            .into(),
        );
        s.revision += 1;
    });
    rt.frame(3.58);
    let tool_at = |index: usize| match &rt.state.messages[index].parts[0] {
        crate::content::Part::Tool(t) => Some(t.as_ref()),
        _ => None,
    };
    assert_eq!(
        tool_at(0).and_then(|t| super::report_body(&rt.state, "run1", t)),
        Some("Final answer")
    );
    assert_eq!(
        tool_at(3).and_then(|t| super::report_body(&rt.state, "untimed", t)),
        Some("Untimed result")
    );

    // A cancelled/error continuation ends at its own terminal report.
    let cont = start + 70_000;
    rt.update(|s, _| {
        s.messages.push(launch("run2", cont, cont + 200).into());
        s.messages
            .push(report_row("err", cont + 4_000, "cancelled", "Aborted").into());
        s.revision += 1;
    });
    rt.frame(3.6);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Error") && tree.contains("\"4s\""), "{tree}");
}

#[test]
fn nested_subagent_stops_duration_from_child_snapshot_report() {
    let start = 2_000_000_u64;
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"created": start, "completed": start + 100},
        "content": [{
            "type": "tool", "id": "outer", "name": "subagent",
            "time": {"ran": start, "completed": start + 100},
            "state": {
                "status": "completed",
                "input": {"description": "Outer agent"},
                "metadata": {"sessionId": "child_a", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state
        .transcript_display
        .tool_clock
        .set_test_now(Some(start + 65_000));
    crate::settings::fixture_transcript(
        &mut state,
        json!({"toolCallExpansionDefaults": {"tools": {"task": "expanded", "read": "collapsed"}}}),
    );
    state.messages.push(parent.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    let nested_launch = json!({
        "id": "a_msg_1", "type": "assistant", "time": {"created": start + 1_000},
        "content": [{
            "type": "tool", "id": "inner", "name": "subagent",
            "time": {"ran": start + 1_000, "completed": start + 1_200},
            "state": {
                "status": "completed",
                "input": {"description": "Inner agent"},
                "metadata": {"sessionId": "child_b", "status": "running"}
            }
        }]
    });
    let page_running = history::decode(json!({
        "status": "window", "latest": true, "messages": [nested_launch]
    }))
    .unwrap();
    let mut lease_a = None;
    let mut lease_b = None;
    rt.update(|s, _| {
        lease_a = Some(
            s.transcript_display
                .children
                .install("child_a", page_running),
        );
        lease_b = Some(
            s.transcript_display.children.install_under(
                Some("child_a"),
                "child_b",
                history::decode(json!({
                    "status": "window", "latest": true, "messages": [{
                        "id": "b_msg_1", "type": "assistant", "time": {"completed": 1},
                        "content": [{
                            "type": "tool", "id": "grandchild_read", "name": "read",
                            "state": {"status": "completed", "input": {"filePath": "grandchild.rs"}}
                        }]
                    }]
                }))
                .unwrap(),
            ),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    rt.frame(0.0);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Inner agent")
            && tree.contains("\"1m 04s\"")
            && !tree.contains("grandchild.rs"),
        "nested subagent cards must start collapsed by default: {tree}"
    );
    let outer_key = super::super::tool_key("parent", "outer");
    let inner_key = super::super::tool_key(
        &format!("{outer_key}-task-steps-child:child_a:a_msg_1"),
        "inner",
    );
    let (ix, iy) = rt
        .find(&format!("toggle-{inner_key}"))
        .expect("nested subagent toggle");
    rt.pointer_down(ix, iy);
    rt.pointer_up(ix, iy);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Inner agent")
            && tree.contains("\"1m 04s\"")
            && tree.contains("grandchild.rs"),
        "expanding nested subagent must reveal grandchild steps: {tree}"
    );

    // Even when a nested report body exceeds the 2 MiB body budget, its terminal state and timestamp still stop the clock.
    let huge_body = "z".repeat((2 << 20) + 128);
    let page_done = history::decode(json!({
        "status": "window", "latest": true, "messages": [
            nested_launch,
            {
                "id": "a_msg_2", "type": "synthetic", "time": {"created": start + 6_000},
                "text": format!("<subagent sessionID=\"child_b\" state=\"completed\">\n{huge_body}\n</subagent>")
            }
        ]
    }))
    .unwrap();
    rt.update(|s, _| {
        s.transcript_display
            .tool_clock
            .set_test_now(Some(start + 90_000));
        lease_a = Some(s.transcript_display.children.install("child_a", page_done));
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Completed") && tree.contains("\"5s\""),
        "oversized report body must still settle nested status/duration: {tree}"
    );
    let _ = (lease_a, lease_b);
}

#[test]
fn child_step_truncation_reports_proven_limits_and_preserves_legacy_on_empty_page() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "launch", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {
                    "sessionID": "child",
                    "status": "running",
                    "summary": [{"tool": "bash", "title": "Legacy summary only", "status": "completed"}]
                }
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(parent.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    let mut lease = None;

    // 205 child steps prove step-limit overflow: 200+ count and status notice.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(205, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("200+ steps") && tree.contains("Showing the latest 200 steps."),
        "{tree}"
    );

    // 5 steps with an older page cursor must not falsely claim 200 truncated steps.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(5, true, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("5 steps") && !tree.contains("Showing the latest"),
        "{tree}"
    );

    // A child page with 0 tools and an older cursor keeps the legacy summary fallback.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(0, true, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 3));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Legacy summary only") && !tree.contains("Showing the latest"),
        "{tree}"
    );

    // Byte-budget overflow reports the exact retained count and formats count with '+'.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(10, false, &"x".repeat(450_000))),
        );
        assert!(crate::chat::events::poll_chat(s, 4));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("4+ steps") && tree.contains("Showing the latest 4 steps."),
        "{tree}"
    );

    // When 0 child steps fit in 2 MiB, keep the truncation notice AND fall back to the legacy summary.
    rt.update(|s, _| {
        lease = Some(s.transcript_display.children.install(
            "child",
            child_steps_page(1, false, &"y".repeat((2 << 20) + 64)),
        ));
        assert!(crate::chat::events::poll_chat(s, 5));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Legacy summary only") && tree.contains("Content too large to display."),
        "0-retained byte overflow must keep notice and legacy fallback: {tree}"
    );
    let _ = lease;
}

#[test]
fn mutual_child_references_non_transitive_times_untimed_reports_and_late_session_id() {
    // 1. Mutual references between two direct root children must never recurse or reuse cross-parent snapshots.
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(
        &mut state,
        json!({"toolCallExpansionDefaults": {"tools": {"task": "expanded"}}}),
    );
    let make_root = |id: &str, child: &str| {
        history::decode_message(&json!({
            "id": id, "type": "assistant", "time": {"completed": 1},
            "content": [{"type": "tool", "id": id, "name": "subagent", "state": {
                "status": "completed", "metadata": {"sessionId": child, "status": "running"}
            }}]
        }))
        .unwrap()
    };
    state.messages = vec![
        make_root("m_a", "child_a").into(),
        make_root("m_b", "child_b").into(),
    ];
    let mut rt = Runtime::new(
        state,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    let mut leases = Vec::new();
    rt.update(|s, _| {
        for (own, other) in [("child_a", "child_b"), ("child_b", "child_a")] {
            let page = history::decode(json!({
                "status": "window", "latest": true, "messages": [{
                    "id": format!("msg_{own}"), "type": "assistant", "time": {"completed": 1},
                    "content": [{"type": "tool", "id": format!("call_{own}"), "name": "subagent", "state": {
                        "status": "completed", "metadata": {"sessionId": other, "status": "running"}
                    }}]
                }]
            }))
            .unwrap();
            leases.push(s.transcript_display.children.install(own, page));
        }
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.state
            .transcript_display
            .children
            .snapshot(Some("child_a"), "child_b")
            .is_none()
            && rt
                .state
                .transcript_display
                .children
                .snapshot(Some("child_b"), "child_a")
                .is_none(),
        "root snapshots must never be reused under another parent"
    );
    rt.update(|s, _| {
        leases.push(
            s.transcript_display
                .children
                .install_refused(Some("child_a"), "child_b"),
        );
        crate::chat::events::poll_chat(s, 2);
    });
    assert!(
        rt.state
            .transcript_display
            .children
            .is_refused(Some("child_a"), "child_b")
            && rt.state.transcript_display.children.in_flight_count() == 0
            && rt
                .state
                .transcript_display
                .children
                .snapshot(Some("child_a"), "child_b")
                .is_none(),
        "refused cross-parent edge must release its slot and store no snapshot"
    );

    // 2. Non-transitive timestamps, unrelated-tool isolation, and nested same-timestamp native order.
    let mut s2 = init();
    let unrelated_tool = history::decode_message(&json!({
        "id": "m_other", "type": "assistant", "time": {"created": 30_000},
        "content": [{"type": "tool", "id": "other_read", "name": "read", "time": {"ran": 30_000},
            "state": {"status": "completed", "input": {"filePath": "a.rs"}}}]
    }))
    .unwrap();
    let untimed_launch = history::decode_message(&json!({
        "id": "m_mid", "type": "assistant", "time": {},
        "content": [{"type": "tool", "id": "call", "name": "subagent", "state": {
            "status": "completed", "metadata": {"sessionId": "child", "status": "running"}
        }}]
    }))
    .unwrap();
    let missing_ts_report = history::decode_message(&json!({
        "id": "r_none", "type": "synthetic", "time": {},
        "text": "<subagent sessionID=\"child\" state=\"completed\">\nNo timestamp\n</subagent>"
    }))
    .unwrap();
    let zero_ts_report = history::decode_message(&json!({
        "id": "r_zero", "type": "synthetic", "time": {"created": 0},
        "text": "<subagent sessionID=\"child\" state=\"completed\">\nZero timestamp\n</subagent>"
    }))
    .unwrap();
    s2.messages = vec![
        launch("m_30", 30_000, 30_100).into(),
        untimed_launch.clone().into(),
        launch("m_10", 10_000, 10_100).into(),
        missing_ts_report.into(),
        zero_ts_report.into(),
    ];
    for (idx, msg_id) in [(0, "m_30"), (1, "m_mid"), (2, "m_10")] {
        let crate::content::Part::Tool(tool) = &s2.messages[idx].parts[0] else {
            continue;
        };
        let d = super::delivery(&s2, msg_id, tool).expect("delivery");
        assert!(!d.status.running && d.status.ended.is_none());
    }
    // Unrelated tool at t=30_000 must not pollute an untimed launch whose report is at t=20_000.
    let mut s_iso = init();
    s_iso.messages = vec![
        unrelated_tool.into(),
        untimed_launch.into(),
        report_row("r_20", 20_000, "completed", "Isolated result").into(),
    ];
    let crate::content::Part::Tool(iso_tool) = &s_iso.messages[1].parts[0] else {
        panic!("expected tool");
    };
    let d_iso = super::delivery(&s_iso, "m_mid", iso_tool).expect("isolated delivery");
    assert!(!d_iso.status.running && d_iso.body == Some("Isolated result"));
    // Two nested reports with identical timestamps between the same steps preserve native order.
    let mut s_nested = init();
    let nested_page = history::decode(json!({
        "status": "window", "latest": true, "messages": [
            {"id": "n1", "type": "assistant", "time": {"created": 100}, "content": [
                {"type": "tool", "id": "sub", "name": "subagent", "time": {"ran": 100}, "state": {
                    "status": "completed", "metadata": {"sessionId": "grand", "status": "running"}
                }}
            ]},
            {"id": "z_first", "type": "synthetic", "time": {"created": 200},
                "text": "<subagent sessionID=\"grand\" state=\"running\">\nFirst\n</subagent>"},
            {"id": "a_second", "type": "synthetic", "time": {"created": 200},
                "text": "<subagent sessionID=\"grand\" state=\"completed\">\nSecond wins\n</subagent>"}
        ]
    }))
    .unwrap();
    let _nested_lease = s_nested
        .transcript_display
        .children
        .install("parent_child", nested_page);
    crate::chat::events::poll_chat(&mut s_nested, 1);
    let nested_tool = s_nested
        .transcript_display
        .children
        .steps(None, "parent_child")[0]
        .1
        .clone();
    let d_nested = super::delivery(&s_nested, "child:parent_child:n1", &nested_tool)
        .expect("nested same-ts delivery");
    assert!(
        !d_nested.status.running && d_nested.body == Some("Second wins"),
        "later native report must beat earlier report with same timestamp even if its row id sorts earlier"
    );

    // 3. Late and changed sessionID (A -> B) on an already-visible card trigger demand without scroll and preserve focus.
    let start = 5_000_000_u64;
    let mut s3 = init();
    s3.phase = Phase::Ready;
    s3.transcript_display
        .tool_clock
        .set_test_now(Some(start + 5_000));
    crate::settings::fixture_transcript(
        &mut s3,
        json!({"toolCallExpansionDefaults": {"tools": {"task": "expanded"}}}),
    );
    s3.messages = vec![
        history::decode_message(&json!({
            "id": "late", "type": "assistant", "time": {"created": start},
            "content": [{"type": "tool", "id": "c1", "name": "subagent", "time": {"ran": start},
                "state": {"status": "running", "input": {"description": "Late child"}, "metadata": {}}}]
        }))
        .unwrap()
        .into(),
    ];
    let mut rt3 = Runtime::new(
        s3,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    let late_toggle = format!("toggle-{}", super::super::tool_key("late", "c1"));
    rt3.frame(0.0);
    rt3.frame(0.0);
    rt3.update(|_, tx| tx.focus(late_toggle.clone(), true));
    rt3.frame(0.02);
    assert!(
        !rt3.state
            .transcript_display
            .children
            .has_demand(None, "child_late")
    );
    rt3.update(|s, _| {
        s.messages[0] = history::decode_message(&json!({
            "id": "late", "type": "assistant", "time": {"created": start},
            "content": [{"type": "tool", "id": "c1", "name": "subagent", "time": {"ran": start, "completed": start + 100},
                "state": {"status": "completed", "input": {"description": "Late child"}, "metadata": {"sessionId": "child_late", "status": "running"}}}]
        }))
        .unwrap()
        .into();
        s.revision += 1;
    });
    rt3.frame(0.04);
    rt3.frame(0.06);
    assert!(
        rt3.state
            .transcript_display
            .children
            .has_demand(None, "child_late"),
        "late sessionId must trigger demand without scrolling"
    );
    assert!(
        rt3.elements()
            .into_iter()
            .any(|e| !e.exiting && e.focused && e.key.as_deref() == Some(late_toggle.as_str())),
        "focus must remain on task toggle after sessionId arrives"
    );
    rt3.update(|s, _| {
        s.messages[0] = history::decode_message(&json!({
            "id": "late", "type": "assistant", "time": {"created": start},
            "content": [{"type": "tool", "id": "c1", "name": "subagent", "time": {"ran": start, "completed": start + 100},
                "state": {"status": "completed", "input": {"description": "Late child"}, "metadata": {"sessionId": "child_next", "status": "running"}}}]
        }))
        .unwrap()
        .into();
        s.revision += 1;
    });
    rt3.frame(0.07);
    rt3.frame(0.075);
    assert!(
        rt3.state
            .transcript_display
            .children
            .has_demand(None, "child_next"),
        "replacing sessionId A -> B must trigger demand for child_next without scrolling"
    );
    assert!(
        rt3.elements()
            .into_iter()
            .any(|e| !e.exiting && e.focused && e.key.as_deref() == Some(late_toggle.as_str())),
        "focus must remain on task toggle when sessionId changes from A to B"
    );
    rt3.update(|s, _| {
        s.messages.push(
            history::decode_message(&json!({
                "id": "late_done", "type": "synthetic", "time": {"created": start + 8_000},
                "text": "<subagent sessionID=\"child_next\" state=\"completed\">\nDone\n</subagent>"
            }))
            .unwrap()
            .into(),
        );
        s.revision += 1;
    });
    rt3.frame(0.08);
    assert!(
        rt3.elements()
            .into_iter()
            .any(|e| !e.exiting && e.focused && e.key.as_deref() == Some(late_toggle.as_str())),
        "focus must remain on task toggle when terminal report stops the timer"
    );

    // 4. Structured JSON resident-byte accounting crosses 2 MiB on large null arrays.
    let null_heavy = json!(vec![serde_json::Value::Null; 100_000]);
    assert!(super::json_bytes(&null_heavy) > super::STEP_BYTES);
    let _ = leases;
}

#[test]
fn child_queue_promotes_all_visible_demands_preserves_lru_cache_and_allows_deep_nesting() {
    let mut s = init();
    let mut leases = Vec::new();
    for i in 0..20 {
        let id = format!("child_{i:02}");
        let card = format!("card_{i:02}");
        let lease = std::rc::Rc::default();
        super::Children::demand(&mut s, None, &id, &card, &lease, true);
        leases.push((id, lease));
    }
    for (id, _) in &leases {
        assert!(
            s.transcript_display.children.has_demand(None, id),
            "every visible demand past 16 must be queued: {id}"
        );
    }

    // Drain all 20 visible demands in batches of at most 4 without starvation.
    let mut dispatched = Vec::new();
    let mut tick = 1usize;
    loop {
        let batch = s.transcript_display.children.dispatch_test_slots();
        if batch.is_empty() {
            break;
        }
        assert!(batch.len() <= 4 && s.transcript_display.children.in_flight_count() <= 4);
        for key in &batch {
            let page = if key.1 == "child_03" {
                None
            } else {
                Some(child_steps_page(1, false, "ok"))
            };
            s.transcript_display.children.complete_test_slot(key, page);
            dispatched.push(key.1.clone());
        }
        crate::chat::events::poll_chat(&mut s, tick);
        tick += 1;
    }
    assert_eq!(dispatched.len(), 20);
    assert_eq!(dispatched[0], "child_00");
    assert_eq!(dispatched[19], "child_19");
    assert!(s.transcript_display.children.is_refused(None, "child_03"));
    assert!(
        s.transcript_display
            .children
            .snapshot(None, "child_03")
            .is_none()
    );
    assert_eq!(s.transcript_display.children.in_flight_count(), 0);

    // Dropping a card's lease removes its live demand while retaining its cached snapshot.
    leases.remove(0);
    crate::chat::events::poll_chat(&mut s, tick);
    assert!(!s.transcript_display.children.has_demand(None, "child_00"));
    assert!(
        s.transcript_display
            .children
            .snapshot(None, "child_00")
            .is_some(),
        "unmounted card snapshot must survive in bounded cache"
    );

    // Cache stays bounded at 32 entries across 35 distinct children.
    let mut extra_leases = Vec::new();
    for i in 20..40 {
        let id = format!("child_{i:02}");
        extra_leases.push(
            s.transcript_display
                .children
                .install(&id, child_steps_page(1, false, "ok")),
        );
    }
    crate::chat::events::poll_chat(&mut s, tick + 1);
    assert_eq!(s.transcript_display.children.snapshot_count(), 32);

    // 4-level nesting chain is allowed when its parent snapshot exists, while ancestor cycles stay blocked.
    let l1 = s
        .transcript_display
        .children
        .install("a", child_steps_page(1, false, "ok"));
    let l2 = s.transcript_display.children.install_under(
        Some("a"),
        "b",
        child_steps_page(1, false, "ok"),
    );
    let l3 = s.transcript_display.children.install_under(
        Some("b"),
        "c",
        child_steps_page(1, false, "ok"),
    );
    crate::chat::events::poll_chat(&mut s, tick + 2);
    assert!(
        s.transcript_display.children.can_watch(Some("a>b>c"), "d"),
        "nesting deeper than 3 levels must be allowed when parent snapshot is verified"
    );
    assert!(
        !s.transcript_display.children.can_watch(Some("a>b>c"), "a"),
        "ancestor cycles must still be blocked at any depth"
    );
    let _ = (leases, extra_leases, l1, l2, l3);
}
