use crate::{Phase, chat::actions::Display, history, init, strings::with_locale};
use rune::{Env, Runtime};
use serde_json::json;

fn child_steps_page_from(start: usize, count: usize, older: bool, payload: &str) -> history::Page {
    let tools: Vec<_> = (start..start + count)
        .map(|i| {
            json!({
                "type": "tool",
                "id": format!("step_{i}"),
                "name": "read",
                "state": {
                    "status": "completed",
                    "input": {"filePath": format!("f_{i:03}.rs")},
                    "content": [{"type": "text", "text": payload}]
                }
            })
        })
        .collect();
    let mut page = json!({
        "status": "window",
        "latest": true,
        "messages": [{
            "id": "child_msg",
            "type": "assistant",
            "time": {"completed": 1},
            "content": tools
        }]
    });
    if older {
        page["older"] = json!({"kind": "before", "messageID": "child_msg"});
    }
    history::decode(page).unwrap()
}

fn child_steps_page(count: usize, older: bool, payload: &str) -> history::Page {
    child_steps_page_from(0, count, older, payload)
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
    assert!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .is_empty()
    );

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
fn reveal_virtual_rows_focus_and_real_selection_protection() {
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

    // 1. 80 steps mounted at 50..80; detach to top (step_50), grow to 200 steps.
    // "Show 50 more" must reveal 0..50 on first click, and virtual_rows must only mount the visible window.
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
    rt.state.transcript_display.task_row_builds.set(0);
    let (x, y) = rt
        .find(&format!("reveal-{step_key}"))
        .expect("reveal button");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    let built_on_reveal = rt.state.transcript_display.task_row_builds.get();
    assert!(
        built_on_reveal < 80,
        "virtual_rows builder must only be invoked for the mounted window out of 200 steps, got {built_on_reveal} builds"
    );
    for _ in 0..7 {
        rt.frame(1.0 / 60.0);
    }
    let mounted_step_rows = rt
        .elements()
        .into_iter()
        .filter(|e| {
            !e.exiting
                && e.key.as_deref().is_some_and(|k| {
                    k.starts_with(&format!("toggle-tool-{step_key}-child:child:child_msg"))
                })
        })
        .count();
    assert!(
        mounted_step_rows < 80,
        "virtual_rows must only mount visible window out of 200 steps, got {mounted_step_rows}"
    );
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

    // 2. Anchor eviction at 200-step cap falls back to surviving visible step_61.
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        s.transcript_display.bind("srv", "ws", "evict-a");
        s.transcript_display.bind("srv", "ws", "evict-b");
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

    // 3. Focused step stays mounted at bottom, and key_matches_row avoids prefix collisions.
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
                .install("child", child_steps_page(30, false, "selectable_step_zero")),
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
                .install("child", child_steps_page(35, false, "selectable_step_zero")),
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
            .any(|e| !e.exiting && e.focused && e.key.as_deref() == Some(step0_toggle.as_str())),
        "focused step_0 control must stay mounted and focused after returning to bottom"
    );
    assert!(super::key_matches_row(
        &format!("copy-{step0_key}-output"),
        &step0_key
    ));
    assert!(super::key_matches_row(
        &format!("reveal-{step0_key}-tool_output"),
        &step0_key
    ));
    assert!(super::key_matches_row(
        &format!("toggle-tool-{step0_key}-task-steps-child:a:m:inner"),
        &step0_key
    ));
    assert!(!super::key_matches_row("toggle-foo-idx:10", "foo-idx:1"));

    // 4. Real pointer-drag selection inside expanded step_0 triggers on_selection_change and protects step_0.
    let (sx, sy) = rt.find(&step0_toggle).expect("step_0 toggle");
    rt.pointer_down(sx, sy);
    rt.pointer_up(sx, sy);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, tx| {
        tx.focus(format!("toggle-{task_key}"), true);
        Display::poll(s, false, 0.2, tx);
    });
    rt.frame(1.0 / 60.0);
    let payload_el = rt
        .elements()
        .into_iter()
        .find(|e| {
            !e.exiting
                && e.path.contains(&format!("/{step0_key}/"))
                && e.text.as_deref() == Some("selectable_step_zero")
        })
        .expect("selectable payload inside step_0");
    let [px, py, pw, ph] = payload_el.rect;
    rt.pointer_down(px + 1.0, py + 2.0);
    rt.pointer_move(px + pw - 1.0, py + ph - 2.0);
    rt.pointer_up(px + pw - 1.0, py + ph - 2.0);
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.selected_text().as_deref(), Some("selectable_step_zero"));
    assert!(
        rt.state
            .transcript_display
            .task_selected(&step_key)
            .iter()
            .any(|k| k == &step0_key),
        "real drag selection must record step_0 via on_selection_change"
    );
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 220.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert_ne!(
        rt.state
            .transcript_display
            .task_anchors(&step_key)
            .first()
            .map(String::as_str),
        Some("child_msg:step_0"),
        "visible_anchor must move past step_0 so selection alone protects index 0"
    );
    rt.update(|s, _| {
        lease = Some(
            s.transcript_display
                .children
                .install("child", child_steps_page(40, false, "selectable_step_zero")),
        );
        assert!(crate::chat::events::poll_chat(s, 7));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.find(&format!("reveal-{step_key}")).is_none(),
        "real-selected step_0 must hold start at 0 without inserting a reveal row"
    );
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str())),
        "real-selected step_0 must stay mounted when newer steps arrive"
    );

    // 5. Collapsing the task card clears its stored step anchor.
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

    // 6. Disambiguated legacy step identities stay stable when an earlier duplicate slides past 200.
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

