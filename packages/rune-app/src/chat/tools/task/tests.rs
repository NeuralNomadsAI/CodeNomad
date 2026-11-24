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

fn child_steps_page_from(
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

fn child_steps_page(count: usize, older: bool, payload: &str) -> history::Page {
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
            && tree.contains("grandchild.rs"),
        "{tree}"
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
fn detached_reader_keeps_its_step_anchored_when_newer_steps_arrive() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "launch", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {"sessionID": "child", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
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
    let task_key = super::super::tool_key("parent", "launch");
    let step_key = format!("{task_key}-task-steps");
    let scroll_key = format!("{step_key}-scroll");
    let step0_key = super::super::tool_key(&format!("{step_key}-child:child:child_msg"), "step_0");
    let mut lease = None;
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(30, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    // While following bottom, anchors are inactive.
    assert!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .is_empty()
    );

    // Detach to the top of the steps viewport so step 0 is anchored.
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let before_y = rt
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str()))
        .expect("step 0 mounted at top")
        .rect[1];
    assert_eq!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .first()
            .map(String::as_str),
        Some("child_msg:step_0")
    );

    // Append 5 newer steps past INITIAL_STEPS (30): the window must not evict step 0.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(35, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let after = rt
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str()))
        .expect("step 0 must remain mounted while detached");
    assert!((before_y - after.rect[1]).abs() < 1.0);
    assert!(rt.find(&format!("reveal-{step_key}")).is_none());

    // Returning to the bottom immediately trims back to 30 without waiting for a new page.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .is_empty()
    );
    assert!(
        rt.elements()
            .into_iter()
            .all(|e| e.exiting || e.key.as_deref() != Some(step0_key.as_str())),
        "returning to bottom must evict step 0 immediately"
    );
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.accessibility_json().to_string().contains("Show 5 more"));

    // Mid-list detach when "Show more" appears must keep the read row stable.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(30, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 3));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 360.0));
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    let read_anchor = rt
        .state
        .transcript_display
        .task_anchors(&step_key)
        .first()
        .cloned()
        .expect("detached mid-list anchor");
    let read_id = read_anchor.split_once(':').unwrap().1;
    assert_ne!(read_id, "step_0", "must detach past index 5: {read_anchor}");
    let read_key = super::super::tool_key(&format!("{step_key}-child:child:child_msg"), read_id);
    let mid_before_y = rt
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(read_key.as_str()))
        .expect("mid-list row mounted")
        .rect[1];
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(35, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 4));
    });
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    let mid_after_y = rt
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(read_key.as_str()))
        .expect("mid-list row remains mounted")
        .rect[1];
    assert!(
        (mid_before_y - mid_after_y).abs() < 1.0,
        "appearing reveal shifted row {read_anchor}: before={mid_before_y} after={mid_after_y}"
    );
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.accessibility_json().to_string().contains("Show 5 more"));
    let _ = lease;
}

#[test]
fn reveal_uses_effective_start_and_survives_anchor_eviction() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "launch", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {"sessionID": "child", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
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
    let task_key = super::super::tool_key("parent", "launch");
    let step_key = format!("{task_key}-task-steps");
    let scroll_key = format!("{step_key}-scroll");
    let mut lease = None;

    // 80 steps mounted at 50..80; detach to top (anchor at step_50), then grow to 200 steps.
    // "Show 50 more" must reveal 0..50 on the first click even though desired is 170.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(80, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .first()
            .map(String::as_str),
        Some("child_msg:step_50")
    );
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(200, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.accessibility_json().to_string().contains("Show 50 more"));
    let (x, y) = rt
        .find(&format!("reveal-{step_key}"))
        .expect("reveal button");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let step0_key = super::super::tool_key(&format!("{step_key}-child:child:child_msg"), "step_0");
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str())),
        "first click must actually mount step_0"
    );
    assert!(
        rt.find(&format!("reveal-{step_key}")).is_none(),
        "first click must reveal all 50 promised steps"
    );

    // 190 steps -> reveal 100 -> read at step_60 -> 71 newer steps evict step_60 at the 200-step cap.
    // The next visible row (step_61) must stay mounted in place with no scroll jump.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        s.transcript_display.bind("srv", "ws", "other");
        s.transcript_display.bind("srv", "ws", "fresh");
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(190, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 3));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let (rx, ry) = rt
        .find(&format!("reveal-{step_key}"))
        .expect("reveal 100 button");
    rt.pointer_down(rx, ry);
    rt.pointer_up(rx, ry);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .first()
            .map(String::as_str),
        Some("child_msg:step_60")
    );
    let step61_key =
        super::super::tool_key(&format!("{step_key}-child:child:child_msg"), "step_61");
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step61_key.as_str())),
        "step_61 visible before eviction"
    );
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page_from(61, 200, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 4));
    });
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step61_key.as_str())),
        "surviving visible step_61 must stay mounted immediately without scrolling"
    );
    assert!(rt.find(&format!("reveal-{step_key}")).is_none());

    // A focused step stays mounted even after returning to bottom when newer steps arrive.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        s.transcript_display.bind("srv", "ws", "focus-a");
        s.transcript_display.bind("srv", "ws", "focus-b");
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(30, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 5));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let step0_toggle = format!("toggle-{step0_key}");
    rt.update(|_, tx| tx.focus(step0_toggle.clone(), true));
    rt.frame(1.0 / 60.0);
    rt.update(|s, tx| {
        Display::poll(s, false, 0.1, tx);
        tx.scroll_to_bottom_instant(scroll_key.clone());
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(35, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 6));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str())),
        "focused step_0 must stay mounted even after returning to bottom"
    );
    assert!(rt.find(&format!("reveal-{step_key}")).is_none());

    // Collapsing the task card clears its stored step anchor.
    let (tx, ty) = rt.find(&format!("toggle-{task_key}")).expect("task toggle");
    rt.pointer_down(tx, ty);
    rt.pointer_up(tx, ty);
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .is_empty()
    );

    // Disambiguated legacy step identities stay stable when an earlier duplicate slides past 200.
    let mut legacy = vec![json!({"id": "dup", "tool": "read"})];
    for _ in 0..199 {
        legacy.push(json!({"tool": "read"}));
    }
    let dup_key_before = super::legacy_identities(&legacy, 0)[0].clone();
    legacy.push(json!({"id": "dup", "tool": "read"}));
    let ids_after = super::legacy_identities(&legacy, 1);
    assert_ne!(
        ids_after.last().unwrap(),
        &dup_key_before,
        "second duplicate must not inherit the evicted first duplicate's key"
    );
    assert!(ids_after[0].starts_with("idx:1"));
    let _ = lease;
}
