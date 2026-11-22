use crate::{Phase, content::Part, history, init, view};
use rune::{Env, Runtime};
use serde_json::json;
#[test]
fn user_attachments_render_as_chips_without_instructions_or_uris() {
    crate::strings::with_locale("en", || {
        for dark in [false, true] {
            let row = history::decode_message(&json!({
                "id":"user-files","type":"user","text":"",
                "skills":[{"id":"skill","name":"Review","instructions":"PRIVATE-SKILL-INSTRUCTIONS"}],
                "agents":[{"name":"PRIVATE-AGENT"}],
                "files":[
                    {"name":"Picture","mime":"image/png","source":{"type":"inline"},"data":"PRIVATE-BYTES"},
                    {"mime":"text/plain","source":{"type":"uri","uri":"file:///private/notes.txt"}},
                    {"mime":"application/octet-stream","source":{"type":"inline"},"data":"PRIVATE-BYTES"}
                ]
            })).unwrap();
            let mut s = init();
            s.messages = vec![row];
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
    assert!(rt.find("tool-native_msg-call_1-tool_output").is_none());
    let (x, y) = rt.find("toggle-tool-native_msg-call_1").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("tool-native_msg-call_1-tool_input").is_some());
    assert!(rt.find("tool-native_msg-call_1-tool_output").is_some());
    assert_eq!(rt.state.messages[0].body, "Before\nAfter");
}
#[test]
fn tool_identity_and_large_unicode_output_are_bounded() {
    let mut raw = json!({"id":"m","type":"assistant","content":[{"type":"tool","id":"one","name":"read","state":{"status":"completed","content":[{"type":"text","text":"🦀".repeat(100_000)}]}}]});
    let row = history::decode_message(&raw).unwrap();
    let Part::Tool(tool) = &row.parts[0] else {
        panic!("tool")
    };
    assert!(tool.limited);
    assert!(tool.output.len() <= 256 * 1024);
    assert!(tool.output.ends_with('🦀'));
    let duplicate = raw["content"][0].clone();
    raw["content"].as_array_mut().unwrap().push(duplicate);
    assert!(history::decode_message(&raw).is_err());
}
