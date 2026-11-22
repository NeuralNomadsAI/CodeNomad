use crate::{Phase, State, content::Part, history, init, view};
use rune::{Env, Runtime};
use serde_json::json;
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
    state.messages = vec![row];
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
    s.messages = vec![row];
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
        state.messages = vec![history::decode_message(&native).unwrap()];
        state.phase = Phase::Ready;
        let mut rt = Runtime::new(
            state,
            |s, cx| crate::strings::with_locale("en", || view(s, cx)),
            (1000.0, 1200.0),
            Env::new(dark, 1.0),
        );
        rt.frame(0.0);
        let tree = rt.accessibility_json().to_string();
        for label in [
            "Results",
            "First",
            "let count = 12;",
            "+return 8;",
            "Print result",
            "printf",
            "Grep return",
            "Offset: 4",
        ] {
            assert!(tree.contains(label), "label missing: {label}: {tree}");
        }
        assert!(!tree.contains("Edit applied."));
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        let (x, y) = rt.find("copy-tool-transcript:5:shell-output").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some("$ printf '%s' result\nresult")
        );
    }
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
    state.messages = vec![row];
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
    for _ in 0..6 {
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
    state.messages =
        vec![history::decode_message(&json!({"id":"reveal","type":"user","text":source})).unwrap()];
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
        .unwrap(),
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
    state.messages = vec![row];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 720.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    for key in ["toggle-tool-error:4:read", "copy-tool-error:4:read-error"] {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
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
    state.messages = vec![row];
    state.phase = Phase::Ready;
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
