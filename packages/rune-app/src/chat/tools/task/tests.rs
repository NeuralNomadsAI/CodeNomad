#[test]
fn task_uses_its_own_background_report_and_keeps_the_synthetic_row_hidden() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let launch = |id, at| {
        history::decode_message(&json!({
        "id":id,"type":"assistant","time":{"created":at,"completed":at},"content":[{
            "type":"tool","id":"call","name":"subagent","time":{"ran":at},
            "state":{"status":"completed","input":{"description":"Check the fixture","prompt":"Bounded prompt"},
                "metadata":{"sessionId":"child","status":"running"},
                "content":[{"type":"text","text":"Launch acknowledgement"}]}}]
    })).unwrap()
    };
    let report_row = |id, at, text| {
        history::decode_message(&json!({
        "id":id,"type":"synthetic","time":{"created":at},
        "text":format!("<subagent sessionID=\"child\" state=\"completed\">\n{text}\n</subagent>")
    })).unwrap()
    };
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(
        &mut state,
        json!({
            "toolCallExpansionDefaults":{"tools":{"task":"collapsed"}}
        }),
    );
    state.messages = vec![
        launch("first", 10).into(),
        report_row("older", 20, "First result").into(),
        launch("second", 30).into(),
        report_row("latest", 40, "Second result").into(),
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
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let parent = history::decode_message(&json!({
        "id":"parent","type":"assistant","time":{"completed":1},"content":[{
            "type":"tool","id":"launch","name":"task","state":{"status":"completed",
              "metadata":{"sessionID":"child","status":"running",
                "summary":[{"tool":"bash","title":"Legacy summary only","status":"completed"}]}}
        }]
    }))
    .unwrap();
    let child = history::decode(json!({"status":"window","latest":true,"messages":[
        {"id":"child-step","type":"assistant","time":{},"content":[{
            "type":"tool","id":"read","name":"read","state":{"status":"running","input":{"filePath":"actual.txt"}}
        }]}
    ]})).unwrap();
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
            json!({
                "toolCallExpansionDefaults":{"tools":{"read":"hidden"}}
            }),
        )
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(!tree.contains("actual.txt") && !tree.contains("Legacy summary only"));
}

#[test]
fn background_and_foreground_subagent_duration_follows_terminal_report_and_retires_to_zero_fps_idle()
 {
    use crate::{
        Phase, chat::actions::Display, history, init, platform::storage::unix_millis,
        strings::with_locale,
    };
    use rune::{Env, Runtime};
    use serde_json::json;

    let start = unix_millis().saturating_sub(15_000);
    // Background launch without part time.ran (falls back to message.time.created) and a 500ms ack.
    let bg_launch = history::decode_message(&json!({
        "id": "bg",
        "type": "assistant",
        "time": {"created": start, "completed": start + 500},
        "content": [{
            "type": "tool",
            "id": "call",
            "name": "opencode_subagent",
            "time": {"completed": start + 500},
            "state": {
                "status": "completed",
                "input": {"description": "Background worker"},
                "metadata": {"sessionID": "child_bg", "status": "running"}
            }
        }]
    }))
    .unwrap();
    // Background launch with no timestamp at all must still settle once its terminal report arrives.
    let bg_notime = history::decode_message(&json!({
        "id": "bg_nt",
        "type": "assistant",
        "time": {},
        "content": [{
            "type": "tool",
            "id": "call_nt",
            "name": "subagent",
            "state": {
                "status": "completed",
                "input": {"description": "Untimed worker"},
                "metadata": {"sessionID": "child_nt", "status": "running"}
            }
        }]
    }))
    .unwrap();
    // Foreground opencode_task falling back to message.time.created settles at 7s.
    let fg_done = history::decode_message(&json!({
        "id": "fg",
        "type": "assistant",
        "time": {"created": start, "completed": start + 7_000},
        "content": [{
            "type": "tool",
            "id": "call_fg",
            "name": "opencode_task",
            "time": {"completed": start + 7_000},
            "state": {
                "status": "completed",
                "input": {"description": "Foreground worker"},
                "content": [{"type": "text", "text": "FG_DONE"}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Streaming;
    state.messages = vec![bg_launch.into(), bg_notime.into(), fg_done.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                rune::col().children(s.messages.iter().flat_map(|row| {
                    row.parts.iter().filter_map(|part| {
                        let crate::content::Part::Tool(tool) = part else {
                            return None;
                        };
                        Some(super::super::view(s, &row.id, tool))
                    })
                }))
            })
        },
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"7s\""),
        "foreground message_created fallback: {tree}"
    );
    assert!(
        tree.contains("\"15s\"") || tree.contains("\"16s\""),
        "background launch ticks live past 500ms ack: {tree}"
    );
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 0.1, tx));
    });
    assert!(rt.wake_deadline().is_some());

    // Intermediate running report at +3s must NOT freeze the live duration or stop ticking.
    let running_report = history::decode_message(&json!({
        "id": "rep_run",
        "type": "synthetic",
        "time": {"created": start + 3_000},
        "text": "<subagent sessionID=\"child_bg\" state=\"running\">\nStill working\n</subagent>"
    }))
    .unwrap();
    rt.update(|s, _| s.messages.push(running_report.into()));
    rt.frame(0.2);
    let tree = rt.accessibility_json().to_string();
    assert!(
        !tree.contains("\"3s\""),
        "running report must not freeze duration: {tree}"
    );
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 0.3, tx));
    });
    assert!(rt.wake_deadline().is_some());

    // Terminal cancelled report at +11s and completed report for untimed launch settle both cards
    // and return the shared clock to 0 fps idle.
    let cancelled_report = history::decode_message(&json!({
        "id": "rep_cancel",
        "type": "synthetic",
        "time": {"created": start + 11_000},
        "text": "<background-result kind=\"subagent\" sessionID=\"child_bg\" state=\"cancelled\">\nStopped\n</background-result>"
    }))
    .unwrap();
    let untimed_report = history::decode_message(&json!({
        "id": "rep_nt",
        "type": "synthetic",
        "time": {"created": start + 4_000},
        "text": "<subagent sessionID=\"child_nt\" state=\"completed\">\nUNTIMED_RESULT\n</subagent>"
    }))
    .unwrap();
    rt.update(|s, _| {
        s.phase = Phase::Ready;
        s.messages.push(cancelled_report.into());
        s.messages.push(untimed_report.into());
        let nt_key = super::super::tool_key("bg_nt", "call_nt");
        Display::set_expanded(s, &nt_key, true);
    });
    rt.frame(0.4);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"11s\""),
        "terminal cancelled report sets 11s: {tree}"
    );
    assert!(
        tree.contains("\"Error\""),
        "cancelled report shows error status: {tree}"
    );
    assert!(
        tree.contains("UNTIMED_RESULT"),
        "untimed launch resolves terminal report: {tree}"
    );
    assert!(
        !tree.contains("\"Running\""),
        "all subagents settled: {tree}"
    );
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 2.0, tx));
    });
    rt.frame(2.1);
    assert!(
        rt.wake_deadline().is_none(),
        "settled subagents must stay at 0 fps idle"
    );
}

