use crate::{Phase, State, content::Part, history, init, view};
use rune::{Env, Runtime};
use serde_json::json;
#[test]
fn replacing_a_window_keeps_overlap_identity() {
    let mut state = init();
    let first: history::Row =
        history::decode_message(&json!({"id":"first","type":"user","text":"First"}))
            .unwrap()
            .into();
    let shared: history::Row =
        history::decode_message(&json!({"id":"shared","type":"user","text":"Overlap"}))
            .unwrap()
            .into();
    let departed: history::Row =
        history::decode_message(&json!({"id":"departed","type":"user","text":"Departed"}))
            .unwrap()
            .into();
    state.messages = vec![shared.clone(), departed];
    let (events, incoming) = crate::bounded(1);
    state.incoming = Some(incoming);
    events
        .try_send(crate::transport::Event::Older(history::Page {
            rows: vec![first, shared.clone()],
            older: None,
            newer: Some(json!({"kind":"after","messageID":"shared"})),
            running: false,
            user_file_references: false,
        }))
        .unwrap();
    assert!(crate::poll_chat(&mut state, 1));
    assert!(state.history_detached);
    assert!(std::sync::Arc::ptr_eq(&shared, &state.messages[1]));
}
#[test]
fn attachment_reveal_keeps_the_gap_between_head_and_tail() {
    let files = (0..1001)
        .map(|index| {
            json!({
                "name":format!("Part {index}"), "mime":"text/plain","source":{"type":"unavailable"}
            })
        })
        .collect::<Vec<_>>();
    let mut s = init();
    s.messages = vec![
        history::decode_message(&json!({"id":"dense","type":"user","text":"Files","files":files}))
            .unwrap()
            .into(),
    ];
    s.phase = Phase::Ready;
    let mut rt = Runtime::new(s, view, (900.0, 700.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let elements = rt.elements();
    let head = elements
        .iter()
        .position(|el| el.key.as_deref() == Some("dense-file-499"))
        .unwrap();
    let marker = elements
        .iter()
        .position(|el| el.key.as_deref() == Some("parts-gap-dense"))
        .unwrap();
    let tail = elements
        .iter()
        .position(|el| el.key.as_deref() == Some("dense-file-501"))
        .unwrap();
    assert!(head < marker && marker < tail);
    assert!(rt.find("dense-file-500").is_none());
    rt.update(|s, _| crate::transcript_state::Display::reveal_next(s, "parts-gap-dense"));
    rt.frame(0.0);
    assert!(rt.find("dense-file-500").is_some());
    assert!(rt.find("parts-gap-dense").is_none());
}
#[test]
fn user_attachments_render_as_chips_without_instructions_or_uris() {
    crate::strings::with_locale("en", || {
        for dark in [false, true] {
            let row = history::decode_message(&json!({
                "id":"user-files","type":"user","text":"",
                "skills":[{"id":"skill","name":"Review","text":"PRIVATE-SKILL-INSTRUCTIONS"}],
                "agents":[{"name":"PRIVATE-AGENT"}],
                "files":[
                    {"name":"Picture","mime":"image/png","source":{"type":"inline"},"data":"PRIVATE-BYTES"},
                    {"mime":"text/plain","source":{"type":"uri","uri":"file:///private/notes.txt"}},
                    {"mime":"application/octet-stream","source":{"type":"inline"},"data":"PRIVATE-BYTES"}
                ]
            })).unwrap();
            let mut s = init();
            s.messages = vec![row.into()];
            s.phase = Phase::Ready;
            let mut rt = Runtime::new(s, view, (390.0, 700.0), Env::new(dark, 1.0));
            for _ in 0..12 {
                rt.frame(1.0 / 60.0);
            }
            for key in [
                "user-files-skill-0",
                "user-files-file-0",
                "user-files-file-1",
                "user-files-file-2",
            ] {
                assert!(rt.find(key).is_some(), "no rendered chip {key}");
            }
            assert!(rt.find("part-user-files-0").is_none());
            let tree = rt.accessibility_json().to_string();
            for label in ["Review", "Picture", "notes.txt", "attachment"] {
                assert!(
                    tree.contains(&format!("\"{label}\"")),
                    "no accessible name {label}: {tree}"
                );
            }
            for private in [
                "PRIVATE-SKILL-INSTRUCTIONS",
                "PRIVATE-AGENT",
                "PRIVATE-BYTES",
                "file:///private",
            ] {
                assert!(!tree.contains(private));
            }
        }
    });
}
#[test]
fn write_renders_and_copies_the_file_instead_of_the_tool_acknowledgement() {
    let row = history::decode_message(
        &json!({"id":"written","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"write","name":"write","state":{"status":"completed",
                "input":{"filePath":"demo.rs","content":"fn written() {}\n"},
                "metadata":{"content":"stale metadata"},
                "content":[{"type":"text","text":"Write applied."}]}}
        ]}),
    )
    .unwrap();
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("fn written() {}"));
    assert!(!tree.contains("Write applied.") && !tree.contains("stale metadata"));
    let (x, y) = rt.find("copy-tool-written:5:write-output").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some("fn written() {}\n")
    );
}

