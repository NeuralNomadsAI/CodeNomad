use super::*;
use rune::{Env, Runtime};
use serde_json::json;

#[test]
fn receipts_are_anchored_without_becoming_native_message_parts() {
    let mut state = crate::init();
    state.phase = crate::Phase::Ready;
    for (id, body) in [("first", "First native text"), ("last", "Last native text")] {
        state.messages.push(
            crate::history::decode_message(&json!({
                "id":id,"type":"user","text":body,
            }))
            .unwrap()
            .into(),
        );
    }
    for (message, reason) in [
        (Some("first"), "Anchored reason"),
        (None, "Unanchored reason"),
    ] {
        let receipt = serde_json::from_value(json!({
            "requestId": "confirmed", "sessionId":"ses_fixture", "decision":"once",
            "origin":"codenomad", "resources":["fixtures/**"], "reason":reason,
            "source":message.map(|id| json!({"messageId":id,"callId":"call"}))
        }))
        .unwrap();
        state.transcript_display.receipts.entries.insert(
            message.map(str::to_owned),
            Entry {
                receipt: vec![receipt],
                ..Entry::default()
            },
        );
    }
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    let reason = tree.find("Anchored reason").unwrap();
    assert!(
        tree.find("First native text").unwrap() < reason
            && reason < tree.find("Last native text").unwrap()
    );
    assert!(!tree.contains("Unanchored reason"));
    for row in &rt.state.messages {
        assert!(row.parts.is_empty() && !row.body.contains("reason"));
    }
}
