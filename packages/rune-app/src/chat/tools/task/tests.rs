use crate::{
    Phase, chat::actions::Display, history, init, platform::storage::unix_millis,
    strings::with_locale,
};
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

fn child_steps_page(count: usize, older: bool, payload: &str) -> history::Page {
    let tools: Vec<_> = (0..count)
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
    let start = unix_millis().saturating_sub(65_000);
    let ack = start + 1_200;
    let mut state = init();
    state.phase = Phase::Ready;
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
    assert!(tree.contains("Running") && tree.contains("1m 0"), "{tree}");
    assert!(
        !tree.contains("\"1s\""),
        "must not freeze at launch ack: {tree}"
    );
    let mut ticked = false;
    rt.update(|s, tx| ticked = Display::poll(s, false, 0.01, tx));
    assert!(ticked);

    // An intermediate running report must keep ticking.
    rt.update(|s, _| {
        s.messages
            .push(report_row("mid", start + 10_000, "running", "Still working").into());
        s.revision += 1;
    });
    rt.frame(0.02);
    rt.update(|s, tx| ticked = Display::poll(s, false, 1.1, tx));
    assert!(ticked);
    assert!(rt.accessibility_json().to_string().contains("Running"));

    // A terminal report freezes the duration at its timestamp and stops the clock.
    rt.update(|s, _| {
        s.messages
            .push(report_row("done", start + 67_000, "completed", "Final answer").into());
        s.revision += 1;
    });
    rt.frame(1.2);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Completed") && tree.contains("1m 7s"),
        "{tree}"
    );
    rt.update(|s, tx| ticked = Display::poll(s, false, 3.5, tx));
    assert!(!ticked);

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
fn child_step_truncation_reports_count_bytes_and_older_pages() {
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
    state.messages.push(parent.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| with_locale("en", || crate::view(s, cx)),
        (1160.0, 900.0),
        Env::new(false, 1.0),
    );
    let mut lease = None;
    for (page, expected) in [
        (
            child_steps_page(205, false, "ok"),
            "Showing the latest 200 steps.",
        ),
        (
            child_steps_page(5, true, "ok"),
            "Showing the latest 200 steps.",
        ),
        (
            child_steps_page(10, false, &"x".repeat(450_000)),
            "Showing the latest 4 steps.",
        ),
    ] {
        rt.update(|s, _| {
            lease = Some(s.transcript_display.children.install("child", page));
            assert!(crate::chat::events::poll_chat(s, 1));
        });
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains(expected), "missing {expected} in {tree}");
    }
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
    // Detach to the top of the steps viewport so step 0 is the reader's anchor.
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
        rt.state.transcript_display.task_anchor(&step_key),
        Some("child_msg:step_0")
    );

    // Append 5 newer steps past INITIAL_STEPS (30): the window must not evict step 0.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(35, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
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

    // Once the reader scrolls down past the sliding window start, older steps may slide out.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert_ne!(
        rt.state.transcript_display.task_anchor(&step_key),
        Some("child_msg:step_0")
    );
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(40, false, "ok")),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.accessibility_json().to_string().contains("Show 10 more"));
    let _ = lease;
}