#[test]
fn streamed_text_after_a_tool_reaches_the_rendered_transcript() {
    let row = history::decode_message(&json!({"id":"mixed","type":"assistant","content":[
        {"type":"text","text":"Before"},
        {"type":"tool","id":"read_1","name":"read","state":{"status":"completed"}},
        {"type":"text","text":"After"}
    ]}))
    .unwrap();
    let (out, input) = crate::bounded(4);
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Streaming;
    state.incoming = Some(input);
    let mut rt = Runtime::new(state, view, (960.0, 760.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    out.try_send(crate::transport::Event::Text(
        "mixed".into(),
        crate::content::TextEvent::Delta {
            ordinal: Some(1),
            text: " MKAA000008K".into(),
        },
    ))
    .unwrap();
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.state.messages[0].body.contains("MKAA000008K"));
    assert!(
        rt.accessibility_json().to_string().contains("MKAA000008K"),
        "A streamed fragment must reach the actual text view"
    );
}
#[test]
fn native_tools_preserve_order_and_reveal_real_input_output_on_demand() {
    let raw = json!({"id":"native_msg","type":"assistant","content":[
        {"type":"text","text":"Before"},
        {"type":"tool","id":"call_1","name":"read","state":{"status":"completed","input":{"file":"sample.rs"},"content":[{"type":"text","text":"fn actual() {}"}]}},
        {"type":"text","text":"After"},
        {"type":"tool","id":"call_2","name":"shell","state":{"status":"error","input":{"command":"synthetic"},"error":{"message":"Synthetic refusal"}}}
    ]});
    let row = history::decode_message(&raw).unwrap();
    assert!(
        matches!(&row.parts[..],[Part::Text(a),Part::Tool(_),Part::Text(b),Part::Tool(_)] if a.text=="Before"&&b.text=="After")
    );
    let mut s = init();
    s.messages = vec![row.into()];
    s.phase = Phase::Ready;
    let mut rt = Runtime::new(s, view, (960.0, 1000.0), Env::new(true, 1.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("tool-native_msg:6:call_1-tool_output").is_none());
    let (x, y) = rt.find("toggle-tool-native_msg:6:call_1").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("tool-native_msg:6:call_1-tool_input").is_none());
    assert!(rt.find("tool-native_msg:6:call_1-tool_output").is_some());
    let (x, y) = rt
        .find("toggle-tool-native_msg:6:call_1-tool_input")
        .unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert!(rt.find("tool-native_msg:6:call_1-tool_input").is_some());
    assert_eq!(rt.state.messages[0].body, "Before\nAfter");
}
#[test]
fn tool_identity_is_unique_and_unicode_output_is_retained_for_reveal() {
    let mut raw = json!({"id":"m","type":"assistant","content":[{"type":"tool","id":"one","name":"read","state":{"status":"completed","content":[{"type":"text","text":"🦀".repeat(100_000)}]}}]});
    let row = history::decode_message(&raw).unwrap();
    let Part::Tool(tool) = &row.parts[0] else {
        panic!("tool")
    };
    assert_eq!(tool.output.len(), 400_000);
    assert!(tool.output.ends_with('🦀'));
    let duplicate = raw["content"][0].clone();
    raw["content"].as_array_mut().unwrap().push(duplicate);
    assert!(history::decode_message(&raw).is_err());
}

#[test]
fn markdown_and_specialized_tools_use_native_content_in_the_runtime() {
    for dark in [false, true] {
        let mut state = init();
        let native = serde_json::from_str(include_str!("../../fixtures/transcript.json")).unwrap();
        state.messages = vec![history::decode_message(&native).unwrap().into()];
        state.phase = Phase::Ready;
        let mut rt = Runtime::new(
            state,
            |s, cx| crate::strings::with_locale("en", || view(s, cx)),
            (1000.0, 1200.0),
            Env::new(dark, 1.0),
        );
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        let tree = rt.accessibility_json().to_string();
        for label in [
            "Results",
            "First",
            "let count = 12;",
            "return 8;",
            "Print result",
            "printf",
            "Grep return",
            "Offset: 4",
        ] {
            assert!(tree.contains(label), "label missing: {label}: {tree}");
        }
        assert!(!tree.contains("Edit applied."));
        assert!(
            !tree.contains("\\u001b[31m"),
            "ANSI escapes must stay out of rendered text"
        );
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        let (x, y) = rt.find("copy-tool-transcript:5:shell-output").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some("$ printf '%s' result\n\u{1b}[31mresult\u{1b}[0m")
        );
    }
}

