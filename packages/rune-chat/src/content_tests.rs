use crate::{Phase, content::Part, history, init, view};
use rune::{Env, Runtime};
use serde_json::json;
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
        matches!(&row.parts[..],[Part::Text(a),Part::Tool(_),Part::Text(b),Part::Tool(_)] if a=="Before"&&b=="After")
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