#[test]
fn parent_steps_pane_clips_nested_subagent_visibility() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "outer", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {"sessionID": "child_a", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let mut tools = vec![json!({
        "type": "tool", "id": "nested_0", "name": "subagent", "state": {
            "status": "completed",
            "input": {"description": "Nested first"},
            "metadata": {"sessionID": "child_nested", "status": "running"}
        }
    })];
    for i in 1..30 {
        tools.push(json!({
            "type": "tool", "id": format!("read_{i}"), "name": "read", "state": {
                "status": "completed", "input": {"filePath": format!("f_{i:02}.rs")}
            }
        }));
    }
    let page = history::decode(json!({
        "status": "window", "latest": true,
        "messages": [{"id": "a_msg", "type": "assistant", "time": {"completed": 1}, "content": tools}]
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
    let task_key = super::super::tool_key("parent", "outer");
    let step_key = format!("{task_key}-task-steps");
    let scroll_key = format!("{step_key}-scroll");
    let nested_key = super::super::tool_key(&format!("{step_key}-child:child_a:a_msg"), "nested_0");
    let mut lease = None;
    let mut nested_lease = None;
    rt.update(|s, _| {
        lease = Some(s.transcript_display.children.install("child_a", page));
        let empty = history::decode(json!({
            "status": "window", "latest": true, "messages": []
        }))
        .unwrap();
        nested_lease = Some(s.transcript_display.children.install_under(
            Some("child_a"),
            "child_nested",
            empty,
        ));
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let (nx, ny) = rt
        .find(&format!("toggle-{nested_key}"))
        .expect("nested_0 toggle");
    rt.pointer_down(nx, ny);
    rt.pointer_up(nx, ny);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.state.transcript_display.children.has_visible_card(
            Some("child_a"),
            "child_nested",
            &nested_key
        ),
        "expanded visible nested card must be active in child demands"
    );
    rt.update(|_, tx| tx.scroll_to_bottom_instant(scroll_key.clone()));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        crate::chat::events::poll_chat(s, 2);
    });
    assert!(
        !rt.state.transcript_display.children.has_visible_card(
            Some("child_a"),
            "child_nested",
            &nested_key
        ),
        "scrolling nested card out of parent steps_pane must prune its demand"
    );
    let _ = (lease, nested_lease);
}

#[test]
fn focused_markdown_link_inside_step_and_grandchild_protects_row_from_eviction() {
    let parent = history::decode_message(&json!({
        "id": "parent", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "launch", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {"sessionID": "child", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let make_page = |count: usize| {
        let mut tools = vec![json!({
            "type": "tool", "id": "step_0", "name": "skill", "state": {
                "status": "completed",
                "input": {"id": "guide"},
                "content": [{"type": "text", "text": "Read [the guide](https://example.com/step0-guide) first."}]
            }
        })];
        for i in 1..count {
            tools.push(json!({
                "type": "tool", "id": format!("step_{i}"), "name": "read", "state": {
                    "status": "completed", "input": {"filePath": format!("f_{i:02}.rs")}
                }
            }));
        }
        history::decode(json!({
            "status": "window", "latest": true,
            "messages": [{"id": "child_msg", "type": "assistant", "time": {"completed": 1}, "content": tools}]
        }))
        .unwrap()
    };
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(
        &mut state,
        json!({"toolCallExpansionDefaults": {"tools": {"task": "expanded", "skill": "collapsed", "read": "collapsed"}}}),
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
                .install("child", make_page(30)),
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
    let (sx, sy) = rt
        .find(&format!("toggle-{step0_key}"))
        .expect("step_0 toggle");
    rt.pointer_down(sx, sy);
    rt.pointer_up(sx, sy);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let link_url = "https://example.com/step0-guide";
    rt.update(|_, tx| tx.focus(link_url, true));
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
                .install("child", make_page(40)),
        );
        assert!(crate::chat::events::poll_chat(s, 2));
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.find(&format!("reveal-{step_key}")).is_none(),
        "focused Markdown link inside step_0 must keep start at 0 even at bottom"
    );
    rt.update(|_, tx| tx.scroll_to_instant(scroll_key.clone(), 0.0, 0.0));
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.elements()
            .into_iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(step0_key.as_str())),
        "step_0 must remain mounted while its Markdown link holds focus"
    );

    // Grandchild expanded link protection through recursive step_contains_link.
    let nested_task = history::decode(json!({
        "status": "window", "latest": true,
        "messages": [{"id": "g_msg", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "gc_skill", "name": "skill", "state": {
                "status": "completed",
                "input": {"id": "deep"},
                "content": [{"type": "text", "text": "See [deep](https://example.com/grandchild-link)"}]
            }
        }]}]
    }))
    .unwrap();
    let mid_row = history::decode_message(&json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1}, "content": [{
            "type": "tool", "id": "mid", "name": "subagent", "state": {
                "status": "completed",
                "metadata": {"sessionID": "grandchild", "status": "running"}
            }
        }]
    }))
    .unwrap();
    let crate::content::Part::Tool(mid_task) = &mid_row.parts[0] else {
        panic!("expected tool part");
    };
    let mut gc_lease = None;
    rt.update(|s, _| {
        gc_lease = Some(s.transcript_display.children.install_under(
            Some("child"),
            "grandchild",
            nested_task,
        ));
        assert!(crate::chat::events::poll_chat(s, 3));
        let gc_key = super::super::tool_key("row-task-steps-child:grandchild:g_msg", "gc_skill");
        Display::set_expanded(s, &gc_key, true);
        assert!(super::step_contains_link(
            s,
            "child:child:m1",
            mid_task,
            "row",
            &["child"],
            "https://example.com/grandchild-link",
            0,
        ));
    });
    let _ = (lease, gc_lease);
}