#[test]
fn transcript_edit_switches_the_shared_diff_without_changing_the_copied_patch() {
    let mut state = init();
    let native = serde_json::from_str(include_str!("../../fixtures/transcript.json")).unwrap();
    state.messages = vec![history::decode_message(&native).unwrap().into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || view(s, cx)),
        (1000.0, 1200.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("tool-transcript:4:edit-diff").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Switch to unified view")
    );
    for key in [
        "tool-transcript:4:edit-mode",
        "tool-transcript:4:edit-copy-patch",
    ] {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Switch to split view")
    );
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some("--- a/src/demo.rs\n+++ b/src/demo.rs\n@@ -1 +1 @@\n-return 7;\n+return 8;")
    );
}

#[test]
fn transcript_patch_with_out_of_range_lines_uses_the_raw_fallback() {
    let patch = "--- a/app.rs\n+++ b/app.rs\n@@ -4294967295 +4294967295 @@\n-return 1;\n+return 2;";
    let mut state = init();
    state.messages = vec![history::decode_message(&json!({"id":"range","type":"assistant","time":{"completed":1},"content":[
        {"type":"tool","name":"edit","id":"edit","state":{"status":"completed","input":{"filePath":"app.rs"},
            "metadata":{"diff":patch}}}
    ]})).unwrap().into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("tool-range:4:edit-diff").is_none());
    assert!(rt.accessibility_json().to_string().contains("+return 2;"));
}

#[test]
fn transcript_keeps_and_copies_a_patch_with_long_unicode_headers() {
    let path = format!("{}.rs", "é".repeat(1711));
    let patch = format!("Index: {path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-A\n+B");
    assert!(patch.find("@@ ").unwrap() > 10_000);
    assert!(patch.encode_utf16().count() < 10_000);
    let mut state = init();
    state.messages = vec![history::decode_message(&json!({"id":"unicode","type":"assistant","time":{"completed":1},"content":[
        {"type":"tool","name":"edit","id":"edit","state":{"status":"completed","input":{"filePath":path},
            "metadata":{"files":[{"file":path,"patch":patch}]},"content":[{"type":"text","text":"Edited …"}]}}
    ]})).unwrap().into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt.find("tool-unicode:4:edit-copy-patch").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some(patch.as_str())
    );
}