#[test]
fn detached_reader_anchor_survives_count_and_byte_truncation_with_explicit_notices() {
    use crate::{Phase, history, init, strings::with_locale};
    use rune::{Env, Runtime};
    use serde_json::json;

    let make_page = |start: usize, count: usize, big_last: bool| {
        let tools: Vec<_> = (start..start + count)
            .map(|i| {
                let text = if big_last && i == start + count - 1 {
                    "B".repeat((2 << 20) + 64_000)
                } else {
                    "ok".to_owned()
                };
                json!({
                    "type": "tool",
                    "id": format!("step_{i}"),
                    "name": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": format!("f_{i:03}.rs")},
                        "content": [{"type": "text", "text": text}]
                    }
                })
            })
            .collect();
        history::decode(json!({
            "status": "window",
            "latest": true,
            "messages": [{
                "id": "child_msg",
                "type": "assistant",
                "time": {"completed": 1},
                "content": tools
            }]
        }))
        .unwrap()
    };

    let parent = history::decode_message(&json!({
        "id": "parent",
        "type": "assistant",
        "time": {"completed": 1},
        "content": [{
            "type": "tool",
            "id": "launch",
            "name": "subagent",
            "state": {
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
    let row_key = |i: usize| {
        super::super::tool_key(
            &format!("{step_key}-child:child:child_msg"),
            &format!("step_{i}"),
        )
    };
    let rel_y = |rt: &Runtime<crate::State>, key: &str| {
        let els = rt.elements();
        let pane_y = els
            .iter()
            .find(|e| !e.exiting && e.key.as_deref() == Some(scroll_key.as_str()))
            .expect("steps scroll pane")
            .rect[1];
        let row_y = els
            .iter()
            .find(|e| !e.exiting && e.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("row {key} must stay mounted"))
            .rect[1];
        row_y - pane_y
    };

    // 1. Start with 40 steps (no truncation) and detach on step_10 at top of the mounted tail.
    let mut lease = None;
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", make_page(0, 40, false)),
        );
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"Steps\"") && tree.contains("\"40 steps\""),
        "{tree}"
    );
    assert!(
        !tree.contains("Showing the latest") && !tree.contains("Content too large to display."),
        "{tree}"
    );

    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let step10_key = row_key(10);
    assert_eq!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .first()
            .map(String::as_str),
        Some("child_msg:step_10")
    );
    let before_rel = rel_y(&rt, &step10_key);

    // 2. Cross byte-budget truncation (> 2 MiB) with < 200 steps: explicit "Content too large to display."
    //    status notice and full-steps copy appear while keeping "45 steps" and detached step_10 stable.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", make_page(0, 45, true)),
        );
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"45 steps\"") && !tree.contains("200+"),
        "{tree}"
    );
    assert!(tree.contains("Content too large to display."), "{tree}");
    assert!(rt.find(&format!("copy-{task_key}-steps")).is_some());
    assert!((before_rel - rel_y(&rt, &step10_key)).abs() < 1.0);

    // 3. Cross count truncation (> 200 steps: 210 total -> retains step_10..step_209):
    //    "200+ steps" and "Showing the latest 200 steps." appear while step_10 stays anchored.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", make_page(0, 210, false)),
        );
        assert!(crate::chat::events::poll_chat(s, 3));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("\"200+ steps\""), "{tree}");
    assert!(tree.contains("Showing the latest 200 steps."), "{tree}");
    assert!((before_rel - rel_y(&rt, &step10_key)).abs() < 1.0);

    // 4. Advance further past all previously anchored rows (step_50..step_249):
    //    detached reader lands on oldest surviving step_50 instead of jumping to bottom.
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", make_page(50, 200, false)),
        );
        assert!(crate::chat::events::poll_chat(s, 4));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let step50_key = row_key(50);
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step50_key.as_str())),
        "detached reader must land on oldest surviving step_50"
    );
    assert!(rt.find(&format!("reveal-{step_key}")).is_none());
    let _ = lease;
}
