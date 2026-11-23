use super::*;
use rune::{Env, Runtime};
use serde_json::json;

#[test]
fn visibility_changes_keep_prose_and_explicit_card_disclosures() {
    let mut s = crate::init();
    let row = crate::history::decode_message(&json!({
        "id":"turn","type":"assistant","time":{"completed":1},
        "content":[
            {"type":"reasoning","text":"Private reasoning"},
            {"type":"tool","name":"read","id":"r","state":{"status":"completed","input":{"filePath":"project.txt"}}},
            {"type":"tool","name":"glob","id":"g","state":{"status":"completed","input":{"pattern":"src/*"}}},
            {"type":"text","text":"Public reply"}
        ]
    })).unwrap();
    s.messages.push(row.into());
    let mut rt = Runtime::new(
        s,
        |s, _| crate::strings::with_locale("en", || message(s, 0)),
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_some());
    assert!(rt.find("toggle-tool-turn:1:r").is_none());
    assert!(rt.find("reasoning-turn:0").is_none());

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"everything"},
                "toolGroupVisibility":"expanded", "showThinkingBlocks":true,
                "thinkingBlocksExpansion":"expanded", "toolInputsVisibility":"expanded"
            }),
        );
    });
    rt.frame(0.02);
    assert!(rt.find("toggle-tool-turn:1:r").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Private reasoning")
    );
    let (x, y) = rt.find("toggle-tool-turn:1:r").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.find("toggle-tool-turn:1:r-tool_input").is_none());

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"nothing"}
            }),
        )
    });
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_none());
    assert!(rt.find("reasoning-turn:0").is_none());
    assert!(rt.accessibility_json().to_string().contains("Public reply"));

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"everything"},
                "toolGroupVisibility":"hidden"
            }),
        )
    });
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_none());
    assert!(rt.find("toggle-tool-turn:1:r").is_some());
    assert!(rt.find("toggle-tool-turn:1:r-tool_input").is_none());
    assert!(rt.find("toggle-tool-turn:1:g-tool_input").is_some());
}