#[test]
fn wrapped_update_patch_uses_the_shared_diff_and_copies_the_original() {
    let patch = "```diff\n*** Begin Patch\n\n*** Update File: src/demo.rs\n@@\n-return 7;\n+return 8;\n*** End Patch\n```";
    let mut state = init();
    state.messages = vec![history::decode_message(&json!({"id":"wrapped","type":"assistant","time":{"completed":1},"content":[
        {"type":"tool","name":"edit","id":"edit","state":{"status":"completed","metadata":{"diff":patch}}}
    ]})).unwrap().into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("return 7;") && tree.contains("return 8;"));
    let (x, y) = rt.find("tool-wrapped:4:edit-copy-patch").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(clipboard.text().as_deref().map(String::as_str), Some(patch));
}

fn edit_cards(count: usize) -> State {
    let cards: Vec<_> = (0..count)
        .map(|i| {
            json!({"type":"tool","name":"edit","id":format!("edit{i}"),
                "state":{"status":"completed","input":{},
                "metadata":{"files":[{"file":"demo.rs","patch":"@@ -1 +1 @@\n-before\n+after"}]}}})
        })
        .collect();
    let mut state = init();
    state.messages = vec![
        history::decode_message(
            &json!({"id":"cards","type":"assistant","time":{"completed":1},"content":cards}),
        )
        .unwrap()
        .into(),
    ];
    state.phase = Phase::Ready;
    state
}

#[test]
fn transcript_edit_modes_follow_the_window_and_are_shared_between_cards() {
    let mut rt = Runtime::new(
        edit_cards(2),
        |s, cx| crate::strings::with_locale("en", || view(s, cx)),
        (1000.0, 1200.0),
        Env::new(false, 1.0),
    );
    let label_count = |rt: &Runtime<State>, label: &str| {
        rt.elements()
            .into_iter()
            .filter(|e| {
                !e.exiting
                    && e.key.as_deref().is_some_and(|key| key.ends_with("-mode"))
                    && e.label.as_deref() == Some(label)
            })
            .count()
    };
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(label_count(&rt, "Switch to unified view"), 2);
    rt.set_viewport((500.0, 1200.0), 1.0);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(label_count(&rt, "Switch to split view"), 2);
    rt.set_viewport((1000.0, 1200.0), 1.0);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt.find("tool-cards:5:edit0-mode").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(label_count(&rt, "Switch to split view"), 2);
    rt.update(|s, _| {
        s.transcript_display.bind("fixture", "project", "other");
        s.messages.clear();
        s.renew_scope();
        s.revision += 1;
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|s, _| {
        s.transcript_display.bind("fixture", "project", "original");
        s.messages = edit_cards(2).messages;
        s.renew_scope();
        s.revision += 1;
    });
    for _ in 0..48 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(label_count(&rt, "Switch to split view"), 2);
}

#[test]
fn compact_view_mode_and_unified_wrap_are_local_to_the_card() {
    let mut rt = Runtime::new(edit_cards(2), view, (500.0, 1000.0), Env::new(false, 1.0));
    let button = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|e| !e.exiting && e.key.as_deref() == Some(key))
            .unwrap()
    };
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    for (change, other) in [
        ("tool-cards:5:edit0-wrap", "tool-cards:5:edit1-wrap"),
        ("tool-cards:5:edit0-mode", "tool-cards:5:edit1-mode"),
    ] {
        let label = button(&rt, other).label;
        assert_eq!(label, button(&rt, change).label);
        let (x, y) = rt.find(change).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        assert_ne!(label, button(&rt, change).label);
        assert_eq!(label, button(&rt, other).label);
    }
}

#[test]
fn a_larger_history_viewport_retries_an_already_mounted_diff() {
    let mut rt = Runtime::new(edit_cards(12), view, (960.0, 380.0), Env::new(false, 1.0));
    rt.frame(0.0);
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    let card = "toggle-tool-cards:5:edit1";
    let top = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|e| !e.exiting && e.key.as_deref() == Some(card))
            .unwrap()
            .rect[1]
    };
    let before = top(&rt);
    assert!(rt.find("tool-cards:5:edit0-copy-patch").is_some());
    assert!(rt.find("tool-cards:5:edit1-copy-patch").is_none());
    rt.set_viewport((960.0, 960.0), 1.0);
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    assert!((before - top(&rt)).abs() < 1.0);
    assert!(rt.find("tool-cards:5:edit1-copy-patch").is_some());
}

#[test]
fn scrolling_one_message_can_show_more_diffs_than_the_cache_retains() {
    let mut rt = Runtime::new(
        edit_cards(33),
        |s, cx| crate::strings::with_locale("en", || view(s, cx)),
        (500.0, 720.0),
        Env::new(false, 1.0),
    );
    let mut seen = std::collections::HashSet::new();
    rt.frame(0.0);
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    let key = "tool-cards:5:edit0-mode";
    let (x, y) = rt.find(key).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    for y in (0..10_000).step_by(280) {
        rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, y as f32));
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        seen.extend(
            rt.elements()
                .into_iter()
                .filter(|element| {
                    !element.exiting && element.visible[2] > 0.0 && element.visible[3] > 0.0
                })
                .filter_map(|e| e.key)
                .filter(|key| key.starts_with("tool-cards:") && key.ends_with("-copy-patch")),
        );
        if seen.len() == 33 {
            break;
        }
    }
    assert_eq!(seen.len(), 33);
    assert!(
        !rt.elements()
            .iter()
            .any(|e| !e.exiting && e.key.as_deref() == Some(key))
    );
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.elements().into_iter().any(|e| !e.exiting
        && e.key.as_deref() == Some(key)
        && e.label.as_deref() == Some("Switch to unified view")));
}

#[test]
fn historical_part_gap_reveals_the_middle_without_rejecting_the_message() {
    let mut parts = vec![json!({"type":"text","text":""}); 1237];
    parts[0]["text"] = json!("First part");
    parts[501]["text"] = json!("Middle part");
    parts[1236]["text"] = json!("Last part");
    let row = history::decode_message(
        &json!({"id":"parts","type":"assistant","time":{"completed":1},"content":parts}),
    )
    .unwrap();
    assert_eq!(row.parts.len(), 1237);
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    rt.frame(0.0);
    assert!(rt.find("parts-gap-parts").is_some());
    assert!(!rt.accessibility_json().to_string().contains("Middle part"));
    let focused = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .iter()
            .any(|element| element.focused && element.key.as_deref() == Some(key))
    };
    fn key(rt: &mut Runtime<State>, key: rune::Key) {
        let event = rune::KeyEvent {
            key,
            mods: Default::default(),
        };
        rt.key(event.clone());
        rt.key_up(event);
        rt.frame(1.0 / 60.0);
    }
    for _ in 0..12 {
        if focused(&rt, "reveal-parts-gap-parts") {
            break;
        }
        key(&mut rt, rune::Key::Tab);
    }
    assert!(focused(&rt, "reveal-parts-gap-parts"));
    key(&mut rt, rune::Key::Text(" ".into()));
    assert!(rt.find("parts-gap-parts").is_none());
    assert!(rt.accessibility_json().to_string().contains("Middle part"));
    assert!(focused(&rt, "parts-gap-parts-start"));
}

#[test]
fn revealing_latest_prose_keeps_the_reader_at_the_cut() {
    let before = "A line which fills the initial render window. ".repeat(1100);
    let source = format!(
        "{}\n\nFIRST NEW PARAGRAPH\n\n{}",
        &before[..50_005],
        "The remainder stays below. ".repeat(2500)
    );
    let mut state = init();
    state.messages = vec![
        history::decode_message(&json!({"id":"reveal","type":"user","text":source}))
            .unwrap()
            .into(),
    ];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    let (x, y) = rt.find("reveal-body-reveal").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    let new = rt
        .elements()
        .into_iter()
        .find(|e| e.text.as_deref() == Some("FIRST NEW PARAGRAPH"))
        .unwrap();
    assert!(
        (new.rect[1] - y).abs() < 100.0,
        "new text landed at {} instead of near {y}",
        new.rect[1]
    );
}

#[test]
fn long_streaming_markdown_coalesces_deltas_and_closes_immediately() {
    let mut state = init();
    let long = "A short first paragraph. ".repeat(450);
    state.messages = vec![
        history::decode_message(&json!({"id":"stream","type":"assistant",
        "content":[{"type":"text","text":long}]}))
        .unwrap()
        .into(),
    ];
    state.phase = Phase::Streaming;
    let (out, queue) = crate::bounded(8);
    state.incoming = Some(queue);
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    for (delta, elapsed) in [(" FIRST-RENDER", 0.01), (" WAITING-TAIL", 0.01)] {
        out.try_send(crate::transport::Event::Text(
            "stream".into(),
            crate::content::TextEvent::Delta {
                ordinal: Some(0),
                text: delta.into(),
            },
        ))
        .unwrap();
        rt.frame(elapsed);
    }
    assert!(rt.state.messages[0].body.contains("WAITING-TAIL"));
    assert!(!rt.accessibility_json().to_string().contains("WAITING-TAIL"));
    rt.frame(0.21);
    assert!(rt.accessibility_json().to_string().contains("WAITING-TAIL"));
    out.try_send(crate::transport::Event::Text(
        "stream".into(),
        crate::content::TextEvent::End {
            ordinal: Some(0),
            text: format!("{long} FINAL-TAIL"),
        },
    ))
    .unwrap();
    rt.frame(0.01);
    assert!(rt.accessibility_json().to_string().contains("FINAL-TAIL"));
}

#[test]
fn tool_failure_can_copy_its_full_error_before_reveal() {
    let error = format!("{} END-ERROR", "A clipped diagnostic. ".repeat(550));
    let row = history::decode_message(&json!({"id":"error","type":"assistant","content":[
        {"type":"tool","id":"read","name":"read","state":{"status":"error","error":{"message":error}}}
    ]})).unwrap();
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let (x, y) = rt.find("copy-tool-error:4:read-error").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert!(!rt.accessibility_json().to_string().contains("END-ERROR"));
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some(error.as_str())
    );
}

#[test]
fn native_tool_ids_cannot_alias_another_calls_disclosure() {
    let row = history::decode_message(&json!({"id":"collision","type":"assistant","content":[
        {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{"filePath":"first.txt"}}},
        {"type":"tool","id":"a-tool_input","name":"read","state":{"status":"completed","content":[{"type":"text","text":"OTHER OUTPUT"}]}}
    ]})).unwrap();
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(&mut state, json!({"toolGroupVisibility":"hidden"}));
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    rt.frame(0.0);
    for key in [
        "toggle-tool-collision:1:a",
        "toggle-tool-collision:1:a-tool_input",
    ] {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("first.txt"));
    assert!(!tree.contains("OTHER OUTPUT"));
}

#[test]
fn tool_json_is_charged_before_a_large_resident_clone() {
    use std::mem::size_of;
    let size = history::MAX_BYTES / size_of::<serde_json::Value>() + 1;
    let rows = vec![json!(""); size];
    let raw = json!({"id":"large","type":"assistant","content":[
        {"type":"tool","id":"one","name":"read","state":{"status":"completed","input":{"rows":rows}}}
    ]});
    assert!(raw.to_string().len() < 2 * 1024 * 1024);
    assert!(
        matches!(history::decode_message(&raw), Err(error) if error.to_string() == "resident history limit reached")
    );
}

#[test]
fn prose_keeps_literal_html_line_breaks_and_copies_undisplayed_source() {
    let source = format!(
        "Alice\nBob\n\n<div>bonjour</div>\n\n**bold**\n\n{}\n\nEND-PROSE",
        "source ".repeat(8000)
    );
    let row =
        history::decode_message(&json!({"type":"user","id":"literal","text":source})).unwrap();
    let mut state = init();
    state.messages = vec![row.into()];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    rt.wheel(400.0, 300.0, 15000.0);
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Alice\\nBob"));
    assert!(tree.contains("<div>bonjour</div>"));
    assert!(!tree.contains("END-PROSE"));
    let (x, y) = rt.find("copy-message-literal").unwrap();
    // A focused message copy stays reachable without revealing the concealed source.
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some(source.as_str())
    );
}
